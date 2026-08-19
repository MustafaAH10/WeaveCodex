"""Immutable, task-independent workflow storage for Weave Codex."""

from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
import threading
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field

from .phase_program import PhaseProgram

_WORKFLOW_ID = re.compile(r"^wf_[0-9a-f]{16}$")


class _StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class WorkflowCreate(_StrictModel):
    """The reusable portion of a harness; deliberately excludes task and cwd."""

    name: str = Field(min_length=2, max_length=100)
    description: str = Field(default="", max_length=500)
    phase_program: PhaseProgram = Field(alias="phaseProgram")
    parent_workflow_id: str | None = Field(
        default=None, alias="parentWorkflowId", pattern=r"^wf_[0-9a-f]{16}$"
    )
    adaptation_method: Literal["manual", "codex"] | None = Field(
        default=None, alias="adaptationMethod"
    )
    adaptation_summary: str = Field(default="", alias="adaptationSummary", max_length=500)


class SavedWorkflow(_StrictModel):
    schema_version: Literal[1, 2] = Field(default=2, alias="schemaVersion")
    workflow_id: str = Field(alias="workflowId", pattern=r"^wf_[0-9a-f]{16}$")
    name: str = Field(min_length=2, max_length=100)
    description: str = Field(default="", max_length=500)
    phase_program: PhaseProgram = Field(alias="phaseProgram")
    program_hash: str = Field(alias="programHash", pattern=r"^sha256:[0-9a-f]{64}$")
    created_at: str = Field(alias="createdAt")
    parent_workflow_id: str | None = Field(
        default=None, alias="parentWorkflowId", pattern=r"^wf_[0-9a-f]{16}$"
    )
    parent_program_hash: str | None = Field(
        default=None, alias="parentProgramHash", pattern=r"^sha256:[0-9a-f]{64}$"
    )
    adaptation_method: Literal["manual", "codex"] | None = Field(
        default=None, alias="adaptationMethod"
    )
    adaptation_summary: str = Field(default="", alias="adaptationSummary", max_length=500)


def program_hash(program: PhaseProgram) -> str:
    payload = json.dumps(
        program.model_dump(by_alias=True, mode="json"),
        sort_keys=True,
        separators=(",", ":"),
    ).encode()
    return f"sha256:{hashlib.sha256(payload).hexdigest()}"


class WorkflowStore:
    """Small local JSON store whose records are immutable once written."""

    def __init__(self, root: Path) -> None:
        self.root = root
        self._lock = threading.Lock()

    def save(self, request: WorkflowCreate) -> SavedWorkflow:
        parent = self.get(request.parent_workflow_id) if request.parent_workflow_id else None
        if request.parent_workflow_id and parent is None:
            raise ValueError("parent workflow does not exist")
        value = SavedWorkflow(
            schemaVersion=2,
            workflowId=f"wf_{uuid4().hex[:16]}",
            name=request.name,
            description=request.description,
            phaseProgram=request.phase_program,
            programHash=program_hash(request.phase_program),
            createdAt=datetime.now(UTC).isoformat(),
            parentWorkflowId=parent.workflow_id if parent else None,
            parentProgramHash=parent.program_hash if parent else None,
            adaptationMethod=request.adaptation_method,
            adaptationSummary=request.adaptation_summary,
        )
        payload = value.model_dump_json(by_alias=True, indent=2)
        with self._lock:
            self.root.mkdir(parents=True, exist_ok=True)
            descriptor, temporary_name = tempfile.mkstemp(
                prefix=".workflow-", suffix=".json", dir=self.root
            )
            temporary = Path(temporary_name)
            try:
                with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                    handle.write(payload)
                    handle.write("\n")
                    handle.flush()
                    os.fsync(handle.fileno())
                temporary.replace(self.root / f"{value.workflow_id}.json")
            finally:
                temporary.unlink(missing_ok=True)
        return value

    def list(self) -> list[SavedWorkflow]:
        if not self.root.is_dir():
            return []
        values: list[SavedWorkflow] = []
        paths = sorted(
            self.root.glob("wf_*.json"),
            key=lambda item: item.stat().st_mtime,
            reverse=True,
        )
        for path in paths[:100]:
            try:
                values.append(SavedWorkflow.model_validate_json(path.read_text(encoding="utf-8")))
            except (OSError, ValueError):
                continue
        return values

    def get(self, workflow_id: str) -> SavedWorkflow | None:
        if _WORKFLOW_ID.fullmatch(workflow_id) is None:
            return None
        path = self.root / f"{workflow_id}.json"
        if not path.is_file():
            return None
        try:
            return SavedWorkflow.model_validate_json(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
