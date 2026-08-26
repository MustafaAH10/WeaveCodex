from __future__ import annotations

import importlib.util
import json
import os
import shutil
import sys
import time
from pathlib import Path

import pytest

SCRIPT = Path(__file__).parents[1] / "scripts" / "run_platform_workflow_trials.py"
SPEC = importlib.util.spec_from_file_location("platform_workflow_trials", SCRIPT)
assert SPEC and SPEC.loader
TRIALS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(TRIALS)
PLAN_PATH = Path(__file__).parents[2] / "experiments" / "platform-workflow-trials" / "plan.json"
RECOVERY_PLAN_PATH = PLAN_PATH.with_name("plan-v2-recovery.json")
PUBLIC_BUNDLE = PLAN_PATH.parent / "results-v2"


def _trial(plan: dict[str, object], trial_id: str) -> dict[str, object]:
    return next(item for item in plan["trials"] if item["trialId"] == trial_id)


def test_frozen_plan_has_bounded_subscription_design() -> None:
    plan = TRIALS.load_plan(PLAN_PATH)
    assert plan["execution"] == {
        "samplesPerArm": 1,
        "armsPerTrial": 2,
        "plannedTrials": 4,
        "plannedRuns": 8,
        "sequence": "sequential",
        "memory": "off",
        "model": "gpt-5.6-terra",
        "reasoningEffort": "low",
        "ordinaryMaximumControllerTurns": 1,
        "weaveMaximumControllerTurns": 3,
        "maximumTotalControllerTurns": 16,
        "maximumWallMinutesPerRun": 20,
        "nativeProtectedActions": "deny",
        "networkUse": "Codex service only; task fixtures and simulated connectors are local",
    }
    assert {item["domain"] for item in plan["trials"]} == {
        "coding",
        "design",
        "operations-integration-simulation",
        "support-research-simulation",
    }


def test_recovery_plan_discloses_invalid_prompt_exposure_and_environment() -> None:
    plan = TRIALS.load_plan(RECOVERY_PLAN_PATH)
    assert plan["planId"] == (
        "sha256:cb61b2f65745b67801c54e38c623a1dbb06004c0bde606469ebb9e037f5d643e"
    )
    assert plan["invalidAttempt"]["validSamples"] == 0
    assert "prompt" in plan["invalidAttempt"]["promptExposure"].lower()
    assert plan["environmentRequirements"]["sourceMount"].endswith("read-only")
    assert plan["environmentRequirements"]["resultMount"].endswith("writable named volume")
    assert len(plan["trials"]) == 4


def test_manifests_compare_one_turn_with_explicit_contract(tmp_path: Path) -> None:
    plan = TRIALS.load_plan(PLAN_PATH)
    for trial in plan["trials"]:
        workspace = tmp_path / trial["trialId"]
        workspace.mkdir()
        ordinary = TRIALS.build_manifest(trial, workspace, "ordinary", "gpt-5.6-terra", "low")
        weave = TRIALS.build_manifest(trial, workspace, "weave", "gpt-5.6-terra", "low")
        assert ordinary.schema_version == 1
        assert ordinary.verification.enabled is False
        assert weave.schema_version == 2
        assert [phase.kind for phase in weave.phase_program.phases] == [
            "work",
            "checkpoint",
            "work",
            "verify",
        ]
        assert ordinary.memory.mode == weave.memory.mode == "off"
        assert ordinary.agent.approval_gate == weave.agent.approval_gate == "deny"


def test_checkpoint_gates_are_artifact_based(tmp_path: Path) -> None:
    plan = TRIALS.load_plan(PLAN_PATH)
    cases = {
        "forecast-zero-override": {
            "rootCause": "Explicit 0 is falsy and incorrectly falls back.",
            "intendedChange": "Preserve explicit zero and the public API.",
            "testsToRun": "python -m unittest -v",
            "risks": ["blank fallback"],
        },
        "night-bloom-poster": {
            "hierarchy": "Night Bloom then date and venue",
            "palette": ["#101828", "#F8F5EC", "#8B5CF6", "#2E7D5B"],
            "motif": "abstract botanical",
            "accessibility": "title and desc",
            "facts": ["Night Bloom", "17 October", "Riverside Makers Hall", "Free entry"],
        },
        "connector-action-draft": {
            "sourceIds": ["ORD-101", "ORD-102"],
            "proposedActions": ["ORD-101", "ORD-102"],
            "excludedOrders": ["ORD-103", "ORD-104"],
            "safetyBoundary": "Never use --apply",
        },
        "incident-support-brief": {
            "observations": ["INC-42"],
            "inferences": [],
            "unknowns": ["root cause unknown"],
            "requiredCitations": [
                "incident_log.json#INC-42",
                "status_history.md#09-30Z",
                "runbook.md#customer-update-runbook",
            ],
            "nextUpdateAt": "10:00Z",
        },
    }
    for trial_id, value in cases.items():
        trial = _trial(plan, trial_id)
        artifact = tmp_path / trial_id / trial["checkpointArtifact"]
        artifact.parent.mkdir(parents=True)
        artifact.write_text(json.dumps(value), encoding="utf-8")
        assert TRIALS.checkpoint_gate(trial_id, artifact.parents[1], trial["checkpointArtifact"])[
            "passed"
        ]


