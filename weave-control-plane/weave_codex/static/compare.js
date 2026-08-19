const $ = (selector, root = document) => root.querySelector(selector);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
let csrfToken = "";
let cwd = "";
let codexProjection = null;
let weaveReceipt = null;

async function request(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { ...(options.headers || {}), ...(options.method && options.method !== "GET" ? { "Content-Type": "application/json", "X-Weave-CSRF": csrfToken } : {}) } });
  const data = await response.json();
  if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : `HTTP ${response.status}`);
  return data;
}

function threadLabel(thread, index) {
  const text = String(thread.name || thread.preview || `Codex task ${index + 1}`).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return text.length > 75 ? `${text.slice(0, 72)}…` : text;
}

function nodeHtml({ kind, title, detail, nested = [] }, type = "") {
  return `<div class="map-node ${escapeHtml(type)}"><small>${escapeHtml(kind)}</small><b>${escapeHtml(title)}</b><span>${escapeHtml(detail || "")}</span>${nested.length ? `<div class="nested">${nested.map((item) => `<i>${escapeHtml(item)}</i>`).join("")}</div>` : ""}</div>`;
}

function projectionGroups(projection) {
  const definitions = [
    ["Orient", ["task", "setup", "memory"]], ["Understand", ["explore", "plan"]], ["Act", ["execute", "integrate", "change"]], ["Check", ["verify", "repair", "approval"]], ["Communicate", ["model", "deliver"]],
  ];
  const nodes = projection?.graph?.nodes || [];
  return definitions.map(([title, kinds]) => ({ title, count: nodes.filter((node) => kinds.includes(node.kind)).reduce((total, node) => total + Number(node.counts?.items || node.itemIds?.length || 1), 0) })).filter((item) => item.count > 0);
}

function weavePhases(receipt) {
  const executions = receipt?.phaseProgram?.executions || [];
  return executions.map((phase) => {
    const timeline = (receipt.timeline || []).filter((event) => event.phase === phase.phaseId);
    const stageTitle = timeline.find((event) => event.kind === "stage" && event.title)?.title?.replace(/ started$| finished$|: verification$/gi, "");
    const detail = phase.kind === "checkpoint"
      ? "A recorded human continue/stop decision."
      : "One native Codex turn; its internal tools remain adaptive.";
    return { kind: String(phase.kind || "work").toUpperCase(), title: phase.name || stageTitle || (phase.kind === "verify" ? "Verify the result" : "Codex work goal"), detail, type: phase.kind === "checkpoint" ? "human" : phase.kind === "verify" ? "verify" : "weave" };
  });
}

function metrics(items) {
  return items.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("");
}

function renderCodex() {
  if (!codexProjection) return;
  const groups = projectionGroups(codexProjection);
  const approvals = Number(codexProjection.counts?.approvals || 0);
  $("#codex-map").classList.remove("empty");
  $("#codex-map").innerHTML = [
    nodeHtml({ kind: "INPUT", title: "User task", detail: "One native Codex task receives the outcome." }),
    nodeHtml({ kind: "ADAPTIVE LOOP", title: "Codex chooses the tactics", detail: "Persisted items are grouped below—not promoted into an authored plan.", nested: groups.map((group) => `${group.title} · ${group.count}`) }, "adaptive"),
    nodeHtml({ kind: "OUTPUT", title: "Files + answer", detail: "The task and durable items form the evidence boundary." }),
  ].join("");
  $("#codex-metrics").innerHTML = metrics([["Workflow", "Implicit"], ["Between-goal gates", "None"], ["Evidence map", "Derived"]]);
  $("#codex-human").innerHTML = `<span class="active">Conversation steering</span><span>${approvals} observed native approval${approvals === 1 ? "" : "s"}</span>`;
}

