"""Run three bounded, memory-off repository harnesses through Codex app-server."""

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
from weave_codex.repo_trials import TRIALS, build_trial_manifest, grade_evidence
from weave_codex.runtime import HarnessRunner, RunSession


def parser() -> argparse.ArgumentParser:
    value = argparse.ArgumentParser(description=__doc__)
    value.add_argument("--repos-root", type=Path, required=True)
    value.add_argument("--raw-root", type=Path, required=True)
    value.add_argument("--summary-out", type=Path, required=True)
    value.add_argument("--codex-bin", default=shutil.which("codex") or "codex")
    value.add_argument("--model", default="gpt-5.6-terra")
    value.add_argument("--execute", action="store_true")
    value.add_argument(
        "--regrade-existing",
        action="store_true",
        help="Rebuild the public summary from preserved raw receipts without calling Codex.",
    )
    value.add_argument("--confirm-three-subscription-harnesses", action="store_true")
    return value


def canonical_hash(value: Any) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), default=str).encode()
    return "sha256:" + hashlib.sha256(encoded).hexdigest()


def _run_with_checkpoint(manifest: Any, codex_bin: str, run_id: str) -> RunSession:
    session = RunSession(run_id=run_id)
    worker = threading.Thread(target=HarnessRunner(codex_bin).run, args=(manifest, session))
    worker.start()
    deadline = time.monotonic() + 2_700
    while worker.is_alive() and time.monotonic() < deadline:
        pending = session.pending_approval
        if pending is not None:
            method = str(pending.get("method"))
            session.decide("accept" if method == "harness/checkpoint" else "decline")
        worker.join(timeout=0.5)
    if worker.is_alive():
        raise TimeoutError(f"run {run_id} exceeded 45 minutes")
    return session


def _external_test(trial: Any, repo: Path) -> dict[str, Any]:
    started = time.monotonic()
    completed = subprocess.run(
        list(trial.verification_command),
        cwd=repo,
        capture_output=True,
        text=True,
        timeout=600,
    )
    output = completed.stdout + "\n" + completed.stderr
    return {
        "command": list(trial.verification_command),
        "exitCode": completed.returncode,
        "elapsedSeconds": round(time.monotonic() - started, 3),
        "outputSha256": "sha256:" + hashlib.sha256(output.encode()).hexdigest(),
    }


def _public_receipt(receipt: dict[str, Any] | None) -> dict[str, Any]:
    receipt = receipt or {}
    usage = receipt.get("usageByTurn") if isinstance(receipt.get("usageByTurn"), dict) else {}
    final_usage = next(reversed(usage.values()), {}) if usage else {}
    total = final_usage.get("total") if isinstance(final_usage, dict) else {}
    observed = receipt.get("observed") if isinstance(receipt.get("observed"), dict) else {}
    return {
        "receiptId": canonical_hash(receipt),
        "manifestHash": receipt.get("manifestHash"),
        "controllerTurns": len(receipt.get("turnIds") or []),
        "modelCompletions": int(observed.get("modelCompletions") or 0),
        "completedItemsByType": observed.get("completedItemsByType") or {},
        "tokenUsage": total,
        "completionStatus": receipt.get("completionStatus"),
        "checkpoints": (receipt.get("phaseProgram") or {}).get("checkpoints") or [],
        "phaseExecutions": (receipt.get("phaseProgram") or {}).get("executions") or [],
        "verification": receipt.get("verification") or [],
    }


def run(args: argparse.Namespace) -> dict[str, Any]:
    plans = []
    for trial in TRIALS:
        repo = args.repos_root / trial.directory
        manifest = build_trial_manifest(trial, repo, model=args.model)
        plans.append(
            {
                "trialId": trial.id,
                "repository": trial.repository,
                "cwd": str(repo.resolve()),
                "commit": subprocess.run(
                    ["git", "rev-parse", "HEAD"],
                    cwd=repo,
                    check=True,
                    capture_output=True,
                    text=True,
                ).stdout.strip(),
                "manifestHash": manifest_hash(manifest),
                "maximumControllerTurns": 4,
            }
        )
    if not args.execute and not args.regrade_existing:
        return {"state": "dry-run", "memory": "off", "model": args.model, "plans": plans}
    if args.execute and not args.confirm_three_subscription_harnesses:
        raise SystemExit("--execute requires --confirm-three-subscription-harnesses")

    args.raw_root.mkdir(parents=True, exist_ok=True)
    results = []
    for trial, plan in zip(TRIALS, plans, strict=True):
        repo = args.repos_root / trial.directory
        manifest = build_trial_manifest(trial, repo, model=args.model)
        raw_path = args.raw_root / f"{trial.id}.json"
        if args.regrade_existing:
            raw = json.loads(raw_path.read_text(encoding="utf-8"))
            run_status = str(raw.get("status"))
            receipt = raw.get("result") if isinstance(raw.get("result"), dict) else None
        else:
            session = _run_with_checkpoint(manifest, args.codex_bin, f"sandbox-{trial.id}")
            raw = session.snapshot()
            raw_path.write_text(json.dumps(raw, indent=2, default=str) + "\n", encoding="utf-8")
            run_status = session.status
            receipt = session.result
        grade = grade_evidence(trial, repo)
        external = _external_test(trial, repo)
        grade["externalVerification"] = external
        grade["passed"] = bool(grade["passed"] and external["exitCode"] == 0)
        results.append(
            {
                **plan,
                "title": trial.title,
                "question": trial.question,
                "runStatus": run_status,
                "grade": grade,
                "receipt": _public_receipt(receipt),
            }
        )
        if run_status != "completed":
            break

    summary = {
        "schemaVersion": 1,
        "study": "Runloop repository harness acceptance trials",
        "environment": "isolated Runloop devbox; Codex authenticated through official device flow",
        "model": args.model,
        "memory": "off",
        "design": (
            "Each authored Work phase is one persistent Codex controller turn containing any "
            "number of native reasoning/tool iterations; tool calls are observed, not authored."
        ),
        "results": results,
        "claimLimits": [
            "These are three source-analysis product acceptance trials, not a benchmark.",
            "There is one rollout per repository and no ordinary-Codex comparison arm.",
            "The checkpoint was accepted by the operating agent after the first map phase.",
            "Subscription usage events are not invoice-level cost attribution.",
            "No result implies that the upstream repository has a defect.",
        ],
    }
    summary["summarySha256"] = canonical_hash(summary)
    args.summary_out.parent.mkdir(parents=True, exist_ok=True)
    args.summary_out.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    return summary


def main() -> None:
    args = parser().parse_args()
    print(json.dumps(run(args), indent=2))


if __name__ == "__main__":
    main()
