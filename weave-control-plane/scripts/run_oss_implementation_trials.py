"""Run matched ordinary-Codex and WeaveCodex repairs on three pinned OSS repos."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import threading
import time
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from weave_codex.oss_implementation_trials import (
    TASKS,
    OssImplementationTask,
    canonical_json,
    format_command,
    materialize_seeded_repository,
    ordinary_prompt,
    seed_digest,
    sha256_json,
    tracked_changes,
    weave_manifest,
)
from weave_codex.runtime import HarnessRunner, RunSession, SdkGateway

ORDER = {
    "jinja-autoescape-case": ("ordinary", "weave"),
    "starlette-header-invariants": ("weave", "ordinary"),
    "commander-option-identity": ("ordinary", "weave"),
}


def parser() -> argparse.ArgumentParser:
    value = argparse.ArgumentParser(description=__doc__)
    value.add_argument("--sources-root", type=Path, required=True)
    value.add_argument("--work-root", type=Path, required=True)
    value.add_argument("--raw-root", type=Path, required=True)
    value.add_argument("--plan", type=Path, required=True)
    value.add_argument("--summary-out", type=Path, required=True)
    value.add_argument("--codex-bin", default=shutil.which("codex") or "codex")
    value.add_argument("--model", default="gpt-5.6-terra")
    value.add_argument(
        "--starlette-python",
        default="/home/user/weave-lab/matched-oss-v2/venvs/starlette/bin/python",
    )
    value.add_argument("--freeze-plan", action="store_true")
    value.add_argument("--execute", action="store_true")
    value.add_argument("--regrade-existing", action="store_true")
    value.add_argument("--confirm-six-subscription-runs", action="store_true")
    return value


def _sha256_text(value: str) -> str:
    return "sha256:" + hashlib.sha256(value.encode()).hexdigest()


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=repo, check=True, capture_output=True, text=True
    ).stdout.strip()


def _plan_core(args: argparse.Namespace) -> dict[str, Any]:
    codex_version = subprocess.run(
        [args.codex_bin, "--version"], check=True, capture_output=True, text=True
    ).stdout.strip()
    tasks = []
    for task in TASKS:
        source = args.sources_root / task.directory
        actual_commit = _git(source, "rev-parse", "HEAD")
        if actual_commit != task.commit:
            raise ValueError(f"source commit mismatch for {task.id}: {actual_commit}")
        upstream = format_command(task.upstream_test, starlette_python=args.starlette_python)
        hidden = format_command(task.hidden_test, starlette_python=args.starlette_python)
        tasks.append(
            {
                "taskId": task.id,
                "title": task.title,
                "repository": task.repository,
                "commit": task.commit,
                "seedDefinitionId": seed_digest(task),
                "instructionsSha256": _sha256_text(task.instructions),
                "contextPaths": list(task.context_paths),
                "targetPaths": list(task.target_paths),
                "upstreamTest": list(upstream),
                "hiddenTestSha256": sha256_json(list(hidden)),
                "weaveProgram": list(task.phases),
                "order": list(ORDER[task.id]),
            }
        )
    return {
        "schemaVersion": 1,
        "study": "Matched OSS implementation acceptance trials",
        "model": args.model,
        "codexRuntime": {"binary": str(Path(args.codex_bin).resolve()), "version": codex_version},
        "reasoningEffort": "low",
        "memory": "off",
        "sandbox": "workspace-write",
        "approvalPolicy": "never",
        "ordinaryProgram": "one persistent Codex controller turn",
        "tasks": tasks,
        "plannedRuns": 6,
        "ordering": "alternated by task",
    }


def freeze_plan(args: argparse.Namespace) -> dict[str, Any]:
    core = _plan_core(args)
    value = {
        **core,
        "frozenAtUtc": datetime.now(UTC).isoformat(),
        "planId": sha256_json(core),
    }
    args.plan.parent.mkdir(parents=True, exist_ok=True)
    args.plan.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
    return value


def verify_plan(args: argparse.Namespace) -> dict[str, Any]:
    value = json.loads(args.plan.read_text(encoding="utf-8"))
    core = {key: item for key, item in value.items() if key not in {"frozenAtUtc", "planId"}}
    if value.get("planId") != sha256_json(core):
        raise ValueError("frozen plan content ID mismatch")
    if core != _plan_core(args):
        raise ValueError("runtime inputs do not match the frozen plan")
    return value


def _run_command(command: tuple[str, ...], cwd: Path, *, timeout: int = 600) -> dict[str, Any]:
    completed = subprocess.run(
        list(command), cwd=cwd, capture_output=True, text=True, timeout=timeout
    )
    output = completed.stdout + "\n" + completed.stderr
    return {
        "command": list(command),
        "exitCode": completed.returncode,
        "outputSha256": _sha256_text(output),
    }


def _event_counts(events: list[dict[str, Any]]) -> dict[str, Any]:
    completed: dict[str, int] = {}
    for event in events:
        if event.get("method") != "item/completed":
            continue
        params = event.get("params") if isinstance(event.get("params"), dict) else {}
        item = params.get("item") if isinstance(params.get("item"), dict) else {}
        kind = str(item.get("type") or "unknown")
        completed[kind] = completed.get(kind, 0) + 1
    return {
        "modelCompletions": sum(event.get("method") == "rawResponse/completed" for event in events),
        "completedItemsByType": dict(sorted(completed.items())),
    }


def _ordinary_run(
    task: OssImplementationTask,
    workspace: Path,
    *,
    codex_bin: str,
    model: str,
    test_command: tuple[str, ...],
) -> dict[str, Any]:
    events: list[dict[str, Any]] = []
    gateway = SdkGateway(
        codex_bin,
        str(workspace / ".weave-codex" / "traces"),
        lambda *_: {"decision": "decline"},
    )
    started = int(time.time())
    try:
        gateway.start()
        thread_id = gateway.start_thread(
            {
                "cwd": str(workspace.resolve()),
                "approvalPolicy": "never",
                "approvalsReviewer": "user",
                "sandbox": "workspace-write",
                "serviceName": "weave_codex_oss_trial_ordinary",
                "experimentalRawEvents": True,
                "model": model,
                "config": {"memories": {"use_memories": False, "generate_memories": False}},
            }
        )
        gateway.set_memory_mode(thread_id, "disabled")
        turn = gateway.run_turn(
            thread_id,
            ordinary_prompt(task, test_command),
            effort="low",
            output_schema=None,
            event_sink=lambda event: events.append({**event, "phase": "ordinary-codex"}),
        )
        return {
            "status": turn.status,
            "startedAt": started,
            "completedAt": int(time.time()),
            "threadId": thread_id,
            "turnIds": [turn.turn_id],
            "usageByTurn": {turn.turn_id: turn.usage} if turn.usage else {},
            "observed": _event_counts(events),
            "finalResponseSha256": _sha256_text(turn.final_response),
            "events": events,
        }
    finally:
        gateway.close()


def _weave_run(
    task: OssImplementationTask,
    workspace: Path,
    *,
    codex_bin: str,
    model: str,
    test_command: tuple[str, ...],
) -> dict[str, Any]:
    manifest = weave_manifest(task, workspace, model=model, test_command=test_command)
    session = RunSession(run_id=f"oss-{task.id}-{uuid.uuid4().hex[:10]}")
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
        raise TimeoutError(f"Weave run exceeded 45 minutes: {task.id}")
    return session.snapshot()


def _usage(receipt: dict[str, Any]) -> dict[str, int]:
    usage = receipt.get("usageByTurn") if isinstance(receipt.get("usageByTurn"), dict) else {}
    totals = next(reversed(usage.values()), {}).get("total", {}) if usage else {}
    return {
        "inputTokens": int(totals.get("inputTokens") or 0),
        "cachedInputTokens": int(totals.get("cachedInputTokens") or 0),
        "outputTokens": int(totals.get("outputTokens") or 0),
        "reasoningOutputTokens": int(totals.get("reasoningOutputTokens") or 0),
    }


def _public_arm(
    arm: str,
    raw: dict[str, Any],
    workspace: Path,
    task: OssImplementationTask,
    upstream: dict[str, Any],
    hidden: dict[str, Any],
) -> dict[str, Any]:
    receipt = raw.get("result") if arm == "weave" else raw
    receipt = receipt if isinstance(receipt, dict) else {}
    changed = tracked_changes(workspace)
    allowed = all(path in task.target_paths for path in changed)
    observed = receipt.get("observed") if isinstance(receipt.get("observed"), dict) else {}
    phase = receipt.get("phaseProgram") if isinstance(receipt.get("phaseProgram"), dict) else {}
    passed = upstream["exitCode"] == 0 and hidden["exitCode"] == 0 and allowed
    diff = _git(workspace, "diff", "--binary")
    return {
        "arm": "WeaveCodex" if arm == "weave" else "Ordinary Codex",
        "runStatus": raw.get("status"),
        "artifactAccepted": passed,
        "upstreamTest": upstream,
        "independentTest": hidden,
        "changedTrackedPaths": changed,
        "targetOnly": allowed,
        "finalDiffSha256": _sha256_text(diff),
        "receiptId": sha256_json(receipt),
        "controllerTurns": len(receipt.get("turnIds") or []),
        "modelCompletions": int(observed.get("modelCompletions") or 0),
        "completedItemsByType": observed.get("completedItemsByType") or {},
        "tokenUsage": _usage(receipt),
        "completionStatus": receipt.get("completionStatus") or raw.get("status"),
        "checkpoints": phase.get("checkpoints") or [],
        "phaseExecutions": phase.get("executions") or [],
        "verification": receipt.get("verification") or [],
    }


def run(args: argparse.Namespace) -> dict[str, Any]:
    if args.freeze_plan:
        return freeze_plan(args)
    plan = verify_plan(args)
    if not args.execute and not args.regrade_existing:
        return {"state": "dry-run", "planId": plan["planId"], "plannedRuns": 6}
    if args.execute and not args.confirm_six_subscription_runs:
        raise SystemExit("--execute requires --confirm-six-subscription-runs")

    args.raw_root.mkdir(parents=True, exist_ok=True)
    results: list[dict[str, Any]] = []
    for task in TASKS:
        test_command = format_command(task.upstream_test, starlette_python=args.starlette_python)
        hidden_command = format_command(task.hidden_test, starlette_python=args.starlette_python)
        arms: dict[str, Any] = {}
        starts: dict[str, str] = {}
        for arm in ORDER[task.id]:
            source = args.sources_root / task.directory
            workspace = args.work_root / task.id / arm
            raw_path = args.raw_root / task.id / f"{arm}.json"
            if args.regrade_existing:
                raw = json.loads(raw_path.read_text(encoding="utf-8"))
                seed_patch = str(raw["seedPatchSha256"])
                baseline = raw["baseline"]
            else:
                seed_patch = materialize_seeded_repository(task, source, workspace)
                baseline_upstream = _run_command(test_command, workspace)
                baseline_hidden = _run_command(hidden_command, workspace)
                baseline = {"upstream": baseline_upstream, "independent": baseline_hidden}
                if baseline_upstream["exitCode"] == 0 and baseline_hidden["exitCode"] == 0:
                    raise RuntimeError(f"seeded regression did not fail for {task.id}/{arm}")
                raw = (
                    _ordinary_run(
                        task,
                        workspace,
                        codex_bin=args.codex_bin,
                        model=args.model,
                        test_command=test_command,
                    )
                    if arm == "ordinary"
                    else _weave_run(
                        task,
                        workspace,
                        codex_bin=args.codex_bin,
                        model=args.model,
                        test_command=test_command,
                    )
                )
                raw = {**raw, "seedPatchSha256": seed_patch, "baseline": baseline}
                raw_path.parent.mkdir(parents=True, exist_ok=True)
                raw_path.write_text(json.dumps(raw, indent=2, default=str) + "\n", encoding="utf-8")
            starts[arm] = seed_patch
            upstream = _run_command(test_command, workspace)
            hidden = _run_command(hidden_command, workspace)
            arms[arm] = _public_arm(arm, raw, workspace, task, upstream, hidden)
        if len(set(starts.values())) != 1:
            raise RuntimeError(f"starting seed patch drift for {task.id}")
        results.append(
            {
                "taskId": task.id,
                "title": task.title,
                "repository": task.repository,
                "commit": task.commit,
                "seedPatchSha256": next(iter(starts.values())),
                "executionOrder": list(ORDER[task.id]),
                "weaveProgram": [
                    {"id": phase["id"], "kind": phase["kind"], "name": phase["name"]}
                    for phase in task.phases
                ],
                "ordinary": arms["ordinary"],
                "weave": arms["weave"],
            }
        )

    all_arms = [result[arm] for result in results for arm in ("ordinary", "weave")]
    summary = {
        "schemaVersion": 1,
        "study": "Matched OSS implementation acceptance trials",
        "planId": plan["planId"],
        "model": args.model,
        "memory": "off",
        "environment": "isolated Runloop devbox using the user's official Codex sign-in",
        "design": {
            "same": [
                "seeded starting repository",
                "task prompt",
                "model and reasoning effort",
                "workspace-write sandbox",
                "memory disabled",
                "external tests",
            ],
            "ordinary": "one normal Codex controller turn",
            "weave": "a task-specific human-authored phase program with visible receipts",
            "different": ["controller-turn program", "checkpoint placement", "turn ceiling"],
            "order": "alternated by repository; one rollout per arm",
        },
        "aggregate": {
            "repositories": len(results),
            "runs": len(all_arms),
            "ordinaryAccepted": sum(result["ordinary"]["artifactAccepted"] for result in results),
            "weaveAccepted": sum(result["weave"]["artifactAccepted"] for result in results),
            "ordinaryControllerTurns": sum(
                result["ordinary"]["controllerTurns"] for result in results
            ),
            "weaveControllerTurns": sum(result["weave"]["controllerTurns"] for result in results),
            "ordinaryModelCompletions": sum(
                result["ordinary"]["modelCompletions"] for result in results
            ),
            "weaveModelCompletions": sum(result["weave"]["modelCompletions"] for result in results),
        },
        "results": results,
        "claimLimits": [
            "These are seeded regressions, not defects found in the upstream repositories.",
            "Three one-rollout product probes are not a benchmark or a quality estimate.",
            "Weave receives more controller turns, so compute is intentionally not matched.",
            "A checkpoint was accepted by the operating agent after inspecting the pending phase.",
            "Memory was disabled in every arm.",
            "Subscription telemetry is not invoice-level cost attribution.",
        ],
    }
    summary["summarySha256"] = sha256_json(summary)
    args.summary_out.parent.mkdir(parents=True, exist_ok=True)
    args.summary_out.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    return summary


def main() -> None:
    args = parser().parse_args()
    print(canonical_json(run(args)))


if __name__ == "__main__":
    main()
