const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
const CanvasModel = typeof module !== "undefined" && module.exports
  ? require("./canvas-model.js")
  : globalThis.WeaveCanvasModel;
const { clone, linearGraph, orderedClientPhases, graphProblem, wouldCreateCycle, uniquePhaseId, layoutRunGraph } = CanvasModel;
const trashIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13M10 11v5m4-5v5"/></svg>';
const duplicateIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>';

let securitySession = null;
let runMode = "weave";
let activeRun = null;
let pollTimer = null;
let activeSavedWorkflow = null;
let savedWorkflows = [];
let loginPollTimer = null;
let designProgram = null;
let adaptationMethod = null;
let integrationInventory = null;
let selectedIntegrations = [];
let selectedRunId = null;
let voiceRecognition = null;
let voiceListening = false;
let voiceBaseText = "";
let pendingIsCheckpoint = false;
let selectedPhaseIndex = 0;
let selectedEdgeIndex = null;
let canvasDrag = null;
let connectionDraft = null;
let phaseTemplateCatalog = new Map();
let canvasZoom = 1;
let canvasPan = { x: 0, y: 0 };
let canvasPanDrag = null;
let canvasPanMoved = false;
let canvasNotice = "";
let arrowTool = null;
let uploadedFiles = [];

async function request(path, options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  const headers = { ...(options.headers || {}) };
  if (method !== "GET") {
    headers["Content-Type"] = "application/json";
    if (securitySession?.csrfToken) headers["X-Weave-CSRF"] = securitySession.csrfToken;
  }
  const response = await fetch(path, { ...options, method, headers });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { error: text || `HTTP ${response.status}` }; }
  if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : JSON.stringify(data.error));
  return data;
}

function graphTemplate(kind) {
  const catalogTemplate = phaseTemplateCatalog.get(kind);
  if (catalogTemplate) return clone(catalogTemplate.program);
  if (["review", "direct", "audit", "precision"].includes(kind)) return linearGraph(kind);
  if (kind === "blank") {
    return { projectionVersion: 1, phases: [{ id: "first-step", kind: "work", scope: "adaptive", name: "First Codex turn", goal: "Describe what Codex should accomplish before handing work to the next node.", reasoningEffort: "inherit", position: { x: 170, y: 250 } }], edges: [] };
  }
  return linearGraph("review");
}

function selectedProgram() {
  if (designProgram) return clone(designProgram);
  if (activeSavedWorkflow) return clone(activeSavedWorkflow.phaseProgram);
  return graphTemplate("review");
}

function buildManifest({ mode, name, cwd, instructions, integrations, agent, program }) {
  const direct = mode === "ordinary";
  const requested = clone(integrations?.requested || []).map((item) => direct ? { ...item, phaseIds: [] } : item);
  const value = {
    schemaVersion: direct ? 1 : 2,
    name,
    cwd,
    task: { instructions, contextPaths: uploadedFiles.map((file) => file.path) },
    memory: { mode: "off", selectedThreadIds: [] },
    integrations: { inventoryId: integrations?.inventoryId || null, requested },
    agent,
    verification: { enabled: false, criteria: direct ? "Codex owns checking inside its native adaptive run." : "Phase program owns verification.", maxRetries: 0 },
    output: { format: "text" },
    observability: { traceRoot: ".weave-codex/traces" },
  };
  if (!direct) value.phaseProgram = clone(program);
  return value;
}

function manifest() {
  const authoredName = $("#design-save-name")?.value.trim();
  return buildManifest({
    mode: runMode,
    name: runMode === "ordinary" ? "Codex direct" : (activeSavedWorkflow?.name || authoredName || "My workflow"),
    cwd: $("#workspace-input").value.trim(),
    instructions: $("#task-input").value.trim(),
    integrations: { inventoryId: integrationInventory?.inventoryId || null, requested: selectedIntegrations },
    agent: { model: null, reasoningEffort: "medium", sandbox: $("#sandbox-select").value, approvalGate: $("#approval-select").value },
    program: selectedProgram(),
  });
}

function setView(view, { updateHash = true } = {}) {
  const aliases = {
    run: "create", design: "create", architecture: "create",
    workflows: "library", integrations: "library", setup: "library",
    runs: "activity", "field-trials": "activity",
  };
  const requested = aliases[view] || view;
  const allowed = new Set(["create", "library", "activity", "docs"]);
  const active = allowed.has(requested) ? requested : "create";
  $$(".product-view").forEach((panel) => {
    const selected = panel.id === `${active}-view`;
    panel.hidden = !selected;
    panel.classList.toggle("active", selected);
  });
  $$("[data-view]").forEach((link) => {
    const selected = link.dataset.view === active;
    link.classList.toggle("active", selected);
    if (selected) link.setAttribute("aria-current", "page"); else link.removeAttribute("aria-current");
  });
  if (updateHash) history.pushState(null, "", `#${active}`);
  $(".more-menu")?.removeAttribute("open");
  window.scrollTo(0, 0);
  if (active === "library") {
    if (runMode === "ordinary") setMode("weave");
    void loadWorkflows();
    $("#integrations-cwd").value ||= $("#workspace-input").value;
    void checkAccount();
  }
  if (active === "create") renderPhaseEditor();
  if (active === "activity") {
    void loadRuns();
    void loadFieldTrials();
  }
}

function setMode(mode) {
  runMode = mode;
  $$(".mode").forEach((button) => {
    const active = button.dataset.mode === mode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-checked", String(active));
  });
  if (mode === "weave" && !designProgram) designProgram = graphTemplate("review");
  const runButton = $("#run-task");
  if (runButton && !runButton.disabled) runButton.innerHTML = mode === "weave" ? "Run my workflow <span>→</span>" : "Run with Codex <span>→</span>";
}

function programNodes(program, { compact = false } = {}) {
  const phases = orderedClientPhases(program || { phases: [], edges: [] });
  return phases.map((phase, index) => `<article class="phase-node ${escapeHtml(phase.kind)}"><small>${index + 1} · ${escapeHtml(phaseKindLabel(phase))}</small><b>${escapeHtml(phase.name)}</b></article>${index < phases.length - 1 ? '<i aria-hidden="true">→</i>' : ""}`).join("") || (compact ? "" : "<p>No steps yet.</p>");
}

function stepKind(kind, stepType = "") {
  if (kind === "command") return ({ function: "One function", test: "Exact test", checker: "Exact checker" })[stepType] || "Exact command";
  return ({ work: "Codex works", checkpoint: "Calibration", verify: "AI review", native: "Codex works" })[kind] || "Observed activity";
}

function phaseKindLabel(phase) {
  if (phase?.kind === "work") return phase.scope === "focused" ? "Focused Codex task" : phase.scope === "adaptive" ? "Broad Codex goal" : "Codex goal";
  return stepKind(phase?.kind, phase?.stepType);
}

function friendlyStatus(value) {
  const text = String(value || "unknown").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function phasePlainCopy(phase) {
  if (phase.kind === "checkpoint") return { actor: "Calibration", copy: phase.question, note: "Lock or redirect the intent before the next Codex step." };
  if (phase.kind === "verify") return { actor: "AI review", copy: phase.criteria, note: `Codex can repair up to ${phase.maxRepairs || 0} time${phase.maxRepairs === 1 ? "" : "s"}.` };
  if (phase.kind === "command") return { actor: stepKind(phase.kind, phase.stepType), copy: phase.command, note: `Passed only when this exact command is observed with exit code ${phase.expectedExitCode ?? 0}.` };
  return phase.scope === "focused"
    ? { actor: "Focused Codex task", copy: phase.goal, note: "Codex keeps this turn narrow and does not expand into adjacent work." }
    : { actor: "Broad Codex goal", copy: phase.goal, note: "Codex chooses the internal plan and may inspect, edit, test, and retry as much as the outcome requires." };
}

function setVoiceState(listening, message) {
  voiceListening = listening;
  const button = $("#voice-input");
  button.classList.toggle("listening", listening);
  button.setAttribute("aria-pressed", String(listening));
  button.querySelector("b").textContent = listening ? "Stop" : "Speak";
  $("#voice-status").textContent = message;
}

function configureVoiceInput() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) {
    $("#voice-input").disabled = true;
    $("#voice-status").textContent = "Browser dictation is unavailable here. You can still type or paste your goal; Weave does not record audio.";
    return;
  }
  voiceRecognition = new Recognition();
  voiceRecognition.continuous = true;
  voiceRecognition.interimResults = true;
  voiceRecognition.lang = navigator.language || "en-US";
  voiceRecognition.onstart = () => setVoiceState(true, "Listening… speak naturally. Select Stop when you are finished.");
  voiceRecognition.onresult = (event) => {
    let transcript = "";
    for (let index = 0; index < event.results.length; index += 1) transcript += event.results[index][0].transcript;
    $("#task-input").value = `${voiceBaseText}${voiceBaseText && transcript ? " " : ""}${transcript}`.trim();
  };
  voiceRecognition.onerror = (event) => {
    const denied = event.error === "not-allowed" || event.error === "service-not-allowed";
    setVoiceState(false, denied ? "Microphone access was not allowed. You can enable it in browser settings or keep typing." : "Voice input stopped. Your transcript is still here; you can continue typing.");
  };
  voiceRecognition.onend = () => {
    if (voiceListening) setVoiceState(false, "Voice input stopped. Review or edit your goal before running.");
  };
}

function toggleVoiceInput() {
  if (!voiceRecognition) return;
  if (voiceListening) {
    voiceRecognition.stop();
    return;
  }
  voiceBaseText = $("#task-input").value.trim();
  try {
    voiceRecognition.start();
  } catch (_) {
    setVoiceState(false, "Voice input is already starting. Please try again in a moment.");
  }
}

function applyWorkflow(workflow, { customize = false } = {}) {
  activeSavedWorkflow = workflow;
  designProgram = clone(workflow.phaseProgram);
  selectedPhaseIndex = 0;
  adaptationMethod = null;
  $("#design-save-name").value = workflow.name;
  $("#workflow-name").value = workflow.name;
  setMode("weave");
  $("#task-input").value = "";
  if (customize) {
    setView("create");
    $("#workflow-canvas").scrollIntoView({ behavior: "smooth", block: "start" });
  } else {
    setView("create");
    $("#task-input").focus();
  }
}

