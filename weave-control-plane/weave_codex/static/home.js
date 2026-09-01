const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);

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
let canvasNotice = "";

const clone = (value) => JSON.parse(JSON.stringify(value));

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

function phaseProgram(kind) {
  const workflows = {
    direct: [
      { id: "implement", kind: "work", name: "Complete the goal", goal: "Produce the requested outcome. Gather context and use any relevant tools or integrations along the way." },
      { id: "verify", kind: "verify", name: "Prove it works", criteria: "The requested outcome is complete, accurate, and supported by relevant evidence or checks.", maxRepairs: 1 },
    ],
    review: [
      { id: "inspect", kind: "work", name: "Understand and propose", goal: "Understand the available context and present a concise direction. Do not make consequential changes yet." },
      { id: "approve", kind: "checkpoint", name: "Check with me", question: "Does this direction look right, and should Codex continue?" },
      { id: "implement", kind: "work", name: "Complete the goal", goal: "Follow the approved direction and produce the requested outcome using any relevant tools or integrations." },
      { id: "verify", kind: "verify", name: "Prove the result", criteria: "The requested outcome is complete, accurate, and supported by relevant evidence or checks.", maxRepairs: 1 },
    ],
    audit: [
      { id: "map", kind: "work", name: "Explore the options", goal: "Gather context, compare plausible approaches, and identify assumptions, tradeoffs, and likely failure modes before acting." },
      { id: "implement", kind: "work", name: "Execute the best path", goal: "Choose the strongest supported approach and produce the requested outcome using any relevant tools or integrations." },
      { id: "verify", kind: "verify", name: "Challenge the result", criteria: "Actively look for weak assumptions, missing evidence, edge cases, or quality problems; repair once if the result does not hold up.", maxRepairs: 1 },
    ],
    precision: [
      { id: "inspect", kind: "work", scope: "focused", name: "Find the cause", goal: "Inspect the relevant implementation and focused tests. Explain the smallest supported change.", reasoningEffort: "low" },
      { id: "implement", kind: "work", scope: "focused", name: "Make the focused change", goal: "Implement only the supported change. Do not broaden the task.", reasoningEffort: "inherit" },
      { id: "focused-test", kind: "command", stepType: "test", name: "Run the focused test", command: "python3 -m pytest -q", expectedExitCode: 0, stopOnFailure: true },
      { id: "static-check", kind: "command", stepType: "checker", name: "Check the changed files", command: "git diff --check", expectedExitCode: 0, stopOnFailure: true },
      { id: "review", kind: "verify", name: "Review the evidence", criteria: "The change is narrow, the requested behavior is complete, and every exact check passed.", maxRepairs: 0 },
    ],
  };
  return workflows[kind];
}

function linearGraph(kind) {
  const phases = clone(phaseProgram(kind));
  phases.forEach((phase, index) => { phase.position = { x: 90 + (index * 300), y: 230 }; });
  return {
    projectionVersion: 1,
    phases,
    edges: phases.slice(1).map((phase, index) => ({ from: phases[index].id, to: phase.id })),
  };
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
  const workflow = $("#workflow-select").value;
  if (designProgram) return clone(designProgram);
  if (activeSavedWorkflow) return clone(activeSavedWorkflow.phaseProgram);
  return graphTemplate(workflow);
}

