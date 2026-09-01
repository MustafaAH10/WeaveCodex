from __future__ import annotations

import json
import threading
import time
from typing import Any

import pytest
from pydantic import ValidationError

from weave_codex.manifest import HarnessManifest
from weave_codex.phase_program import (
    PhaseProgram,
    compile_phase_program,
    ordered_phases,
    phase_templates,
    phase_turn_bound,
    safe_phase_id,
)
from weave_codex.runtime import HarnessRunner, RunSession, TurnOutcome


def program() -> PhaseProgram:
    return PhaseProgram.model_validate(
        {
            "projectionVersion": 1,
            "phases": [
                {
                    "id": "inspect",
                    "kind": "work",
                    "name": "Inspect the workspace",
                    "goal": "Read relevant files and form an evidence-backed plan.",
                },
                {
                    "id": "approve-plan",
                    "kind": "checkpoint",
                    "name": "Approve the plan",
                    "question": "Continue from inspection into implementation?",
                },
                {
                    "id": "implement",
                    "kind": "work",
                    "name": "Implement and test",
                    "goal": "Make the requested change and run focused checks.",
                },
                {
                    "id": "verify",
                    "kind": "verify",
                    "name": "Verify the result",
                    "criteria": "The requested behavior works and checks pass.",
                    "maxRepairs": 2,
                },
            ],
        }
    )


def test_phase_graph_counts_controller_turns_not_internal_tool_calls() -> None:
    value = program()
    compiled = compile_phase_program(value)

    assert phase_turn_bound(value) == 5
    assert compiled["maximumControllerTurns"] == 5
    assert compiled["executionOrder"] == ["inspect", "approve-plan", "implement", "verify"]
    assert compiled["nodes"][1]["detail"] == (
        "One broad adaptive Codex turn · internal tool loop is Codex-managed"
    )
    assert "model completions" in compiled["internalLoopSemantics"]


def test_program_rejects_ambiguous_or_non_executable_shapes() -> None:
    with pytest.raises(ValidationError, match="unique"):
        PhaseProgram.model_validate(
            {
                "phases": [
                    {"id": "same", "kind": "work", "name": "One", "goal": "Inspect it."},
                    {"id": "same", "kind": "work", "name": "Two", "goal": "Change it."},
                ]
            }
        )
    with pytest.raises(ValidationError, match="first executable phase"):
        PhaseProgram.model_validate(
            {
                "phases": [
                    {
                        "id": "approve",
                        "kind": "checkpoint",
                        "name": "Approve",
                        "question": "Continue with this plan?",
                    },
                    {"id": "work", "kind": "work", "name": "Work", "goal": "Do the work."},
                ]
            }
        )


def test_safe_phase_id_is_readable_and_unique() -> None:
    assert safe_phase_id("Inspect & understand") == "inspect-understand"
    assert safe_phase_id("42 checks", {"phase-42-checks"}) == "phase-42-checks-2"


def test_templates_are_valid_and_explain_the_codex_loop_boundary() -> None:
    values = phase_templates()
    assert [item["id"] for item in values] == [
        "fine-grained-fix",
        "frontend-launch",
        "data-analysis",
        "full-stack-product",
        "research-brief",
        "creative-poster",
    ]
    assert all(PhaseProgram.model_validate(item["program"]) for item in values)
    assert "exact pass/fail commands" in values[0]["description"]
    assert [item["nodeCount"] for item in values] == [5, 10, 9, 8, 8, 7]
    assert {item["audience"] for item in values} == {
        "Engineering",
        "Design + frontend",
        "Data analysis",
        "Product engineering",
        "Research + strategy",
        "Creative work",
    }
    example_programs = [PhaseProgram.model_validate(item["program"]) for item in values]
    assert all(program.edges for program in example_programs)
    assert all(
        all(phase.position is not None for phase in program.phases) for program in example_programs
    )


