import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = await readFile(path.join(root, "index.html"), "utf8");
const css = await readFile(path.join(root, "site.css"), "utf8");
const script = await readFile(path.join(root, "site.js"), "utf8");

test("the public website is a standalone static bundle", () => {
  assert.match(html, /href="site\.css"/);
  assert.match(html, /src="site\.js"/);
  assert.doesNotMatch(html, /<(?:script|link)[^>]+https?:\/\//);
  assert.doesNotMatch(css, /@import|url\(["']?https?:\/\//);
  assert.doesNotMatch(script, /fetch\(|XMLHttpRequest|\/api\//);
  assert.doesNotMatch(html, /href="\/app(?:\/|"|#)/);
  assert.match(html, /href="http:\/\/127\.0\.0\.1:8790\/"/);
});

test("interactive examples expose a complete tab contract", () => {
  const tabIds = [...html.matchAll(/id="(tab-[^"]+)" role="tab"/g)].map((match) => match[1]);
  const panelIds = [...html.matchAll(/id="(panel-[^"]+)" role="tabpanel"/g)].map(
    (match) => match[1],
  );
  const controls = [...html.matchAll(/aria-controls="([^"]+)"/g)].map((match) => match[1]);

  assert.deepEqual(tabIds, ["tab-product", "tab-data", "tab-creative"]);
  assert.deepEqual(panelIds, ["panel-product", "panel-data", "panel-creative"]);
  assert.deepEqual(controls, panelIds);
  assert.match(script, /ArrowLeft/);
  assert.match(script, /ArrowRight/);
});

test("diagram and copy controls have accessible semantics", () => {
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length, "HTML ids must be unique");
  assert.equal((html.match(/role="img"/g) ?? []).length, 4);
  assert.match(html, /class="copy-label" aria-live="polite"/);
  assert.match(
    html,
    /data-copy="codex login&#10;cd weave-control-plane &amp;&amp; uv sync&#10;uv run python -m weave_codex\.server --codex-bin &quot;\$\(command -v codex\)&quot; --host 127\.0\.0\.1 --port 8790"/,
  );
});

test("marketing copy preserves the Codex and Weave boundary", () => {
  assert.match(html, /Each Codex block is a complete turn—not a tool call\./);
  assert.match(html, /does not replace Codex or turn every internal action into a box/);
  assert.match(html, /official local Codex app-server/);
  assert.match(html, /independent open-source project built on Codex/);
});