function buildManifest({ mode, name, cwd, instructions, integrations, agent, program }) {
  const direct = mode === "ordinary";
  const requested = clone(integrations?.requested || []).map((item) => direct ? { ...item, phaseIds: [] } : item);
  const value = {
    schemaVersion: direct ? 1 : 2,
    name,
    cwd,
    task: { instructions, contextPaths: [] },
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
    name: runMode === "ordinary" ? "Codex direct" : (activeSavedWorkflow?.name || authoredName || $("#workflow-select").selectedOptions[0].textContent),
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
  const allowed = new Set(["create", "library", "activity"]);
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
  const loopAuthoring = $("#loop-authoring");
  loopAuthoring.classList.toggle("hidden", mode !== "weave");
  loopAuthoring.setAttribute("aria-hidden", String(mode !== "weave"));
  if (mode === "weave" && !designProgram) {
    designProgram = graphTemplate($("#workflow-select").value);
  }
  renderWorkflowPreview();
  const runButton = $("#run-task");
  if (runButton && !runButton.disabled) runButton.innerHTML = mode === "weave" ? "Run my workflow <span>→</span>" : "Run with Codex <span>→</span>";
}

function programNodes(program, { compact = false } = {}) {
  const phases = orderedClientPhases(program || { phases: [], edges: [] });
  return phases.map((phase, index) => `<article class="phase-node ${escapeHtml(phase.kind)}"><small>${index + 1} · ${escapeHtml(phaseKindLabel(phase))}</small><b>${escapeHtml(phase.name)}</b></article>${index < phases.length - 1 ? '<i aria-hidden="true">→</i>' : ""}`).join("") || (compact ? "" : "<p>No steps yet.</p>");
}

function stepKind(kind, stepType = "") {
  if (kind === "command") return ({ function: "One function", test: "Exact test", checker: "Exact checker" })[stepType] || "Exact command";
  return ({ work: "Codex works", checkpoint: "Your decision", verify: "AI review", native: "Codex works" })[kind] || "Observed activity";
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
  if (phase.kind === "checkpoint") return { actor: "Your decision", copy: phase.question, note: "Codex waits here until you continue or stop." };
  if (phase.kind === "verify") return { actor: "AI review", copy: phase.criteria, note: `Codex can repair up to ${phase.maxRepairs || 0} time${phase.maxRepairs === 1 ? "" : "s"}.` };
  if (phase.kind === "command") return { actor: stepKind(phase.kind, phase.stepType), copy: phase.command, note: `Passed only when this exact command is observed with exit code ${phase.expectedExitCode ?? 0}.` };
  return phase.scope === "focused"
    ? { actor: "Focused Codex task", copy: phase.goal, note: "Codex keeps this turn narrow and does not expand into adjacent work." }
    : { actor: "Broad Codex goal", copy: phase.goal, note: "Codex chooses the internal plan and may inspect, edit, test, and retry as much as the outcome requires." };
}

function renderRunLoop(program) {
  const preview = $("#run-loop-preview");
  if (!preview) return;
  preview.innerHTML = orderedClientPhases(program || { phases: [], edges: [] }).map((phase, index) => {
    const plain = phasePlainCopy(phase);
    return `<article class="run-loop-step ${escapeHtml(phase.kind)}"><span>${index + 1}</span><div><small>${escapeHtml(plain.actor)}</small><b>${escapeHtml(phase.name)}</b><p>${escapeHtml(plain.note)}</p></div></article>`;
  }).join("");
}

function renderWorkflowPreview() {
  const program = selectedProgram();
  $("#workflow-preview").innerHTML = programNodes(program);
  renderRunLoop(program);
  if (activeSavedWorkflow) {
    $("#active-workflow").innerHTML = `<span>Using saved workflow · ${escapeHtml(activeSavedWorkflow.name)}</span>`;
  } else {
    $("#active-workflow").innerHTML = "<span>Starting design · change anything later</span>";
  }
}

function updateWorkflowExplanation() {
  activeSavedWorkflow = null;
  adaptationMethod = null;
  const copy = {
    review: "Codex first explains its direction. You decide whether it continues.",
    audit: "Codex compares approaches, takes the best-supported path, then tries to break its own result.",
    direct: "Codex completes the goal without a midpoint pause, then checks and repairs the result once.",
    precision: "Codex works in narrow goals. Exact tests and checkers must visibly pass before the workflow can continue.",
  };
  $("#workflow-explanation").textContent = copy[$("#workflow-select").value];
  $("#design-save-name").value = $("#workflow-select").selectedOptions[0].textContent;
  designProgram = graphTemplate($("#workflow-select").value);
  selectedPhaseIndex = 0;
  renderWorkflowPreview();
  renderPhaseEditor();
}

function selectLoopTemplate(template) {
  if (!["review", "direct", "audit", "precision"].includes(template)) return;
  activeSavedWorkflow = null;
  adaptationMethod = null;
  $("#workflow-select").value = template;
  setMode("weave");
  updateWorkflowExplanation();
  $$('[data-loop-template]').forEach((button) => {
    const active = button.dataset.loopTemplate === template;
    button.classList.toggle("active", active);
    button.setAttribute("aria-checked", String(active));
  });
}

const exampleCases = {
  design: {
    goal: "Create a calm visual direction for a financial planning app.",
    codex: ["Final answer", "One visual direction, rationale, component guidance, and a finished design brief."],
    weave: ["Proposal · 3 directions compared", "Your decision · Direction B approved", "Delivery · Brief and assets created", "Proof · Contrast and consistency checked"],
  },
  operations: {
    goal: "Turn support trends into an approved action plan.",
    codex: ["Final answer", "A prioritized support plan based on the available notes and connected sources."],
    weave: ["Analysis · Themes linked to source evidence", "Your decision · Priorities 1 and 3 approved", "Delivery · Owners and actions drafted", "Proof · Every claim traced back to a source"],
  },
  simulation: {
    goal: "Simulate a café queue and explain the best staffing choice.",
    codex: ["Final answer", "A simulation, three scenarios, and a staffing recommendation."],
    weave: ["Assumptions · Arrival and service rates shown", "Your decision · Lunch spike adjusted", "Execution · Three scenarios run", "Proof · Sensitivity and limitations reported"],
  },
};

function renderExample(caseId = "design") {
  if (!$("#example-goal")) return;
  const example = exampleCases[caseId] || exampleCases.design;
  $("#example-goal").innerHTML = `<span>Goal</span>${escapeHtml(example.goal)}`;
  $("#codex-example-output").innerHTML = example.codex.map((line, index) => `<p class="${index === 0 ? "result-line" : ""}"><span>${index === 0 ? "✓" : ""}</span>${escapeHtml(line)}</p>`).join("");
  $("#weave-example-output").innerHTML = example.weave.map((line, index) => {
    const [label, copy] = line.split(" · ");
    return `<p><span>${index + 1}</span><b>${escapeHtml(label)}</b><small>${escapeHtml(copy)}</small></p>`;
  }).join("");
  $$('[data-example-case]').forEach((button) => button.classList.toggle("active", button.dataset.exampleCase === caseId));
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
  $("#workflow-select").value = "saved";
  $("#workflow-select").selectedOptions[0].textContent = workflow.name;
  $("#workflow-explanation").textContent = "Loaded from your local library. The new task and repository are not inherited.";
  $("#design-save-name").value = workflow.name;
  $("#workflow-name").value = workflow.name;
  $$("[data-loop-template]").forEach((button) => { button.classList.remove("active"); button.setAttribute("aria-checked", "false"); });
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
  return `<article class="saved-workflow"><header><div><small>Saved ${escapeHtml(created)}</small><h3>${escapeHtml(workflow.name)}</h3></div><span class="saved-badge">Ready to reuse</span></header><p>${escapeHtml(workflow.description || "No description.")}</p><div class="mini-program">${programNodes(workflow.phaseProgram, { compact: true })}</div><footer><span>${workflow.phaseProgram.phases.length} steps · ${escapeHtml(lineage)}</span><div><button type="button" data-use-workflow="${escapeHtml(workflow.workflowId)}">Use for a new task</button><button type="button" data-customize-workflow="${escapeHtml(workflow.workflowId)}">Customize</button></div></footer></article>`;
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
    renderWorkflowPreview();
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
      $("#approval-title").textContent = checkpoint ? "Continue to the next step?" : "Codex requested a protected action";
      $("#approval-detail").textContent = checkpoint ? (state.pendingApproval.params?.question || "Continue this run?") : "Review this protected action before allowing it.";
      $("#checkpoint-feedback-wrap").classList.toggle("hidden", !checkpoint);
      $("#continue-run").textContent = checkpoint ? "Continue / redirect" : "Allow";
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
  if (!designProgram) {
    const key = $("#workflow-select").value === "saved" ? "review" : $("#workflow-select").value;
    designProgram = graphTemplate(key);
  }
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

// The product canvas and runtime share this graph representation.
function clientTopologicalOrder(program) {
  if (!program?.edges?.length) return program?.phases || [];
  const byId = new Map(program.phases.map((phase) => [phase.id, phase]));
  const index = new Map(program.phases.map((phase, order) => [phase.id, order]));
  const incoming = new Map(program.phases.map((phase) => [phase.id, 0]));
  const outgoing = new Map(program.phases.map((phase) => [phase.id, []]));
  for (const edge of program.edges) {
    if (!byId.has(edge.from) || !byId.has(edge.to)) return program.phases;
    incoming.set(edge.to, incoming.get(edge.to) + 1);
    outgoing.get(edge.from).push(edge.to);
  }
  const ready = program.phases.filter((phase) => incoming.get(phase.id) === 0).map((phase) => phase.id);
  const result = [];
  while (ready.length) {
    ready.sort((left, right) => index.get(left) - index.get(right));
    const id = ready.shift();
    result.push(byId.get(id));
    for (const target of outgoing.get(id).sort((left, right) => index.get(left) - index.get(right))) {
      incoming.set(target, incoming.get(target) - 1);
      if (incoming.get(target) === 0) ready.push(target);
    }
  }
  return result;
}

function orderedClientPhases(program) {
  const ordered = clientTopologicalOrder(program);
  return ordered.length === (program?.phases?.length || 0) ? ordered : (program?.phases || []);
}

function graphProblem(program) {
  const ids = new Set(program.phases.map((phase) => phase.id));
  if (program.edges.some((edge) => !ids.has(edge.from) || !ids.has(edge.to))) return "An arrow points to a missing node.";
  if (program.edges.some((edge) => edge.from === edge.to)) return "A node cannot point to itself.";
  const identities = program.edges.map((edge) => `${edge.from}\u0000${edge.to}`);
  if (new Set(identities).size !== identities.length) return "The same arrow appears twice.";
  if (program.phases.length > 1 && !program.edges.length) return "Connect the nodes with arrows before running.";
  const incoming = new Map(program.phases.map((phase) => [phase.id, 0]));
  for (const edge of program.edges) incoming.set(edge.to, incoming.get(edge.to) + 1);
  const roots = program.phases.filter((phase) => incoming.get(phase.id) === 0);
  if (roots.length !== 1) return roots.length ? "Connect every loose node so there is one starting point." : "This graph contains a loop. Remove one arrow.";
  if (clientTopologicalOrder(program).length !== program.phases.length) return "This graph contains a loop or disconnected nodes.";
  if (roots[0].kind !== "work") return "The starting node must be a Codex turn.";
  return "";
}

function wouldCreateCycle(program, sourceId, targetId) {
  if (sourceId === targetId) return true;
  const outgoing = new Map(program.phases.map((phase) => [phase.id, []]));
  for (const edge of program.edges) outgoing.get(edge.from)?.push(edge.to);
  const pending = [targetId];
  const seen = new Set();
  while (pending.length) {
    const current = pending.pop();
    if (current === sourceId) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    pending.push(...(outgoing.get(current) || []));
  }
  return false;
}

function uniquePhaseId(stem, program) {
  const base = String(stem).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 42) || "node";
  const ids = new Set(program.phases.map((phase) => phase.id));
  let id = /^[a-z]/.test(base) ? base : `node-${base}`;
  let counter = 2;
  while (ids.has(id)) id = `${base.slice(0, 42)}-${counter++}`;
  return id;
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
  return `<p class="kicker">${escapeHtml(phaseKindLabel(phase).toUpperCase())}</p><h2>${escapeHtml(phase.name)}</h2><div class="inspector-fields"><label>Step name<input data-phase-field="name" value="${escapeHtml(phase.name)}" maxlength="80"></label>${scopeSelect}${typeSelect}<label>${escapeHtml(phaseCopyLabel(phase))}<textarea data-phase-field="${key}" maxlength="${phase.kind === "work" ? 4000 : 2000}" rows="7">${escapeHtml(phase[key])}</textarea></label>${commandSettings}${verifySettings}<p class="connection-summary">${incoming} arrow${incoming === 1 ? "" : "s"} in · ${outgoing} arrow${outgoing === 1 ? "" : "s"} out</p>${connectControl}</div><div class="inspector-actions"><button type="button" data-phase-duplicate>Duplicate step</button><button class="danger" type="button" data-phase-delete>Delete step</button></div>`;
}

function edgeInspector(edge) {
  const program = ensureDesignProgram();
  const source = program.phases.find((phase) => phase.id === edge.from);
  const target = program.phases.find((phase) => phase.id === edge.to);
  return `<p class="kicker">SELECTED ARROW</p><h2>${escapeHtml(source?.name || edge.from)} → ${escapeHtml(target?.name || edge.to)}</h2><p class="edge-help">The target waits for the source to finish. Weave derives Codex turn order from this dependency.</p><div class="inspector-actions"><button class="danger" type="button" data-edge-delete>Delete arrow</button></div>`;
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
    x: (event.clientX - rect.left + viewport.scrollLeft) / canvasZoom,
    y: (event.clientY - rect.top + viewport.scrollTop) / canvasZoom,
  };
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
    renderWorkflowPreview();
    renderPhaseEditor();
  };
  document.addEventListener("pointermove", move);
  document.addEventListener("pointerup", end, { once: true });
}

