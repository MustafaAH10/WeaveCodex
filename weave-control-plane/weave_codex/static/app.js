const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
const uid = () => `phase-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

const PHASE_TYPES = {
  task: { label: "Task", icon: "T", description: "The run-wide outcome you want.", defaultTitle: "Define the task", fixed: true },
  context: { label: "Context", icon: "C", description: "Files Codex should consider first.", defaultTitle: "Load relevant context", fixed: true },
  memory: { label: "Memory", icon: "M", description: "Prior Codex experience available to every phase.", defaultTitle: "Choose prior experience", fixed: true },
  approval: { label: "Action approvals", icon: "A", description: "Run-wide policy for protected tool actions.", defaultTitle: "Control protected actions", fixed: true },
  work: { label: "Codex Work Loop", icon: "C×", description: "One app-server turn; Codex may use many tools inside.", defaultTitle: "Do the work" },
  checkpoint: { label: "Human Checkpoint", icon: "H", description: "Pause between phases for a continue or stop decision.", defaultTitle: "Review before continuing" },
  verify: { label: "Verify + Repair", icon: "V", description: "Check the candidate and allow bounded repair turns.", defaultTitle: "Verify the result" },
  output: { label: "Output", icon: "O", description: "Final answer and observed receipt.", defaultTitle: "Return the result", fixed: true },
};

const DEFAULT_PHASES = [
  makePhase("task", { goal: "Describe the outcome you want Codex to produce." }),
  makePhase("context", { paths: "README.md" }),
  makePhase("memory", { mode: "off" }),
  makePhase("approval", { gate: "manual" }),
  makePhase("work", { goal: "Inspect the current implementation and propose a concrete plan.", reasoningEffort: "inherit" }),
  makePhase("checkpoint", { question: "Continue from the proposed plan into implementation?" }),
  makePhase("work", { goal: "Implement the approved plan and run focused tests for the change.", reasoningEffort: "inherit" }),
  makePhase("verify", { criteria: "The implementation satisfies the task and the available test evidence supports the result.", maxRepairs: 1 }),
  makePhase("output", { format: "text" }),
];

const EXAMPLES = {
  flappy: {
    name: "Flappy Bird frontend with review",
    title: "A reviewable frontend workflow",
    prompt: "Design a polished Flappy Bird frontend in this repository. Inspect what is already here, implement it, and verify it in the browser.",
    benefit: "Approve the visual direction before implementation, then require browser evidence before accepting the result.",
    contextPaths: ["README.md", "src/"],
    criteria: "The game is playable in the browser, the layout is polished at desktop and mobile sizes, controls are discoverable, and no visible console or runtime errors remain.",
    evidenceLabel: "ONE REAL LOCAL OBSERVATION",
    evidence: "A previously recorded Flappy Bird Weave run contained <b>2 controller turns</b>, <b>36 persisted items</b>, and <b>23 tool calls</b> inside Codex's own loops. This is structural evidence from one run—not an A/B test or a quality claim.",
    phases: [
      { kind: "work", title: "Inspect and propose", detail: "Understand the app, constraints, and visual direction." },
      { kind: "checkpoint", title: "Approve direction", detail: "A human decides whether implementation should begin." },
      { kind: "work", title: "Build the experience", detail: "Codex implements and iterates with its native tools." },
      { kind: "verify", title: "Browser verification", detail: "Check playability, layout, and visible error states." },
    ],
  },
  bugfix: {
    name: "Checkout diagnosis and repair",
    title: "A diagnosis-first repair workflow",
    prompt: "Find the cause of the checkout failure in this repository, make the smallest safe repair, and demonstrate that the regression is covered.",
    benefit: "Separate diagnosis from mutation, approve the evidence-backed repair direction, and bound repair attempts after verification.",
    contextPaths: ["README.md", "src/", "tests/"],
    criteria: "The reported failure is reproduced or explained, the smallest safe repair is present, and focused regression checks pass.",
    evidenceLabel: "ILLUSTRATIVE DESIGN",
    evidence: "This checkout workflow demonstrates the control model. It has not been run as a benchmark, so Weave makes no performance claim for it.",
    phases: [
      { kind: "work", title: "Reproduce and diagnose", detail: "Inspect evidence and isolate the likely failure path." },
      { kind: "checkpoint", title: "Approve repair plan", detail: "A human reviews scope before files change." },
      { kind: "work", title: "Make the repair", detail: "Codex edits, runs focused checks, and adapts as needed." },
      { kind: "verify", title: "Regression check", detail: "Require the original failure and focused tests to pass." },
    ],
  },
  migration: {
    name: "Zero-downtime database migration",
    title: "A reversible migration workflow",
    prompt: "Plan and implement a zero-downtime migration from the legacy customer profile schema to the new schema. Preserve compatibility during rollout and prove the rollback path.",
    benefit: "Keep schema discovery and rollout design separate from mutation, then require an explicit decision before implementation and rollback rehearsal.",
    contextPaths: ["README.md", "migrations/", "src/", "deploy/"],
    criteria: "Forward migration, mixed-version compatibility, idempotent backfill, and rollback evidence all pass without destructive operations.",
    evidenceLabel: "ILLUSTRATIVE DESIGN",
    evidence: "This program makes the migration boundary reviewable. It has not been executed against a production database and is not a safety guarantee.",
    phases: [
      { kind: "work", title: "Map schema and traffic", detail: "Inspect read/write paths, deployment order, and rollback constraints without changing files." },
      { kind: "work", title: "Design expand-contract rollout", detail: "Ground compatibility, backfill, monitoring, and rollback steps in repository evidence." },
      { kind: "checkpoint", title: "Approve migration plan", detail: "A human accepts the data movement and rollback boundary." },
      { kind: "work", title: "Implement compatibility", detail: "Codex implements the approved migration and focused tests." },
      { kind: "verify", title: "Rehearse forward and rollback", detail: "Check compatibility, idempotence, and rollback evidence." },
    ],
  },
  monorepo: {
    name: "Monorepo dependency upgrade",
    title: "A staged dependency-upgrade workflow",
    prompt: "Upgrade the shared framework dependency across this monorepo without breaking downstream packages. Stage the work so failures can be isolated and reverted.",
    benefit: "Make the affected-package map and batch order explicit before edits, then verify the package matrix with bounded repairs.",
    contextPaths: ["README.md", "package.json", "packages/", "tests/"],
    criteria: "Lockfiles are consistent, affected package builds and focused tests pass, and public compatibility checks show no unexplained regression.",
    evidenceLabel: "ILLUSTRATIVE DESIGN",
    evidence: "This reusable design shows how a large upgrade can be staged. It has not been run across a real monorepo or scored.",
    phases: [
      { kind: "work", title: "Map affected packages", detail: "Inspect manifests, lockfiles, package relationships, and the available test matrix." },
      { kind: "work", title: "Propose upgrade batches", detail: "Group changes into reversible batches and identify compatibility risks." },
      { kind: "checkpoint", title: "Approve upgrade sequence", detail: "A human accepts the batch order and rollback points." },
      { kind: "work", title: "Upgrade in batches", detail: "Codex applies the approved changes and checks each batch." },
      { kind: "verify", title: "Verify package matrix", detail: "Check locks, builds, focused tests, and public compatibility." },
    ],
  },
  incident: {
    name: "Production incident investigation",
    title: "An evidence-first mitigation workflow",
    prompt: "Investigate the sudden increase in checkout latency using the repository and available local diagnostics. Propose the smallest safe mitigation, implement it only after review, and verify that observability remains intact.",
    benefit: "Force a read-only evidence pass and ranked hypotheses before authorizing a reversible repository-local mitigation.",
    contextPaths: ["README.md", "src/", "config/", "observability/"],
    criteria: "The local reproduction improves or is resolved, focused regressions pass, instrumentation still reports the relevant signals, and rollback remains possible.",
    evidenceLabel: "ILLUSTRATIVE DESIGN",
    evidence: "This is a repository-local incident workflow, not authority to change production systems. It has not been executed or scored.",
    phases: [
      { kind: "work", title: "Collect evidence read-only", detail: "Characterize the latency increase and separate observations from hypotheses." },
      { kind: "work", title: "Rank causal hypotheses", detail: "Seek disconfirming evidence and propose the smallest reversible mitigation." },
      { kind: "checkpoint", title: "Authorize mitigation", detail: "A human approves scope and the rollback trigger." },
      { kind: "work", title: "Apply minimal mitigation", detail: "Codex makes only the approved change and preserves instrumentation." },
      { kind: "verify", title: "Verify latency and signals", detail: "Check the reproduction, regressions, observability, and rollback." },
    ],
  },
};

let phases = normalizePhases(loadDraft() || DEFAULT_PHASES);
let selectedPhaseId = phases.find((phase) => phase.type === "work")?.id || phases[0]?.id || null;
let compiled = null;
let compileTimer = null;
let compileVersion = 0;
let activeRun = null;
let activeReceipt = null;
let activeTracePhase = null;
let pollTimer = null;
let draggedPhaseId = null;
let draggedPaletteType = null;
let capabilities = { phasePrograms: false, compileEndpoint: null, runEndpoint: null };
let currentExample = "flappy";
let securitySession = null;
let loginPollTimer = null;
let workspaceEntries = [];
const selectedIntegrations = new Map();

function makePhase(type, config = {}) {
  return { id: uid(), type, title: PHASE_TYPES[type].defaultTitle, config };
}

function loadDraft() {
  try {
    const draft = JSON.parse(localStorage.getItem("weave-codex-phase-draft"));
    return Array.isArray(draft?.phases) && draft.phases.every((phase) => PHASE_TYPES[phase.type]) ? draft.phases : null;
  } catch (_) {
    return null;
  }
}

function normalizePhases(value) {
  const source = value.map((phase) => ({ ...phase, config: { ...(phase.config || {}) } }));
  const oldRepair = source.find((phase) => phase.type === "repair");
  const program = source.filter((phase) => ["work", "checkpoint", "verify"].includes(phase.type));
  program.forEach((phase) => {
    if (phase.type === "work") {
      phase.config.goal ||= phase.config.instruction || "";
      phase.config.reasoningEffort ||= "inherit";
      delete phase.config.instruction;
    }
    if (phase.type === "verify") phase.config.maxRepairs = Number(phase.config.maxRepairs ?? oldRepair?.config?.retries ?? 1);
  });
  const fixed = (type, config) => source.find((phase) => phase.type === type) || makePhase(type, config);
  return [
    fixed("task", { goal: "" }), fixed("context", { paths: "" }), fixed("memory", { mode: "off" }), fixed("approval", { gate: "manual" }),
    ...program,
    fixed("output", { format: "text" }),
  ];
}

function saveDraft() {
  try {
    localStorage.setItem("weave-codex-phase-draft", JSON.stringify({ phases, name: $("#harness-name").value }));
    $("#draft-status").textContent = "Draft saved locally";
  } catch (_) {
    $("#draft-status").textContent = "Draft not saved";
  }
}

function toast(message) {
  const node = $("#toast");
  node.textContent = message;
  node.classList.add("visible");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.classList.remove("visible"), 2400);
}

async function request(path, options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (method !== "GET" && securitySession?.csrfToken) headers["X-Weave-CSRF"] = securitySession.csrfToken;
  const response = await fetch(path, { ...options, method, headers });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { error: text || `HTTP ${response.status}` }; }
  if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : JSON.stringify(data.error));
  return data;
}

async function bootstrapSession() {
  securitySession = await request("/api/session");
  if (securitySession.loopbackOnly !== true || securitySession.authenticationOwner !== "codexAppServer") throw new Error("The local Weave session did not report the expected security boundary.");
  if (securitySession.workspaceRoot && !$("#cwd").value.trim()) $("#cwd").value = securitySession.workspaceRoot;
  return securitySession;
}

async function detectCapabilities() {
  const indicator = $("#runtime-indicator");
  try {
    const response = await fetch("/api/phase-templates", { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    capabilities = {
      phasePrograms: data.phasePrograms === true || Array.isArray(data.templates),
      compileEndpoint: data.compileEndpoint || null,
      runEndpoint: data.runEndpoint || null,
    };
    indicator.className = "runtime connected";
    $("span", indicator).textContent = "Local Codex connected";
    renderConnectionStatus({ connected: true });
  } catch (_) {
    // The current v1 server has no capabilities endpoint; the fixed-manifest adapter remains usable.
    indicator.className = "runtime error";
    $("span", indicator).textContent = "Runtime unavailable";
    renderConnectionStatus({ connected: false });
  }
}

function switchView(view, updateHistory = true) {
  const aliases = { build: "design", observe: "runs" };
  view = aliases[view] || view;
  if (!$("#" + view + "-view")) view = "home";
  $$(".view-tab").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  $$(".app-view").forEach((panel) => panel.classList.toggle("active", panel.id === `${view}-view`));
  if (updateHistory && location.hash !== `#${view}`) history.pushState({ view }, "", `#${view}`);
  window.scrollTo({ top: 0, behavior: "smooth" });
  if (view === "setup" && securitySession) void checkAccount();
  if (view === "integrations" && securitySession && $("#integration-status")?.dataset.loaded !== "true") void loadIntegrations();
}

