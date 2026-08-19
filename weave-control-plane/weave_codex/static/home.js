const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);

let securitySession = null;
let runMode = "ordinary";
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
    ordinary: [{ id: "work", kind: "work", name: "Codex task", goal: "Complete the user's task autonomously. Inspect, edit, test, and adapt as needed." }],
    direct: [
      { id: "implement", kind: "work", name: "Implement", goal: "Implement the requested outcome and run relevant checks." },
      { id: "verify", kind: "verify", name: "Verify", criteria: "The requested outcome is complete and relevant checks pass.", maxRepairs: 1 },
    ],
    review: [
      { id: "inspect", kind: "work", name: "Inspect", goal: "Inspect the repository and produce a concise implementation direction without changing files." },
      { id: "approve", kind: "checkpoint", name: "Approve direction", question: "Continue with this implementation direction?" },
      { id: "implement", kind: "work", name: "Implement", goal: "Implement the approved direction and run the relevant checks." },
      { id: "verify", kind: "verify", name: "Verify", criteria: "The requested outcome is complete, focused, and supported by passing checks.", maxRepairs: 1 },
    ],
    audit: [
      { id: "map", kind: "work", name: "Map risk", goal: "Map the relevant architecture, tests, and likely failure modes before editing." },
      { id: "implement", kind: "work", name: "Implement", goal: "Implement the smallest robust change and run focused tests." },
      { id: "verify", kind: "verify", name: "Adversarial verify", criteria: "Challenge the change for regressions and edge cases; pass only when focused tests and evidence support it.", maxRepairs: 1 },
    ],
  };
  return workflows[kind];
}

function selectedProgram() {
  const workflow = runMode === "ordinary" ? "ordinary" : $("#workflow-select").value;
  if (workflow === "ordinary") return { projectionVersion: 1, phases: phaseProgram("ordinary") };
  if (designProgram) return clone(designProgram);
  if (activeSavedWorkflow) return clone(activeSavedWorkflow.phaseProgram);
  return { projectionVersion: 1, phases: clone(phaseProgram(workflow)) };
}

function manifest() {
  return {
    schemaVersion: 2,
    name: runMode === "ordinary" ? "Codex direct" : (activeSavedWorkflow?.name || `Weave ${$("#workflow-select").value}`),
    cwd: $("#workspace-input").value.trim(),
    task: { instructions: $("#task-input").value.trim(), contextPaths: [] },
    memory: { mode: "off", selectedThreadIds: [] },
    integrations: { inventoryId: integrationInventory?.inventoryId || null, requested: clone(selectedIntegrations) },
    agent: { model: null, reasoningEffort: "medium", sandbox: $("#sandbox-select").value, approvalGate: $("#approval-select").value },
    verification: { enabled: false, criteria: "Phase program owns verification.", maxRetries: 0 },
    output: { format: "text" },
    observability: { traceRoot: ".weave-codex/traces" },
    phaseProgram: selectedProgram(),
  };
}

function setView(view, { updateHash = true } = {}) {
  const allowed = new Set(["run", "design", "workflows", "runs", "integrations", "field-trials", "architecture", "setup"]);
  const active = allowed.has(view) ? view : "run";
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
  window.scrollTo(0, 0);
  if (active === "workflows") {
    if (runMode === "ordinary") setMode("weave");
    void loadWorkflows();
  }
  if (active === "design") renderPhaseEditor();
  if (active === "runs") void loadRuns();
  if (active === "integrations") {
    $("#integrations-cwd").value ||= $("#workspace-input").value;
  }
  if (active === "field-trials") void loadFieldTrials();
  if (active === "setup") void checkAccount();
}

function setMode(mode) {
  runMode = mode;
  $$(".mode").forEach((button) => {
    const active = button.dataset.mode === mode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-checked", String(active));
  });
  $("#workflow-choice").classList.toggle("hidden", mode !== "weave");
  if (mode === "weave" && !designProgram) {
    designProgram = { projectionVersion: 1, phases: clone(phaseProgram($("#workflow-select").value)) };
  }
  renderWorkflowPreview();
}

