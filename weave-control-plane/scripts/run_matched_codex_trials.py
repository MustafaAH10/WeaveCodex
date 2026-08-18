"""Run three bounded ordinary-Codex versus WeaveCodex product trials."""

import argparse
import json
import shutil
import time
import uuid
from pathlib import Path
from typing import Any

from weave_codex.matched_trials import (
    TASKS,
    canonical_json,
    event_counts,
    fixture_digest,
    grade_task,
    materialize_task,
    ordinary_prompt,
    sha256_json,
    weave_manifest,
    workspace_digest,
)
from weave_codex.runtime import HarnessRunner, RunSession, SdkGateway


def parser() -> argparse.ArgumentParser:
    value = argparse.ArgumentParser(description=__doc__)
    value.add_argument("--codex-bin", default=shutil.which("codex") or "codex")
    value.add_argument("--model", default="gpt-5.6-terra")
    value.add_argument(
        "--work-root",
        type=Path,
        default=Path(".weave-codex/matched-trials-v1"),
    )
    value.add_argument(
        "--summary-out",
        type=Path,
        default=Path("weave_codex/static/matched-trials.json"),
    )
    value.add_argument("--execute", action="store_true")
    value.add_argument("--confirm-six-codex-runs", action="store_true")
    value.add_argument(
        "--regrade-existing",
        action="store_true",
        help="Rebuild the public summary from preserved raw receipts without calling Codex.",
    )
    return value


def _ordinary_run(task: Any, workspace: Path, codex_bin: str, model: str) -> dict[str, Any]:
    events: list[dict[str, Any]] = []
    trace_root = workspace / ".weave-codex" / "traces"
    gateway = SdkGateway(codex_bin, str(trace_root), lambda *_: {"decision": "decline"})
    started = int(time.time())
    try:
        gateway.start()
        thread_id = gateway.start_thread(
            {
                "cwd": str(workspace.resolve()),
                "approvalPolicy": "never",
                "approvalsReviewer": "user",
                "sandbox": "workspace-write",
                "serviceName": "weave_codex_matched_trial_ordinary",
                "experimentalRawEvents": True,
                "model": model,
                "config": {"memories": {"use_memories": False, "generate_memories": False}},
            }
        )
        gateway.set_memory_mode(thread_id, "disabled")
        outcome = gateway.run_turn(
            thread_id,
            ordinary_prompt(task),
            effort="low",
            output_schema=None,
            event_sink=lambda event: events.append({**event, "phase": "ordinary-codex"}),
        )
        return {
            "status": outcome.status,
            "threadId": thread_id,
            "turnIds": [outcome.turn_id],
            "startedAt": started,
            "completedAt": int(time.time()),
            "usageByTurn": {outcome.turn_id: outcome.usage} if outcome.usage else {},
            "observed": event_counts(events),
            "integrations": {
                "bindingMode": "none",
                "requested": [],
                "observedToolItems": [],
            },
            "finalResponseSha256": sha256_json(outcome.final_response),
            "events": events,
        }
    finally:
        gateway.close()


def _weave_run(task: Any, workspace: Path, codex_bin: str, model: str) -> dict[str, Any]:
    session = RunSession(run_id=f"matched-{task.id}-{uuid.uuid4().hex[:12]}")
    HarnessRunner(codex_bin).run(weave_manifest(task, workspace, model), session)
    return {
        "status": session.status,
        "error": session.error,
        "receipt": session.result,
        "events": session.events,
    }


def _public_arm(arm: str, raw: dict[str, Any], workspace: Path, grade: dict[str, Any]) -> dict:
    receipt = raw.get("receipt") if arm == "weave" else raw
    receipt = receipt if isinstance(receipt, dict) else {}
    observed = receipt.get("observed") if isinstance(receipt.get("observed"), dict) else {}
    turn_ids = receipt.get("turnIds") if isinstance(receipt.get("turnIds"), list) else []
    integrations = (
        receipt.get("integrations") if isinstance(receipt.get("integrations"), dict) else {}
    )
    usage_by_turn = (
        receipt.get("usageByTurn") if isinstance(receipt.get("usageByTurn"), dict) else {}
    )
    last_usage = next(reversed(usage_by_turn.values()), {}) if usage_by_turn else {}
    total_usage = last_usage.get("total") if isinstance(last_usage, dict) else {}
    total_usage = total_usage if isinstance(total_usage, dict) else {}
    started_at = int(receipt.get("startedAt") or 0)
    completed_at = int(receipt.get("completedAt") or 0)
    return {
        "arm": "WeaveCodex" if arm == "weave" else "Ordinary Codex",
        "runStatus": raw.get("status"),
        "artifact": grade,
        "controllerTurns": len(turn_ids),
        "modelCompletions": int(observed.get("modelCompletions") or 0),
        "tokenUsage": {
            "inputTokens": int(total_usage.get("inputTokens") or 0),
            "cachedInputTokens": int(total_usage.get("cachedInputTokens") or 0),
            "outputTokens": int(total_usage.get("outputTokens") or 0),
            "reasoningOutputTokens": int(total_usage.get("reasoningOutputTokens") or 0),
        },
        "elapsedSeconds": max(0, completed_at - started_at),
        "startedAt": started_at,
        "completedAt": completed_at,
        "completedItemsByType": observed.get("completedItemsByType") or {},
        "requestedIntegrations": integrations.get("requested") or [],
        "observedIntegrationToolItems": integrations.get("observedToolItems") or [],
        "workspaceDigest": workspace_digest(workspace),
        "receiptId": sha256_json(receipt),
    }


