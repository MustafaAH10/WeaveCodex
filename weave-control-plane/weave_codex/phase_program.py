"""Human-owned, phase-level programs for Codex.

One ``work`` phase maps to one app-server ``turn/start`` operation.  Codex may
perform many model completions and tool calls inside that turn; those internal
items are observed after execution but are deliberately not user-authored graph
nodes.
"""

from __future__ import annotations

import re
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class _StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class WorkPhase(_StrictModel):
    id: str = Field(min_length=2, max_length=48, pattern=r"^[a-z][a-z0-9-]*$")
    kind: Literal["work"] = "work"
    name: str = Field(min_length=2, max_length=80)
    goal: str = Field(min_length=4, max_length=4_000)
    scope: Literal["adaptive", "focused"] = "adaptive"
    reasoning_effort: Literal["inherit", "low", "medium", "high", "xhigh"] = Field(
        default="inherit", alias="reasoningEffort"
    )


class CheckpointPhase(_StrictModel):
    id: str = Field(min_length=2, max_length=48, pattern=r"^[a-z][a-z0-9-]*$")
    kind: Literal["checkpoint"] = "checkpoint"
    name: str = Field(min_length=2, max_length=80)
    question: str = Field(min_length=4, max_length=1_000)


class VerifyPhase(_StrictModel):
    id: str = Field(min_length=2, max_length=48, pattern=r"^[a-z][a-z0-9-]*$")
    kind: Literal["verify"] = "verify"
    name: str = Field(min_length=2, max_length=80)
    criteria: str = Field(min_length=4, max_length=2_000)
    max_repairs: int = Field(default=1, alias="maxRepairs", ge=0, le=2)


class CommandPhase(_StrictModel):
    """One exact command delegated to Codex's sandboxed tool loop.

    Weave never invokes this command directly on the host. A dedicated Codex
    turn is instructed to run it exactly once, and the receipt is marked passed
    only when the matching completed command is observed in app-server events.
    """

    id: str = Field(min_length=2, max_length=48, pattern=r"^[a-z][a-z0-9-]*$")
    kind: Literal["command"] = "command"
    step_type: Literal["function", "test", "checker"] = Field(default="test", alias="stepType")
    name: str = Field(min_length=2, max_length=80)
    command: str = Field(min_length=2, max_length=2_000)
    expected_exit_code: int = Field(default=0, alias="expectedExitCode", ge=0, le=255)
    stop_on_failure: bool = Field(default=True, alias="stopOnFailure")


Phase = Annotated[
    WorkPhase | CheckpointPhase | VerifyPhase | CommandPhase,
    Field(discriminator="kind"),
]


class PhaseProgram(_StrictModel):
    """An ordered executable program above Codex's native agent loop."""

    projection_version: Literal[1] = Field(default=1, alias="projectionVersion")
    phases: list[Phase] = Field(min_length=1, max_length=16)

    @model_validator(mode="after")
    def validate_program(self) -> PhaseProgram:
        ids = [phase.id for phase in self.phases]
        if len(ids) != len(set(ids)):
            raise ValueError("phase ids must be unique")
        if not any(phase.kind == "work" for phase in self.phases):
            raise ValueError("a phase program requires at least one work phase")
        if self.phases[0].kind != "work":
            raise ValueError("the first executable phase must be a work phase")
        for left, right in zip(self.phases, self.phases[1:], strict=False):
            if left.kind == right.kind == "checkpoint":
                raise ValueError("adjacent checkpoints are not executable")
        return self


def phase_turn_bound(program: PhaseProgram) -> int:
    """Return controller turns, not internal Codex model/tool iterations."""

    total = 0
    for phase in program.phases:
        if phase.kind == "work":
            total += 1
        elif phase.kind == "command":
            total += 1
        elif phase.kind == "verify":
            total += 1 + phase.max_repairs
    return total


