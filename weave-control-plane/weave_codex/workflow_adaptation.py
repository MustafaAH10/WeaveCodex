"""Bounded, review-before-save adaptation of reusable phase programs."""

from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path
from typing import Any, Protocol

from pydantic import BaseModel, ConfigDict, Field

from .phase_program import PhaseProgram
from .runtime import Gateway, SdkGateway


class _StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class WorkflowAdaptRequest(_StrictModel):
    """A task hint plus the source program; neither is saved by this operation."""

    phase_program: PhaseProgram = Field(alias="phaseProgram")
    task: str = Field(min_length=8, max_length=8_000)
    cwd: str = Field(min_length=1, max_length=4_000)
    reasoning_effort: str = Field(default="low", alias="reasoningEffort")


class WorkflowAdaptResult(_StrictModel):
    phase_program: PhaseProgram = Field(alias="phaseProgram")
    changed_phase_ids: list[str] = Field(alias="changedPhaseIds")
    review_required: bool = Field(default=True, alias="reviewRequired")
    method: str = "codex-goal-rewrite"
    privacy: str = "proposal-only; task and repository are not saved"


class GatewayFactory(Protocol):
    def __call__(
        self,
        codex_bin: str,
        trace_root: str,
        approval_handler: Callable[..., Any],
    ) -> Gateway: ...


def _adaptation_schema() -> dict[str, Any]:
    return {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "phaseProgram": PhaseProgram.model_json_schema(by_alias=True),
        },
        "required": ["phaseProgram"],
    }


def validate_goal_only_adaptation(
    source: PhaseProgram,
    candidate: PhaseProgram,
) -> list[str]:
    """Require stable structure while permitting human-readable goal changes."""

    if len(source.phases) != len(candidate.phases):
        raise ValueError("adaptation must preserve the number of phases")
    changed: list[str] = []
    for before, after in zip(source.phases, candidate.phases, strict=True):
        if before.id != after.id or before.kind != after.kind:
            raise ValueError("adaptation must preserve phase ids, kinds, and order")
        before_value = before.model_dump(by_alias=True, mode="json")
        after_value = after.model_dump(by_alias=True, mode="json")
        structural_keys = {
            "id",
            "kind",
            "scope",
            "reasoningEffort",
            "maxRepairs",
            "stepType",
            "command",
            "expectedExitCode",
            "stopOnFailure",
        }
        for key in structural_keys:
            if before_value.get(key) != after_value.get(key):
                raise ValueError(f"adaptation cannot change structural field {key}")
        if before_value != after_value:
            changed.append(before.id)
    if not changed:
        raise ValueError("adaptation did not change any phase wording")
    return changed


class WorkflowAdaptationService:
    """Ask Codex for one structured, read-only rewrite and return it for review."""

    def __init__(
        self,
        codex_bin: str,
        *,
        gateway_factory: GatewayFactory = SdkGateway,
    ) -> None:
        self.codex_bin = codex_bin
        self.gateway_factory = gateway_factory

    def adapt(self, request: WorkflowAdaptRequest) -> WorkflowAdaptResult:
        workspace = Path(request.cwd).resolve(strict=True)
        if not workspace.is_dir():
            raise ValueError("cwd must be an existing directory")
        gateway = self.gateway_factory(
            self.codex_bin,
            str(workspace / ".weave-codex" / "traces"),
            lambda *_: {"decision": "decline"},
        )
        try:
            gateway.start()
            thread_id = gateway.start_thread(
                {
                    "cwd": str(workspace),
                    "approvalPolicy": "never",
                    "approvalsReviewer": "user",
                    "sandbox": "read-only",
                    "serviceName": "weave_codex_workflow_adapter",
                    "experimentalRawEvents": False,
                    "config": {"memories": {"use_memories": False, "generate_memories": False}},
                }
            )
            gateway.set_memory_mode(thread_id, "disabled")
            source_json = json.dumps(
                request.phase_program.model_dump(by_alias=True, mode="json"),
                ensure_ascii=False,
                indent=2,
            )
            prompt = f"""You adapt human-authored phase goals for a new task.

New task:
{request.task}

Source phase program:
{source_json}

Return phaseProgram only. Preserve projectionVersion, phase count, every phase id,
kind, order, scope, reasoningEffort, maxRepairs, stepType, command, expectedExitCode,
and stopOnFailure exactly. Rewrite only human-readable name/goal/question/criteria
fields so the same workflow structure is useful for
the new task. Do not solve the task, inspect files, or propose shell commands.
The user will review the wording before saving or running it.
"""
            outcome = gateway.run_turn(
                thread_id,
                prompt,
                effort=request.reasoning_effort,
                output_schema=_adaptation_schema(),
                event_sink=lambda _event: None,
            )
            if outcome.status != "completed":
                raise ValueError(f"Codex adaptation ended with status {outcome.status}")
            payload = json.loads(outcome.final_response)
            candidate = PhaseProgram.model_validate(payload["phaseProgram"])
            changed = validate_goal_only_adaptation(request.phase_program, candidate)
            return WorkflowAdaptResult(
                phaseProgram=candidate,
                changedPhaseIds=changed,
            )
        finally:
            gateway.close()