function workflowCard(workflow) {
  const created = new Date(workflow.createdAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  const lineage = workflow.parentWorkflowId ? "Adapted from another saved workflow" : "Original workflow";
  return `<article class="saved-workflow"><header><div><small>Saved ${escapeHtml(created)}</small><h3>${escapeHtml(workflow.name)}</h3></div><button class="trash-button" type="button" data-delete-workflow="${escapeHtml(workflow.workflowId)}" title="Delete workflow" aria-label="Delete ${escapeHtml(workflow.name)}">${trashIcon}</button></header><p>${escapeHtml(workflow.description || "No description.")}</p><div class="mini-program">${programNodes(workflow.phaseProgram, { compact: true })}</div><footer><span>${workflow.phaseProgram.phases.length} steps · ${escapeHtml(lineage)}</span><div><button type="button" data-use-workflow="${escapeHtml(workflow.workflowId)}">Use for a new task</button><button type="button" data-customize-workflow="${escapeHtml(workflow.workflowId)}">Customize</button></div></footer></article>`;
}

function bindWorkflowUseButtons() {
  $$('[data-use-workflow]').forEach((button) => button.addEventListener("click", () => {
    const workflow = savedWorkflows.find((item) => item.workflowId === button.dataset.useWorkflow);
    if (workflow) applyWorkflow(workflow);
  }));
  $$('[data-customize-workflow]').forEach((button) => button.addEventListener("click", () => {
    const workflow = savedWorkflows.find((item) => item.workflowId === button.dataset.customizeWorkflow);
    if (workflow) applyWorkflow(workflow, { customize: true });
  }));
  $$('[data-delete-workflow]').forEach((button) => button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await request(`/api/workflows/${button.dataset.deleteWorkflow}`, { method: "DELETE" });
      if (activeSavedWorkflow?.workflowId === button.dataset.deleteWorkflow) activeSavedWorkflow = null;
      await loadWorkflows();
    } catch (error) {
      button.disabled = false;
      $("#save-status").textContent = `Could not delete workflow: ${error.message}`;
    }
  }));
}

async function loadWorkflows() {
  const library = $("#workflow-library");
  try {
    const result = await request("/api/workflows");
    savedWorkflows = result.workflows || [];
    library.innerHTML = savedWorkflows.length ? savedWorkflows.map(workflowCard).join("") : '<div class="empty-library"><b>No saved workflows yet.</b><p>Save your current process. The task and folder will not be included.</p></div>';
    bindWorkflowUseButtons();
  } catch (error) {
    library.innerHTML = `<p>Workflow library unavailable: ${escapeHtml(error.message)}</p>`;
  }
}

async function saveWorkflow() {
  const button = $("#save-workflow");
  const status = $("#save-status");
  const payload = {
    name: $("#workflow-name").value.trim(),
    description: $("#workflow-description").value.trim(),
    phaseProgram: selectedProgram(),
    parentWorkflowId: activeSavedWorkflow && adaptationMethod ? activeSavedWorkflow.workflowId : null,
    adaptationMethod: activeSavedWorkflow && adaptationMethod ? adaptationMethod : null,
    adaptationSummary: activeSavedWorkflow && adaptationMethod ? "Human-reviewed goal wording changed; phase structure remains explicit." : "",
  };
  button.disabled = true;
  status.textContent = "Saving locally…";
  try {
    const saved = await request("/api/workflows", { method: "POST", body: JSON.stringify(payload) });
    activeSavedWorkflow = saved;
    status.textContent = `Saved “${saved.name}”. The task and folder were not included.`;
    await loadWorkflows();
  } catch (error) {
    status.textContent = `Could not save: ${error.message}`;
  } finally {
    button.disabled = false;
  }
}

function renderSteps(phases, state = {}) {
  const activePhase = state.pendingApproval?.params?.phaseId || state.result?.phaseProgram?.activePhaseId || "";
  const executions = state.result?.phaseProgram?.executions || [];
  const executionById = new Map(executions.map((item) => [item.phaseId, item]));
  $("#run-steps").innerHTML = phases.map((phase, index) => {
    const execution = executionById.get(phase.id);
    const nativeDone = phase.kind === "native" && state.status === "completed";
    const nativeActive = phase.kind === "native" && !["completed", "failed"].includes(state.status);
    const className = execution?.status === "fail" ? "failed" : execution?.status === "stopped" ? "stopped" : execution || nativeDone ? "done" : activePhase === phase.id || nativeActive ? "active" : "";
    const stateLabel = execution?.status === "pass" ? "Passed" : execution?.status === "fail" ? "Failed" : execution?.status === "stopped" ? "Stopped" : className === "done" ? "Done" : "";
    return `<article class="${className}"><small>${escapeHtml(phaseKindLabel(phase))}</small><b>${escapeHtml(phase.name)}</b>${stateLabel ? `<em>${stateLabel}</em>` : ""}</article>`;
  }).join("");
}

function displaySteps(value) {
  return value.phaseProgram ? orderedClientPhases(value.phaseProgram) : [{ id: "native-codex-run", kind: "native", name: "One native adaptive Codex run" }];
}