function programNodes(program, { compact = false } = {}) {
  const phases = program?.phases || [];
  return phases.map((phase, index) => `<article class="phase-node ${escapeHtml(phase.kind)}"><small>${index + 1} · ${escapeHtml(phase.kind)}</small><b>${escapeHtml(phase.name)}</b></article>${index < phases.length - 1 ? '<i aria-hidden="true">→</i>' : ""}`).join("") || (compact ? "" : "<p>No phases.</p>");
}

function renderWorkflowPreview() {
  const program = selectedProgram();
  $("#workflow-preview").innerHTML = programNodes(program);
  if (activeSavedWorkflow) {
    $("#active-workflow").innerHTML = `<span>Saved workflow · task not included</span><code>${escapeHtml(activeSavedWorkflow.programHash.slice(0, 22))}…</code>`;
  } else {
    $("#active-workflow").innerHTML = "<span>Built-in starting shape</span><code>not saved</code>";
  }
}

function updateWorkflowExplanation() {
  activeSavedWorkflow = null;
  adaptationMethod = null;
  const copy = {
    review: "Pause after inspection so you can approve the direction before files change.",
    audit: "Require an architectural risk map before implementation, then challenge the result.",
    direct: "Keep the workflow short while retaining a separate verification and repair bound.",
  };
  $("#workflow-explanation").textContent = copy[$("#workflow-select").value];
  designProgram = { projectionVersion: 1, phases: clone(phaseProgram($("#workflow-select").value)) };
  renderWorkflowPreview();
}

function applyWorkflow(workflow, { customize = false } = {}) {
  activeSavedWorkflow = workflow;
  designProgram = clone(workflow.phaseProgram);
  adaptationMethod = null;
  $("#workflow-select").value = "saved";
  $("#workflow-select").selectedOptions[0].textContent = workflow.name;
  $("#workflow-explanation").textContent = "Loaded from your local library. The new task and repository are not inherited.";
  setMode("weave");
  $("#task-input").value = "";
  if (customize) {
    $("#design-task").value = $("#task-input").value;
    setView("design");
  } else {
    setView("run");
    $("#task-input").focus();
  }
}

function workflowCard(workflow) {
  const created = new Date(workflow.createdAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  const lineage = workflow.parentWorkflowId ? `Derived from ${workflow.parentWorkflowId}` : "Original workflow";
  return `<article class="saved-workflow"><header><div><small>IMMUTABLE · ${escapeHtml(created)}</small><h3>${escapeHtml(workflow.name)}</h3></div><code>${escapeHtml(workflow.programHash.slice(7, 19))}</code></header><p>${escapeHtml(workflow.description || "No description.")}</p><div class="mini-program">${programNodes(workflow.phaseProgram, { compact: true })}</div><footer><span>${workflow.phaseProgram.phases.length} phases · ${escapeHtml(lineage)}</span><div><button type="button" data-use-workflow="${escapeHtml(workflow.workflowId)}">Run unchanged</button><button type="button" data-customize-workflow="${escapeHtml(workflow.workflowId)}">Edit for another task →</button></div></footer></article>`;
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
    library.innerHTML = savedWorkflows.length ? savedWorkflows.map(workflowCard).join("") : '<div class="empty-library"><b>No saved workflows yet.</b><p>Save the current phase program on the left. Your task and repository will not be included.</p></div>';
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
    status.textContent = `Saved ${saved.workflowId}. Program ${saved.programHash.slice(0, 22)}…; no task or repository stored.`;
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
  const completed = new Set(executions.filter((item) => item.status === "completed").map((item) => item.phaseId));
  $("#run-steps").innerHTML = phases.map((phase, index) => `<article class="${completed.has(phase.id) ? "done" : activePhase === phase.id ? "active" : ""}"><small>${String(index + 1).padStart(2, "0")} · ${escapeHtml(phase.kind)}</small><b>${escapeHtml(phase.name)}</b></article>`).join("");
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
    renderSteps(value.phaseProgram.phases);
    $("#live-run").classList.remove("hidden");
    $("#live-run-title").textContent = value.name;
    $("#run-status").textContent = `≤ ${compiled.maximumTurns} controller turns`;
    $("#run-output").classList.add("hidden");
    $("#approval-card").classList.add("hidden");
    $("#live-run").scrollIntoView({ behavior: "smooth", block: "start" });
    const result = await request("/api/runs", { method: "POST", body: JSON.stringify(value) });
    activeRun = result.runId;
    button.textContent = "Run in progress";
    pollRun(value.phaseProgram.phases);
  } catch (error) {
    button.disabled = false;
    button.innerHTML = "Run with Codex <span>→</span>";
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
      $("#approval-title").textContent = checkpoint ? "Approve the next phase?" : "Codex requested a protected action";
      $("#approval-detail").textContent = checkpoint ? (state.pendingApproval.params?.question || "Continue this run?") : "Review this protected action before allowing it.";
      $("#approval-card").classList.remove("hidden");
    } else $("#approval-card").classList.add("hidden");
    if (["completed", "failed"].includes(state.status)) {
      const result = state.result || {};
      $("#run-output").textContent = result.finalResponse || state.error || "Run ended without a final response.";
      $("#run-output").classList.remove("hidden");
      $("#run-note").textContent = result.manifestHash ? `Receipt bound to ${result.manifestHash.slice(0, 22)}…` : "The run receipt stays on this machine.";
      $("#run-task").disabled = false;
      $("#run-task").innerHTML = "Run another task <span>→</span>";
      return;
    }
    pollTimer = setTimeout(() => pollRun(phases), 700);
  } catch (error) {
    $("#run-output").textContent = String(error.message || error);
    $("#run-output").classList.remove("hidden");
    $("#run-task").disabled = false;
  }
}

