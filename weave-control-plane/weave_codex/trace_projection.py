"""Privacy-preserving, phase-level projections of Codex app-server traces.

The app-server exposes turns, items, and live notifications.  Those records are the
source of truth.  A phase in this module is deliberately only a derived visual
grouping: one phase can contain any number of model responses and tool calls.
"""

from __future__ import annotations

import re
from collections import Counter
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

PROJECTION_VERSION = "codex-phase-projection/1"

_TOOL_ITEM_TYPES = {
    "collabAgentToolCall",
    "commandExecution",
    "dynamicToolCall",
    "fileChange",
    "imageGeneration",
    "imageView",
    "mcpToolCall",
    "sleep",
    "subAgentActivity",
    "webSearch",
}
_READ_ACTIONS = {"read", "listfiles", "search"}
_VERIFY_COMMAND = re.compile(
    r"(?:^|[\s/])(pytest|cargo\s+test|npm\s+(?:run\s+)?test|pnpm\s+(?:run\s+)?test|"
    r"yarn\s+test|vitest|jest|ruff|mypy|eslint|tsc|go\s+test|make\s+(?:test|check)|"
    r"just\s+(?:test|check)|gradle\w*\s+test)(?:\s|$)",
    re.IGNORECASE,
)
_CHANGE_COMMAND = re.compile(
    r"(?:^|\s)(apply_patch|git\s+apply|sed\s+-i|perl\s+-i|mkdir|touch|mv|cp|rm|chmod)"
    r"(?:\s|$)",
    re.IGNORECASE,
)
_SHIP_COMMAND = re.compile(
    r"(?:^|\s)git\s+(?:commit|push|tag)(?:\s|$)|(?:^|\s)(?:gh\s+pr\s+create)(?:\s|$)",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class ProjectionLimits:
    """Display limits; source identifiers and aggregate counts are never truncated."""

    max_summary_chars: int = 280
    max_tool_labels: int = 8

    def __post_init__(self) -> None:
        if self.max_summary_chars < 80:
            raise ValueError("max_summary_chars must be at least 80")
        if self.max_tool_labels < 1:
            raise ValueError("max_tool_labels must be positive")


@dataclass
class _Phase:
    kind: str
    title: str
    confidence: str = "heuristic"
    turn_ids: list[str] = field(default_factory=list)
    item_ids: list[str] = field(default_factory=list)
    event_refs: list[str] = field(default_factory=list)
    source_event_ids: list[Any] = field(default_factory=list)
    item_types: Counter[str] = field(default_factory=Counter)
    event_methods: Counter[str] = field(default_factory=Counter)
    tool_types: Counter[str] = field(default_factory=Counter)
    tool_actions: Counter[str] = field(default_factory=Counter)
    tool_labels: list[str] = field(default_factory=list)
    tool_item_ids: set[str] = field(default_factory=set)
    unidentified_tool_calls: int = 0
    statuses: Counter[str] = field(default_factory=Counter)
    item_count: int = 0
    event_count: int = 0
    model_completions: int = 0

    def add_turn(self, turn_id: str | None) -> None:
        if turn_id and turn_id not in self.turn_ids:
            self.turn_ids.append(turn_id)

    def add_item(self, item: Mapping[str, Any], turn_id: str | None) -> None:
        self.add_turn(turn_id)
        self.item_count += 1
        item_type = _string(item.get("type"), "unknown")
        self.item_types[item_type] += 1
        item_id = _string(item.get("id"))
        if item_id:
            self.item_ids.append(item_id)
        status = _string(item.get("status"))
        if status:
            self.statuses[status] += 1
        if item_type in _TOOL_ITEM_TYPES:
            self.tool_types[item_type] += 1
            for action in _tool_actions(item):
                self.tool_actions[action] += 1
            label = _tool_label(item)
            if label:
                self.tool_labels.append(label)
            if item_id:
                self.tool_item_ids.add(item_id)
            else:
                self.unidentified_tool_calls += 1

    def add_event(
        self,
        event: Mapping[str, Any],
        event_ref: str,
        source_event_id: str | int | None,
    ) -> None:
        self.event_count += 1
        self.event_refs.append(event_ref)
        if source_event_id is not None:
            self.source_event_ids.append(source_event_id)
        method = _string(event.get("method"), "unknown")
        self.event_methods[method] += 1
        if method == "rawResponse/completed":
            self.model_completions += 1


def project_thread(
    thread_read_response: Mapping[str, Any],
    *,
    receipt: Mapping[str, Any] | None = None,
    limits: ProjectionLimits | None = None,
) -> dict[str, Any]:
    """Project a v2 ``thread/read`` response into a phase graph.

    ``thread/read`` does not retain every live notification.  Consequently model
    invocation and approval-request counts are reported as unobservable unless a
    Weave receipt is supplied.  Item IDs and turn IDs remain the exact source IDs.
    """

    active_limits = limits or ProjectionLimits()
    thread_value = thread_read_response.get("thread", thread_read_response)
    if not isinstance(thread_value, Mapping):
        raise ValueError("thread/read response must contain a thread object")
    thread_id = _string(thread_value.get("id"))
    raw_turns = thread_value.get("turns", [])
    turns = list(raw_turns) if isinstance(raw_turns, Sequence) else []
    phases: list[_Phase] = []
    turn_ids: list[str] = []
    item_ids: list[str] = []
    item_types: Counter[str] = Counter()
    item_statuses: Counter[str] = Counter()
    missing_item_ids = 0
    warnings: list[str] = []

    for turn_value in turns:
        if not isinstance(turn_value, Mapping):
            continue
        turn_id = _string(turn_value.get("id"))
        if turn_id:
            turn_ids.append(turn_id)
        items_view = _string(turn_value.get("itemsView"), "full")
        if items_view != "full":
            warnings.append(
                f"Turn {turn_id or '[missing id]'} has itemsView={items_view}; its item counts "
                "are not a complete trace."
            )
        raw_items = turn_value.get("items", [])
        items = list(raw_items) if isinstance(raw_items, Sequence) else []
        current: _Phase | None = None
        seen_verification = False
        last_agent_index = max(
            (index for index, item in enumerate(items) if _item_type(item) == "agentMessage"),
            default=-1,
        )

        def emit(
            kind: str, *, confidence: str = "heuristic", active_turn_id: str = turn_id
        ) -> _Phase:
            nonlocal current
            if current is not None and current.kind == kind:
                return current
            current = _Phase(kind=kind, title=_phase_title(kind), confidence=confidence)
            current.add_turn(active_turn_id)
            phases.append(current)
            return current

        for index, item_value in enumerate(items):
            if not isinstance(item_value, Mapping):
                continue
            item_type = _item_type(item_value)
            item_types[item_type] += 1
            item_status = _string(item_value.get("status"))
            if item_status:
                item_statuses[item_status] += 1
            item_id = _string(item_value.get("id"))
            if item_id:
                item_ids.append(item_id)
            else:
                missing_item_ids += 1

            if item_type in {"reasoning", "plan"}:
                phase = current if current and current.kind not in {"task", "deliver"} else None
                (phase or emit("plan")).add_item(item_value, turn_id)
                continue
            if item_type == "agentMessage" and index != last_agent_index:
                (current or emit("plan")).add_item(item_value, turn_id)
                continue

            kind = _item_phase_kind(item_value, seen_verification=seen_verification)
            if kind == "verify":
                seen_verification = True
            emit(kind).add_item(item_value, turn_id)

        if not items:
            warnings.append(f"Turn {turn_id or '[missing id]'} contains no loaded items.")

    receipt_counts = _receipt_observability(receipt)
    graph = _graph(phases, active_limits)
    return {
        "schemaVersion": 1,
        "projectionVersion": PROJECTION_VERSION,
        "projectionBasis": "derivedFromPersistedThreadItems",
        "derived": True,
        "disclaimer": (
            "Phase nodes are deterministic visual projections, not native Codex execution "
            "units. One phase may contain many model responses and tool calls."
        ),
        "source": {
            "kind": "appServerV2ThreadRead",
            "threadId": thread_id or None,
            "turnIds": turn_ids,
            "itemIds": item_ids,
            "missingItemIdCount": missing_item_ids,
        },
        "counts": {
            "turns": len(turns),
            "items": sum(item_types.values()),
            "itemsByType": dict(sorted(item_types.items())),
            "toolCalls": sum(item_types[item_type] for item_type in _TOOL_ITEM_TYPES),
            "modelCompletions": receipt_counts["modelCompletions"],
            "approvalRequests": receipt_counts["approvalRequests"],
            "verificationAttempts": receipt_counts["verificationAttempts"],
            "projectedVerificationPhases": sum(phase.kind == "verify" for phase in phases),
            "projectedRepairPhases": sum(phase.kind == "repair" for phase in phases),
            "declinedOperations": item_statuses["declined"],
        },
        "observability": {
            "modelCompletions": receipt_counts["modelCompletionsBasis"],
            "approvalRequests": receipt_counts["approvalRequestsBasis"],
            "verificationAttempts": receipt_counts["verificationAttemptsBasis"],
            "declinedOperations": "observedFromPersistedItemStatuses",
        },
        "privacy": _privacy_contract(active_limits),
        "warnings": warnings,
        "graph": graph,
    }


def project_events(
    events: Iterable[Mapping[str, Any]],
    *,
    receipt: Mapping[str, Any] | None = None,
    limits: ProjectionLimits | None = None,
) -> dict[str, Any]:
    """Project captured app-server notifications/requests into a phase graph.

    Every input event receives a deterministic ``event:<zero-based index>`` reference.
    A protocol event/request ID is preserved separately when the source supplied one.
    Payload text, command strings, outputs, arguments, and reasoning are not copied.
    """

    active_limits = limits or ProjectionLimits()
    event_values = [event for event in events if isinstance(event, Mapping)]
    phases: list[_Phase] = []
    records: list[dict[str, Any]] = []
    event_methods: Counter[str] = Counter()
    item_ids: list[str] = []
    turn_ids: list[str] = []
    tool_item_ids: set[str] = set()
    tool_events_without_ids = 0
    approval_requests = 0
    approval_request_ids: set[str | int] = set()
    verification_phases: set[str] = set()
    verified_turns: set[str | None] = set()
    current: _Phase | None = None

    def emit(kind: str, *, confidence: str = "heuristic") -> _Phase:
        nonlocal current
        if current is not None and current.kind == kind:
            return current
        current = _Phase(kind=kind, title=_phase_title(kind), confidence=confidence)
        phases.append(current)
        return current

    for index, event in enumerate(event_values):
        method = _string(event.get("method"), "unknown")
        params_value = event.get("params", {})
        params = params_value if isinstance(params_value, Mapping) else {}
        item_value = params.get("item", {})
        item = item_value if isinstance(item_value, Mapping) else {}
        event_ref = f"event:{index}"
        source_event_id = _source_event_id(event, params)
        turn_id = _event_turn_id(params)
        item_id = _string(item.get("id")) or _string(params.get("itemId"))
        explicit_phase = _string(event.get("phase"))
        resolved_approval = (
            method == "serverRequest/resolved"
            and source_event_id is not None
            and source_event_id in approval_request_ids
        )
        kind, confidence = _event_phase_kind(
            event,
            method,
            item,
            resolved_approval=resolved_approval,
            seen_verification=turn_id in verified_turns,
        )

        phase = emit(kind, confidence="explicit" if method == "harness/stage" else confidence)
        phase.add_event(event, event_ref, source_event_id)
        phase.add_turn(turn_id)
        if item:
            # Started and completed notifications intentionally contribute to event counts,
            # while item/tool counts are deduplicated below by their source item ID.
            is_new_item = not item_id or item_id not in phase.item_ids
            if item_id and is_new_item:
                phase.item_ids.append(item_id)
            if is_new_item:
                phase.item_count += 1
                phase.item_types[_item_type(item)] += 1
            status = _string(item.get("status"))
            if status:
                phase.statuses[status] += 1
            if _item_type(item) in _TOOL_ITEM_TYPES and is_new_item:
                phase.tool_types[_item_type(item)] += 1
                for action in _tool_actions(item):
                    phase.tool_actions[action] += 1
                label = _tool_label(item)
                if label:
                    phase.tool_labels.append(label)
                if item_id:
                    phase.tool_item_ids.add(item_id)
                elif method == "item/completed":
                    phase.unidentified_tool_calls += 1
        elif item_id and item_id not in phase.item_ids:
            phase.item_ids.append(item_id)
            phase.item_count += 1

        event_methods[method] += 1
        if turn_id and turn_id not in turn_ids:
            turn_ids.append(turn_id)
        if item_id and item_id not in item_ids:
            item_ids.append(item_id)
        if item and _item_type(item) in _TOOL_ITEM_TYPES:
            if item_id:
                tool_item_ids.add(item_id)
            elif method == "item/completed":
                tool_events_without_ids += 1
        if "requestApproval" in method:
            approval_requests += 1
            if source_event_id is not None:
                approval_request_ids.add(source_event_id)
        if kind == "verify":
            verification_phases.add(explicit_phase or phase.title)
            verified_turns.add(turn_id)
        records.append(
            {
                "eventRef": event_ref,
                "sourceEventId": source_event_id,
                "method": method,
                "turnId": turn_id,
                "itemId": item_id or None,
            }
        )

    graph = _graph(phases, active_limits)
    model_completions = event_methods["rawResponse/completed"]
    receipt_counts = _receipt_observability(receipt)
    verification_attempts = (
        receipt_counts["verificationAttempts"]
        if receipt_counts["verificationAttempts"] is not None
        else len(verification_phases)
    )
    return {
        "schemaVersion": 1,
        "projectionVersion": PROJECTION_VERSION,
        "projectionBasis": "derivedFromCapturedAppServerEvents",
        "derived": True,
        "disclaimer": (
            "Phase nodes are deterministic visual projections, not native Codex execution "
            "units. Started/completed events can describe the same tool item."
        ),
        "source": {
            "kind": "appServerV2EventStream",
            "turnIds": turn_ids,
            "itemIds": item_ids,
            "eventRecords": records,
        },
        "counts": {
            "events": len(event_values),
            "eventsByMethod": dict(sorted(event_methods.items())),
            "uniqueItems": len(item_ids),
            "toolCalls": len(tool_item_ids) + tool_events_without_ids,
            "modelCompletions": model_completions,
            "approvalRequests": approval_requests,
            "verificationAttempts": verification_attempts,
            "projectedVerificationPhases": sum(phase.kind == "verify" for phase in phases),
            "projectedRepairPhases": sum(phase.kind == "repair" for phase in phases),
        },
        "observability": {
            "modelCompletions": "observedFromRawResponseCompletedEvents",
            "approvalRequests": "observedFromCapturedServerRequests",
            "verificationAttempts": (
                receipt_counts["verificationAttemptsBasis"]
                if receipt_counts["verificationAttempts"] is not None
                else "derivedFromExplicitPhaseLabelsAndReviewItems"
            ),
        },
        "privacy": _privacy_contract(active_limits),
        "warnings": [],
        "graph": graph,
    }


def _graph(phases: Sequence[_Phase], limits: ProjectionLimits) -> dict[str, Any]:
    nodes: list[dict[str, Any]] = []
    for index, phase in enumerate(phases, start=1):
        node_id = f"phase:{index:04d}"
        labels = _deduplicate(phase.tool_labels)
        visible_labels = labels[: limits.max_tool_labels]
        nodes.append(
            {
                "id": node_id,
                "type": "phaseProjection",
                "kind": phase.kind,
                "title": phase.title,
                "derived": True,
                "confidence": phase.confidence,
                "summary": _truncate(_phase_summary(phase), limits.max_summary_chars),
                "turnIds": phase.turn_ids,
                "itemIds": phase.item_ids,
                "eventRefs": phase.event_refs,
                "sourceEventIds": phase.source_event_ids,
                "counts": {
                    "items": phase.item_count,
                    "events": phase.event_count,
                    "toolCalls": len(phase.tool_item_ids) + phase.unidentified_tool_calls,
                    "modelCompletions": phase.model_completions,
                },
                "toolBurst": {
                    "totalObservations": len(phase.tool_item_ids) + phase.unidentified_tool_calls,
                    "byType": dict(sorted(phase.tool_types.items())),
                    "byAction": dict(sorted(phase.tool_actions.items())),
                    "labels": visible_labels,
                    "labelsTruncated": len(labels) > len(visible_labels),
                },
                "statuses": dict(sorted(phase.statuses.items())),
            }
        )
    edges = [
        {
            "id": f"edge:{index:04d}",
            "type": "projectedNext",
            "source": nodes[index - 1]["id"],
            "target": nodes[index]["id"],
            "derived": True,
        }
        for index in range(1, len(nodes))
    ]
    return {"nodes": nodes, "edges": edges}


def _item_phase_kind(item: Mapping[str, Any], *, seen_verification: bool) -> str:
    item_type = _item_type(item)
    if item_type == "userMessage":
        return "task"
    if item_type == "hookPrompt":
        return "context"
    if item_type in {"reasoning", "plan"}:
        return "plan"
    if item_type == "agentMessage":
        return "deliver"
    if item_type == "commandExecution":
        return _command_kind(item, seen_verification=seen_verification)
    if item_type == "fileChange":
        return "repair" if seen_verification else "change"
    if item_type == "mcpToolCall":
        return "explore" if item.get("readOnlyHint") is True else "integrate"
    if item_type == "dynamicToolCall":
        return "execute"
    if item_type in {"collabAgentToolCall", "subAgentActivity"}:
        return "delegate"
    if item_type in {"webSearch", "imageView"}:
        return "explore"
    if item_type == "imageGeneration":
        return "create"
    if item_type == "sleep":
        return "wait"
    if item_type in {"enteredReviewMode", "exitedReviewMode"}:
        return "verify"
    if item_type == "contextCompaction":
        return "context"
    return "runtime"


def _command_kind(item: Mapping[str, Any], *, seen_verification: bool) -> str:
    command = _string(item.get("command"))
    actions = {_string(action.get("type")).lower() for action in _command_actions(item)}
    if actions and actions <= _READ_ACTIONS:
        return "explore"
    if _VERIFY_COMMAND.search(command):
        return "verify"
    if _SHIP_COMMAND.search(command):
        return "ship"
    if _CHANGE_COMMAND.search(command):
        return "repair" if seen_verification else "change"
    return "execute"


def _event_phase_kind(
    event: Mapping[str, Any],
    method: str,
    item: Mapping[str, Any],
    *,
    resolved_approval: bool,
    seen_verification: bool,
) -> tuple[str, str]:
    if "requestApproval" in method or resolved_approval:
        return "approval", "protocol"
    explicit = _string(event.get("phase")).lower()
    if explicit:
        if explicit.startswith("verifier") or "verify" in explicit:
            return "verify", "explicit"
        if "repair" in explicit:
            return "repair", "explicit"
        if explicit in {"setup", "memory", "solver", "output", "error"}:
            return {
                "setup": "setup",
                "memory": "memory",
                "solver": "execute",
                "output": "deliver",
                "error": "error",
            }[explicit], "explicit"
    if item:
        return _item_phase_kind(item, seen_verification=seen_verification), "protocol"
    if method.startswith("turn/"):
        return "turn", "protocol"
    if method.startswith("rawResponse"):
        return "model", "protocol"
    if method == "thread/tokenUsage/updated":
        return "usage", "protocol"
    return "runtime", "heuristic"


def _phase_summary(phase: _Phase) -> str:
    tools = len(phase.tool_item_ids) + phase.unidentified_tool_calls
    parts: list[str] = []
    if tools:
        types = ", ".join(
            f"{count} {_display_type(item_type)}" for item_type, count in phase.tool_types.items()
        )
        parts.append(f"{tools} tool item reference{'s' if tools != 1 else ''}: {types}")
    if phase.model_completions:
        parts.append(
            f"{phase.model_completions} observed model completion"
            f"{'s' if phase.model_completions != 1 else ''}"
        )
    if phase.item_count and not tools:
        parts.append(f"{phase.item_count} persisted item{'s' if phase.item_count != 1 else ''}")
    if phase.event_count and not parts:
        parts.append(f"{phase.event_count} captured event{'s' if phase.event_count != 1 else ''}")
    return "; ".join(parts) or "Derived from source ordering."


def _tool_actions(item: Mapping[str, Any]) -> list[str]:
    actions = [
        _string(action.get("type"), "unknown")
        for action in _command_actions(item)
        if isinstance(action, Mapping)
    ]
    return actions or [_item_type(item)]


def _command_actions(item: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    value = item.get("commandActions", [])
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes)):
        return []
    return [action for action in value if isinstance(action, Mapping)]


