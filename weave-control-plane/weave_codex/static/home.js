const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);

let securitySession = null;
let runMode = "ordinary";
let activeRun = null;
let pollTimer = null;

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

function manifest() {
  const task = $("#task-input").value.trim();
  const workflow = runMode === "ordinary" ? "ordinary" : $("#workflow-select").value;
  return {
    schemaVersion: 2,
    name: runMode === "ordinary" ? "Codex direct" : `Weave ${workflow}`,
    cwd: $("#workspace-input").value.trim(),
    task: { instructions: task, contextPaths: [] },
    memory: { mode: "off", selectedThreadIds: [] },
    integrations: { inventoryId: null, requested: [] },
    agent: { model: null, reasoningEffort: "medium", sandbox: $("#sandbox-select").value, approvalGate: $("#approval-select").value },
    verification: { enabled: false, criteria: "Phase program owns verification.", maxRetries: 0 },
    output: { format: "text" },
    observability: { traceRoot: ".weave-codex/traces" },
    phaseProgram: { projectionVersion: 1, phases: phaseProgram(workflow) },
  };
}

function setMode(mode) {
  runMode = mode;
  $$(".mode").forEach((button) => {
    const active = button.dataset.mode === mode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-checked", String(active));
  });
  $("#workflow-choice").classList.toggle("hidden", mode !== "weave");
}

function updateWorkflowExplanation() {
  const copy = {
    review: "Pause after inspection so you can approve the direction before files change.",
    audit: "Require an architectural risk map before implementation, then challenge the result.",
    direct: "Keep the workflow short while retaining a separate verification and repair bound.",
  };
  $("#workflow-explanation").textContent = copy[$("#workflow-select").value];
}

function renderSteps(phases, state = {}) {
  const activePhase = state.pendingApproval?.params?.phaseId || state.result?.phaseProgram?.activePhaseId || "";
  const executions = state.result?.phaseProgram?.executions || [];
  const completed = new Set(executions.filter((item) => item.status === "completed").map((item) => item.phaseId));
  $("#run-steps").innerHTML = phases.map((phase, index) => `<article class="${completed.has(phase.id) ? "done" : activePhase === phase.id ? "active" : ""}"><small>${String(index + 1).padStart(2, "0")} · ${escapeHtml(phase.kind)}</small><b>${escapeHtml(phase.name)}</b></article>`).join("");
}

function errorMessage(error) { return String(error?.message || error || "Unknown error"); }

async function startRun() {
  clearTimeout(pollTimer);
  const task = $("#task-input").value.trim();
  const cwd = $("#workspace-input").value.trim();
  if (task.length < 4) { $("#task-input").focus(); return; }
  if (!cwd.startsWith("/")) { $("#workspace-input").focus(); return; }
  const button = $("#run-task");
  button.disabled = true;
  button.textContent = "Checking run…";
  try {
    const value = manifest();
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
    $("#run-output").textContent = errorMessage(error);
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
      $("#approval-detail").textContent = checkpoint ? (state.pendingApproval.params?.question || "Continue this run?") : "Review this request in the full Studio run explorer before allowing it.";
      $("#approval-card").classList.remove("hidden");
    } else {
      $("#approval-card").classList.add("hidden");
    }
    if (["completed", "failed"].includes(state.status)) {
      const result = state.result || {};
      $("#run-output").textContent = result.finalResponse || state.error || "Run ended without a final response.";
      $("#run-output").classList.remove("hidden");
      $("#run-note").textContent = result.manifestHash ? `Receipt bound to ${result.manifestHash.slice(0, 22)}…` : "The run receipt stays on this machine.";
      const button = $("#run-task");
      button.disabled = false;
      button.innerHTML = "Run another task <span>→</span>";
      return;
    }
    pollTimer = setTimeout(() => pollRun(phases), 700);
  } catch (error) {
    $("#run-output").textContent = errorMessage(error);
    $("#run-output").classList.remove("hidden");
    $("#run-task").disabled = false;
  }
}