function renderPalette() {
  const item = ([type, definition]) => `<button class="palette-item" type="button" draggable="true" data-phase-type="${type}">
      <span class="phase-icon type-${type}">${definition.icon}</span><span><b>${definition.label}</b><small>${definition.description}</small></span><i aria-hidden="true">＋</i>
    </button>`;
  const entries = Object.entries(PHASE_TYPES).filter(([, value]) => !value.fixed);
  $("#phase-palette").innerHTML = entries.map(item).join("");
  $$(".palette-item").forEach((button) => {
    button.addEventListener("click", () => addPhase(button.dataset.phaseType));
    button.addEventListener("dragstart", (event) => {
      draggedPaletteType = button.dataset.phaseType;
      draggedPhaseId = null;
      event.dataTransfer.effectAllowed = "copy";
      event.dataTransfer.setData("text/plain", `palette:${draggedPaletteType}`);
    });
  });
}

function selectSetup(type) {
  selectedPhaseId = getPhase(type)?.id || null;
  renderCanvas();
}

function phaseSummary(phase) {
  if (phase.type === "task") return phase.config.goal || "Add the task goal";
  if (phase.type === "context") return lineCount(phase.config.paths) ? `${lineCount(phase.config.paths)} context path${lineCount(phase.config.paths) === 1 ? "" : "s"}` : "No context paths";
  if (phase.type === "memory") return ({ off: "No prior traces", all: "All native Codex memory", selected: "Selected thread excerpts" })[phase.config.mode || "off"];
  if (phase.type === "approval") return ({ manual: "Ask for protected tool actions", "auto-review": "Codex reviews tool escalation", deny: "Deny tool escalation" })[phase.config.gate || "manual"];
  if (phase.type === "work") return phase.config.goal || "Add one goal-level instruction";
  if (phase.type === "checkpoint") return phase.config.question || "Add a continue-or-stop question";
  if (phase.type === "verify") return `${phase.config.criteria || "Add a pass criterion"} · up to ${Number(phase.config.maxRepairs ?? 1)} repairs`;
  if (phase.type === "output") return `${phase.config.format || "text"} response + receipt`;
  return "";
}

function lineCount(value) {
  return String(value || "").split("\n").map((line) => line.trim()).filter(Boolean).length;
}

function contextPaths() {
  return [...new Set(String(getPhase("context")?.config.paths || "").split("\n").map((line) => line.trim()).filter(Boolean))];
}

function setContextPaths(paths) {
  const unique = [...new Set(paths.map((path) => String(path).trim()).filter(Boolean))].slice(0, 12);
  getPhase("context").config.paths = unique.join("\n");
  saveDraft();
  renderCanvas();
  scheduleCompile();
}

function renderWorkspaceSelection() {
  const paths = contextPaths();
  const summary = $("#workspace-selection-summary");
  const selected = $("#workspace-selected");
  if (!summary || !selected) return;
  summary.textContent = paths.length ? `${paths.length} starting reference${paths.length === 1 ? "" : "s"}` : "No starting references";
  selected.innerHTML = paths.length
    ? paths.map((path) => `<button type="button" data-remove-context-path="${escapeHtml(path)}" title="Remove ${escapeHtml(path)}"><span>${escapeHtml(path)}</span><i>×</i></button>`).join("")
    : `<span class="workspace-empty">Codex can still inspect the workspace when the task requires it.</span>`;
  $$('[data-remove-context-path]', selected).forEach((button) => button.addEventListener("click", () => setContextPaths(paths.filter((path) => path !== button.dataset.removeContextPath))));
  renderWorkspaceResults();
}

function renderWorkspaceResults() {
  const root = $("#workspace-results");
  if (!root || !workspaceEntries.length) return;
  const selected = new Set(contextPaths());
  root.innerHTML = workspaceEntries.map((entry) => {
    const active = selected.has(entry.path);
    const icon = entry.kind === "directory" ? "▣" : entry.kind === "symlink" ? "↗" : "·";
    return `<button type="button" class="workspace-result ${active ? "selected" : ""}" data-context-path="${escapeHtml(entry.path)}"><i>${icon}</i><span>${escapeHtml(entry.path)}</span><em>${active ? "Added" : entry.kind}</em></button>`;
  }).join("");
  $$('[data-context-path]', root).forEach((button) => button.addEventListener("click", () => {
    const paths = contextPaths();
    const path = button.dataset.contextPath;
    if (paths.includes(path)) setContextPaths(paths.filter((item) => item !== path));
    else if (paths.length < 12) setContextPaths([...paths, path]);
    else toast("A harness can carry at most 12 starting references");
  }));
}

async function searchWorkspacePaths() {
  const root = $("#workspace-results");
  const button = $("#search-workspace");
  root.innerHTML = `<div class="workspace-empty">Reading names from the local workspace…</div>`;
  button.disabled = true;
  try {
    const value = await request("/api/workspace/paths", {
      method: "POST",
      body: JSON.stringify({ cwd: $("#cwd").value.trim(), query: $("#workspace-query").value, limit: 60 }),
    });
    workspaceEntries = value.entries || [];
    $("#workspace-picker-note").textContent = `${workspaceEntries.length} name${workspaceEntries.length === 1 ? "" : "s"} shown · ${value.privacy || "names-only"}${value.truncated ? " · narrow the search for more" : ""}`;
    root.innerHTML = workspaceEntries.length ? "" : `<div class="workspace-empty">No matching paths. Try a shorter search.</div>`;
    renderWorkspaceResults();
  } catch (error) {
    workspaceEntries = [];
    root.innerHTML = `<div class="workspace-empty error">Workspace browsing is unavailable: ${escapeHtml(error.message)}</div>`;
  } finally {
    button.disabled = false;
  }
}

function renderDesignSummary() {
  const task = getPhase("task");
  if (document.activeElement !== $("#goal-input")) $("#goal-input").value = task?.config.goal || "";
  $("#context-summary").textContent = lineCount(getPhase("context")?.config.paths) ? `${lineCount(getPhase("context")?.config.paths)} suggested path${lineCount(getPhase("context")?.config.paths) === 1 ? "" : "s"}` : "No suggested files";
  $("#memory-summary").textContent = ({ off: "Off · clean run", all: "All native memory", selected: `${selectedThreads().length || 0} selected tasks` })[getPhase("memory")?.config.mode || "off"];
  $("#approval-summary").textContent = ({ manual: "Ask me", "auto-review": "Auto-review", deny: "Deny escalation" })[getPhase("approval")?.config.gate || "manual"];
  $("#output-summary").textContent = `${getPhase("output")?.config.format || "text"} + receipt`;
  $$(".run-settings-strip button").forEach((button) => button.classList.toggle("selected", getPhase(button.dataset.selectType)?.id === selectedPhaseId));
  renderWorkspaceSelection();
}