def _tool_label(item: Mapping[str, Any]) -> str:
    item_type = _item_type(item)
    if item_type == "commandExecution":
        actions = _tool_actions(item)
        return "+".join(_display_type(action) for action in actions[:3])
    if item_type == "mcpToolCall":
        server = _string(item.get("server"), "MCP")
        tool = _string(item.get("tool"), "tool")
        return f"{server}.{tool}"
    if item_type == "dynamicToolCall":
        namespace = _string(item.get("namespace"))
        tool = _string(item.get("tool"), "tool")
        return f"{namespace}.{tool}" if namespace else tool
    return _display_type(item_type)


def _receipt_observability(receipt: Mapping[str, Any] | None) -> dict[str, Any]:
    if receipt is None:
        return {
            "modelCompletions": None,
            "approvalRequests": None,
            "verificationAttempts": None,
            "modelCompletionsBasis": "notObservableFromThreadRead",
            "approvalRequestsBasis": "notPersistedInThreadItems",
            "verificationAttemptsBasis": "notKnownWithoutHarnessReceipt",
        }
    observed_value = receipt.get("observed", {})
    observed = observed_value if isinstance(observed_value, Mapping) else {}
    verification_value = receipt.get("verification", [])
    verification = verification_value if isinstance(verification_value, Sequence) else []
    timeline_value = receipt.get("timeline", [])
    timeline = timeline_value if isinstance(timeline_value, Sequence) else []
    return {
        "modelCompletions": _optional_int(observed.get("modelCompletions")),
        "approvalRequests": sum(
            1
            for event in timeline
            if isinstance(event, Mapping) and "approval" in _string(event.get("kind")).lower()
        ),
        "verificationAttempts": len(verification),
        "modelCompletionsBasis": "observedInWeaveReceipt",
        "approvalRequestsBasis": "derivedFromWeaveReceiptTimeline",
        "verificationAttemptsBasis": "observedInWeaveReceipt",
    }


