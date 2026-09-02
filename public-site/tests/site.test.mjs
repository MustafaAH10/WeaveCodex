import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = await readFile(path.join(root, "index.html"), "utf8");
const css = await readFile(path.join(root, "site.css"), "utf8");
const script = await readFile(path.join(root, "site.js"), "utf8");
const workflowSource = await readFile(path.join(root, "workflows.js"), "utf8");
const comparisonSource = await readFile(path.join(root, "comparisons.js"), "utf8");
await import(pathToFileURL(path.join(root, "workflows.js")));
await import(pathToFileURL(path.join(root, "comparisons.js")));
const workflows = globalThis.WEAVE_WORKFLOWS;
const comparisons = globalThis.WEAVE_COMPARISONS;

test("the public website is standalone and never opens the local app", () => {
  assert.match(html, /href="site\.css(?:\?[^\"]*)?"/);
  assert.match(html, /src="workflows\.js(?:\?[^\"]*)?"/);
  assert.match(html, /src="comparisons\.js(?:\?[^\"]*)?"/);
  assert.match(html, /src="site\.js(?:\?[^\"]*)?"/);
  assert.doesNotMatch(html, /<(?:script|link)[^>]+https?:\/\//);
  assert.doesNotMatch(css, /@import|url\(["']?https?:\/\//);
  assert.doesNotMatch(script, /fetch\(|XMLHttpRequest|\/api\//);
  assert.doesNotMatch(html, /Open local app|href="http:\/\/127\.0\.0\.1:8790/);
});

test("all four examples are non-linear executable DAGs", () => {
  assert.deepEqual(Object.keys(workflows), ["finance", "campaign", "crm", "frontend"]);
  for (const [key, workflow] of Object.entries(workflows)) {
    assert.ok(workflow.nodes.length >= 9 && workflow.nodes.length <= 10, `${key} has a useful number of steps`);
    const ids = new Set(workflow.nodes.map((node) => node.id));
    assert.equal(ids.size, workflow.nodes.length, `${key} node ids are unique`);
    const incoming = new Map(workflow.nodes.map((node) => [node.id, 0]));
    const outgoing = new Map(workflow.nodes.map((node) => [node.id, []]));
    for (const [from, to] of workflow.edges) {
      assert.ok(ids.has(from) && ids.has(to), `${key} edge endpoints exist`);
      outgoing.get(from).push(to);
      incoming.set(to, incoming.get(to) + 1);
    }
    assert.ok([...outgoing.values()].some((targets) => targets.length > 1), `${key} visibly branches`);
    assert.ok([...incoming.values()].some((count) => count > 1), `${key} visibly merges`);
    assert.ok(workflow.nodes.some((node) => node.kind === "human"), `${key} has a human decision`);
    assert.ok(workflow.nodes.some((node) => node.kind === "check"), `${key} has an exact check`);

    const sources = [...incoming].filter(([, count]) => count === 0).map(([id]) => id);
    const sinks = [...outgoing].filter(([, targets]) => targets.length === 0).map(([id]) => id);
    assert.equal(sources.length, 1, `${key} has one explicit start`);
    assert.equal(sinks.length, 1, `${key} has one explicit result`);
    const reachable = new Set(sources);
    const frontier = [...sources];
    while (frontier.length) {
      for (const target of outgoing.get(frontier.shift())) {
        if (reachable.has(target)) continue;
        reachable.add(target);
        frontier.push(target);
      }
    }
    assert.equal(reachable.size, workflow.nodes.length, `${key} connects every authored step to the start`);

    const queue = [...incoming].filter(([, count]) => count === 0).map(([id]) => id);
    let visited = 0;
    while (queue.length) {
      const id = queue.shift();
      visited += 1;
      for (const target of outgoing.get(id)) {
        incoming.set(target, incoming.get(target) - 1);
        if (incoming.get(target) === 0) queue.push(target);
      }
    }
    assert.equal(visited, workflow.nodes.length, `${key} graph is acyclic and fully connected`);
  }
});

test("the graph renderer draws exact edges and supports switching and animation", () => {
  assert.equal((html.match(/data-workflow-key=/g) ?? []).length, 4);
  assert.match(html, /id="workflow-graph" role="img"/);
  assert.match(script, /for \(const \[fromId, toId\] of workflow\.edges\)/);
  assert.match(script, /createElementNS/);
  assert.match(script, /playWorkflowGraph/);
  assert.match(script, /IntersectionObserver/);
  assert.match(script, /ArrowLeft/);
  assert.match(script, /ArrowRight/);
});

test("the control comparison uses four concrete user-authored workflow graphs", () => {
  assert.deepEqual(Object.keys(comparisons), ["finance", "campaign", "vendor", "release"]);
  assert.equal((html.match(/data-comparison-key=/g) ?? []).length, 4);
  for (const [key, comparison] of Object.entries(comparisons)) {
    assert.equal(comparison.nodes.length, 8, `${key} has a concise but substantive decomposition`);
    const ids = new Set(comparison.nodes.map((node) => node.id));
    const edges = comparison.edges.map((edge) => Array.isArray(edge) ? { from: edge[0], to: edge[1], kind: "route" } : edge);
    const outgoing = new Map(comparison.nodes.map((node) => [node.id, 0]));
    for (const edge of edges) {
      assert.ok(ids.has(edge.from) && ids.has(edge.to), `${key} edge endpoints exist`);
      outgoing.set(edge.from, outgoing.get(edge.from) + 1);
    }
    assert.ok([...outgoing.values()].some((count) => count > 1), `${key} visibly branches`);
    assert.ok(comparison.nodes.some((node) => node.kind === "human"), `${key} exposes calibration`);
    assert.ok(comparison.nodes.some((node) => node.kind === "check"), `${key} has an exact check`);
    assert.ok(edges.some((edge) => edge.kind === "recovery"), `${key} has a named recovery edge`);
    assert.deepEqual(Object.keys(comparison.contracts), ["evidence", "calibration", "check", "recovery"]);
    assert.equal(comparison.codex.route.length, 4);
    assert.match(comparison.codex.note, /inside the|inside an|inside.*run|implicit/i);
  }
  assert.match(script, /function playComparison\(\)/);
  assert.match(script, /renderComparisonGraph/);
  assert.match(script, /comparison-recovery-arrow/);
  assert.match(script, /comparisonObserver/);
  assert.match(html, /This illustrates the control surfaces, not a claim that Codex fails/);
});

test("copy is concise and preserves the product boundary", () => {
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length, "HTML ids must be unique");
  assert.match(html, /Decide the route/);
  assert.match(html, /Same Codex, a route you own/);
  assert.match(html, /Lock the intent, evidence, and recovery path/);
  assert.match(html, /Route drawn before the run/);
  assert.match(html, /official local Codex app-server/);
  assert.match(html, /Independent\. Open source\. Built on Codex\./);
  assert.match(html, /class="copy-label" aria-live="polite"/);
  assert.equal((html.match(/class="copy-button"/g) ?? []).length, 4);
  assert.match(html, /git clone https:\/\/github\.com\/MustafaAH10\/WeaveCodex\.git/);
  assert.doesNotMatch(`${html}${script}`, /[—–]/);
  assert.doesNotMatch(`${html}${workflowSource}${comparisonSource}`, /\b(?:approve|approval|operator gate|human gate)\b/i);
  assert.doesNotMatch(html, /complete turn|not a tool call/i);
});