async function decide(decision) {
  if (!activeRun) return;
  await request(`/api/runs/${encodeURIComponent(activeRun)}/approval`, { method: "POST", body: JSON.stringify({ decision }) });
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
  return phase.kind === "work" ? "goal" : phase.kind === "checkpoint" ? "question" : "criteria";
}

function phaseCopyLabel(phase) {
  return phase.kind === "work" ? "Complete goal for this Codex turn" : phase.kind === "checkpoint" ? "Question shown to the human" : "Pass criteria";
}

function renderPhaseEditor() {
  const program = ensureDesignProgram();
  $("#design-cwd").value ||= $("#workspace-input").value;
  $("#phase-editor").innerHTML = program.phases.map((phase, index) => {
    const key = phaseCopyKey(phase);
    return `<article class="phase-card" data-kind="${escapeHtml(phase.kind)}" data-phase-index="${index}"><span class="phase-number">${String(index + 1).padStart(2, "0")}</span><div class="phase-fields"><label class="phase-field">Type<select data-phase-field="kind" disabled><option>${escapeHtml(phase.kind)}</option></select></label><label class="phase-field">Name<input data-phase-field="name" value="${escapeHtml(phase.name)}" maxlength="80"></label><label class="phase-field copy">${phaseCopyLabel(phase)}<textarea data-phase-field="${key}" maxlength="${phase.kind === "work" ? 4000 : 2000}">${escapeHtml(phase[key])}</textarea></label>${phase.kind === "verify" ? `<label class="phase-field">Repair turns<select data-phase-field="maxRepairs"><option value="0" ${phase.maxRepairs === 0 ? "selected" : ""}>0</option><option value="1" ${phase.maxRepairs === 1 ? "selected" : ""}>1</option><option value="2" ${phase.maxRepairs === 2 ? "selected" : ""}>2</option></select></label>` : ""}</div><div class="phase-card-actions"><button type="button" data-phase-move="up" aria-label="Move up">↑</button><button type="button" data-phase-move="down" aria-label="Move down">↓</button><button class="danger" type="button" data-phase-delete aria-label="Delete phase">Delete</button></div></article>`;
  }).join("");
  $$("[data-phase-field]", $("#phase-editor")).forEach((field) => field.addEventListener("input", () => {
    const card = field.closest("[data-phase-index]");
    const phase = program.phases[Number(card.dataset.phaseIndex)];
    const key = field.dataset.phaseField;
    phase[key] = key === "maxRepairs" ? Number(field.value) : field.value;
    adaptationMethod ||= "manual";
    renderWorkflowPreview();
  }));
  $$("[data-phase-move]", $("#phase-editor")).forEach((button) => button.addEventListener("click", () => {
    const index = Number(button.closest("[data-phase-index]").dataset.phaseIndex);
    const next = button.dataset.phaseMove === "up" ? index - 1 : index + 1;
    if (next < 0 || next >= program.phases.length) return;
    [program.phases[index], program.phases[next]] = [program.phases[next], program.phases[index]];
    adaptationMethod ||= "manual";
    renderPhaseEditor();
  }));
  $$("[data-phase-delete]", $("#phase-editor")).forEach((button) => button.addEventListener("click", () => {
    const index = Number(button.closest("[data-phase-index]").dataset.phaseIndex);
    if (program.phases.length === 1 || (program.phases[index].kind === "work" && program.phases.filter((item) => item.kind === "work").length === 1)) {
      $("#design-status").textContent = "A workflow needs at least one Work phase.";
      return;
    }
    program.phases.splice(index, 1);
    adaptationMethod ||= "manual";
    renderPhaseEditor();
  }));
  const origin = activeSavedWorkflow
    ? adaptationMethod
      ? `Unsaved edits derived from ${activeSavedWorkflow.workflowId} · parent remains immutable`
      : `Saved ${activeSavedWorkflow.workflowId}${activeSavedWorkflow.parentWorkflowId ? ` · parent ${activeSavedWorkflow.parentWorkflowId}` : " · original workflow"}`
    : "Built-in starting design · not saved";
  $("#design-origin").textContent = origin;
}