def test_exact_command_phase_is_a_real_bounded_controller_turn() -> None:
    value = PhaseProgram.model_validate(
        {
            "phases": [
                {"id": "inspect", "kind": "work", "name": "Inspect", "goal": "Inspect it."},
                {
                    "id": "focused-test",
                    "kind": "command",
                    "stepType": "test",
                    "name": "Focused test",
                    "command": "python -m pytest -q tests/test_one.py::test_case",
                    "expectedExitCode": 0,
                    "stopOnFailure": True,
                },
            ]
        }
    )
    compiled = compile_phase_program(value)

    assert phase_turn_bound(value) == 2
    assert compiled["maximumControllerTurns"] == 2
    assert compiled["nodes"][2]["kind"] == "command"
    assert "exact test command" in compiled["nodes"][2]["detail"]


def test_each_work_node_chooses_its_own_granularity() -> None:
    value = PhaseProgram.model_validate(
        {
            "phases": [
                {
                    "id": "broad",
                    "kind": "work",
                    "scope": "adaptive",
                    "name": "Build the feature",
                    "goal": "Build the complete feature and prove it works.",
                },
                {
                    "id": "narrow",
                    "kind": "work",
                    "scope": "focused",
                    "name": "Change one parser",
                    "goal": "Change only parse_value and its focused test.",
                },
            ]
        }
    )
    compiled = compile_phase_program(value)

    assert "broad adaptive" in compiled["nodes"][1]["detail"]
    assert "deliberately focused" in compiled["nodes"][2]["detail"]


def test_canvas_arrows_define_stable_dependency_order_and_preserve_positions() -> None:
    value = PhaseProgram.model_validate(
        {
            "phases": [
                {
                    "id": "frame",
                    "kind": "work",
                    "name": "Frame product",
                    "goal": "Define shared interfaces.",
                    "position": {"x": 40, "y": 220},
                },
                {
                    "id": "backend",
                    "kind": "work",
                    "name": "Backend",
                    "goal": "Build backend services.",
                    "position": {"x": 360, "y": 80},
                },
                {
                    "id": "auth",
                    "kind": "work",
                    "name": "Auth",
                    "goal": "Build authentication.",
                    "position": {"x": 360, "y": 380},
                },
                {
                    "id": "frontend",
                    "kind": "work",
                    "name": "Frontend",
                    "goal": "Build against both contracts.",
                    "position": {"x": 700, "y": 220},
                },
            ],
            "edges": [
                {"from": "frame", "to": "backend"},
                {"from": "frame", "to": "auth"},
                {"from": "backend", "to": "frontend"},
                {"from": "auth", "to": "frontend"},
            ],
        }
    )

    assert [phase.id for phase in ordered_phases(value)] == [
        "frame",
        "backend",
        "auth",
        "frontend",
    ]
    compiled = compile_phase_program(value)
    assert compiled["executionOrder"] == ["frame", "backend", "auth", "frontend"]
    assert {(edge["from"], edge["to"]) for edge in compiled["edges"]} >= {
        ("frame", "backend"),
        ("frame", "auth"),
        ("backend", "frontend"),
        ("auth", "frontend"),
    }
    assert compiled["nodes"][2]["position"] == {"x": 360, "y": 80}


def test_canvas_graph_fails_closed_on_cycles_or_multiple_starting_nodes() -> None:
    base = [
        {"id": "one", "kind": "work", "name": "One", "goal": "Do one thing."},
        {"id": "two", "kind": "work", "name": "Two", "goal": "Do another thing."},
        {"id": "three", "kind": "work", "name": "Three", "goal": "Do a third thing."},
    ]
    with pytest.raises(ValidationError, match="exactly one starting node"):
        PhaseProgram.model_validate({"phases": base, "edges": [{"from": "one", "to": "two"}]})
    with pytest.raises(ValidationError, match="exactly one starting node|acyclic"):
        PhaseProgram.model_validate(
            {
                "phases": base,
                "edges": [
                    {"from": "one", "to": "two"},
                    {"from": "two", "to": "one"},
                    {"from": "one", "to": "three"},
                ],
            }
        )