def test_seeded_artifact_graders_accept_contracts(tmp_path: Path) -> None:
    plan = TRIALS.load_plan(PLAN_PATH)

    coding = tmp_path / "coding"
    coding_trial = _trial(plan, "forecast-zero-override")
    shutil.copytree(PLAN_PATH.parent / coding_trial["fixture"], coding)
    immutable_before = {"test_forecast.py": TRIALS.file_hash(coding / "test_forecast.py")}
    coding.joinpath("forecast.py").write_text(
        "def forecast_rows(rows, baseline_growth):\n"
        "    out = []\n"
        "    for row in rows:\n"
        "        raw = row.get('growth_override')\n"
        "        raw = baseline_growth if raw in (None, '') else raw\n"
        "        try:\n"
        "            out.append(float(row['revenue']) * (1 + float(raw)))\n"
        "        except ValueError as exc:\n"
        "            raise ValueError(f\"invalid growth for {row.get('row_id')}\") from exc\n"
        "    return out\n",
        encoding="utf-8",
    )
    coding_grade = TRIALS.grade(coding_trial, coding, immutable_before)
    assert coding_grade["passed"] is True
    assert coding_grade["inputIntegrity"]["passed"] is True

    design = tmp_path / "design"
    design.mkdir()
    design.joinpath("poster.svg").write_text(
        """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 1600">
        <title>Night Bloom</title><desc>Abstract botanical event poster</desc>
        <rect width="1200" height="1600" fill="#101828"/>
        <circle cx="100" cy="100" r="50" fill="#F8F5EC"/>
        <circle cx="200" cy="200" r="50" fill="#8B5CF6"/>
        <path d="M0 0L10 10" stroke="#2E7D5B"/>
        <path d="M10 0L20 10"/><path d="M20 0L30 10"/>
        <path d="M30 0L40 10"/><path d="M40 0L50 10"/>
        <text>Night Bloom</text><text>17 October</text>
        <text>Riverside Makers Hall</text><text>Free entry</text></svg>""",
        encoding="utf-8",
    )
    design.joinpath("design-notes.md").write_text(
        "The hierarchy prioritizes the title. Accessibility uses title and desc.",
        encoding="utf-8",
    )
    assert all(TRIALS._grade_design(design)["checks"].values())
    original_svg = design.joinpath("poster.svg").read_text(encoding="utf-8")
    for remote_url in ("https://cdn.example/poster.svg", "//cdn.example/poster.svg"):
        design.joinpath("poster.svg").write_text(
            original_svg.replace(
                "</svg>", f"<style>.remote{{fill:url('{remote_url}')}}</style></svg>"
            ),
            encoding="utf-8",
        )
        assert TRIALS._grade_design(design)["checks"]["selfContained"] is False
    design.joinpath("poster.svg").write_text(original_svg, encoding="utf-8")

    operations = tmp_path / "operations"
    shutil.copytree(
        PLAN_PATH.parent / _trial(plan, "connector-action-draft")["fixture"], operations
    )
    operations.joinpath("proposed_actions.json").write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "actions": [
                    {
                        "orderId": "ORD-101",
                        "accountId": "ACC-1",
                        "action": "priority_outreach",
                        "requiresApproval": True,
                        "reason": "Priority account delayed by five days.",
                        "sourceRefs": ["ORD-101", "ACC-1"],
                    },
                    {
                        "orderId": "ORD-102",
                        "accountId": "ACC-2",
                        "action": "draft_refund",
                        "requiresApproval": True,
                        "reason": "Refund requested within thirty days.",
                        "sourceRefs": ["ORD-102", "ACC-2"],
                    },
                ],
            }
        ),
        encoding="utf-8",
    )
    assert all(TRIALS._grade_operations(operations)["checks"].values())
    value = json.loads(operations.joinpath("proposed_actions.json").read_text(encoding="utf-8"))
    value["actions"].append(dict(value["actions"][0]))
    value["actions"][1]["accountId"] = "ACC-1"
    operations.joinpath("proposed_actions.json").write_text(json.dumps(value), encoding="utf-8")
    rejected = TRIALS._grade_operations(operations)["checks"]
    assert rejected["exactEligibleActions"] is False
    assert rejected["distinctOrders"] is True