def _privacy_contract(limits: ProjectionLimits) -> dict[str, Any]:
    return {
        "mode": "structuralMetadataOnly",
        "excluded": [
            "userMessageText",
            "agentMessageText",
            "reasoningContent",
            "commandStrings",
            "commandOutput",
            "toolArgumentsAndResults",
            "fileContentsAndDiffs",
        ],
        "included": [
            "sourceIdentifiers",
            "protocolMethods",
            "itemAndActionTypes",
            "toolNames",
            "statuses",
            "aggregateCounts",
        ],
        "displayLimits": {
            "summaryCharacters": limits.max_summary_chars,
            "toolLabelsPerPhase": limits.max_tool_labels,
        },
        "identifiersTruncated": False,
    }


def _source_event_id(event: Mapping[str, Any], params: Mapping[str, Any]) -> str | int | None:
    for value in (event.get("id"), params.get("requestId"), params.get("eventId")):
        if isinstance(value, str) and value:
            return value
        if isinstance(value, int) and not isinstance(value, bool):
            return value
    return None


def _event_turn_id(params: Mapping[str, Any]) -> str | None:
    turn_value = params.get("turn", {})
    turn = turn_value if isinstance(turn_value, Mapping) else {}
    return _string(params.get("turnId")) or _string(turn.get("id")) or None


