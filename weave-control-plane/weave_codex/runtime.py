"""Codex app-server execution with bounded memory, verification, and receipts."""

from __future__ import annotations

import hashlib
import json
import threading
import time
import uuid
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

from pydantic import BaseModel

from .manifest import VERIFIER_SCHEMA, HarnessManifest, build_solver_prompt, manifest_hash
from .phase_program import phase_turn_bound
from .phase_runtime import execute_phase_program
from .trace_projection import project_events


@dataclass
class TurnOutcome:
    turn_id: str
    final_response: str
    status: str = "completed"
    usage: dict[str, Any] | None = None


class Gateway(Protocol):
    def start(self) -> None: ...
    def close(self) -> None: ...
    def read_thread(self, thread_id: str) -> dict[str, Any]: ...
    def list_threads(self, cwd: str) -> list[dict[str, Any]]: ...
    def start_thread(self, params: dict[str, Any]) -> str: ...
    def set_memory_mode(self, thread_id: str, mode: str) -> None: ...
    def interrupt(self) -> bool: ...
    def run_turn(
        self,
        thread_id: str,
        prompt: str,
        *,
        effort: str,
        output_schema: dict[str, Any] | None,
        event_sink: Callable[[dict[str, Any]], None],
    ) -> TurnOutcome: ...


@dataclass
class RunSession:
    run_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    status: str = "queued"
    events: list[dict[str, Any]] = field(default_factory=list)
    pending_approval: dict[str, Any] | None = None
    result: dict[str, Any] | None = None
    error: str | None = None
    _decision: dict[str, str] | None = None
    _interrupt: Callable[[], bool] | None = field(default=None, repr=False)
    _stop_requested: bool = field(default=False, repr=False)
    _condition: threading.Condition = field(default_factory=threading.Condition, repr=False)

    def snapshot(self) -> dict[str, Any]:
        with self._condition:
            return {
                "runId": self.run_id,
                "status": self.status,
                "events": list(self.events[-120:]),
                "timeline": self.projected_timeline()[-120:],
                "pendingApproval": self.pending_approval,
                "result": self.result,
                "error": self.error,
                "stopRequested": self._stop_requested,
            }

    def event(self, value: dict[str, Any], *, phase: str = "runtime") -> None:
        value = {**value, "phase": phase}
        encoded = json.dumps(value, default=str)
        if len(encoded) > 16_000:
            value = {"method": value.get("method", "event"), "truncated": True}
        with self._condition:
            self.events.append(value)

    def stage(self, phase: str, title: str, detail: str = "") -> None:
        self.event(
            {"method": "harness/stage", "params": {"title": title, "detail": detail}},
            phase=phase,
        )

    def projected_timeline(self) -> list[dict[str, Any]]:
        projected = [
            item
            for index, event in enumerate(self.events)
            if (item := _project_event(event, index)) is not None
        ]
        for index, item in enumerate(projected, start=1):
            item["index"] = index
        return projected

    def request_approval(self, method: str, params: dict[str, Any] | None) -> dict[str, Any]:
        if method not in {
            "item/commandExecution/requestApproval",
            "item/fileChange/requestApproval",
        }:
            return {"decision": "cancel"}
        resolution = self._wait_for_decision({"method": method, "params": params or {}})
        return {"decision": resolution["decision"]}

    def request_checkpoint(self, phase_id: str, question: str) -> dict[str, str]:
        return self._wait_for_decision(
            {
                "method": "harness/checkpoint",
                "params": {"phaseId": phase_id, "question": question},
            }
        )

    def _wait_for_decision(self, pending: dict[str, Any]) -> dict[str, str]:
        with self._condition:
            self.pending_approval = pending
            self.status = "waitingForApproval"
            self._condition.notify_all()
            deadline = time.monotonic() + 300
            while self._decision is None and time.monotonic() < deadline:
                self._condition.wait(timeout=1)
            resolution = self._decision or {"decision": "decline"}
            self._decision = None
            self.pending_approval = None
            self.status = "running"
            return resolution

    def decide(self, decision: str, feedback: str = "") -> None:
        if decision not in {"accept", "acceptForSession", "decline", "cancel"}:
            raise ValueError("unsupported approval decision")
        if not isinstance(feedback, str):
            raise ValueError("checkpoint feedback must be text")
        feedback = feedback.strip()
        if len(feedback) > 2_000:
            raise ValueError("checkpoint feedback must contain at most 2000 characters")
        with self._condition:
            if self.pending_approval is None:
                raise ValueError("this run has no pending approval")
            is_checkpoint = self.pending_approval.get("method") == "harness/checkpoint"
            if feedback and not is_checkpoint:
                raise ValueError("feedback is supported only at a harness checkpoint")
            self._decision = {"decision": decision}
            if feedback:
                self._decision["feedback"] = feedback
            self._condition.notify_all()

    def bind_interrupt(self, callback: Callable[[], bool] | None) -> None:
        with self._condition:
            self._interrupt = callback

    def request_stop(self) -> bool:
        """Stop a pending checkpoint or interrupt the currently active Codex turn."""

        with self._condition:
            if self.status in {"completed", "failed", "stopped"}:
                return False
            self._stop_requested = True
            if self.pending_approval is not None:
                self._decision = {"decision": "cancel"}
                self._condition.notify_all()
                return True
            callback = self._interrupt
        return bool(callback and callback())