def run_study(args: argparse.Namespace) -> dict[str, Any]:
    if not args.execute and not args.regrade_existing:
        return {
            "state": "dry-run",
            "tasks": [task.id for task in TASKS],
            "plannedExecutions": len(TASKS) * 2,
            "ordinaryControllerTurnCeiling": len(TASKS),
            "weaveControllerTurnCeiling": len(TASKS) * 3,
            "memory": "off",
            "model": args.model,
        }
    if args.execute and not args.confirm_six_codex_runs:
        raise SystemExit("--execute requires --confirm-six-codex-runs")

    args.work_root.mkdir(parents=True, exist_ok=True)
    order = {
        "finance-variance": ("ordinary", "weave"),
        "codex-app-server-contract": ("weave", "ordinary"),
        "accessible-confirmation": ("ordinary", "weave"),
    }
    results: list[dict[str, Any]] = []
    for task in TASKS:
        task_results: dict[str, Any] = {}
        starting_digests: dict[str, str] = {}
        for arm in order[task.id]:
            workspace = args.work_root / task.id / arm
            raw_path = args.work_root / task.id / f"{arm}-raw.json"
            if args.regrade_existing:
                if not raw_path.is_file() or not workspace.is_dir():
                    raise RuntimeError(f"missing preserved evidence for {task.id}/{arm}")
                raw = json.loads(raw_path.read_text(encoding="utf-8"))
                starting_digests[arm] = fixture_digest(task)
            else:
                materialize_task(task, workspace)
                starting_digests[arm] = workspace_digest(workspace)
                raw = (
                    _ordinary_run(task, workspace, args.codex_bin, args.model)
                    if arm == "ordinary"
                    else _weave_run(task, workspace, args.codex_bin, args.model)
                )
                raw_path.write_text(json.dumps(raw, indent=2, default=str) + "\n", encoding="utf-8")
            task_results[arm] = _public_arm(arm, raw, workspace, grade_task(task, workspace))
        if len(set(starting_digests.values())) != 1:
            raise RuntimeError(f"starting fixture drift for {task.id}")
        results.append(
            {
                "taskId": task.id,
                "title": task.title,
                "domain": task.domain,
                "executionOrder": list(order[task.id]),
                "startingWorkspaceDigest": next(iter(starting_digests.values())),
                "integrationTreatment": {
                    "kind": task.integration_kind,
                    "id": task.integration_id,
                    "label": task.integration_label,
                    "phaseIds": list(task.integration_phase_ids),
                },
                "ordinary": task_results["ordinary"],
                "weave": task_results["weave"],
            }
        )

    all_arms = [result[key] for result in results for key in ("ordinary", "weave")]
    summary = {
        "schemaVersion": 1,
        "studyId": sha256_json(
            {
                "tasks": [task.id for task in TASKS],
                "model": args.model,
                "orders": order,
                "memory": "off",
            }
        ),
        "createdAt": max(arm["completedAt"] for arm in all_arms),
        "model": args.model,
        "memory": "off",
        "design": {
            "ordinary": "one normal Codex controller turn",
            "weave": "inspect work turn → produce work turn → structured verification turn",
            "same": ["task fixture", "model", "reasoning effort", "sandbox", "memory mode"],
            "different": ["phase program", "explicit integration request", "turn ceiling"],
            "order": "alternated by task; one rollout per arm",
        },
        "aggregate": {
            "tasks": len(results),
            "executions": len(all_arms),
            "ordinaryArtifactsPassed": sum(
                result["ordinary"]["artifact"]["passed"] for result in results
            ),
            "weaveArtifactsPassed": sum(
                result["weave"]["artifact"]["passed"] for result in results
            ),
            "ordinaryControllerTurns": sum(
                result["ordinary"]["controllerTurns"] for result in results
            ),
            "weaveControllerTurns": sum(result["weave"]["controllerTurns"] for result in results),
            "ordinaryModelCompletions": sum(
                result["ordinary"]["modelCompletions"] for result in results
            ),
            "weaveModelCompletions": sum(result["weave"]["modelCompletions"] for result in results),
            "ordinaryInputTokens": sum(
                result["ordinary"]["tokenUsage"]["inputTokens"] for result in results
            ),
            "weaveInputTokens": sum(
                result["weave"]["tokenUsage"]["inputTokens"] for result in results
            ),
            "ordinaryOutputTokens": sum(
                result["ordinary"]["tokenUsage"]["outputTokens"] for result in results
            ),
            "weaveOutputTokens": sum(
                result["weave"]["tokenUsage"]["outputTokens"] for result in results
            ),
        },
        "results": results,
        "claimLimits": [
            "Three local product-acceptance fixtures are not a benchmark.",
            "One rollout per arm cannot establish a quality advantage.",
            "Weave receives more controller turns; compute is not matched.",
            "Integration requests are instructional, not a hard tool allowlist.",
            (
                "Skill loading is not observable; only completed MCP/dynamic tool items count as "
                "observed use."
            ),
            "Subscription execution exposes usage events, not invoice-level cost attribution.",
        ],
    }
    summary["summarySha256"] = sha256_json(summary)
    return summary


def main() -> None:
    args = parser().parse_args()
    summary = run_study(args)
    print(canonical_json(summary))
    if args.execute or args.regrade_existing:
        args.summary_out.parent.mkdir(parents=True, exist_ok=True)
        args.summary_out.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
