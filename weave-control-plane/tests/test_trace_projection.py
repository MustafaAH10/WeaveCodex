from __future__ import annotations

import json
from pathlib import Path

from weave_codex.trace_projection import ProjectionLimits, project_events, project_thread

FIXTURES = Path(__file__).with_name("fixtures")


def fixture(name: str):
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def test_thread_projection_groups_items_into_goal_level_phases() -> None:
    projected = project_thread(fixture("thread_read_trace.json"))

    assert projected["projectionBasis"] == "derivedFromPersistedThreadItems"
    assert projected["source"] == {
        "kind": "appServerV2ThreadRead",
        "threadId": "thr-fixture",
        "turnIds": ["turn-build", "turn-review"],
        "itemIds": [
            "item-user",
            "item-reason",
            "item-read",
            "item-progress",
            "item-search",
            "item-change",
            "item-test-fail",
            "item-repair",
            "item-test-pass",
            "item-final",
            "item-review-start",
            "item-review-end",
        ],
        "missingItemIdCount": 0,
    }
    assert projected["counts"] == {
        "turns": 2,
        "items": 12,
        "itemsByType": {
            "agentMessage": 2,
            "commandExecution": 4,
            "enteredReviewMode": 1,
            "exitedReviewMode": 1,
            "fileChange": 2,
            "reasoning": 1,
            "userMessage": 1,
        },
        "toolCalls": 6,
        "modelCompletions": None,
        "approvalRequests": None,
        "verificationAttempts": None,
        "projectedVerificationPhases": 3,
        "projectedRepairPhases": 1,
        "declinedOperations": 0,
    }
    assert [node["kind"] for node in projected["graph"]["nodes"]] == [
        "task",
        "plan",
        "explore",
        "change",
        "verify",
        "repair",
        "verify",
        "deliver",
        "verify",
    ]
    explore = projected["graph"]["nodes"][2]
    assert explore["itemIds"] == ["item-read", "item-progress", "item-search"]
    assert explore["counts"]["toolCalls"] == 2
    assert projected["warnings"] == [
        "Turn turn-review has itemsView=summary; its item counts are not a complete trace."
    ]


def test_thread_projection_never_copies_sensitive_trace_content() -> None:
    encoded = json.dumps(project_thread(fixture("thread_read_trace.json")))

    assert "SECRET" not in encoded
    assert "/secret" not in encoded
    assert "aggregatedOutput" not in encoded
    assert "commandStrings" in encoded
    assert "identifiersTruncated" in encoded


def test_one_phase_can_represent_one_hundred_tool_calls() -> None:
    items = [
        {"type": "userMessage", "id": "task", "content": []},
        *[
            {
                "type": "commandExecution",
                "id": f"read-{index:03d}",
                "command": f"sed -n 1p file-{index}.py",
                "commandActions": [{"type": "read"}],
                "status": "completed",
            }
            for index in range(100)
        ],
        {"type": "agentMessage", "id": "answer", "text": "done"},
    ]

    projected = project_thread(
        {"thread": {"id": "thr-burst", "turns": [{"id": "turn-burst", "items": items}]}}
    )

    assert [node["kind"] for node in projected["graph"]["nodes"]] == [
        "task",
        "explore",
        "deliver",
    ]
    explore = projected["graph"]["nodes"][1]
    assert explore["counts"]["toolCalls"] == 100
    assert explore["itemIds"] == [f"read-{index:03d}" for index in range(100)]
    assert projected["counts"]["toolCalls"] == 100


def test_receipt_adds_only_observable_counts_to_thread_projection() -> None:
    receipt = {
        "observed": {"modelCompletions": 3},
        "verification": [{"attempt": 1}, {"attempt": 2}],
        "timeline": [{"kind": "approval"}, {"kind": "answer"}],
    }

    projected = project_thread(fixture("thread_read_trace.json"), receipt=receipt)

    assert projected["counts"]["modelCompletions"] == 3
    assert projected["counts"]["approvalRequests"] == 1
    assert projected["counts"]["verificationAttempts"] == 2
    assert projected["observability"] == {
        "modelCompletions": "observedInWeaveReceipt",
        "approvalRequests": "derivedFromWeaveReceiptTimeline",
        "verificationAttempts": "observedInWeaveReceipt",
        "declinedOperations": "observedFromPersistedItemStatuses",
    }


def test_event_projection_preserves_every_event_reference_and_source_id() -> None:
    projected = project_events(fixture("events_trace.json"))

    assert projected["projectionBasis"] == "derivedFromCapturedAppServerEvents"
    assert projected["counts"] == {
        "events": 10,
        "eventsByMethod": {
            "harness/stage": 2,
            "item/commandExecution/requestApproval": 1,
            "item/completed": 1,
            "item/started": 1,
            "rawResponse/completed": 2,
            "serverRequest/resolved": 1,
            "turn/completed": 1,
            "turn/started": 1,
        },
        "uniqueItems": 1,
        "toolCalls": 1,
        "modelCompletions": 2,
        "approvalRequests": 1,
        "verificationAttempts": 1,
        "projectedVerificationPhases": 1,
        "projectedRepairPhases": 0,
    }
    records = projected["source"]["eventRecords"]
    assert [record["eventRef"] for record in records] == [f"event:{i}" for i in range(10)]
    assert [record["sourceEventId"] for record in records if record["sourceEventId"]] == [
        "approval-17",
        "approval-17",
        "response-1",
        42,
    ]
    assert projected["source"]["turnIds"] == ["turn-live", "turn-verify"]
    assert projected["source"]["itemIds"] == ["tool-live"]


def test_event_projection_exposes_approval_and_verification_as_phases() -> None:
    projected = project_events(fixture("events_trace.json"))
    kinds = [node["kind"] for node in projected["graph"]["nodes"]]

    assert "approval" in kinds
    assert "verify" in kinds
    assert len(projected["graph"]["edges"]) == len(kinds) - 1
    assert all(node["derived"] is True for node in projected["graph"]["nodes"])
    assert all(edge["derived"] is True for edge in projected["graph"]["edges"])


def test_event_projection_redacts_payloads_and_bounds_only_display_labels() -> None:
    projected = project_events(
        fixture("events_trace.json"),
        limits=ProjectionLimits(max_summary_chars=80, max_tool_labels=1),
    )
    encoded = json.dumps(projected)

    assert "SECRET" not in encoded
    assert "secret.example" not in encoded
    assert len(projected["source"]["eventRecords"]) == 10
    assert projected["privacy"]["displayLimits"] == {
        "summaryCharacters": 80,
        "toolLabelsPerPhase": 1,
    }


def test_event_projection_marks_post_verification_changes_as_repairs() -> None:
    events = [
        {
            "method": "item/completed",
            "params": {
                "turnId": "turn-repair",
                "item": {
                    "type": "commandExecution",
                    "id": "test-failed",
                    "command": "pytest -q",
                    "status": "failed",
                },
            },
        },
        {
            "method": "item/completed",
            "params": {
                "turnId": "turn-repair",
                "item": {"type": "fileChange", "id": "fix", "status": "completed"},
            },
        },
    ]

    projected = project_events(events)

    assert [node["kind"] for node in projected["graph"]["nodes"]] == ["verify", "repair"]
    assert projected["counts"]["projectedRepairPhases"] == 1