function renderCanvas() {
  const canvas = $("#phase-canvas");
  const program = programPhases();
  if (!program.length) {
    canvas.innerHTML = `<div class="canvas-empty"><b>No executable phases yet</b><span>Add a Codex Work Loop first, then optional checkpoints and verification.</span></div>`;
  } else {
    canvas.innerHTML = program.map((phase, index) => {
      const definition = PHASE_TYPES[phase.type];
      return `<article class="phase-card executable-phase ${selectedPhaseId === phase.id ? "selected" : ""}" draggable="true" data-phase-id="${escapeHtml(phase.id)}" data-phase-type="${phase.type}" tabindex="0">
        <div class="phase-rail"><button class="drag-handle" type="button" aria-label="Drag ${escapeHtml(phase.title)}">⠿</button><span>${String(index + 1).padStart(2, "0")}</span></div>
        <span class="phase-icon type-${phase.type}">${definition.icon}</span>
        <div class="phase-copy"><small>${definition.label}${phase.type === "work" ? " · ONE CODEX TURN" : ""}</small><b>${escapeHtml(phase.title)}</b><p>${escapeHtml(phaseSummary(phase))}</p>${phase.type === "work" ? `<em>May contain one or one hundred tool calls</em>` : ""}</div>
        <div class="phase-controls"><button type="button" data-move="up" aria-label="Move up">↑</button><button type="button" data-move="down" aria-label="Move down">↓</button><button type="button" data-remove aria-label="Remove phase">×</button></div>
      </article>`;
    }).join("");
  }
  bindCanvasEvents();
  renderInspector();
  renderDesignSummary();
  $("#phase-bound").textContent = programPhases().length || "0";
}

function bindCanvasEvents() {
  $$(".phase-card").forEach((card) => {
    const id = card.dataset.phaseId;
    const fixed = PHASE_TYPES[card.dataset.phaseType].fixed;
    card.addEventListener("click", (event) => {
      if (event.target.closest("button[data-move], button[data-remove]")) return;
      selectedPhaseId = id;
      renderCanvas();
    });
    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); selectedPhaseId = id; renderCanvas(); }
    });
    card.addEventListener("dragstart", (event) => {
      if (fixed) { event.preventDefault(); return; }
      draggedPhaseId = id;
      draggedPaletteType = null;
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", `phase:${id}`);
      card.classList.add("dragging");
    });
    card.addEventListener("dragend", () => { draggedPhaseId = null; card.classList.remove("dragging"); $$(".drop-before").forEach((node) => node.classList.remove("drop-before")); });
    card.addEventListener("dragover", (event) => { if (fixed) return; event.preventDefault(); card.classList.add("drop-before"); });
    card.addEventListener("dragleave", () => card.classList.remove("drop-before"));
    card.addEventListener("drop", (event) => { event.preventDefault(); card.classList.remove("drop-before"); dropAt(phases.findIndex((phase) => phase.id === id)); });
    $("[data-move='up']", card)?.addEventListener("click", () => movePhase(id, -1));
    $("[data-move='down']", card)?.addEventListener("click", () => movePhase(id, 1));
    $("[data-remove]", card)?.addEventListener("click", () => removePhase(id));
  });
}

function addPhase(type, index = phases.length) {
  if (PHASE_TYPES[type].fixed) { selectSetup(type); return; }
  const defaults = { work: { goal: "", reasoningEffort: "inherit" }, checkpoint: { question: "Continue to the next phase?" }, verify: { criteria: "The result satisfies the task and is supported by inspected evidence.", maxRepairs: 1 } };
  const phase = makePhase(type, defaults[type]);
  const outputIndex = phases.findIndex((item) => item.type === "output");
  phases.splice(Math.min(index, outputIndex), 0, phase);
  selectedPhaseId = phase.id;
  changed();
}

function removePhase(id) {
  if (PHASE_TYPES[phases.find((phase) => phase.id === id)?.type]?.fixed) return;
  phases = phases.filter((phase) => phase.id !== id);
  if (selectedPhaseId === id) selectedPhaseId = phases[0]?.id || null;
  changed();
}

function movePhase(id, offset) {
  const program = phases.filter((phase) => !PHASE_TYPES[phase.type].fixed);
  const from = program.findIndex((phase) => phase.id === id);
  const to = Math.max(0, Math.min(program.length - 1, from + offset));
  if (from < 0 || from === to) return;
  [program[from], program[to]] = [program[to], program[from]];
  phases = normalizePhases([...phases.filter((phase) => PHASE_TYPES[phase.type].fixed), ...program]);
  changed();
}

function dropAt(index) {
  if (draggedPaletteType) addPhase(draggedPaletteType, index);
  if (draggedPhaseId) {
    const program = phases.filter((phase) => !PHASE_TYPES[phase.type].fixed);
    const from = program.findIndex((phase) => phase.id === draggedPhaseId);
    if (from < 0) return;
    const targetId = phases[index]?.id;
    let target = program.findIndex((phase) => phase.id === targetId);
    if (target < 0) target = program.length;
    const [phase] = program.splice(from, 1);
    program.splice(from < target ? target - 1 : target, 0, phase);
    phases = normalizePhases([...phases.filter((item) => PHASE_TYPES[item.type].fixed), ...program]);
    changed();
  }
  draggedPhaseId = null;
  draggedPaletteType = null;
}

function renderInspector() {
  const root = $("#phase-inspector");
  const phase = phases.find((item) => item.id === selectedPhaseId);
  $("#thread-picker").classList.toggle("hidden", getPhase("memory")?.config.mode !== "selected");
  if (!phase) {
    $("#inspector-subtitle").textContent = "Select a phase";
    root.innerHTML = `<div class="inspector-empty"><span>↖</span><p>Select a phase on the canvas to edit its instruction and controls.</p></div>`;
    return;
  }
  const definition = PHASE_TYPES[phase.type];
  $("#inspector-subtitle").textContent = definition.label;
  root.innerHTML = `<div class="inspector-type"><span class="phase-icon type-${phase.type}">${definition.icon}</span><div><b>${definition.label}</b><small>${definition.description}</small></div></div>
    <label class="field"><span>${definition.fixed ? "Setting name" : "Phase name"}</span><input data-phase-field="title" value="${escapeHtml(phase.title)}" /></label>
    ${inspectorFields(phase)}
    ${phase.type === "work" ? `<div class="codex-boundary"><b>Inside this phase, Codex decides the steps.</b><p>It can inspect files, reason, call tools, edit, and test repeatedly. Weave records that internal loop; it does not turn each tool call into a canvas block.</p></div>` : ""}`;
  $$('[data-phase-field]', root).forEach((control) => {
    control.addEventListener("input", () => updatePhaseField(phase, control));
    control.addEventListener("change", () => updatePhaseField(phase, control));
  });
}

function inspectorFields(phase) {
  const c = phase.config;
  if (phase.type === "task") return `<label class="field"><span>Goal</span><textarea data-phase-field="goal" rows="7" placeholder="Describe the outcome, constraints, and definition of done.">${escapeHtml(c.goal || "")}</textarea><small>Write the result you want—not the individual tool steps.</small></label>`;
  if (phase.type === "context") return `<label class="field"><span>Suggested paths <em>one per line</em></span><textarea data-phase-field="paths" rows="7" placeholder="README.md\nsrc/">${escapeHtml(c.paths || "")}</textarea><small>Codex may inspect more files when the task requires it.</small></label>`;
  if (phase.type === "memory") return `<label class="field"><span>Prior experience</span><select data-phase-field="mode"><option value="off" ${c.mode === "off" ? "selected" : ""}>Off — clean run</option><option value="all" ${c.mode === "all" ? "selected" : ""}>All — native Codex memory</option><option value="selected" ${c.mode === "selected" ? "selected" : ""}>Selected — exact thread excerpts</option></select><small>Selected mode can be audited from the run receipt.</small></label>`;
  if (phase.type === "approval") return `<label class="field"><span>Protected tool actions</span><select data-phase-field="gate"><option value="manual" ${c.gate === "manual" ? "selected" : ""}>Ask me when requested</option><option value="auto-review" ${c.gate === "auto-review" ? "selected" : ""}>Codex auto-review</option><option value="deny" ${c.gate === "deny" ? "selected" : ""}>Deny escalation</option></select><small>This run-wide safety policy applies inside every Work Loop. It is not a between-phase checkpoint.</small></label>`;
  if (phase.type === "work") return `<label class="field"><span>Goal for this turn</span><textarea data-phase-field="goal" rows="8" placeholder="For example: redesign the frontend, inspect the current implementation first, make the change, and test it.">${escapeHtml(c.goal || "")}</textarea><small>This phase maps to one app-server turn. Codex owns the internal tool loop.</small></label><label class="field"><span>Reasoning for this phase</span><select data-phase-field="reasoningEffort"><option value="inherit" ${c.reasoningEffort === "inherit" ? "selected" : ""}>Inherit run setting</option><option value="low" ${c.reasoningEffort === "low" ? "selected" : ""}>Low</option><option value="medium" ${c.reasoningEffort === "medium" ? "selected" : ""}>Medium</option><option value="high" ${c.reasoningEffort === "high" ? "selected" : ""}>High</option><option value="xhigh" ${c.reasoningEffort === "xhigh" ? "selected" : ""}>Extra high</option></select></label>`;
  if (phase.type === "checkpoint") return `<label class="field"><span>Question for the human</span><textarea data-phase-field="question" rows="6" placeholder="Continue into implementation using the proposed plan?">${escapeHtml(c.question || "")}</textarea><small>Execution pauses here. Continue moves to the next phase; stop ends the harness without a model call.</small></label>`;
  if (phase.type === "verify") return `<label class="field"><span>Pass criterion</span><textarea data-phase-field="criteria" rows="6">${escapeHtml(c.criteria || "")}</textarea><small>Verification is one controller turn.</small></label><label class="field"><span>Maximum repair turns</span><select data-phase-field="maxRepairs"><option value="0" ${Number(c.maxRepairs) === 0 ? "selected" : ""}>No repairs</option><option value="1" ${Number(c.maxRepairs) === 1 ? "selected" : ""}>1 repair</option><option value="2" ${Number(c.maxRepairs) === 2 ? "selected" : ""}>2 repairs</option></select><small>Repairs run only when verification requests them.</small></label>`;
  if (phase.type === "output") return `<label class="field"><span>Response format</span><select data-phase-field="format"><option value="text" ${c.format !== "json" ? "selected" : ""}>Text</option><option value="json" ${c.format === "json" ? "selected" : ""}>JSON</option></select><small>A full machine-readable receipt is stored either way.</small></label>`;
  return "";
}

