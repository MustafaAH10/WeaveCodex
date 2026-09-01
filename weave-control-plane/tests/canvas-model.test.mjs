import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const model = require("../weave_codex/static/canvas-model.js");

test("orders a branching workflow by dependency", () => {
  const program = {
    phases: [
      { id: "start", kind: "work" },
      { id: "left", kind: "work" },
      { id: "right", kind: "work" },
      { id: "finish", kind: "verify" },
    ],
    edges: [
      { from: "start", to: "left" },
      { from: "start", to: "right" },
      { from: "left", to: "finish" },
      { from: "right", to: "finish" },
    ],
  };
  assert.deepEqual(model.orderedClientPhases(program).map((phase) => phase.id), ["start", "left", "right", "finish"]);
  assert.equal(model.graphProblem(program), "");
});

test("rejects loose starts, cycles, and invalid arrows", () => {
  const loose = { phases: [{ id: "a", kind: "work" }, { id: "b", kind: "work" }], edges: [] };
  assert.match(model.graphProblem(loose), /Connect/);

  const cycle = {
    phases: [{ id: "a", kind: "work" }, { id: "b", kind: "verify" }],
    edges: [{ from: "a", to: "b" }, { from: "b", to: "a" }],
  };
  assert.match(model.graphProblem(cycle), /loop/);
  assert.equal(model.wouldCreateCycle({ ...cycle, edges: [{ from: "a", to: "b" }] }, "b", "a"), true);
});

test("built-in graphs are cloned and receive stable unique IDs", () => {
  const first = model.linearGraph("review");
  const second = model.linearGraph("review");
  first.phases[0].name = "changed";
  assert.notEqual(second.phases[0].name, "changed");
  assert.equal(model.uniquePhaseId("Inspect", second), "inspect-2");
});
