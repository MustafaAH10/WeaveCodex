from __future__ import annotations

import json
from pathlib import Path

from weave_codex.manifest import HarnessManifest, compile_manifest
from weave_codex.workflow_store import WorkflowCreate, WorkflowStore, program_hash


def reusable_program() -> dict[str, object]:
    return {
        "projectionVersion": 1,
        "phases": [
            {
                "id": "inspect",
                "kind": "work",
                "name": "Inspect",
                "goal": "Inspect the relevant repository evidence and propose a direction.",
            },
            {
                "id": "approve",
                "kind": "checkpoint",
                "name": "Approve",
                "question": "Continue with this direction?",
            },
            {
                "id": "build",
                "kind": "work",
                "name": "Build",
                "goal": "Implement the approved direction and run focused checks.",
            },
        ],
    }


def task_manifest(task: str, cwd: str, program: dict[str, object]) -> HarnessManifest:
    return HarnessManifest.model_validate(
        {
            "schemaVersion": 2,
            "name": "Reusable workflow run",
            "cwd": cwd,
            "task": {"instructions": task, "contextPaths": []},
            "memory": {"mode": "off", "selectedThreadIds": []},
            "integrations": {"inventoryId": None, "requested": []},
            "agent": {
                "model": None,
                "reasoningEffort": "medium",
                "sandbox": "workspace-write",
                "approvalGate": "manual",
            },
            "verification": {
                "enabled": False,
                "criteria": "Phase program owns verification.",
                "maxRetries": 0,
            },
            "output": {"format": "text"},
            "observability": {"traceRoot": ".weave-codex/traces"},
            "phaseProgram": program,
        }
    )


def test_saved_workflow_excludes_task_and_survives_store_restart(tmp_path: Path) -> None:
    store = WorkflowStore(tmp_path / "workflows")
    created = store.save(
        WorkflowCreate.model_validate(
            {
                "name": "Inspect, approve, build",
                "description": "A reusable human-gated change process.",
                "phaseProgram": reusable_program(),
            }
        )
    )

    raw = json.loads((store.root / f"{created.workflow_id}.json").read_text())
    assert "task" not in raw
    assert "cwd" not in raw
    assert raw["programHash"] == program_hash(created.phase_program)

    reloaded = WorkflowStore(store.root).get(created.workflow_id)
    assert reloaded == created
    assert WorkflowStore(store.root).list() == [created]


def test_same_saved_program_compiles_for_two_distinct_tasks_without_mutation(
    tmp_path: Path,
) -> None:
    store = WorkflowStore(tmp_path / "workflows")
    saved = store.save(
        WorkflowCreate.model_validate(
            {
                "name": "Reusable engineering review",
                "phaseProgram": reusable_program(),
            }
        )
    )
    before = (store.root / f"{saved.workflow_id}.json").read_bytes()

    frontend = task_manifest(
        "Redesign onboarding and verify it in a browser.",
        "/tmp/frontend",
        saved.phase_program.model_dump(by_alias=True, mode="json"),
    )
    migration = task_manifest(
        "Migrate the database schema without breaking compatibility.",
        "/tmp/backend",
        saved.phase_program.model_dump(by_alias=True, mode="json"),
    )
    compiled_frontend = compile_manifest(frontend)
    compiled_migration = compile_manifest(migration)

    assert compiled_frontend["executionOrder"] == compiled_migration["executionOrder"]
    assert compiled_frontend["manifestHash"] != compiled_migration["manifestHash"]
    assert program_hash(frontend.phase_program) == saved.program_hash
    assert program_hash(migration.phase_program) == saved.program_hash
    assert (store.root / f"{saved.workflow_id}.json").read_bytes() == before


def test_derived_workflow_binds_parent_without_mutating_it(tmp_path: Path) -> None:
    store = WorkflowStore(tmp_path / "workflows")
    parent = store.save(
        WorkflowCreate.model_validate(
            {"name": "Reusable review", "phaseProgram": reusable_program()}
        )
    )
    parent_bytes = (store.root / f"{parent.workflow_id}.json").read_bytes()
    adapted = reusable_program()
    adapted["phases"][0]["goal"] = "Inspect HTTP proxy invariants before proposing a repair."
    child = store.save(
        WorkflowCreate.model_validate(
            {
                "name": "Proxy contract review",
                "description": "Adapted for network-client contract work.",
                "phaseProgram": adapted,
                "parentWorkflowId": parent.workflow_id,
                "adaptationMethod": "codex",
                "adaptationSummary": "Reworded goals; structure preserved.",
            }
        )
    )

    assert child.parent_workflow_id == parent.workflow_id
    assert child.parent_program_hash == parent.program_hash
    assert child.program_hash != parent.program_hash
    assert (store.root / f"{parent.workflow_id}.json").read_bytes() == parent_bytes


def test_delete_removes_workflow_from_library_and_keeps_recovery_copy(tmp_path: Path) -> None:
    store = WorkflowStore(tmp_path / "workflows")
    saved = store.save(
        WorkflowCreate.model_validate(
            {"name": "Temporary workflow", "phaseProgram": reusable_program()}
        )
    )

    assert store.delete(saved.workflow_id) is True
    assert store.get(saved.workflow_id) is None
    assert store.list() == []
    assert len(list((store.root / ".trash").glob(f"{saved.workflow_id}-*.json"))) == 1
    assert store.delete(saved.workflow_id) is False
