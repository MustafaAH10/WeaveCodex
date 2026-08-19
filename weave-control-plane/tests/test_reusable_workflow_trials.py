from __future__ import annotations

import json
from pathlib import Path

from weave_codex.reusable_workflow_trials import (
    TARGETS,
    canonical_hash,
    programs_for,
    public_design,
)
from weave_codex.workflow_adaptation import validate_goal_only_adaptation


def test_three_programs_preserve_structure_but_change_task_specific_wording() -> None:
    assert len(TARGETS) == 3
    hashes: set[str] = set()
    for trial in TARGETS:
        source, derived = programs_for(trial)
        assert [(item.id, item.kind) for item in source.phases] == [
            (item.id, item.kind) for item in derived.phases
        ]
        assert validate_goal_only_adaptation(source, derived)
        design = public_design(trial)
        assert design["structurePreserved"] is True
        assert design["sourceProgramHash"] != design["derivedProgramHash"]
        hashes.add(design["sourceProgramHash"])
    assert len(hashes) == 3


def test_target_repositories_are_distinct_pinned_and_memory_contract_is_external() -> None:
    assert {trial.target.directory for trial in TARGETS} == {"typer", "httpx", "fastify"}
    assert all(len(trial.target_commit) == 40 for trial in TARGETS)
    assert all(trial.target.artifact.startswith(".weave/evidence/") for trial in TARGETS)


def test_runner_is_explicitly_gated() -> None:
    script = Path(__file__).parents[1] / "scripts/run_reusable_workflow_trial.py"
    source = script.read_text(encoding="utf-8")
    assert "--confirm-one-run" in source
    assert 'memory": "off"' in source
    assert "session.decide" in source

    launcher = Path(__file__).parents[1] / "scripts/launch_reusable_workflow_runloop.py"
    launch_source = launcher.read_text(encoding="utf-8")
    assert "--confirm-one-chatgpt-sandbox" in launch_source
    assert "codex login --device-auth" in launch_source
    assert "Logged in using ChatGPT" in launch_source
    assert "OPENAI_API_KEY must not be injected" in launch_source
    assert "--with-api-key" not in launch_source
    assert "secret.create" not in launch_source


def test_published_single_sandbox_evidence_matches_the_frozen_programs() -> None:
    static = Path(__file__).parents[1] / "weave_codex/static"
    summary = json.loads((static / "reusable-workflow-trials.json").read_text())
    manifest = json.loads((static / "reusable-workflow-trials-evidence.json").read_text())
    plan = json.loads((static / "reusable-workflow-trials-plan-v2.json").read_text())

    assert summary["schemaVersion"] == 2
    assert summary["authentication"] == {
        "method": "chatgpt-device-code",
        "loginStatus": "Logged in using ChatGPT",
        "loginStatusSha256": (
            "sha256:16118df3eb3595e44a4721878cef0f79910e6564e10ff0e78e451e7c4e478947"
        ),
        "apiKeyInjected": False,
        "codexVersion": "0.148.0",
    }
    assert summary["sandboxCount"] == 1
    assert summary["intendedRuns"] == 3
    assert summary["cleanAcceptedRuns"] == 3
    assert summary["invalidInfrastructureAttempts"] == 2
    assert {trial["sandboxId"] for trial in summary["trials"]} == {summary["sandboxId"]}
    assert [trial["status"] for trial in summary["trials"]] == ["accepted"] * 3
    assert [trial["sourceRepo"] for trial in summary["trials"]] == [
        "Click",
        "Requests",
        "Express",
    ]
    assert [trial["targetRepo"] for trial in summary["trials"]] == [
        "Typer",
        "HTTPX",
        "Fastify",
    ]
    for trial in summary["trials"]:
        assert trial["sourceProgramHash"] != trial["derivedProgramHash"]
        assert trial["structurePreserved"] is True
        assert trial["changedGoals"] == 4
        assert trial["phaseKinds"] == ["work", "checkpoint", "work", "work", "verify"]
        assert trial["artifactAccepted"] is True
        assert trial["upstreamChecks"] == "passed"

    assert manifest["planId"] == summary["planId"]
    assert manifest["summarySha256"] == summary["summarySha256"]
    assert len(manifest["entries"]) == 11
    assert summary["summarySha256"] == canonical_hash(
        {key: value for key, value in summary.items() if key != "summarySha256"}
    )
    assert manifest["manifestId"] == canonical_hash(
        {key: value for key, value in manifest.items() if key != "manifestId"}
    )
    assert plan["planId"] == canonical_hash(
        {key: value for key, value in plan.items() if key not in {"frozenAtUtc", "planId"}}
    )
