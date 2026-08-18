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

function renderCodex() {
  if (!codexProjection) return;
  const groups = projectionGroups(codexProjection);
  $("#codex-map").classList.remove("empty");
  $("#codex-map").innerHTML = [
    nodeHtml({ kind: "INPUT", title: "User task", detail: "A native Codex thread receives the goal." }),
    nodeHtml({ kind: "ADAPTIVE LOOP", title: "Codex decides the path", detail: "Observed items are nested here—not promoted into a fake authored plan.", nested: groups.map((group) => `${group.title} · ${group.count}`) }, "adaptive"),
    nodeHtml({ kind: "OUTPUT", title: "Final task state", detail: "Conversation, files, and persisted thread items." }),
  ].join("");
  const counts = codexProjection.counts || {};
  $("#codex-metrics").innerHTML = metrics([["Turns", counts.turns ?? "—"], ["Tools", counts.toolCalls ?? "—"], ["Items", counts.items ?? counts.events ?? "—"]]);
  $("#codex-human").innerHTML = `<span class="active">Conversation steering</span><span>${Number(counts.approvals || 0)} observed approval${Number(counts.approvals || 0) === 1 ? "" : "s"}</span><span>No precompiled phase gates</span>`;
}

function weavePhases(receipt) {
  const executions = receipt?.phaseProgram?.executions || [];
  return executions.map((phase) => {
    const timeline = (receipt.timeline || []).filter((event) => event.phase === phase.phaseId);
    const tools = timeline.filter((event) => event.kind === "tool_call").length;
    const stageTitle = timeline.find((event) => event.kind === "stage" && event.title)?.title?.replace(/ started$| finished$|: verification$/gi, "");
    return { kind: String(phase.kind || "work").toUpperCase(), title: phase.name || stageTitle || (phase.kind === "verify" ? "Verify the result" : "Codex work goal"), detail: phase.kind === "checkpoint" ? "Human continue/stop decision." : `${tools} observed tool request${tools === 1 ? "" : "s"} inside this goal.`, type: phase.kind === "checkpoint" ? "human" : "weave" };
  });
}

function renderWeave() {
  if (!weaveReceipt) return;
  const phases = weavePhases(weaveReceipt);
  $("#weave-map").classList.remove("empty");
  $("#weave-map").innerHTML = [nodeHtml({ kind: "INPUT", title: "Compiled task contract", detail: `Memory ${weaveReceipt.memory?.mode || "off"} · ${weaveReceipt.controls?.sandbox || "sandbox unknown"}` }, "weave"), ...phases.map((phase) => nodeHtml(phase, phase.type)), nodeHtml({ kind: "OUTPUT", title: "Answer + evidence receipt", detail: "Authored phases and observed Codex activity stay correlated." }, "weave")].join("");
  const tools = (weaveReceipt.timeline || []).filter((event) => event.kind === "tool_call").length;
  $("#weave-metrics").innerHTML = metrics([["Phases", phases.length], ["Tools", tools], ["Turns", weaveReceipt.turnIds?.length ?? "—"]]);
  const checkpoints = phases.filter((phase) => phase.type === "human");
  $("#weave-human").innerHTML = `<span class="active">${checkpoints.length} authored checkpoint${checkpoints.length === 1 ? "" : "s"}</span><span>Native action approvals</span><span>Receipt-bound decisions</span>`;
}

function metrics(items) { return items.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join(""); }

function formatNumber(value) { return new Intl.NumberFormat("en-US").format(Number(value || 0)); }

function integrationEvidence(result) {
  const treatment = result.integrationTreatment;
  const observed = result.weave.observedIntegrationToolItems || [];
  if (observed.length) {
    const first = observed[0];
    return `Observed ${first.server || first.itemType} · ${first.tool || "tool completed"}`;
  }
  return treatment.kind === "skill"
    ? "Requested; Codex does not expose a skill-loaded event"
    : "Requested; no matching integration tool item observed";
}