function updatePhaseField(phase, control) {
  const key = control.dataset.phaseField;
  if (key === "title") phase.title = control.value;
  else phase.config[key] = key === "maxRepairs" ? Number(control.value) : control.value;
  if (phase.type === "memory" && key === "mode") $("#thread-picker").classList.toggle("hidden", control.value !== "selected");
  const card = $(`.phase-card[data-phase-id="${phase.id}"]`);
  if (card) { $(".phase-copy b", card).textContent = phase.title; $(".phase-copy p", card).textContent = phaseSummary(phase); }
  renderDesignSummary();
  saveDraft();
  scheduleCompile();
}

function changed() {
  saveDraft();
  renderCanvas();
  scheduleCompile();
}

function getPhase(type) { return phases.find((phase) => phase.type === type); }
function getPhases(type) { return phases.filter((phase) => phase.type === type); }
function programPhases() { return phases.filter((phase) => ["work", "checkpoint", "verify"].includes(phase.type)); }
function selectedThreads() { return $$("#thread-list input:checked").map((input) => input.value); }

function compatibilityIssues() {
  const issues = [];
  const program = programPhases();
  if (!program.some((phase) => phase.type === "work")) issues.push("Add at least one Codex Work Loop.");
  if (program.length > 8) issues.push("The phase-program adapter supports at most eight executable phases.");
  if (program.length && program[0].type !== "work") issues.push("The first executable phase must be a Codex Work Loop.");
  if (program.some((phase, index) => phase.type === "checkpoint" && program[index - 1]?.type === "checkpoint")) issues.push("Place a Codex or Verify phase between human checkpoints.");
  if (!getPhase("task")?.config.goal?.trim()) issues.push("Describe the task goal.");
  program.forEach((phase) => {
    if (phase.title.trim().length < 2) issues.push(`${PHASE_TYPES[phase.type].label} needs a phase name.`);
    if (phase.type === "work" && String(phase.config.goal || "").trim().length < 4) issues.push(`Give “${phase.title || "Codex Work Loop"}” a goal of at least four characters.`);
    if (phase.type === "checkpoint" && String(phase.config.question || "").trim().length < 4) issues.push(`Give “${phase.title || "Human Checkpoint"}” a clear question.`);
    if (phase.type === "verify" && String(phase.config.criteria || "").trim().length < 4) issues.push(`Give “${phase.title || "Verification"}” a pass criterion.`);
  });
  if (!$("#cwd").value.trim().startsWith("/")) issues.push("The workspace must be an absolute path.");
  if (getPhase("memory")?.config.mode === "selected" && !selectedThreads().length) issues.push("Load and choose at least one exact thread for selected memory.");
  if (!capabilities.phasePrograms) {
    if (program.length !== 1 || program[0]?.type !== "work") issues.push("This older server can only execute one Codex Work Loop. Start it with phase-program support to run this design.");
  }
  return issues;
}

function manifestFromCanvas() {
  const task = getPhase("task");
  const context = getPhase("context");
  const memory = getPhase("memory");
  const approval = getPhase("approval");
  const work = getPhase("work");
  const verify = getPhase("verify");
  const output = getPhase("output");
  const instruction = [task?.config.goal?.trim(), work?.config.goal?.trim() ? `\nExecution phase — ${work.config.goal.trim()}` : ""].filter(Boolean).join("\n");
  return {
    schemaVersion: 1,
    name: $("#harness-name").value.trim() || "Untitled harness",
    cwd: $("#cwd").value.trim(),
    task: { instructions: instruction, contextPaths: String(context?.config.paths || "").split("\n").map((line) => line.trim()).filter(Boolean) },
    memory: { mode: memory?.config.mode || "off", selectedThreadIds: memory?.config.mode === "selected" ? selectedThreads() : [] },
    agent: { model: $("#model").value.trim() || null, reasoningEffort: $("#effort").value, sandbox: $("#sandbox").value, approvalGate: approval?.config.gate || "deny" },
    verification: { enabled: Boolean(verify), criteria: verify?.config.criteria || "The result satisfies the task.", maxRetries: verify ? Number(verify?.config.maxRepairs || 0) : 0 },
    output: { format: output?.config.format || "text" },
    observability: { traceRoot: ".weave-codex/traces" },
  };
}

function phaseManifest() {
  const base = manifestFromCanvas();
  return {
    ...base,
    schemaVersion: 2,
    task: { ...base.task, instructions: getPhase("task")?.config.goal?.trim() || "Complete the configured phase program." },
    verification: { enabled: false, criteria: "Phase program owns verification.", maxRetries: 0 },
    phaseProgram: {
      projectionVersion: 1,
      phases: programPhases().map((phase) => {
        const common = { id: phase.id, name: phase.title };
        if (phase.type === "work") return { ...common, kind: "work", goal: phase.config.goal, reasoningEffort: phase.config.reasoningEffort || "inherit" };
        if (phase.type === "checkpoint") return { ...common, kind: "checkpoint", question: phase.config.question };
        return { ...common, kind: "verify", criteria: phase.config.criteria, maxRepairs: Number(phase.config.maxRepairs || 0) };
      }),
    },
  };
}

function scheduleCompile() {
  clearTimeout(compileTimer);
  compiled = null;
  $("#run-button").disabled = true;
  $("#adapter-status").className = "adapter-pill checking";
  $("#adapter-status").textContent = "Design changed";
  $("#run-readiness").textContent = "Rechecking this design…";
  compileTimer = setTimeout(compile, 420);
}

async function compile() {
  clearTimeout(compileTimer);
  const version = ++compileVersion;
  const issues = compatibilityIssues();
  $("#manifest-json").value = JSON.stringify(capabilities.phasePrograms ? phaseManifest() : manifestFromCanvas(), null, 2);
  if (issues.length) {
    compiled = null;
    renderCompatibility(issues, false, "Editable, not executable yet");
    return false;
  }
  try {
    let result;
    if (capabilities.phasePrograms && capabilities.compileEndpoint) {
      result = await request(capabilities.compileEndpoint, { method: "POST", body: JSON.stringify(phaseManifest()) });
    } else {
      result = await request("/api/compile", { method: "POST", body: JSON.stringify(manifestFromCanvas()) });
    }
    if (version !== compileVersion) return false;
    compiled = result;
    $("#actions").innerHTML = (result.actions || []).map((action) => `<li>${escapeHtml(action)}</li>`).join("");
    $("#turn-bound").textContent = result.maximumTurns ?? "Adapter-defined";
    const label = capabilities.phasePrograms ? "Phase-program adapter" : "Codex v1 adapter";
    renderCompatibility([], true, label, result.manifestHash);
    return true;
  } catch (error) {
    if (version !== compileVersion) return false;
    compiled = null;
    renderCompatibility([`The local Codex adapter could not validate this design: ${error.message}`], false, "Adapter unavailable");
    return false;
  }
}

function renderCompatibility(issues, valid, label, hash = "") {
  const status = $("#adapter-status");
  status.className = `adapter-pill ${valid ? "ready" : "blocked"}`;
  status.textContent = valid ? label : "Needs attention";
  $("#compatibility").innerHTML = valid
    ? `<div class="compatibility-ok"><i>✓</i><div><b>Executable by ${escapeHtml(label)}</b><p>${capabilities.phasePrograms ? "Each Codex Work Loop compiles to one app-server turn." : "This canonical single-work-phase design maps faithfully to the current typed manifest."}</p>${hash ? `<small>${escapeHtml(hash)}</small>` : ""}</div></div>`
    : `<ul>${issues.map((issue) => `<li>${escapeHtml(issue)}</li>`).join("")}</ul>`;
  if (!valid) { $("#actions").innerHTML = "<li>No operations will run until the design is compatible.</li>"; $("#turn-bound").textContent = "—"; }
  $("#run-button").disabled = !valid;
  $("#run-readiness").textContent = valid ? "Ready to run with Codex" : "This draft will not run yet";
  $("#run-readiness-detail").textContent = valid ? "The receipt will preserve the manifest hash and observed internal activity." : "Fix the compatibility notes above; your draft remains saved locally.";
}

async function run() {
  if (!(await compile())) return;
  const endpoint = capabilities.phasePrograms && capabilities.runEndpoint ? capabilities.runEndpoint : "/api/runs";
  const payload = capabilities.phasePrograms && capabilities.runEndpoint ? phaseManifest() : manifestFromCanvas();
  $("#run-button").disabled = true;
  switchView("runs");
  showTraceLoading("Starting Codex…");
  try {
    const data = await request(endpoint, { method: "POST", body: JSON.stringify(payload) });
    activeRun = data.runId;
    poll();
  } catch (error) {
    showTraceError(error.message);
    $("#run-button").disabled = false;
  }
}

function showTraceLoading(message) {
  $("#trace-empty").classList.add("hidden");
  $("#trace-content").classList.remove("hidden");
  $("#trace-status").className = "status-pill running";
  $("#trace-status").textContent = "Running";
  $("#trace-title").textContent = message;
  $("#trace-meta").textContent = "Waiting for app-server events";
  renderTrace({ timeline: [] }, "running");
}

function showTraceError(message) {
  $("#trace-status").className = "status-pill failed";
  $("#trace-status").textContent = "Failed";
  $("#trace-title").textContent = "Run failed";
  $("#trace-meta").textContent = message;
}

async function loadRecentRuns(autoLoad = false) {
  const root = $("#recent-runs");
  try {
    const data = await request("/api/runs");
    root.innerHTML = data.runs?.length ? data.runs.map((run) => `<button class="run-item" type="button" data-run-id="${escapeHtml(run.runId)}"><span class="run-dot ${run.status}"></span><span><b>${run.verification?.at(-1)?.status === "pass" ? "Verified Codex run" : "Codex run"}</b><small>${formatDate(run.completedAt || run.startedAt)} · ${escapeHtml(run.memoryMode || "memory off")}</small></span><em>${Number(run.turnCount || 0)} turn${Number(run.turnCount || 0) === 1 ? "" : "s"}</em></button>`).join("") : `<div class="run-list-empty"><b>No saved runs yet</b><p>Build and run a harness. Its real Codex trace will appear here.</p></div>`;
    $$(".run-item", root).forEach((button) => button.addEventListener("click", () => loadSavedRun(button.dataset.runId)));
    if (autoLoad && data.runs?.length) await loadSavedRun(data.runs[0].runId);
  } catch (error) {
    root.innerHTML = `<div class="run-list-empty"><b>Runtime unavailable</b><p>${escapeHtml(error.message)}</p></div>`;
  }
}

