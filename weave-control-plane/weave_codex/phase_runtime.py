"""Execution of human-authored phases above Codex's native turn loop."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Protocol

from .manifest import VERIFIER_SCHEMA, HarnessManifest

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
    def request_checkpoint(self, phase_id: str, question: str) -> str: ...


@dataclass
class PhaseRunResult:
    answer: str = ""
    turn_ids: list[str] = field(default_factory=list)
    usage_by_turn: dict[str, dict[str, Any]] = field(default_factory=dict)
    verification: list[dict[str, Any]] = field(default_factory=list)
    executions: list[dict[str, Any]] = field(default_factory=list)
    checkpoints: list[dict[str, str]] = field(default_factory=list)
    completion_status: str = "completed"


def _work_prompt(
    manifest: HarnessManifest,
    *,
    phase_id: str,
    phase_name: str,
    goal: str,
    selected_excerpts: list[str],
    first_work_phase: bool,
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
    return f"""Execute this human-authored Codex work phase.

<overall_task>
{manifest.task.instructions}
</overall_task>
<phase id="{phase_id}" name="{phase_name}">
{goal}
</phase>
<context_paths>
{context}
</context_paths>
<selected_memory mode="{manifest.memory.mode}">
{memory}
</selected_memory>

{continuity}
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
    for phase in program.phases:
        if phase.kind == "checkpoint":
            session.stage(phase.id, phase.name, phase.question)
            decision = session.request_checkpoint(phase.id, phase.question)
            result.checkpoints.append({"phaseId": phase.id, "decision": decision})
            result.executions.append(
                {
                    "phaseId": phase.id,
                    "kind": phase.kind,
                    "turnIds": [],
                    "decision": decision,
                }
            )
            if decision not in {"accept", "acceptForSession"}:
                result.completion_status = "stoppedAtCheckpoint"
                break
            continue

        phase_turn_ids: list[str] = []
        if phase.kind == "work":
            work_count += 1
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
                    goal=phase.goal,
                    selected_excerpts=selected_excerpts,
                    first_work_phase=work_count == 1,
                ),
                effort=effort,
                output_schema=None,
                event_sink=lambda event, phase_id=phase.id: session.event(
                    event, phase=phase_id
                ),
            )
            _record_turn(result, turn)
            phase_turn_ids.append(turn.turn_id)
            result.answer = turn.final_response
            session.stage(phase.id, f"{phase.name} finished", f"Turn {turn.turn_id}")
        else:
            for attempt in range(1 + phase.max_repairs):
                attempt_phase = phase.id if attempt == 0 else f"{phase.id}-repair-{attempt}"
                action = "verification" if attempt == 0 else "repair verification"
                session.stage(
                    attempt_phase,
                    f"{phase.name}: {action} started",
                    phase.criteria,
                )
                prompt = (
                    "Verify the current result against the overall task and criterion below.\n\n"
                    f"Criterion:\n{phase.criteria}\n\nCurrent result:\n{result.answer}\n\n"
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
                phase_turn_ids.append(turn.turn_id)
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
            {"phaseId": phase.id, "kind": phase.kind, "turnIds": phase_turn_ids}
        )
    return result