async function startRun() {
  clearTimeout(pollTimer);
  const value = manifest();
  if (value.task.instructions.length < 4) { $("#task-input").focus(); return; }
  if (!value.cwd.startsWith("/")) { $("#workspace-input").focus(); return; }
  if (runMode === "weave") {
    const problem = graphProblem(value.phaseProgram);
    if (problem) {
      $("#design-status").textContent = problem;
      $("#design-status").classList.add("error");
      $("#workflow-canvas").scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
  }
  const button = $("#run-task");
  button.disabled = true;
  button.textContent = "Checking run…";
  try {
    const compiled = await request("/api/compile", { method: "POST", body: JSON.stringify(value) });
    const phases = displaySteps(value);
    renderSteps(phases, { status: "starting" });
    $("#live-run").classList.remove("hidden");
    $("#live-run-title").textContent = value.name;
    $("#run-status").textContent = compiled.maximumTurns > 1 ? "Workflow ready" : "Codex ready";
    $("#run-output").classList.add("hidden");
    $("#approval-card").classList.add("hidden");
    $("#live-run").scrollIntoView({ behavior: "smooth", block: "start" });
    const result = await request("/api/runs", { method: "POST", body: JSON.stringify(value) });
    activeRun = result.runId;
    const cancelButton = $("#cancel-active-run");
    cancelButton.disabled = false;
    cancelButton.textContent = "Stop run";
    cancelButton.classList.remove("hidden");
    button.textContent = "Run in progress";
    pollRun(phases);
  } catch (error) {
    button.disabled = false;
    button.innerHTML = runMode === "weave" ? "Run my workflow <span>→</span>" : "Run with Codex <span>→</span>";
    $("#live-run").classList.remove("hidden");
    $("#live-run-title").textContent = "Run could not start";
    $("#run-status").textContent = "Needs attention";
    $("#run-output").textContent = String(error.message || error);
    $("#run-output").classList.remove("hidden");
  }
}

async function pollRun(phases) {
  clearTimeout(pollTimer);
  try {
    const state = await request(`/api/runs/${encodeURIComponent(activeRun)}`);
    renderSteps(phases, state);
    $("#run-status").textContent = friendlyStatus(state.status || "running");
    if (state.pendingApproval) {
      const checkpoint = state.pendingApproval.method === "harness/checkpoint";
      pendingIsCheckpoint = checkpoint;
      $("#approval-title").textContent = checkpoint ? "Calibrate the next step" : "Codex requested a protected action";
      $("#approval-detail").textContent = checkpoint ? (state.pendingApproval.params?.question || "Continue this run?") : "Review this protected action before allowing it.";
      $("#checkpoint-feedback-wrap").classList.toggle("hidden", !checkpoint);
      $("#continue-run").textContent = checkpoint ? "Apply direction" : "Allow";
      $("#approval-card").classList.remove("hidden");
    } else {
      pendingIsCheckpoint = false;
      $("#approval-card").classList.add("hidden");
    }
    if (["completed", "failed", "stopped"].includes(state.status)) {
      const result = state.result || {};
      const completion = result.completionStatus || state.status;
      $("#run-status").textContent = friendlyStatus(completion);
      $("#run-output").textContent = result.finalResponse || state.error || "Run ended without a final response.";
      $("#run-output").classList.remove("hidden");
      $("#run-note").textContent = completion === "completed"
        ? "Finished. A readable record is available in Runs."
        : completion === "failedCheck"
          ? "Stopped because a pass/fail check failed. Open Runs for the evidence."
          : `${friendlyStatus(completion)}. Open Runs for the evidence.`;
      $("#run-task").disabled = false;
      $("#run-task").innerHTML = "Run another task <span>→</span>";
      $("#cancel-active-run").classList.add("hidden");
      return;
    }
    pollTimer = setTimeout(() => pollRun(phases), 700);
  } catch (error) {
    $("#run-output").textContent = String(error.message || error);
    $("#run-output").classList.remove("hidden");
    $("#run-task").disabled = false;
    $("#cancel-active-run").classList.add("hidden");
  }
}

async function stopActiveRun() {
  if (!activeRun) return;
  const button = $("#cancel-active-run");
  button.disabled = true;
  button.textContent = "Stopping…";
  try {
    await request(`/api/runs/${encodeURIComponent(activeRun)}/stop`, { method: "POST", body: "{}" });
    $("#run-status").textContent = "Stopping";
  } catch (error) {
    button.disabled = false;
    button.textContent = "Stop run";
    $("#run-note").textContent = String(error.message || error);
  }
}

async function decide(decision) {
  if (!activeRun) return;
  const feedback = pendingIsCheckpoint && decision === "accept" ? $("#checkpoint-feedback").value.trim() : "";
  await request(`/api/runs/${encodeURIComponent(activeRun)}/approval`, { method: "POST", body: JSON.stringify({ decision, feedback }) });
  $("#checkpoint-feedback").value = "";
  pendingIsCheckpoint = false;
  $("#approval-card").classList.add("hidden");
}

function renderAccount(account) {
  const message = account?.message || (account?.canRun ? "Codex is ready." : "Codex needs sign-in.");
  $("#account-state").textContent = message;
  $("#setup-account-message").textContent = message;
  $(".live-dot").classList.toggle("connected", account?.canRun === true);
  $("#setup-account-privacy").textContent = "No secrets, tokens, or email are returned to this page.";
  $("#chatgpt-login").classList.toggle("hidden", account?.canRun && account?.accountType === "chatgpt");
}

async function checkAccount() {
  try {
    securitySession ||= await request("/api/session");
    renderAccount(await request("/api/account"));
  } catch (error) {
    renderAccount({ canRun: false, message: `Local Codex unavailable: ${error.message}` });
  }
}

async function pollLogin(loginId) {
  clearTimeout(loginPollTimer);
  const result = await request(`/api/account/login/${encodeURIComponent(loginId)}`);
  if (result.state === "succeeded") return checkAccount();
  if (result.state === "failed") return renderAccount({ canRun: false, message: result.message });
  $("#setup-account-message").textContent = result.message || "Waiting for ChatGPT sign-in…";
  loginPollTimer = setTimeout(() => pollLogin(loginId), 900);
}

async function startLogin() {
  const button = $("#chatgpt-login");
  button.disabled = true;
  try {
    securitySession ||= await request("/api/session");
    const result = await request("/api/account/login/chatgpt", { method: "POST", body: "{}" });
    if (result.authUrl) window.open(result.authUrl, "_blank", "noopener,noreferrer");
    $("#setup-account-message").textContent = result.message || "Finish signing in through Codex.";
    if (result.loginId) void pollLogin(result.loginId);
  } catch (error) {
    renderAccount({ canRun: false, message: error.message });
  } finally { button.disabled = false; }
}

function ensureDesignProgram() {
  if (!designProgram) designProgram = graphTemplate("review");
  designProgram.edges ||= designProgram.phases.slice(1).map((phase, index) => ({ from: designProgram.phases[index].id, to: phase.id }));
  designProgram.phases.forEach((phase, index) => { phase.position ||= { x: 90 + (index * 300), y: 250 }; });
  return designProgram;
}

function phaseCopyKey(phase) {
  if (phase.kind === "work") return "goal";
  if (phase.kind === "checkpoint") return "question";
  if (phase.kind === "command") return "command";
  return "criteria";
}

function phaseCopyLabel(phase) {
  if (phase.kind === "work") return "What Codex must accomplish";
  if (phase.kind === "checkpoint") return "Question shown to you";
  if (phase.kind === "command") return "Exact command to observe";
  return "What counts as proven";
}

function phaseInspector(phase) {
  const key = phaseCopyKey(phase);
  const scopeSelect = phase.kind === "work" ? `<label>How much can this step own?<select data-phase-field="scope"><option value="adaptive" ${phase.scope !== "focused" ? "selected" : ""}>Broad · Codex chooses how</option><option value="focused" ${phase.scope === "focused" ? "selected" : ""}>Focused · only this job</option></select></label>` : "";
  const typeSelect = phase.kind === "command" ? `<label>Pass/fail check type<select data-phase-field="stepType"><option value="function" ${phase.stepType === "function" ? "selected" : ""}>Function call</option><option value="test" ${phase.stepType === "test" ? "selected" : ""}>Test</option><option value="checker" ${phase.stepType === "checker" ? "selected" : ""}>Checker</option></select></label>` : "";
  const commandSettings = phase.kind === "command" ? `<div class="inspector-grid"><label>Passing exit code<input data-phase-field="expectedExitCode" type="number" min="0" max="255" value="${phase.expectedExitCode ?? 0}"></label><label class="switch-field"><input data-phase-field="stopOnFailure" type="checkbox" ${phase.stopOnFailure !== false ? "checked" : ""}><span>Stop if this fails</span></label></div><p class="inspector-proof">Passed only when Codex events contain this exact command and exit code.</p>` : "";
  const verifySettings = phase.kind === "verify" ? `<label>Repair attempts<select data-phase-field="maxRepairs"><option value="0" ${phase.maxRepairs === 0 ? "selected" : ""}>None</option><option value="1" ${phase.maxRepairs === 1 ? "selected" : ""}>One</option><option value="2" ${phase.maxRepairs === 2 ? "selected" : ""}>Two</option></select></label>` : "";
  const program = ensureDesignProgram();
  const incoming = program.edges.filter((edge) => edge.to === phase.id).length;
  const outgoing = program.edges.filter((edge) => edge.from === phase.id).length;
  const targets = program.phases.filter((target) => target.id !== phase.id && !program.edges.some((edge) => edge.from === phase.id && edge.to === target.id) && !wouldCreateCycle(program, phase.id, target.id));
  const connectControl = targets.length
    ? `<div class="inspector-connect"><label>Then continue to<select data-phase-connect>${targets.map((target) => `<option value="${escapeHtml(target.id)}">${escapeHtml(target.name)}</option>`).join("")}</select></label><button type="button" data-phase-connect-add>Add arrow</button></div>`
    : '<p class="inspector-proof">No other step can be connected from here without making a duplicate or loop.</p>';
  return `<p class="kicker">${escapeHtml(phaseKindLabel(phase).toUpperCase())}</p><h2>${escapeHtml(phase.name)}</h2><div class="inspector-fields"><label>Step name<input data-phase-field="name" value="${escapeHtml(phase.name)}" maxlength="80"></label>${scopeSelect}${typeSelect}<label>${escapeHtml(phaseCopyLabel(phase))}<textarea data-phase-field="${key}" maxlength="${phase.kind === "work" ? 4000 : 2000}" rows="7">${escapeHtml(phase[key])}</textarea></label>${commandSettings}${verifySettings}<p class="connection-summary">${incoming} arrow${incoming === 1 ? "" : "s"} in · ${outgoing} arrow${outgoing === 1 ? "" : "s"} out</p>${connectControl}</div><div class="inspector-actions"><button class="icon-only" type="button" data-phase-duplicate title="Duplicate step" aria-label="Duplicate step">${duplicateIcon}</button><button class="danger icon-only" type="button" data-phase-delete title="Delete step" aria-label="Delete step">${trashIcon}</button></div>`;
}

function edgeInspector(edge) {
  const program = ensureDesignProgram();
  const source = program.phases.find((phase) => phase.id === edge.from);
  const target = program.phases.find((phase) => phase.id === edge.to);
  return `<p class="kicker">SELECTED ARROW</p><h2>${escapeHtml(source?.name || edge.from)} → ${escapeHtml(target?.name || edge.to)}</h2><p class="edge-help">The target waits for the source to finish. Weave derives Codex turn order from this dependency.</p><div class="inspector-actions"><button class="danger icon-only" type="button" data-edge-delete title="Delete arrow" aria-label="Delete arrow">${trashIcon}</button></div>`;
}

function canvasPath(source, target) {
  const startX = source.position.x + 252;
  const startY = source.position.y + 86;
  const endX = target.position.x;
  const endY = target.position.y + 86;
  const bend = Math.max(80, Math.abs(endX - startX) * .45);
  return `M ${startX} ${startY} C ${startX + bend} ${startY}, ${endX - bend} ${endY}, ${endX} ${endY}`;
}

function renderCanvasEdges() {
  const program = ensureDesignProgram();
  const byId = new Map(program.phases.map((phase) => [phase.id, phase]));
  const paths = program.edges.map((edge, index) => {
    const source = byId.get(edge.from);
    const target = byId.get(edge.to);
    if (!source || !target) return "";
    const path = canvasPath(source, target);
    return `<path class="edge-hit" data-edge-index="${index}" d="${path}"></path><path class="edge-line ${index === selectedEdgeIndex ? "selected" : ""}" d="${path}" marker-end="url(#arrowhead)"></path>`;
  }).join("");
  const draft = connectionDraft?.path ? `<path class="edge-line draft" d="${connectionDraft.path}" marker-end="url(#arrowhead)"></path>` : "";
  $("#canvas-edges").innerHTML = `<defs><marker id="arrowhead" markerWidth="10" markerHeight="8" refX="9" refY="4" orient="auto"><path d="M0,0 L10,4 L0,8 Z"></path></marker></defs>${paths}${draft}`;
  $$("[data-edge-index]", $("#canvas-edges")).forEach((path) => path.addEventListener("click", (event) => {
    event.stopPropagation();
    selectedEdgeIndex = Number(path.dataset.edgeIndex);
    selectedPhaseIndex = -1;
    renderPhaseEditor();
  }));
}

function pointerToCanvas(event) {
  const viewport = $("#canvas-viewport");
  const rect = viewport.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left - canvasPan.x) / canvasZoom,
    y: (event.clientY - rect.top - canvasPan.y) / canvasZoom,
  };
}

function applyCanvasTransform() {
  $("#phase-editor").style.transform = `translate(${canvasPan.x}px, ${canvasPan.y}px) scale(${canvasZoom})`;
  $("#canvas-viewport").style.backgroundPosition = `${canvasPan.x}px ${canvasPan.y}px`;
}

function zoomCanvasAt(value, clientX, clientY) {
  const nextZoom = Math.max(.42, Math.min(1.35, Number(value.toFixed(3))));
  const viewport = $("#canvas-viewport");
  const rect = viewport.getBoundingClientRect();
  const point = { x: clientX - rect.left, y: clientY - rect.top };
  const ratio = nextZoom / canvasZoom;
  canvasPan = {
    x: point.x - ((point.x - canvasPan.x) * ratio),
    y: point.y - ((point.y - canvasPan.y) * ratio),
  };
  canvasZoom = nextZoom;
  applyCanvasTransform();
}

function handleCanvasWheel(event) {
  event.preventDefault();
  const normalized = event.deltaMode === 1 ? event.deltaY * 18 : event.deltaMode === 2 ? event.deltaY * 180 : event.deltaY;
  zoomCanvasAt(canvasZoom * Math.exp(-normalized * .0015), event.clientX, event.clientY);
}