async function browseCodexThreads() {
  const root = $("#codex-thread-list");
  root.innerHTML = "<p>Reading Codex thread metadata…</p>";
  try {
    const data = await request(`/api/threads?cwd=${encodeURIComponent($("#cwd").value.trim())}`);
    root.innerHTML = data.threads?.length ? data.threads.map((thread, index) => {
      const label = readableThreadLabel(thread, index);
      return `<button type="button" data-thread-id="${escapeHtml(thread.id)}"><b>${escapeHtml(label)}</b><small>Codex task · ${escapeHtml(String(thread.id || "").slice(0, 13))}</small></button>`;
    }).join("") : "<p>No Codex threads were found for this workspace.</p>";
    $$('[data-thread-id]', root).forEach((button) => button.addEventListener("click", () => loadThreadProjection(button.dataset.threadId, $("b", button).textContent)));
  } catch (error) { root.innerHTML = `<p>Thread browsing is unavailable: ${escapeHtml(error.message)}</p>`; }
}

function readableThreadLabel(thread, index) {
  const source = String(thread.name || thread.preview || "").replace(/\s+/g, " ").trim();
  const taggedTask = source.match(/<(?:overall_task|task)>\s*([\s\S]*?)\s*<\/(?:overall_task|task)>/i)?.[1];
  const withoutMarkup = String(taggedTask || source)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const fallback = `Codex task ${index + 1}`;
  const label = withoutMarkup || fallback;
  return label.length > 78 ? `${label.slice(0, 75).trimEnd()}…` : label;
}

async function loadThreadProjection(threadId, name) {
  $$("[data-thread-id]").forEach((button) => button.classList.toggle("active", button.dataset.threadId === threadId));
  $$(".run-item").forEach((button) => button.classList.remove("active"));
  showTraceLoading("Projecting Codex thread…");
  try {
    const projection = await request("/api/thread-projection", { method: "POST", body: JSON.stringify({ cwd: $("#cwd").value.trim(), threadId }) });
    activeRun = null;
    activeTracePhase = null;
    activeReceipt = { runId: threadId, threadId, threadName: name, traceProjection: projection, timeline: [], finalResponse: "This is a privacy-preserving phase projection of an existing Codex thread. The original response body is not copied into the projection." };
    renderEvents([]);
    renderTrace(activeReceipt, "completed");
  } catch (error) { showTraceError(`Thread projection unavailable: ${error.message}`); }
}

function formatDate(value) {
  if (!value) return "Saved locally";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "Saved locally" : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
}

async function loadSavedRun(runId) {
  $$(".run-item").forEach((button) => button.classList.toggle("active", button.dataset.runId === runId));
  showTraceLoading("Loading saved run…");
  try {
    const state = await request(`/api/runs/${runId}`);
    activeRun = state.status === "running" ? runId : null;
    activeReceipt = state.result || { timeline: state.timeline || [] };
    activeTracePhase = null;
    renderEvents(state.events || []);
    renderTrace(activeReceipt, state.status, state.error);
  } catch (error) { showTraceError(error.message); }
}

function phaseGroups(timeline) {
  const groups = [];
  timeline.forEach((event) => {
    if (["runtime", "item"].includes(event.kind)) return;
    const id = event.phase || "runtime";
    let group = groups.find((item) => item.id === id);
    if (!group) { group = { id, label: humanPhase(id), events: [] }; groups.push(group); }
    group.events.push(event);
    if (event.kind === "stage" && event.title) group.label = String(event.title).replace(/ started$/i, "").replace(/ finished$/i, "").replace(/: verification$/i, "");
  });
  return groups;
}

