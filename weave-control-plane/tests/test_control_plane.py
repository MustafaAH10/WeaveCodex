from __future__ import annotations

import json
import threading
import time
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError

from weave_codex.manifest import HarnessManifest, compile_manifest
from weave_codex.runtime import HarnessRunner, RunSession, TurnOutcome, _project_event
from weave_codex.server import ControlPlane


def manifest(**overrides: Any) -> HarnessManifest:
    value: dict[str, Any] = {
        "schemaVersion": 1,
        "name": "Test harness",
        "cwd": "/tmp/project",
        "task": {"instructions": "Inspect the project and report the result."},
        "memory": {"mode": "off", "selectedThreadIds": []},
        "agent": {
            "model": None,
            "reasoningEffort": "low",
            "sandbox": "read-only",
            "approvalGate": "deny",
        },
        "verification": {"enabled": True, "criteria": "The answer is correct.", "maxRetries": 1},
        "output": {"format": "text"},
        "observability": {"traceRoot": ".weave-codex/traces"},
    }
    value.update(overrides)
    return HarnessManifest.model_validate(value)


class FakeGateway:
    def __init__(self, outcomes: list[str] | None = None) -> None:
        self.outcomes = list(
            outcomes or ["draft", '{"status":"pass","answer":"final","issues":[]}']
        )
        self.prompts: list[str] = []
        self.params: dict[str, Any] | None = None
        self.memory_mode: tuple[str, str] | None = None
        self.read_ids: list[str] = []
        self.closed = False

    def start(self) -> None:
        pass

    def close(self) -> None:
        self.closed = True

    def read_thread(self, thread_id: str) -> dict[str, Any]:
        self.read_ids.append(thread_id)
        return {
            "thread": {
                "turns": [
                    {
                        "items": [
                            {
                                "type": "userMessage",
                                "content": [{"type": "text", "text": "prior task"}],
                            },
                            {"type": "agentMessage", "text": f"useful result from {thread_id}"},
                        ]
                    }
                ]
            }
        }

    def list_threads(self, cwd: str) -> list[dict[str, Any]]:
        return [{"id": "thread-a", "cwd": cwd}]

    def start_thread(self, params: dict[str, Any]) -> str:
        self.params = params
        return "new-thread"

    def set_memory_mode(self, thread_id: str, mode: str) -> None:
        self.memory_mode = (thread_id, mode)

    def run_turn(self, thread_id: str, prompt: str, **kwargs: Any) -> TurnOutcome:
        self.prompts.append(prompt)
        kwargs["event_sink"]({"method": "turn/completed", "params": {"threadId": thread_id}})
        return TurnOutcome(f"turn-{len(self.prompts)}", self.outcomes.pop(0))


def test_compiler_exposes_bypassed_memory_and_turn_bound() -> None:
    compiled = compile_manifest(manifest())
    assert compiled["maximumTurns"] == 3
    assert compiled["nodes"][1] == {
        "id": "memory",
        "kind": "memory",
        "label": "Memory",
        "detail": "Off",
        "state": "bypassed",
    }
    assert "inject no prior traces" in compiled["actions"][1]


def test_compiler_exposes_phase_level_program_without_expanding_tool_calls() -> None:
    value = manifest(
        schemaVersion=2,
        phaseProgram={
            "projectionVersion": 1,
            "phases": [
                {
                    "id": "inspect",
                    "kind": "work",
                    "name": "Inspect",
                    "goal": "Inspect the relevant project evidence.",
                },
                {
                    "id": "gate",
                    "kind": "checkpoint",
                    "name": "Human gate",
                    "question": "Continue into implementation?",
                },
                {
                    "id": "build",
                    "kind": "work",
                    "name": "Build",
                    "goal": "Implement and test the requested change.",
                },
            ],
        },
    )
    compiled = compile_manifest(value)

    assert compiled["maximumTurns"] == 2
    assert compiled["executionOrder"] == ["inspect", "gate", "build"]
    assert [node["id"] for node in compiled["nodes"]] == [
        "task",
        "memory",
        "integrations",
        "safety",
        "inspect",
        "gate",
        "build",
        "output",
    ]
    assert "not authored by this graph" in compiled["internalLoopSemantics"]


def test_selected_memory_requires_explicit_unique_ids() -> None:
    with pytest.raises(ValidationError, match="at least one thread id"):
        manifest(memory={"mode": "selected", "selectedThreadIds": []})
    with pytest.raises(ValidationError, match="duplicates"):
        manifest(memory={"mode": "selected", "selectedThreadIds": ["x", "x"]})


