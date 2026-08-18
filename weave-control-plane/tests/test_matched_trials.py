import json
from pathlib import Path

from weave_codex.matched_trials import (
    TASKS,
    fixture_digest,
    grade_task,
    materialize_task,
    ordinary_prompt,
    sha256_json,
    weave_manifest,
    workspace_digest,
)


def test_three_tasks_are_distinct_and_memory_off() -> None:
    assert [task.id for task in TASKS] == [
        "finance-variance",
        "codex-app-server-contract",
        "accessible-confirmation",
    ]
    assert len({task.domain for task in TASKS}) == 3
    for task in TASKS:
        manifest = weave_manifest(task, Path("/tmp") / task.id, "gpt-5.6-terra")
        assert manifest.memory.mode == "off"
        assert manifest.agent.reasoning_effort == "low"
        assert manifest.agent.sandbox == "workspace-write"
        assert manifest.agent.approval_gate == "deny"
        assert [phase.kind for phase in manifest.phase_program.phases] == [
            "work",
            "work",
            "verify",
        ]
        assert manifest.phase_program.phases[-1].max_repairs == 0
        assert len(manifest.integrations.requested) == 1
        assert "Memory is disabled" in ordinary_prompt(task)


def test_fixture_materialization_is_deterministic(tmp_path: Path) -> None:
    task = TASKS[0]
    first = tmp_path / "first"
    second = tmp_path / "second"
    materialize_task(task, first)
    materialize_task(task, second)
    assert workspace_digest(first) == workspace_digest(second)
    assert workspace_digest(first) == fixture_digest(task)


def test_finance_grader_accepts_only_exact_result(tmp_path: Path) -> None:
    task = TASKS[0]
    materialize_task(task, tmp_path)
    failed = grade_task(task, tmp_path)
    assert failed["passed"] is False
    (tmp_path / "result.json").write_text(
        json.dumps(
            {
                "total_revenue": 1200,
                "total_cost": 860,
                "gross_profit": 340,
                "gross_margin": 0.2833,
                "weakest_region": "EMEA",
                "weakest_region_margin": 0.1667,
            }
        ),
        encoding="utf-8",
    )
    passed = grade_task(task, tmp_path)
    assert passed["passed"] is True
    assert passed["score"] == 1.0


def test_app_server_grader_requires_exact_contract_and_source(tmp_path: Path) -> None:
    task = TASKS[1]
    materialize_task(task, tmp_path)
    (tmp_path / "architecture.json").write_text(
        json.dumps(
            {
                "auth_status_endpoint": "account/read",
                "thread_start_endpoint": "thread/start",
                "turn_start_endpoint": "turn/start",
                "auth_owner": "codex-app-server",
                "official_source": "https://developers.openai.com/codex/app-server",
            }
        ),
        encoding="utf-8",
    )
    assert grade_task(task, tmp_path)["passed"] is True
    (tmp_path / "extra.txt").write_text("not allowed", encoding="utf-8")
    assert grade_task(task, tmp_path)["passed"] is False


def test_accessibility_grader_checks_the_requested_relationships(tmp_path: Path) -> None:
    task = TASKS[2]
    materialize_task(task, tmp_path)
    failed = grade_task(task, tmp_path)
    assert failed["passed"] is False
    (tmp_path / "index.html").write_text(
        """<!doctype html><html><body>
        <button id="open-confirmation" aria-haspopup="dialog"
          aria-controls="confirmation-dialog">Delete project</button>
        <section id="confirmation-dialog" role="dialog" aria-modal="true"
          aria-labelledby="confirmation-title">
          <h2 id="confirmation-title">Delete project?</h2>
          <button id="confirm-delete">Delete</button>
        </section></body></html>""",
        encoding="utf-8",
    )
    assert grade_task(task, tmp_path)["passed"] is True


def test_preserved_summary_is_self_consistent() -> None:
    path = Path(__file__).parents[1] / "weave_codex" / "static" / "matched-trials.json"
    summary = json.loads(path.read_text(encoding="utf-8"))
    claimed = summary.pop("summarySha256")

    assert claimed == sha256_json(summary)
    assert summary["aggregate"] == {
        "tasks": 3,
        "executions": 6,
        "ordinaryArtifactsPassed": 3,
        "weaveArtifactsPassed": 3,
        "ordinaryControllerTurns": 3,
        "weaveControllerTurns": 9,
        "ordinaryModelCompletions": 15,
        "weaveModelCompletions": 46,
        "ordinaryInputTokens": 448476,
        "weaveInputTokens": 1424224,
        "ordinaryOutputTokens": 1998,
        "weaveOutputTokens": 6810,
    }
    assert all(
        result[arm]["artifact"]["passed"]
        for result in summary["results"]
        for arm in ("ordinary", "weave")
    )
    docs_trial = next(
        result for result in summary["results"] if result["taskId"] == "codex-app-server-contract"
    )
    assert docs_trial["weave"]["observedIntegrationToolItems"] == [
        {
            "itemType": "mcpToolCall",
            "status": "completed",
            "server": "openaiDeveloperDocs",
            "tool": "search_openai_docs",
        }
    ]