function humanPhase(phase) {
  if (phase === "solver") return "Codex work";
  if (phase.startsWith("verifier")) return phase === "verifier-1" ? "Verification" : `Verification / repair ${phase.split("-").at(-1)}`;
  return phase.replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function renderTrace(result, status = "completed", error = null) {
  activeReceipt = result;
  const timeline = result.timeline || [];
  const projection = result.traceProjection || null;
  const authoredIds = new Set((result.phaseProgram?.executions || []).map((item) => item.phaseId));
  const authoredGroups = phaseGroups(timeline).filter((group) => authoredIds.has(group.id));
  const hasAuthoredPhases = authoredGroups.length > 0;
  const groups = hasAuthoredPhases ? authoredGroups : projection ? projectionClusters(projection) : phaseGroups(timeline);
  const observed = result.observed || {};
  const tools = projection?.counts?.toolCalls ?? timeline.filter((event) => event.kind === "tool_call").length;
  $("#trace-empty").classList.add("hidden");
  $("#trace-content").classList.remove("hidden");
  $("#trace-status").className = `status-pill ${status}`;
  $("#trace-status").textContent = status === "completed" ? "Complete" : status === "failed" ? "Failed" : "Running";
  $("#trace-title").textContent = status === "running" ? "Codex is working" : result.threadName || "Codex execution trace";
  $("#trace-meta").textContent = hasAuthoredPhases ? `${String(result.runId || "run").slice(0, 16)} · exact Weave phase receipt · ${result.controls?.sandbox || "control pending"}` : projection ? `${String(result.runId || "thread").slice(0, 16)} · derived activity view · ${projection.projectionBasis}` : `${result.runId ? result.runId.slice(0, 8) : "live"} · ${result.controls?.sandbox || "control pending"} · memory ${result.memory?.mode || "off"}${error ? ` · ${error}` : ""}`;
  $("#use-run-controls").textContent = hasAuthoredPhases ? "Reuse this harness shape" : projection ? "Use this trace shape" : "Use these controls";
  const comparison = $("#compare-this-run");
  if (comparison) {
    const query = hasAuthoredPhases
      ? `rightRun=${encodeURIComponent(result.runId || "")}`
      : `leftThread=${encodeURIComponent(result.threadId || result.runId || "")}&cwd=${encodeURIComponent($("#cwd").value.trim())}`;
    comparison.href = `/compare.html?${query}`;
  }
  $("#metric-phases").textContent = groups.length;
  $("#metric-phases").nextElementSibling.textContent = hasAuthoredPhases ? "authored phases" : projection ? "derived activity groups" : "goal phases";
  $("#metric-tools").textContent = tools;
  $("#metric-model").textContent = projection?.counts?.modelCompletions ?? observed.modelCompletions ?? "—";
  $("#metric-turns").textContent = projection?.counts?.turns ?? result.turnIds?.length ?? "—";
  const observationCount = projection?.counts?.events ?? projection?.counts?.items ?? timeline.length;
  $("#trace-event-count").textContent = `${observationCount} source observation${observationCount === 1 ? "" : "s"}${projection && !hasAuthoredPhases ? " · derived grouping" : " · observed inside exact phases"}`;
  $(".execution-map-panel h3").textContent = hasAuthoredPhases ? "Authored phase map" : projection ? "Derived activity map" : "Phase map";
  $(".execution-map-panel header p").textContent = hasAuthoredPhases ? "Exact phase boundaries from this Weave run; tools remain inside Work." : projection ? "A compact interpretation of persisted Codex items—not native phase objects." : "Large cards are meaningful goals. Tool calls stay inside Work phases.";
  if (hasAuthoredPhases) renderExecutionMap(groups);
  else if (projection) renderProjectionMap(projection);
  else renderExecutionMap(groups);
  if (projection && !timeline.length) renderProjectionActivity(projection);
  else renderTimeline(timeline);
  $("#final-response").textContent = result.finalResponse || (status === "running" ? "Waiting for the final response…" : error || "No final response was stored.");
  renderReceipt(result);
}

function projectionClusters(projection) {
  const definitions = [
    { id: "orient", title: "Orient", kinds: ["task", "setup", "memory"], summary: "Task, environment, and context setup" },
    { id: "understand", title: "Understand", kinds: ["explore", "plan"], summary: "Inspection and planning activity" },
    { id: "act", title: "Act", kinds: ["execute", "integrate", "change"], summary: "Tool execution and workspace changes" },
    { id: "check", title: "Check", kinds: ["verify", "repair", "approval"], summary: "Verification, repair, and approval activity" },
    { id: "communicate", title: "Communicate", kinds: ["model", "deliver"], summary: "Model responses and delivery activity" },
  ];
  const nodes = projection.graph?.nodes || [];
  return definitions.map((definition) => {
    const members = nodes.filter((node) => definition.kinds.includes(node.kind));
    return {
      ...definition,
      kind: "derived",
      confidence: "interpretation",
      members,
      counts: {
        items: members.reduce((sum, node) => sum + Number(node.counts?.items || node.counts?.events || 1), 0),
        toolCalls: members.reduce((sum, node) => sum + Number(node.counts?.toolCalls || 0), 0),
      },
      turnIds: [...new Set(members.flatMap((node) => node.turnIds || []))],
    };
  }).filter((cluster) => cluster.members.length);
}

function renderProjectionMap(projection) {
  const nodes = projectionClusters(projection);
  const root = $("#execution-map");
  if (!nodes.length) { root.innerHTML = `<div class="map-empty">This thread contains no projectable phases.</div>`; return; }
  root.innerHTML = nodes.map((node, index) => `<button class="executed-phase derived ${activeTracePhase === node.id ? "active" : ""}" type="button" data-trace-phase="${escapeHtml(node.id)}"><span>${String(index + 1).padStart(2, "0")}</span><div><small>DERIVED ACTIVITY GROUP</small><b>${escapeHtml(node.title)}</b><p>${Number(node.counts?.toolCalls || 0)} observed tool call${Number(node.counts?.toolCalls || 0) === 1 ? "" : "s"} · ${node.members.length} projected nodes</p></div><em>${escapeHtml(node.summary)}</em></button>`).join("");
  $$(".executed-phase", root).forEach((button) => button.addEventListener("click", () => {
    activeTracePhase = activeTracePhase === button.dataset.tracePhase ? null : button.dataset.tracePhase;
    renderProjectionMap(projection);
    renderProjectionActivity(projection);
  }));
}

function renderProjectionActivity(projection) {
  const nodes = projectionClusters(projection).filter((node) => !activeTracePhase || node.id === activeTracePhase);
  const root = $("#timeline");
  if (!nodes.length) { root.innerHTML = `<div class="timeline-empty">No projected activity is available.</div>`; return; }
  root.innerHTML = nodes.map((node) => `<div class="timeline-phase"><span>${escapeHtml(node.title)}</span><i>derived interpretation</i></div><article class="timeline-event kind-${escapeHtml(node.kind)}"><span class="event-index">${escapeHtml(node.id.slice(0, 2).toUpperCase())}</span><div><small>derived activity group</small><b>${escapeHtml(node.summary)}</b><p>${Number(node.counts?.toolCalls || 0)} tool calls · ${node.members.length} projected nodes · ${node.turnIds?.length || 0} turns</p></div></article>`).join("");
}

function renderExecutionMap(groups) {
  const root = $("#execution-map");
  if (!groups.length) { root.innerHTML = `<div class="map-empty">Waiting for the first phase event…</div>`; return; }
  const executions = new Map((activeReceipt?.phaseProgram?.executions || []).map((item) => [item.phaseId, item.kind]));
  const phaseMarkup = groups.map((group, index) => {
    const tools = group.events.filter((event) => event.kind === "tool_call").length;
    const reasoning = group.events.filter((event) => event.kind === "reasoning").length;
    const kind = executions.get(group.id) || "work";
    return `<button class="executed-phase ${activeTracePhase === group.id ? "active" : ""}" type="button" data-trace-phase="${escapeHtml(group.id)}"><span>${String(index + 1).padStart(2, "0")}</span><div><small>${escapeHtml(kind === "verify" ? "VERIFY + REPAIR" : "AUTHORED WORK GOAL")}</small><b>${escapeHtml(group.label)}</b><p>${tools} tool request${tools === 1 ? "" : "s"} · ${reasoning} reasoning summar${reasoning === 1 ? "y" : "ies"}</p><div class="phase-inside"><i>Codex loop</i><i>tools nested here</i></div></div></button>`;
  }).join("");
  root.innerHTML = `<div class="map-boundary"><small>INPUT</small><b>Task contract</b><span>context · memory · safety</span></div>${phaseMarkup}<div class="map-boundary output"><small>OUTPUT</small><b>Answer + receipt</b><span>result · counts · provenance</span></div>`;
  $$(".executed-phase", root).forEach((button) => button.addEventListener("click", () => {
    activeTracePhase = activeTracePhase === button.dataset.tracePhase ? null : button.dataset.tracePhase;
    renderExecutionMap(groups);
    renderTimeline(activeReceipt?.timeline || []);
  }));
}

function renderTimeline(timeline) {
  const filter = $("#event-filter").value;
  const filtered = timeline.filter((event) => !["runtime", "item"].includes(event.kind)).filter((event) => !activeTracePhase || event.phase === activeTracePhase).filter((event) => filter === "all" || (filter === "tool" ? ["tool_call", "tool_result"].includes(event.kind) : event.kind === filter));
  const root = $("#timeline");
  if (!filtered.length) { root.innerHTML = `<div class="timeline-empty">No matching activity in this trace.</div>`; return; }
  let previousPhase = null;
  root.innerHTML = filtered.map((event) => {
    const phase = event.phase || "runtime";
    const heading = phase !== previousPhase ? `<div class="timeline-phase"><span>${escapeHtml(humanPhase(phase))}</span><i>inside phase</i></div>` : "";
    previousPhase = phase;
    return `${heading}<article class="timeline-event kind-${escapeHtml(event.kind || "event")}"><span class="event-index">${escapeHtml(event.index || "·")}</span><div><small>${escapeHtml(String(event.kind || "event").replaceAll("_", " "))}</small><b>${escapeHtml(event.title || event.method || "Event")}</b>${event.detail ? `<p>${escapeHtml(event.detail)}</p>` : ""}</div></article>`;
  }).join("");
}

function renderReceipt(result) {
  if (result.traceProjection) {
    const projection = result.traceProjection;
    $("#receipt-summary").innerHTML = `<dl><div><dt>Projection</dt><dd>${escapeHtml(projection.projectionVersion)}</dd></div><div><dt>Basis</dt><dd>${escapeHtml(projection.projectionBasis)}</dd></div><div><dt>Meaning</dt><dd>${escapeHtml(projection.disclaimer)}</dd></div><div><dt>Warnings</dt><dd>${escapeHtml((projection.warnings || []).join(" · ") || "none")}</dd></div></dl>`;
    $("#receipt").textContent = JSON.stringify(projection, null, 2);
    return;
  }
  const verification = result.verification || [];
  $("#receipt-summary").innerHTML = `<dl><div><dt>Manifest</dt><dd>${escapeHtml(result.manifestHash || "—")}</dd></div><div><dt>Memory</dt><dd>${escapeHtml(result.memory?.mode || "off")}${result.memory?.resolvedThreadIds?.length ? ` · ${result.memory.resolvedThreadIds.length} selected threads` : ""}</dd></div><div><dt>Safety</dt><dd>${escapeHtml(result.controls?.sandbox || "—")} · ${escapeHtml(result.controls?.approvalGate || "—")}</dd></div><div><dt>Verifier</dt><dd>${escapeHtml(verification.at(-1)?.status || "not enabled")}</dd></div></dl>`;
  $("#receipt").textContent = JSON.stringify(result, null, 2);
}

function renderEvents(events) {
  $("#events").innerHTML = events.length ? events.map((event) => `<div><b>${escapeHtml(event.method || "event")}</b>${event.truncated ? " · payload truncated" : ""}</div>`).join("") : "<p>No raw notifications were persisted for this saved run.</p>";
}

async function poll() {
  clearTimeout(pollTimer);
  if (!activeRun) return;
  try {
    const state = await request(`/api/runs/${activeRun}`);
    activeReceipt = state.result || { ...(activeReceipt || {}), timeline: state.timeline || [] };
    renderEvents(state.events || []);
    renderTrace(activeReceipt, state.status, state.error);
    if (state.pendingApproval && !$("#approval-dialog").open) {
      const checkpoint = state.pendingApproval.method === "harness/checkpoint";
      $("#approval-kicker").textContent = checkpoint ? "BETWEEN-PHASE CHECKPOINT" : "PROTECTED TOOL ACTION";
      $("#approval-title").textContent = checkpoint ? "The harness is waiting for you" : "Codex requested a protected action";
      $("#approval-copy").textContent = checkpoint ? "Continuing starts the next executable phase. Stopping ends the harness here." : "This request came from inside the current Codex Work Loop.";
      $("#decision-decline").textContent = checkpoint ? "Stop harness" : "Decline";
      $("#decision-accept").textContent = checkpoint ? "Continue" : "Allow once";
      $("#decision-session").classList.toggle("hidden", checkpoint);
      $("#approval-detail").textContent = JSON.stringify(state.pendingApproval.params, null, 2);
      $("#approval-dialog").showModal();
    }
    if (["completed", "failed"].includes(state.status)) {
      activeRun = null;
      $("#run-button").disabled = false;
      await loadRecentRuns();
      return;
    }
    pollTimer = setTimeout(poll, 650);
  } catch (error) { showTraceError(error.message); $("#run-button").disabled = false; }
}

function selectRunSource(source) {
  $$('[data-run-source]').forEach((button) => button.classList.toggle("active", button.dataset.runSource === source));
  $$(".run-source").forEach((section) => section.classList.toggle("active", section.id === `${source}-run-source`));
  activeReceipt = null;
  activeTracePhase = null;
  $("#trace-content").classList.add("hidden");
  $("#trace-empty").classList.remove("hidden");
  $("#trace-empty h3").textContent = source === "codex" ? "Choose an existing Codex task" : "Choose a saved Weave run";
  $("#trace-empty p").textContent = source === "codex"
    ? "Weave will derive a compact activity map from persisted Codex items. It will not call a model or claim the groups were an original plan."
    : "An exact Weave receipt preserves your authored phases and the observed Codex activity inside them.";
  if (source === "codex" && !$("#codex-thread-list [data-thread-id]")) void browseCodexThreads();
}

function selectTracePanel(panel) {
  $$("[data-trace-panel]").forEach((button) => button.classList.toggle("active", button.dataset.tracePanel === panel));
  $(".trace-detail-grid").dataset.visiblePanel = panel;
}

async function loadIntegrations() {
  const status = $("#integration-status");
  status.textContent = "Reading the effective Codex inventory for this workspace…";
  try {
    const data = await request(`/api/integrations?cwd=${encodeURIComponent($("#cwd").value.trim())}`);
    status.dataset.loaded = "true";
    status.textContent = `Inventory from ${data.cwd}. No credentials or configuration contents were returned.`;
    const skills = data.skills || [];
    const servers = data.mcpServers || [];
    const apps = data.apps || [];
    $("#skill-count").textContent = skills.length;
    $("#mcp-count").textContent = servers.length;
    $("#app-count").textContent = apps.length;
    $("#skill-inventory").innerHTML = skills.length ? skills.map((skill) => `<article><b>${escapeHtml(skill.name)}</b><small>${escapeHtml(skill.description || "No description")}</small><span class="inventory-state">${skill.enabled ? "enabled" : "disabled"} · ${escapeHtml(skill.scope || "scope unknown")}</span>${skill.enabled ? `<button type="button" data-integration-marker="$${escapeHtml(skill.name)}" data-integration-label="Skill: ${escapeHtml(skill.name)}">Include in task</button>` : ""}</article>`).join("") : "<p>No skills were reported for this workspace.</p>";
    $("#mcp-inventory").innerHTML = servers.length ? servers.map((server) => `<article><b>${escapeHtml(server.name)}</b><small>${server.tools.length} tool${server.tools.length === 1 ? "" : "s"}: ${escapeHtml(server.tools.slice(0, 5).join(", ") || "none exposed")}${server.tools.length > 5 ? "…" : ""}</small><span class="inventory-state">auth ${escapeHtml(server.authStatus)}</span></article>`).join("") : "<p>No MCP servers were reported by Codex.</p>";
    $("#app-inventory").innerHTML = apps.length ? apps.map((app) => `<article><b>${escapeHtml(app.name)}</b><small>${escapeHtml(app.description || "Codex connector app")}</small><span class="inventory-state">${app.accessible ? "connected" : app.enabled ? "available" : "disabled"}</span>${app.accessible ? `<button type="button" data-integration-marker="$${escapeHtml(app.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""))}" data-integration-label="App: ${escapeHtml(app.name)}">Include in task</button>` : app.installUrl ? `<a href="${escapeHtml(app.installUrl)}" target="_blank" rel="noreferrer">Connect in Codex ↗</a>` : ""}</article>`).join("") : "<p>No connector apps were reported by Codex.</p>";
    $$('[data-integration-marker]').forEach((button) => button.addEventListener("click", () => toggleIntegration(button)));
    renderIntegrationSelection();
    if (data.pagination?.appsTruncated) status.textContent += " The connector list shows the first 100 entries reported by Codex.";
    if (data.pagination?.mcpTruncated) status.textContent += " The MCP list is paginated and this view shows its first page.";
    if (data.warnings?.length) status.textContent += ` ${data.warnings.join(" ")}`;
  } catch (error) {
    status.textContent = `Inventory unavailable: ${error.message}`;
  }
}

function toggleIntegration(button) {
  const marker = button.dataset.integrationMarker;
  if (selectedIntegrations.has(marker)) selectedIntegrations.delete(marker);
  else selectedIntegrations.set(marker, button.dataset.integrationLabel || marker);
  $$('[data-integration-marker]').forEach((item) => item.classList.toggle("selected", selectedIntegrations.has(item.dataset.integrationMarker)));
  renderIntegrationSelection();
}

function renderIntegrationSelection() {
  const labels = [...selectedIntegrations.values()];
  $("#integration-selection").textContent = labels.length ? labels.join(" · ") : "Nothing selected. Skills and connected Apps can be added as visible invocation markers in your task.";
  $("#apply-integrations").disabled = labels.length === 0;
}

function applySelectedIntegrations() {
  if (!selectedIntegrations.size) return;
  const markerLine = `Use these Codex integrations when relevant: ${[...selectedIntegrations.keys()].join(" ")}.`;
  const task = getPhase("task");
  task.config.goal = `${task.config.goal || "Describe the task here."}\n\n${markerLine}`.trim();
  selectedPhaseId = task.id;
  changed();
  switchView("design");
  toast("Selected integration markers were added visibly to the task");
}

async function approve(decision) {
  if (!activeRun) return;
  await request(`/api/runs/${activeRun}/approval`, { method: "POST", body: JSON.stringify({ decision }) });
  $("#approval-dialog").close();
  poll();
}

async function loadThreads() {
  const root = $("#thread-list");
  root.innerHTML = "Reading Codex thread metadata…";
  try {
    const data = await request(`/api/threads?cwd=${encodeURIComponent($("#cwd").value.trim())}`);
    root.innerHTML = data.threads?.length ? data.threads.map((thread) => `<label><input type="checkbox" value="${escapeHtml(thread.id)}"><span><b>${escapeHtml(thread.name || thread.preview || "Untitled thread")}</b><small>${escapeHtml(thread.id)}</small></span></label>`).join("") : "No saved threads were found for this workspace.";
    $$("input", root).forEach((input) => input.addEventListener("change", scheduleCompile));
  } catch (error) { root.textContent = error.message; }
  scheduleCompile();
}

function applyManifest() {
  try {
    const manifest = JSON.parse($("#manifest-json").value);
    $("#harness-name").value = manifest.name || $("#harness-name").value;
    $("#cwd").value = manifest.cwd || $("#cwd").value;
    $("#model").value = manifest.agent?.model || "";
    $("#effort").value = manifest.agent?.reasoningEffort || "medium";
    $("#sandbox").value = manifest.agent?.sandbox || "read-only";
    phases = starterPhases();
    getPhase("task").config.goal = manifest.task?.instructions || "";
    getPhase("context").config.paths = (manifest.task?.contextPaths || []).join("\n");
    getPhase("memory").config.mode = manifest.memory?.mode || "off";
    if (manifest.memory?.mode === "selected") {
      $("#thread-list").innerHTML = (manifest.memory.selectedThreadIds || []).map((id) => `<label><input type="checkbox" value="${escapeHtml(id)}" checked><span><b>Selected Codex thread</b><small>${escapeHtml(id)}</small></span></label>`).join("");
    }
    getPhase("approval").config.gate = manifest.agent?.approvalGate || "manual";
    if (manifest.phaseProgram?.phases?.length) {
      const editable = manifest.phaseProgram.phases.map((item) => {
        if (item.kind === "work") return { id: item.id, type: "work", title: item.name, config: { goal: item.goal, reasoningEffort: item.reasoningEffort || "inherit" } };
        if (item.kind === "checkpoint") return { id: item.id, type: "checkpoint", title: item.name, config: { question: item.question } };
        return { id: item.id, type: "verify", title: item.name, config: { criteria: item.criteria, maxRepairs: Number(item.maxRepairs || 0) } };
      });
      phases = normalizePhases([...phases.filter((phase) => PHASE_TYPES[phase.type].fixed), ...editable]);
    } else {
      getPhase("verify").config.criteria = manifest.verification?.criteria || "The result satisfies the task.";
      getPhase("verify").config.maxRepairs = Number(manifest.verification?.maxRetries || 0);
      if (!manifest.verification?.enabled) phases = phases.filter((phase) => phase.type !== "verify");
    }
    getPhase("output").config.format = manifest.output?.format || "text";
    selectedPhaseId = phases.find((phase) => phase.type === "task")?.id;
    changed();
    toast("Supported manifest fields applied");
  } catch (error) { toast(`Invalid manifest: ${error.message}`); }
}

function starterPhases() {
  return [
    makePhase("task", { goal: "Describe the outcome you want Codex to produce." }),
    makePhase("context", { paths: "README.md" }),
    makePhase("memory", { mode: "off" }),
    makePhase("approval", { gate: "manual" }),
    makePhase("work", { goal: "Inspect the current implementation and propose a concrete plan.", reasoningEffort: "inherit" }),
    makePhase("checkpoint", { question: "Continue from the proposed plan into implementation?" }),
    makePhase("work", { goal: "Implement the approved plan and run focused tests for the change.", reasoningEffort: "inherit" }),
    makePhase("verify", { criteria: "The implementation satisfies the task and the available test evidence supports the result.", maxRepairs: 1 }),
    makePhase("output", { format: "text" }),
  ];
}

function directPhases() {
  return [
    makePhase("task", { goal: getPhase("task")?.config.goal || "Describe the outcome you want Codex to produce." }),
    makePhase("context", { paths: getPhase("context")?.config.paths || "README.md" }),
    makePhase("memory", { mode: getPhase("memory")?.config.mode || "off" }),
    makePhase("approval", { gate: getPhase("approval")?.config.gate || "manual" }),
    makePhase("work", { goal: "Complete the task using the current repository as evidence. Use the native Codex tool loop as needed.", reasoningEffort: "inherit" }),
    makePhase("verify", { criteria: "The result satisfies the task and focused evidence supports the final response.", maxRepairs: 1 }),
    makePhase("output", { format: "text" }),
  ];
}

function examplePhases(exampleKey) {
  const example = EXAMPLES[exampleKey];
  const fixed = [
    makePhase("task", { goal: example.prompt }),
    makePhase("context", { paths: example.contextPaths.join("\n") }),
    makePhase("memory", { mode: "off" }),
    makePhase("approval", { gate: "manual" }),
  ];
  const program = example.phases.map((item) => {
    if (item.kind === "work") {
      const phase = makePhase("work", { goal: item.detail, reasoningEffort: "inherit" });
      phase.title = item.title;
      return phase;
    }
    if (item.kind === "checkpoint") {
      const phase = makePhase("checkpoint", { question: `${item.detail} Continue into the next phase?` });
      phase.title = item.title;
      return phase;
    }
    const phase = makePhase("verify", { criteria: example.criteria, maxRepairs: exampleKey === "monorepo" ? 2 : 1 });
    phase.title = item.title;
    return phase;
  });
  return normalizePhases([...fixed, ...program, makePhase("output", { format: "text" })]);
}

function loadPreset(key, announce = true) {
  const currentGoal = getPhase("task")?.config.goal || "";
  if (key === "direct") phases = directPhases();
  else if (EXAMPLES[key]) phases = examplePhases(key);
  else phases = starterPhases();
  if (["direct", "review"].includes(key) && currentGoal && !currentGoal.startsWith("Describe the outcome")) getPhase("task").config.goal = currentGoal;
  $("#harness-name").value = key === "direct" ? "Direct work with verification" : EXAMPLES[key]?.name || "Plan, approve, build";
  selectedPhaseId = programPhases()[0]?.id || null;
  $$(".template-card").forEach((button) => button.classList.toggle("active", button.dataset.preset === key));
  changed();
  if (announce) toast("Starting workflow loaded — every phase remains editable");
}

function renderExample(exampleKey) {
  currentExample = EXAMPLES[exampleKey] ? exampleKey : "flappy";
  const example = EXAMPLES[currentExample];
  $$(".example-tab").forEach((button) => {
    const active = button.dataset.example === currentExample;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
  $("#example-title").textContent = example.title;
  $("#example-prompt").textContent = example.prompt;
  $("#example-benefit").textContent = example.benefit;
  $("#example-evidence").innerHTML = `<span>${escapeHtml(example.evidenceLabel)}</span><p>${example.evidence}</p>`;
  $("#weave-flow").innerHTML = example.phases.map((phase, index) => `<div class="${escapeHtml(phase.kind === "checkpoint" ? "gate" : phase.kind)}"><i>${phase.kind === "checkpoint" ? "H" : phase.kind === "verify" ? "✓" : String(index + 1).padStart(2, "0")}</i><span><b>${escapeHtml(phase.title)}</b><small>${escapeHtml(phase.detail)}${phase.kind === "work" ? " Codex may use one or one hundred tools inside." : ""}</small></span></div>`).join("");
}

function renderConnectionStatus({ connected, account = null, error = "" }) {
  const root = $("#connection-status");
  if (!root) return;
  root.className = `connection-status ${connected ? "connected" : "error"}`;
  $("b", root).textContent = connected ? "Weave can reach the local Codex adapter" : "The local Codex adapter is unavailable";
  $("span", root).textContent = connected ? "This confirms the control plane, not subscription authentication." : (error || "Start Weave with a working Codex installation, then retry.");
  if (account) renderAccountDetail(account);
}

function renderAccountDetail(account) {
  const root = $("#account-detail");
  if (!root) return;
  const signedIn = account.canRun === true;
  const type = account.accountType === "chatgpt" ? "ChatGPT" : account.accountType === "apiKey" ? "API key" : account.accountType || "Codex";
  const plan = account.planType ? `${account.planType} plan` : "";
  root.className = `account-detail ${signedIn ? "signed-in" : "signed-out"}`;
  root.innerHTML = `<b>${signedIn ? "Ready to run through " + escapeHtml(type) : "Codex needs authentication"}</b><span>${escapeHtml(account.message || [type, plan].filter(Boolean).join(" · ") || "Use the ChatGPT browser flow or run codex login.")}</span>${account.privacy ? `<small>No secrets or email are returned to this page.</small>` : ""}`;
  $("#chatgpt-login").classList.toggle("hidden", signedIn && account.accountType === "chatgpt");
}

async function checkAccount() {
  try {
    await detectCapabilities();
    const account = await request("/api/account");
    renderAccountDetail(account);
    return account;
  } catch (error) {
    renderAccountDetail({ authenticated: false });
    renderConnectionStatus({ connected: capabilities.phasePrograms, error: error.message });
    return null;
  }
}

async function startChatGptLogin() {
  const button = $("#chatgpt-login");
  button.disabled = true;
  button.textContent = "Opening ChatGPT sign-in…";
  try {
    const result = await request("/api/account/login/chatgpt", { method: "POST", body: JSON.stringify({}) });
    if (result.authUrl) window.open(result.authUrl, "_blank", "noopener,noreferrer");
    $("#account-detail").className = "account-detail waiting";
    $("#account-detail").innerHTML = `<b>Finish signing in in the browser</b><span>${escapeHtml(result.message || "Codex is waiting for ChatGPT authentication.")}</span>`;
    if (result.loginId) pollLogin(result.loginId);
    toast("Complete the ChatGPT sign-in flow opened by Codex");
  } catch (error) {
    toast(`Codex sign-in could not start: ${error.message}`);
  } finally {
    button.disabled = false;
    button.textContent = "Sign in with ChatGPT";
  }
}

async function pollLogin(loginId) {
  clearTimeout(loginPollTimer);
  try {
    const result = await request(`/api/account/login/${encodeURIComponent(loginId)}`);
    if (result.state === "succeeded") {
      renderAccountDetail(result.account || await request("/api/account"));
      toast("ChatGPT sign-in completed in Codex");
      return;
    }
    if (result.state === "failed") {
      renderAccountDetail({ canRun: false, message: result.message });
      return;
    }
    $("#account-detail").innerHTML = `<b>Waiting for the browser sign-in</b><span>${escapeHtml(result.message || "Return here after ChatGPT confirms the connection.")}</span>`;
    loginPollTimer = setTimeout(() => pollLogin(loginId), 900);
  } catch (error) {
    renderAccountDetail({ canRun: false, message: error.message });
  }
}

function useRunControls() {
  if (!activeReceipt) return;
  if (activeReceipt.traceProjection) {
    const fixed = phases.filter((phase) => PHASE_TYPES[phase.type].fixed);
    const editable = [];
    for (const node of activeReceipt.traceProjection.graph?.nodes || []) {
      if (["task", "context", "deliver", "runtime"].includes(node.kind)) continue;
      if (node.kind === "verify") {
        if (editable.at(-1)?.type !== "verify") editable.push(makePhase("verify", { criteria: "Confirm the result satisfies the task using current workspace evidence.", maxRepairs: 1 }));
        continue;
      }
      if (node.kind === "approval") continue;
      const phase = makePhase("work", { goal: `Complete the ${String(node.title || node.kind).toLowerCase()} stage for the task. Reinspect the current workspace instead of assuming the earlier trace is still valid.`, reasoningEffort: "inherit" });
      phase.title = node.title || PHASE_TYPES.work.defaultTitle;
      editable.push(phase);
      if (editable.length === 8) break;
    }
    if (!editable.some((phase) => phase.type === "work")) editable.unshift(makePhase("work", { goal: "Complete the task using current workspace evidence.", reasoningEffort: "inherit" }));
    phases = normalizePhases([...fixed, ...editable.slice(0, 8)]);
    selectedPhaseId = programPhases()[0]?.id;
    changed();
    switchView("design");
    toast("Created an editable draft from the derived trace shape; review its generic goals before running");
    return;
  }
  const approval = getPhase("approval");
  const memory = getPhase("memory");
  if (approval) approval.config.gate = activeReceipt.controls?.approvalGate || approval.config.gate;
  if (memory) memory.config.mode = activeReceipt.memory?.mode === "selected" ? "off" : (activeReceipt.memory?.mode || "off");
  $("#sandbox").value = activeReceipt.controls?.sandbox || $("#sandbox").value;
  changed();
  switchView("design");
  toast("Copied available controls; saved receipts do not include the original task text");
}

function bindGlobalEvents() {
  $$(".view-tab").forEach((button) => button.addEventListener("click", () => switchView(button.dataset.view)));
  $$('[data-view-link]').forEach((control) => control.addEventListener("click", (event) => { event.preventDefault(); switchView(control.dataset.viewLink); }));
  $$('[data-open-builder]').forEach((button) => button.addEventListener("click", () => switchView("design")));
  $("#new-harness").addEventListener("click", () => switchView("design"));
  $$(".example-tab").forEach((button) => button.addEventListener("click", () => renderExample(button.dataset.example)));
  $("#copy-example-prompt").addEventListener("click", async () => { await navigator.clipboard.writeText(EXAMPLES[currentExample].prompt); toast("Prompt copied"); });
  $("#use-example").addEventListener("click", () => { loadPreset(currentExample); switchView("design"); });
  $$(".template-card").forEach((button) => button.addEventListener("click", () => loadPreset(button.dataset.preset)));
  $$(".run-settings-strip button").forEach((button) => button.addEventListener("click", () => selectSetup(button.dataset.selectType)));
  $("#goal-input").addEventListener("input", (event) => { getPhase("task").config.goal = event.target.value; saveDraft(); scheduleCompile(); });
  $("#search-workspace").addEventListener("click", searchWorkspacePaths);
  $("#workspace-query").addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); searchWorkspacePaths(); } });
  $("#refresh-runs").addEventListener("click", () => loadRecentRuns());
  $$('[data-run-source]').forEach((button) => button.addEventListener("click", () => selectRunSource(button.dataset.runSource)));
  $$('[data-trace-panel]').forEach((button) => button.addEventListener("click", () => selectTracePanel(button.dataset.tracePanel)));
  $("#browse-threads").addEventListener("click", browseCodexThreads);
  $("#refresh-integrations").addEventListener("click", loadIntegrations);
  $("#apply-integrations").addEventListener("click", applySelectedIntegrations);
  $("#event-filter").addEventListener("change", () => activeReceipt?.traceProjection ? renderProjectionActivity(activeReceipt.traceProjection) : renderTimeline(activeReceipt?.timeline || []));
  $("#copy-result").addEventListener("click", async () => { await navigator.clipboard.writeText($("#final-response").textContent); toast("Result copied"); });
  $("#use-run-controls").addEventListener("click", useRunControls);
  $("#compile").addEventListener("click", compile);
  $("#run-button").addEventListener("click", run);
  $("#load-threads").addEventListener("click", loadThreads);
  $("#thread-list").addEventListener("change", scheduleCompile);
  $("#apply-json").addEventListener("click", applyManifest);
  $("#harness-name").addEventListener("input", () => { saveDraft(); scheduleCompile(); });
  $$("#cwd, #model, #effort, #sandbox").forEach((control) => control.addEventListener("change", () => {
    if (control.id === "cwd") { workspaceEntries = []; $("#workspace-results").innerHTML = `<div class="workspace-empty">Workspace changed. Browse to load path names.</div>`; }
    scheduleCompile();
  }));
  $("#reset-canvas").addEventListener("click", () => { phases = normalizePhases(phases.filter((phase) => PHASE_TYPES[phase.type].fixed)); selectedPhaseId = null; changed(); });
  $("#load-preset").addEventListener("click", () => loadPreset("review"));
  $("#check-connection").addEventListener("click", checkAccount);
  $("#chatgpt-login").addEventListener("click", startChatGptLogin);
  $$(".copy-command").forEach((button) => button.addEventListener("click", async () => { await navigator.clipboard.writeText(button.dataset.copy); toast("Command copied"); }));
  const dropzone = $("#canvas-dropzone");
  dropzone.addEventListener("dragover", (event) => { event.preventDefault(); dropzone.classList.add("over"); });
  dropzone.addEventListener("dragleave", () => dropzone.classList.remove("over"));
  dropzone.addEventListener("drop", (event) => { event.preventDefault(); dropzone.classList.remove("over"); dropAt(phases.length); });
  $$('[data-decision]').forEach((button) => button.addEventListener("click", (event) => { event.preventDefault(); approve(button.dataset.decision); }));
  window.addEventListener("popstate", () => switchView(location.hash.slice(1) || "home", false));
}

async function init() {
  const stored = (() => { try { return JSON.parse(localStorage.getItem("weave-codex-phase-draft")); } catch (_) { return null; } })();
  if (stored?.name) $("#harness-name").value = stored.name;
  renderPalette();
  renderCanvas();
  renderExample("flappy");
  bindGlobalEvents();
  try { await bootstrapSession(); } catch (error) { renderConnectionStatus({ connected: false, error: error.message }); }
  await detectCapabilities();
  await compile();
  await loadRecentRuns(true);
  const requestedView = location.hash.slice(1) || "home";
  switchView(requestedView, false);
  if (!location.hash) history.replaceState({ view: "home" }, "", "#home");
}

init();