function beginCanvasPan(event) {
  if (event.button !== 0 || event.target.closest(".canvas-node, .edge-hit, .node-port")) return;
  canvasPanDrag = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    origin: { ...canvasPan },
  };
  canvasPanMoved = false;
  event.currentTarget.setPointerCapture(event.pointerId);
  event.currentTarget.classList.add("panning");
  event.preventDefault();
}

function moveCanvasPan(event) {
  if (!canvasPanDrag || event.pointerId !== canvasPanDrag.pointerId) return;
  const deltaX = event.clientX - canvasPanDrag.startX;
  const deltaY = event.clientY - canvasPanDrag.startY;
  if (Math.abs(deltaX) + Math.abs(deltaY) > 4) canvasPanMoved = true;
  canvasPan = {
    x: canvasPanDrag.origin.x + deltaX,
    y: canvasPanDrag.origin.y + deltaY,
  };
  applyCanvasTransform();
}

function endCanvasPan(event) {
  if (!canvasPanDrag || event.pointerId !== canvasPanDrag.pointerId) return;
  if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  event.currentTarget.classList.remove("panning");
  canvasPanDrag = null;
}

function beginConnection(event, sourceId) {
  event.preventDefault();
  event.stopPropagation();
  const program = ensureDesignProgram();
  const source = program.phases.find((phase) => phase.id === sourceId);
  connectionDraft = { sourceId, path: "" };
  const move = (moveEvent) => {
    const point = pointerToCanvas(moveEvent);
    const startX = source.position.x + 252;
    const startY = source.position.y + 86;
    const bend = Math.max(70, Math.abs(point.x - startX) * .4);
    connectionDraft.path = `M ${startX} ${startY} C ${startX + bend} ${startY}, ${point.x - bend} ${point.y}, ${point.x} ${point.y}`;
    renderCanvasEdges();
  };
  const end = (upEvent) => {
    document.removeEventListener("pointermove", move);
    const targetPort = document.elementFromPoint(upEvent.clientX, upEvent.clientY)?.closest('[data-port="in"]');
    const targetId = targetPort?.closest("[data-phase-id]")?.dataset.phaseId;
    if (targetId && wouldCreateCycle(program, sourceId, targetId)) {
      canvasNotice = "That arrow would create a loop. Connect the steps in a forward path instead.";
    } else if (targetId && !program.edges.some((edge) => edge.from === sourceId && edge.to === targetId)) {
      program.edges.push({ from: sourceId, to: targetId });
      canvasNotice = "";
      adaptationMethod ||= "manual";
    }
    connectionDraft = null;
    renderPhaseEditor();
  };
  document.addEventListener("pointermove", move);
  document.addEventListener("pointerup", end, { once: true });
}

function beginNodeDrag(event, phaseIndex) {
  if (event.target.closest(".node-port") || arrowTool) return;
  const phase = ensureDesignProgram().phases[phaseIndex];
  canvasDrag = { phaseIndex, moved: false, origin: { ...phase.position }, start: pointerToCanvas(event) };
  event.currentTarget.setPointerCapture(event.pointerId);
  event.currentTarget.classList.add("dragging");
}

function moveNode(event) {
  if (!canvasDrag) return;
  const phase = ensureDesignProgram().phases[canvasDrag.phaseIndex];
  const point = pointerToCanvas(event);
  if (Math.abs(point.x - canvasDrag.start.x) + Math.abs(point.y - canvasDrag.start.y) < 4) return;
  phase.position.x = Math.max(20, Math.min(2400, Math.round((canvasDrag.origin.x + point.x - canvasDrag.start.x) / 20) * 20));
  phase.position.y = Math.max(20, Math.min(1010, Math.round((canvasDrag.origin.y + point.y - canvasDrag.start.y) / 20) * 20));
  if (phase.position.x !== canvasDrag.origin.x || phase.position.y !== canvasDrag.origin.y) canvasDrag.moved = true;
  const node = $(`[data-phase-id="${CSS.escape(phase.id)}"]`, $("#canvas-nodes"));
  node.style.left = `${phase.position.x}px`;
  node.style.top = `${phase.position.y}px`;
  renderCanvasEdges();
}

function endNodeDrag(event) {
  if (!canvasDrag) return;
  const { phaseIndex, moved } = canvasDrag;
  event.currentTarget.classList.remove("dragging");
  canvasDrag = null;
  if (!moved) return;
  selectedPhaseIndex = phaseIndex;
  selectedEdgeIndex = null;
  if (moved) adaptationMethod ||= "manual";
  renderPhaseEditor();
}

function setArrowTool(active) {
  arrowTool = active ? { sourceId: null } : null;
  const button = $("#canvas-add-arrow");
  button.setAttribute("aria-pressed", String(Boolean(active)));
  $("#canvas-viewport").classList.toggle("connecting", Boolean(active));
  $("#canvas-tool-hint").textContent = active
    ? "Choose the starting node"
    : "Drag to move · wheel to zoom · drag the background to pan";
}

function selectCanvasNode(index) {
  const program = ensureDesignProgram();
  const phase = program.phases[index];
  if (!phase) return;
  selectedPhaseIndex = index;
  selectedEdgeIndex = null;
  if (!arrowTool) {
    renderPhaseEditor();
    return;
  }
  if (!arrowTool.sourceId) {
    arrowTool.sourceId = phase.id;
    $("#canvas-tool-hint").textContent = "Now choose the destination node";
    renderPhaseEditor();
    return;
  }
  const sourceId = arrowTool.sourceId;
  if (sourceId === phase.id) canvasNotice = "Choose a different destination node.";
  else if (program.edges.some((edge) => edge.from === sourceId && edge.to === phase.id)) canvasNotice = "Those nodes are already connected.";
  else if (wouldCreateCycle(program, sourceId, phase.id)) canvasNotice = "That arrow would create a loop.";
  else {
    program.edges.push({ from: sourceId, to: phase.id });
    canvasNotice = "";
    adaptationMethod ||= "manual";
  }
  setArrowTool(false);
  renderPhaseEditor();
}

function renderPhaseEditor() {
  const program = ensureDesignProgram();
  if (selectedPhaseIndex >= program.phases.length) selectedPhaseIndex = program.phases.length - 1;
  const order = new Map(orderedClientPhases(program).map((phase, index) => [phase.id, index + 1]));
  $("#canvas-nodes").innerHTML = program.phases.map((phase, index) => {
    const plain = phasePlainCopy(phase);
    const icon = phase.kind === "checkpoint" ? "◇" : phase.kind === "command" ? "✓" : phase.kind === "verify" ? "◎" : "⌁";
    const footer = phase.kind === "checkpoint" ? "Course check" : phase.kind === "command" ? "Pass / fail" : phase.kind === "verify" ? "Review + repair" : phase.scope === "focused" ? "Focused turn" : "Broad turn";
    return `<article class="canvas-node ${escapeHtml(phase.kind)} ${escapeHtml(phase.scope || "")} ${index === selectedPhaseIndex ? "selected" : ""}" data-kind="${escapeHtml(phase.kind)}" data-phase-index="${index}" data-phase-id="${escapeHtml(phase.id)}" tabindex="0"><span class="node-kind-icon" aria-hidden="true">${icon}</span><span class="node-order" aria-label="Step ${order.get(phase.id) || index + 1}">${order.get(phase.id) || index + 1}</span><button class="node-port input" data-port="in" type="button" tabindex="-1" aria-hidden="true"></button><small>${escapeHtml(plain.actor)}</small><b>${escapeHtml(phase.name)}</b><p>${escapeHtml(plain.copy)}</p><em>${escapeHtml(footer)}</em><button class="node-port output" data-port="out" type="button" tabindex="-1" aria-hidden="true"></button></article>`;
  }).join("");
  if (selectedEdgeIndex != null && program.edges[selectedEdgeIndex]) $("#phase-inspector").innerHTML = edgeInspector(program.edges[selectedEdgeIndex]);
  else if (selectedPhaseIndex >= 0) $("#phase-inspector").innerHTML = phaseInspector(program.phases[selectedPhaseIndex]);
  else $("#phase-inspector").innerHTML = '<p class="kicker">STEP SETTINGS</p><h2>Select a step</h2><p>Drag it anywhere, edit its instruction, or pull an arrow from its right dot.</p>';
  $$("[data-phase-index]", $("#canvas-nodes")).forEach((node) => {
    const phase = program.phases[Number(node.dataset.phaseIndex)];
    node.style.left = `${phase.position.x}px`;
    node.style.top = `${phase.position.y}px`;
    node.addEventListener("click", (event) => {
      event.stopPropagation();
      selectCanvasNode(Number(node.dataset.phaseIndex));
    });
    node.addEventListener("keydown", (event) => {
      if (!["Enter", " "].includes(event.key)) return;
      event.preventDefault();
      selectCanvasNode(Number(node.dataset.phaseIndex));
    });
    node.addEventListener("pointerdown", (event) => beginNodeDrag(event, Number(node.dataset.phaseIndex)));
    node.addEventListener("pointermove", moveNode);
    node.addEventListener("pointerup", endNodeDrag);
    $("[data-port=out]", node).addEventListener("pointerdown", (event) => beginConnection(event, node.dataset.phaseId));
  });
  renderCanvasEdges();
  $$("[data-phase-field]", $("#phase-inspector")).forEach((field) => field.addEventListener("input", () => {
    const phase = program.phases[selectedPhaseIndex];
    const key = field.dataset.phaseField;
    if (["maxRepairs", "expectedExitCode"].includes(key)) phase[key] = Number(field.value);
    else if (key === "stopOnFailure") phase[key] = field.checked;
    else phase[key] = field.value;
    adaptationMethod ||= "manual";
    if (["stepType", "scope"].includes(key)) renderPhaseEditor();
    else {
      const node = $(`[data-phase-index="${selectedPhaseIndex}"]`, $("#canvas-nodes"));
      if (key === "name") { node.querySelector("b").textContent = field.value; $("#phase-inspector h2").textContent = field.value; }
      if (key === phaseCopyKey(phase)) node.querySelector("p").textContent = field.value;
    }
  }));
  $$("[data-phase-connect-add]", $("#phase-inspector")).forEach((button) => button.addEventListener("click", () => {
    const source = program.phases[selectedPhaseIndex];
    const targetId = $("[data-phase-connect]", $("#phase-inspector")).value;
    if (!targetId || wouldCreateCycle(program, source.id, targetId)) return;
    program.edges.push({ from: source.id, to: targetId });
    canvasNotice = "";
    adaptationMethod ||= "manual";
    renderPhaseEditor();
  }));
  $$("[data-phase-duplicate]", $("#phase-inspector")).forEach((button) => button.addEventListener("click", () => {
    const source = program.phases[selectedPhaseIndex];
    const duplicate = clone(source);
    duplicate.id = uniquePhaseId(`${source.id}-copy`, program);
    duplicate.name = `${source.name} copy`.slice(0, 80);
    duplicate.position = { x: Math.min(2100, source.position.x + 300), y: Math.min(930, source.position.y + 70) };
    program.phases.push(duplicate);
    program.edges.push({ from: source.id, to: duplicate.id });
    selectedPhaseIndex = program.phases.length - 1;
    selectedEdgeIndex = null;
    adaptationMethod ||= "manual";
    renderPhaseEditor();
  }));
  $$("[data-phase-delete]", $("#phase-inspector")).forEach((button) => button.addEventListener("click", () => {
    const index = selectedPhaseIndex;
    if (program.phases.length === 1 || (program.phases[index].kind === "work" && program.phases.filter((item) => item.kind === "work").length === 1)) {
      $("#design-status").textContent = "A workflow needs at least one Codex turn.";
      return;
    }
    const removed = program.phases[index];
    const incoming = program.edges.filter((edge) => edge.to === removed.id).map((edge) => edge.from);
    const outgoing = program.edges.filter((edge) => edge.from === removed.id).map((edge) => edge.to);
    program.edges = program.edges.filter((edge) => edge.from !== removed.id && edge.to !== removed.id);
    for (const source of incoming) for (const target of outgoing) if (source !== target && !program.edges.some((edge) => edge.from === source && edge.to === target)) program.edges.push({ from: source, to: target });
    program.phases.splice(index, 1);
    selectedPhaseIndex = Math.min(index, program.phases.length - 1);
    selectedEdgeIndex = null;
    adaptationMethod ||= "manual";
    renderPhaseEditor();
  }));
  $$("[data-edge-delete]", $("#phase-inspector")).forEach((button) => button.addEventListener("click", () => {
    program.edges.splice(selectedEdgeIndex, 1);
    selectedEdgeIndex = null;
    renderPhaseEditor();
  }));
  const problem = graphProblem(program);
  $("#design-status").textContent = problem || canvasNotice || "Ready to run. Arrows determine the step order.";
  $("#design-status").classList.toggle("error", Boolean(problem || canvasNotice));
  const summary = $("#canvas-summary");
  if (summary) summary.textContent = `${program.phases.length} node${program.phases.length === 1 ? "" : "s"} · ${program.edges.length} arrow${program.edges.length === 1 ? "" : "s"}${problem ? " · needs attention" : " · executable"}`;
  const origin = activeSavedWorkflow ? adaptationMethod ? `Unsaved changes to “${activeSavedWorkflow.name}”` : `Using saved workflow “${activeSavedWorkflow.name}”` : "Canvas draft · not saved";
  $("#design-origin").textContent = origin;
}