def test_integration_requests_are_typed_scoped_and_compiled() -> None:
    value = manifest(
        schemaVersion=2,
        integrations={
            "inventoryId": "sha256:" + "a" * 64,
            "requested": [
                {
                    "kind": "skill",
                    "id": "code-review",
                    "label": "Code review",
                    "phaseIds": ["inspect"],
                },
                {
                    "kind": "mcp",
                    "id": "openaiDeveloperDocs",
                    "label": "OpenAI developer docs",
                    "phaseIds": [],
                },
            ],
        },
        phaseProgram={
            "projectionVersion": 1,
            "phases": [
                {
                    "id": "inspect",
                    "kind": "work",
                    "name": "Inspect",
                    "goal": "Inspect the relevant project evidence.",
                }
            ],
        },
    )

    compiled = compile_manifest(value)

    integration_node = next(node for node in compiled["nodes"] if node["id"] == "integrations")
    assert integration_node["detail"] == "2 requested · instructional binding"
    assert any("request skill 'Code review' in inspect" in item for item in compiled["actions"])
    assert any(
        "request mcp 'OpenAI developer docs' in all work phases" in item
        for item in compiled["actions"]
    )

    with pytest.raises(ValidationError, match="must reference work phases"):
        manifest(
            schemaVersion=2,
            integrations={
                "requested": [
                    {
                        "kind": "skill",
                        "id": "code-review",
                        "label": "Code review",
                        "phaseIds": ["missing"],
                    }
                ]
            },
            phaseProgram={
                "projectionVersion": 1,
                "phases": [
                    {
                        "id": "inspect",
                        "kind": "work",
                        "name": "Inspect",
                        "goal": "Inspect the relevant project evidence.",
                    }
                ],
            },
        )


def test_runner_binds_requested_integrations_to_prompt_and_receipt() -> None:
    fake = FakeGateway(outcomes=["reviewed", '{"status":"pass","answer":"done","issues":[]}'])
    runner = HarnessRunner("codex", lambda *_: fake)
    session = RunSession(run_id="run-integrations")
    selected = manifest(
        integrations={
            "inventoryId": "sha256:" + "b" * 64,
            "requested": [
                {
                    "kind": "skill",
                    "id": "code-review",
                    "label": "Code review",
                    "phaseIds": [],
                }
            ],
        }
    )

    runner.run(selected, session)

    assert "$code-review" in fake.prompts[0]
    assert "not a hard tool allowlist" in fake.prompts[0]
    assert session.result is not None
    assert session.result["integrations"] == {
        "inventoryId": "sha256:" + "b" * 64,
        "bindingMode": "instructional",
        "requested": [
            {
                "kind": "skill",
                "id": "code-review",
                "label": "Code review",
                "phaseIds": [],
            }
        ],
        "observedToolItems": [],
        "attribution": (
            "Requests are manifest-bound. Use is claimed only when an observable integration "
            "tool item is present; skill loading is not inferred."
        ),
    }


def test_runner_injects_only_selected_threads_and_records_hashes() -> None:
    fake = FakeGateway()
    runner = HarnessRunner("codex", lambda *_: fake)
    session = RunSession(run_id="run-selected")
    selected = manifest(memory={"mode": "selected", "selectedThreadIds": ["thread-a", "thread-b"]})
    runner.run(selected, session)

    assert session.status == "completed"
    assert fake.read_ids == ["thread-a", "thread-b"]
    assert "useful result from thread-a" in fake.prompts[0]
    assert "useful result from thread-b" in fake.prompts[0]
    assert fake.prompts[0].count("[thread thread-a]") == 1
    assert fake.prompts[0].count("[thread thread-b]") == 1
    assert fake.memory_mode == ("new-thread", "disabled")
    assert fake.params is not None
    assert fake.params["config"]["memories"] == {
        "use_memories": False,
        "generate_memories": False,
    }
    assert session.result is not None
    assert session.result["memory"]["resolvedThreadIds"] == ["thread-a", "thread-b"]
    assert set(session.result["memory"]["excerptHashes"]) == {"thread-a", "thread-b"}
    assert fake.closed


def test_verifier_repairs_within_declared_bound() -> None:
    fake = FakeGateway(
        [
            "draft",
            '{"status":"repair","answer":"better","issues":["missing evidence"]}',
            '{"status":"pass","answer":"better","issues":[]}',
        ]
    )
    session = RunSession(run_id="run-repair")
    HarnessRunner("codex", lambda *_: fake).run(manifest(), session)

    assert session.result is not None
    assert session.result["finalResponse"] == "better"
    assert len(session.result["turnIds"]) == session.result["controls"]["maximumTurns"] == 3
    assert [item["status"] for item in session.result["verification"]] == ["repair", "pass"]
    assert [item["phase"] for item in session.result["timeline"] if item["kind"] == "stage"] == [
        "setup",
        "setup",
        "memory",
        "integrations",
        "setup",
        "solver",
        "solver",
        "verifier-1",
        "verifier-1",
        "verifier-2",
        "verifier-2",
        "output",
    ]


def test_visual_timeline_projects_reasoning_and_tool_rounds() -> None:
    reasoning = _project_event(
        {
            "method": "item/completed",
            "phase": "solver",
            "params": {"item": {"type": "reasoning", "summary": ["Inspect first"]}},
        },
        0,
    )
    tool = _project_event(
        {
            "method": "item/started",
            "phase": "solver",
            "params": {"item": {"type": "commandExecution", "command": "rg README"}},
        },
        1,
    )
    result = _project_event(
        {
            "method": "item/completed",
            "phase": "solver",
            "params": {"item": {"type": "commandExecution", "status": "completed"}},
        },
        2,
    )

    assert reasoning["kind"] == "reasoning"
    assert tool["kind"] == "tool_call"
    assert tool["detail"] == "rg README"
    assert result["kind"] == "tool_result"