function beginNodeDrag(event, phaseIndex) {
  if (event.target.closest(".node-port")) return;
  const phase = ensureDesignProgram().phases[phaseIndex];
  canvasDrag = { phaseIndex, origin: { ...phase.position }, start: pointerToCanvas(event) };
  event.currentTarget.setPointerCapture(event.pointerId);
  event.currentTarget.classList.add("dragging");
}

function moveNode(event) {
  if (!canvasDrag) return;
  const phase = ensureDesignProgram().phases[canvasDrag.phaseIndex];
  const point = pointerToCanvas(event);
  phase.position.x = Math.max(20, Math.min(2400, Math.round((canvasDrag.origin.x + point.x - canvasDrag.start.x) / 20) * 20));
  phase.position.y = Math.max(20, Math.min(1010, Math.round((canvasDrag.origin.y + point.y - canvasDrag.start.y) / 20) * 20));
  const node = $(`[data-phase-id="${CSS.escape(phase.id)}"]`, $("#canvas-nodes"));
  node.style.left = `${phase.position.x}px`;
  node.style.top = `${phase.position.y}px`;
  renderCanvasEdges();
}

function endNodeDrag(event) {
  if (!canvasDrag) return;
  event.currentTarget.classList.remove("dragging");
  canvasDrag = null;
  adaptationMethod ||= "manual";
  renderPhaseEditor();
}

