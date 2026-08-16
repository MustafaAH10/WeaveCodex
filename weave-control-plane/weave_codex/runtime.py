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
    _decision: str | None = None
    _condition: threading.Condition = field(default_factory=threading.Condition, repr=False)

    def snapshot(self) -> dict[str, Any]:
        with self._condition:
            return {
                "runId": self.run_id,
                "status": self.status,
                "events": list(self.events[-120:]),
                "pendingApproval": self.pending_approval,
                "result": self.result,
                "error": self.error,
            }

    def event(self, value: dict[str, Any]) -> None:
        encoded = json.dumps(value, default=str)
        if len(encoded) > 16_000:
            value = {"method": value.get("method", "event"), "truncated": True}
        with self._condition:
            self.events.append(value)

    def request_approval(self, method: str, params: dict[str, Any] | None) -> dict[str, Any]:
        if method not in {
            "item/commandExecution/requestApproval",
            "item/fileChange/requestApproval",
        }:
            return {"decision": "cancel"}
        with self._condition:
            self.pending_approval = {"method": method, "params": params or {}}
            self.status = "waitingForApproval"
            self._condition.notify_all()
            deadline = time.monotonic() + 300
            while self._decision is None and time.monotonic() < deadline:
                self._condition.wait(timeout=1)
            decision = self._decision or "decline"
            self._decision = None
            self.pending_approval = None
            self.status = "running"
            return {"decision": decision}

    def decide(self, decision: str) -> None:
        if decision not in {"accept", "acceptForSession", "decline", "cancel"}:
            raise ValueError("unsupported approval decision")
        with self._condition:
            if self.pending_approval is None:
                raise ValueError("this run has no pending approval")
            self._decision = decision
            self._condition.notify_all()


class _EmptyResponse(BaseModel):
    pass


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

    def run(self, manifest: HarnessManifest, session: RunSession) -> None:
        started_at = int(time.time())
        session.status = "running"
        trace_root = Path(manifest.observability.trace_root)
        if not trace_root.is_absolute():
            trace_root = Path(manifest.cwd) / trace_root
        gateway = self.gateway_factory(self.codex_bin, str(trace_root), session.request_approval)
        requested = list(manifest.memory.selected_thread_ids)
        resolved: list[str] = []
        excerpt_hashes: dict[str, str] = {}
        turns: list[str] = []
        usage_by_turn: dict[str, dict[str, Any]] = {}
        try:
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
            gateway.set_memory_mode(
                thread_id, "enabled" if manifest.memory.mode == "all" else "disabled"
            )

            solver = gateway.run_turn(
                thread_id,
                build_solver_prompt(manifest, excerpts),
                effort=manifest.agent.reasoning_effort,
                output_schema=None,
                event_sink=session.event,
            )
            turns.append(solver.turn_id)
            if solver.usage is not None:
                usage_by_turn[solver.turn_id] = solver.usage
            answer = solver.final_response
            verification: list[dict[str, Any]] = []
            for attempt in range(
                1 + manifest.verification.max_retries if manifest.verification.enabled else 0
            ):
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
                    event_sink=session.event,
                )
                turns.append(checked.turn_id)
                if checked.usage is not None:
                    usage_by_turn[checked.turn_id] = checked.usage
                parsed = json.loads(checked.final_response)
                verification.append(
                    {"attempt": attempt + 1, "status": parsed["status"], "issues": parsed["issues"]}
                )
                answer = parsed["answer"]
                if parsed["status"] == "pass":
                    break

            completed_item_types = Counter(
                event.get("params", {}).get("item", {}).get("type", "unknown")
                for event in session.events
                if event.get("method") == "item/completed"
            )
            session.result = {
                "receiptVersion": 1,
                "manifestHash": manifest_hash(manifest),
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
                "controls": {
                    "sandbox": manifest.agent.sandbox,
                    "approvalGate": manifest.agent.approval_gate,
                    "maximumTurns": 1
                    + (
                        1 + manifest.verification.max_retries
                        if manifest.verification.enabled
                        else 0
                    ),
                },
                "verification": verification,
                "usageByTurn": usage_by_turn,
                "observed": {
                    "modelCompletions": sum(
                        event.get("method") == "rawResponse/completed" for event in session.events
                    ),
                    "completedItemsByType": dict(completed_item_types),
                },
                "finalResponse": answer,
                "traceRoot": str(trace_root),
            }
            session.status = "completed"
        except Exception as exc:  # noqa: BLE001
            session.error = str(exc)
            session.status = "failed"
        finally:
            gateway.close()
