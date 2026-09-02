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
    assert session.result["workflow"] == {
        "name": "Test harness",
        "task": "Inspect the project and report the result.",
    }
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


def test_native_action_approval_rejects_checkpoint_feedback() -> None:
    session = RunSession(run_id="approval-feedback")
    worker = threading.Thread(
        target=lambda: session.request_approval(
            "item/commandExecution/requestApproval",
            {"command": "pytest", "cwd": "/tmp/project"},
        )
    )
    worker.start()
    deadline = time.monotonic() + 2
    while session.pending_approval is None and time.monotonic() < deadline:
        time.sleep(0.01)
    with pytest.raises(ValueError, match="only at a harness checkpoint"):
        session.decide("accept", "Change the implementation first.")
    session.decide("decline")
    worker.join(timeout=2)


def test_single_product_surface_owns_canvas_saved_workflows_and_runs() -> None:
    static = Path(__file__).parents[1] / "weave_codex/static"
    html = (static / "index.html").read_text()

    assert html.count('class="product-view') == 4
    assert 'id="workflow-canvas"' in html
    assert 'id="workflow-library"' in html
    assert 'id="runs-list"' in html
    assert 'id="connections-panel"' in html
    assert 'id="setup-panel"' in html
    assert 'id="docs-view"' in html
    for obsolete in ("studio.html", "platform.html", "deep-dive.html", "compare.html"):
        assert not (static / obsolete).exists()


def test_canvas_is_freeform_executable_fullscreen_and_pannable() -> None:
    static = Path(__file__).parents[1] / "weave_codex/static"
    html = (static / "index.html").read_text()
    javascript = (static / "home.js").read_text()
    stylesheet = (static / "home.css").read_text()

    assert "Build your workflow" in html
    assert 'id="canvas-nodes"' in html
    assert 'id="canvas-edges"' in html
    assert 'id="canvas-add-node"' in html
    assert 'id="canvas-add-arrow"' in html
    assert 'id="canvas-arrange"' not in html
    assert 'id="canvas-fit"' in html
    assert 'id="canvas-fullscreen"' in html
    assert 'data-add-phase="work"' in html
    assert 'data-add-phase="checkpoint"' in html
    assert 'data-add-phase="command"' in html
    assert 'data-add-phase="verify"' in html
    assert 'request("/api/phase-templates")' in javascript
    assert "function fitCanvas()" in javascript
    assert "function beginCanvasPan(event)" in javascript
    assert "function handleCanvasWheel(event)" in javascript
    assert 'addEventListener("wheel", handleCanvasWheel, { passive: false })' in javascript
    assert "requestFullscreen" in javascript
    assert "beginConnection" in javascript
    assert "wouldCreateCycle" in javascript
    assert "data-phase-connect-add" in javascript
    assert 'role="region" aria-label="Executable workflow graph"' in html
    assert 'id="save-design" class="canvas-icon-button" type="button"' in html
    assert ".canvas-node.command" in stylesheet
    assert ".canvas-node.checkpoint" in stylesheet
    assert ".canvas-viewport { height: 680px; overflow: hidden" in stylesheet
    assert ".canvas-primary:is(:fullscreen, .canvas-expanded)" in stylesheet
    assert 'canvas.classList.add("canvas-expanded")' in javascript


def test_functional_app_prioritizes_the_builder_not_marketing_content() -> None:
    static = Path(__file__).parents[1] / "weave_codex/static"
    html = (static / "index.html").read_text()

    assert "Build your workflow" in html
    assert 'class="build-guide"' not in html
    assert 'class="animated-architecture"' not in html
    assert "input tokens" not in html.lower()
    assert "model completions" not in html.lower()