function renderPhaseEditor() {
  const program = ensureDesignProgram();
  if (selectedPhaseIndex >= program.phases.length) selectedPhaseIndex = program.phases.length - 1;
  const order = new Map(orderedClientPhases(program).map((phase, index) => [phase.id, index + 1]));
  $("#canvas-nodes").innerHTML = program.phases.map((phase, index) => {
    const plain = phasePlainCopy(phase);
    const footer = phase.kind === "checkpoint" ? "Human pause" : phase.kind === "command" ? "Pass / fail" : phase.kind === "verify" ? "Review + repair" : phase.scope === "focused" ? "Focused turn" : "Broad turn";
    return `<article class="canvas-node ${escapeHtml(phase.kind)} ${escapeHtml(phase.scope || "")} ${index === selectedPhaseIndex ? "selected" : ""}" data-kind="${escapeHtml(phase.kind)}" data-phase-index="${index}" data-phase-id="${escapeHtml(phase.id)}" tabindex="0"><span class="node-order" aria-label="Step ${order.get(phase.id) || index + 1}">${order.get(phase.id) || index + 1}</span><button class="node-port input" data-port="in" type="button" tabindex="-1" aria-hidden="true"></button><small>${escapeHtml(plain.actor)}</small><b>${escapeHtml(phase.name)}</b><p>${escapeHtml(plain.copy)}</p><em>${escapeHtml(footer)}</em><button class="node-port output" data-port="out" type="button" tabindex="-1" aria-hidden="true"></button></article>`;
  }).join("");
  if (selectedEdgeIndex != null && program.edges[selectedEdgeIndex]) $("#phase-inspector").innerHTML = edgeInspector(program.edges[selectedEdgeIndex]);
  else if (selectedPhaseIndex >= 0) $("#phase-inspector").innerHTML = phaseInspector(program.phases[selectedPhaseIndex]);
  else $("#phase-inspector").innerHTML = '<p class="kicker">STEP SETTINGS</p><h2>Select a step</h2><p>Drag it anywhere, edit its instruction, or pull an arrow from its right dot.</p>';
  $$("[data-phase-index]", $("#canvas-nodes")).forEach((node) => {
    const phase = program.phases[Number(node.dataset.phaseIndex)];
    node.style.left = `${phase.position.x}px`;
    node.style.top = `${phase.position.y}px`;
    node.addEventListener("click", () => { selectedPhaseIndex = Number(node.dataset.phaseIndex); selectedEdgeIndex = null; renderPhaseEditor(); });
    node.addEventListener("keydown", (event) => {
      if (!["Enter", " "].includes(event.key)) return;
      event.preventDefault();
      selectedPhaseIndex = Number(node.dataset.phaseIndex);
      selectedEdgeIndex = null;
      renderPhaseEditor();
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
    renderWorkflowPreview();
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
    renderWorkflowPreview();
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
    renderWorkflowPreview();
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
    renderWorkflowPreview();
    renderPhaseEditor();
  }));
  $$("[data-edge-delete]", $("#phase-inspector")).forEach((button) => button.addEventListener("click", () => {
    program.edges.splice(selectedEdgeIndex, 1);
    selectedEdgeIndex = null;
    renderWorkflowPreview();
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
  if (kind === "checkpoint") program.phases.push({ id, kind, name: "My decision", question: "What should Codex show me here before the workflow continues?", position });
  if (kind === "command") program.phases.push({ id, kind, stepType: commandType, name: "Run one exact command", command: "python3 -m pytest -q path/to/test.py::test_name", expectedExitCode: 0, stopOnFailure: true, position });
  if (kind === "verify") program.phases.push({ id, kind, name: "Review and repair", criteria: "Describe what must be true before this workflow can finish.", maxRepairs: 1, position });
  if (selected) program.edges.push({ from: selected.id, to: id });
  selectedPhaseIndex = program.phases.length - 1;
  selectedEdgeIndex = null;
  adaptationMethod ||= "manual";
  renderWorkflowPreview();
  renderPhaseEditor();
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
      return `<button class="run-list-item ${run.runId === selectedRunId ? "active" : ""}" type="button" data-run-id="${escapeHtml(run.runId)}"><span class="run-kind">${kind}</span><b>${escapeHtml(run.name || fallbackName)}</b><small>${escapeHtml(friendlyStatus(run.completionStatus || run.status))} · ${escapeHtml(started)}</small></button>`;
    }).join("") : "<p>No runs yet. Create one and it will appear here.</p>";
    $$("[data-run-id]", list).forEach((button) => button.addEventListener("click", () => void showRun(button.dataset.runId)));
    if (!selectedRunId && runs[0]) {
      selectedRunId = runs[0].runId;
      void showRun(runs[0].runId);
    }
  } catch (error) { list.innerHTML = `<p>Runs unavailable: ${escapeHtml(error.message)}</p>`; }
}

async function showRun(runId) {
  selectedRunId = runId;
  await loadRuns();
  const detail = $("#run-detail");
    detail.innerHTML = "<p>Loading run…</p>";
  try {
    const state = await request(`/api/runs/${encodeURIComponent(runId)}`);
    const result = state.result || {};
    const executions = result.phaseProgram?.executions || [];
    const timeline = result.timeline || state.timeline || [];
    const phaseCards = executions.map((execution, index) => {
      const activity = timeline.filter((item) => item.phase === execution.phaseId);
      const counts = activity.reduce((acc, item) => { acc[item.kind] = (acc[item.kind] || 0) + 1; return acc; }, {});
      const fileCount = (counts.fileChange || 0) + (counts.file_change || 0);
      const actionCount = (counts.command || 0) + (counts.tool || 0) + (counts.toolCall || 0) + (counts.mcp || 0);
      const checkCount = (counts.verification || 0) + (counts.test || 0);
      const summary = [fileCount && `Files changed · ${fileCount}`, actionCount && `Tools used · ${actionCount}`, checkCount && `Checks · ${checkCount}`].filter(Boolean);
      if (execution.kind === "command") summary.unshift(`Exit code · ${execution.observedExitCode ?? "not observed"}`);
      const chips = summary.map((item) => `<span>${escapeHtml(item)}</span>`).join("") || "<span>Codex activity recorded</span>";
      const intervention = execution.kind === "checkpoint" ? `<div class="human-intervention"><small>YOUR DECISION</small><b>${escapeHtml(execution.decision === "accept" || execution.decision === "acceptForSession" ? "Continued" : "Stopped")}</b>${execution.feedback ? `<p>${escapeHtml(execution.feedback)}</p>` : "<p>No additional direction was added.</p>"}</div>` : "";
      const exactState = execution.status === "pass" ? "passed" : execution.status === "stopped" ? "stopped" : "failed";
      const exactLabel = execution.status === "pass" ? "Passed" : execution.status === "stopped" ? "Stopped" : "Failed";
      const exactCheck = execution.kind === "command" ? `<div class="exact-check ${exactState}"><small>${escapeHtml(phaseKindLabel(execution).toUpperCase())}</small><b>${exactLabel}</b><code>${escapeHtml(execution.command || "Command unavailable")}</code><p>${escapeHtml(execution.evidence || execution.summary || "No evidence recorded.")}</p></div>` : "";
      const title = execution.name || (execution.kind === "checkpoint" ? "Your checkpoint" : execution.kind === "verify" ? "Check the result" : "Codex worked on the goal");
      return `<article class="receipt-phase"><header><div><small>${escapeHtml(phaseKindLabel(execution))}</small><b>${escapeHtml(title)}</b></div><small>${escapeHtml(friendlyStatus(execution.status || "observed"))}</small></header>${intervention}${exactCheck}<div class="activity-chips">${chips}</div></article>`;
    }).join("");
    const title = result.workflow?.name || (executions.length ? "Guided workflow" : "Direct Codex run");
    const task = result.workflow?.task || "What you asked Codex to do, where you intervened, and what came back.";
    detail.innerHTML = `<header class="receipt-head"><div><p class="kicker">${escapeHtml(friendlyStatus(result.completionStatus || state.status).toUpperCase())}</p><h2>${escapeHtml(title)}</h2><p>${escapeHtml(task)}</p></div></header>${phaseCards || "<article class=\"receipt-phase\"><header><div><small>CODEX WORKED ADAPTIVELY</small><b>One direct run</b></div><small>Observed</small></header><p>Codex chose its own internal sequence of reasoning and tools.</p></article>"}<section class="result-card"><small>FINAL RESULT</small><pre class="receipt-output">${escapeHtml(result.finalResponse || state.error || "No final response.")}</pre></section><details class="technical-receipt"><summary>Technical record</summary><p>Machine-readable identifiers remain in the local receipt for reproducibility. They are intentionally hidden from the normal workflow.</p></details>`;
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
      return `<article class="trial-card"><header><div><p class="kicker">${escapeHtml(trial.workflowLabel)}</p><h2>${escapeHtml(trial.taskFamily)}</h2></div><span class="verdict">${escapeHtml(friendlyStatus(trial.status))}</span></header><div class="repo-route"><div><small>CREATED IN</small><b><a href="${escapeHtml(trial.sourceRepository || "#")}" target="_blank" rel="noreferrer">${escapeHtml(trial.sourceRepo)}</a></b></div><span>→</span><div><small>REUSED IN</small><b><a href="${escapeHtml(trial.targetRepository || "#")}" target="_blank" rel="noreferrer">${escapeHtml(trial.targetRepo)}</a></b></div></div><ol class="trial-program">${names.map((name, index) => `<li><small>${escapeHtml(stepKind(kinds[index]))}</small><b>${escapeHtml(name)}</b></li>`).join("")}</ol><p class="adaptation-proof"><b>What changed:</b> ${trial.changedGoals || 0} goal descriptions were rewritten for the new task. The step order and safety bounds stayed the same.</p><dl><dt>human checkpoint</dt><dd>${escapeHtml(checkpoint ? friendlyStatus(checkpoint.decision) : "Not needed")}</dd><dt>created</dt><dd>${escapeHtml((trial.changedFiles || []).join(", ") || "No file artifact")}</dd><dt>repository check</dt><dd>${trial.upstreamChecks === "passed" ? "Passed" : escapeHtml(friendlyStatus(trial.upstreamChecks))}${trial.externalElapsedSeconds == null ? "" : ` · ${trial.externalElapsedSeconds}s`}</dd><dt>result</dt><dd>${escapeHtml(trial.verification || "Not recorded")}</dd></dl><details class="technical-receipt"><summary>Reproduction command</summary><code>${escapeHtml(command)}</code></details></article>`;
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
  return `<article class="platform-arm ${checkpoint ? "weave-arm" : ""}"><header><span>${label}</span><b>${arm.artifactPassed ? "Result accepted" : "Result rejected"}</b></header><p>${escapeHtml(cleanTrialExcerpt(arm.finalResponseExcerpt))}</p><footer>${checkpoint ? `<span>Your checkpoint · ${escapeHtml(friendlyStatus(checkpoint.decision))}</span>` : "<span>Codex chose the route</span>"}<span>${links || "No public artifact"}</span></footer></article>`;
}

async function loadPlatformTrials() {
  const grid = $("#platform-trials-grid");
  try {
    const evidence = await request("/api/platform-trials");
    const totals = evidence.totals || {};
    $("#platform-trials-summary").innerHTML = `<article><b>${totals.arms || 0}</b><small>runs completed</small></article><article><b>${totals.artifactsAccepted || 0}</b><small>results accepted</small></article><article><b>${totals.weaveCheckpointsAccepted || 0}</b><small>human gates exercised</small></article>`;
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

function setCanvasZoom(value) {
  canvasZoom = Math.max(.42, Math.min(1.35, Number(value.toFixed(2))));
  $("#phase-editor").style.transform = `scale(${canvasZoom})`;
  $("#canvas-zoom-label").textContent = `${Math.round(canvasZoom * 100)}%`;
}

function arrangeCanvas() {
  const program = ensureDesignProgram();
  const incoming = new Map(program.phases.map((phase) => [phase.id, 0]));
  const outgoing = new Map(program.phases.map((phase) => [phase.id, []]));
  for (const edge of program.edges) {
    if (!incoming.has(edge.to) || !outgoing.has(edge.from)) continue;
    incoming.set(edge.to, incoming.get(edge.to) + 1);
    outgoing.get(edge.from).push(edge.to);
  }
  const depth = new Map();
  const ready = program.phases.filter((phase) => incoming.get(phase.id) === 0).map((phase) => phase.id);
  for (const id of ready) depth.set(id, 0);
  while (ready.length) {
    const id = ready.shift();
    for (const target of outgoing.get(id)) {
      depth.set(target, Math.max(depth.get(target) || 0, (depth.get(id) || 0) + 1));
      incoming.set(target, incoming.get(target) - 1);
      if (incoming.get(target) === 0) ready.push(target);
    }
  }
  const layers = new Map();
  program.phases.forEach((phase, index) => {
    const column = depth.get(phase.id) ?? index;
    if (!layers.has(column)) layers.set(column, []);
    layers.get(column).push(phase);
  });
  for (const [column, phases] of layers) {
    const spacing = Math.min(330, 820 / Math.max(1, phases.length));
    const start = Math.max(70, 520 - ((phases.length - 1) * spacing / 2));
    phases.forEach((phase, row) => { phase.position = { x: 80 + (column * 320), y: Math.round((start + row * spacing) / 20) * 20 }; });
  }
  adaptationMethod ||= "manual";
  renderPhaseEditor();
}

function fitCanvas() {
  const program = ensureDesignProgram();
  const maxX = Math.max(...program.phases.map((phase) => phase.position.x + 290), 900);
  const maxY = Math.max(...program.phases.map((phase) => phase.position.y + 210), 500);
  const viewport = $("#canvas-viewport");
  setCanvasZoom(Math.min((viewport.clientWidth - 50) / maxX, (viewport.clientHeight - 50) / maxY, 1));
  viewport.scrollTo({ left: 0, top: 0, behavior: "smooth" });
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
    "frontend-launch": "Redesign and implement the primary frontend experience in this repository, then show me the result before the final release checks.",
    "data-analysis": "Analyze the available business data, let me review the assumptions, and produce a decision brief with traceable numbers.",
    "full-stack-product": "Build a complete web product in this repository, including backend, authentication, frontend, and an integrated quality pass.",
    "research-brief": "Research the decision using primary sources, let me choose the supported argument, and produce a defensible cited brief.",
    "creative-poster": "Create a distinctive artistic poster, let me choose the visual direction, then critique and refine the final artwork.",
  };
  if (goals[kind] && !$("#task-input").value.trim()) $("#task-input").value = goals[kind];
  renderWorkflowPreview();
  renderPhaseEditor();
  setCanvasZoom(kind === "blank" ? 1 : .68);
  $("#canvas-viewport").scrollTo({ left: 0, top: 0, behavior: "smooth" });
}

async function init() {
  try {
    securitySession = await request("/api/session");
    $("#workspace-input").value = securitySession.workspaceRoot || "";
  } catch (_) { securitySession = null; }
  await loadPhaseTemplates();
  const initialTemplate = phaseTemplateCatalog.has("full-stack-product") ? "full-stack-product" : "review";
  designProgram = graphTemplate(initialTemplate);
  if ($("#example-workflow-select")) $("#example-workflow-select").value = phaseTemplateCatalog.has(initialTemplate) ? initialTemplate : "blank";
  $("#design-save-name").value = phaseTemplateCatalog.get(initialTemplate)?.name || "My workflow";
  $("#integrations-cwd").value = $("#workspace-input").value;
  await checkAccount();
  renderWorkflowPreview();
  renderExample();
  configureVoiceInput();
  await loadWorkflows();

  $$("[data-view]").forEach((link) => link.addEventListener("click", (event) => { event.preventDefault(); setView(link.dataset.view); }));
  $$(".mode").forEach((button) => button.addEventListener("click", () => setMode(button.dataset.mode)));
  $$("[data-loop-template]").forEach((button) => button.addEventListener("click", () => selectLoopTemplate(button.dataset.loopTemplate)));
  $$("[data-example-case]").forEach((button) => button.addEventListener("click", () => renderExample(button.dataset.exampleCase)));
  $$("[data-prompt]").forEach((button) => button.addEventListener("click", () => { $("#task-input").value = button.dataset.prompt; $("#task-input").focus(); }));
  $("#voice-input").addEventListener("click", toggleVoiceInput);
  $("#workflow-select").addEventListener("change", updateWorkflowExplanation);
  $("#sandbox-select").addEventListener("change", updateSettingsSummary);
  $("#approval-select").addEventListener("change", updateSettingsSummary);
  $("#run-task").addEventListener("click", startRun);
  $("#continue-run").addEventListener("click", () => decide("accept"));
  $("#stop-run").addEventListener("click", () => decide("decline"));
  $("#cancel-active-run").addEventListener("click", stopActiveRun);
  $("#save-workflow").addEventListener("click", saveWorkflow);
  $("#save-from-run").addEventListener("click", () => {
    $("#workflow-name").value = activeSavedWorkflow?.name || $("#workflow-select").selectedOptions[0].textContent;
    setView("library");
  });
  $("#refresh-workflows").addEventListener("click", loadWorkflows);
  $$("[data-add-phase]").forEach((button) => button.addEventListener("click", () => addPhase(button.dataset.addPhase, button.dataset.stepOption)));
  $$("[data-graph-template]").forEach((button) => button.addEventListener("click", () => loadGraphTemplate(button.dataset.graphTemplate)));
  $("#load-example-workflow").addEventListener("click", () => loadGraphTemplate($("#example-workflow-select").value));
  $("#canvas-arrange").addEventListener("click", arrangeCanvas);
  $("#canvas-fit").addEventListener("click", fitCanvas);
  $("#canvas-zoom-out").addEventListener("click", () => setCanvasZoom(canvasZoom - .1));
  $("#canvas-zoom-in").addEventListener("click", () => setCanvasZoom(canvasZoom + .1));
  $("#phase-editor").addEventListener("click", (event) => {
    if (event.target !== $("#phase-editor") && event.target !== $("#canvas-nodes") && event.target !== $("#canvas-edges")) return;
    selectedPhaseIndex = -1;
    selectedEdgeIndex = null;
    renderPhaseEditor();
  });
  document.addEventListener("keydown", (event) => {
    if (!$("#create-view").hidden && event.key === "Delete" && selectedEdgeIndex != null && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || "")) {
      ensureDesignProgram().edges.splice(selectedEdgeIndex, 1);
      selectedEdgeIndex = null;
      renderWorkflowPreview();
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
  setCanvasZoom(.68);
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