function addPhase(kind, stepOption = "adaptive") {
  const program = ensureDesignProgram();
  if (program.phases.length >= 16) { $("#design-status").textContent = "A workflow can contain at most sixteen nodes."; return; }
  const commandType = kind === "command" ? stepOption : "test";
  const stem = kind === "work" ? "work" : kind === "checkpoint" ? "checkpoint" : kind === "command" ? commandType : "verify";
  const id = uniquePhaseId(stem, program);
  const selected = program.phases[selectedPhaseIndex] || program.phases[program.phases.length - 1];
  const position = selected ? { x: Math.min(2100, selected.position.x + 310), y: selected.position.y } : { x: 120, y: 260 };
  if (kind === "work") program.phases.push({ id, kind, scope: stepOption === "focused" ? "focused" : "adaptive", name: "New Codex turn", goal: "Describe what Codex should accomplish in this turn. Make it as broad or as precise as this workflow needs.", reasoningEffort: "inherit", position });
  if (kind === "checkpoint") program.phases.push({ id, kind, name: "Calibrate the run", question: "What must remain fixed, and what should Codex redirect before continuing?", position });
  if (kind === "command") program.phases.push({ id, kind, stepType: commandType, name: "Run one exact command", command: "python3 -m pytest -q path/to/test.py::test_name", expectedExitCode: 0, stopOnFailure: true, position });
  if (kind === "verify") program.phases.push({ id, kind, name: "Review and repair", criteria: "Describe what must be true before this workflow can finish.", maxRepairs: 1, position });
  if (selected) program.edges.push({ from: selected.id, to: id });
  selectedPhaseIndex = program.phases.length - 1;
  selectedEdgeIndex = null;
  adaptationMethod ||= "manual";
  $("#canvas-node-menu").hidden = true;
  $("#canvas-add-node").setAttribute("aria-expanded", "false");
  renderPhaseEditor();
}

function renderAttachedFiles() {
  const target = $("#attached-files");
  target.innerHTML = uploadedFiles.map((file, index) => `<span class="file-chip" title="${escapeHtml(file.path)}"><span>${escapeHtml(file.name)}</span><button type="button" data-remove-file="${index}" aria-label="Remove ${escapeHtml(file.name)}">×</button></span>`).join("");
  $$('[data-remove-file]', target).forEach((button) => button.addEventListener("click", () => {
    uploadedFiles.splice(Number(button.dataset.removeFile), 1);
    renderAttachedFiles();
  }));
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result).split(",", 2)[1] || ""));
    reader.addEventListener("error", () => reject(reader.error || new Error("Could not read file")));
    reader.readAsDataURL(file);
  });
}

async function uploadSelectedFiles(files) {
  const chosen = [...files];
  if (!chosen.length) return;
  if (uploadedFiles.length + chosen.length > 8) {
    $("#voice-status").textContent = "Choose at most eight files.";
    return;
  }
  if (chosen.some((file) => file.size > 4 * 1024 * 1024)) {
    $("#voice-status").textContent = "Each file must be 4 MB or smaller.";
    return;
  }
  $("#attach-files").disabled = true;
  $("#voice-status").textContent = "Adding files locally…";
  try {
    const encoded = await Promise.all(chosen.map(async (file) => ({ name: file.name, contentBase64: await fileToBase64(file) })));
    const result = await request("/api/workspace/uploads", { method: "POST", body: JSON.stringify({ files: encoded }) });
    uploadedFiles.push(...(result.files || []));
    renderAttachedFiles();
    $("#voice-status").textContent = `${uploadedFiles.length} local file${uploadedFiles.length === 1 ? "" : "s"} ready for Codex.`;
  } catch (error) {
    $("#voice-status").textContent = `Could not add files: ${error.message}`;
  } finally {
    $("#attach-files").disabled = false;
    $("#file-input").value = "";
  }
}

async function adaptWithCodex() {
  const task = $("#task-input").value.trim();
  const cwd = $("#workspace-input").value.trim();
  if (task.length < 8) { $("#task-input").focus(); return; }
  if (!cwd.startsWith("/")) { $("#workspace-input").focus(); return; }
  const button = $("#adapt-with-codex");
  button.disabled = true;
  $("#design-status").textContent = "Codex is proposing goal-only wording in read-only mode…";
  try {
    const result = await request("/api/workflows/adapt", { method: "POST", body: JSON.stringify({ phaseProgram: ensureDesignProgram(), task, cwd, reasoningEffort: "low" }) });
    designProgram = clone(result.phaseProgram);
    adaptationMethod = "codex";
    $("#design-status").textContent = `Suggestion ready. Review ${result.changedPhaseIds.length} changed step(s); nothing has been saved or run.`;
    renderPhaseEditor();
  } catch (error) {
    $("#design-status").textContent = `Could not adapt goals: ${error.message}`;
  } finally { button.disabled = false; }
}

async function saveDesign() {
  const button = $("#save-design");
  const name = $("#design-save-name").value.trim();
  if (name.length < 2) { $("#design-save-name").focus(); return; }
  button.disabled = true;
  try {
    const payload = {
      name,
      description: activeSavedWorkflow ? "A reviewed adaptation of a saved workflow for a similar task family." : "A human-authored reusable Codex workflow.",
      phaseProgram: ensureDesignProgram(),
      parentWorkflowId: activeSavedWorkflow && adaptationMethod ? activeSavedWorkflow.workflowId : null,
      adaptationMethod: activeSavedWorkflow && adaptationMethod ? adaptationMethod : null,
      adaptationSummary: activeSavedWorkflow && adaptationMethod ? "Human-reviewed wording changed; structure remains visible." : "",
    };
    const saved = await request("/api/workflows", { method: "POST", body: JSON.stringify(payload) });
    activeSavedWorkflow = saved;
    designProgram = clone(saved.phaseProgram);
    adaptationMethod = null;
    $("#design-status").textContent = `Saved “${saved.name}”. The task and folder were excluded.`;
    await loadWorkflows();
    renderPhaseEditor();
  } catch (error) {
    $("#design-status").textContent = `Could not save: ${error.message}`;
  } finally { button.disabled = false; }
}

async function useDesignInRun() {
  setMode("weave");
  await startRun();
}

