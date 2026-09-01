import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = await readFile(path.join(root, "index.html"), "utf8");
const css = await readFile(path.join(root, "site.css"), "utf8");
const script = await readFile(path.join(root, "site.js"), "utf8");

test("the public website is standalone and never opens the local app", () => {
  assert.match(html, /href="site\.css"/);
  assert.match(html, /src="site\.js"/);
  assert.doesNotMatch(html, /<(?:script|link)[^>]+https?:\/\//);
  assert.doesNotMatch(css, /@import|url\(["']?https?:\/\//);
  assert.doesNotMatch(script, /fetch\(|XMLHttpRequest|\/api\//);
  assert.doesNotMatch(html, /127\.0\.0\.1:8790[^<]*Open local app/);
  assert.doesNotMatch(html, /Open local app/);
});

test("examples are concrete and expose a complete tab contract", () => {
  const tabIds = [...html.matchAll(/id="(tab-[^"]+)" role="tab"/g)].map((match) => match[1]);
  const panelIds = [...html.matchAll(/id="(panel-[^"]+)" role="tabpanel"/g)].map((match) => match[1]);
  const controls = [...html.matchAll(/aria-controls="([^"]+)"/g)].map((match) => match[1]);

  assert.deepEqual(tabIds, ["tab-finance", "tab-frontend", "tab-incident"]);
  assert.deepEqual(panelIds, ["panel-finance", "panel-frontend", "panel-incident"]);
  assert.deepEqual(controls, panelIds);
  for (const phrase of ["Reconcile totals", "Test accessibility", "Run regression"]) assert.match(html, new RegExp(phrase));
  assert.match(script, /ArrowLeft/);
  assert.match(script, /ArrowRight/);
});

test("workflow, animation, and copy controls have accessible semantics", () => {
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length, "HTML ids must be unique");
  assert.equal((html.match(/role="img"/g) ?? []).length, 1);
  assert.equal((html.match(/class="rail-node/g) ?? []).length, 6);
  assert.match(html, /class="copy-label" aria-live="polite"/);
  assert.match(script, /IntersectionObserver/);
  assert.match(script, /playWorkflow/);
  assert.match(html, /data-copy="codex login&#10;cd weave-control-plane &amp;&amp; uv sync&#10;uv run python -m weave_codex\.server --codex-bin &quot;\$\(command -v codex\)&quot; --host 127\.0\.0\.1 --port 8790"/);
});

test("copy is concise and preserves the product boundary", () => {
  assert.match(html, /Codex does the work/);
  assert.match(html, /You design the path/);
  assert.match(html, /official local Codex app-server/);
  assert.match(html, /Independent\. Open source\. Built on Codex\./);
  assert.doesNotMatch(`${html}${script}`, /[—–]/);
  assert.doesNotMatch(html, /complete turn|not a tool call/i);
});
