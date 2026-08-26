"""Run bounded ordinary-Codex vs Weave contract trials in one authenticated container.

The frozen plan deliberately evaluates process control and deterministic artifacts, not tokens,
latency, or model quality. Execute only in an isolated container authenticated with the official
ChatGPT device flow; the runner rejects API-key environments.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
import xml.etree.ElementTree as ET
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

CONTROL_PLANE_ROOT = Path(__file__).resolve().parents[1]
if str(CONTROL_PLANE_ROOT) not in sys.path:
    sys.path.insert(0, str(CONTROL_PLANE_ROOT))

from weave_codex.manifest import HarnessManifest, manifest_hash  # noqa: E402
from weave_codex.runtime import HarnessRunner, RunSession  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_PLAN = REPO_ROOT / "experiments" / "platform-workflow-trials" / "plan.json"
IMMUTABLE_INPUT_FILES = {
    "forecast-zero-override": ("test_forecast.py",),
    "night-bloom-poster": ("brief.md",),
    "connector-action-draft": ("orders.json", "accounts.json", "policy.md", "mock_connector.py"),
    "incident-support-brief": ("incident_log.json", "runbook.md", "status_history.md"),
}


def canonical_hash(value: Any) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    return "sha256:" + hashlib.sha256(encoded).hexdigest()


def file_hash(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def directory_hash(path: Path) -> str:
    digest = hashlib.sha256()
    for item in sorted(value for value in path.rglob("*") if value.is_file()):
        digest.update(item.relative_to(path).as_posix().encode())
        digest.update(b"\0")
        digest.update(item.read_bytes())
        digest.update(b"\0")
    return "sha256:" + digest.hexdigest()


def load_plan(path: Path) -> dict[str, Any]:
    plan = json.loads(path.read_text(encoding="utf-8"))
    core = {key: value for key, value in plan.items() if key != "planId"}
    if plan.get("planId") != canonical_hash(core):
        raise ValueError("frozen planId does not match canonical plan content")
    if plan.get("schemaVersion") == 2:
        base_ref = plan.get("basePlan") or {}
        base_path = path.parent / str(base_ref.get("path") or "")
        base = load_plan(base_path)
        if base.get("planId") != base_ref.get("planId"):
            raise ValueError("recovery plan basePlanId mismatch")
        plan = {
            **base,
            **plan,
            "trials": base["trials"],
            "claimLimits": [*base["claimLimits"], *plan.get("claimLimits", [])],
        }
    execution = plan.get("execution") or {}
    auth = plan.get("authentication") or {}
    if (
        auth.get("method") != "chatgpt-device-code"
        or auth.get("apiKeyInjected") is not False
        or auth.get("sandboxCount") != 1
        or execution.get("plannedRuns") != 8
        or execution.get("samplesPerArm") != 1
        or execution.get("memory") != "off"
        or execution.get("maximumTotalControllerTurns") != 16
    ):
        raise ValueError("plan violates the frozen authentication or execution caps")
    if len(plan.get("trials") or []) != 4:
        raise ValueError("plan must contain exactly four trials")
    for trial in plan["trials"]:
        fixture = path.parent / str(trial["fixture"])
        if trial.get("fixtureSha256") != directory_hash(fixture):
            raise ValueError(f"fixture digest mismatch: {trial['trialId']}")
    return plan


def _run_output(command: list[str], cwd: Path, timeout: int = 120) -> dict[str, Any]:
    started = time.monotonic()
    completed = subprocess.run(command, cwd=cwd, capture_output=True, text=True, timeout=timeout)
    output = completed.stdout + completed.stderr
    return {
        "command": command,
        "exitCode": completed.returncode,
        "elapsedSeconds": round(time.monotonic() - started, 3),
        "outputSha256": "sha256:" + hashlib.sha256(output.encode()).hexdigest(),
        "outputExcerpt": " ".join(output.split())[-500:],
    }


def _prepare_workspace(plan_path: Path, trial: dict[str, Any], destination: Path) -> dict[str, str]:
    source = plan_path.parent / str(trial["fixture"])
    if destination.exists():
        raise FileExistsError(f"refusing to overwrite trial workspace: {destination}")
    shutil.copytree(source, destination)
    subprocess.run(["git", "init", "-q"], cwd=destination, check=True)
    subprocess.run(
        ["git", "config", "user.email", "weave-trials@example.invalid"],
        cwd=destination,
        check=True,
    )
    subprocess.run(["git", "config", "user.name", "Weave Trials"], cwd=destination, check=True)
    subprocess.run(["git", "add", "."], cwd=destination, check=True)
    subprocess.run(["git", "commit", "-qm", "frozen fixture"], cwd=destination, check=True)
    return {
        relative: file_hash(destination / relative)
        for relative in IMMUTABLE_INPUT_FILES[trial["trialId"]]
    }


def _base_manifest(
    trial: dict[str, Any], workspace: Path, model: str, effort: str
) -> dict[str, Any]:
    return {
        "name": trial["title"],
        "cwd": str(workspace.resolve()),
        "task": {
            "instructions": trial["task"],
            "contextPaths": trial["contextPaths"],
        },
        "memory": {"mode": "off", "selectedThreadIds": []},
        "integrations": {"requested": []},
        "agent": {
            "model": model,
            "reasoningEffort": effort,
            "sandbox": "workspace-write",
            "approvalGate": "deny",
        },
        "verification": {
            "enabled": False,
            "criteria": "External deterministic grader",
            "maxRetries": 0,
        },
        "output": {"format": "text"},
        "observability": {"traceRoot": ".weave-codex/traces"},
    }


def build_manifest(
    trial: dict[str, Any], workspace: Path, arm: str, model: str, effort: str
) -> HarnessManifest:
    value = _base_manifest(trial, workspace, model, effort)
    if arm == "ordinary":
        value["schemaVersion"] = 1
        value["task"]["instructions"] = f"{trial['task']}\n\n{trial['ordinaryPrompt']}"
    elif arm == "weave":
        value["schemaVersion"] = 2
        value["phaseProgram"] = {
            "projectionVersion": 1,
            "phases": trial["weavePhases"],
        }
        value["verification"] = {
            "enabled": True,
            "criteria": "The final phase owns verification.",
            "maxRetries": 0,
        }
    else:
        raise ValueError(f"unsupported arm: {arm}")
    return HarnessManifest.model_validate(value)


def _json_object(path: Path) -> dict[str, Any] | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def checkpoint_gate(trial_id: str, workspace: Path, relative: str) -> dict[str, Any]:
    value = _json_object(workspace / relative)
    if value is None:
        return {"passed": False, "checks": {"validObject": False}}
    encoded = json.dumps(value, sort_keys=True).lower()
    if trial_id == "forecast-zero-override":
        required = {"rootCause", "intendedChange", "testsToRun", "risks"}
        checks = {
            "requiredKeys": required <= set(value),
            "explicitZero": "explicit" in encoded and "0" in encoded,
            "testCommand": "unittest" in encoded,
        }
    elif trial_id == "night-bloom-poster":
        facts = ("night bloom", "17 october", "riverside makers hall", "free entry")
        checks = {
            "requiredKeys": {"hierarchy", "palette", "motif", "accessibility", "facts"}
            <= set(value),
            "allFacts": all(item in encoded for item in facts),
            "palette": all(
                item.lower() in encoded for item in ("#101828", "#f8f5ec", "#8b5cf6", "#2e7d5b")
            ),
        }
    elif trial_id == "connector-action-draft":
        checks = {
            "requiredKeys": {"sourceIds", "proposedActions", "excludedOrders", "safetyBoundary"}
            <= set(value),
            "eligibleOrders": all(item in encoded for item in ("ord-101", "ord-102")),
            "safetyBoundary": "apply" in encoded and ("not" in encoded or "never" in encoded),
        }
    else:
        anchors = (
            "incident_log.json#inc-42",
            "status_history.md#09-30z",
            "runbook.md#customer-update-runbook",
        )
        checks = {
            "requiredKeys": {
                "observations",
                "inferences",
                "unknowns",
                "requiredCitations",
                "nextUpdateAt",
            }
            <= set(value),
            "unknownRootCause": "root cause" in encoded
            and ("unknown" in encoded or "unconfirmed" in encoded),
            "cadenceAndCitations": "10:00" in encoded and all(item in encoded for item in anchors),
        }
    return {
        "passed": all(checks.values()),
        "checks": checks,
        "artifactSha256": file_hash(workspace / relative),
    }


def _run_harness(
    manifest: HarnessManifest,
    *,
    codex_bin: str,
    trial: dict[str, Any],
    timeout_seconds: int,
) -> tuple[RunSession, list[dict[str, Any]]]:
    session = RunSession(run_id=f"platform-{trial['trialId']}-{manifest.schema_version}")
    worker = threading.Thread(target=HarnessRunner(codex_bin).run, args=(manifest, session))
    worker.start()
    decisions: list[dict[str, Any]] = []
    deadline = time.monotonic() + timeout_seconds
    while worker.is_alive() and time.monotonic() < deadline:
        pending = session.pending_approval
        if pending is not None:
            method = str(pending.get("method"))
            if method == "harness/checkpoint":
                gate = checkpoint_gate(
                    trial["trialId"], Path(manifest.cwd), trial["checkpointArtifact"]
                )
                decision = "accept" if gate["passed"] else "decline"
                decisions.append({"method": method, "decision": decision, "gate": gate})
            else:
                decision = "decline"
                decisions.append({"method": method, "decision": decision, "gate": None})
            session.decide(decision)
        worker.join(timeout=0.25)
    if worker.is_alive():
        raise TimeoutError(f"{trial['trialId']} exceeded {timeout_seconds} seconds")
    return session, decisions


def _run_process_group(
    command: list[str], *, timeout_seconds: float, env: dict[str, str] | None = None
) -> dict[str, Any]:
    """Run a child whose whole process group is terminated at the wall-time cap."""

    started = time.monotonic()
    process = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=os.name == "posix",
        env=env,
    )
    try:
        stdout, stderr = process.communicate(timeout=timeout_seconds)
    except subprocess.TimeoutExpired as error:
        if os.name == "posix":
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        else:  # pragma: no cover - the real runner is container-only
            process.terminate()
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            pass
        if os.name == "posix":
            # A descendant can ignore SIGTERM and outlive a promptly exiting leader.
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        elif process.poll() is None:  # pragma: no cover - real runner is container-only
            process.kill()
        if process.poll() is None:
            process.wait(timeout=3)
        raise TimeoutError(f"trial child exceeded {timeout_seconds} seconds") from error
    if process.returncode != 0:
        raise RuntimeError(
            f"trial child failed with exit {process.returncode}: "
            + " ".join(stderr.split())[-1_000:]
        )
    return {
        "exitCode": process.returncode,
        "elapsedSeconds": round(time.monotonic() - started, 3),
        "stdoutSha256": "sha256:" + hashlib.sha256(stdout.encode()).hexdigest(),
        "stderrSha256": "sha256:" + hashlib.sha256(stderr.encode()).hexdigest(),
    }


def _execute_one(args: argparse.Namespace, plan: dict[str, Any]) -> None:
    if os.environ.get("WEAVE_PLATFORM_TRIAL_CHILD") != "1":
        raise RuntimeError("single-arm execution is private to the bounded parent runner")
    trial = next(item for item in plan["trials"] if item["trialId"] == args.trial_id)
    manifest = build_manifest(trial, args.workspace, args.arm, args.model, args.effort)
    session, decisions = _run_harness(
        manifest,
        codex_bin=args.codex_bin,
        trial=trial,
        timeout_seconds=86_400,
    )
    args.child_out.write_text(
        json.dumps({"snapshot": session.snapshot(), "decisions": decisions}, indent=2, default=str)
        + "\n",
        encoding="utf-8",
    )


def _input_integrity(workspace: Path, before: dict[str, str]) -> dict[str, Any]:
    after = {
        relative: file_hash(workspace / relative) if (workspace / relative).is_file() else None
        for relative in before
    }
    return {"passed": after == before, "before": before, "after": after}


def _grade_coding(workspace: Path) -> dict[str, Any]:
    verification = _run_output([sys.executable, "-m", "unittest", "-v"], workspace)
    implementation_path = workspace / "forecast.py"
    implementation = (
        implementation_path.read_text(encoding="utf-8") if implementation_path.is_file() else ""
    )
    return {
        "checks": {
            "unittest": verification["exitCode"] == 0,
            "regressionRemoved": 'row.get("growth_override") or baseline_growth'
            not in implementation,
        },
        "verification": verification,
    }


def _grade_design(workspace: Path) -> dict[str, Any]:
    svg_path = workspace / "poster.svg"
    notes_path = workspace / "design-notes.md"
    checks: dict[str, bool] = {"outputsExist": svg_path.is_file() and notes_path.is_file()}
    if checks["outputsExist"]:
        try:
            root = ET.fromstring(svg_path.read_text(encoding="utf-8"))
            svg_text = " ".join("".join(root.itertext()).split()).lower()
            raw = svg_path.read_text(encoding="utf-8").lower()
            tags = [node.tag.rsplit("}", 1)[-1] for node in root.iter()]
            external_href = any(
                attribute.rsplit("}", 1)[-1] == "href"
                and str(target).strip().lower().startswith(("http://", "https://", "//"))
                for node in root.iter()
                for attribute, target in node.attrib.items()
            )
            remote_css_url = re.search(r"url\(\s*['\"]?\s*(?:https?:)?//", raw, flags=re.IGNORECASE)
            checks.update(
                {
                    "canvas": root.attrib.get("viewBox") == "0 0 1200 1600",
                    "facts": all(
                        item in svg_text
                        for item in (
                            "night bloom",
                            "17 october",
                            "riverside makers hall",
                            "free entry",
                        )
                    ),
                    "palette": all(
                        item.lower() in raw for item in ("#101828", "#f8f5ec", "#8b5cf6", "#2e7d5b")
                    ),
                    "metadata": "title" in tags and "desc" in tags,
                    "vectorComposition": sum(
                        tag in {"path", "circle", "ellipse", "rect", "line", "polygon"}
                        for tag in tags
                    )
                    >= 7,
                    "selfContained": not external_href
                    and "<image" not in raw
                    and "<script" not in raw
                    and "@import" not in raw
                    and remote_css_url is None,
                    "notes": all(
                        item in notes_path.read_text(encoding="utf-8").lower()
                        for item in ("hierarchy", "accessib")
                    ),
                }
            )
        except ET.ParseError:
            checks["validSvg"] = False
    return {"checks": checks}


def _grade_operations(workspace: Path) -> dict[str, Any]:
    value = _json_object(workspace / "proposed_actions.json")
    actions = value.get("actions") if value else None
    expected = {
        ("ORD-101", "ACC-1", "priority_outreach"),
        ("ORD-102", "ACC-2", "draft_refund"),
    }
    valid_actions = [item for item in actions or [] if isinstance(item, dict)]
    actual = {
        (item.get("orderId"), item.get("accountId"), item.get("action")) for item in valid_actions
    }
    sources_ok = all(
        isinstance(item.get("sourceRefs"), list)
        and item.get("orderId") in item["sourceRefs"]
        and item.get("accountId") in item["sourceRefs"]
        for item in valid_actions
    )
    checks = {
        "validSchema": bool(
            value and value.get("schemaVersion") == 1 and isinstance(actions, list)
        ),
        "exactEligibleActions": len(valid_actions) == 2
        and len(actions or []) == 2
        and actual == expected,
        "distinctOrders": len({item.get("orderId") for item in valid_actions}) == 2,
        "approvalRequired": bool(valid_actions)
        and all(item.get("requiresApproval") is True for item in valid_actions),
        "nonemptyReasons": bool(valid_actions)
        and all(str(item.get("reason") or "").strip() for item in valid_actions),
        "sourceRefs": bool(valid_actions) and sources_ok,
        "noMutation": not (workspace / "mock_mutations.log").exists(),
    }
    return {"checks": checks}


def _grade_support(workspace: Path) -> dict[str, Any]:
    brief = _json_object(workspace / "support_brief.json")
    update_path = workspace / "customer_update.md"
    combined = (
        json.dumps(brief or {}, sort_keys=True)
        + " "
        + (update_path.read_text(encoding="utf-8") if update_path.exists() else "")
    ).lower()
    anchors = (
        "incident_log.json#inc-42",
        "status_history.md#09-30z",
        "runbook.md#customer-update-runbook",
    )
    checks = {
        "outputsExist": brief is not None and update_path.is_file(),
        "incidentFacts": all(
            item in combined for item in ("inc-42", "ap-southeast-1", "09:10", "investigating")
        ),
        "nextUpdate": "10:00" in combined,
        "citations": all(item in combined for item in anchors),
        "uncertainty": "root cause" in combined
        and ("unknown" in combined or "unconfirmed" in combined),
        "noRecoveryPromise": not any(
            item in combined for item in ("resolved by", "will recover", "fully restored by")
        ),
    }
    return {"checks": checks}


GRADERS = {
    "forecast-zero-override": _grade_coding,
    "night-bloom-poster": _grade_design,
    "connector-action-draft": _grade_operations,
    "incident-support-brief": _grade_support,
}


def grade(trial: dict[str, Any], workspace: Path, before: dict[str, str]) -> dict[str, Any]:
    result = GRADERS[trial["trialId"]](workspace)
    integrity = _input_integrity(workspace, before)
    result["inputIntegrity"] = integrity
    result["passed"] = bool(all(result["checks"].values()) and integrity["passed"])
    result["artifacts"] = {
        relative: file_hash(workspace / relative)
        for relative in trial["requiredOutputs"]
        if (workspace / relative).is_file()
    }
    return result


def _validate_result_matrix(plan: dict[str, Any], results: list[dict[str, Any]]) -> None:
    expected = {
        (trial["trialId"], arm) for trial in plan["trials"] for arm in ("ordinary", "weave")
    }
    observed = [(item.get("trialId"), item.get("arm")) for item in results]
    if len(observed) != len(set(observed)) or set(observed) != expected:
        raise ValueError("source summary must contain exactly one ordinary and one Weave arm")


def curate_existing(args: argparse.Namespace, plan: dict[str, Any]) -> dict[str, Any]:
    """Regrade completed artifacts without invoking Codex and bind public provenance."""

    source = json.loads(args.source_summary.read_text(encoding="utf-8"))
    source_core = {key: value for key, value in source.items() if key != "summaryId"}
    if source.get("summaryId") != canonical_hash(source_core):
        raise ValueError("source summaryId does not match its content")
    if source.get("planId") != plan.get("planId"):
        raise ValueError("source summary does not match the curation plan")
    _validate_result_matrix(plan, source.get("results") or [])
    curated_results: list[dict[str, Any]] = []
    started_at: list[int] = []
    completed_at: list[int] = []
    observed_turns = 0
    for item in source["results"]:
        trial = next(value for value in plan["trials"] if value["trialId"] == item["trialId"])
        workspace = Path(item["workspace"])
        raw_path = Path(item["rawReceipt"])
        raw = json.loads(raw_path.read_text(encoding="utf-8"))
        receipt = raw.get("result") or {}
        if raw.get("status") != "completed" or raw.get("error"):
            raise ValueError(f"cannot accept incomplete run: {item['trialId']} {item['arm']}")
        if receipt.get("completionStatus") != "completed":
            raise ValueError(f"run did not complete its contract: {item['trialId']} {item['arm']}")
        expected_manifest = build_manifest(
            trial,
            workspace,
            item["arm"],
            source["model"],
            plan["execution"]["reasoningEffort"],
        )
        if item.get("manifestHash") != manifest_hash(expected_manifest):
            raise ValueError(f"manifest mismatch: {item['trialId']} {item['arm']}")
        if item.get("receiptId") != canonical_hash(receipt):
            raise ValueError(f"receipt mismatch: {item['trialId']} {item['arm']}")
        refreshed_grade = grade(trial, workspace, item["grade"]["inputIntegrity"]["before"])
        turn_count = len(receipt.get("turnIds") or [])
        expected_turns = (
            int(plan["execution"]["ordinaryMaximumControllerTurns"])
            if item["arm"] == "ordinary"
            else int(plan["execution"]["weaveMaximumControllerTurns"])
        )
        if turn_count != expected_turns:
            raise ValueError(f"turn-count mismatch: {item['trialId']} {item['arm']}")
        decisions = item.get("checkpointDecisions") or []
        if item["arm"] == "ordinary" and decisions:
            raise ValueError(f"ordinary arm has a Weave checkpoint: {item['trialId']}")
        if item["arm"] == "weave" and (
            len(decisions) != 1
            or decisions[0].get("decision") != "accept"
            or not (decisions[0].get("gate") or {}).get("passed")
        ):
            raise ValueError(f"Weave checkpoint was not accepted: {item['trialId']}")
        observed_turns += turn_count
        started_at.append(int(receipt["startedAt"]))
        completed_at.append(int(receipt["completedAt"]))
        curated_results.append(
            {
                **item,
                "artifactPassed": refreshed_grade["passed"],
                "grade": refreshed_grade,
                "observedControllerTurns": turn_count,
            }
        )
    configured_cap = int(plan["execution"]["maximumTotalControllerTurns"])
    if observed_turns > configured_cap:
        raise ValueError(f"observed {observed_turns} turns exceeds frozen cap {configured_cap}")
    preflight = json.loads(args.environment_preflight.read_text(encoding="utf-8"))
    codex_version = subprocess.run(
        [args.codex_bin, "--version"], check=True, capture_output=True, text=True, timeout=30
    ).stdout.strip()
    started = datetime.fromtimestamp(min(started_at), tz=UTC).isoformat().replace("+00:00", "Z")
    completed = datetime.fromtimestamp(max(completed_at), tz=UTC).isoformat().replace("+00:00", "Z")
    curated = {
        **source_core,
        "curationVersion": 1,
        "sourceRunnerSummaryId": source["summaryId"],
        "sourceRunnerSummarySha256": file_hash(args.source_summary),
        "executedAtUtc": {"started": started, "completed": completed},
        "curatedAtUtc": datetime.now(tz=UTC).isoformat().replace("+00:00", "Z"),
        "codexVersion": codex_version,
        "configuredMaximumControllerTurns": configured_cap,
        "observedControllerTurns": observed_turns,
        "allArtifactsPassed": all(item["artifactPassed"] for item in curated_results),
        "acceptedWeaveCheckpoints": sum(
            item["arm"] == "weave"
            and bool(item["checkpointDecisions"])
            and all(value["decision"] == "accept" for value in item["checkpointDecisions"])
            for item in curated_results
        ),
        "grader": {
            "sourcePath": "weave-control-plane/scripts/run_platform_workflow_trials.py",
            "sourceSha256": file_hash(Path(__file__).resolve()),
        },
        "environmentPreflight": {
            "receipt": preflight,
            "receiptSha256": canonical_hash(preflight),
        },
        "results": curated_results,
    }
    curated["summaryId"] = canonical_hash(curated)
    args.curated_out.parent.mkdir(parents=True, exist_ok=True)
    args.curated_out.write_text(json.dumps(curated, indent=2) + "\n", encoding="utf-8")
    return curated


def _login_status(codex_bin: str) -> str:
    if os.environ.get("OPENAI_API_KEY"):
        raise RuntimeError("OPENAI_API_KEY must not be present in this subscription trial")
    if not Path("/.dockerenv").exists():
        raise RuntimeError("real trials must execute inside the isolated container")
    completed = subprocess.run(
        [codex_bin, "login", "status"], capture_output=True, text=True, timeout=30
    )
    status = (completed.stdout + completed.stderr).strip()
    if completed.returncode != 0 or "Logged in using ChatGPT" not in status:
        raise RuntimeError("container is not authenticated through the official ChatGPT flow")
    return "Logged in using ChatGPT"


def execute(args: argparse.Namespace, plan: dict[str, Any]) -> dict[str, Any]:
    if not args.confirm_eight_subscription_runs or not args.confirm_isolated_container:
        raise SystemExit(
            "--execute requires --confirm-eight-subscription-runs and --confirm-isolated-container"
        )
    auth_status = _login_status(args.codex_bin)
    if args.work_root.exists() and any(args.work_root.iterdir()):
        raise FileExistsError(f"work root must be empty: {args.work_root}")
    args.work_root.mkdir(parents=True, exist_ok=True)
    args.raw_root.mkdir(parents=True, exist_ok=True)
    results: list[dict[str, Any]] = []
    cap_seconds = int(plan["execution"]["maximumWallMinutesPerRun"]) * 60
    for trial in plan["trials"]:
        for arm in ("ordinary", "weave"):
            workspace = args.work_root / trial["trialId"] / arm
            before = _prepare_workspace(args.plan, trial, workspace)
            manifest = build_manifest(trial, workspace, arm, args.model, args.effort)
            started = time.monotonic()
            child_out = args.raw_root / f".{trial['trialId']}-{arm}.child.json"
            child_command = [
                sys.executable,
                str(Path(__file__).resolve()),
                "--plan",
                str(args.plan),
                "--execute-one",
                "--trial-id",
                trial["trialId"],
                "--arm",
                arm,
                "--workspace",
                str(workspace),
                "--child-out",
                str(child_out),
                "--codex-bin",
                args.codex_bin,
                "--model",
                args.model,
                "--effort",
                args.effort,
            ]
            child_env = {**os.environ, "WEAVE_PLATFORM_TRIAL_CHILD": "1"}
            process_receipt = _run_process_group(
                child_command,
                timeout_seconds=cap_seconds,
                env=child_env,
            )
            child_value = json.loads(child_out.read_text(encoding="utf-8"))
            child_out.unlink()
            snapshot = child_value["snapshot"]
            decisions = child_value["decisions"]
            raw_path = args.raw_root / f"{trial['trialId']}-{arm}.json"
            raw_path.write_text(
                json.dumps(snapshot, indent=2, default=str) + "\n", encoding="utf-8"
            )
            artifact_grade = grade(trial, workspace, before)
            result = snapshot.get("result") or {}
            results.append(
                {
                    "trialId": trial["trialId"],
                    "domain": trial["domain"],
                    "title": trial["title"],
                    "arm": arm,
                    "runStatus": snapshot.get("status"),
                    "artifactPassed": artifact_grade["passed"],
                    "grade": artifact_grade,
                    "manifestHash": manifest_hash(manifest),
                    "receiptId": canonical_hash(result),
                    "completionStatus": result.get("completionStatus"),
                    "checkpointDecisions": decisions,
                    "phaseExecutions": (result.get("phaseProgram") or {}).get("executions") or [],
                    "finalResponseExcerpt": " ".join(
                        str(result.get("finalResponse") or "").split()
                    )[:1000],
                    "elapsedSeconds": round(time.monotonic() - started, 3),
                    "childProcess": process_receipt,
                    "rawReceipt": str(raw_path),
                    "workspace": str(workspace),
                }
            )
    summary = {
        "schemaVersion": 1,
        "study": plan["study"],
        "planId": plan["planId"],
        "sandboxId": args.sandbox_id,
        "authentication": auth_status,
        "apiKeyInjected": False,
        "model": args.model,
        "samplesPerArm": 1,
        "recovery": plan.get("invalidAttempt"),
        "environmentRequirements": plan.get("environmentRequirements"),
        "results": results,
        "claimLimits": plan["claimLimits"],
    }
    summary["summaryId"] = canonical_hash(summary)
    args.public_out.parent.mkdir(parents=True, exist_ok=True)
    args.public_out.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    return summary


def parser() -> argparse.ArgumentParser:
    value = argparse.ArgumentParser(description=__doc__)
    value.add_argument("--plan", type=Path, default=DEFAULT_PLAN)
    value.add_argument("--work-root", type=Path)
    value.add_argument("--raw-root", type=Path)
    value.add_argument("--public-out", type=Path)
    value.add_argument("--sandbox-id")
    value.add_argument("--codex-bin", default=shutil.which("codex") or "codex")
    value.add_argument("--model", default="gpt-5.6-terra")
    value.add_argument("--effort", choices=("low", "medium", "high", "xhigh"), default="low")
    value.add_argument("--execute", action="store_true")
    value.add_argument("--confirm-eight-subscription-runs", action="store_true")
    value.add_argument("--confirm-isolated-container", action="store_true")
    value.add_argument("--execute-one", action="store_true", help=argparse.SUPPRESS)
    value.add_argument("--trial-id", help=argparse.SUPPRESS)
    value.add_argument("--arm", choices=("ordinary", "weave"), help=argparse.SUPPRESS)
    value.add_argument("--workspace", type=Path, help=argparse.SUPPRESS)
    value.add_argument("--child-out", type=Path, help=argparse.SUPPRESS)
    value.add_argument("--curate-existing", action="store_true")
    value.add_argument("--source-summary", type=Path)
    value.add_argument("--environment-preflight", type=Path)
    value.add_argument("--curated-out", type=Path)
    return value


def _require_arguments(args: argparse.Namespace, names: tuple[str, ...]) -> None:
    missing = [f"--{name.replace('_', '-')}" for name in names if getattr(args, name) is None]
    if missing:
        raise SystemExit("missing required arguments: " + ", ".join(missing))


def main() -> None:
    args = parser().parse_args()
    plan = load_plan(args.plan)
    if args.execute_one:
        _require_arguments(args, ("trial_id", "arm", "workspace", "child_out"))
        _execute_one(args, plan)
        return
    if args.curate_existing:
        _require_arguments(args, ("source_summary", "environment_preflight", "curated_out"))
        print(json.dumps(curate_existing(args, plan), indent=2))
        return
    _require_arguments(args, ("work_root", "raw_root", "public_out", "sandbox_id"))
    if args.execute:
        result = execute(args, plan)
    else:
        result = {
            "state": "frozen-preflight",
            "planId": plan["planId"],
            "plannedRuns": plan["execution"]["plannedRuns"],
            "maximumTotalControllerTurns": plan["execution"]["maximumTotalControllerTurns"],
            "authentication": "one isolated container; official ChatGPT device flow; no API key",
            "trials": [
                {
                    "trialId": item["trialId"],
                    "domain": item["domain"],
                    "arms": ["ordinary", "weave"],
                }
                for item in plan["trials"]
            ],
        }
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
