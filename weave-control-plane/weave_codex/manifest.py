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

from .phase_program import PhaseProgram, compile_phase_program, phase_turn_bound


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


class IntegrationRequest(StrictModel):
    kind: Literal["skill", "mcp", "app"]
    id: str = Field(min_length=1, max_length=160, pattern=r"^[^\x00-\x1f]+$")
    label: str = Field(min_length=1, max_length=160)
    phase_ids: list[str] = Field(default_factory=list, alias="phaseIds", max_length=8)

    @model_validator(mode="after")
    def check_phase_ids(self) -> IntegrationRequest:
        if len(self.phase_ids) != len(set(self.phase_ids)):
            raise ValueError("integration phaseIds must not contain duplicates")
        return self


class IntegrationsBlock(StrictModel):
    inventory_id: str | None = Field(
        default=None,
        alias="inventoryId",
        pattern=r"^sha256:[0-9a-f]{64}$",
    )
    requested: list[IntegrationRequest] = Field(default_factory=list, max_length=12)

    @model_validator(mode="after")
    def check_requests(self) -> IntegrationsBlock:
        identities = [(item.kind, item.id) for item in self.requested]
        if len(identities) != len(set(identities)):
            raise ValueError("integration requests must be unique by kind and id")
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
    schema_version: Literal[1, 2] = Field(default=1, alias="schemaVersion")
    name: str = Field(default="Untitled harness", min_length=2, max_length=100)
    cwd: str = Field(min_length=1, max_length=1_000)
    task: TaskBlock
    memory: MemoryBlock = Field(default_factory=MemoryBlock)
    integrations: IntegrationsBlock = Field(default_factory=IntegrationsBlock)
    agent: AgentBlock = Field(default_factory=AgentBlock)
    verification: VerificationBlock = Field(default_factory=VerificationBlock)
    output: OutputBlock = Field(default_factory=OutputBlock)
    observability: ObservabilityBlock = Field(default_factory=ObservabilityBlock)
    phase_program: PhaseProgram | None = Field(default=None, alias="phaseProgram")

    @model_validator(mode="after")
    def check_paths(self) -> HarnessManifest:
        if not Path(self.cwd).is_absolute():
            raise ValueError("cwd must be an absolute path")
        if self.schema_version == 2 and self.phase_program is None:
            raise ValueError("schemaVersion 2 requires phaseProgram")
        if self.schema_version == 1 and self.phase_program is not None:
            raise ValueError("phaseProgram requires schemaVersion 2")
        phase_ids = {
            phase.id
            for phase in (self.phase_program.phases if self.phase_program is not None else [])
            if phase.kind == "work"
        }
        for request in self.integrations.requested:
            if request.phase_ids and self.phase_program is None:
                raise ValueError("scoped integrations require schemaVersion 2 phaseProgram")
            unknown = set(request.phase_ids) - phase_ids
            if unknown:
                raise ValueError(
                    "integration phaseIds must reference work phases: " + ", ".join(sorted(unknown))
                )
        return self