class PhaseGatewayFake:
    def __init__(self) -> None:
        self.outputs = [
            "inspection and plan",
            "implemented result",
            '{"status":"pass","answer":"verified result","issues":[]}',
        ]
        self.prompts: list[str] = []

    def start(self) -> None:
        pass

    def close(self) -> None:
        pass

    def read_thread(self, thread_id: str) -> dict[str, Any]:
        return {"thread": {"turns": []}}

    def list_threads(self, cwd: str) -> list[dict[str, Any]]:
        return []

    def start_thread(self, params: dict[str, Any]) -> str:
        return "phase-thread"

    def set_memory_mode(self, thread_id: str, mode: str) -> None:
        pass

    def run_turn(self, thread_id: str, prompt: str, **kwargs: Any) -> TurnOutcome:
        self.prompts.append(prompt)
        turn_id = f"turn-{len(self.prompts)}"
        sink = kwargs["event_sink"]
        sink(
            {
                "method": "item/completed",
                "params": {
                    "item": {
                        "type": "commandExecution",
                        "id": f"command-{len(self.prompts)}",
                        "status": "completed",
                    }
                },
            }
        )
        sink({"method": "rawResponse/completed", "params": {"responseId": turn_id}})
        return TurnOutcome(turn_id, self.outputs.pop(0))


def executable_manifest() -> HarnessManifest:
    return HarnessManifest.model_validate(
        {
            "schemaVersion": 2,
            "name": "Phase harness",
            "cwd": "/tmp/project",
            "task": {"instructions": "Redesign the frontend and verify it."},
            "memory": {"mode": "off", "selectedThreadIds": []},
            "agent": {
                "reasoningEffort": "low",
                "sandbox": "workspace-write",
                "approvalGate": "manual",
            },
            "phaseProgram": program().model_dump(by_alias=True, mode="json"),
        }
    )


def test_phase_program_executes_controller_turns_and_real_human_checkpoint() -> None:
    fake = PhaseGatewayFake()
    session = RunSession(run_id="phase-run")
    worker = threading.Thread(
        target=lambda: HarnessRunner("codex", lambda *_: fake).run(executable_manifest(), session)
    )
    worker.start()
    deadline = time.monotonic() + 2
    while session.pending_approval is None and time.monotonic() < deadline:
        time.sleep(0.01)
    assert session.pending_approval == {
        "method": "harness/checkpoint",
        "params": {
            "phaseId": "approve-plan",
            "question": "Continue from inspection into implementation?",
        },
    }
    session.decide("accept", "Use direction B and reduce visual noise.")
    worker.join(timeout=2)

    assert session.status == "completed"
    assert session.result is not None
    assert session.result["turnIds"] == ["turn-1", "turn-2", "turn-3"]
    assert session.result["finalResponse"] == "verified result"
    assert session.result["completionStatus"] == "completed"
    assert session.result["phaseProgram"]["checkpoints"] == [
        {
            "phaseId": "approve-plan",
            "decision": "accept",
            "feedback": "Use direction B and reduce visual noise.",
        }
    ]
    assert [entry["name"] for entry in session.result["phaseProgram"]["executions"]] == [
        "Inspect the workspace",
        "Approve the plan",
        "Implement and test",
        "Verify the result",
    ]
    assert session.result["observed"]["modelCompletions"] == 3
    assert session.result["observed"]["completedItemsByType"] == {"commandExecution": 3}
    assert session.result["traceProjection"]["projectionBasis"] == (
        "derivedFromCapturedAppServerEvents"
    )
    assert session.result["traceProjection"]["counts"]["toolCalls"] == 3
    assert "many native Codex reasoning and tool" in fake.prompts[0]
    assert "<granularity>adaptive</granularity>" in fake.prompts[0]
    assert "do not take over responsibilities assigned to later workflow nodes" in fake.prompts[0]
    assert "Stop this turn as soon as the phase outcome is complete" in fake.prompts[0]
    assert "Use direction B and reduce visual noise." in fake.prompts[1]
    assert "latest instruction for this phase" in fake.prompts[1]


