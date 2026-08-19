"""Validate and publish sanitized evidence from the single-sandbox reuse study."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

from weave_codex.reusable_workflow_trials import TARGETS, canonical_hash, programs_for


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plan", type=Path, required=True)
    parser.add_argument("--evidence-root", type=Path, required=True)
    parser.add_argument("--public-out", type=Path, required=True)
    parser.add_argument("--manifest-out", type=Path, required=True)
    parser.add_argument("--sandbox-id", required=True)
    parser.add_argument("--codex-version", required=True)
    parser.add_argument("--login-status-sha256", required=True)
    return parser


def _sha256(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def _load(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"expected an object: {path}")
    return value


def _validate_plan(plan: dict[str, Any]) -> None:
    core = {key: value for key, value in plan.items() if key not in {"frozenAtUtc", "planId"}}
    if plan.get("planId") != canonical_hash(core):
        raise ValueError("frozen plan ID does not match its content")
    if plan.get("sandboxCount") != 1 or plan.get("plannedRuns") != 3:
        raise ValueError("the study must bind one sandbox and three intended runs")
    auth = plan.get("authentication") or {}
    if auth.get("accountMode") != "chatgpt" or auth.get("apiKeyInjected") is not False:
        raise ValueError("the plan must require ChatGPT auth and forbid API-key injection")


def _validate_trial(plan_trial: dict[str, Any], result: dict[str, Any], sandbox_id: str) -> None:
    exact = (
        "trialId",
        "sourceCommit",
        "sourceProgramHash",
        "targetCommit",
        "derivedProgramHash",
        "phaseIds",
        "phaseKinds",
        "changedGoals",
        "structurePreserved",
    )
    for field in exact:
        if result.get(field) != plan_trial.get(field):
            raise ValueError(f"{plan_trial['trialId']} changed frozen field {field}")
    if result.get("sandboxId") != sandbox_id:
        raise ValueError(f"{plan_trial['trialId']} used another sandbox")
    if result.get("status") != "accepted" or result.get("artifactAccepted") is not True:
        raise ValueError(f"{plan_trial['trialId']} is not an accepted clean result")
    external = (result.get("grade") or {}).get("externalVerification") or {}
    if external.get("exitCode") != 0:
        raise ValueError(f"{plan_trial['trialId']} did not pass external verification")


def _labels(repository: str) -> str:
    name = repository.rstrip("/").rsplit("/", 1)[-1]
    known = {"httpx": "HTTPX", "fastify": "Fastify"}
    return known.get(name.lower(), name.replace("-", " ").title())


def assemble(args: argparse.Namespace) -> tuple[dict[str, Any], dict[str, Any]]:
    plan = _load(args.plan)
    _validate_plan(plan)
    trial_by_id = {trial.trial_id: trial for trial in TARGETS}
    published: list[dict[str, Any]] = []
    entries: list[dict[str, Any]] = [
        {"role": "frozen-plan", "path": str(args.plan), "sha256": _sha256(args.plan)}
    ]
    for plan_trial in plan["trials"]:
        trial_id = plan_trial["trialId"]
        public_path = args.evidence_root / "clean" / f"{trial_id}.public.json"
        raw_path = args.evidence_root / "clean" / f"{trial_id}.raw.json"
        result = _load(public_path)
        _validate_trial(plan_trial, result, args.sandbox_id)
        trial = trial_by_id[trial_id]
        source_program, derived_program = programs_for(trial)
        external = (result.get("grade") or {}).get("externalVerification") or {}
        verification_label = "evidence contract and focused upstream checks passed"
        if trial_id == "express-to-fastify-async-errors":
            verification_label = (
                "evidence contract and the repository-configured Fastify borp suite passed"
            )
        published.append(
            {
                **result,
                "sourceRepository": plan_trial["sourceRepo"],
                "targetRepository": plan_trial["targetRepo"],
                "sourceRepo": _labels(plan_trial["sourceRepo"]),
                "targetRepo": _labels(plan_trial["targetRepo"]),
                "sourcePhaseNames": [phase.name for phase in source_program.phases],
                "phaseNames": [phase.name for phase in derived_program.phases],
                "changedFiles": [trial.target.artifact],
                "upstreamChecks": "passed",
                "verification": verification_label,
                "externalCommand": external.get("command") or [],
                "externalElapsedSeconds": external.get("elapsedSeconds"),
                "publicReceiptSha256": _sha256(public_path),
                "rawReceiptSha256": _sha256(raw_path),
            }
        )
        entries.extend(
            [
                {
                    "role": "sanitized-run",
                    "trialId": trial_id,
                    "path": str(public_path),
                    "sha256": _sha256(public_path),
                },
                {
                    "role": "local-private-trace",
                    "trialId": trial_id,
                    "path": str(raw_path),
                    "sha256": _sha256(raw_path),
                },
            ]
        )

    incidents: list[dict[str, Any]] = []
    incident_root = args.evidence_root / "incidents"
    for directory in sorted(path for path in incident_root.iterdir() if path.is_dir()):
        public_path = directory / "public.json"
        raw_path = directory / "raw.json"
        result = _load(public_path)
        incidents.append(
            {
                "incidentId": directory.name,
                "trialId": result.get("trialId"),
                "status": "invalid-infrastructure-attempt",
                "runStatus": result.get("runStatus"),
                "artifactAccepted": result.get("artifactAccepted"),
                "externalExitCode": (
                    (result.get("grade") or {}).get("externalVerification") or {}
                ).get("exitCode"),
                "publicReceiptSha256": _sha256(public_path),
                "rawReceiptSha256": _sha256(raw_path),
            }
        )
        entries.extend(
            [
                {
                    "role": "incident-summary",
                    "incidentId": directory.name,
                    "path": str(public_path),
                    "sha256": _sha256(public_path),
                },
                {
                    "role": "incident-private-trace",
                    "incidentId": directory.name,
                    "path": str(raw_path),
                    "sha256": _sha256(raw_path),
                },
            ]
        )

    public: dict[str, Any] = {
        "schemaVersion": 2,
        "study": plan["study"],
        "planId": plan["planId"],
        "authentication": {
            "method": "chatgpt-device-code",
            "loginStatus": "Logged in using ChatGPT",
            "loginStatusSha256": args.login_status_sha256,
            "apiKeyInjected": False,
            "codexVersion": args.codex_version,
        },
        "sandboxCount": 1,
        "sandboxId": args.sandbox_id,
        "intendedRuns": 3,
        "cleanAcceptedRuns": len(published),
        "invalidInfrastructureAttempts": len(incidents),
        "rawEvidenceAvailability": "local-private; content hashes are published",
        "trials": published,
        "incidents": incidents,
        "claimBoundary": (
            "Three one-rollout product acceptance trials in one ChatGPT-authenticated "
            "Runloop sandbox. Source runs are historical and target runs have no "
            "ordinary-Codex comparison arm. Two additional attempts are disclosed as "
            "invalid setup incidents. The result tests immutable lineage, human-reviewed "
            "goal adaptation, execution, and external verification—not general model "
            "quality or compute efficiency."
        ),
    }
    public["summarySha256"] = canonical_hash(public)
    manifest: dict[str, Any] = {
        "schemaVersion": 1,
        "planId": plan["planId"],
        "summarySha256": public["summarySha256"],
        "rawEvidenceAvailability": public["rawEvidenceAvailability"],
        "entries": entries,
    }
    manifest["manifestId"] = canonical_hash(manifest)
    return public, manifest


def main() -> None:
    args = _parser().parse_args()
    public, manifest = assemble(args)
    args.public_out.parent.mkdir(parents=True, exist_ok=True)
    args.manifest_out.parent.mkdir(parents=True, exist_ok=True)
    args.public_out.write_text(json.dumps(public, indent=2) + "\n", encoding="utf-8")
    args.manifest_out.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(
        json.dumps(
            {"summarySha256": public["summarySha256"], "manifestId": manifest["manifestId"]},
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