def compile_phase_program(program: PhaseProgram) -> dict[str, object]:
    """Compile a phase program to a truthful, UI-ready sequential graph."""

    nodes: list[dict[str, object]] = [
        {
            "id": "task",
            "kind": "task",
            "label": "Task",
            "detail": "Human goal and workspace context",
            "editable": False,
        }
    ]
    edges: list[dict[str, str]] = []
    previous = "task"
    for position, phase in enumerate(program.phases, start=1):
        if phase.kind == "work":
            detail = (
                "One broad adaptive Codex turn · internal tool loop is Codex-managed"
                if phase.scope == "adaptive"
                else "One deliberately focused Codex turn · scope expansion is prohibited"
            )
            turn_cost = 1
        elif phase.kind == "checkpoint":
            detail = "Human continue, redirect with feedback, or stop · no model call"
            turn_cost = 0
        elif phase.kind == "command":
            detail = (
                f"One exact {phase.step_type} command · pass requires observed exit "
                f"code {phase.expected_exit_code}"
            )
            turn_cost = 1
        else:
            detail = f"One verifier turn · up to {phase.max_repairs} repair turn(s)"
            turn_cost = 1 + phase.max_repairs
        nodes.append(
            {
                "id": phase.id,
                "kind": phase.kind,
                "label": phase.name,
                "detail": detail,
                "position": position,
                "editable": True,
                "maximumControllerTurns": turn_cost,
            }
        )
        edges.append({"from": previous, "to": phase.id, "condition": "next"})
        previous = phase.id
    nodes.append(
        {
            "id": "output",
            "kind": "output",
            "label": "Output + receipt",
            "detail": "Final answer and observed execution evidence",
            "editable": False,
        }
    )
    edges.append({"from": previous, "to": "output", "condition": "next"})
    return {
        "projectionVersion": program.projection_version,
        "nodes": nodes,
        "edges": edges,
        "maximumControllerTurns": phase_turn_bound(program),
        "internalLoopSemantics": (
            "Each work phase starts one Codex controller turn. The number of model completions "
            "and native tool calls inside that turn is observed, not authored by this graph."
        ),
        "executionOrder": [phase.id for phase in program.phases],
    }


def phase_templates() -> list[dict[str, object]]:
    """Return small, reviewable starting programs for the canvas."""

    templates = [
        (
            "fine-grained-fix",
            "Inspect, fix, test, and check",
            "A credible engineering loop with narrow Codex goals and exact pass/fail commands.",
            [
                WorkPhase(
                    id="inspect-problem",
                    name="Find the cause",
                    scope="focused",
                    goal=(
                        "Inspect the relevant implementation and tests. Explain the smallest "
                        "supported fix."
                    ),
                    reasoningEffort="low",
                ),
                WorkPhase(
                    id="make-fix",
                    name="Make the focused fix",
                    scope="focused",
                    goal="Implement only the supported change. Do not broaden the task.",
                ),
                CommandPhase(
                    id="run-focused-test",
                    stepType="test",
                    name="Run the focused test",
                    command="python -m pytest -q path/to/test_file.py::test_name",
                ),
                CommandPhase(
                    id="run-static-check",
                    stepType="checker",
                    name="Run the static checker",
                    command="python -m compileall -q .",
                ),
                VerifyPhase(
                    id="review-evidence",
                    name="Review the evidence",
                    criteria="The requested change is narrow and both exact checks passed.",
                    maxRepairs=0,
                ),
            ],
        ),
        (
            "inspect",
            "Inspect and explain",
            "One autonomous Codex phase for evidence gathering and an answer.",
            [
                WorkPhase(
                    id="inspect-and-answer",
                    name="Inspect and answer",
                    goal="Inspect the relevant workspace evidence and answer the task.",
                )
            ],
        ),
        (
            "plan-build-check",
            "Plan, build, then check",
            "Pause after inspection, then implement and verify in later controller turns.",
            [
                WorkPhase(
                    id="inspect-and-plan",
                    name="Inspect and plan",
                    goal="Understand the codebase and propose a concrete implementation plan.",
                ),
                CheckpointPhase(
                    id="approve-plan",
                    name="Approve the plan",
                    question="Continue from the proposed plan into implementation?",
                ),
                WorkPhase(
                    id="implement-and-test",
                    name="Implement and test",
                    goal="Implement the approved plan and run focused verification.",
                ),
                VerifyPhase(
                    id="verify-result",
                    name="Verify the result",
                    criteria="The requested behavior is implemented and supported by checks.",
                    max_repairs=1,
                ),
            ],
        ),
        (
            "review-repair",
            "Independent review and repair",
            "Build first, then use a structured verifier with one bounded repair turn.",
            [
                WorkPhase(
                    id="complete-task",
                    name="Complete the task",
                    goal="Complete the task using Codex's native tools and report the result.",
                ),
                VerifyPhase(
                    id="review-and-repair",
                    name="Review and repair",
                    criteria="The result is correct, complete, and grounded in inspected evidence.",
                    max_repairs=1,
                ),
            ],
        ),
    ]
    return [
        {
            "id": template_id,
            "name": name,
            "description": description,
            "program": PhaseProgram(phases=phases).model_dump(by_alias=True, mode="json"),
        }
        for template_id, name, description, phases in templates
    ]


def safe_phase_id(name: str, existing: set[str] | None = None) -> str:
    """Create a stable, schema-valid id for UI-authored phases."""

    base = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") or "phase"
    if not base[0].isalpha():
        base = f"phase-{base}"
    base = base[:48].rstrip("-")
    taken = existing or set()
    candidate = base
    suffix = 2
    while candidate in taken:
        ending = f"-{suffix}"
        candidate = f"{base[: 48 - len(ending)].rstrip('-')}{ending}"
        suffix += 1
    return candidate