class _EmptyResponse(BaseModel):
    pass


def _short_text(value: Any, limit: int = 260) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        text = value
    else:
        text = json.dumps(value, default=str, sort_keys=True)
    text = " ".join(text.split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _project_event(event: dict[str, Any], index: int) -> dict[str, Any] | None:
    """Turn noisy app-server notifications into a small visual timeline vocabulary."""

    method = str(event.get("method", "event"))
    phase = str(event.get("phase", "runtime"))
    params = event.get("params", {}) if isinstance(event.get("params"), dict) else {}
    item = params.get("item", {}) if isinstance(params.get("item"), dict) else {}
    item_type = str(item.get("type", ""))
    if method in {"rawResponseItem/completed", "item/agentMessage/delta", "turn/started"}:
        return None
    if method == "item/started" and item_type not in {"commandExecution", "fileChange"}:
        return None
    if method == "item/completed" and item_type == "userMessage":
        return None
    kind = "runtime"
    title = method
    detail = ""
    if method == "harness/stage":
        kind = "stage"
        title = str(params.get("title", phase))
        detail = _short_text(params.get("detail"))
    elif method == "rawResponse/completed":
        kind = "model"
        title = "Model completion"
        detail = "A model response completed inside this controller turn."
    elif method == "thread/tokenUsage/updated":
        kind = "usage"
        title = "Token usage updated"
        detail = _short_text(params.get("tokenUsage"))
    elif method in {"item/started", "item/completed"}:
        completed = method.endswith("completed")
        if item_type == "commandExecution":
            kind = "tool_result" if completed else "tool_call"
            title = "Command finished" if completed else "Command requested"
            detail = _short_text(
                item.get("command")
                or item.get("parsedCommand")
                or item.get("status")
                or item.get("aggregatedOutput")
            )
        elif item_type == "fileChange":
            kind = "tool_result" if completed else "tool_call"
            title = "File change recorded" if completed else "File change requested"
            detail = _short_text(item.get("changes") or item.get("status"))
        elif item_type == "reasoning":
            kind = "reasoning"
            title = "Reasoning summary"
            detail = _short_text(item.get("summary") or item.get("content"))
        elif item_type == "agentMessage":
            kind = "answer"
            title = "Agent answer"
            detail = _short_text(item.get("text"))
        else:
            kind = "item"
            title = f"{item_type or 'Codex item'} {'completed' if completed else 'started'}"
            detail = _short_text(item.get("status") or item.get("text"))
    elif method == "turn/completed":
        kind = "turn"
        title = "Controller turn completed"
        turn = params.get("turn", {})
        detail = _short_text(turn.get("status") if isinstance(turn, dict) else "")
    elif "Approval" in method or "approval" in method:
        kind = "approval"
        title = "Approval requested"
        detail = _short_text(params)
    else:
        return None
    return {
        "index": index + 1,
        "phase": phase,
        "kind": kind,
        "title": title,
        "detail": detail,
        "method": method,
        "truncated": bool(event.get("truncated")),
    }


def _integration_observations(events: list[dict[str, Any]]) -> list[dict[str, str]]:
    """Project only integration identity/status fields from completed tool items."""

    observations: list[dict[str, str]] = []
    seen: set[tuple[str, str, str]] = set()
    for event in events:
        if event.get("method") != "item/completed":
            continue
        params = event.get("params") if isinstance(event.get("params"), dict) else {}
        item = params.get("item") if isinstance(params.get("item"), dict) else {}
        item_type = str(item.get("type", ""))
        if item_type not in {"mcpToolCall", "dynamicToolCall"}:
            continue
        server = str(item.get("server") or item.get("serverName") or "")
        tool = str(item.get("tool") or item.get("toolName") or item.get("name") or "")
        key = (item_type, server, tool)
        if key in seen:
            continue
        seen.add(key)
        observation = {"itemType": item_type, "status": str(item.get("status") or "completed")}
        if server:
            observation["server"] = server
        if tool:
            observation["tool"] = tool
        observations.append(observation)
    return observations


class SdkGateway:
    """Thin adapter over the pinned Codex Python SDK and app-server."""

    def __init__(self, codex_bin: str, trace_root: str, approval_handler: Callable[..., Any]):
        from openai_codex.client import CodexClient, CodexConfig

        self._client = CodexClient(
            CodexConfig(
                codex_bin=codex_bin,
                client_name="weave_codex",
                client_title="Weave Codex Control Plane",
                client_version="0.1.0",
                env={"CODEX_ROLLOUT_TRACE_ROOT": trace_root},
            ),
            approval_handler=approval_handler,
        )
        self._active_lock = threading.Lock()
        self._active_turn: tuple[str, str] | None = None
        self._interrupt_requested = False

    def start(self) -> None:
        self._client.start()
        self._client.initialize()

    def close(self) -> None:
        self._client.close()

    def read_thread(self, thread_id: str) -> dict[str, Any]:
        value = self._client.thread_read(thread_id, include_turns=True)
        return value.model_dump(by_alias=True, mode="json", exclude_none=True)

    def list_threads(self, cwd: str) -> list[dict[str, Any]]:
        value = self._client.thread_list({"cwd": cwd, "limit": 30})
        data = value.model_dump(by_alias=True, mode="json", exclude_none=True)
        return data.get("data", [])

    def start_thread(self, params: dict[str, Any]) -> str:
        return self._client.thread_start(params).thread.id

    def set_memory_mode(self, thread_id: str, mode: str) -> None:
        self._client.request(
            "thread/memoryMode/set",
            {"threadId": thread_id, "mode": mode},
            response_model=_EmptyResponse,
        )

    def interrupt(self) -> bool:
        with self._active_lock:
            self._interrupt_requested = True
            active = self._active_turn
        if active is None:
            return True
        self._client.turn_interrupt(*active)
        return True

    def run_turn(
        self,
        thread_id: str,
        prompt: str,
        *,
        effort: str,
        output_schema: dict[str, Any] | None,
        event_sink: Callable[[dict[str, Any]], None],
    ) -> TurnOutcome:
        params: dict[str, Any] = {"effort": effort}
        if output_schema is not None:
            params["outputSchema"] = output_schema
        started = self._client.turn_start(thread_id, prompt, params=params)
        turn_id = started.turn.id
        with self._active_lock:
            self._active_turn = (thread_id, turn_id)
            interrupt_requested = self._interrupt_requested
        if interrupt_requested:
            self._client.turn_interrupt(thread_id, turn_id)
        final_response = ""
        usage = None
        try:
            while True:
                note = self._client.next_turn_notification(turn_id)
                payload = note.payload
                data = (
                    payload.model_dump(by_alias=True, mode="json", exclude_none=True)
                    if hasattr(payload, "model_dump")
                    else {"value": str(payload)}
                )
                event_sink({"method": note.method, "params": data})
                if note.method == "item/completed":
                    item = data.get("item", {})
                    if item.get("type") == "agentMessage":
                        final_response = item.get("text", final_response)
                if note.method == "thread/tokenUsage/updated":
                    usage = data.get("tokenUsage")
                if note.method == "turn/completed":
                    turn = data.get("turn", {})
                    return TurnOutcome(
                        turn_id=turn_id,
                        final_response=final_response,
                        status=turn.get("status", "unknown"),
                        usage=usage,
                    )
        finally:
            with self._active_lock:
                if self._active_turn == (thread_id, turn_id):
                    self._active_turn = None
                self._interrupt_requested = False
            self._client.unregister_turn_notifications(turn_id)


def _thread_excerpt(value: dict[str, Any], *, limit: int = 1_500) -> str:
    pieces: list[str] = []
    for turn in value.get("thread", {}).get("turns", [])[-4:]:
        for item in turn.get("items", []):
            item_type = item.get("type")
            if item_type == "agentMessage" and item.get("text"):
                pieces.append(f"assistant: {item['text']}")
            elif item_type == "userMessage":
                text = " ".join(
                    part.get("text", "")
                    for part in item.get("content", [])
                    if part.get("type") == "text"
                )
                if text:
                    pieces.append(f"user: {text}")
    return "\n".join(pieces)[-limit:]


class HarnessRunner:
    def __init__(
        self,
        codex_bin: str,
        gateway_factory: Callable[[str, str, Callable[..., Any]], Gateway] = SdkGateway,
    ) -> None:
        self.codex_bin = codex_bin
        self.gateway_factory = gateway_factory

    def list_threads(self, cwd: str) -> list[dict[str, Any]]:
        trace_root = str(Path(cwd) / ".weave-codex" / "traces")
        gateway = self.gateway_factory(
            self.codex_bin, trace_root, lambda *_: {"decision": "decline"}
        )
        try:
            gateway.start()
            return gateway.list_threads(cwd)
        finally:
            gateway.close()

    def read_thread(self, cwd: str, thread_id: str) -> dict[str, Any]:
        trace_root = str(Path(cwd) / ".weave-codex" / "traces")
        gateway = self.gateway_factory(
            self.codex_bin, trace_root, lambda *_: {"decision": "decline"}
        )
        try:
            gateway.start()
            return gateway.read_thread(thread_id)
        finally:
            gateway.close()

    def run(self, manifest: HarnessManifest, session: RunSession) -> None:
        started_at = int(time.time())
        session.status = "running"
        session.stage("setup", "Manifest accepted", "Controls are frozen for this run.")
        trace_root = Path(manifest.observability.trace_root)
        if not trace_root.is_absolute():
            trace_root = Path(manifest.cwd) / trace_root
        gateway = self.gateway_factory(self.codex_bin, str(trace_root), session.request_approval)
        session.bind_interrupt(getattr(gateway, "interrupt", None))
        requested = list(manifest.memory.selected_thread_ids)
        resolved: list[str] = []
        excerpt_hashes: dict[str, str] = {}
        turns: list[str] = []
        usage_by_turn: dict[str, dict[str, Any]] = {}
        try:
            session.stage("setup", "Codex app-server starting", str(trace_root))
            gateway.start()
            excerpts: list[str] = []
            for thread_id in requested:
                excerpt = _thread_excerpt(gateway.read_thread(thread_id))
                if not excerpt:
                    raise ValueError(
                        f"selected thread has no readable user/assistant trace: {thread_id}"
                    )
                excerpts.append(f"[thread {thread_id}]\n{excerpt}")
                excerpt_hashes[thread_id] = "sha256:" + hashlib.sha256(excerpt.encode()).hexdigest()
                resolved.append(thread_id)
            session.stage(
                "memory",
                "Memory prepared",
                (
                    f"Injected {len(resolved)} exact thread excerpt(s)."
                    if manifest.memory.mode == "selected"
                    else "Native Codex memory enabled."
                    if manifest.memory.mode == "all"
                    else "Memory bypassed."
                ),
            )
            session.stage(
                "integrations",
                "Integration contract prepared",
                (
                    f"Requested {len(manifest.integrations.requested)} integration(s); "
                    "requests are instructional, not a hard tool allowlist."
                    if manifest.integrations.requested
                    else "Inherited the Codex environment without explicit integration requests."
                ),
            )

            approval_policy = "never" if manifest.agent.approval_gate == "deny" else "on-request"
            params: dict[str, Any] = {
                "cwd": manifest.cwd,
                "approvalPolicy": approval_policy,
                "approvalsReviewer": (
                    "auto_review" if manifest.agent.approval_gate == "auto-review" else "user"
                ),
                "sandbox": manifest.agent.sandbox,
                "serviceName": "weave_codex",
                "experimentalRawEvents": True,
                "config": {
                    "memories": {
                        "use_memories": manifest.memory.mode == "all",
                        "generate_memories": manifest.memory.mode == "all",
                    }
                },
            }
            if manifest.agent.model:
                params["model"] = manifest.agent.model
            thread_id = gateway.start_thread(params)
            session.stage("setup", "Thread started", f"Sandbox: {manifest.agent.sandbox}")
            gateway.set_memory_mode(
                thread_id, "enabled" if manifest.memory.mode == "all" else "disabled"
            )

            phase_executions: list[dict[str, Any]] = []
            checkpoints: list[dict[str, str]] = []
            completion_status = "completed"
            if manifest.phase_program is not None:
                phase_result = execute_phase_program(
                    manifest,
                    gateway=gateway,
                    session=session,
                    thread_id=thread_id,
                    selected_excerpts=excerpts,
                )
                turns = phase_result.turn_ids
                usage_by_turn = phase_result.usage_by_turn
                answer = phase_result.answer
                verification = phase_result.verification
                phase_executions = phase_result.executions
                checkpoints = phase_result.checkpoints
                completion_status = phase_result.completion_status
            else:
                session.stage(
                    "solver", "Solver turn started", "Codex may reason and use native tools."
                )
                solver = gateway.run_turn(
                    thread_id,
                    build_solver_prompt(manifest, excerpts),
                    effort=manifest.agent.reasoning_effort,
                    output_schema=None,
                    event_sink=lambda event: session.event(event, phase="solver"),
                )
                turns.append(solver.turn_id)
                if solver.usage is not None:
                    usage_by_turn[solver.turn_id] = solver.usage
                answer = solver.final_response
                session.stage("solver", "Solver turn finished", f"Turn {solver.turn_id}")
                if solver.status != "completed":
                    completion_status = "stopped"
                verification = []
                verifier_attempts = (
                    1 + manifest.verification.max_retries
                    if manifest.verification.enabled and completion_status == "completed"
                    else 0
                )
                for attempt in range(verifier_attempts):
                    phase = f"verifier-{attempt + 1}"
                    session.stage(
                        phase,
                        f"Verifier turn {attempt + 1} started",
                        "Checks the candidate and may return a repaired answer.",
                    )
                    prompt = (
                        "Verify the candidate against the stated task and this criterion:\n"
                        f"{manifest.verification.criteria}\n\nCandidate:\n{answer}\n\n"
                        "Return status=pass if it is ready. Otherwise repair it in answer "
                        "and list issues."
                    )
                    checked = gateway.run_turn(
                        thread_id,
                        prompt,
                        effort=manifest.agent.reasoning_effort,
                        output_schema=VERIFIER_SCHEMA,
                        event_sink=lambda event, current_phase=phase: session.event(
                            event, phase=current_phase
                        ),
                    )
                    turns.append(checked.turn_id)
                    if checked.usage is not None:
                        usage_by_turn[checked.turn_id] = checked.usage
                    parsed = json.loads(checked.final_response)
                    verification.append(
                        {
                            "attempt": attempt + 1,
                            "status": parsed["status"],
                            "issues": parsed["issues"],
                        }
                    )
                    answer = parsed["answer"]
                    session.stage(
                        phase,
                        f"Verifier turn {attempt + 1} finished",
                        f"Verdict: {parsed['status']}",
                    )
                    if parsed["status"] == "pass":
                        break

            completed_item_types = Counter(
                event.get("params", {}).get("item", {}).get("type", "unknown")
                for event in session.events
                if event.get("method") == "item/completed"
            )
            session.result = {
                "receiptVersion": 1,
                "runId": session.run_id,
                "manifestHash": manifest_hash(manifest),
                "workflow": {
                    "name": manifest.name,
                    "task": manifest.task.instructions,
                },
                "startedAt": started_at,
                "completedAt": int(time.time()),
                "threadId": thread_id,
                "turnIds": turns,
                "memory": {
                    "mode": manifest.memory.mode,
                    "requestedThreadIds": requested,
                    "resolvedThreadIds": resolved if manifest.memory.mode == "selected" else None,
                    "excerptHashes": excerpt_hashes,
                },
                "integrations": {
                    "inventoryId": manifest.integrations.inventory_id,
                    "bindingMode": "instructional",
                    "requested": [
                        item.model_dump(by_alias=True, mode="json")
                        for item in manifest.integrations.requested
                    ],
                    "observedToolItems": _integration_observations(session.events),
                    "attribution": (
                        "Requests are manifest-bound. Use is claimed only when an observable "
                        "integration tool item is present; skill loading is not inferred."
                    ),
                },
                "controls": {
                    "sandbox": manifest.agent.sandbox,
                    "approvalGate": manifest.agent.approval_gate,
                    "maximumTurns": (
                        phase_turn_bound(manifest.phase_program)
                        if manifest.phase_program is not None
                        else 1
                        + (
                            1 + manifest.verification.max_retries
                            if manifest.verification.enabled
                            else 0
                        )
                    ),
                },
                "completionStatus": completion_status,
                "phaseProgram": (
                    {
                        "projectionVersion": manifest.phase_program.projection_version,
                        "graph": manifest.phase_program.model_dump(by_alias=True, mode="json"),
                        "executions": phase_executions,
                        "checkpoints": checkpoints,
                        "internalLoopSemantics": (
                            "Work phases are controller turns; Codex-internal model and tool "
                            "iterations are observed events, not separately authored blocks."
                        ),
                    }
                    if manifest.phase_program is not None
                    else None
                ),
                "verification": verification,
                "usageByTurn": usage_by_turn,
                "observed": {
                    "modelCompletions": sum(
                        event.get("method") == "rawResponse/completed" for event in session.events
                    ),
                    "completedItemsByType": dict(completed_item_types),
                },
                "timeline": session.projected_timeline(),
                "finalResponse": answer,
                "traceRoot": str(trace_root),
            }
            session.stage("output", "Final output recorded", "Receipt persisted locally.")
            session.result["timeline"] = session.projected_timeline()
            session.result["traceProjection"] = project_events(
                session.events, receipt=session.result
            )
            session.status = "stopped" if completion_status == "stopped" else "completed"
        except Exception as exc:  # noqa: BLE001
            session.error = str(exc)
            session.stage("error", "Run failed", str(exc))
            session.status = "failed"
        finally:
            session.bind_interrupt(None)
            gateway.close()