async function decide(decision) {
  if (!activeRun) return;
  await request(`/api/runs/${encodeURIComponent(activeRun)}/approval`, { method: "POST", body: JSON.stringify({ decision }) });
  $("#approval-card").classList.add("hidden");
}

function evidenceCard(result) {
  const grade = result.grade || {};
  const receipt = result.receipt || {};
  const commands = Number(receipt.completedItemsByType?.commandExecution || 0);
  return `<article class="evidence-card"><header><span>${grade.passed ? "ARTIFACT ACCEPTED" : "REVIEW"}</span><em>${escapeHtml(String(result.commit || "").slice(0, 12))}</em></header><h3>${escapeHtml(result.title)}</h3><p>${escapeHtml(result.question)}</p><dl><div><dt>Goal phases</dt><dd>${escapeHtml(receipt.controllerTurns)}</dd></div><div><dt>Codex completions</dt><dd>${escapeHtml(receipt.modelCompletions)}</dd></div><div><dt>Commands</dt><dd>${commands}</dd></div></dl></article>`;
}

function ossEvidenceCard(result) {
  const ordinary = result.ordinary || {};
  const weave = result.weave || {};
  return `<article class="evidence-card"><header><span>${ordinary.artifactAccepted && weave.artifactAccepted ? "BOTH REPAIRS ACCEPTED" : "OUTCOMES DIFFERED"}</span><em>${escapeHtml(String(result.commit || "").slice(0, 12))}</em></header><h3>${escapeHtml(result.title)}</h3><p>${escapeHtml((result.weaveProgram || []).map((phase) => phase.name).join(" → "))}</p><dl><div><dt>Ordinary</dt><dd>${escapeHtml(ordinary.modelCompletions)} completions</dd></div><div><dt>Weave</dt><dd>${escapeHtml(weave.modelCompletions)} completions</dd></div><div><dt>Checkpoint</dt><dd>${escapeHtml((weave.checkpoints || []).length)}</dd></div></dl></article>`;
}

async function init() {
  try {
    securitySession = await request("/api/session");
    $("#workspace-input").value = securitySession.workspaceRoot || "";
    const account = await request("/api/account");
    $("#account-state").textContent = account.canRun ? (account.message || "Codex is ready") : (account.message || "Codex needs sign-in");
    $(".live-dot").classList.toggle("connected", account.canRun === true);
  } catch (error) {
    $("#account-state").textContent = "Local Codex is not connected";
  }
  try {
    const evidence = await request("/oss-implementation-trials.json");
    $("#evidence-cards").innerHTML = (evidence.results || []).map(ossEvidenceCard).join("");
  } catch (error) {
    try {
      const fallback = await request("/sandbox-trials.json");
      $("#evidence-cards").innerHTML = (fallback.results || []).map(evidenceCard).join("");
    } catch (_) {
      $("#evidence-cards").innerHTML = `<p>Preserved trials are unavailable: ${escapeHtml(errorMessage(error))}</p>`;
    }
  }
  $$(".mode").forEach((button) => button.addEventListener("click", () => setMode(button.dataset.mode)));
  $$("[data-prompt]").forEach((button) => button.addEventListener("click", () => { $("#task-input").value = button.dataset.prompt; $("#task-input").focus(); }));
  $("#workflow-select").addEventListener("change", updateWorkflowExplanation);
  $("#sandbox-select").addEventListener("change", () => { $("#settings-summary").textContent = `${$("#sandbox-select").selectedOptions[0].textContent} · ${$("#approval-select").selectedOptions[0].textContent.toLowerCase()} protected actions`; });
  $("#approval-select").addEventListener("change", () => { $("#settings-summary").textContent = `${$("#sandbox-select").selectedOptions[0].textContent} · ${$("#approval-select").selectedOptions[0].textContent.toLowerCase()} protected actions`; });
  $("#run-task").addEventListener("click", startRun);
  $("#continue-run").addEventListener("click", () => decide("accept"));
  $("#stop-run").addEventListener("click", () => decide("decline"));
}

init();
