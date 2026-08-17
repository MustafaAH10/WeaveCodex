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
  makePhase("task", { goal: "Inspect this repository without changing files. Explain the control flow in three concise bullets and cite the files you inspected." }),
  makePhase("context", { paths: "README.md\ncodex-rs/app-server/README.md" }),
  makePhase("memory", { mode: "off" }),
  makePhase("approval", { gate: "manual" }),
  makePhase("work", { goal: "Investigate the task thoroughly using Codex's native tools. Report only claims supported by inspected evidence.", reasoningEffort: "inherit" }),
  makePhase("verify", { criteria: "The answer is correct, complete, grounded in inspected evidence, and follows the task.", maxRepairs: 1 }),
  makePhase("output", { format: "text" }),
];

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
  const response = await fetch(path, { headers: { "Content-Type": "application/json" }, ...options });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { error: text || `HTTP ${response.status}` }; }
  if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : JSON.stringify(data.error));
  return data;
}

async function detectCapabilities() {
  try {
    const response = await fetch("/api/phase-templates", { headers: { Accept: "application/json" } });
    if (!response.ok) return;
    const data = await response.json();
    capabilities = {
      phasePrograms: data.phasePrograms === true || Array.isArray(data.templates),
      compileEndpoint: data.compileEndpoint || null,
      runEndpoint: data.runEndpoint || null,
    };
  } catch (_) {
    // The current v1 server has no capabilities endpoint; the fixed-manifest adapter remains usable.
  }
}

