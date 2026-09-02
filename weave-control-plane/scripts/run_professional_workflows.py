"""Run four small professional workflow acceptance tasks through local WeaveCodex."""

from __future__ import annotations

import argparse
import json
import shutil
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from weave_codex.manifest import HarnessManifest

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "examples/professional-trials"


TRIALS: tuple[dict[str, Any], ...] = (
    {
        "id": "finance-variance",
        "fixture": "finance",
        "name": "CFO variance review",
        "task": (
            "Use the local README, actuals.csv, and budget.csv to create the requested "
            "reconciled Q4 variance analysis and CFO brief. Do not alter the source files."
        ),
        "feedback": (
            "Use a 1,500 absolute materiality threshold. Preserve unknown causes as unknown."
        ),
        "work": (
            (
                "map-workbook",
                "Map the workbook",
                "Inspect the local task and source tables. State the reconciliation logic "
                "and materiality rules before editing anything.",
            ),
            (
                "build-analysis",
                "Build the variance analysis",
                "Create analysis.csv and cfo-brief.md exactly as requested, with "
                "source-preserving calculations and no invented causal claims.",
            ),
        ),
        "command": "python3 check.py",
        "criteria": (
            "The deterministic finance check passed, both source tables remain unchanged, "
            "and the brief distinguishes measured variance from unknown cause."
        ),
    },
    {
        "id": "campaign-poster",
        "fixture": "campaign",
        "name": "Campaign poster production",
        "task": (
            "Use the local campaign brief to create an original accessible SVG poster and "
            "design notes. Keep every fixed fact and use only inline vector artwork."
        ),
        "feedback": (
            "Choose the quiet botanical direction. Keep the supplied palette and make the "
            "event title the clear focal point."
        ),
        "work": (
            (
                "explore-concepts",
                "Explore poster directions",
                "Read the brief and describe three materially different visual routes. "
                "Do not create the final files yet.",
            ),
            (
                "produce-poster",
                "Produce the selected poster",
                "Create poster.svg and design-notes.md using the locked direction, fixed "
                "facts, accessible SVG metadata, and inline artwork only.",
            ),
        ),
        "command": "python3 check.py",
        "criteria": (
            "The deterministic poster check passed, the artwork preserves the chosen "
            "direction, and the notes record palette and provenance."
        ),
    },
    {
        "id": "crm-shortlist",
        "fixture": "crm",
        "name": "CRM selection brief",
        "task": (
            "Use only the local requirements and vendor evidence to create a two-option CRM "
            "shortlist for a 50-person sales team. Do not invent vendor capabilities."
        ),
        "feedback": (
            "Treat every non-negotiable as a hard gate. Prefer operational fit over the "
            "lowest price and keep unresolved questions visible."
        ),
        "work": (
            (
                "build-evidence",
                "Build the evidence matrix",
                "Map each vendor to every hard requirement and weighted preference. "
                "Explicitly exclude vendors that fail a hard gate.",
            ),
            (
                "write-shortlist",
                "Write the migration-aware shortlist",
                "Create shortlist.md with exactly two supported options, requirement "
                "evidence, two open questions, and a 30/60/90-day migration outline.",
            ),
        ),
        "command": "python3 check.py",
        "criteria": (
            "The deterministic CRM check passed and every recommendation is grounded in "
            "the supplied evidence and hard requirements."
        ),
    },
    {
        "id": "renewal-triage",
        "fixture": "customer-ops",
        "name": "Renewal triage plan",
        "task": (
            "Use the local account records and action policy to draft a complete renewal "
            "plan and team note. Do not mutate source records or take external actions."
        ),
        "feedback": (
            "Safety wins over revenue opportunity. Any severity-one conflict must become "
            "escalation_only with no commercial outreach."
        ),
        "work": (
            (
                "map-policy",
                "Map accounts to policy",
                "Inspect every account and map it to the exact matching policy rule. "
                "Surface contradictory signals before drafting actions.",
            ),
            (
                "draft-actions",
                "Draft the renewal actions",
                "Create renewal-plan.csv and team-note.md with one supported action and "
                "cited policy rule for every account.",
            ),
        ),
        "command": "python3 check.py",
        "criteria": (
            "The deterministic operations check passed, every account is covered once, "
            "and no source or external system was mutated."
        ),
    },
)


