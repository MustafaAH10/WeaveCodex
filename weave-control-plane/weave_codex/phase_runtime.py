"""Execution of human-authored phases above Codex's native turn loop."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Protocol

from .manifest import VERIFIER_SCHEMA, HarnessManifest, integration_prompt

if TYPE_CHECKING:
    from collections.abc import Callable


class _Turn(Protocol):
    turn_id: str
    final_response: str
    status: str
    usage: dict[str, Any] | None


class PhaseGateway(Protocol):
    def run_turn(
        self,
        thread_id: str,
        prompt: str,
        *,
        effort: str,
        output_schema: dict[str, Any] | None,
        event_sink: Callable[[dict[str, Any]], None],
    ) -> _Turn: ...


class PhaseSession(Protocol):
    def event(self, value: dict[str, Any], *, phase: str = "runtime") -> None: ...
    def stage(self, phase: str, title: str, detail: str = "") -> None: ...
    def request_checkpoint(self, phase_id: str, question: str) -> dict[str, str]: ...


@dataclass
class PhaseRunResult:
    answer: str = ""
    turn_ids: list[str] = field(default_factory=list)
    usage_by_turn: dict[str, dict[str, Any]] = field(default_factory=dict)
    verification: list[dict[str, Any]] = field(default_factory=list)
    executions: list[dict[str, Any]] = field(default_factory=list)
    checkpoints: list[dict[str, str]] = field(default_factory=list)
    completion_status: str = "completed"


COMMAND_RESULT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "executedCommand": {"type": "string"},
        "exitCode": {"type": "integer"},
        "summary": {"type": "string"},
    },
    "required": ["executedCommand", "exitCode", "summary"],
    "additionalProperties": False,
}


def _command_prompt(
    manifest: HarnessManifest,
    *,
    phase_id: str,
    phase_name: str,
    step_type: str,
    command: str,
    expected_exit_code: int,
) -> str:
    return f"""Execute one fine-grained {step_type} step inside Codex's sandbox.

<overall_task>
{manifest.task.instructions}
</overall_task>
<step id="{phase_id}" name="{phase_name}">
Run exactly this command once, without combining it with another command:
{command}
</step>

Do not run exploratory commands or make changes beyond the effects of the declared command.
Return the exact command,
observed exit code, and a short factual summary. Success requires exit code {expected_exit_code}.
Weave will independently compare your structured report with the app-server command event."""


def _normalize_command(value: str) -> str:
    return " ".join(value.split())


def _observed_command_result(
    events: list[dict[str, Any]],
    *,
    requested: str,
    expected_exit_code: int,
) -> dict[str, Any]:
    """Fail closed unless one completed item carries the exact requested command."""

    requested_normalized = _normalize_command(requested)
    observed: list[dict[str, Any]] = []
    for event in events:
        if event.get("method") != "item/completed":
            continue
        params = event.get("params") if isinstance(event.get("params"), dict) else {}
        item = params.get("item") if isinstance(params.get("item"), dict) else {}
        if item.get("type") != "commandExecution":
            continue
        candidates: list[str] = []
        if isinstance(item.get("command"), str):
            candidates.append(item["command"])
        actions = item.get("commandActions") if isinstance(item.get("commandActions"), list) else []
        candidates.extend(
            action["command"]
            for action in actions
            if isinstance(action, dict) and isinstance(action.get("command"), str)
        )
        if any(_normalize_command(candidate) == requested_normalized for candidate in candidates):
            observed.append(item)
    exact = len(observed) == 1
    item = observed[0] if exact else {}
    exit_code = item.get("exitCode") if isinstance(item.get("exitCode"), int) else None
    passed = bool(exact and exit_code == expected_exit_code and item.get("status") == "completed")
    return {
        "status": "pass" if passed else "fail",
        "expectedExitCode": expected_exit_code,
        "observedExitCode": exit_code,
        "matchingCommandItems": len(observed),
        "evidence": (
            "One exact command completed with the expected exit code."
            if passed
            else "The exact command and expected exit code were not both observed."
        ),
    }


def _work_prompt(
    manifest: HarnessManifest,
    *,
    phase_id: str,
    phase_name: str,
    phase_scope: str,
    goal: str,
    selected_excerpts: list[str],
    first_work_phase: bool,
    human_feedback: str,
) -> str:
    context = "\n".join(f"- {path}" for path in manifest.task.context_paths) or "- none"
    if first_work_phase:
        memory = "\n\n".join(selected_excerpts) or "No selected trace content was supplied."
    else:
        memory = (
            "Selected memory, if any, was supplied once in the first work phase and remains in "
            "this thread's context. It is not duplicated here."
        )
    continuity = (
        "This is the first work phase. Establish the relevant evidence before acting."
        if first_work_phase
        else (
            "Continue in the same Codex thread. Earlier turns and their tool evidence are already "
            "in context; do not redo work without a concrete reason."
        )
    )
    feedback = human_feedback or "No new human direction was supplied at the preceding checkpoint."
    scope_contract = (
        "This is a broad adaptive goal. Choose the necessary internal sequence and use as many "
        "native tools as the outcome legitimately requires."
        if phase_scope == "adaptive"
        else (
            "This is a deliberately focused goal. Complete only the stated instruction; do not "
            "expand into adjacent refactors, features, or investigations."
        )
    )
    return f"""Execute this human-authored Codex work phase.

