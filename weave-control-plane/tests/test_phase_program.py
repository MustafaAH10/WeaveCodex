from __future__ import annotations

import threading
import time
from typing import Any

import pytest
from pydantic import ValidationError

from weave_codex.manifest import HarnessManifest
from weave_codex.phase_program import (
    PhaseProgram,
    compile_phase_program,
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
        "One Codex turn · internal tool loop is Codex-managed"
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
    assert [item["id"] for item in values] == ["inspect", "plan-build-check", "review-repair"]
    assert all(PhaseProgram.model_validate(item["program"]) for item in values)
    assert "controller turns" in values[1]["description"]


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
    assert session.result["observed"]["modelCompletions"] == 3
    assert session.result["observed"]["completedItemsByType"] == {"commandExecution": 3}
    assert session.result["traceProjection"]["projectionBasis"] == (
        "derivedFromCapturedAppServerEvents"
    )
    assert session.result["traceProjection"]["counts"]["toolCalls"] == 3
    assert "many native Codex reasoning and tool" in fake.prompts[0]
    assert "Use direction B and reduce visual noise." in fake.prompts[1]
    assert "latest instruction for this phase" in fake.prompts[1]
