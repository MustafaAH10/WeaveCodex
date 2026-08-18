"""Small, deterministic fixtures for ordinary Codex versus WeaveCodex trials."""

import hashlib
import json
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from .manifest import HarnessManifest


@dataclass(frozen=True)
class TrialTask:
    id: str
    title: str
    domain: str
    instructions: str
    files: dict[str, str]
    integration_kind: Literal["skill", "mcp", "app"]
    integration_id: str
    integration_label: str
    integration_phase_ids: tuple[str, ...]


TASKS = (
    TrialTask(
        id="finance-variance",
        title="Explain a regional margin variance",
        domain="finance",
        instructions=(
            "Inspect data/regions.csv and create result.json. The JSON must contain numeric "
            "total_revenue, total_cost, gross_profit, gross_margin (rounded to 4 decimals), "
            "weakest_region, and weakest_region_margin (rounded to 4 decimals). Do not change "
            "the source CSV. Validate the arithmetic before finishing."
        ),
        files={
            "data/regions.csv": (
                "region,revenue,cost\nAPAC,400,260\nEMEA,300,250\nNorth America,500,350\n"
            )
        },
        integration_kind="skill",
        integration_id="spreadsheets:Spreadsheets",
        integration_label="Spreadsheets",
        integration_phase_ids=("inspect", "produce"),
    ),
    TrialTask(
        id="codex-app-server-contract",
        title="Specify a Codex app-server client contract",
        domain="developer-platform",
        instructions=(
            "Use the official OpenAI developer documentation and create architecture.json for "
            "a local Codex app-server client. The JSON must contain auth_status_endpoint, "
            "thread_start_endpoint, turn_start_endpoint, and auth_owner. Use the exact endpoint "
            "names account/read, thread/start, and turn/start. Set auth_owner to codex-app-server. "
            "Also include a non-empty official_source URL. Do not create any other file."
        ),
        files={
            "README.md": (
                "# Client contract\n\n"
                "The result must be grounded in current official OpenAI docs.\n"
            )
        },
        integration_kind="mcp",
        integration_id="openaiDeveloperDocs",
        integration_label="OpenAI developer docs",
        integration_phase_ids=("inspect",),
    ),
    TrialTask(
        id="accessible-confirmation",
        title="Repair an inaccessible confirmation dialog",
        domain="frontend",
        instructions=(
            "Inspect index.html and repair the confirmation interaction in place. Keep the visible "
            "wording. The open button must declare aria-haspopup=dialog and point to the dialog "
            "with aria-controls. The dialog must have role=dialog, aria-modal=true, and an "
            "aria-labelledby reference to its heading. Preserve the existing element IDs and do "
            "not add dependencies."
        ),
        files={
            "index.html": (
                "<!doctype html>\n"
                "<html lang=\"en\"><body>\n"
                "  <button id=\"open-confirmation\">Delete project</button>\n"
                "  <section id=\"confirmation-dialog\">\n"
                "    <h2 id=\"confirmation-title\">Delete project?</h2>\n"
                "    <button id=\"confirm-delete\">Delete</button>\n"
                "  </section>\n"
                "</body></html>\n"
            )
        },
        integration_kind="skill",
        integration_id="code-review",
        integration_label="Code review",
        integration_phase_ids=("inspect", "produce"),
    ),
)


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sha256_json(value: Any) -> str:
    return "sha256:" + hashlib.sha256(canonical_json(value).encode()).hexdigest()


def task_by_id(task_id: str) -> TrialTask:
    return next(task for task in TASKS if task.id == task_id)


def fixture_digest(task: TrialTask) -> str:
    return sha256_json(
        [
            {
                "path": path,
                "sha256": hashlib.sha256(content.encode()).hexdigest(),
            }
            for path, content in sorted(task.files.items())
        ]
    )


def materialize_task(task: TrialTask, destination: Path) -> None:
    if destination.exists():
        shutil.rmtree(destination)
    destination.mkdir(parents=True)
    for relative, content in task.files.items():
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")


def workspace_digest(root: Path) -> str:
    payload: list[dict[str, str]] = []
    for path in sorted(item for item in root.rglob("*") if item.is_file()):
        relative = path.relative_to(root)
        if ".weave-codex" in relative.parts:
            continue
        payload.append(
            {
                "path": relative.as_posix(),
                "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            }
        )
    return sha256_json(payload)


def _read_json(path: Path) -> dict[str, Any] | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, UnicodeDecodeError):
        return None
    return value if isinstance(value, dict) else None