async function loadRuns() {
  const list = $("#runs-list");
  try {
    const result = await request("/api/runs");
    const runs = result.runs || [];
    list.innerHTML = runs.length ? runs.map((run) => {
      const started = run.startedAt ? new Date(run.startedAt * 1000).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "Recent";
      const kind = run.phaseCount ? "My workflow" : "Codex directly";
      const fallbackName = run.phaseCount ? `${run.phaseCount}-step workflow` : "One adaptive run";
      return `<div class="run-list-row"><button class="run-list-item ${run.runId === selectedRunId ? "active" : ""}" type="button" data-run-id="${escapeHtml(run.runId)}"><span class="run-kind">${kind}</span><b>${escapeHtml(run.name || fallbackName)}</b><small>${escapeHtml(friendlyStatus(run.completionStatus || run.status))} · ${escapeHtml(started)}</small></button><button class="trash-button" type="button" data-delete-run="${escapeHtml(run.runId)}" title="Delete run" aria-label="Delete ${escapeHtml(run.name || fallbackName)}">${trashIcon}</button></div>`;
    }).join("") : "<p>No runs yet. Create one and it will appear here.</p>";
    $$("[data-run-id]", list).forEach((button) => button.addEventListener("click", () => void showRun(button.dataset.runId)));
    $$("[data-delete-run]", list).forEach((button) => button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        await request(`/api/runs/${button.dataset.deleteRun}`, { method: "DELETE" });
        if (selectedRunId === button.dataset.deleteRun) {
          selectedRunId = null;
          $("#run-detail").innerHTML = '<div class="empty-run"><b>Choose a run</b><p>Its workflow and evidence will appear here.</p></div>';
        }
        await loadRuns();
      } catch (error) {
        button.disabled = false;
        $("#run-detail").innerHTML = `<div class="empty-run"><b>Could not delete run</b><p>${escapeHtml(error.message)}</p></div>`;
      }
    }));
    if (!selectedRunId && runs[0]) {
      selectedRunId = runs[0].runId;
      void showRun(runs[0].runId);
    }
  } catch (error) { list.innerHTML = `<p>Runs unavailable: ${escapeHtml(error.message)}</p>`; }
}

function runExecutionStatus(execution = {}) {
  if (execution.status === "fail" || execution.status === "failed") return { className: "failed", label: "Failed" };
  if (execution.status === "stopped") return { className: "stopped", label: "Stopped" };
  if (execution.kind === "checkpoint") {
    const continued = ["accept", "acceptForSession"].includes(execution.decision);
    return { className: continued ? "passed" : "stopped", label: continued ? "Continued" : "Stopped" };
  }
  if (execution.status === "repair") return { className: "passed", label: "Repaired" };
  if (execution.status === "pass") return { className: "passed", label: "Passed" };
  return { className: "done", label: "Done" };
}

function runCanvasMarkup(graph, executions) {
  const layout = layoutRunGraph(graph, executions);
  const edgeMarkup = layout.edges.map((edge) => {
    const bend = Math.max(44, Math.abs(edge.endX - edge.startX) * .45);
    return `<path class="run-graph-edge" d="M${edge.startX} ${edge.startY} C${edge.startX + bend} ${edge.startY},${edge.endX - bend} ${edge.endY},${edge.endX} ${edge.endY}" marker-end="url(#run-arrow)"></path>`;
  }).join("");
  const nodeMarkup = layout.nodes.map((node, index) => {
    const status = runExecutionStatus(node.execution || {});
    const title = String(node.name || node.execution?.name || `Step ${index + 1}`);
    const shortTitle = title.length > 25 ? `${title.slice(0, 24)}…` : title;
    const detailId = `run-node-${String(node.id).replace(/[^a-zA-Z0-9_-]/g, "-")}`;
    return `<g class="run-graph-node ${escapeHtml(node.kind || "work")} ${status.className}" transform="translate(${node.x} ${node.y})" role="button" tabindex="0" data-run-node="${escapeHtml(detailId)}" aria-label="Inspect ${escapeHtml(title)}"><rect width="${node.width}" height="${node.height}" rx="13"></rect><circle cx="18" cy="18" r="5"></circle><text class="run-node-kind" x="31" y="22">${escapeHtml(phaseKindLabel(node).replace("Codex goal", "Codex"))}</text><text class="run-node-title" x="16" y="51">${escapeHtml(shortTitle)}</text><text class="run-node-status" x="16" y="75">${escapeHtml(status.label)}</text></g>`;
  }).join("");
  return `<section class="run-replay" aria-labelledby="run-replay-title"><header><div><small>RESULT CANVAS</small><h3 id="run-replay-title">Replay the workflow</h3></div><p>Select a node to inspect it.</p></header><div class="run-graph-frame"><svg class="run-graph" viewBox="0 0 ${layout.width} ${layout.height}" role="img" aria-label="Run result workflow"><defs><marker id="run-arrow" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto"><path d="M0 0 9 4.5 0 9Z"></path></marker></defs>${edgeMarkup}${nodeMarkup}</svg></div></section>`;
}

function contextMarkup(context = {}) {
  const paths = Array.isArray(context.contextPaths) ? context.contextPaths : [];
  const rows = [
    ["Task", context.overallTask],
    ["Folder", context.workspace],
    ["Files", paths.join("\n")],
    ["Your latest direction", context.humanFeedback],
    ["Previous visible result", context.priorOutput],
  ].filter(([, value]) => String(value || "").trim());
  return rows.length
    ? `<dl>${rows.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd><pre>${escapeHtml(value)}</pre></dd></div>`).join("")}</dl>`
    : "<p>No additional context was stored for this older run.</p>";
}

function runNodeDetail(execution, phase, index, timeline, result, state) {
  const status = runExecutionStatus(execution);
  const activity = timeline.filter((item) => item.phase === execution.phaseId);
  const counts = activity.reduce((acc, item) => { acc[item.kind] = (acc[item.kind] || 0) + 1; return acc; }, {});
  const fileCount = (counts.fileChange || 0) + (counts.file_change || 0);
  const actionCount = (counts.command || 0) + (counts.tool || 0) + (counts.toolCall || 0) + (counts.mcp || 0);
  const checkCount = (counts.verification || 0) + (counts.test || 0);
  const summary = [fileCount && `${fileCount} file change${fileCount === 1 ? "" : "s"}`, actionCount && `${actionCount} tool action${actionCount === 1 ? "" : "s"}`, checkCount && `${checkCount} check${checkCount === 1 ? "" : "s"}`].filter(Boolean);
  if (execution.kind === "command") summary.unshift(`Exit ${execution.observedExitCode ?? "not observed"}`);
  const chips = summary.map((item) => `<span>${escapeHtml(item)}</span>`).join("") || "<span>Activity recorded</span>";
  const io = execution.io || {
    input: phase?.goal || phase?.question || phase?.command || phase?.criteria || "This older receipt did not store a node input.",
    context: { overallTask: result.workflow?.task },
    output: index === (result.phaseProgram?.executions?.length || 1) - 1 ? (result.finalResponse || state.error || "") : "This older receipt did not store a node output.",
  };
  const intervention = execution.kind === "checkpoint" ? `<div class="human-intervention"><small>CALIBRATION</small><b>${escapeHtml(status.label)}</b>${execution.feedback ? `<p>${escapeHtml(execution.feedback)}</p>` : "<p>No additional direction was added.</p>"}</div>` : "";
  const exactState = execution.status === "pass" ? "passed" : execution.status === "stopped" ? "stopped" : "failed";
  const exactCheck = execution.kind === "command" ? `<div class="exact-check ${exactState}"><b>${escapeHtml(status.label)}</b><code>${escapeHtml(execution.command || phase?.command || "Command unavailable")}</code><p>${escapeHtml(execution.evidence || execution.summary || "No evidence recorded.")}</p></div>` : "";
  const title = execution.name || phase?.name || (execution.kind === "checkpoint" ? "Calibration" : execution.kind === "verify" ? "Review the result" : "Codex step");
  const detailId = `run-node-${String(execution.phaseId).replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  return `<details class="run-node-detail" id="${escapeHtml(detailId)}"><summary><span class="run-detail-index">${index + 1}</span><span><small>${escapeHtml(phaseKindLabel(execution))}</small><b>${escapeHtml(title)}</b></span><em class="${status.className}">${escapeHtml(status.label)}</em></summary><div class="run-node-body">${intervention}${exactCheck}<div class="activity-chips">${chips}</div><div class="node-io-grid"><details><summary>Input</summary><pre>${escapeHtml(io.input || "No input stored.")}</pre></details><details><summary>Context</summary>${contextMarkup(io.context)}</details><details><summary>Output</summary><pre>${escapeHtml(io.output || "No output stored.")}</pre></details></div></div></details>`;
}

function bindRunReplay(detail) {
  const openDetail = (id) => {
    const target = document.getElementById(id);
    if (!target) return;
    target.open = true;
    $$("[data-run-node]", detail).forEach((node) => node.classList.toggle("selected", node.dataset.runNode === id));
    target.scrollIntoView({ behavior: "smooth", block: "nearest" });
  };
  $$("[data-run-node]", detail).forEach((node) => {
    node.addEventListener("click", () => openDetail(node.dataset.runNode));
    node.addEventListener("keydown", (event) => {
      if (!["Enter", " "].includes(event.key)) return;
      event.preventDefault();
      openDetail(node.dataset.runNode);
    });
  });
}

async function showRun(runId) {
  selectedRunId = runId;
  await loadRuns();
  const detail = $("#run-detail");
  detail.innerHTML = "<p>Loading run…</p>";
  try {
    const state = await request(`/api/runs/${encodeURIComponent(runId)}`);
    const result = state.result || {};
    let executions = result.phaseProgram?.executions || [];
    const timeline = result.timeline || state.timeline || [];
    let graph = result.phaseProgram?.graph || null;
    if (!executions.length) {
      executions = [{ phaseId: "native-codex-run", name: "Codex run", kind: "native", status: result.finalResponse ? "pass" : "fail", io: { input: result.workflow?.task || "Task unavailable", context: { overallTask: result.workflow?.task }, output: result.finalResponse || state.error || "No final response." } }];
      graph = { phases: [{ id: "native-codex-run", name: "Codex run", kind: "native" }], edges: [] };
    }
    const phaseById = new Map((graph?.phases || []).map((phase) => [phase.id, phase]));
    const phaseCards = executions.map((execution, index) => runNodeDetail(execution, phaseById.get(execution.phaseId), index, timeline, result, state)).join("");
    const title = result.workflow?.name || (executions.length ? "Guided workflow" : "Direct Codex run");
    const task = result.workflow?.task || "What you asked Codex to do, where you intervened, and what came back.";
    detail.innerHTML = `<header class="receipt-head"><div><p class="kicker">${escapeHtml(friendlyStatus(result.completionStatus || state.status).toUpperCase())}</p><h2>${escapeHtml(title)}</h2><p>${escapeHtml(task)}</p></div></header>${runCanvasMarkup(graph, executions)}<section class="run-node-list" aria-label="Inspectable workflow nodes">${phaseCards}</section><details class="result-card"><summary>Final result</summary><pre class="receipt-output">${escapeHtml(result.finalResponse || state.error || "No final response.")}</pre></details>`;
    bindRunReplay(detail);
  } catch (error) { detail.innerHTML = `<p>Could not load receipt: ${escapeHtml(error.message)}</p>`; }
}