function addPhase(kind) {
  const program = ensureDesignProgram();
  if (program.phases.length >= 8) {
    $("#design-status").textContent = "A workflow can contain at most eight executable phases.";
    return;
  }
  const stem = kind === "work" ? "work" : kind === "checkpoint" ? "checkpoint" : "verify";
  let id = stem;
  let counter = 2;
  const ids = new Set(program.phases.map((phase) => phase.id));
  while (ids.has(id)) id = `${stem}-${counter++}`;
  if (kind === "work") program.phases.push({ id, kind, name: "New work goal", goal: "Describe the complete outcome Codex should achieve in this turn.", reasoningEffort: "inherit" });
  if (kind === "checkpoint") program.phases.push({ id, kind, name: "Human checkpoint", question: "Continue to the next phase?" });
  if (kind === "verify") program.phases.push({ id, kind, name: "Verify result", criteria: "The requested outcome is complete and supported by relevant checks.", maxRepairs: 1 });
  adaptationMethod ||= "manual";
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
    $("#design-status").textContent = `Proposal ready. Review ${result.changedPhaseIds.length} changed phase(s); nothing has been saved or run.`;
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
    $("#design-status").textContent = `Saved ${saved.workflowId}. The task and repository were excluded.`;
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
  setView("run");
}

async function loadRuns() {
  const list = $("#runs-list");
  try {
    const result = await request("/api/runs");
    const runs = result.runs || [];
    list.innerHTML = runs.length ? runs.map((run) => `<button class="run-list-item ${run.runId === selectedRunId ? "active" : ""}" type="button" data-run-id="${escapeHtml(run.runId)}"><b>${escapeHtml(run.completionStatus || run.status)}</b><small>${run.phaseCount || 0} authored phases · ${run.turnCount || 0} controller turns</small><small>${escapeHtml(run.runId.slice(0, 13))}…</small></button>`).join("") : "<p>No recorded runs yet.</p>";
    $$("[data-run-id]", list).forEach((button) => button.addEventListener("click", () => void showRun(button.dataset.runId)));
  } catch (error) { list.innerHTML = `<p>Runs unavailable: ${escapeHtml(error.message)}</p>`; }
}