class CommandPhaseGatewayFake(PhaseGatewayFake):
    def __init__(self, *, exit_code: int = 0, observed_command: str = "uv run pytest -q") -> None:
        super().__init__()
        self.exit_code = exit_code
        self.observed_command = observed_command
        self.outputs = [
            "inspection complete",
            json.dumps(
                {
                    "executedCommand": "uv run pytest -q",
                    "exitCode": exit_code,
                    "summary": "Focused suite completed.",
                }
            ),
            "implemented only when a failed check does not stop the program",
        ]

    def run_turn(self, thread_id: str, prompt: str, **kwargs: Any) -> TurnOutcome:
        self.prompts.append(prompt)
        turn_id = f"turn-{len(self.prompts)}"
        sink = kwargs["event_sink"]
        if "Run exactly this command once" in prompt:
            sink(
                {
                    "method": "item/completed",
                    "params": {
                        "item": {
                            "type": "commandExecution",
                            "id": "exact-command",
                            "command": f'/bin/bash -lc "{self.observed_command}"',
                            "commandActions": [
                                {"type": "unknown", "command": self.observed_command}
                            ],
                            "exitCode": self.exit_code,
                            "status": "completed" if self.exit_code == 0 else "failed",
                        }
                    },
                }
            )
        sink({"method": "rawResponse/completed", "params": {"responseId": turn_id}})
        return TurnOutcome(turn_id, self.outputs.pop(0))


class InterruptedPhaseGatewayFake(PhaseGatewayFake):
    def run_turn(self, thread_id: str, prompt: str, **kwargs: Any) -> TurnOutcome:
        self.prompts.append(prompt)
        return TurnOutcome("turn-interrupted", "", status="interrupted")


def command_manifest() -> HarnessManifest:
    return HarnessManifest.model_validate(
        {
            "schemaVersion": 2,
            "name": "Fine-grained harness",
            "cwd": "/tmp/project",
            "task": {"instructions": "Inspect the project and validate the focused behavior."},
            "memory": {"mode": "off", "selectedThreadIds": []},
            "agent": {
                "reasoningEffort": "low",
                "sandbox": "read-only",
                "approvalGate": "deny",
            },
            "phaseProgram": {
                "projectionVersion": 1,
                "phases": [
                    {
                        "id": "inspect",
                        "kind": "work",
                        "name": "Inspect",
                        "goal": "Inspect the focused implementation.",
                    },
                    {
                        "id": "focused-test",
                        "kind": "command",
                        "stepType": "test",
                        "name": "Focused test",
                        "command": "uv run pytest -q",
                        "expectedExitCode": 0,
                        "stopOnFailure": True,
                    },
                    {
                        "id": "extra-work",
                        "kind": "work",
                        "name": "Continue",
                        "goal": "Continue only when the test passes.",
                    },
                ],
            },
        }
    )


def test_interrupted_work_phase_stops_without_claiming_completion() -> None:
    fake = InterruptedPhaseGatewayFake()
    session = RunSession(run_id="interrupted-phase")

    HarnessRunner("codex", lambda *_: fake).run(executable_manifest(), session)

    assert session.status == "stopped"
    assert session.result is not None
    assert session.result["completionStatus"] == "stopped"
    assert session.result["phaseProgram"]["executions"] == [
        {
            "phaseId": "inspect",
            "name": "Inspect the workspace",
            "kind": "work",
            "turnIds": ["turn-interrupted"],
            "scope": "adaptive",
            "status": "stopped",
        }
    ]


def test_exact_command_pass_requires_matching_observed_app_server_item() -> None:
    fake = CommandPhaseGatewayFake()
    session = RunSession(run_id="command-pass")

    HarnessRunner("codex", lambda *_: fake).run(command_manifest(), session)

    assert session.status == "completed"
    assert session.result is not None
    command = session.result["phaseProgram"]["executions"][1]
    assert command["status"] == "pass"
    assert command["observedExitCode"] == 0
    assert command["matchingCommandItems"] == 1
    assert "beyond the effects of the declared command" in fake.prompts[1]
    assert session.result["completionStatus"] == "completed"
    assert session.result["turnIds"] == ["turn-1", "turn-2", "turn-3"]


def test_exact_command_fails_closed_and_stops_when_observation_does_not_match() -> None:
    fake = CommandPhaseGatewayFake(observed_command="uv run pytest -q tests/other.py")
    session = RunSession(run_id="command-fail")

    HarnessRunner("codex", lambda *_: fake).run(command_manifest(), session)

    assert session.status == "completed"
    assert session.result is not None
    command = session.result["phaseProgram"]["executions"][1]
    assert command["status"] == "fail"
    assert command["matchingCommandItems"] == 0
    assert session.result["completionStatus"] == "failedCheck"
    assert session.result["turnIds"] == ["turn-1", "turn-2"]