def test_tampered_plan_is_rejected(tmp_path: Path) -> None:
    value = json.loads(PLAN_PATH.read_text(encoding="utf-8"))
    value["execution"]["plannedRuns"] = 9
    path = tmp_path / "plan.json"
    path.write_text(json.dumps(value), encoding="utf-8")
    with pytest.raises(ValueError, match="planId"):
        TRIALS.load_plan(path)


@pytest.mark.skipif(os.name != "posix", reason="real trial runner is Linux-container only")
def test_wall_cap_terminates_descendant_process_group(tmp_path: Path) -> None:
    sentinel = tmp_path / "descendant-survived"
    ready = tmp_path / "descendant-ready"
    descendant = (
        "import pathlib,signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); "
        f"pathlib.Path({str(ready)!r}).write_text('ready'); time.sleep(1); "
        f"pathlib.Path({str(sentinel)!r}).write_text('alive')"
    )
    parent = (
        "import subprocess,sys,time; "
        f"subprocess.Popen([sys.executable, '-c', {descendant!r}]); "
        "time.sleep(60)"
    )
    with pytest.raises(TimeoutError, match="trial child exceeded"):
        TRIALS._run_process_group([sys.executable, "-c", parent], timeout_seconds=0.5)
    assert ready.exists()
    time.sleep(1.1)
    assert not sentinel.exists()


def test_private_child_parser_does_not_require_parent_output_arguments(tmp_path: Path) -> None:
    args = TRIALS.parser().parse_args(
        [
            "--plan",
            str(RECOVERY_PLAN_PATH),
            "--execute-one",
            "--trial-id",
            "forecast-zero-override",
            "--arm",
            "ordinary",
            "--workspace",
            str(tmp_path / "workspace"),
            "--child-out",
            str(tmp_path / "child.json"),
        ]
    )
    TRIALS._require_arguments(args, ("trial_id", "arm", "workspace", "child_out"))
    assert args.work_root is None
    assert args.raw_root is None
    assert args.public_out is None
    assert args.sandbox_id is None


def test_curator_rejects_duplicate_or_missing_arm_identity() -> None:
    plan = TRIALS.load_plan(RECOVERY_PLAN_PATH)
    complete = [
        {"trialId": trial["trialId"], "arm": arm}
        for trial in plan["trials"]
        for arm in ("ordinary", "weave")
    ]
    TRIALS._validate_result_matrix(plan, complete)
    with pytest.raises(ValueError, match="exactly one"):
        TRIALS._validate_result_matrix(plan, [*complete[:-1], dict(complete[0])])


def test_public_evidence_bundle_ids_and_hashes_are_canonical() -> None:
    manifest = json.loads((PUBLIC_BUNDLE / "evidence-manifest.json").read_text(encoding="utf-8"))
    summary = json.loads((PUBLIC_BUNDLE / "curated-summary.json").read_text(encoding="utf-8"))
    outcome = json.loads((PUBLIC_BUNDLE / "outcome.json").read_text(encoding="utf-8"))
    environment = json.loads(
        (PUBLIC_BUNDLE / "environment-preflight.json").read_text(encoding="utf-8")
    )

    assert summary["summaryId"] == TRIALS.canonical_hash(
        {key: value for key, value in summary.items() if key != "summaryId"}
    )
    assert outcome["outcomeId"] == TRIALS.canonical_hash(
        {key: value for key, value in outcome.items() if key != "outcomeId"}
    )
    assert manifest["curatedSummaryId"] == summary["summaryId"]
    assert manifest["outcomeId"] == outcome["outcomeId"]
    assert manifest["environmentReceiptId"] == TRIALS.canonical_hash(environment)

    for item in manifest["files"]:
        assert item["sha256"] == TRIALS.file_hash(PUBLIC_BUNDLE / item["path"])
    assert manifest["trees"]["artifacts"] == TRIALS.directory_hash(PUBLIC_BUNDLE / "artifacts")
    assert manifest["trees"]["receipts"] == TRIALS.directory_hash(PUBLIC_BUNDLE / "receipts")
    assert manifest["grader"]["sha256"] == TRIALS.file_hash(SCRIPT)
    assert manifest["tests"]["sha256"] == TRIALS.file_hash(Path(__file__))
    assert manifest["invalidIncident"]["sha256"] == TRIALS.file_hash(
        PUBLIC_BUNDLE / manifest["invalidIncident"]["path"]
    )
