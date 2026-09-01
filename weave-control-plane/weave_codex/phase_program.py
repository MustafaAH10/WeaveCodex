"""Human-owned, phase-level programs for Codex.

One ``work`` phase maps to one app-server ``turn/start`` operation.  Codex may
perform many model completions and tool calls inside that turn; those internal
items are observed after execution but are deliberately not user-authored graph
nodes.
"""

# Workflow prose remains in whole source strings so the canvas and API expose
# identical copy without runtime joining or whitespace normalization.
# ruff: noqa: E501

from __future__ import annotations

import re
from collections import defaultdict
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class _StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class CanvasPosition(_StrictModel):
    """Human-authored placement on the visual workflow canvas."""

    x: int = Field(ge=0, le=4_000)
    y: int = Field(ge=0, le=3_000)


class PhaseEdge(_StrictModel):
    """A directed dependency between two executable nodes."""

    from_id: str = Field(alias="from", min_length=2, max_length=48)
    to_id: str = Field(alias="to", min_length=2, max_length=48)


class WorkPhase(_StrictModel):
    id: str = Field(min_length=2, max_length=48, pattern=r"^[a-z][a-z0-9-]*$")
    kind: Literal["work"] = "work"
    name: str = Field(min_length=2, max_length=80)
    goal: str = Field(min_length=4, max_length=4_000)
    scope: Literal["adaptive", "focused"] = "adaptive"
    reasoning_effort: Literal["inherit", "low", "medium", "high", "xhigh"] = Field(
        default="inherit", alias="reasoningEffort"
    )
    position: CanvasPosition | None = None


class CheckpointPhase(_StrictModel):
    id: str = Field(min_length=2, max_length=48, pattern=r"^[a-z][a-z0-9-]*$")
    kind: Literal["checkpoint"] = "checkpoint"
    name: str = Field(min_length=2, max_length=80)
    question: str = Field(min_length=4, max_length=1_000)
    position: CanvasPosition | None = None


class VerifyPhase(_StrictModel):
    id: str = Field(min_length=2, max_length=48, pattern=r"^[a-z][a-z0-9-]*$")
    kind: Literal["verify"] = "verify"
    name: str = Field(min_length=2, max_length=80)
    criteria: str = Field(min_length=4, max_length=2_000)
    max_repairs: int = Field(default=1, alias="maxRepairs", ge=0, le=2)
    position: CanvasPosition | None = None


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
    position: CanvasPosition | None = None


Phase = Annotated[
    WorkPhase | CheckpointPhase | VerifyPhase | CommandPhase,
    Field(discriminator="kind"),
]


class PhaseProgram(_StrictModel):
    """A user-authored executable graph above Codex's native agent loop.

    Older saved workflows may omit ``edges``; those retain their original
    left-to-right list order. Once edges are present they become the source of
    truth for dependency and turn order.
    """

    projection_version: Literal[1] = Field(default=1, alias="projectionVersion")
    phases: list[Phase] = Field(min_length=1, max_length=16)
    edges: list[PhaseEdge] = Field(default_factory=list, max_length=40)

    @model_validator(mode="after")
    def validate_program(self) -> PhaseProgram:
        ids = [phase.id for phase in self.phases]
        if len(ids) != len(set(ids)):
            raise ValueError("phase ids must be unique")
        if not any(phase.kind == "work" for phase in self.phases):
            raise ValueError("a phase program requires at least one work phase")
        ordered = ordered_phases(self)
        if ordered[0].kind != "work":
            raise ValueError("the first executable phase must be a work phase")
        for left, right in zip(ordered, ordered[1:], strict=False):
            if left.kind == right.kind == "checkpoint":
                raise ValueError("adjacent checkpoints are not executable")
        return self