function renderWeave() {
  if (!weaveReceipt) return;
  const phases = weavePhases(weaveReceipt);
  const checkpoints = phases.filter((phase) => phase.type === "human");
  const verifiers = phases.filter((phase) => phase.type === "verify");
  $("#weave-map").classList.remove("empty");
  $("#weave-map").innerHTML = [
    nodeHtml({ kind: "INPUT", title: "Compiled task contract", detail: `Memory ${weaveReceipt.memory?.mode || "off"} · ${weaveReceipt.controls?.sandbox || "sandbox unknown"}` }, "weave"),
    ...phases.map((phase) => nodeHtml(phase, phase.type)),
    nodeHtml({ kind: "OUTPUT", title: "Answer + receipt", detail: "Authored intent and observed Codex activity stay correlated." }, "weave"),
  ].join("");
  $("#weave-metrics").innerHTML = metrics([["Authored goals", phases.length], ["Human gates", checkpoints.length], ["Verify stages", verifiers.length]]);
  $("#weave-human").innerHTML = `<span class="active">${checkpoints.length} authored checkpoint${checkpoints.length === 1 ? "" : "s"}</span><span>Native action approvals remain</span><span>Decisions in receipt</span>`;
}

function humanDecision(result) {
  const checkpoints = result.weave?.checkpoints || [];
  if (!checkpoints.length) return "No between-goal checkpoint was authored for this program.";
  return checkpoints.map((checkpoint) => `${checkpoint.phaseId}: ${checkpoint.decision}`).join(" · ");
}

function ossTrialHtml(result, index) {
  const ordinary = result.ordinary;
  const weave = result.weave;
  const phases = (result.weaveProgram || []).map((phase) => `<div class="${escapeHtml(phase.kind)}"><small>${escapeHtml(phase.kind === "checkpoint" ? "HUMAN" : phase.kind.toUpperCase())}</small><b>${escapeHtml(phase.name)}</b></div>`).join("<i>→</i>");
  const proof = weave.verification?.[0]?.status === "pass" ? "Phase verifier passed on its first attempt." : "No passing phase-verifier receipt was preserved.";
  const finalState = ordinary.independentTest?.exitCode === 0 && weave.independentTest?.exitCode === 0 ? "Both external tests passed" : "Outcomes differed";
  return `<article class="trial-card">
    <header><div><span>0${index + 1} · ${escapeHtml(new URL(result.repository).pathname.replace(/^\//, ""))}</span><h3>${escapeHtml(result.title)}</h3></div><em>${escapeHtml(finalState)}</em></header>
    <div class="arm-row"><div><small>ORDINARY CODEX</small><b>One adaptive task</b><p>Codex chose the investigation, edit, and test sequence.</p></div><i>versus</i><div class="program"><small>WEAVE + CODEX</small><b>Human-authored outer workflow</b><div class="program-line">${phases}</div></div></div>
    <dl><div><dt>Human coordination</dt><dd>${escapeHtml(humanDecision(result))}</dd></div><div><dt>Evidence retained</dt><dd>${escapeHtml(proof)} Final source matched the accepted repair state.</dd></div><div><dt>What this proves</dt><dd>The declared workflow executed around native Codex and remained auditable; it does not prove a better repair.</dd></div></dl>
  </article>`;
}

async function loadOssTrials() {
  const summary = $("#oss-summary");
  try {
    const data = await request("/oss-implementation-trials.json");
    const results = data.results || [];
    const checkpoints = results.reduce((total, result) => total + (result.weave?.checkpoints || []).length, 0);
    const verifiers = results.filter((result) => result.weave?.verification?.[0]?.status === "pass").length;
    const bothAccepted = results.filter((result) => result.ordinary?.artifactAccepted && result.weave?.artifactAccepted).length;
    summary.innerHTML = `<div><b>${bothAccepted}/${results.length}</b><span>matched artifacts accepted on both sides</span></div><div><b>${checkpoints}</b><span>human checkpoints actually reached</span></div><div><b>${verifiers}/${results.length}</b><span>phase-verifier receipts passed</span></div>`;
    $("#oss-trials").innerHTML = results.map(ossTrialHtml).join("");
  } catch (error) {
    summary.innerHTML = `<span>Frozen evidence unavailable: ${escapeHtml(error.message)}</span>`;
  }
}

