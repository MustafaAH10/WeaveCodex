from __future__ import annotations

import json
import subprocess
from dataclasses import replace
from pathlib import Path

from weave_codex.manifest import compile_manifest
from weave_codex.oss_implementation_trials import (
    TASKS,
    OssImplementationTask,
    format_command,
    materialize_seeded_repository,
    ordinary_prompt,
    seed_digest,
    sha256_json,
    tracked_changes,
    weave_manifest,
)


def _fixture_repo(root: Path, task_index: int) -> tuple[Path, OssImplementationTask]:
    task = TASKS[task_index]
    repo = root / task.directory
    repo.mkdir(parents=True)
    subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=repo, check=True)
    for edit in task.seed_edits:
        path = repo / edit.path
        path.parent.mkdir(parents=True, exist_ok=True)
        existing = path.read_text(encoding="utf-8") if path.exists() else ""
        path.write_text(existing + edit.before, encoding="utf-8")
    for path_name in task.context_paths:
        path = repo / path_name
        if not path.exists():
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("test context\n", encoding="utf-8")
    subprocess.run(["git", "add", "."], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-qm", "fixture"], cwd=repo, check=True)
    commit = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=repo, check=True, capture_output=True, text=True
    ).stdout.strip()
    return repo, replace(task, commit=commit)


def test_tasks_are_pinned_distinct_and_memory_off(tmp_path: Path) -> None:
    assert [task.directory for task in TASKS] == ["jinja", "starlette", "commander"]
    assert len({task.repository for task in TASKS}) == 3
    assert len({seed_digest(task) for task in TASKS}) == 3
    for task in TASKS:
        command = format_command(task.upstream_test, starlette_python="/venv/python")
        manifest = weave_manifest(
            task,
            tmp_path / task.directory,
            model="gpt-5.6-terra",
            test_command=command,
        )
        compiled = compile_manifest(manifest)
        assert manifest.memory.mode == "off"
        assert manifest.agent.sandbox == "workspace-write"
        assert manifest.agent.approval_gate == "deny"
        assert compiled["maximumTurns"] >= 4
        assert compiled["maximumTurns"] <= 5
        assert "Memory is disabled" in ordinary_prompt(task, command)


def test_seed_materialization_is_exact_and_target_only(tmp_path: Path) -> None:
    source, task = _fixture_repo(tmp_path / "source", 0)
    destination = tmp_path / "seeded"
    digest = materialize_seeded_repository(task, source, destination)
    assert digest.startswith("sha256:")
    assert tracked_changes(destination) == list(task.target_paths)
    text = (destination / task.target_paths[0]).read_text(encoding="utf-8")
    for edit in task.seed_edits:
        assert edit.before not in text
        assert edit.after in text


def test_command_placeholder_is_resolved() -> None:
    task = TASKS[1]
    command = format_command(task.upstream_test, starlette_python="/tmp/python")
    assert command[0] == "/tmp/python"
    assert all("{" not in part for part in command)
    hidden = format_command(task.hidden_test, starlette_python="/tmp/python")
    assert hidden[0] == "/tmp/python"
    assert "{'X-Custom':'v'}" in hidden[-1]


def test_phase_programs_are_genuinely_different(tmp_path: Path) -> None:
    shapes = []
    for task in TASKS:
        command = format_command(task.upstream_test, starlette_python="python")
        manifest = weave_manifest(
            task, tmp_path / task.directory, model="test", test_command=command
        )
        shapes.append(tuple(phase.kind for phase in manifest.phase_program.phases))
    assert shapes == [
        ("work", "checkpoint", "work", "verify"),
        ("work", "work", "work", "verify"),
        ("work", "checkpoint", "work", "work", "verify"),
    ]


def test_preserved_oss_study_ids_and_results_are_self_consistent() -> None:
    root = Path(__file__).parents[1] / "weave_codex" / "static"
    plan = json.loads((root / "oss-implementation-trials-plan.json").read_text())
    plan_id = plan.pop("planId")
    plan.pop("frozenAtUtc")
    assert plan_id == sha256_json(plan)

    summary = json.loads((root / "oss-implementation-trials.json").read_text())
    summary_id = summary.pop("summarySha256")
    assert summary_id == sha256_json(summary)
    assert summary["planId"] == plan_id
    assert summary["aggregate"] == {
        "repositories": 3,
        "runs": 6,
        "ordinaryAccepted": 3,
        "weaveAccepted": 3,
        "ordinaryControllerTurns": 3,
        "weaveControllerTurns": 11,
        "ordinaryModelCompletions": 18,
        "weaveModelCompletions": 32,
    }
    assert all(
        result[arm]["artifactAccepted"]
        for result in summary["results"]
        for arm in ("ordinary", "weave")
    )