def _canonical(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def manifest_hash(manifest: HarnessManifest) -> str:
    payload = manifest.model_dump(by_alias=True, mode="json")
    return "sha256:" + hashlib.sha256(_canonical(payload).encode()).hexdigest()


def compile_manifest(manifest: HarnessManifest) -> dict[str, Any]:
    """Return the executable graph and app-server action preview."""

    if manifest.phase_program is not None:
        return _compile_phase_manifest(manifest)

    nodes = [
        {"id": "task", "kind": "task", "label": "Task", "detail": "Human instructions"},
        {
            "id": "memory",
            "kind": "memory",
            "label": "Memory",
            "detail": manifest.memory.mode.title(),
            "state": "bypassed" if manifest.memory.mode == "off" else "active",
        },
        _integration_node(manifest),
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
        *_integration_actions(manifest),
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


def _compile_phase_manifest(manifest: HarnessManifest) -> dict[str, Any]:
    program = manifest.phase_program
    if program is None:  # pragma: no cover - guarded by the public caller
        raise ValueError("phase program is required")
    phase_graph = compile_phase_program(program)
    phase_nodes = list(phase_graph["nodes"])
    task_node = phase_nodes.pop(0)
    output_node = phase_nodes.pop()
    memory_node = {
        "id": "memory",
        "kind": "memory",
        "label": "Memory",
        "detail": manifest.memory.mode.title(),
        "state": "bypassed" if manifest.memory.mode == "off" else "active",
        "editable": False,
    }
    integration_node = _integration_node(manifest)
    integration_node["editable"] = False
    safety_node = {
        "id": "safety",
        "kind": "safety",
        "label": "Safety boundary",
        "detail": f"{manifest.agent.approval_gate} · {manifest.agent.sandbox}",
        "editable": False,
    }
    nodes = [task_node, memory_node, integration_node, safety_node, *phase_nodes, output_node]
    edges = [
        {"from": left["id"], "to": right["id"], "condition": "next"}
        for left, right in zip(nodes, nodes[1:], strict=False)
    ]
    memory_action = {
        "off": "disable Codex memory read/generation; inject no prior traces",
        "all": "enable Codex native memory read/generation and mark the thread eligible",
        "selected": "disable native memory; read and inject only selected thread IDs",
    }[manifest.memory.mode]
    actions = [
        "initialize experimental app-server client",
        memory_action,
        *_integration_actions(manifest),
        f"thread/start ({manifest.agent.sandbox}, approvals={manifest.agent.approval_gate})",
    ]
    for phase in program.phases:
        if phase.kind == "work":
            actions.append(
                f"turn/start work phase '{phase.name}' (Codex manages its internal tool loop)"
            )
        elif phase.kind == "checkpoint":
            actions.append(f"pause for human checkpoint '{phase.name}' (no model call)")
        else:
            actions.append(
                f"turn/start verifier '{phase.name}', then at most "
                f"{phase.max_repairs} repair turn(s)"
            )
    actions.extend(["collect exact app-server events", "write receipt linked to manifest hash"])
    return {
        "manifestHash": manifest_hash(manifest),
        "schemaVersion": manifest.schema_version,
        "nodes": nodes,
        "edges": edges,
        "actions": actions,
        "maximumTurns": phase_turn_bound(program),
        "internalLoopSemantics": phase_graph["internalLoopSemantics"],
        "executionOrder": phase_graph["executionOrder"],
    }


def _integration_node(manifest: HarnessManifest) -> dict[str, Any]:
    count = len(manifest.integrations.requested)
    return {
        "id": "integrations",
        "kind": "integration",
        "label": "Codex integrations",
        "detail": (
            f"{count} requested · instructional binding"
            if count
            else "Inherited environment · no explicit requests"
        ),
        "state": "active" if count else "bypassed",
    }


def _integration_actions(manifest: HarnessManifest) -> list[str]:
    if not manifest.integrations.requested:
        return ["inherit Codex integrations; request none explicitly"]
    actions: list[str] = []
    for request in manifest.integrations.requested:
        scope = ", ".join(request.phase_ids) if request.phase_ids else "all work phases"
        actions.append(
            f"request {request.kind} '{request.label}' in {scope} (instructional, not allowlisted)"
        )
    return actions


def integration_prompt(manifest: HarnessManifest, phase_id: str | None = None) -> str:
    requests = [
        item
        for item in manifest.integrations.requested
        if not item.phase_ids or phase_id is None or phase_id in item.phase_ids
    ]
    if not requests:
        return "No Codex integration is explicitly requested for this phase."
    lines = []
    for request in requests:
        if request.kind == "skill":
            instruction = f"invoke the ${request.id} skill and follow its loaded procedure"
        elif request.kind == "mcp":
            instruction = f"use tools from the configured {request.label} MCP server when relevant"
        else:
            instruction = f"use the connected {request.label} app when relevant"
        lines.append(f"- {request.kind} {request.label} ({request.id}): {instruction}.")
    lines.append(
        "These are visible requests, not a hard tool allowlist. Do not claim an integration was "
        "used unless the run contains observable supporting activity."
    )
    return "\n".join(lines)


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
<requested_integrations binding=\"instructional\">
{integration_prompt(manifest)}
</requested_integrations>

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