function integrationItems(kind, values) {
  return values.map((item) => {
    const id = kind === "skill" ? item.name : kind === "mcp" ? item.name : item.id;
    const label = item.name || item.id;
    const selected = selectedIntegrations.some((value) => value.kind === kind && value.id === id);
    const detail = kind === "skill" ? `${item.enabled ? "Enabled" : "Disabled"} · ${item.scope}` : kind === "mcp" ? `${item.authStatus} · ${item.tools.length} tools` : `${item.enabled ? "Enabled" : "Available"}${item.accessible ? "" : " · inaccessible"}`;
    return `<label class="integration-item"><input type="checkbox" data-integration-kind="${kind}" data-integration-id="${escapeHtml(id)}" data-integration-label="${escapeHtml(label)}" ${selected ? "checked" : ""}><span><b>${escapeHtml(label)}</b><small>${escapeHtml(detail)}</small></span></label>`;
  }).join("") || "<p>No items reported.</p>";
}

async function loadIntegrations() {
  const cwd = $("#integrations-cwd").value.trim();
  $("#integrations-status").textContent = "Reading a redacted inventory from Codex…";
  try {
    integrationInventory = await request(`/api/integrations?cwd=${encodeURIComponent(cwd)}`);
    $("#integration-groups").innerHTML = `<section class="integration-group"><h2>Skills</h2><p>Workspace instructions and specialized procedures.</p>${integrationItems("skill", integrationInventory.skills || [])}</section><section class="integration-group"><h2>MCP servers</h2><p>Tool and resource servers already configured in Codex.</p>${integrationItems("mcp", integrationInventory.mcpServers || [])}</section><section class="integration-group"><h2>Connector apps</h2><p>Codex apps available to this account.</p>${integrationItems("app", integrationInventory.apps || [])}</section>`;
    $("#integrations-status").textContent = `${(integrationInventory.skills || []).length} skills · ${(integrationInventory.mcpServers || []).length} MCP servers · ${(integrationInventory.apps || []).length} apps. No secrets or config paths returned.`;
    $$("[data-integration-id]", $("#integration-groups")).forEach((input) => input.addEventListener("change", () => {
      const key = `${input.dataset.integrationKind}:${input.dataset.integrationId}`;
      selectedIntegrations = selectedIntegrations.filter((item) => `${item.kind}:${item.id}` !== key);
      if (input.checked) selectedIntegrations.push({ kind: input.dataset.integrationKind, id: input.dataset.integrationId, label: input.dataset.integrationLabel, phaseIds: [] });
      $("#integrations-status").textContent = `${selectedIntegrations.length} explicit request(s) will be bound to the next Weave run.`;
    }));
  } catch (error) { $("#integrations-status").textContent = `Could not load integrations: ${error.message}`; }
}

async function loadFieldTrials() {
  void loadPlatformTrials();
  const grid = $("#field-trials-grid");
  try {
    const evidence = await request("/reusable-workflow-trials.json");
    const trials = evidence.trials || [];
    const accepted = trials.filter((item) => item.status === "accepted").length;
    const auth = evidence.authentication || {};
    $("#field-trials-summary").innerHTML = `<article><b>${trials.length}</b><small>workflows reused</small></article><article><b>${accepted}</b><small>results accepted</small></article><article><b>${trials.filter((item) => item.upstreamChecks === "passed").length}</b><small>independent checks passed</small></article>`;
    grid.innerHTML = trials.map((trial) => {
      const names = trial.phaseNames || trial.phaseIds || [];
      const kinds = trial.phaseKinds || [];
      const command = (trial.externalCommand || []).join(" ");
      const checkpoint = (trial.checkpoints || [])[0];
      return `<article class="trial-card"><header><div><p class="kicker">${escapeHtml(trial.workflowLabel)}</p><h2>${escapeHtml(trial.taskFamily)}</h2></div><span class="verdict">${escapeHtml(friendlyStatus(trial.status))}</span></header><div class="repo-route"><div><small>CREATED IN</small><b><a href="${escapeHtml(trial.sourceRepository || "#")}" target="_blank" rel="noreferrer">${escapeHtml(trial.sourceRepo)}</a></b></div><span>→</span><div><small>REUSED IN</small><b><a href="${escapeHtml(trial.targetRepository || "#")}" target="_blank" rel="noreferrer">${escapeHtml(trial.targetRepo)}</a></b></div></div><ol class="trial-program">${names.map((name, index) => `<li><small>${escapeHtml(stepKind(kinds[index]))}</small><b>${escapeHtml(name)}</b></li>`).join("")}</ol><p class="adaptation-proof"><b>What changed:</b> ${trial.changedGoals || 0} goal descriptions were rewritten for the new task. The step order and safety bounds stayed the same.</p><dl><dt>calibration point</dt><dd>${escapeHtml(checkpoint ? friendlyStatus(checkpoint.decision) : "Not needed")}</dd><dt>created</dt><dd>${escapeHtml((trial.changedFiles || []).join(", ") || "No file artifact")}</dd><dt>repository check</dt><dd>${trial.upstreamChecks === "passed" ? "Passed" : escapeHtml(friendlyStatus(trial.upstreamChecks))}${trial.externalElapsedSeconds == null ? "" : ` · ${trial.externalElapsedSeconds}s`}</dd><dt>result</dt><dd>${escapeHtml(trial.verification || "Not recorded")}</dd></dl><details class="technical-receipt"><summary>Reproduction command</summary><code>${escapeHtml(command)}</code></details></article>`;
    }).join("");
    const incidents = evidence.incidents || [];
    const incidentText = incidents.length ? `<p>A setup incident was retained separately and excluded from these accepted results.</p>` : "";
    $("#field-trials-limits").innerHTML = `<div class="auth-proof"><b>Test setup</b><p>${escapeHtml(auth.loginStatus || "Not recorded")} · Codex ${escapeHtml(auth.codexVersion || "unknown")} · no API key injected</p></div>${incidentText}<b>What this means</b><p>${escapeHtml(evidence.claimBoundary || "These are bounded product trials, not benchmark scores.")}</p>`;
  } catch (error) {
    grid.innerHTML = `<p>Trial evidence is not available yet: ${escapeHtml(error.message)}</p>`;
    $("#field-trials-summary").innerHTML = "<article><b>Pending</b><small>frozen evidence</small></article>";
  }
}

const trialLabels = {
  "forecast-zero-override": "Forecast repair",
  "night-bloom-poster": "Event poster",
  "connector-action-draft": "Operations draft",
  "incident-support-brief": "Incident brief",
};

function cleanTrialExcerpt(value) {
  return String(value || "No response excerpt recorded.")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\/workspace\/trial-results\/[^\s)]+/g, "the trial workspace");
}

function platformArm(arm, label) {
  const files = Object.keys(arm.artifactHashes || {});
  const checkpoint = (arm.checkpointDecisions || [])[0];
  const root = arm.publicArtifactRoot || "";
  const links = files.map((file) => `<a href="https://github.com/MustafaAH10/WeaveCodex/blob/main/experiments/platform-workflow-trials/results-v2/${escapeHtml(root)}/${escapeHtml(file)}" target="_blank" rel="noreferrer">${escapeHtml(file)}</a>`).join(" · ");
  return `<article class="platform-arm ${checkpoint ? "weave-arm" : ""}"><header><span>${label}</span><b>${arm.artifactPassed ? "Result accepted" : "Result rejected"}</b></header><p>${escapeHtml(cleanTrialExcerpt(arm.finalResponseExcerpt))}</p><footer>${checkpoint ? `<span>Calibration · ${escapeHtml(friendlyStatus(checkpoint.decision))}</span>` : "<span>Codex chose the route</span>"}<span>${links || "No public artifact"}</span></footer></article>`;
}

async function loadPlatformTrials() {
  const grid = $("#platform-trials-grid");
  try {
    const evidence = await request("/api/platform-trials");
    const totals = evidence.totals || {};
    $("#platform-trials-summary").innerHTML = `<article><b>${totals.arms || 0}</b><small>runs completed</small></article><article><b>${totals.artifactsAccepted || 0}</b><small>results accepted</small></article><article><b>${totals.weaveCheckpointsAccepted || 0}</b><small>calibrations recorded</small></article>`;
    grid.innerHTML = (evidence.results || []).map((trial) => `<section class="platform-pair"><header><p class="kicker">SAME TASK · DIFFERENT CONTROL</p><h3>${escapeHtml(trialLabels[trial.trialId] || trial.trialId)}</h3></header><div>${platformArm(trial.ordinaryCodex || {}, "CODEX DIRECT")}${platformArm(trial.weaveCodex || {}, "WITH YOUR WORKFLOW")}</div></section>`).join("");
    $("#platform-trials-limits").innerHTML = `<b>What this shows</b><p>Both control styles produced accepted artifacts in one run per task. The difference was coordination: Weave exposed a visible decision before production. This does not show that Weave makes Codex smarter or more efficient.</p><p><a href="https://github.com/MustafaAH10/WeaveCodex/blob/main/experiments/platform-workflow-trials/results-v2/RESULTS.md" target="_blank" rel="noreferrer">Read the test method →</a></p>`;
  } catch (error) {
    grid.innerHTML = `<p>Platform evidence is unavailable: ${escapeHtml(error.message)}</p>`;
    $("#platform-trials-summary").innerHTML = "<article><b>Unavailable</b><small>tracked evidence</small></article>";
  }
}