def trial_manifest(trial: dict[str, Any], cwd: Path) -> dict[str, Any]:
    first, second = trial["work"]
    phases = [
        {
            "id": first[0],
            "kind": "work",
            "scope": "focused",
            "name": first[1],
            "goal": first[2],
            "reasoningEffort": "low",
        },
        {
            "id": "calibrate",
            "kind": "checkpoint",
            "name": "Lock the operating rule",
            "question": "What must remain fixed before producing the deliverable?",
        },
        {
            "id": second[0],
            "kind": "work",
            "scope": "focused",
            "name": second[1],
            "goal": second[2],
            "reasoningEffort": "low",
        },
        {
            "id": "exact-check",
            "kind": "command",
            "stepType": "checker",
            "name": "Run the acceptance check",
            "command": trial["command"],
            "expectedExitCode": 0,
            "stopOnFailure": True,
        },
        {
            "id": "final-review",
            "kind": "verify",
            "name": "Review the deliverable",
            "criteria": trial["criteria"],
            "maxRepairs": 0,
        },
    ]
    edges = [
        {"from": first[0], "to": "calibrate"},
        {"from": "calibrate", "to": second[0]},
        {"from": second[0], "to": "exact-check"},
        {"from": "exact-check", "to": "final-review"},
    ]
    value = {
        "schemaVersion": 2,
        "name": trial["name"],
        "cwd": str(cwd),
        "task": {"instructions": trial["task"], "contextPaths": [str(cwd / "README.md")]},
        "memory": {"mode": "off", "selectedThreadIds": []},
        "integrations": {"inventoryId": None, "requested": []},
        "agent": {
            "model": None,
            "reasoningEffort": "low",
            "sandbox": "workspace-write",
            "approvalGate": "deny",
        },
        "verification": {
            "enabled": False,
            "criteria": "The phase program owns verification.",
            "maxRetries": 0,
        },
        "output": {"format": "text"},
        "observability": {"traceRoot": ".weave-codex/traces"},
        "phaseProgram": {"projectionVersion": 1, "phases": phases, "edges": edges},
    }
    return HarnessManifest.model_validate(value).model_dump(by_alias=True, mode="json")


def request(
    base_url: str, path: str, *, token: str | None = None, body: dict[str, Any] | None = None
) -> dict[str, Any]:
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Content-Type": "application/json"} if body is not None else {}
    if token:
        headers["X-Weave-CSRF"] = token
        headers["Origin"] = base_url
    call = urllib.request.Request(
        f"{base_url}{path}",
        data=data,
        headers=headers,
        method="POST" if body is not None else "GET",
    )
    try:
        with urllib.request.urlopen(call, timeout=30) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as exc:
        raise RuntimeError(exc.read().decode()) from exc


def run_trial(base_url: str, token: str, trial: dict[str, Any], cwd: Path) -> dict[str, Any]:
    started = request(base_url, "/api/runs", token=token, body=trial_manifest(trial, cwd))
    run_id = started["runId"]
    deadline = time.monotonic() + 720
    checkpoint_sent = False
    while time.monotonic() < deadline:
        state = request(base_url, f"/api/runs/{run_id}")
        if state.get("status") == "waitingForApproval" and not checkpoint_sent:
            request(
                base_url,
                f"/api/runs/{run_id}/approval",
                token=token,
                body={"decision": "accept", "feedback": trial["feedback"]},
            )
            checkpoint_sent = True
        if state.get("status") in {"completed", "failed", "stopped"}:
            result = state.get("result") or {}
            return {
                "trialId": trial["id"],
                "runId": run_id,
                "status": state["status"],
                "completionStatus": result.get("completionStatus"),
                "checkpointSent": checkpoint_sent,
                "finalResponse": bool(result.get("finalResponse")),
                "executions": result.get("phaseProgram", {}).get("executions", []),
            }
        time.sleep(1)
    raise TimeoutError(f"trial {trial['id']} exceeded 12 minutes")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://127.0.0.1:8790")
    parser.add_argument("--execute", action="store_true")
    args = parser.parse_args()
    work_root = ROOT / ".weave-codex/professional-trials"
    work_root.mkdir(parents=True, exist_ok=True)
    manifests = []
    for trial in TRIALS:
        manifests.append(trial_manifest(trial, work_root / trial["id"]))
    if not args.execute:
        print(
            json.dumps(
                {
                    "state": "dry-run",
                    "trials": [item["id"] for item in TRIALS],
                    "maximumControllerTurns": 16,
                },
                indent=2,
            )
        )
        return

    session = request(args.base_url, "/api/session")
    token = session["csrfToken"]
    results = []
    for trial in TRIALS:
        workspace = work_root / trial["id"]
        if workspace.exists():
            shutil.rmtree(workspace)
        shutil.copytree(FIXTURES / trial["fixture"], workspace)
        results.append(run_trial(args.base_url, token, trial, workspace))
        print(json.dumps(results[-1], indent=2))
    summary = {
        "runs": results,
        "allRunsTerminal": all(item["status"] == "completed" for item in results),
        "acceptedCount": sum(item["completionStatus"] == "completed" for item in results),
        "failedCheckCount": sum(item["completionStatus"] == "failedCheck" for item in results),
    }
    (work_root / "summary.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