function matchedTrialHtml(result) {
  const ordinary = result.ordinary;
  const weave = result.weave;
  const computeRatio = ordinary.modelCompletions
    ? (weave.modelCompletions / ordinary.modelCompletions).toFixed(1)
    : "—";
  return `<article class="trial-card">
    <header><div><span>${escapeHtml(result.domain)}</span><h3>${escapeHtml(result.title)}</h3></div><em>${ordinary.artifact.passed && weave.artifact.passed ? "Both artifacts accepted" : "Outcomes differed"}</em></header>
    <div class="trial-arms">
      <section><b>Ordinary Codex</b><strong>${ordinary.artifact.checksPassed}/${ordinary.artifact.checksTotal}</strong><p>1 adaptive controller turn</p><small>${ordinary.modelCompletions} model completions · ${formatNumber(ordinary.tokenUsage.inputTokens)} input tokens</small></section>
      <section class="weave-arm"><b>WeaveCodex</b><strong>${weave.artifact.checksPassed}/${weave.artifact.checksTotal}</strong><p>Inspect → produce → verify</p><small>${weave.modelCompletions} model completions · ${formatNumber(weave.tokenUsage.inputTokens)} input tokens</small></section>
    </div>
    <dl><div><dt>Integration request</dt><dd>${escapeHtml(result.integrationTreatment.label)} · ${escapeHtml(result.integrationTreatment.phaseIds.join(" + "))}</dd></div><div><dt>Observed evidence</dt><dd>${escapeHtml(integrationEvidence(result))}</dd></div><div><dt>Compute ratio</dt><dd>${escapeHtml(computeRatio)}× model completions for Weave</dd></div></dl>
  </article>`;
}

async function loadMatchedTrials() {
  const summary = $("#matched-summary");
  try {
    const data = await request("/matched-trials.json");
    const aggregate = data.aggregate || {};
    summary.innerHTML = `<div><b>${aggregate.ordinaryArtifactsPassed}/${aggregate.tasks}</b><span>ordinary artifacts accepted</span></div><div><b>${aggregate.weaveArtifactsPassed}/${aggregate.tasks}</b><span>Weave artifacts accepted</span></div><div><b>${aggregate.ordinaryModelCompletions}</b><span>ordinary model completions</span></div><div><b>${aggregate.weaveModelCompletions}</b><span>Weave model completions</span></div>`;
    $("#matched-trials").innerHTML = (data.results || []).map(matchedTrialHtml).join("");
  } catch (error) {
    summary.innerHTML = `<span>Matched evidence unavailable: ${escapeHtml(error.message)}</span>`;
  }
}

function ossTrialHtml(result) {
  const ordinary = result.ordinary;
  const weave = result.weave;
  const phases = (result.weaveProgram || []).map((phase) => `<span class="${escapeHtml(phase.kind)}">${escapeHtml(phase.name)}</span>`).join("");
  const checkpoints = weave.checkpoints || [];
  return `<article class="trial-card oss-card">
    <header><div><span>${escapeHtml(new URL(result.repository).pathname.replace(/^\//, ""))}</span><h3>${escapeHtml(result.title)}</h3></div><em>${ordinary.artifactAccepted && weave.artifactAccepted ? "Both repairs accepted" : "Outcomes differed"}</em></header>
    <div class="phase-strip" aria-label="Weave program">${phases}</div>
    <div class="trial-arms">
      <section><b>Ordinary Codex</b><strong>${ordinary.artifactAccepted ? "Accepted" : "Failed"}</strong><p>${ordinary.controllerTurns} controller turn · ${ordinary.modelCompletions} completions</p><small>${formatNumber(ordinary.tokenUsage.inputTokens)} input tokens · independent test ${ordinary.independentTest.exitCode === 0 ? "passed" : "failed"}</small></section>
      <section class="weave-arm"><b>WeaveCodex</b><strong>${weave.artifactAccepted ? "Accepted" : "Failed"}</strong><p>${weave.controllerTurns} controller turns · ${weave.modelCompletions} completions</p><small>${formatNumber(weave.tokenUsage.inputTokens)} input tokens · ${checkpoints.length} checkpoint${checkpoints.length === 1 ? "" : "s"}</small></section>
    </div>
    <dl><div><dt>Source</dt><dd>${escapeHtml(result.commit.slice(0, 12))} · declared seed ${escapeHtml(result.seedPatchSha256.slice(7, 19))}</dd></div><div><dt>Final diff</dt><dd>${ordinary.changedTrackedPaths.length || weave.changedTrackedPaths.length ? "Target-only changes" : "Both restored the exact upstream bytes"}</dd></div><div><dt>Verifier</dt><dd>${weave.verification?.[0]?.status === "pass" ? "Passed on first attempt" : "No first-pass verifier receipt"}</dd></div></dl>
  </article>`;
}