def ordered_phases(program: PhaseProgram) -> list[Phase]:
    """Return stable dependency order, rejecting decorative or cyclic graphs."""

    if not program.edges:
        return list(program.phases)
    by_id = {phase.id: phase for phase in program.phases}
    position = {phase.id: index for index, phase in enumerate(program.phases)}
    identities = [(edge.from_id, edge.to_id) for edge in program.edges]
    if len(identities) != len(set(identities)):
        raise ValueError("phase edges must be unique")
    unknown = {item for edge in identities for item in edge if item not in by_id}
    if unknown:
        raise ValueError("phase edges reference unknown nodes: " + ", ".join(sorted(unknown)))
    if any(source == target for source, target in identities):
        raise ValueError("a phase cannot connect to itself")

    incoming = {phase.id: 0 for phase in program.phases}
    outgoing: dict[str, list[str]] = defaultdict(list)
    for source, target in identities:
        incoming[target] += 1
        outgoing[source].append(target)
    roots = [phase.id for phase in program.phases if incoming[phase.id] == 0]
    if len(roots) != 1:
        raise ValueError("an executable graph requires exactly one starting node")

    ready = roots[:]
    ordered_ids: list[str] = []
    while ready:
        ready.sort(key=position.__getitem__)
        current = ready.pop(0)
        ordered_ids.append(current)
        for target in sorted(outgoing[current], key=position.__getitem__):
            incoming[target] -= 1
            if incoming[target] == 0:
                ready.append(target)
    if len(ordered_ids) != len(program.phases):
        raise ValueError("workflow arrows must form one connected acyclic graph")
    return [by_id[phase_id] for phase_id in ordered_ids]


def phase_turn_bound(program: PhaseProgram) -> int:
    """Return controller turns, not internal Codex model/tool iterations."""

    total = 0
    for phase in ordered_phases(program):
        if phase.kind == "work":
            total += 1
        elif phase.kind == "command":
            total += 1
        elif phase.kind == "verify":
            total += 1 + phase.max_repairs
    return total


def compile_phase_program(program: PhaseProgram) -> dict[str, object]:
    """Compile a phase program to a truthful, UI-ready executable graph."""

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
    ordered = ordered_phases(program)
    for position, phase in enumerate(ordered, start=1):
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
                "order": position,
                "editable": True,
                "maximumControllerTurns": turn_cost,
                **(
                    {"position": phase.position.model_dump(mode="json")}
                    if phase.position is not None
                    else {}
                ),
            }
        )
    if program.edges:
        incoming = {phase.id: 0 for phase in program.phases}
        outgoing = {phase.id: 0 for phase in program.phases}
        for edge in program.edges:
            incoming[edge.to_id] += 1
            outgoing[edge.from_id] += 1
            edges.append({"from": edge.from_id, "to": edge.to_id, "condition": "next"})
        for phase in program.phases:
            if incoming[phase.id] == 0:
                edges.append({"from": "task", "to": phase.id, "condition": "start"})
            if outgoing[phase.id] == 0:
                edges.append({"from": phase.id, "to": "output", "condition": "finish"})
    else:
        previous = "task"
        for phase in ordered:
            edges.append({"from": previous, "to": phase.id, "condition": "next"})
            previous = phase.id
        edges.append({"from": previous, "to": "output", "condition": "next"})
    nodes.append(
        {
            "id": "output",
            "kind": "output",
            "label": "Output + receipt",
            "detail": "Final answer and observed execution evidence",
            "editable": False,
        }
    )
    return {
        "projectionVersion": program.projection_version,
        "nodes": nodes,
        "edges": edges,
        "maximumControllerTurns": phase_turn_bound(program),
        "internalLoopSemantics": (
            "Each work phase starts one Codex controller turn. The number of model completions "
            "and native tool calls inside that turn is observed, not authored by this graph."
        ),
        "executionOrder": [phase.id for phase in ordered],
    }