function switchView(view) {
  $$(".view-tab").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  $$(".app-view").forEach((panel) => panel.classList.toggle("active", panel.id === `${view}-view`));
  history.replaceState(null, "", view === "build" ? "#build" : "#observe");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function renderPalette() {
  const item = ([type, definition], fixed) => `<button class="palette-item ${fixed ? "fixed-control" : ""}" type="button" draggable="${fixed ? "false" : "true"}" ${fixed ? `data-select-type="${type}"` : `data-phase-type="${type}"`}>
      <span class="phase-icon type-${type}">${definition.icon}</span><span><b>${definition.label}</b><small>${definition.description}</small></span><i aria-hidden="true">${fixed ? "↗" : "＋"}</i>
    </button>`;
  const entries = Object.entries(PHASE_TYPES);
  $("#phase-palette").innerHTML = `<p class="palette-group-label">EXECUTABLE PHASES</p>${entries.filter(([, value]) => !value.fixed).map((entry) => item(entry, false)).join("")}<p class="palette-group-label">RUN-WIDE SETUP</p>${entries.filter(([, value]) => value.fixed).map((entry) => item(entry, true)).join("")}`;
  $$(".palette-item").forEach((button) => {
    button.addEventListener("click", () => button.dataset.phaseType ? addPhase(button.dataset.phaseType) : selectSetup(button.dataset.selectType));
    button.addEventListener("dragstart", (event) => {
      if (!button.dataset.phaseType) { event.preventDefault(); return; }
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

function renderCanvas() {
  const canvas = $("#phase-canvas");
  if (!phases.length) {
    canvas.innerHTML = `<div class="canvas-empty"><b>Your canvas is empty</b><span>Add Task, Codex Work Loop, and Output to make an executable starting point.</span></div>`;
  } else {
    canvas.innerHTML = phases.map((phase, index) => {
      const definition = PHASE_TYPES[phase.type];
      const fixed = Boolean(definition.fixed);
      return `<article class="phase-card ${fixed ? "fixed-phase" : "executable-phase"} ${selectedPhaseId === phase.id ? "selected" : ""}" draggable="${fixed ? "false" : "true"}" data-phase-id="${escapeHtml(phase.id)}" data-phase-type="${phase.type}" tabindex="0">
        <div class="phase-rail"><button class="drag-handle" type="button" aria-label="${fixed ? "Run-wide control" : `Drag ${escapeHtml(phase.title)}`}" ${fixed ? "disabled" : ""}>${fixed ? "◆" : "⠿"}</button><span>${String(index + 1).padStart(2, "0")}</span></div>
        <span class="phase-icon type-${phase.type}">${definition.icon}</span>
        <div class="phase-copy"><small>${fixed ? "RUN-WIDE CONTROL" : "EXECUTABLE PHASE"} · ${definition.label}${phase.type === "work" ? " · CODEX-MANAGED INTERIOR" : ""}</small><b>${escapeHtml(phase.title)}</b><p>${escapeHtml(phaseSummary(phase))}</p>${phase.type === "work" ? `<em>May contain many reasoning and tool iterations</em>` : ""}</div>
        ${fixed ? `<div class="phase-controls"><span class="fixed-label">FIXED</span></div>` : `<div class="phase-controls"><button type="button" data-move="up" aria-label="Move up">↑</button><button type="button" data-move="down" aria-label="Move down">↓</button><button type="button" data-remove aria-label="Remove phase">×</button></div>`}
      </article>`;
    }).join("");
  }
  bindCanvasEvents();
  renderInspector();
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
    <label class="field"><span>Phase name</span><input data-phase-field="title" value="${escapeHtml(phase.title)}" /></label>
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
  switchView("observe");
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
    root.innerHTML = data.threads?.length ? data.threads.map((thread) => `<button type="button" data-thread-id="${escapeHtml(thread.id)}"><b>${escapeHtml(thread.name || thread.preview || "Untitled Codex thread")}</b><small>${escapeHtml(thread.id)}</small></button>`).join("") : "<p>No Codex threads were found for this workspace.</p>";
    $$('[data-thread-id]', root).forEach((button) => button.addEventListener("click", () => loadThreadProjection(button.dataset.threadId, $("b", button).textContent)));
  } catch (error) { root.innerHTML = `<p>Thread browsing is unavailable: ${escapeHtml(error.message)}</p>`; }
}

async function loadThreadProjection(threadId, name) {
  $$("[data-thread-id]").forEach((button) => button.classList.toggle("active", button.dataset.threadId === threadId));
  $$(".run-item").forEach((button) => button.classList.remove("active"));
  showTraceLoading("Projecting Codex thread…");
  try {
    const projection = await request("/api/thread-projection", { method: "POST", body: JSON.stringify({ cwd: $("#cwd").value.trim(), threadId }) });
    activeRun = null;
    activeTracePhase = null;
    activeReceipt = { runId: threadId, threadName: name, traceProjection: projection, timeline: [], finalResponse: "This is a privacy-preserving phase projection of an existing Codex thread. The original response body is not copied into the projection." };
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
  const groups = projection ? projection.graph?.nodes || [] : phaseGroups(timeline);
  const observed = result.observed || {};
  const tools = projection?.counts?.toolCalls ?? timeline.filter((event) => event.kind === "tool_call").length;
  $("#trace-empty").classList.add("hidden");
  $("#trace-content").classList.remove("hidden");
  $("#trace-status").className = `status-pill ${status}`;
  $("#trace-status").textContent = status === "completed" ? "Complete" : status === "failed" ? "Failed" : "Running";
  $("#trace-title").textContent = status === "running" ? "Codex is working" : result.threadName || "Codex execution trace";
  $("#trace-meta").textContent = projection ? `${String(result.runId || "thread").slice(0, 16)} · derived phase view · ${projection.projectionBasis}` : `${result.runId ? result.runId.slice(0, 8) : "live"} · ${result.controls?.sandbox || "control pending"} · memory ${result.memory?.mode || "off"}${error ? ` · ${error}` : ""}`;
  $("#use-run-controls").textContent = projection ? "Use this trace shape" : "Use these controls";
  $("#metric-phases").textContent = groups.length;
  $("#metric-tools").textContent = tools;
  $("#metric-model").textContent = projection?.counts?.modelCompletions ?? observed.modelCompletions ?? "—";
  $("#metric-turns").textContent = projection?.counts?.turns ?? result.turnIds?.length ?? "—";
  const observationCount = projection?.counts?.events ?? projection?.counts?.items ?? timeline.length;
  $("#trace-event-count").textContent = `${observationCount} source observation${observationCount === 1 ? "" : "s"}${projection ? " · derived grouping" : ""}`;
  if (projection) renderProjectionMap(projection);
  else renderExecutionMap(groups);
  if (projection && !timeline.length) renderProjectionActivity(projection);
  else renderTimeline(timeline);
  $("#final-response").textContent = result.finalResponse || (status === "running" ? "Waiting for the final response…" : error || "No final response was stored.");
  renderReceipt(result);
}

function renderProjectionMap(projection) {
  const nodes = projection.graph?.nodes || [];
  const root = $("#execution-map");
  if (!nodes.length) { root.innerHTML = `<div class="map-empty">This thread contains no projectable phases.</div>`; return; }
  root.innerHTML = nodes.map((node, index) => `<button class="executed-phase derived ${activeTracePhase === node.id ? "active" : ""}" type="button" data-trace-phase="${escapeHtml(node.id)}"><span>${String(index + 1).padStart(2, "0")}</span><div><small>${escapeHtml(node.kind)} · ${escapeHtml(node.confidence)}</small><b>${escapeHtml(node.title)}</b><p>${Number(node.counts?.toolCalls || 0)} tool call${Number(node.counts?.toolCalls || 0) === 1 ? "" : "s"} · ${Number(node.counts?.items || node.counts?.events || 0)} source items</p></div><em>${escapeHtml(node.summary || "Derived from persisted Codex records")}</em></button>`).join("");
  $$(".executed-phase", root).forEach((button) => button.addEventListener("click", () => {
    activeTracePhase = activeTracePhase === button.dataset.tracePhase ? null : button.dataset.tracePhase;
    renderProjectionMap(projection);
    renderProjectionActivity(projection);
  }));
}

function renderProjectionActivity(projection) {
  const nodes = (projection.graph?.nodes || []).filter((node) => !activeTracePhase || node.id === activeTracePhase);
  const root = $("#timeline");
  if (!nodes.length) { root.innerHTML = `<div class="timeline-empty">No projected activity is available.</div>`; return; }
  root.innerHTML = nodes.map((node) => `<div class="timeline-phase"><span>${escapeHtml(node.title)}</span><i>derived · ${escapeHtml(node.confidence)}</i></div><article class="timeline-event kind-${escapeHtml(node.kind)}"><span class="event-index">${escapeHtml(node.kind.slice(0, 2).toUpperCase())}</span><div><small>${escapeHtml(node.kind)} phase</small><b>${escapeHtml(node.summary)}</b><p>${Number(node.counts?.toolCalls || 0)} tool calls · ${Number(node.counts?.items || 0)} items · ${node.turnIds?.length || 0} turns${node.toolBurst?.labels?.length ? ` · ${escapeHtml(node.toolBurst.labels.join(", "))}` : ""}</p></div></article>`).join("");
}

function renderExecutionMap(groups) {
  const root = $("#execution-map");
  if (!groups.length) { root.innerHTML = `<div class="map-empty">Waiting for the first phase event…</div>`; return; }
  root.innerHTML = groups.map((group, index) => {
    const tools = group.events.filter((event) => event.kind === "tool_call").length;
    const reasoning = group.events.filter((event) => event.kind === "reasoning").length;
    return `<button class="executed-phase ${activeTracePhase === group.id ? "active" : ""}" type="button" data-trace-phase="${escapeHtml(group.id)}"><span>${String(index + 1).padStart(2, "0")}</span><div><small>HARNESS PHASE</small><b>${escapeHtml(group.label)}</b><p>${tools} tool request${tools === 1 ? "" : "s"} · ${reasoning} reasoning item${reasoning === 1 ? "" : "s"}</p></div>${group.id === "solver" ? `<em>Codex-managed loop</em>` : ""}</button>`;
  }).join("");
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
    switchView("build");
    toast("Created an editable draft from the derived trace shape; review its generic goals before running");
    return;
  }
  const approval = getPhase("approval");
  const memory = getPhase("memory");
  if (approval) approval.config.gate = activeReceipt.controls?.approvalGate || approval.config.gate;
  if (memory) memory.config.mode = activeReceipt.memory?.mode === "selected" ? "off" : (activeReceipt.memory?.mode || "off");
  $("#sandbox").value = activeReceipt.controls?.sandbox || $("#sandbox").value;
  changed();
  switchView("build");
  toast("Copied available controls; saved receipts do not include the original task text");
}

function bindGlobalEvents() {
  $$(".view-tab").forEach((button) => button.addEventListener("click", () => switchView(button.dataset.view)));
  $$('[data-open-builder]').forEach((button) => button.addEventListener("click", () => switchView("build")));
  $("#new-harness").addEventListener("click", () => switchView("build"));
  $("#refresh-runs").addEventListener("click", () => loadRecentRuns());
  $("#browse-threads").addEventListener("click", browseCodexThreads);
  $("#event-filter").addEventListener("change", () => activeReceipt?.traceProjection ? renderProjectionActivity(activeReceipt.traceProjection) : renderTimeline(activeReceipt?.timeline || []));
  $("#copy-result").addEventListener("click", async () => { await navigator.clipboard.writeText($("#final-response").textContent); toast("Result copied"); });
  $("#use-run-controls").addEventListener("click", useRunControls);
  $("#compile").addEventListener("click", compile);
  $("#run-button").addEventListener("click", run);
  $("#load-threads").addEventListener("click", loadThreads);
  $("#thread-list").addEventListener("change", scheduleCompile);
  $("#apply-json").addEventListener("click", applyManifest);
  $("#harness-name").addEventListener("input", () => { saveDraft(); scheduleCompile(); });
  $$("#cwd, #model, #effort, #sandbox").forEach((control) => control.addEventListener("change", scheduleCompile));
  $("#reset-canvas").addEventListener("click", () => { phases = normalizePhases([]); selectedPhaseId = getPhase("task")?.id || null; changed(); });
  $("#load-preset").addEventListener("click", () => { phases = starterPhases(); selectedPhaseId = phases.find((phase) => phase.type === "work").id; changed(); });
  const dropzone = $("#canvas-dropzone");
  dropzone.addEventListener("dragover", (event) => { event.preventDefault(); dropzone.classList.add("over"); });
  dropzone.addEventListener("dragleave", () => dropzone.classList.remove("over"));
  dropzone.addEventListener("drop", (event) => { event.preventDefault(); dropzone.classList.remove("over"); dropAt(phases.length); });
  $$('[data-decision]').forEach((button) => button.addEventListener("click", (event) => { event.preventDefault(); approve(button.dataset.decision); }));
}

async function init() {
  const stored = (() => { try { return JSON.parse(localStorage.getItem("weave-codex-phase-draft")); } catch (_) { return null; } })();
  if (stored?.name) $("#harness-name").value = stored.name;
  renderPalette();
  renderCanvas();
  bindGlobalEvents();
  await detectCapabilities();
  await compile();
  await loadRecentRuns(true);
  if (location.hash === "#build") switchView("build");
}

init();