async function loadOssTrials() {
  const summary = $("#oss-summary");
  try {
    const data = await request("/oss-implementation-trials.json");
    const aggregate = data.aggregate || {};
    summary.innerHTML = `<div><b>${aggregate.ordinaryAccepted}/${aggregate.repositories}</b><span>ordinary repairs accepted</span></div><div><b>${aggregate.weaveAccepted}/${aggregate.repositories}</b><span>Weave repairs accepted</span></div><div><b>${aggregate.ordinaryModelCompletions}</b><span>ordinary model completions</span></div><div><b>${aggregate.weaveModelCompletions}</b><span>Weave model completions</span></div>`;
    $("#oss-trials").innerHTML = (data.results || []).map(ossTrialHtml).join("");
  } catch (error) {
    summary.innerHTML = `<span>OSS evidence unavailable: ${escapeHtml(error.message)}</span>`;
  }
}

function renderMatrix() {
  const codex = codexProjection;
  const weave = weaveReceipt;
  const checkpointCount = weavePhases(weave).filter((phase) => phase.type === "human").length;
  const rows = [
    ["Workflow shape", "Adaptive inside the Codex task", `${weave?.phaseProgram?.executions?.length || 0} authored execution steps`],
    ["Human coordination", "Conversation + observed native approvals", `${checkpointCount} explicit between-phase checkpoint${checkpointCount === 1 ? "" : "s"} + native approvals`],
    ["Memory", "Codex thread configuration", weave ? `Receipt says ${weave.memory?.mode || "off"}` : "—"],
    ["Visualization basis", codex ? "Deterministic projection of persisted items" : "—", weave ? "Exact phase receipt + observed events" : "—"],
    ["Answer quality", "Not scored here", "Not scored here"],
  ];
  $("#comparison-matrix").innerHTML = `<div class="matrix-row header"><b>Dimension</b><b>Codex only</b><b>Weave + Codex</b></div>${rows.map((row) => `<div class="matrix-row"><b>${escapeHtml(row[0])}</b><span>${escapeHtml(row[1])}</span><span>${escapeHtml(row[2])}</span></div>`).join("")}`;
}

async function selectCodex(threadId) {
  if (!threadId) return;
  $("#comparison-status").textContent = "Projecting the selected Codex task without a model call…";
  codexProjection = await request("/api/thread-projection", { method: "POST", body: JSON.stringify({ cwd, threadId }) });
  $("#codex-title").textContent = $("#codex-select").selectedOptions[0]?.textContent || "Codex task";
  renderCodex(); renderMatrix();
  $("#comparison-status").textContent = "Both maps are local evidence views. Codex groups are derived; Weave phases are exact when a receipt is selected.";
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
    await Promise.all([loadOssTrials(), loadMatchedTrials()]);
    const session = await request("/api/session"); csrfToken = session.csrfToken; cwd = session.workspaceRoot;
    const [runs, threads] = await Promise.all([request("/api/runs"), request(`/api/threads?cwd=${encodeURIComponent(cwd)}`)]);
    $("#weave-select").innerHTML = `<option value="">Choose a Weave run</option>${(runs.runs || []).map((run) => `<option value="${escapeHtml(run.runId)}">${escapeHtml(`${run.phaseCount || 0} phases · ${run.turnCount || 0} turns · ${run.runId.slice(0, 8)}`)}</option>`).join("")}`;
    $("#codex-select").innerHTML = `<option value="">Choose a Codex task</option>${(threads.threads || []).map((thread, index) => `<option value="${escapeHtml(thread.id)}">${escapeHtml(threadLabel(thread, index))}</option>`).join("")}`;
    const params = new URLSearchParams(location.search);
    const left = params.get("leftThread"); const right = params.get("rightRun");
    if (left && [...$("#codex-select").options].some((option) => option.value === left)) { $("#codex-select").value = left; await selectCodex(left); }
    if (right && [...$("#weave-select").options].some((option) => option.value === right)) { $("#weave-select").value = right; await selectWeave(right); }
    $("#comparison-status").textContent = "Choose one source on each side. Loading and visualization do not call a model.";
  } catch (error) { $("#comparison-status").textContent = `Comparison unavailable: ${error.message}`; }
  $("#codex-select").addEventListener("change", (event) => selectCodex(event.target.value).catch((error) => $("#comparison-status").textContent = error.message));
  $("#weave-select").addEventListener("change", (event) => selectWeave(event.target.value).catch((error) => $("#comparison-status").textContent = error.message));
}

init();
