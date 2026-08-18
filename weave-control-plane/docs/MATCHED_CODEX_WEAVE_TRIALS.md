# Ordinary Codex versus WeaveCodex: three matched product trials

On 18 August 2026, we ran three small local tasks twice: once through ordinary Codex and once
through WeaveCodex. All six runs used the same ChatGPT-authenticated Codex CLI, `gpt-5.6-terra`
at low reasoning effort, a workspace-write sandbox, denied escalations, and memory off.

Ordinary Codex received one controller turn. WeaveCodex executed three authored turns:
**inspect evidence → produce the result → verify the artifact**. The Weave arm also requested one
integration in named phases. The starting files were byte-identical between arms, and deterministic
graders scored the resulting files.

| Task | Ordinary | Weave | Model completions, ordinary → Weave | Integration evidence |
|---|---:|---:|---:|---|
| Regional finance variance | 8/8 | 8/8 | 4 → 8 | Spreadsheet skill requested; skill loading is not exposed as a run item. |
| Codex app-server contract | 7/7 | 7/7 | 7 → 14 | `openaiDeveloperDocs.search_openai_docs` observed as a completed MCP tool item. |
| Accessible confirmation dialog | 8/8 | 8/8 | 4 → 24 | Code-review skill requested; the run emitted subagent activity, but no skill-loaded event exists. |

Across all three tasks, ordinary Codex used 15 model completions and Weave used 46. The final
app-server token-usage updates reported 448,476 input and 1,998 output tokens for ordinary Codex,
versus 1,424,224 input and 6,810 output tokens for Weave. These are app-server usage events under
the existing ChatGPT login, not invoice-level cost attribution.

The result is not that Weave is "better." Both arms produced accepted artifacts. Weave made the
workflow contract, stage handoffs, verification decision, and integration request inspectable, but
it spent roughly three times the model completions. The smallest frontend task was the clearest
warning: a broad code-review request induced substantial subagent work without changing the scored
outcome. The product therefore defaults to explicit phase scope and shows requested integration
identity separately from observed use.

## Evidence boundary

- This is a three-fixture product acceptance probe, not a benchmark.
- There was one rollout per arm and no sampling control.
- Compute was intentionally not matched: the control-plane structure is the treatment.
- Skills do not currently emit a stable "skill loaded" item, so a request is not proof of use.
- MCP use is attributed only when a completed MCP/dynamic tool item appears in the receipt.
- Full local events remain ignored under `.weave-codex/`; the tracked
  [`matched-trials.json`](../weave_codex/static/matched-trials.json) contains graders, counts,
  hashes, and claim limits without raw prompts or model responses.

Regrade the preserved local receipts without making a Codex call:

```bash
cd weave-control-plane
PYTHONPATH=. uv run python scripts/run_matched_codex_trials.py \
  --regrade-existing \
  --work-root .weave-codex/matched-trials-v1 \
  --summary-out weave_codex/static/matched-trials.json
```
