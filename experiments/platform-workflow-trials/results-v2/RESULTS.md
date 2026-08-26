# Platform workflow acceptance trial

Both ordinary Codex and WeaveCodex produced contract-valid artifacts on all four tasks. The result
does **not** show that Weave makes the model smarter. It shows the product distinction we wanted to
test: the same Codex agent can be wrapped in a user-defined, observable control loop without
reducing the inner turn to a toy sequence of tool calls.

## What ran

One ChatGPT-authenticated container ran four task pairs sequentially with memory off. The ordinary
arm had one adaptive Codex turn. The Weave arm had a planning turn, a deterministic review gate, an
execution turn, and a verifier turn. A work phase could contain any number of native Codex
reasoning and tool iterations.

| Task | Ordinary Codex output | Added Weave checkpoint | Deterministic outcome |
|---|---|---|---|
| Forecast repair | Patched `forecast.py` | Root cause, intended change, test and risk plan | 3/3 unittests passed in both arms |
| Event poster | SVG and design notes | Facts, hierarchy, palette, motif and accessibility direction | Both SVGs parsed, were self-contained, and met the brief |
| Operations connector simulation | Two proposed actions | Source IDs, exclusions and no-mutation boundary | Exact two policy actions; approval required; zero mutations |
| Incident support simulation | Internal brief and customer update | Observation/inference/unknowns evidence map | Facts and citations preserved; unknown cause; no recovery promise |

All eight final artifacts passed the tightened external graders. All four Weave planning artifacts
passed their gates and the runs continued. The run observed 16 controller turns against a frozen
cap of 16: one per ordinary arm and three per Weave arm. This is a process-control comparison, not
a call-efficiency claim.

## What the checkpoint changes

In the ordinary arm, a reviewer sees the requested final artifact after one adaptive turn. In the
Weave arm, the reviewer can stop before production if the evidence map or plan is wrong. The four
saved checkpoint JSON files are deliberately plain, portable artifacts; each is bound to an
accepted checkpoint receipt in `receipts/`.

The operations trial is the clearest example. Both arms proposed the same two actions and neither
mutated the mock connector. Weave additionally exposed the eligible source records, excluded
orders, proposed actions, and safety boundary before the final JSON was written.

## Evidence and provenance

- `outcome.json` is the compact product-facing comparison.
- `curated-summary.json` contains every sanitized arm grade, artifact hash, checkpoint receipt,
  output excerpt, execution time, and controller-turn count.
- `runner-summary.json` is the immutable pre-regrade summary. The curated summary binds its hash.
- `environment-preflight.json` records the read-only source mount, fresh writable result volume,
  official ChatGPT login, absence of an API key, and successful nested `bwrap` probe.
- `artifacts/` contains only the requested final outputs and Weave checkpoint artifacts. Raw model
  events, auth material, `.git` directories, and sandbox traces are excluded.

The final grader rejects duplicate or misbound operations actions, missing reasons, modified input
fixtures, external SVG resources including quoted CSS URLs, unsupported incident claims, and the
seeded forecast regression. Its exact source SHA-256 is recorded in the curated summary.

## Invalid first attempt

The first container could not create the user namespace required by Codex's sandbox. Every arm was
blocked before fixture inspection. That attempt contributes zero valid samples and is preserved
separately in `../results-v1-invalid/incident.json`. Its prompt exposure is why the recovery is
described as acceptance evidence rather than unseen-task evidence.

## Claim limits

- There is one rollout per arm, so this does not estimate variance or general model quality.
- The review gate was applied by a deterministic evaluator standing in for a person clicking
  Continue.
- The connector is a local deterministic simulation, not a live vendor integration.
- The design grader checks an explicit brief and safety constraints, not subjective aesthetics.
- No token, latency, cost, or tool-call-count advantage is claimed.
