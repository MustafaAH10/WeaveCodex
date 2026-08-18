# Repository harness trials in an isolated Runloop devbox

We ran three real, memory-off WeaveCodex programs against fresh pinned clones of
Click, Requests, and Express. Codex authenticated inside the devbox through its
official ChatGPT device flow. No local Codex credential file, OAuth token, or
API key was copied into the sandbox.

This was a product acceptance study, not a benchmark. The questions asked Codex
to explain existing behavior from source and tests; they did not assert that an
upstream project had a defect.

## What was authored

Every repository used the same goal-level control shape:

```text
Pinned task
  → Map evidence (one Codex turn, any number of native tools)
  → Operator checkpoint
  → Trace and test (one Codex turn)
  → Adversarial challenge (one Codex turn)
  → Structured verification (one Codex turn)
  → Source-linked receipt
```

This is the product boundary in concrete form. We did not make 76 model
completions or 44 shell commands into canvas blocks. A person authored 12 Work
or Verify turns across three programs; Codex managed the internal activity.

## Outcome

| Repository question | Artifact | External test | Controller turns | Model completions | Commands |
|---|---:|---:|---:|---:|---:|
| Click nested `default_map` resolution | accepted | exit 0 | 4 | 25 | 14 |
| Requests proxy/environment precedence | accepted | exit 0 | 4 | 23 | 13 |
| Express asynchronous error propagation | accepted | exit 0 | 4 | 28 | 17 |
| **Total** | **3/3** | **3/3** | **12** | **76** | **44** |

The three runs reported 3,184,512 input tokens, of which 2,753,280 were cached,
and 31,557 output tokens. Those are Codex app-server usage events, not an invoice
or a normalized efficiency comparison.

Each independent grader required:

- the exact pinned commit;
- at least three findings and four distinct tracked file references;
- both source and test evidence;
- task-specific symbols or concepts;
- no changes to tracked upstream files; and
- a separately rerun, predeclared test command with exit code 0.

The result JSON links every cited sandbox path to a SHA-256 digest. Examples
include:

- `/home/user/weave-lab/repos/click/src/click/core.py`
- `/home/user/weave-lab/repos/requests/src/requests/sessions.py`
- `/home/user/weave-lab/repos/express/lib/application.js`

The dashboard is at
[`/sandbox-trials.html`](http://127.0.0.1:8790/sandbox-trials.html) when the
local WeaveCodex server is running. The machine-readable result is
[`sandbox-trials.json`](../weave_codex/static/sandbox-trials.json), and the
three final evidence artifacts are in [`examples/sandbox-trials/`](../examples/sandbox-trials/).

## What the trial exposed

The abstraction held up: repository complexity changed the amount of internal
Codex work without changing the small authored program. Express needed 28 model
completions and 17 command items; Requests needed 23 and 13. The canvas should
therefore show goal phases and let users expand a phase into observed activity,
not pretend that users can sensibly hand-author every native action.

The trial also found two mundane but important release problems before evidence
was published:

1. Dependency setup changed generated lock files in two clones. Those setup-only
   artifacts were restored/removed before the source-integrity regrade.
2. The first grader treated `.weave-codex/traces/` as an upstream source change.
   We fixed it to distinguish runtime evidence from repository edits and rebuilt
   the public result from preserved receipts without another model call.

The Express artifact records one environment limitation: the sandbox blocked a
direct TCP listening attempt. The predeclared Express Mocha suites still ran to
completion with exit code 0, so the result retains the limitation rather than
hiding it.

## Reproduce the harness layer

The full cloud setup is provider-specific, but the runner itself is ordinary
Python. After cloning the three repositories and signing Codex in:

```bash
cd weave-control-plane
PYTHONPATH=. uv run python scripts/run_sandbox_repo_trials.py \
  --repos-root /absolute/path/to/repos \
  --raw-root /private/path/to/raw-receipts \
  --summary-out weave_codex/static/sandbox-trials.json \
  --model gpt-5.6-terra \
  --execute \
  --confirm-three-subscription-harnesses
```

For a remote machine, `codex login --device-auth` uses the official short-lived
ChatGPT device flow. Do not copy `~/.codex/auth.json` between machines.

The tracked [evidence manifest](../examples/sandbox-trials/evidence-manifest.json)
binds the devbox, repository commits, frozen runner, sanitized artifacts, and
unpublished raw-receipt hashes.

## Claim limits

- One rollout per repository cannot establish reliability or a quality gain.
- There is no ordinary-Codex arm in this study; earlier matched trials cover a
  different set of local product fixtures.
- The operating agent accepted each checkpoint after the initial map phase.
- The raw receipts stay in the isolated devbox because they contain full task
  execution material; only the sanitized projections and public-source evidence
  are committed.
- Subscription usage events do not provide invoice-level cost attribution.