def grade_task(task: TrialTask, workspace: Path) -> dict[str, Any]:
    checks: list[dict[str, Any]] = []

    def check(name: str, passed: bool, observed: Any) -> None:
        checks.append({"name": name, "passed": passed, "observed": observed})

    if task.id == "finance-variance":
        value = _read_json(workspace / "result.json")
        expected = {
            "total_revenue": 1200,
            "total_cost": 860,
            "gross_profit": 340,
            "gross_margin": 0.2833,
            "weakest_region": "EMEA",
            "weakest_region_margin": 0.1667,
        }
        check("valid result.json", value is not None, value is not None)
        for key, target in expected.items():
            observed = value.get(key) if value else None
            passed = observed == target if isinstance(target, str) else observed == target
            check(key, passed, observed)
        check(
            "source CSV unchanged",
            (workspace / "data/regions.csv").read_text(encoding="utf-8")
            == task.files["data/regions.csv"],
            "matched" if (workspace / "data/regions.csv").exists() else "missing",
        )
    elif task.id == "codex-app-server-contract":
        value = _read_json(workspace / "architecture.json")
        expected = {
            "auth_status_endpoint": "account/read",
            "thread_start_endpoint": "thread/start",
            "turn_start_endpoint": "turn/start",
            "auth_owner": "codex-app-server",
        }
        check("valid architecture.json", value is not None, value is not None)
        for key, target in expected.items():
            observed = value.get(key) if value else None
            check(key, observed == target, observed)
        source = str(value.get("official_source", "")) if value else ""
        check(
            "official source",
            source.startswith("https://")
            and any(host in source for host in ("openai.com", "chatgpt.com")),
            source,
        )
        output_files = sorted(
            path.relative_to(workspace).as_posix()
            for path in workspace.rglob("*")
            if path.is_file() and ".weave-codex" not in path.relative_to(workspace).parts
        )
        check("no extra files", output_files == ["README.md", "architecture.json"], output_files)
    elif task.id == "accessible-confirmation":
        html = (workspace / "index.html").read_text(encoding="utf-8")
        compact = " ".join(html.split())
        expectations = {
            "button declares dialog": 'aria-haspopup="dialog"',
            "button controls dialog": 'aria-controls="confirmation-dialog"',
            "dialog role": 'role="dialog"',
            "dialog modal": 'aria-modal="true"',
            "dialog label": 'aria-labelledby="confirmation-title"',
            "open button id preserved": 'id="open-confirmation"',
            "dialog id preserved": 'id="confirmation-dialog"',
            "heading id preserved": 'id="confirmation-title"',
        }
        for name, needle in expectations.items():
            check(name, needle in compact, needle if needle in compact else "missing")
    else:  # pragma: no cover - task list and grader evolve together
        raise ValueError(f"unknown trial task: {task.id}")

    passed = sum(bool(item["passed"]) for item in checks)
    return {
        "taskId": task.id,
        "score": passed / len(checks),
        "passed": passed == len(checks),
        "checksPassed": passed,
        "checksTotal": len(checks),
        "checks": checks,
    }


def weave_manifest(task: TrialTask, workspace: Path, model: str) -> HarnessManifest:
    return HarnessManifest.model_validate(
        {
            "schemaVersion": 2,
            "name": f"Matched trial · {task.title}",
            "cwd": str(workspace.resolve()),
            "task": {"instructions": task.instructions, "contextPaths": list(task.files)},
            "memory": {"mode": "off", "selectedThreadIds": []},
            "integrations": {
                "requested": [
                    {
                        "kind": task.integration_kind,
                        "id": task.integration_id,
                        "label": task.integration_label,
                        "phaseIds": list(task.integration_phase_ids),
                    }
                ]
            },
            "agent": {
                "model": model,
                "reasoningEffort": "low",
                "sandbox": "workspace-write",
                "approvalGate": "deny",
            },
            "verification": {"enabled": False},
            "phaseProgram": {
                "projectionVersion": 1,
                "phases": [
                    {
                        "id": "inspect",
                        "kind": "work",
                        "name": "Inspect evidence",
                        "goal": (
                            "Inspect the supplied files and acceptance criteria. Establish exact "
                            "facts and a concise plan. Do not modify files in this phase."
                        ),
                    },
                    {
                        "id": "produce",
                        "kind": "work",
                        "name": "Produce the result",
                        "goal": (
                            "Create or repair the requested artifact. Keep changes limited to the "
                            "task and run any deterministic local checks that are useful."
                        ),
                    },
                    {
                        "id": "verify",
                        "kind": "verify",
                        "name": "Verify the artifact",
                        "criteria": task.instructions,
                        "maxRepairs": 0,
                    },
                ],
            },
        }
    )


def ordinary_prompt(task: TrialTask) -> str:
    paths = "\n".join(f"- {path}" for path in task.files)
    return f"""Complete this task in the current workspace.

<task>
{task.instructions}
</task>
<starting_files>
{paths}
</starting_files>

Memory is disabled. Use the normal Codex agent loop and any already available integration only if
it is genuinely useful. Complete the artifact and check it before answering. Do not ask
questions."""


def event_counts(events: list[dict[str, Any]]) -> dict[str, Any]:
    completed_items: dict[str, int] = {}
    for event in events:
        if event.get("method") != "item/completed":
            continue
        params = event.get("params") if isinstance(event.get("params"), dict) else {}
        item = params.get("item") if isinstance(params.get("item"), dict) else {}
        item_type = str(item.get("type") or "unknown")
        completed_items[item_type] = completed_items.get(item_type, 0) + 1
    return {
        "modelCompletions": sum(
            event.get("method") == "rawResponse/completed" for event in events
        ),
        "completedItemsByType": dict(sorted(completed_items.items())),
    }