async function copyCommand(button) {
  await navigator.clipboard.writeText(button.dataset.copy || "");
  const original = button.textContent;
  button.textContent = "Copied";
  setTimeout(() => { button.textContent = original; }, 1200);
}

async function loadPhaseTemplates() {
  const select = $("#example-workflow-select");
  try {
    const response = await request("/api/phase-templates");
    phaseTemplateCatalog = new Map((response.templates || []).map((item) => [item.id, item]));
    select.innerHTML = '<option value="blank">Blank canvas</option>' + [...phaseTemplateCatalog.values()].map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)} · ${item.nodeCount} nodes</option>`).join("");
  } catch (error) {
    select.innerHTML = '<option value="blank">Blank canvas</option><option value="fine-grained-fix">Fix one bug precisely</option>';
    $("#design-status").textContent = `Example catalog unavailable: ${error.message}`;
  }
}

function fitCanvas() {
  const program = ensureDesignProgram();
  const viewport = $("#canvas-viewport");
  const minX = Math.min(...program.phases.map((phase) => phase.position.x));
  const minY = Math.min(...program.phases.map((phase) => phase.position.y));
  const maxX = Math.max(...program.phases.map((phase) => phase.position.x + 252));
  const maxY = Math.max(...program.phases.map((phase) => phase.position.y + 170));
  const width = Math.max(252, maxX - minX);
  const height = Math.max(170, maxY - minY);
  canvasZoom = Math.max(.42, Math.min(1, (viewport.clientWidth - 96) / width, (viewport.clientHeight - 96) / height));
  canvasPan = {
    x: ((viewport.clientWidth - (width * canvasZoom)) / 2) - (minX * canvasZoom),
    y: ((viewport.clientHeight - (height * canvasZoom)) / 2) - (minY * canvasZoom),
  };
  applyCanvasTransform();
}

async function toggleCanvasFullscreen() {
  const canvas = $("#workflow-canvas");
  const fallbackActive = canvas.classList.contains("canvas-expanded");
  if (fallbackActive) {
    canvas.classList.remove("canvas-expanded");
    document.body.classList.remove("canvas-modal-open");
    updateFullscreenControl(false);
    window.setTimeout(fitCanvas, 80);
    return;
  }
  if (document.fullscreenElement === canvas) {
    await document.exitFullscreen();
    return;
  }
  try {
    if (typeof canvas.requestFullscreen !== "function") throw new Error("browser full screen is unavailable");
    await canvas.requestFullscreen();
  } catch {
    canvas.classList.add("canvas-expanded");
    document.body.classList.add("canvas-modal-open");
    updateFullscreenControl(true);
    window.setTimeout(fitCanvas, 80);
  }
}

function updateFullscreenControl(active) {
  const button = $("#canvas-fullscreen");
  button.setAttribute("aria-label", active ? "Exit full screen" : "Enter full screen");
  button.setAttribute("title", active ? "Exit full screen" : "Full screen canvas");
}

function loadGraphTemplate(kind) {
  designProgram = graphTemplate(kind);
  activeSavedWorkflow = null;
  adaptationMethod = "manual";
  selectedPhaseIndex = 0;
  selectedEdgeIndex = null;
  const template = phaseTemplateCatalog.get(kind);
  $("#design-save-name").value = template?.name || (kind === "blank" ? "Untitled workflow" : "Custom workflow");
  const goals = {
    "frontend-launch": "Repair the checkout journey using the available funnel notes and design system. Let me choose the route before implementation, then prove accessibility and the final flow.",
    "data-analysis": "Explain the material actual-versus-budget variances in the attached quarterly workbook and produce a reconciled one-page CFO brief.",
    "full-stack-product": "Build a complete web product in this repository, including backend, authentication, frontend, and an integrated quality pass.",
    "research-brief": "Choose a CRM for a 50-person sales team using current primary evidence, explicit non-negotiable requirements, and a defensible migration-aware shortlist.",
    "creative-poster": "Create a launch poster from the attached campaign brief using my selected image integration. Show three directions, let me lock one, then audit the final artwork.",
  };
  if (goals[kind] && !$("#task-input").value.trim()) $("#task-input").value = goals[kind];
  renderPhaseEditor();
  window.setTimeout(fitCanvas, 0);
}

async function init() {
  try {
    securitySession = await request("/api/session");
    $("#workspace-input").value = securitySession.workspaceRoot || "";
  } catch (_) { securitySession = null; }
  await loadPhaseTemplates();
  const initialTemplate = phaseTemplateCatalog.has("data-analysis") ? "data-analysis" : "review";
  designProgram = graphTemplate(initialTemplate);
  if ($("#example-workflow-select")) $("#example-workflow-select").value = phaseTemplateCatalog.has(initialTemplate) ? initialTemplate : "blank";
  $("#design-save-name").value = phaseTemplateCatalog.get(initialTemplate)?.name || "My workflow";
  $("#integrations-cwd").value = $("#workspace-input").value;
  await checkAccount();
  configureVoiceInput();
  await loadWorkflows();

  $$("[data-view]").forEach((link) => link.addEventListener("click", (event) => { event.preventDefault(); setView(link.dataset.view); }));
  $$(".mode").forEach((button) => button.addEventListener("click", () => setMode(button.dataset.mode)));
  $$("[data-prompt]").forEach((button) => button.addEventListener("click", () => { $("#task-input").value = button.dataset.prompt; $("#task-input").focus(); }));
  $("#voice-input").addEventListener("click", toggleVoiceInput);
  $("#attach-files").addEventListener("click", () => $("#file-input").click());
  $("#file-input").addEventListener("change", (event) => void uploadSelectedFiles(event.target.files));
  $("#sandbox-select").addEventListener("change", updateSettingsSummary);
  $("#approval-select").addEventListener("change", updateSettingsSummary);
  $("#run-task").addEventListener("click", startRun);
  $("#continue-run").addEventListener("click", () => decide("accept"));
  $("#stop-run").addEventListener("click", () => decide("decline"));
  $("#cancel-active-run").addEventListener("click", stopActiveRun);
  $("#save-workflow").addEventListener("click", saveWorkflow);
  $("#refresh-workflows").addEventListener("click", loadWorkflows);
  $("#canvas-add-node").addEventListener("click", (event) => {
    event.stopPropagation();
    const menu = $("#canvas-node-menu");
    menu.hidden = !menu.hidden;
    $("#canvas-add-node").setAttribute("aria-expanded", String(!menu.hidden));
  });
  $$("[data-add-phase]").forEach((button) => button.addEventListener("click", () => addPhase(button.dataset.addPhase, button.dataset.stepOption)));
  $("#canvas-add-arrow").addEventListener("click", () => setArrowTool(!arrowTool));
  document.addEventListener("click", (event) => {
    if (event.target.closest(".node-menu-shell")) return;
    $("#canvas-node-menu").hidden = true;
    $("#canvas-add-node").setAttribute("aria-expanded", "false");
  });
  $$("[data-graph-template]").forEach((button) => button.addEventListener("click", () => loadGraphTemplate(button.dataset.graphTemplate)));
  $("#load-example-workflow").addEventListener("click", () => loadGraphTemplate($("#example-workflow-select").value));
  $("#canvas-fit").addEventListener("click", fitCanvas);
  $("#canvas-fullscreen").addEventListener("click", toggleCanvasFullscreen);
  $("#canvas-viewport").addEventListener("pointerdown", beginCanvasPan);
  $("#canvas-viewport").addEventListener("pointermove", moveCanvasPan);
  $("#canvas-viewport").addEventListener("pointerup", endCanvasPan);
  $("#canvas-viewport").addEventListener("pointercancel", endCanvasPan);
  $("#canvas-viewport").addEventListener("wheel", handleCanvasWheel, { passive: false });
  document.addEventListener("fullscreenchange", () => {
    const active = document.fullscreenElement === $("#workflow-canvas");
    updateFullscreenControl(active);
    window.setTimeout(fitCanvas, 80);
  });
  $("#phase-editor").addEventListener("click", (event) => {
    if (canvasPanMoved) { canvasPanMoved = false; return; }
    if (event.target !== $("#phase-editor") && event.target !== $("#canvas-nodes") && event.target !== $("#canvas-edges")) return;
    selectedPhaseIndex = -1;
    selectedEdgeIndex = null;
    renderPhaseEditor();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && arrowTool) {
      setArrowTool(false);
      canvasNotice = "";
      renderPhaseEditor();
    }
    if (event.key === "Escape" && $("#workflow-canvas").classList.contains("canvas-expanded")) {
      $("#workflow-canvas").classList.remove("canvas-expanded");
      document.body.classList.remove("canvas-modal-open");
      updateFullscreenControl(false);
      window.setTimeout(fitCanvas, 80);
    }
    if (!$("#create-view").hidden && event.key === "Delete" && selectedEdgeIndex != null && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || "")) {
      ensureDesignProgram().edges.splice(selectedEdgeIndex, 1);
      selectedEdgeIndex = null;
      renderPhaseEditor();
    }
  });
  $("#adapt-with-codex").addEventListener("click", adaptWithCodex);
  $("#use-design").addEventListener("click", useDesignInRun);
  $("#save-design").addEventListener("click", saveDesign);
  $("#refresh-runs").addEventListener("click", loadRuns);
  $("#load-integrations").addEventListener("click", loadIntegrations);
  $("#check-account").addEventListener("click", checkAccount);
  $("#chatgpt-login").addEventListener("click", startLogin);
  $$(".copy-command").forEach((button) => button.addEventListener("click", () => copyCommand(button).catch(() => { button.textContent = "Copy failed"; })));
  window.addEventListener("hashchange", () => setView(location.hash.slice(1), { updateHash: false }));
  setView(location.hash.slice(1) || "create", { updateHash: false });
  window.setTimeout(fitCanvas, 0);
}

function updateSettingsSummary() {
  const summary = $("#settings-summary");
  if (summary) summary.textContent = `${$("#sandbox-select").selectedOptions[0].textContent} · ${$("#approval-select").selectedOptions[0].textContent.toLowerCase()} protected actions`;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { buildManifest, displaySteps, graphProblem, graphTemplate, orderedClientPhases, wouldCreateCycle };
} else {
  void init();
}