async function showRun(runId) {
  selectedRunId = runId;
  await loadRuns();
  const detail = $("#run-detail");
  detail.innerHTML = "<p>Loading receipt…</p>";
  try {
    const state = await request(`/api/runs/${encodeURIComponent(runId)}`);
    const result = state.result || {};
    const executions = result.phaseProgram?.executions || [];
    const timeline = result.timeline || state.timeline || [];
    const phaseCards = executions.map((execution, index) => {
      const activity = timeline.filter((item) => item.phase === execution.phaseId);
      const counts = activity.reduce((acc, item) => { acc[item.kind] = (acc[item.kind] || 0) + 1; return acc; }, {});
      const chips = Object.entries(counts).map(([kind, count]) => `<span>${escapeHtml(kind)} · ${count}</span>`).join("") || "<span>No projected activity</span>";
      return `<article class="receipt-phase"><header><div><small>${String(index + 1).padStart(2, "0")} · ${escapeHtml(execution.kind || "phase")}</small><b>${escapeHtml(execution.name || execution.phaseId)}</b></div><small>${escapeHtml(execution.status || "observed")}</small></header><div class="activity-chips">${chips}</div></article>`;
    }).join("");
    detail.innerHTML = `<header class="receipt-head"><div><p class="kicker">LOCAL RECEIPT</p><h2>${escapeHtml(result.completionStatus || state.status)}</h2><code>${escapeHtml(result.manifestHash || runId)}</code></div><div><b>${result.observed?.modelCompletions ?? "—"}</b><small> observed model completions</small></div></header>${phaseCards || "<p>This older run has no authored phase executions.</p>"}<pre class="receipt-output">${escapeHtml(result.finalResponse || state.error || "No final response.")}</pre>`;
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
  const grid = $("#field-trials-grid");
  try {
    const evidence = await request("/reusable-workflow-trials.json");
    const trials = evidence.trials || [];
    const accepted = trials.filter((item) => item.status === "accepted").length;
    const auth = evidence.authentication || {};
    $("#field-trials-summary").innerHTML = `<article><b>${trials.length}</b><small>saved workflow reuses</small></article><article><b>${accepted}</b><small>artifacts accepted</small></article><article><b>${trials.filter((item) => item.upstreamChecks === "passed").length}</b><small>repository checks passed</small></article><article><b>${evidence.sandboxCount || 0}</b><small>ChatGPT-authenticated sandbox</small></article>`;
    grid.innerHTML = trials.map((trial) => {
      const names = trial.phaseNames || trial.phaseIds || [];
      const kinds = trial.phaseKinds || [];
      const command = (trial.externalCommand || []).join(" ");
      const checkpoint = (trial.checkpoints || [])[0];
      return `<article class="trial-card"><header><div><p class="kicker">${escapeHtml(trial.workflowLabel)}</p><h2>${escapeHtml(trial.taskFamily)}</h2></div><span class="verdict">${escapeHtml(trial.status)}</span></header><div class="repo-route"><div><small>SAVED IN</small><b><a href="${escapeHtml(trial.sourceRepository || "#")}" target="_blank" rel="noreferrer">${escapeHtml(trial.sourceRepo)}</a></b></div><span>→</span><div><small>REUSED IN</small><b><a href="${escapeHtml(trial.targetRepository || "#")}" target="_blank" rel="noreferrer">${escapeHtml(trial.targetRepo)}</a></b></div></div><ol class="trial-program">${names.map((name, index) => `<li><small>${escapeHtml(kinds[index] || "phase")}</small><b>${escapeHtml(name)}</b></li>`).join("")}</ol><p class="adaptation-proof"><b>What changed:</b> ${trial.changedGoals || 0} human-readable goal fields. Phase IDs, order, kinds, reasoning settings, and repair bounds were preserved.</p><dl><dt>source design</dt><dd><code>${escapeHtml((trial.sourceProgramHash || "").slice(0, 20))}…</code></dd><dt>derived design</dt><dd><code>${escapeHtml((trial.derivedProgramHash || "").slice(0, 20))}…</code></dd><dt>observed execution</dt><dd>${trial.controllerTurns || 0} controller turns · ${trial.modelCompletions || 0} native completions</dd><dt>checkpoint</dt><dd>${escapeHtml(checkpoint ? `${checkpoint.phaseId}: ${checkpoint.decision}` : "not reached")}</dd><dt>target commit</dt><dd><code>${escapeHtml((trial.targetCommit || "").slice(0, 12))}</code></dd><dt>produced artifact</dt><dd>${escapeHtml((trial.changedFiles || []).join(", ") || "none")}</dd><dt>repository check</dt><dd><code>${escapeHtml(command)}</code> · exit 0${trial.externalElapsedSeconds == null ? "" : ` · ${trial.externalElapsedSeconds}s`}</dd><dt>verification</dt><dd>${escapeHtml(trial.verification || "not recorded")}</dd><dt>run receipt</dt><dd><code>${escapeHtml((trial.receiptId || "").slice(0, 20))}…</code></dd></dl></article>`;
    }).join("");
    const incidents = evidence.incidents || [];
    const incidentText = incidents.length ? `<p><b>Setup incidents retained:</b> ${incidents.map((item) => `${escapeHtml(item.incidentId)} (${escapeHtml(item.trialId || "unknown")})`).join("; ")}. They are excluded from the three accepted results.</p>` : "";
    $("#field-trials-limits").innerHTML = `<div class="auth-proof"><b>Actual external-user login</b><p>${escapeHtml(auth.loginStatus || "not recorded")} · Codex ${escapeHtml(auth.codexVersion || "unknown")} · API key injected: ${auth.apiKeyInjected === false ? "no" : "unknown"}</p><p>Raw evidence: ${escapeHtml(evidence.rawEvidenceAvailability || "not recorded")}</p></div>${incidentText}<b>Claim boundary</b><p>${escapeHtml(evidence.claimBoundary || "These are bounded product trials, not benchmark scores.")}</p>`;
  } catch (error) {
    grid.innerHTML = `<p>Trial evidence is not available yet: ${escapeHtml(error.message)}</p>`;
    $("#field-trials-summary").innerHTML = "<article><b>Pending</b><small>frozen evidence</small></article>";
  }
}

function setArchitectureLayer(enabled) {
  const card = $(".architecture-card");
  card.dataset.weave = enabled ? "on" : "off";
  $("#architecture-codex").classList.toggle("active", !enabled);
  $("#architecture-weave").classList.toggle("active", enabled);
  $("#architecture-caption").innerHTML = enabled ? "<b>Weave revealed:</b> a reusable workflow compiles fresh tasks into complete Codex turns, with human handoffs and a receipt." : "<b>Codex only:</b> one goal enters the native adaptive loop.";
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
  await loadWorkflows();

  $$("[data-view]").forEach((link) => link.addEventListener("click", (event) => { event.preventDefault(); setView(link.dataset.view); }));
  $$(".mode").forEach((button) => button.addEventListener("click", () => setMode(button.dataset.mode)));
  $$("[data-prompt]").forEach((button) => button.addEventListener("click", () => { $("#task-input").value = button.dataset.prompt; $("#design-task").value = button.dataset.prompt; $("#task-input").focus(); }));
  $("#workflow-select").addEventListener("change", updateWorkflowExplanation);
  $("#sandbox-select").addEventListener("change", updateSettingsSummary);
  $("#approval-select").addEventListener("change", updateSettingsSummary);
  $("#run-task").addEventListener("click", startRun);
  $("#continue-run").addEventListener("click", () => decide("accept"));
  $("#stop-run").addEventListener("click", () => decide("decline"));
  $("#save-workflow").addEventListener("click", saveWorkflow);
  $("#save-from-run").addEventListener("click", () => {
    $("#workflow-name").value = activeSavedWorkflow?.name || $("#workflow-select").selectedOptions[0].textContent;
    setView("workflows");
  });
  $("#refresh-workflows").addEventListener("click", loadWorkflows);
  $$("[data-add-phase]").forEach((button) => button.addEventListener("click", () => addPhase(button.dataset.addPhase)));
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
  setView(location.hash.slice(1) || "run", { updateHash: false });
}

function updateSettingsSummary() {
  $("#settings-summary").textContent = `${$("#sandbox-select").selectedOptions[0].textContent} · ${$("#approval-select").selectedOptions[0].textContent.toLowerCase()} protected actions`;
}

void init();
