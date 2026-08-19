from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from weave_codex.phase_program import PhaseProgram
from weave_codex.runtime import TurnOutcome
from weave_codex.workflow_adaptation import (
    WorkflowAdaptationService,
    WorkflowAdaptRequest,
    validate_goal_only_adaptation,
)


def program(goal: str = "Inspect the repository and make the requested change.") -> PhaseProgram:
    return PhaseProgram.model_validate(
        {
            "projectionVersion": 1,
            "phases": [
                {"id": "inspect", "kind": "work", "name": "Inspect", "goal": goal},
                {
                    "id": "approve",
                    "kind": "checkpoint",
                    "name": "Approve",
                    "question": "Continue with this direction?",
                },
                {
                    "id": "verify",
                    "kind": "verify",
                    "name": "Verify",
                    "criteria": "The requested behavior works and checks pass.",
                    "maxRepairs": 1,
                },
            ],
        }
    )


class FakeGateway:
    def __init__(self, response: dict[str, Any]) -> None:
        self.response = response
        self.params: dict[str, Any] = {}
        self.output_schema: dict[str, Any] | None = None
        self.closed = False

    def start(self) -> None: pass
    def close(self) -> None: self.closed = True
    def read_thread(self, thread_id: str) -> dict[str, Any]: return {}
    def list_threads(self, cwd: str) -> list[dict[str, Any]]: return []
    def set_memory_mode(self, thread_id: str, mode: str) -> None:
        assert mode == "disabled"
    def start_thread(self, params: dict[str, Any]) -> str:
        self.params = params
        return "thread-adapt"
    def run_turn(self, thread_id: str, prompt: str, **kwargs: Any) -> TurnOutcome:
        assert "Do not solve the task" in prompt
        self.output_schema = kwargs["output_schema"]
        return TurnOutcome("turn-adapt", json.dumps(self.response))


def test_goal_only_adaptation_preserves_structure() -> None:
    source = program()
    candidate = program("Inspect the CLI parameter resolution path and update its contract.")
    assert validate_goal_only_adaptation(source, candidate) == ["inspect"]
    changed = candidate.model_copy(deep=True)
    changed.phases[0].id = "different"
    with pytest.raises(ValueError, match="ids, kinds, and order"):
        validate_goal_only_adaptation(source, changed)


def test_service_runs_one_read_only_structured_turn_and_returns_reviewable_proposal(
    tmp_path: Path,
) -> None:
    source = program()
    candidate = program("Inspect the proxy environment path and preserve bypass invariants.")
    fake = FakeGateway({"phaseProgram": candidate.model_dump(by_alias=True, mode="json")})
    service = WorkflowAdaptationService("codex", gateway_factory=lambda *_: fake)

    result = service.adapt(
        WorkflowAdaptRequest(
            phaseProgram=source,
            task="Repair proxy bypass semantics in this HTTP client.",
            cwd=str(tmp_path),
        )
    )

    assert result.review_required is True
    assert result.changed_phase_ids == ["inspect"]
    assert fake.params["sandbox"] == "read-only"
    assert fake.params["approvalPolicy"] == "never"
    assert fake.params["config"]["memories"]["use_memories"] is False
    assert fake.output_schema is not None
    assert fake.closed
