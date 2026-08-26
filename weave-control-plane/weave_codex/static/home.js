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
let draggedPhaseIndex = null;

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
      { id: "focused-test", kind: "command", stepType: "test", name: "Run the focused test", command: "python -m pytest -q", expectedExitCode: 0, stopOnFailure: true },
      { id: "static-check", kind: "command", stepType: "checker", name: "Check the changed files", command: "git diff --check", expectedExitCode: 0, stopOnFailure: true },
      { id: "review", kind: "verify", name: "Review the evidence", criteria: "The change is narrow, the requested behavior is complete, and every exact check passed.", maxRepairs: 0 },
    ],
  };
  return workflows[kind];
}

function selectedProgram() {
  const workflow = $("#workflow-select").value;
  if (designProgram) return clone(designProgram);
  if (activeSavedWorkflow) return clone(activeSavedWorkflow.phaseProgram);
  return { projectionVersion: 1, phases: clone(phaseProgram(workflow)) };
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
    designProgram = { projectionVersion: 1, phases: clone(phaseProgram($("#workflow-select").value)) };
  }
  renderWorkflowPreview();
  const runButton = $("#run-task");
  if (runButton && !runButton.disabled) runButton.innerHTML = mode === "weave" ? "Run my workflow <span>→</span>" : "Run with Codex <span>→</span>";
}

