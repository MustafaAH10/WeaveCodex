from __future__ import annotations

import json
import subprocess
from pathlib import Path

from weave_codex.manifest import compile_manifest
from weave_codex.repo_trials import TRIALS, build_trial_manifest, grade_evidence


def init_repo(root: Path, trial_id: str) -> Path:
    trial = next(item for item in TRIALS if item.id == trial_id)
    repo = root / trial.directory
    repo.mkdir(parents=True)
    subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=repo, check=True)
    paths = [trial.context_paths[0], trial.context_paths[-1], *trial.context_paths[1:-1]]
    for index, relative in enumerate(dict.fromkeys(paths)):
        path = repo / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(f"evidence {index} {' '.join(trial.required_terms)}\n", encoding="utf-8")
    extra = repo / trial.test_prefixes[0] / "extra-evidence.txt"
    extra.parent.mkdir(parents=True, exist_ok=True)
    extra.write_text("test evidence\n", encoding="utf-8")
    subprocess.run(["git", "add", "."], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-qm", "fixture"], cwd=repo, check=True)
    return repo


def test_trial_manifests_expose_goal_phases_not_tool_calls(tmp_path: Path) -> None:
    for trial in TRIALS:
        repo = init_repo(tmp_path / trial.id, trial.id)
        manifest = build_trial_manifest(trial, repo, model="gpt-5.6-terra")
        compiled = compile_manifest(manifest)
        assert compiled["maximumTurns"] == 4
        assert manifest.memory.mode == "off"
        assert manifest.agent.sandbox == "workspace-write"
        assert [phase.kind for phase in manifest.phase_program.phases] == [
            "work",
            "checkpoint",
            "work",
            "work",
            "verify",
        ]
        assert "native tool calls" in compiled["internalLoopSemantics"]


def test_grade_requires_grounded_tracked_references(tmp_path: Path) -> None:
    trial = TRIALS[0]
    repo = init_repo(tmp_path, trial.id)
    commit = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=repo, check=True, capture_output=True, text=True
    ).stdout.strip()
    references = list(dict.fromkeys([*trial.context_paths, "tests/extra-evidence.txt"]))
    artifact = repo / trial.artifact
    artifact.parent.mkdir(parents=True)
    artifact.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "trialId": trial.id,
                "repository": {"url": trial.repository, "commit": commit},
                "question": trial.question,
                "findings": [
                    {
                        "claim": f"claim {index} {' '.join(trial.required_terms)}",
                        "sourcePaths": references,
                        "symbols": list(trial.required_terms),
                        "evidence": "grounded",
                    }
                    for index in range(3)
                ],
                "verification": [{"command": "pytest", "exitCode": 0, "purpose": "focused"}],
                "limitations": ["fixture"],
                "conclusion": "grounded",
            }
        ),
        encoding="utf-8",
    )
    runtime_trace = repo / ".weave-codex" / "traces" / "trace.jsonl"
    runtime_trace.parent.mkdir(parents=True)
    runtime_trace.write_text("runtime evidence\n", encoding="utf-8")
    grade = grade_evidence(trial, repo)
    assert grade["passed"] is True
    assert len(grade["referencedFiles"]) >= 4


def test_grade_rejects_untracked_or_outside_references(tmp_path: Path) -> None:
    trial = TRIALS[0]
    repo = init_repo(tmp_path, trial.id)
    commit = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=repo, check=True, capture_output=True, text=True
    ).stdout.strip()
    artifact = repo / trial.artifact
    artifact.parent.mkdir(parents=True)
    artifact.write_text(
        json.dumps(
            {
                "trialId": trial.id,
                "repository": {"commit": commit},
                "findings": [
                    {
                        "claim": " ".join(trial.required_terms),
                        "sourcePaths": ["../secret", "invented.py"],
                    }
                ]
                * 3,
            }
        ),
        encoding="utf-8",
    )
    assert grade_evidence(trial, repo)["passed"] is False
