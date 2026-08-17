# Product examples

These examples explain the WeaveCodex control abstraction. They are not benchmark results.

`flappy-bird-observation.json` records privacy-reduced structural counts from one local Codex
thread. The source projection intentionally excluded prompts beyond the stated task, response
bodies, command strings and output, tool arguments/results, file contents, diffs, and reasoning
content. Its hash binds the complete local projection used to create the summary; that private
projection is not included in this repository.

The observation demonstrates why a Work phase is not a tool-call block: a small number of
goal-level turns can contain many adaptive tool actions. It does not establish that Weave improves
quality, cost, or task success over ordinary Codex.

`checkout-repair-design.json` is a second, explicitly illustrative example. It contrasts one
ordinary task prompt with a human-authored reproduce → approve → repair → verify program. It was
not executed and carries no performance claim.

`database-migration-design.json`, `monorepo-upgrade-design.json`, and
`incident-response-design.json` are more complex reusable programs. They separate evidence
gathering and planning from an explicit human decision, implementation, and bounded verification.
They also define suggested starting paths, but Codex may inspect other workspace files inside its
native tool loop. All three are design examples rather than executed comparisons.