function programNodes(program, { compact = false } = {}) {
  const phases = program?.phases || [];
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
  preview.innerHTML = (program?.phases || []).map((phase, index) => {
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
  designProgram = { projectionVersion: 1, phases: clone(phaseProgram($("#workflow-select").value)) };
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
    $("#design-task").value = $("#task-input").value;
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
    $("#design-task").value = $("#task-input").value;
    setView("create");
    const customizer = $("#customize-loop");
    customizer.open = true;
    customizer.scrollIntoView({ behavior: "smooth", block: "start" });
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
  return value.phaseProgram?.phases || [{ id: "native-codex-run", kind: "native", name: "One native adaptive Codex run" }];
}

async function startRun() {
  clearTimeout(pollTimer);
  const value = manifest();
  if (value.task.instructions.length < 4) { $("#task-input").focus(); return; }
  if (!value.cwd.startsWith("/")) { $("#workspace-input").focus(); return; }
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
    $("#run-status").textContent = String(state.status || "running").replace(/([A-Z])/g, " $1").trim();
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
      $("#run-output").textContent = result.finalResponse || state.error || "Run ended without a final response.";
      $("#run-output").classList.remove("hidden");
      $("#run-note").textContent = "Finished. A readable record is available in Activity.";
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
    designProgram = { projectionVersion: 1, phases: clone(phaseProgram(key)) };
  }
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

function phaseInspector(phase, index, count) {
  const key = phaseCopyKey(phase);
  const scopeSelect = phase.kind === "work" ? `<label>How much freedom?<select data-phase-field="scope"><option value="adaptive" ${phase.scope !== "focused" ? "selected" : ""}>Broad · Codex chooses the internal route</option><option value="focused" ${phase.scope === "focused" ? "selected" : ""}>Focused · stay inside this instruction</option></select></label>` : "";
  const typeSelect = phase.kind === "command" ? `<label>Step type<select data-phase-field="stepType"><option value="function" ${phase.stepType === "function" ? "selected" : ""}>One function</option><option value="test" ${phase.stepType === "test" ? "selected" : ""}>One test</option><option value="checker" ${phase.stepType === "checker" ? "selected" : ""}>One checker</option></select></label>` : "";
  const commandSettings = phase.kind === "command" ? `<div class="inspector-grid"><label>Passing exit code<input data-phase-field="expectedExitCode" type="number" min="0" max="255" value="${phase.expectedExitCode ?? 0}"></label><label class="switch-field"><input data-phase-field="stopOnFailure" type="checkbox" ${phase.stopOnFailure !== false ? "checked" : ""}><span>Stop if this fails</span></label></div><p class="inspector-proof">Passed means this exact command was observed in Codex events with the expected exit code.</p>` : "";
  const verifySettings = phase.kind === "verify" ? `<label>Repair attempts<select data-phase-field="maxRepairs"><option value="0" ${phase.maxRepairs === 0 ? "selected" : ""}>None</option><option value="1" ${phase.maxRepairs === 1 ? "selected" : ""}>One</option><option value="2" ${phase.maxRepairs === 2 ? "selected" : ""}>Two</option></select></label>` : "";
  const maxLength = phase.kind === "work" ? 4000 : 2000;
  return `<p class="kicker">STEP ${index + 1} · ${escapeHtml(phaseKindLabel(phase).toUpperCase())}</p><h2>${escapeHtml(phase.name)}</h2><div class="inspector-fields"><label>Step name<input data-phase-field="name" value="${escapeHtml(phase.name)}" maxlength="80"></label>${scopeSelect}${typeSelect}<label>${escapeHtml(phaseCopyLabel(phase))}<textarea data-phase-field="${key}" maxlength="${maxLength}" rows="6">${escapeHtml(phase[key])}</textarea></label>${commandSettings}${verifySettings}</div><div class="inspector-actions"><button type="button" data-phase-move="up" ${index === 0 ? "disabled" : ""}>← Earlier</button><button type="button" data-phase-move="down" ${index === count - 1 ? "disabled" : ""}>Later →</button><button class="danger" type="button" data-phase-delete>Delete</button></div>`;
}

function renderPhaseEditor() {
  const program = ensureDesignProgram();
  $("#design-cwd").value ||= $("#workspace-input").value;
  selectedPhaseIndex = Math.min(Math.max(selectedPhaseIndex, 0), program.phases.length - 1);
  $("#phase-editor").innerHTML = program.phases.map((phase, index) => {
    const plain = phasePlainCopy(phase);
    return `${index ? '<span class="canvas-edge" aria-hidden="true"><i></i><b>then</b></span>' : ""}<button class="canvas-node ${escapeHtml(phase.kind)} ${escapeHtml(phase.scope || "")} ${index === selectedPhaseIndex ? "selected" : ""}" data-kind="${escapeHtml(phase.kind)}" data-phase-index="${index}" draggable="true" type="button" role="listitem"><span class="node-order">${index + 1}</span><small>${escapeHtml(plain.actor)}</small><b>${escapeHtml(phase.name)}</b><p>${escapeHtml(plain.copy)}</p><em>Not run</em></button>`;
  }).join("");
  $("#phase-inspector").innerHTML = phaseInspector(program.phases[selectedPhaseIndex], selectedPhaseIndex, program.phases.length);
  $$("[data-phase-index]", $("#phase-editor")).forEach((node) => {
    node.addEventListener("click", () => { selectedPhaseIndex = Number(node.dataset.phaseIndex); renderPhaseEditor(); });
    node.addEventListener("dragstart", () => { draggedPhaseIndex = Number(node.dataset.phaseIndex); node.classList.add("dragging"); });
    node.addEventListener("dragend", () => { draggedPhaseIndex = null; node.classList.remove("dragging"); });
    node.addEventListener("dragover", (event) => event.preventDefault());
    node.addEventListener("drop", (event) => {
      event.preventDefault();
      const target = Number(node.dataset.phaseIndex);
      if (draggedPhaseIndex == null || draggedPhaseIndex === target) return;
      const [moved] = program.phases.splice(draggedPhaseIndex, 1);
      program.phases.splice(target, 0, moved);
      selectedPhaseIndex = target;
      adaptationMethod ||= "manual";
      renderWorkflowPreview();
      renderPhaseEditor();
    });
  });
  $$("[data-phase-field]", $("#phase-inspector")).forEach((field) => field.addEventListener("input", () => {
    const phase = program.phases[selectedPhaseIndex];
    const key = field.dataset.phaseField;
    if (["maxRepairs", "expectedExitCode"].includes(key)) phase[key] = Number(field.value);
    else if (key === "stopOnFailure") phase[key] = field.checked;
    else phase[key] = field.value;
    adaptationMethod ||= "manual";
    renderWorkflowPreview();
    const node = $(`[data-phase-index="${selectedPhaseIndex}"]`, $("#phase-editor"));
    if (key === "name") { node.querySelector("b").textContent = field.value; $("#phase-inspector h2").textContent = field.value; }
    if (key === phaseCopyKey(phase)) node.querySelector("p").textContent = field.value;
    if (["stepType", "scope"].includes(key)) renderPhaseEditor();
  }));
  $$("[data-phase-move]", $("#phase-inspector")).forEach((button) => button.addEventListener("click", () => {
    const index = selectedPhaseIndex;
    const next = button.dataset.phaseMove === "up" ? index - 1 : index + 1;
    if (next < 0 || next >= program.phases.length) return;
    [program.phases[index], program.phases[next]] = [program.phases[next], program.phases[index]];
    selectedPhaseIndex = next;
    adaptationMethod ||= "manual";
    renderWorkflowPreview();
    renderPhaseEditor();
  }));
  $$("[data-phase-delete]", $("#phase-inspector")).forEach((button) => button.addEventListener("click", () => {
    const index = selectedPhaseIndex;
    if (program.phases.length === 1 || (program.phases[index].kind === "work" && program.phases.filter((item) => item.kind === "work").length === 1)) {
      $("#design-status").textContent = "A workflow needs at least one Codex work step.";
      return;
    }
    program.phases.splice(index, 1);
    selectedPhaseIndex = Math.min(index, program.phases.length - 1);
    adaptationMethod ||= "manual";
    renderWorkflowPreview();
    renderPhaseEditor();
  }));
  const origin = activeSavedWorkflow
    ? adaptationMethod
      ? `Unsaved changes to “${activeSavedWorkflow.name}”`
      : `Using saved workflow “${activeSavedWorkflow.name}”`
    : "Starting design · not saved";
  $("#design-origin").textContent = origin;
}

function addPhase(kind, stepOption = "adaptive") {
  const program = ensureDesignProgram();
  if (program.phases.length >= 16) {
    $("#design-status").textContent = "A workflow can contain at most sixteen steps.";
    return;
  }
  const commandType = kind === "command" ? stepOption : "test";
  const stem = kind === "work" ? "work" : kind === "checkpoint" ? "checkpoint" : kind === "command" ? commandType : "verify";
  let id = stem;
  let counter = 2;
  const ids = new Set(program.phases.map((phase) => phase.id));
  while (ids.has(id)) id = `${stem}-${counter++}`;
  if (kind === "work") program.phases.push({ id, kind, scope: stepOption === "focused" ? "focused" : "adaptive", name: stepOption === "focused" ? "New focused task" : "New broad Codex goal", goal: stepOption === "focused" ? "Describe one narrow outcome Codex must complete without expanding scope." : "Describe a high-level outcome and let Codex choose the internal plan, tools, and retries.", reasoningEffort: "inherit" });
  if (kind === "checkpoint") program.phases.push({ id, kind, name: "My decision", question: "Continue to the next step?" });
  if (kind === "command") program.phases.push({ id, kind, stepType: commandType, name: commandType === "test" ? "Run one test" : commandType === "checker" ? "Run one checker" : "Run one function", command: commandType === "test" ? "python -m pytest -q path/to/test.py::test_name" : commandType === "checker" ? "git diff --check" : "python -c \"from package import function; function()\"", expectedExitCode: 0, stopOnFailure: true });
  if (kind === "verify") program.phases.push({ id, kind, name: "Check the result", criteria: "The requested outcome is complete and supported by relevant checks.", maxRepairs: 1 });
  selectedPhaseIndex = program.phases.length - 1;
  adaptationMethod ||= "manual";
  renderWorkflowPreview();
  renderPhaseEditor();
}

async function adaptWithCodex() {
  const task = $("#design-task").value.trim();
  const cwd = $("#design-cwd").value.trim();
  if (task.length < 8) { $("#design-task").focus(); return; }
  if (!cwd.startsWith("/")) { $("#design-cwd").focus(); return; }
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

function useDesignInRun() {
  setMode("weave");
  $("#task-input").value = $("#design-task").value;
  $("#workspace-input").value = $("#design-cwd").value;
  renderWorkflowPreview();
  setView("create");
  $("#task-composer").scrollIntoView({ behavior: "smooth", block: "start" });
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

function setArchitectureLayer(enabled) {
  const card = $(".architecture-card");
  card.dataset.weave = enabled ? "on" : "off";
  $("#architecture-codex").classList.toggle("active", !enabled);
  $("#architecture-weave").classList.toggle("active", enabled);
  $("#architecture-caption").innerHTML = enabled ? '<b>With Weave:</b> you choose the responsibility of every node—from one adaptive outcome to one exact check. <a href="/platform.html">Read the technical guide →</a>' : '<b>Codex only:</b> one goal enters the native adaptive loop. <a href="/platform.html">Read the technical guide →</a>';
}

async function copyCommand(button) {
  await navigator.clipboard.writeText(button.dataset.copy || "");
  const original = button.textContent;
  button.textContent = "Copied";
  setTimeout(() => { button.textContent = original; }, 1200);
}

async function init() {
  try {
    securitySession = await request("/api/session");
    $("#workspace-input").value = securitySession.workspaceRoot || "";
  } catch (_) { securitySession = null; }
  designProgram = { projectionVersion: 1, phases: clone(phaseProgram("review")) };
  $("#design-cwd").value = $("#workspace-input").value;
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
  $$("[data-prompt]").forEach((button) => button.addEventListener("click", () => { $("#task-input").value = button.dataset.prompt; $("#design-task").value = button.dataset.prompt; $("#task-input").focus(); }));
  $("#task-input").addEventListener("input", () => { $("#design-task").value = $("#task-input").value; });
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
  $("#open-customizer").addEventListener("click", () => {
    const customizer = $("#customize-loop");
    customizer.open = true;
    customizer.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  $("#refresh-workflows").addEventListener("click", loadWorkflows);
  $$("[data-add-phase]").forEach((button) => button.addEventListener("click", () => addPhase(button.dataset.addPhase, button.dataset.stepOption)));
  $("#adapt-with-codex").addEventListener("click", adaptWithCodex);
  $("#use-design").addEventListener("click", useDesignInRun);
  $("#save-design").addEventListener("click", saveDesign);
  $("#refresh-runs").addEventListener("click", loadRuns);
  $("#load-integrations").addEventListener("click", loadIntegrations);
  $("#architecture-codex").addEventListener("click", () => setArchitectureLayer(false));
  $("#architecture-weave").addEventListener("click", () => setArchitectureLayer(true));
  $("#check-account").addEventListener("click", checkAccount);
  $("#chatgpt-login").addEventListener("click", startLogin);
  $$(".copy-command").forEach((button) => button.addEventListener("click", () => copyCommand(button).catch(() => { button.textContent = "Copy failed"; })));
  window.addEventListener("hashchange", () => setView(location.hash.slice(1), { updateHash: false }));
  setView(location.hash.slice(1) || "create", { updateHash: false });
}

function updateSettingsSummary() {
  $("#settings-summary").textContent = `${$("#sandbox-select").selectedOptions[0].textContent} · ${$("#approval-select").selectedOptions[0].textContent.toLowerCase()} protected actions`;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { buildManifest, displaySteps };
} else {
  void init();
}