def phase_templates() -> list[dict[str, object]]:
    """Return executable, positioned starting programs for the public canvas.

    The templates intentionally span different levels of abstraction.  A work
    node can own a broad outcome while a command node remains one exact check.
    Keeping these programs here makes the API, canvas, and runtime share one
    definition instead of maintaining a second decorative JavaScript catalog.
    """

    templates: list[dict[str, object]] = [
        {
            "id": "fine-grained-fix",
            "name": "Fix one bug precisely",
            "audience": "Engineering",
            "description": "Five narrow steps with two exact pass/fail commands.",
            "phases": [
                WorkPhase(
                    id="inspect-problem",
                    name="Find the cause",
                    scope="focused",
                    goal=(
                        "Inspect the relevant implementation and tests. Explain the smallest "
                        "supported fix."
                    ),
                    reasoningEffort="low",
                    position=CanvasPosition(x=80, y=360),
                ),
                WorkPhase(
                    id="make-fix",
                    name="Make the focused fix",
                    scope="focused",
                    goal="Implement only the supported change. Do not broaden the task.",
                    position=CanvasPosition(x=390, y=360),
                ),
                CommandPhase(
                    id="run-focused-test",
                    stepType="test",
                    name="Run the focused test",
                    command="python3 -m pytest -q path/to/test_file.py::test_name",
                    position=CanvasPosition(x=700, y=360),
                ),
                CommandPhase(
                    id="run-static-check",
                    stepType="checker",
                    name="Run the static checker",
                    command="python -m compileall -q .",
                    position=CanvasPosition(x=1010, y=360),
                ),
                VerifyPhase(
                    id="review-evidence",
                    name="Review the evidence",
                    criteria="The requested change is narrow and both exact checks passed.",
                    maxRepairs=0,
                    position=CanvasPosition(x=1320, y=360),
                ),
            ],
            "edges": [
                ("inspect-problem", "make-fix"),
                ("make-fix", "run-focused-test"),
                ("run-focused-test", "run-static-check"),
                ("run-static-check", "review-evidence"),
            ],
        },
        {
            "id": "frontend-launch",
            "name": "Design and launch a frontend",
            "audience": "Design + frontend",
            "description": "Ten steps from visual direction to browser and accessibility checks.",
            "phases": [
                WorkPhase(
                    id="inspect-product",
                    name="Understand the product",
                    goal="Inspect the existing product, brand, routes, and constraints. Describe the user problem and the current visual system.",
                    position=CanvasPosition(x=80, y=360),
                ),
                WorkPhase(
                    id="explore-directions",
                    name="Explore three directions",
                    goal="Create three materially different visual directions with typography, color, layout, motion, and interaction rationale. Do not implement one yet.",
                    position=CanvasPosition(x=390, y=360),
                ),
                CheckpointPhase(
                    id="choose-direction",
                    name="Choose a direction",
                    question="Which direction should continue, and what should change before implementation?",
                    position=CanvasPosition(x=700, y=360),
                ),
                WorkPhase(
                    id="define-system",
                    name="Define the design system",
                    scope="focused",
                    goal="Turn the approved direction into tokens, component rules, responsive behavior, and accessibility constraints.",
                    position=CanvasPosition(x=1010, y=120),
                ),
                WorkPhase(
                    id="build-components",
                    name="Build the components",
                    scope="focused",
                    goal="Implement the reusable UI components and interaction states against the approved design system.",
                    position=CanvasPosition(x=1320, y=120),
                ),
                WorkPhase(
                    id="assemble-experience",
                    name="Assemble the experience",
                    goal="Compose the components into the complete user flow, connect existing data and routes, and keep the implementation coherent.",
                    position=CanvasPosition(x=1630, y=360),
                ),
                CommandPhase(
                    id="run-ui-tests",
                    name="Run the UI tests",
                    stepType="test",
                    command="npm test -- --runInBand",
                    position=CanvasPosition(x=1940, y=120),
                ),
                WorkPhase(
                    id="inspect-browser",
                    name="Inspect the rendered UI",
                    scope="focused",
                    goal="Open the running experience, inspect layout and interaction at desktop width, and repair visible defects without changing the approved direction.",
                    position=CanvasPosition(x=1940, y=600),
                ),
                CommandPhase(
                    id="run-accessibility",
                    name="Run accessibility checks",
                    stepType="checker",
                    command="npm run test:a11y",
                    position=CanvasPosition(x=2250, y=120),
                ),
                VerifyPhase(
                    id="release-review",
                    name="Review the release",
                    criteria="The approved visual direction is implemented, the primary flow works, exact checks pass, and no visible high-severity issue remains.",
                    maxRepairs=1,
                    position=CanvasPosition(x=2250, y=600),
                ),
            ],
            "edges": [
                ("inspect-product", "explore-directions"),
                ("explore-directions", "choose-direction"),
                ("choose-direction", "define-system"),
                ("define-system", "build-components"),
                ("build-components", "assemble-experience"),
                ("assemble-experience", "run-ui-tests"),
                ("assemble-experience", "inspect-browser"),
                ("run-ui-tests", "run-accessibility"),
                ("run-accessibility", "release-review"),
                ("inspect-browser", "release-review"),
            ],
        },
        {
            "id": "data-analysis",
            "name": "Turn raw data into a decision",
            "audience": "Data analysis",
            "description": "Nine steps with parallel cleaning, metric definition, and a human assumptions gate.",
            "phases": [
                WorkPhase(
                    id="inspect-sources",
                    name="Inspect the sources",
                    goal="Inspect the available data files, definitions, time ranges, and business question. Record uncertainties without silently filling them in.",
                    position=CanvasPosition(x=80, y=360),
                ),
                WorkPhase(
                    id="profile-data",
                    name="Profile data quality",
                    scope="focused",
                    goal="Profile schemas, missingness, duplicates, ranges, join keys, and suspicious values. Produce a concise quality report.",
                    position=CanvasPosition(x=390, y=360),
                ),
                WorkPhase(
                    id="clean-data",
                    name="Prepare a clean dataset",
                    scope="focused",
                    goal="Create a reproducible cleaning step that addresses only supported data-quality issues and preserves source provenance.",
                    position=CanvasPosition(x=700, y=120),
                ),
                WorkPhase(
                    id="define-metrics",
                    name="Define the metrics",
                    scope="focused",
                    goal="Translate the decision question into explicit formulas, denominators, segments, and comparison windows. Do not compute conclusions yet.",
                    position=CanvasPosition(x=700, y=600),
                ),
                CommandPhase(
                    id="validate-contract",
                    name="Validate the data contract",
                    stepType="checker",
                    command="python3 -m pytest -q tests/test_data_contract.py",
                    position=CanvasPosition(x=1010, y=120),
                ),
                WorkPhase(
                    id="analyze-results",
                    name="Analyze the results",
                    goal="Join the validated data and metric definitions, calculate the requested comparisons, test sensitivity, and keep a reproducible analysis artifact.",
                    position=CanvasPosition(x=1320, y=360),
                ),
                CheckpointPhase(
                    id="review-assumptions",
                    name="Review assumptions",
                    question="Are the sources, definitions, exclusions, and interpretation appropriate for the decision?",
                    position=CanvasPosition(x=1630, y=360),
                ),
                WorkPhase(
                    id="build-brief",
                    name="Build the decision brief",
                    goal="Turn the approved analysis into a concise narrative and useful tables or charts. Separate observations from recommendations.",
                    position=CanvasPosition(x=1940, y=360),
                ),
                VerifyPhase(
                    id="verify-claims",
                    name="Trace every claim",
                    criteria="Every important number and claim traces to a source and reproducible calculation; uncertainty and limitations are explicit.",
                    maxRepairs=1,
                    position=CanvasPosition(x=2250, y=360),
                ),
            ],
            "edges": [
                ("inspect-sources", "profile-data"),
                ("profile-data", "clean-data"),
                ("profile-data", "define-metrics"),
                ("clean-data", "validate-contract"),
                ("validate-contract", "analyze-results"),
                ("define-metrics", "analyze-results"),
                ("analyze-results", "review-assumptions"),
                ("review-assumptions", "build-brief"),
                ("build-brief", "verify-claims"),
            ],
        },
        {
            "id": "full-stack-product",
            "name": "Build a full-stack product",
            "audience": "Product engineering",
            "description": "Eight broad responsibilities with parallel backend and authentication work.",
            "phases": [
                WorkPhase(
                    id="shape-product",
                    name="Shape the product",
                    goal="Inspect the repository and turn the request into a coherent architecture with explicit interfaces and acceptance criteria.",
                    position=CanvasPosition(x=80, y=360),
                ),
                WorkPhase(
                    id="build-backend",
                    name="Build the backend",
                    goal="Implement the backend model, API, validation, and error handling against the agreed interfaces.",
                    position=CanvasPosition(x=400, y=120),
                ),
                WorkPhase(
                    id="build-auth",
                    name="Build authentication",
                    goal="Implement authentication, authorization, and safe session behavior against the agreed interfaces.",
                    position=CanvasPosition(x=400, y=600),
                ),
                WorkPhase(
                    id="build-frontend",
                    name="Build the frontend",
                    goal="Implement the user-facing flow against the backend and authentication contracts, then inspect the running result.",
                    position=CanvasPosition(x=760, y=360),
                ),
                CheckpointPhase(
                    id="product-review",
                    name="Review the product",
                    question="Does the working flow match the intended experience, or should the final pass be redirected?",
                    position=CanvasPosition(x=1080, y=360),
                ),
                CommandPhase(
                    id="run-suite",
                    name="Run the product tests",
                    stepType="test",
                    command="python3 -m pytest -q",
                    position=CanvasPosition(x=1400, y=120),
                ),
                WorkPhase(
                    id="security-review",
                    name="Review security boundaries",
                    scope="focused",
                    goal="Review only trust boundaries, secrets, authentication, authorization, input handling, and unsafe defaults; repair supported high-severity issues.",
                    position=CanvasPosition(x=1400, y=600),
                ),
                VerifyPhase(
                    id="prove-product",
                    name="Prove the whole flow",
                    criteria="The backend, authentication, and frontend work together; exact tests pass; critical security findings are resolved; the result matches the approved direction.",
                    maxRepairs=1,
                    position=CanvasPosition(x=1760, y=360),
                ),
            ],
            "edges": [
                ("shape-product", "build-backend"),
                ("shape-product", "build-auth"),
                ("build-backend", "build-frontend"),
                ("build-auth", "build-frontend"),
                ("build-frontend", "product-review"),
                ("product-review", "run-suite"),
                ("product-review", "security-review"),
                ("run-suite", "prove-product"),
                ("security-review", "prove-product"),
            ],
        },
        {
            "id": "research-brief",
            "name": "Research a defensible brief",
            "audience": "Research + strategy",
            "description": "Eight steps from source collection to an adversarial claim audit.",
            "phases": [
                WorkPhase(
                    id="frame-question",
                    name="Frame the question",
                    scope="focused",
                    goal="Define the decision, audience, scope, evidence standard, and what would change the answer.",
                    position=CanvasPosition(x=80, y=360),
                ),
                WorkPhase(
                    id="gather-sources",
                    name="Gather primary sources",
                    goal="Find and record relevant primary sources, dates, provenance, and important gaps. Do not draft the conclusion yet.",
                    position=CanvasPosition(x=390, y=360),
                ),
                WorkPhase(
                    id="extract-evidence",
                    name="Extract the evidence",
                    scope="focused",
                    goal="Create a structured evidence table containing claims, supporting passages, dates, and source links.",
                    position=CanvasPosition(x=700, y=120),
                ),
                WorkPhase(
                    id="challenge-evidence",
                    name="Challenge the evidence",
                    scope="focused",
                    goal="Search for contradictions, selection bias, stale sources, unsupported causality, and plausible alternative explanations.",
                    position=CanvasPosition(x=700, y=600),
                ),
                CheckpointPhase(
                    id="choose-angle",
                    name="Choose the argument",
                    question="Which supported angle should the brief take, and which uncertainty must remain visible?",
                    position=CanvasPosition(x=1060, y=360),
                ),
                WorkPhase(
                    id="draft-brief",
                    name="Draft the brief",
                    goal="Write the brief around the approved argument, separating evidence, inference, uncertainty, and recommendation.",
                    position=CanvasPosition(x=1380, y=360),
                ),
                CommandPhase(
                    id="check-links",
                    name="Check cited links",
                    stepType="checker",
                    command="python3 scripts/check_links.py",
                    position=CanvasPosition(x=1700, y=120),
                ),
                VerifyPhase(
                    id="audit-claims",
                    name="Audit every claim",
                    criteria="Every substantive claim has a relevant source, citations resolve, counterevidence is addressed, and inference is clearly labeled.",
                    maxRepairs=1,
                    position=CanvasPosition(x=1700, y=600),
                ),
            ],
            "edges": [
                ("frame-question", "gather-sources"),
                ("gather-sources", "extract-evidence"),
                ("gather-sources", "challenge-evidence"),
                ("extract-evidence", "choose-angle"),
                ("challenge-evidence", "choose-angle"),
                ("choose-angle", "draft-brief"),
                ("draft-brief", "check-links"),
                ("draft-brief", "audit-claims"),
                ("check-links", "audit-claims"),
            ],
        },
        {
            "id": "creative-poster",
            "name": "Create an artistic poster",
            "audience": "Creative work",
            "description": "Seven steps with user-selected direction and parallel typography/composition critiques.",
            "phases": [
                WorkPhase(
                    id="art-direction",
                    name="Define the visual world",
                    goal="Interpret the brief and define a distinctive direction with palette, type, composition, references, and mood.",
                    position=CanvasPosition(x=80, y=360),
                ),
                WorkPhase(
                    id="three-concepts",
                    name="Create three concepts",
                    goal="Produce three materially different, inspectable concepts and explain the tradeoff of each without choosing for the user.",
                    position=CanvasPosition(x=390, y=360),
                ),
                CheckpointPhase(
                    id="choose-concept",
                    name="Choose a concept",
                    question="Which concept should continue, and what should change about its tone, palette, or composition?",
                    position=CanvasPosition(x=700, y=360),
                ),
                WorkPhase(
                    id="produce-poster",
                    name="Produce the poster",
                    goal="Develop the chosen concept into a polished, viewable poster artifact in the requested format.",
                    position=CanvasPosition(x=1010, y=360),
                ),
                WorkPhase(
                    id="type-critique",
                    name="Critique typography",
                    scope="focused",
                    goal="Review only hierarchy, type, legibility, spacing, and copy treatment. Return concrete corrections.",
                    position=CanvasPosition(x=1320, y=120),
                ),
                WorkPhase(
                    id="composition-critique",
                    name="Critique composition",
                    scope="focused",
                    goal="Review only balance, focal point, contrast, negative space, and visual rhythm. Return concrete corrections.",
                    position=CanvasPosition(x=1320, y=600),
                ),
                VerifyPhase(
                    id="final-artwork",
                    name="Review final artwork",
                    criteria="The final artifact preserves the chosen direction, resolves supported critique, is legible, and is delivered in the requested format.",
                    maxRepairs=1,
                    position=CanvasPosition(x=1660, y=360),
                ),
            ],
            "edges": [
                ("art-direction", "three-concepts"),
                ("three-concepts", "choose-concept"),
                ("choose-concept", "produce-poster"),
                ("produce-poster", "type-critique"),
                ("produce-poster", "composition-critique"),
                ("type-critique", "final-artwork"),
                ("composition-critique", "final-artwork"),
            ],
        },
    ]
    values = []
    for template in templates:
        edges = [
            PhaseEdge(**{"from": source, "to": target})
            for source, target in template.get("edges", [])
        ]
        program = PhaseProgram(phases=template["phases"], edges=edges)
        values.append(
            {
                "id": template["id"],
                "name": template["name"],
                "audience": template["audience"],
                "description": template["description"],
                "nodeCount": len(program.phases),
                "program": program.model_dump(by_alias=True, mode="json"),
            }
        )
    return values


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