<overall_task>
{manifest.task.instructions}
</overall_task>
<phase id="{phase_id}" name="{phase_name}">
{goal}
</phase>
<granularity>{phase_scope}</granularity>
<context_paths>
{context}
</context_paths>
<selected_memory mode="{manifest.memory.mode}">
{memory}
</selected_memory>
<requested_integrations binding="instructional">
{integration_prompt(manifest, phase_id)}
</requested_integrations>
<human_checkpoint_feedback>
{feedback}
</human_checkpoint_feedback>

{continuity}
{scope_contract}
When checkpoint feedback is present, treat it as the user's latest instruction for this phase.
One phase is one controller turn, not one tool call. Use as many native Codex reasoning and tool
steps as the goal legitimately requires. Report the phase outcome and the evidence actually used."""


def _record_turn(result: PhaseRunResult, turn: _Turn) -> None:
    result.turn_ids.append(turn.turn_id)
    if turn.usage is not None:
        result.usage_by_turn[turn.turn_id] = turn.usage


def execute_phase_program(
    manifest: HarnessManifest,
    *,
    gateway: PhaseGateway,
    session: PhaseSession,
    thread_id: str,
    selected_excerpts: list[str],
) -> PhaseRunResult:
    """Execute an ordered phase program in a single persistent Codex thread."""

    program = manifest.phase_program
    if program is None:
        raise ValueError("phase program is required")
    result = PhaseRunResult()
    work_count = 0
    pending_human_feedback = ""
    for phase in program.phases:
        if phase.kind == "checkpoint":
            session.stage(phase.id, phase.name, phase.question)
            resolution = session.request_checkpoint(phase.id, phase.question)
            decision = resolution["decision"]
            checkpoint = {"phaseId": phase.id, "decision": decision}
            if feedback := resolution.get("feedback", ""):
                checkpoint["feedback"] = feedback
            result.checkpoints.append(checkpoint)
            result.executions.append(
                {
                    "phaseId": phase.id,
                    "name": phase.name,
                    "kind": phase.kind,
                    "turnIds": [],
                    "decision": decision,
                    **({"feedback": feedback} if feedback else {}),
                }
            )
            if decision not in {"accept", "acceptForSession"}:
                result.completion_status = "stoppedAtCheckpoint"
                break
            pending_human_feedback = feedback
            continue

        phase_turn_ids: list[str] = []
        execution_detail: dict[str, Any] = {}
        stop_after_execution = False
        if phase.kind == "work":
            work_count += 1
            execution_detail = {"scope": phase.scope}
            session.stage(
                phase.id,
                f"{phase.name} started",
                "Codex may perform many internal model and tool iterations in this phase.",
            )
            effort = (
                manifest.agent.reasoning_effort
                if phase.reasoning_effort == "inherit"
                else phase.reasoning_effort
            )
            turn = gateway.run_turn(
                thread_id,
                _work_prompt(
                    manifest,
                    phase_id=phase.id,
                    phase_name=phase.name,
                    phase_scope=phase.scope,
                    goal=phase.goal,
                    selected_excerpts=selected_excerpts,
                    first_work_phase=work_count == 1,
                    human_feedback=pending_human_feedback,
                ),
                effort=effort,
                output_schema=None,
                event_sink=lambda event, phase_id=phase.id: session.event(event, phase=phase_id),
            )
            _record_turn(result, turn)
            pending_human_feedback = ""
            phase_turn_ids.append(turn.turn_id)
            result.answer = turn.final_response
            if turn.status != "completed":
                result.completion_status = "stopped"
                execution_detail["status"] = "stopped"
                stop_after_execution = True
                session.stage(phase.id, f"{phase.name} stopped", f"Turn {turn.turn_id}")
            else:
                session.stage(phase.id, f"{phase.name} finished", f"Turn {turn.turn_id}")
        elif phase.kind == "command":
            session.stage(
                phase.id,
                f"{phase.name} started",
                f"Codex must run one exact {phase.step_type} command.",
            )
            phase_events: list[dict[str, Any]] = []

            def command_event_sink(
                event: dict[str, Any],
                *,
                captured: list[dict[str, Any]] = phase_events,
                phase_id: str = phase.id,
            ) -> None:
                captured.append(event)
                session.event(event, phase=phase_id)

            turn = gateway.run_turn(
                thread_id,
                _command_prompt(
                    manifest,
                    phase_id=phase.id,
                    phase_name=phase.name,
                    step_type=phase.step_type,
                    command=phase.command,
                    expected_exit_code=phase.expected_exit_code,
                ),
                effort="low",
                output_schema=COMMAND_RESULT_SCHEMA,
                event_sink=command_event_sink,
            )
            _record_turn(result, turn)
            phase_turn_ids.append(turn.turn_id)
            if turn.status != "completed":
                passed = False
                execution_detail = {
                    "stepType": phase.step_type,
                    "command": phase.command,
                    "status": "stopped",
                    "expectedExitCode": phase.expected_exit_code,
                    "observedExitCode": None,
                    "matchingCommandItems": 0,
                    "summary": "The run was stopped before this check completed.",
                    "evidence": "No passing result is claimed for an interrupted check.",
                }
                result.completion_status = "stopped"
                stop_after_execution = True
            else:
                reported = json.loads(turn.final_response)
                observed = _observed_command_result(
                    phase_events,
                    requested=phase.command,
                    expected_exit_code=phase.expected_exit_code,
                )
                report_agrees = bool(
                    _normalize_command(reported["executedCommand"])
                    == _normalize_command(phase.command)
                    and reported["exitCode"] == phase.expected_exit_code
                )
                passed = observed["status"] == "pass" and report_agrees
                execution_detail = {
                    "stepType": phase.step_type,
                    "command": phase.command,
                    "status": "pass" if passed else "fail",
                    "expectedExitCode": phase.expected_exit_code,
                    "observedExitCode": observed["observedExitCode"],
                    "matchingCommandItems": observed["matchingCommandItems"],
                    "summary": reported["summary"],
                    "evidence": observed["evidence"],
                }
            stage_outcome = (
                "passed"
                if passed
                else "stopped"
                if execution_detail["status"] == "stopped"
                else "failed"
            )
            session.stage(
                phase.id,
                f"{phase.name} {stage_outcome}",
                execution_detail["evidence"],
            )
            if not passed and phase.stop_on_failure:
                result.completion_status = "failedCheck"
                stop_after_execution = True
        else:
            for attempt in range(1 + phase.max_repairs):
                attempt_phase = phase.id if attempt == 0 else f"{phase.id}-repair-{attempt}"
                action = "verification" if attempt == 0 else "repair verification"
                session.stage(
                    attempt_phase,
                    f"{phase.name}: {action} started",
                    phase.criteria,
                )
                feedback_context = (
                    f"\n\nLatest human checkpoint feedback:\n{pending_human_feedback}"
                    if pending_human_feedback
                    else ""
                )
                prompt = (
                    "Verify the current result against the overall task and criterion below.\n\n"
                    f"Criterion:\n{phase.criteria}\n\nCurrent result:\n{result.answer}\n\n"
                    f"{feedback_context}\n\n"
                    "Return status=pass if ready. Otherwise repair the result in answer and list "
                    "the issues. Use native tools when evidence must be checked."
                )
                turn = gateway.run_turn(
                    thread_id,
                    prompt,
                    effort=manifest.agent.reasoning_effort,
                    output_schema=VERIFIER_SCHEMA,
                    event_sink=lambda event, current=attempt_phase: session.event(
                        event, phase=current
                    ),
                )
                _record_turn(result, turn)
                pending_human_feedback = ""
                phase_turn_ids.append(turn.turn_id)
                if turn.status != "completed":
                    result.completion_status = "stopped"
                    execution_detail = {"status": "stopped"}
                    stop_after_execution = True
                    session.stage(
                        attempt_phase,
                        f"{phase.name}: {action} stopped",
                        f"Turn {turn.turn_id}",
                    )
                    break
                parsed = json.loads(turn.final_response)
                result.verification.append(
                    {
                        "phaseId": phase.id,
                        "attempt": attempt + 1,
                        "status": parsed["status"],
                        "issues": parsed["issues"],
                    }
                )
                result.answer = parsed["answer"]
                session.stage(
                    attempt_phase,
                    f"{phase.name}: {action} finished",
                    f"Verdict: {parsed['status']}",
                )
                if parsed["status"] == "pass":
                    break
        result.executions.append(
            {
                "phaseId": phase.id,
                "name": phase.name,
                "kind": phase.kind,
                "turnIds": phase_turn_ids,
                **execution_detail,
            }
        )
        if stop_after_execution:
            break
    return result
