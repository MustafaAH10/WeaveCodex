# Codex harness source audit

This is the evidence ledger for
[`CODEX_HARNESS_INTERNALS.md`](./CODEX_HARNESS_INTERNALS.md). It is deliberately
compact: the article explains the system; this file makes the source audit
repeatable.

## Provenance

- Official upstream: <https://github.com/openai/codex>
- Pinned upstream commit:
  `9ded177ce7c1c0bd2047f902936c177612ab3434`
- Pinned tree: `80af093a595d2e4a0b45dd666f5390e9dbad5d98`
- Exact downstream import: local commit `34998ea`, whose tree equals the pinned
  upstream tree
- Public integration contract:
  <https://learn.chatgpt.com/docs/app-server>

“Public” below means documented by OpenAI. “Implementation” means observed in
the pinned source and must not be treated as a compatibility promise. “Proposal”
means a Weave decision.

## Audit map

<!-- markdownlint-disable MD013 MD060 -->

| Concern | Evidence class | Exact source path or public page | Symbols / section inspected | Finding used by Weave |
|---|---|---|---|---|
| Transport and initialization | Public + implementation | `codex-rs/app-server/README.md` | Protocol, Lifecycle Overview, Initialization | One initialize handshake per connection; stdio JSONL is the default; experimental WebSocket exists; bounded ingress can reject with `-32001`. |
| Versioned schemas | Public + implementation | `codex-rs/app-server/README.md` | Message Schema, Experimental API Opt-in | Generate types from the deployed binary; experimental fields require explicit opt-in and have no compatibility guarantee. |
| Thread/turn/item model | Public + implementation | `codex-rs/app-server/README.md`; `codex-rs/app-server-protocol/src/protocol/v2/thread_data.rs` | Core Primitives; `Thread`, `Turn`, `ThreadItemsView` | These are lifecycle and history units, not authoring blocks. |
| Turn controls | Public + implementation | `codex-rs/app-server-protocol/src/protocol/v2/turn.rs` | `TurnStartParams`, `TurnSteerParams`, `TurnInterruptParams`, `TurnStatus` | A phase can control context/settings at turn start, steer an active turn, or interrupt it. |
| Semantic items | Implementation | `codex-rs/app-server-protocol/src/protocol/v2/item.rs` | `ThreadItem`, item notifications and deltas | Typed items are sufficient for a semantic trace UI; variants can evolve. |
| Core agent loop | Implementation | `codex-rs/core/src/session/turn.rs` | `run_turn`, `build_prompt`, `run_sampling_request`, `try_run_sampling_request` | A turn repeatedly samples and executes tools until no follow-up remains; it is not one model call or one tool call. |
| Tool completion recording | Implementation | `codex-rs/core/src/stream_events_utils.rs` | `handle_output_item_done` and completion helpers | Completed items are recorded promptly, including before later cancellation. |
| Parallel tool runtime | Implementation | `codex-rs/core/src/tools/parallel.rs` | `ToolCallRuntime` | Parallel-safe calls use shared locking; non-parallel calls serialize; cancellation participates in dispatch. |
| Tool registry and hooks | Implementation | `codex-rs/core/src/tools/registry.rs`; `codex-rs/core/src/tools/router.rs` | registrations, routing, pre/post tool hooks | Capabilities can be contributed/hidden/deferred; hooks can block or alter model-visible feedback. |
| Approval and sandbox | Public + implementation | `codex-rs/app-server/README.md`; `codex-rs/core/src/tools/orchestrator.rs` | Approvals; `ToolOrchestrator` | Approval, sandbox selection, first attempt, and optional escalated retry are distinct steps. |
| Context history | Implementation | `codex-rs/core/src/context_manager/history.rs` | `ContextManager::record_items`, `for_prompt`, replacement and baseline methods | Stored history is append-ordered but normalized and truncated for the next prompt. |
| Step context | Implementation | `codex-rs/core/src/session/mod.rs` | `capture_step_context`, context recording methods | Model-visible tools/environment are captured consistently per sampling step. |
| Typed world state | Implementation | `codex-rs/core/src/session/world_state.rs`; `codex-rs/core/src/context/world_state/mod.rs` | world-state builders, snapshots and diffs | Instructions, permissions, environment, extensions, etc. are typed sections with full/diff reinjection behavior. |
| Compaction | Public + implementation | `codex-rs/app-server/README.md`; `codex-rs/core/src/compact.rs` | compact API; `run_compact_task`, `build_compacted_history` | Compaction transforms the model-visible history and preserves a compaction record; it is not deletion of the trace. |
| Skills | Public + implementation | <https://learn.chatgpt.com/docs/build-skills>; `codex-rs/app-server/README.md`; `codex-rs/core/src/session/turn.rs` | skill input item and turn injection | Skills contribute instructions/resources; they do not define a fixed low-level execution DAG. |
| MCP and apps | Public + implementation | <https://learn.chatgpt.com/docs/extend/mcp?surface=cli>; `codex-rs/app-server/README.md` | initialization extensions, Apps, MCP elicitations | MCP/app capabilities are policy-filtered model-visible tools. The session's MCP extension profile is fixed and inherited by subagents. |
| Built-in memory | Implementation | `codex-rs/memories/README.md`; `codex-rs/ext/memories/src/extension.rs` | two-stage pipeline, `MemoriesExtension` | Built-in memory is extracted and consolidated recall, not arbitrary selection of raw prior traces. |
| Subagents | Implementation | `codex-rs/core/src/agent/control.rs`; `codex-rs/core/src/agent/control/spawn.rs`; `codex-rs/core/src/agent/control/execution.rs` | `AgentControl`, spawn and execution capacity | A subagent is a persisted child thread in a root session tree; status, execution capacity, and residency are managed separately. |
| Durable rollout | Implementation | `codex-rs/history/src/lib.rs`; `codex-rs/rollout/src/policy.rs`; `codex-rs/rollout/src/recorder.rs` | `RolloutItem`, `should_persist_event_msg`, `RolloutRecorder` | The normal rollout is durable conversation state, not a record of every transient event. |
| Optional raw trace | Internal implementation | `codex-rs/rollout-trace/README.md`; `codex-rs/rollout-trace/src/raw_event.rs` | trace bundle format, `RawTraceEvent`, `RawTraceEventPayload` | Opt-in local diagnostic data can support deep visualization but is sensitive, best-effort, and not a public stable protocol. |
| Retry | Implementation | `codex-rs/core/src/responses_retry.rs` | `ResponsesStreamRetryState`, `handle_retryable_response_stream_error` | Retryable stream errors use delay/backoff and can switch transport; they need not fail the phase. |
| Terminal turn mapping | Implementation | `codex-rs/app-server/src/bespoke_event_handling.rs` | `handle_turn_complete`, `handle_turn_interrupted` | App-server projects core completion, failure, and abort into terminal v2 turn status and clears pending server requests. |