def test_manual_approval_blocks_until_human_decision() -> None:
    session = RunSession(run_id="approval")
    answer: list[dict[str, Any]] = []
    worker = threading.Thread(
        target=lambda: answer.append(
            session.request_approval(
                "item/commandExecution/requestApproval",
                {"command": "pytest", "cwd": "/tmp/project"},
            )
        )
    )
    worker.start()
    deadline = time.monotonic() + 2
    while session.pending_approval is None and time.monotonic() < deadline:
        time.sleep(0.01)
    assert session.snapshot()["status"] == "waitingForApproval"
    session.decide("accept")
    worker.join(timeout=2)
    assert answer == [{"decision": "accept"}]


def test_ui_contains_phase_canvas_thread_projection_and_receipt_surfaces() -> None:
    html = (Path(__file__).parents[1] / "weave_codex/static/index.html").read_text()
    for element_id in (
        "manifest-json",
        "phase-canvas",
        "phase-palette",
        "thread-picker",
        "receipt",
        "timeline",
        "receipt-summary",
        "phase-inspector",
        "execution-map",
        "recent-runs",
        "codex-thread-list",
        "approval-dialog",
        "workspace-picker",
        "workspace-query",
        "workspace-results",
    ):
        assert f'id="{element_id}"' in html


def test_ui_edits_phase_programs_without_expanding_codex_tool_calls() -> None:
    static = Path(__file__).parents[1] / "weave_codex/static"
    javascript = (static / "app.js").read_text()
    stylesheet = (static / "style.css").read_text()

    assert 'button.addEventListener("dragstart"' in javascript
    assert "function phaseManifest()" in javascript
    assert 'request("/api/thread-projection"' in javascript
    assert "One app-server turn; Codex may use many tools inside." in javascript
    assert "Codex owns the internal tool loop" in javascript
    assert ".phase-card.fixed-phase" in stylesheet
    assert ".phase-card.drop-before" in stylesheet
    assert "A canvas block is not a tool call." in (static / "index.html").read_text()


def test_ui_offers_three_additional_complex_programs_and_workspace_references() -> None:
    static = Path(__file__).parents[1] / "weave_codex/static"
    html = (static / "index.html").read_text()
    javascript = (static / "app.js").read_text()

    for key in ("migration", "monorepo", "incident"):
        assert f'data-example="{key}"' in html
        assert f'data-preset="{key}"' in html
        assert f"  {key}: {{" in javascript
    assert 'request("/api/workspace/paths"' in javascript
    assert "Codex can still inspect other files" in html
    assert "one or one hundred tool calls" in javascript


def test_run_explorer_comparison_integrations_and_technical_diagrams_are_explicit() -> None:
    static = Path(__file__).parents[1] / "weave_codex/static"
    html = (static / "index.html").read_text()
    javascript = (static / "app.js").read_text()
    comparison = (static / "compare.html").read_text()
    comparison_js = (static / "compare.js").read_text()
    deep_dive = (static / "deep-dive.html").read_text()

    assert "From one task to one evidence map" in html
    assert 'data-run-source="weave"' in html
    assert 'data-trace-panel="activity"' in html
    assert 'id="integrations-view"' in html
    assert "request(`/api/integrations?" in javascript
    assert "Same runtime.<br />Different control surface." in comparison
    assert 'id="codex-map"' in comparison
    assert 'id="weave-map"' in comparison
    assert "Deterministic projection of persisted items" in comparison_js
    assert 'id="integrations"' in deep_dive
    assert 'id="integration-title"' in deep_dive
    assert "AGENTS.md chain" in deep_dive


def test_product_examples_api_source_includes_all_five_examples(tmp_path: Path) -> None:
    app = ControlPlane("codex", tmp_path)
    try:
        examples = app.product_examples()
    finally:
        app.close()

    assert [example["caseId"] for example in examples] == [
        "flappy-bird-local-observation",
        "checkout-repair-design",
        "database-migration-design",
        "monorepo-upgrade-design",
        "incident-response-design",
    ]


def test_saved_run_index_and_load_are_local_and_bounded(tmp_path: Path) -> None:
    app = ControlPlane("codex", tmp_path)
    receipt = {
        "runId": "00000000-0000-0000-0000-000000000001",
        "startedAt": 1,
        "completedAt": 2,
        "turnIds": ["turn-1"],
        "memory": {"mode": "off"},
        "controls": {"sandbox": "read-only"},
        "verification": [],
        "finalResponse": "done",
        "timeline": [{"kind": "answer"}],
    }
    (tmp_path / "00000000-0000-0000-0000-000000000001.json").write_text(
        json.dumps(receipt), encoding="utf-8"
    )

    assert app.saved_runs()[0]["turnCount"] == 1
    assert app.saved_run(receipt["runId"]) == receipt
    assert app.saved_run("../outside") is None