def _item_type(item: Any) -> str:
    return _string(item.get("type"), "unknown") if isinstance(item, Mapping) else "unknown"


def _string(value: Any, default: str = "") -> str:
    return value if isinstance(value, str) and value else default


def _optional_int(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _display_type(value: str) -> str:
    return re.sub(r"(?<!^)(?=[A-Z])", " ", value).lower()


def _phase_title(kind: str) -> str:
    return {
        "approval": "Human approval",
        "change": "Change the workspace",
        "context": "Prepare context",
        "create": "Create an artifact",
        "delegate": "Coordinate agents",
        "deliver": "Deliver the result",
        "error": "Handle an error",
        "execute": "Work toward the goal",
        "explore": "Inspect and understand",
        "integrate": "Use connected tools",
        "memory": "Prepare memory",
        "model": "Model work",
        "plan": "Plan the approach",
        "repair": "Repair after feedback",
        "runtime": "Runtime activity",
        "setup": "Set up the run",
        "ship": "Publish the change",
        "task": "Understand the task",
        "turn": "Turn lifecycle",
        "usage": "Usage update",
        "verify": "Check the result",
        "wait": "Wait for work",
    }.get(kind, "Runtime activity")


def _truncate(value: str, limit: int) -> str:
    return value if len(value) <= limit else value[: limit - 1].rstrip() + "…"


def _deduplicate(values: Sequence[str]) -> list[str]:
    return list(dict.fromkeys(value for value in values if value))
