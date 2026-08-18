# Matched OSS implementation trials

This is a six-run product acceptance study, not a benchmark. We cloned three public repositories
at pinned commits, applied declared regressions, and ran each repair once with ordinary Codex and
once with a task-specific WeaveCodex program. Memory was disabled throughout.

## Result

| Seeded repair | Ordinary Codex | WeaveCodex | Weave program |
| --- | ---: | ---: | --- |
| Jinja autoescape case handling | Accepted · 6 completions | Accepted · 10 completions | Diagnose → checkpoint → repair → verify |
| Starlette header invariants | Accepted · 7 completions | Accepted · 11 completions | Map → adversarial cases → repair → verify |
| Commander option identity | Accepted · 5 completions | Accepted · 11 completions | Reproduce → checkpoint → repair → compatibility review → verify |

Totals: ordinary Codex used 3 controller turns and 18 observed model completions. WeaveCodex used
11 controller turns and 32 observed model completions. Both arms passed 3/3 declared upstream
checks and 3/3 independent checks. Every Weave verifier passed on its first attempt. Both authored
checkpoints were reached and accepted by the operating agent.

The result does not show a quality advantage for Weave. Ordinary Codex was sufficient for all
three repairs and used less compute. What Weave added was a reviewable controller-level program,
two between-goal human decisions, and receipts that correlate those decisions and phases with the
native Codex work. One Work phase still contains however many internal tool/model iterations Codex
needs; it is not one canvas block per tool call.

## Controls

The paired arms used the same:

- seeded repository bytes and task prompt;
- GPT-5.6 Terra at low reasoning effort;
- workspace-write sandbox and denied native protected actions;
- memory-off configuration; and
- post-run upstream plus independent tests.

Execution order alternated by repository. Weave intentionally received more controller turns, so
compute was not matched. There was one rollout per arm and no contamination claim about the model's
pretraining.

The sandbox paths were:

```text
/home/user/weave-lab/matched-oss-v2/sources/{jinja,starlette,commander}
/home/user/weave-lab/matched-oss-v2/work/<task-id>/{ordinary,weave}
/home/user/weave-lab/matched-oss-v2/raw/<task-id>/{ordinary,weave}.json
```

The raw receipts remain in the isolated Runloop devbox and are not presented as a self-contained
public evidence bundle. The repository publishes the content-addressed
[frozen plan](../weave_codex/static/oss-implementation-trials-plan.json), sanitized
[result summary](../weave_codex/static/oss-implementation-trials.json), task/seed source in
[`oss_implementation_trials.py`](../weave_codex/oss_implementation_trials.py), and the deterministic
[runner](../scripts/run_oss_implementation_trials.py).

## Pinned sources

- Jinja `5ef70112a1ff19c05324ff889dd30405b1002044`
- Starlette `398e5a3430eb1ddd33e1d48d766efe41426e231f`
- Commander `ba6d13ddb4243e5913367734f8c159089ffe7834`

The seeded regressions are synthetic and are not claims that those upstream repositories contain
the defects.
