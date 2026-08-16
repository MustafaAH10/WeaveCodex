"""Typed harness manifest and deterministic compiler.

The compiler does not execute a model. It turns the human-owned document into
an inspectable graph plus the exact app-server operations the runtime will use.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class TaskBlock(StrictModel):
    instructions: str = Field(min_length=4, max_length=20_000)
    context_paths: list[str] = Field(default_factory=list, alias="contextPaths", max_length=12)


class MemoryBlock(StrictModel):
    mode: Literal["off", "all", "selected"] = "off"
    selected_thread_ids: list[str] = Field(
        default_factory=list, alias="selectedThreadIds", max_length=8
    )

    @model_validator(mode="after")
    def check_scope(self) -> MemoryBlock:
        unique = list(dict.fromkeys(self.selected_thread_ids))
        if unique != self.selected_thread_ids:
            raise ValueError("selectedThreadIds must not contain duplicates")
        if self.mode == "selected" and not unique:
            raise ValueError("selected memory requires at least one thread id")
        if self.mode != "selected" and unique:
            raise ValueError("selectedThreadIds is only valid for selected memory")
        return self


class AgentBlock(StrictModel):
    model: str | None = Field(default=None, max_length=100)
    reasoning_effort: Literal["low", "medium", "high", "xhigh"] = Field(
        default="medium", alias="reasoningEffort"
    )
    sandbox: Literal["read-only", "workspace-write"] = "read-only"
    approval_gate: Literal["manual", "auto-review", "deny"] = Field(
        default="manual", alias="approvalGate"
    )


class VerificationBlock(StrictModel):
    enabled: bool = True
    criteria: str = Field(
        default=(
            "The answer is correct, complete, grounded in inspected evidence, and follows the task."
        ),
        min_length=4,
        max_length=2_000,
    )
    max_retries: int = Field(default=1, alias="maxRetries", ge=0, le=2)


class OutputBlock(StrictModel):
    format: Literal["text", "json"] = "text"


class ObservabilityBlock(StrictModel):
    trace_root: str = Field(default=".weave-codex/traces", alias="traceRoot", max_length=500)


class HarnessManifest(StrictModel):
    schema_version: Literal[1] = Field(default=1, alias="schemaVersion")
    name: str = Field(default="Untitled harness", min_length=2, max_length=100)
    cwd: str = Field(min_length=1, max_length=1_000)
    task: TaskBlock
    memory: MemoryBlock = Field(default_factory=MemoryBlock)
    agent: AgentBlock = Field(default_factory=AgentBlock)
    verification: VerificationBlock = Field(default_factory=VerificationBlock)
    output: OutputBlock = Field(default_factory=OutputBlock)
    observability: ObservabilityBlock = Field(default_factory=ObservabilityBlock)

    @model_validator(mode="after")
    def check_paths(self) -> HarnessManifest:
        if not Path(self.cwd).is_absolute():
            raise ValueError("cwd must be an absolute path")
        return self


def _canonical(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def manifest_hash(manifest: HarnessManifest) -> str:
    payload = manifest.model_dump(by_alias=True, mode="json")
    return "sha256:" + hashlib.sha256(_canonical(payload).encode()).hexdigest()


def compile_manifest(manifest: HarnessManifest) -> dict[str, Any]:
    """Return the executable graph and app-server action preview."""

    nodes = [
        {"id": "task", "kind": "task", "label": "Task", "detail": "Human instructions"},
        {
            "id": "memory",
            "kind": "memory",
            "label": "Memory",
            "detail": manifest.memory.mode.title(),
            "state": "bypassed" if manifest.memory.mode == "off" else "active",
        },
        {
            "id": "approval",
            "kind": "safety",
            "label": "Approval + sandbox",
            "detail": f"{manifest.agent.approval_gate} · {manifest.agent.sandbox}",
        },
        {
            "id": "agent",
            "kind": "agent",
            "label": "Codex agent loop",
            "detail": manifest.agent.model or "Account default model",
        },
    ]
    if manifest.verification.enabled:
        nodes.extend(
            [
                {"id": "verify", "kind": "verify", "label": "Verifier", "detail": "Structured"},
                {
                    "id": "retry",
                    "kind": "control",
                    "label": "Repair bound",
                    "detail": (
                        f"≤ {manifest.verification.max_retries} "
                        f"{'retry' if manifest.verification.max_retries == 1 else 'retries'}"
                    ),
                },
            ]
        )
    nodes.append(
        {"id": "output", "kind": "output", "label": "Output", "detail": manifest.output.format}
    )
    order = [node["id"] for node in nodes]
    edges = [{"from": left, "to": right} for left, right in zip(order, order[1:], strict=False)]

    memory_action = {
        "off": "disable Codex memory read/generation; inject no prior traces",
        "all": "enable Codex native memory read/generation and mark the thread eligible",
        "selected": "disable native memory; read and inject only selected thread IDs",
    }[manifest.memory.mode]
    approval_policy = "never" if manifest.agent.approval_gate == "deny" else "on-request"
    actions = [
        "initialize experimental app-server client",
        memory_action,
        f"thread/start ({manifest.agent.sandbox}, approvals={approval_policy})",
        "turn/start solver",
    ]
    if manifest.verification.enabled:
        retry_label = "repair check" if manifest.verification.max_retries == 1 else "repair checks"
        actions.append(
            "turn/start structured verifier, then at most "
            f"{manifest.verification.max_retries} {retry_label}"
        )
    actions.extend(["collect item/turn events", "write receipt linked to manifest hash"])
    return {
        "manifestHash": manifest_hash(manifest),
        "nodes": nodes,
        "edges": edges,
        "actions": actions,
        "maximumTurns": 1
        + (1 + manifest.verification.max_retries if manifest.verification.enabled else 0),
    }


def build_solver_prompt(manifest: HarnessManifest, selected_excerpts: list[str]) -> str:
    context = "\n".join(f"- {path}" for path in manifest.task.context_paths) or "- none"
    memory = "\n\n".join(selected_excerpts) or "No selected trace content was supplied."
    return f"""Complete the task using Codex's native tools and report only supported claims.

<task>
{manifest.task.instructions}
</task>
<context_paths>
{context}
</context_paths>
<selected_memory mode=\"{manifest.memory.mode}\">
{memory}
</selected_memory>

Do not claim that a file, command, test, or memory was used unless it was actually inspected."""


VERIFIER_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "status": {"type": "string", "enum": ["pass", "repair"]},
        "answer": {"type": "string"},
        "issues": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["status", "answer", "issues"],
    "additionalProperties": False,
}