def test_main_app_unifies_task_design_runs_integrations_and_evidence() -> None:
    static = Path(__file__).parents[1] / "weave_codex/static"
    html = (static / "index.html").read_text()
    javascript = (static / "home.js").read_text()

    assert 'id="task-composer"' in html
    assert 'data-mode="ordinary"' in html
    assert 'data-mode="weave"' in html
    assert 'id="create-view"' in html
    assert 'id="library-view"' in html
    assert 'id="activity-view"' in html
    assert 'id="docs-view"' in html
    assert html.count('class="product-view') == 4
    assert 'data-view="design"' not in html
    assert 'data-view="runs"' not in html
    assert 'data-view="integrations"' not in html
    assert 'data-view="field-trials"' not in html
    assert 'id="platform-trials-grid"' in html
    assert 'href="/studio.html#design"' not in html
    assert 'require("./canvas-model.js")' in javascript
    assert '<script src="/canvas-model.js"></script>' in html
    assert 'request("/api/compile"' in javascript
    assert 'request("/api/runs"' in javascript
    assert "Build your workflow" in html
    assert 'id="example-workflow-select"' in html
    assert 'id="attach-files"' in html
    assert 'id="file-input"' in html
    assert 'request("/api/workspace/uploads"' in javascript
    assert "data-delete-workflow" in javascript
    assert "data-delete-run" in javascript
    assert 'request("/api/phase-templates")' in javascript
    assert 'data-add-phase="work" data-step-option="adaptive"' in html
    assert 'data-add-phase="command" data-step-option="test"' in html
    assert "Broad · Codex chooses how" in javascript
    assert "Focused · only this job" in javascript
    assert "Function call" in javascript
    assert "Checker" in javascript
    assert 'id="cancel-active-run"' in html
    assert '/stop`, { method: "POST"' in javascript
    assert 'id="checkpoint-feedback"' in html
    assert "CALIBRATION" in javascript
    assert "execution.feedback" in javascript
    assert "layoutRunGraph" in javascript
    assert "WORKFLOW REPLAY" in javascript
    assert "request(`/api/runs/${encodeURIComponent(runId)}/artifacts`" in javascript
    assert 'id="artifact-preview"' in javascript
    assert "runCanvasMarkup" in javascript
    assert "node-io-grid" in javascript
    assert 'title="Delete step" aria-label="Delete step"' in javascript
    assert "trashIcon" in javascript
    assert 'request("/api/platform-trials"' in javascript
    assert 'data-view="create"' in html
    assert 'data-view="library"' in html
    assert 'data-view="activity"' in html
    assert "programHash.slice" not in javascript
    assert "manifestHash || runId" not in javascript
    assert "runId.slice" not in javascript
    assert 'id="workflow-library"' in html
    assert 'request("/api/workflows"' in javascript
    assert 'request("/api/workflows/adapt"' in javascript
    assert "request(`/api/integrations?cwd=" in javascript
    assert 'request("/reusable-workflow-trials.json"' in javascript
    assert "Test setup" in javascript
    assert "Reusable workflows in new repositories" in html
    assert "Only nodes, arrows, and settings are stored" in html
    assert "Stopped because a pass/fail check failed" in javascript


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


def test_run_session_stop_interrupts_active_turn() -> None:
    calls: list[str] = []
    session = RunSession(run_id="stop-active")
    session.status = "running"
    session.bind_interrupt(lambda: calls.append("interrupt") is None)

    assert session.request_stop() is True
    assert calls == ["interrupt"]
    assert session.snapshot()["stopRequested"] is True


def test_run_session_stop_releases_pending_checkpoint() -> None:
    session = RunSession(run_id="stop-checkpoint")
    session.status = "running"
    result: list[dict[str, str]] = []

    waiter = threading.Thread(
        target=lambda: result.append(session.request_checkpoint("review", "Continue?"))
    )
    waiter.start()
    for _ in range(100):
        if session.snapshot()["pendingApproval"] is not None:
            break
        time.sleep(0.01)

    assert session.request_stop() is True
    waiter.join(timeout=1)
    assert result == [{"decision": "cancel"}]