function renderMatrix() {
  const checkpointCount = weavePhases(weaveReceipt).filter((phase) => phase.type === "human").length;
  const rows = [
    ["Workflow definition", "Adaptive task; no separate phase program", weaveReceipt ? `${weaveReceipt.phaseProgram?.executions?.length || 0} authored execution steps` : "—"],
    ["Human coordination", "Conversation steering + native action approvals", weaveReceipt ? `${checkpointCount} explicit between-goal checkpoint${checkpointCount === 1 ? "" : "s"}` : "—"],
    ["Memory declaration", "Codex thread configuration", weaveReceipt ? `Receipt says ${weaveReceipt.memory?.mode || "off"}` : "—"],
    ["Visualization basis", codexProjection ? "Deterministic projection of persisted items" : "—", weaveReceipt ? "Exact phase receipt + observed items" : "—"],
    ["Quality claim", "Not scored by this picker", "Not scored by this picker"],
  ];
  $("#comparison-matrix").innerHTML = `<div class="matrix-row header"><b>Dimension</b><b>Codex only</b><b>Weave + Codex</b></div>${rows.map((row) => `<div class="matrix-row"><b>${escapeHtml(row[0])}</b><span>${escapeHtml(row[1])}</span><span>${escapeHtml(row[2])}</span></div>`).join("")}`;
}

async function selectCodex(threadId) {
  if (!threadId) return;
  $("#comparison-status").textContent = "Projecting the selected task locally…";
  codexProjection = await request("/api/thread-projection", { method: "POST", body: JSON.stringify({ cwd, threadId }) });
  $("#codex-title").textContent = $("#codex-select").selectedOptions[0]?.textContent || "Codex task";
  renderCodex(); renderMatrix();
  $("#comparison-status").textContent = "Codex groups are derived; Weave phases are exact when a receipt is selected.";
}

async function selectWeave(runId) {
  if (!runId) return;
  const state = await request(`/api/runs/${encodeURIComponent(runId)}`);
  weaveReceipt = state.result;
  $("#weave-title").textContent = weaveReceipt?.phaseProgram?.name || weaveReceipt?.name || "Weave run";
  renderWeave(); renderMatrix();
}

async function init() {
  try {
    await loadOssTrials();
    const session = await request("/api/session"); csrfToken = session.csrfToken; cwd = session.workspaceRoot;
    const [runs, threads] = await Promise.all([request("/api/runs"), request(`/api/threads?cwd=${encodeURIComponent(cwd)}`)]);
    $("#weave-select").innerHTML = `<option value="">Choose a Weave receipt</option>${(runs.runs || []).map((run) => `<option value="${escapeHtml(run.runId)}">${escapeHtml(`${run.phaseCount || 0} authored phases · ${run.runId.slice(0, 8)}`)}</option>`).join("")}`;
    $("#codex-select").innerHTML = `<option value="">Choose a Codex task</option>${(threads.threads || []).map((thread, index) => `<option value="${escapeHtml(thread.id)}">${escapeHtml(threadLabel(thread, index))}</option>`).join("")}`;
    const params = new URLSearchParams(location.search);
    const left = params.get("leftThread"); const right = params.get("rightRun");
    if (left && [...$("#codex-select").options].some((option) => option.value === left)) { $("#codex-select").value = left; await selectCodex(left); }
    if (right && [...$("#weave-select").options].some((option) => option.value === right)) { $("#weave-select").value = right; await selectWeave(right); }
    $("#comparison-status").textContent = "Choose one source on each side. Visualization does not call a model.";
  } catch (error) {
    $("#comparison-status").textContent = `Comparison unavailable: ${error.message}`;
  }
  $("#codex-select").addEventListener("change", (event) => selectCodex(event.target.value).catch((error) => { $("#comparison-status").textContent = error.message; }));
  $("#weave-select").addEventListener("change", (event) => selectWeave(event.target.value).catch((error) => { $("#comparison-status").textContent = error.message; }));
}

init();
