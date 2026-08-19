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
  if (activeSavedWorkflow) return activeSavedWorkflow.phaseProgram;
  const workflow = runMode === "ordinary" ? "ordinary" : $("#workflow-select").value;
  return { projectionVersion: 1, phases: phaseProgram(workflow) };
}

function manifest() {
  return {
    schemaVersion: 2,
    name: runMode === "ordinary" ? "Codex direct" : (activeSavedWorkflow?.name || `Weave ${$("#workflow-select").value}`),
    cwd: $("#workspace-input").value.trim(),
    task: { instructions: $("#task-input").value.trim(), contextPaths: [] },
    memory: { mode: "off", selectedThreadIds: [] },
    integrations: { inventoryId: null, requested: [] },
    agent: { model: null, reasoningEffort: "medium", sandbox: $("#sandbox-select").value, approvalGate: $("#approval-select").value },
    verification: { enabled: false, criteria: "Phase program owns verification.", maxRetries: 0 },
    output: { format: "text" },
    observability: { traceRoot: ".weave-codex/traces" },
    phaseProgram: selectedProgram(),
  };
}

function setView(view, { updateHash = true } = {}) {
  const allowed = new Set(["run", "workflows", "architecture", "setup"]);
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
  const copy = {
    review: "Pause after inspection so you can approve the direction before files change.",
    audit: "Require an architectural risk map before implementation, then challenge the result.",
    direct: "Keep the workflow short while retaining a separate verification and repair bound.",
  };
  $("#workflow-explanation").textContent = copy[$("#workflow-select").value];
  renderWorkflowPreview();
}

function applyWorkflow(workflow) {
  activeSavedWorkflow = workflow;
  $("#workflow-select").value = "saved";
  $("#workflow-select").selectedOptions[0].textContent = workflow.name;
  $("#workflow-explanation").textContent = "Loaded from your local library. The new task and repository are not inherited.";
  setMode("weave");
  $("#task-input").value = "";
  setView("run");
  $("#task-input").focus();
}

function workflowCard(workflow) {
  const created = new Date(workflow.createdAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  return `<article class="saved-workflow"><header><div><small>IMMUTABLE · ${escapeHtml(created)}</small><h3>${escapeHtml(workflow.name)}</h3></div><code>${escapeHtml(workflow.programHash.slice(7, 19))}</code></header><p>${escapeHtml(workflow.description || "No description.")}</p><div class="mini-program">${programNodes(workflow.phaseProgram, { compact: true })}</div><footer><span>${workflow.phaseProgram.phases.length} phases · task excluded</span><button type="button" data-use-workflow="${escapeHtml(workflow.workflowId)}">Use on a new task →</button></footer></article>`;
}

function bindWorkflowUseButtons() {
  $$('[data-use-workflow]').forEach((button) => button.addEventListener("click", () => {
    const workflow = savedWorkflows.find((item) => item.workflowId === button.dataset.useWorkflow);
    if (workflow) applyWorkflow(workflow);
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
  await checkAccount();
  renderWorkflowPreview();
  await loadWorkflows();

  $$("[data-view]").forEach((link) => link.addEventListener("click", (event) => { event.preventDefault(); setView(link.dataset.view); }));
  $$(".mode").forEach((button) => button.addEventListener("click", () => setMode(button.dataset.mode)));
  $$("[data-prompt]").forEach((button) => button.addEventListener("click", () => { $("#task-input").value = button.dataset.prompt; $("#task-input").focus(); }));
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