<!-- markdownlint-enable MD013 MD060 -->

## Public versus internal event boundaries

Use these terms precisely:

- **App-server notification:** the client protocol surface documented by OpenAI
  and represented in generated schemas. Individual experimental notifications
  remain experimental.
- **Raw Responses item notification:** an app-server projection available in the
  pinned protocol. It exposes a completed Responses item, not hidden model state.
- **Durable rollout:** selected JSONL history used for persistence/resume; its
  event policy intentionally filters transient data.
- **Raw rollout trace:** the internal, environment-variable-gated diagnostic
  bundle under `codex-rs/rollout-trace`. It is not the stable app-server API and
  should never be enabled or uploaded silently.

## Claims intentionally *not* made

- The client can see the model's private chain of thought.
- Ordinary thread history is a byte-perfect replay of a live session.
- A turn or phase is deterministic when repeated.
- Interrupting a turn rolls back files or external side effects.
- Built-in memory is a graph of complete past trajectories.
- App-server exposes a stable per-turn allowlist for every first-party tool.
- Internal raw trace event shapes are a supported public contract.
- Experimental fields will remain compatible across Codex versions.

## Verification performed for this audit

- Confirmed local import commit `34998ea` has tree
  `80af093a595d2e4a0b45dd666f5390e9dbad5d98`, matching
  `weave-control-plane/UPSTREAM.md`.
- Confirmed every repository path cited by the article exists in the imported
  tree.
- Confirmed the official App Server, Skills, MCP, and Security pages return
  successfully.
- Confirmed every commit-pinned GitHub source link in the article resolves.
- Ran `git diff --check` on the new documentation.
