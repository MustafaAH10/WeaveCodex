"""Run or regrade one frozen reusable-workflow target in an isolated sandbox."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import threading
import time
from pathlib import Path
from typing import Any

from weave_codex.manifest import manifest_hash
from weave_codex.reusable_workflow_trials import (
    TARGETS,
    build_manifest,
    canonical_hash,
    grade,
    public_design,
)
from weave_codex.runtime import HarnessRunner, RunSession


def parser() -> argparse.ArgumentParser:
    value = argparse.ArgumentParser(description=__doc__)
    value.add_argument("--trial-id", required=True)
    value.add_argument("--repo", type=Path, required=True)
    value.add_argument("--raw-out", type=Path, required=True)
    value.add_argument("--public-out", type=Path, required=True)
    value.add_argument("--sandbox-id", required=True)
    value.add_argument("--codex-bin", default=shutil.which("codex") or "codex")
    value.add_argument("--model", default="gpt-5.6-terra")
    value.add_argument("--execute", action="store_true")
    value.add_argument("--confirm-one-run", action="store_true")
    return value


def _run(manifest: Any, codex_bin: str, run_id: str) -> RunSession:
    session = RunSession(run_id=run_id)
    worker = threading.Thread(target=HarnessRunner(codex_bin).run, args=(manifest, session))
    worker.start()
    deadline = time.monotonic() + 2_700
    while worker.is_alive() and time.monotonic() < deadline:
        pending = session.pending_approval
        if pending is not None:
            session.decide("accept" if pending.get("method") == "harness/checkpoint" else "decline")
        worker.join(timeout=0.5)
    if worker.is_alive():
        raise TimeoutError("run exceeded 45 minutes")
    return session


def _check(command: tuple[str, ...], cwd: Path) -> dict[str, Any]:
    started = time.monotonic()
    completed = subprocess.run(list(command), cwd=cwd, capture_output=True, text=True, timeout=900)
    output = completed.stdout + "\n" + completed.stderr
    return {
        "command": list(command),
        "exitCode": completed.returncode,
        "elapsedSeconds": round(time.monotonic() - started, 3),
        "outputSha256": "sha256:" + hashlib.sha256(output.encode()).hexdigest(),
    }


def run(args: argparse.Namespace) -> dict[str, Any]:
    trial = next(item for item in TARGETS if item.trial_id == args.trial_id)
    manifest = build_manifest(trial, args.repo, args.model)
    dry = {
        "trialId": trial.trial_id,
        "manifestHash": manifest_hash(manifest),
        "model": args.model,
        "memory": "off",
        "maximumControllerTurns": 4,
        **public_design(trial),
    }
    if not args.execute:
        return {"state": "dry-run", **dry}
    if not args.confirm_one_run:
        raise SystemExit("--execute requires --confirm-one-run")
    session = _run(manifest, args.codex_bin, f"reuse-{trial.trial_id}")
    raw = session.snapshot()
    args.raw_out.parent.mkdir(parents=True, exist_ok=True)
    args.raw_out.write_text(json.dumps(raw, indent=2, default=str) + "\n", encoding="utf-8")
    evidence_grade = grade(trial, args.repo)
    external = _check(trial.target.verification_command, args.repo)
    evidence_grade["externalVerification"] = external
    evidence_grade["passed"] = bool(evidence_grade["passed"] and external["exitCode"] == 0)
    result = session.result or {}
    phase = result.get("phaseProgram") or {}
    public = {
        **dry,
        "workflowLabel": trial.workflow_label,
        "taskFamily": trial.task_family,
        "sandboxId": args.sandbox_id,
        "status": (
            "accepted" if session.status == "completed" and evidence_grade["passed"] else "failed"
        ),
        "runStatus": session.status,
        "artifactAccepted": evidence_grade["passed"],
        "grade": evidence_grade,
        "receiptId": canonical_hash(result),
        "controllerTurns": len(result.get("turnIds") or []),
        "modelCompletions": int((result.get("observed") or {}).get("modelCompletions") or 0),
        "checkpoints": phase.get("checkpoints") or [],
        "phaseExecutions": phase.get("executions") or [],
        "verification": result.get("verification") or [],
    }
    args.public_out.parent.mkdir(parents=True, exist_ok=True)
    args.public_out.write_text(json.dumps(public, indent=2) + "\n", encoding="utf-8")
    return public


if __name__ == "__main__":
    print(json.dumps(run(parser().parse_args()), indent=2))
