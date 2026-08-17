const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
let compiled = null;
let activeRun = null;
let pollTimer = null;
let compileVersion = 0;
let selectedBlock = null;
const h = (text) =>
  String(text).replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );

function value(id) {
  return $(id).value.trim();
}
function memoryMode() {
  return $('input[name="memory"]:checked').value;
}
function selectedThreads() {
  return $$("#thread-list input:checked").map((item) => item.value);
}

function manifestFromForm() {
  return {
    schemaVersion: 1,
    name: "Codex visual harness",
    cwd: value("#cwd"),
    task: {
      instructions: value("#task"),
      contextPaths: value("#context")
        .split("\n")
        .map((item) => item.trim())
        .filter(Boolean),
    },
    memory: {
      mode: memoryMode(),
      selectedThreadIds: memoryMode() === "selected" ? selectedThreads() : [],
    },
    agent: {
      model: value("#model") || null,
      reasoningEffort: value("#effort"),
      sandbox: value("#sandbox"),
      approvalGate: value("#approval"),
    },
    verification: {
      enabled: $("#verify").checked,
      criteria: value("#criteria"),
      maxRetries: Number(value("#retries")),
    },
    output: { format: "text" },
    observability: { traceRoot: ".weave-codex/traces" },
  };
}

function syncJson() {
  $("#manifest-json").value = JSON.stringify(manifestFromForm(), null, 2);
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(
      typeof data.error === "string" ? data.error : JSON.stringify(data.error),
    );
  return data;
}

function renderCompile(result) {
  compiled = result;
  $("#graph").innerHTML = result.nodes
    .map(
      (node) =>
        `<button type="button" class="node" data-kind="${h(node.kind)}" data-state="${h(node.state || "active")}"><i>${h(node.kind)}</i><b>${h(node.label)}</b><small>${h(node.detail)}</small></button>`,
    )
    .join("");
  $("#actions").innerHTML = result.actions
    .map((action) => `<li>${h(action)}</li>`)
    .join("");
  $("#turn-bound").textContent = result.maximumTurns;
  $("#valid-state").textContent =
    `Valid · ${result.manifestHash.slice(0, 18)}…`;
  $("#valid-state").style.color = "var(--green)";
  bindGraphBlocks(result.nodes);
}

function draftNodes(manifest) {
  const selectedCount = manifest.memory.selectedThreadIds.length;
  const memory = {
    off: { detail: "Off", state: "bypassed" },
    all: { detail: "All prior Codex threads", state: "active" },
    selected: {
      detail: selectedCount
        ? `Selected · ${selectedCount} thread${selectedCount === 1 ? "" : "s"}`
        : "Selected · choose threads",
      state: selectedCount ? "active" : "invalid",
    },
  }[manifest.memory.mode];
  const verificationEnabled = manifest.verification.enabled;

  return [
    { kind: "task", label: "Task", detail: "Instructions + context" },
    { kind: "memory", label: "Memory", ...memory },
    {
      kind: "safety",
      label: "Safety",
      detail: `${manifest.agent.sandbox} · ${manifest.agent.approvalGate}`,
    },
    {
      kind: "agent",
      label: "Agent loop",
      detail: manifest.agent.model || "Codex default model",
    },
    {
      kind: "verify",
      label: "Verify",
      detail: verificationEnabled ? "Structured verdict" : "Off",
      state: verificationEnabled ? "active" : "bypassed",
    },
    {
      kind: "repair",
      label: "Repair",
      detail: manifest.verification.maxRetries
        ? `Up to ${manifest.verification.maxRetries}`
        : "No retries",
      state:
        verificationEnabled && manifest.verification.maxRetries
          ? "active"
          : "bypassed",
    },
    { kind: "output", label: "Output", detail: manifest.output.format },
  ];
}

function renderDraft(manifest, status, action) {
  compiled = null;
  $("#graph").innerHTML = draftNodes(manifest)
    .map(
      (node) =>
        `<button type="button" class="node" data-kind="${h(node.kind)}" data-state="${h(node.state || "active")}"><i>${h(node.kind)}</i><b>${h(node.label)}</b><small>${h(node.detail)}</small></button>`,
    )
    .join("");
  $("#actions").innerHTML = `<li>${h(action)}</li>`;
  $("#turn-bound").textContent = "—";
  $("#valid-state").textContent = status;
  $("#valid-state").style.color = "var(--accent)";
  bindGraphBlocks(draftNodes(manifest));
}

const BLOCK_EDITORS = {
  task: { target: "#task-control", control: "#task", title: "Task", copy: "Edit the instructions and context paths Codex receives." },
  memory: { target: "#memory-control", control: "#memory-mode", title: "Memory", copy: "Choose no prior traces, Codex native memory, or exact selected thread excerpts." },
  safety: { target: "#policy-control", control: "#sandbox", title: "Safety", copy: "Set the sandbox and whether protected actions need your approval." },
  agent: { target: "#policy-control", control: "#effort", title: "Agent loop", copy: "Choose the model and reasoning effort. Native Codex tools stay inside this block." },
  verify: { target: "#policy-control", control: "#verify", title: "Verifier", copy: "Turn the later structured verification turn on or off and edit its criterion." },
  repair: { target: "#policy-control", control: "#retries", title: "Repair", copy: "Choose how many bounded verifier/repair turns may follow the solver." },
  output: { target: ".manifest-panel", control: "#manifest-json", title: "Output", copy: "The final response and receipt leave the harness here. Output is text in this release." },
};

function bindGraphBlocks(nodes) {
  $$("#graph .node").forEach((button) => {
    button.classList.toggle("selected", button.dataset.kind === selectedBlock);
    button.addEventListener("click", () => selectGraphBlock(button.dataset.kind, nodes.find((node) => node.kind === button.dataset.kind)));
  });
}

function selectGraphBlock(kind, node) {
  selectedBlock = kind;
  $$("#graph .node").forEach((button) => button.classList.toggle("selected", button.dataset.kind === kind));
  const editor = BLOCK_EDITORS[kind] || BLOCK_EDITORS.output;
  $("#block-inspector").innerHTML = `<div><span>${h(kind.toUpperCase())} BLOCK</span><h3>${h(editor.title)}</h3><p>${h(editor.copy)}</p><dl><div><dt>Compiled state</dt><dd>${h(node?.state || "active")}</dd></div><div><dt>Current setting</dt><dd>${h(node?.detail || "See manifest")}</dd></div></dl><button type="button" id="edit-selected-block">Edit this block</button></div>`;
  $("#edit-selected-block").addEventListener("click", () => focusBlockEditor(editor));
}

function focusBlockEditor(editor) {
  const target = $(editor.target);
  const control = $(editor.control);
  target?.scrollIntoView({ behavior: "smooth", block: "center" });
  target?.classList.add("editing-highlight");
  setTimeout(() => target?.classList.remove("editing-highlight"), 1800);
  setTimeout(() => control?.focus(), 420);
}

async function compile() {
  syncJson();
  const manifest = manifestFromForm();
  const version = ++compileVersion;
  renderDraft(manifest, "Checking…", "Validating this harness manifest…");
  try {
    const result = await request("/api/compile", {
      method: "POST",
      body: $("#manifest-json").value,
    });
    if (version !== compileVersion) return false;
    renderCompile(result);
    return true;
  } catch (error) {
    if (version !== compileVersion) return false;
    const selectedMemoryIsEmpty =
      manifest.memory.mode === "selected" &&
      manifest.memory.selectedThreadIds.length === 0;
    renderDraft(
      manifest,
      selectedMemoryIsEmpty
        ? "Invalid · Select at least one exact thread ID."
        : `Invalid · ${error.message}`,
      selectedMemoryIsEmpty
        ? "Select at least one exact thread ID to compile this plan."
        : "Fix the manifest error before compiling or running.",
    );
    return false;
  }
}

function applyManifest(manifest) {
  $("#task").value = manifest.task.instructions;
  $("#cwd").value = manifest.cwd;
  $("#model").value = manifest.agent.model || "";
  $("#context").value = (manifest.task.contextPaths || []).join("\n");
  $(`input[name="memory"][value="${manifest.memory.mode}"]`).checked = true;
  $("#sandbox").value = manifest.agent.sandbox;
  $("#approval").value = manifest.agent.approvalGate;
  $("#effort").value = manifest.agent.reasoningEffort;
  $("#verify").checked = manifest.verification.enabled;
  $("#retries").value = manifest.verification.maxRetries;
  $("#criteria").value = manifest.verification.criteria;
  if (manifest.memory.mode === "selected") {
    $("#thread-list").innerHTML = manifest.memory.selectedThreadIds
      .map(
        (id) =>
          `<label><input type="checkbox" value="${h(id)}" checked><span><b>Selected thread</b><small>${h(id)}</small></span></label>`,
      )
      .join("");
  }
  updateMemoryPanel();
}

function updateMemoryPanel() {
  $("#trace-picker").classList.toggle("hidden", memoryMode() !== "selected");
  syncJson();
}

function applyPreset(name) {
  $$(".preset").forEach((button) =>
    button.classList.toggle("active", button.dataset.preset === name),
  );
  $('input[name="memory"][value="off"]').checked = true;
  if (name === "edit") {
    $("#sandbox").value = "workspace-write";
    $("#approval").value = "manual";
    $("#verify").checked = true;
    $("#retries").value = "1";
  } else if (name === "review") {
    $("#sandbox").value = "read-only";
    $("#approval").value = "deny";
    $("#verify").checked = false;
    $("#retries").value = "0";
  } else {
    $("#sandbox").value = "read-only";
    $("#approval").value = "manual";
    $("#verify").checked = true;
    $("#retries").value = "1";
  }
  updateMemoryPanel();
  compile();
}

async function loadThreads() {
  const list = $("#thread-list");
  list.innerHTML = "<span>Reading Codex thread metadata…</span>";
  try {
    const data = await request(
      `/api/threads?cwd=${encodeURIComponent(value("#cwd"))}`,
    );
    list.innerHTML = data.threads.length
      ? data.threads
          .map(
            (thread) =>
              `<label><input type="checkbox" value="${h(thread.id)}"><span><b>${h(thread.name || thread.preview || "Untitled thread")}</b><small>${h(thread.id)}</small></span></label>`,
          )
          .join("")
      : "<span>No saved threads for this workspace.</span>";
  } catch (error) {
    list.innerHTML = `<span>${h(error.message)}</span>`;
  }
  compile();
}

function recompileMemory() {
  updateMemoryPanel();
  compile();
}

function recompileSelectedThreads() {
  syncJson();
  compile();
}

async function run() {
  if (!(await compile())) return;
  $("#run-button").disabled = true;
  $("#events").innerHTML = "<p>Starting Codex app-server…</p>";
  $("#receipt").textContent = "Run in progress.";
  $("#final-response").textContent = "Waiting for Codex.";
  $("#receipt-summary").innerHTML = "<p>Run in progress.</p>";
  renderTimeline([]);
  try {
    const data = await request("/api/runs", {
      method: "POST",
      body: JSON.stringify(manifestFromForm()),
    });
    activeRun = data.runId;
    $("#run-status").textContent = "Running";
    poll();
  } catch (error) {
    $("#run-status").textContent = "Failed";
    $("#receipt").textContent = error.message;
    $("#run-button").disabled = false;
  }
}

function renderEvents(events) {
  $("#events").innerHTML = events.length
    ? events
        .map(
          (event) =>
            `<div class="event"><b>${h(event.method || "event")}</b>${event.truncated ? " · payload truncated" : ""}</div>`,
        )
        .join("")
    : "<p>Waiting for the first event…</p>";
  $("#events").scrollTop = $("#events").scrollHeight;
}

function renderTimeline(timeline) {
  timeline = timeline.filter((event) => !["runtime", "item"].includes(event.kind));
  const root = $("#timeline");
  $("#timeline-count").textContent = `${timeline.length} event${timeline.length === 1 ? "" : "s"}`;
  if (!timeline.length) {
    root.innerHTML = "<p>Waiting for the first observed event…</p>";
    return;
  }
  let lastPhase = null;
  root.innerHTML = timeline.map((event) => {
    const phase = event.phase || "runtime";
    const phaseHead = phase !== lastPhase ? `<div class="timeline-phase"><span>${h(phase)}</span></div>` : "";
    lastPhase = phase;
    return `${phaseHead}<article class="timeline-event" data-kind="${h(event.kind || "runtime")}"><i>${h(event.index || "")}</i><div><span>${h(event.kind || "event")}</span><b>${h(event.title || event.method || "Event")}</b>${event.detail ? `<small>${h(event.detail)}</small>` : ""}</div></article>`;
  }).join("");
  root.scrollTop = root.scrollHeight;
}

function renderReceipt(result, error = null) {
  if (!result) {
    $("#receipt-summary").innerHTML = `<p>${h(error || "No receipt returned.")}</p>`;
    $("#final-response").textContent = error || "No response.";
    $("#receipt").textContent = error || "No receipt.";
    return;
  }
  const observed = result.observed || {};
  const timeline = result.timeline || [];
  const toolCalls = timeline.filter((item) => item.kind === "tool_call").length;
  const toolResults = timeline.filter((item) => item.kind === "tool_result").length;
  const verifier = result.verification || [];
  const finalVerdict = verifier.length ? verifier.at(-1).status : "not enabled";
  $("#receipt-summary").innerHTML = `
    <div class="receipt-metrics">
      <article><b>${h((result.turnIds || []).length)}</b><span>Controller turns</span></article>
      <article><b>${h(observed.modelCompletions ?? "—")}</b><span>Model completions</span></article>
      <article><b>${h(toolCalls)}</b><span>Tool requests</span></article>
      <article><b>${h(toolResults)}</b><span>Tool results</span></article>
    </div>
    <dl class="receipt-facts">
      <div><dt>Run</dt><dd>${h(result.runId || "—")}</dd></div>
      <div><dt>Manifest</dt><dd>${h(result.manifestHash || "—")}</dd></div>
      <div><dt>Memory</dt><dd>${h(result.memory?.mode || "off")}${result.memory?.resolvedThreadIds?.length ? ` · ${h(result.memory.resolvedThreadIds.length)} exact threads` : ""}</dd></div>
      <div><dt>Sandbox / approval</dt><dd>${h(result.controls?.sandbox || "—")} / ${h(result.controls?.approvalGate || "—")}</dd></div>
      <div><dt>Verifier</dt><dd>${h(finalVerdict)} · ${h(verifier.length)} turn${verifier.length === 1 ? "" : "s"}</dd></div>
      <div><dt>Observed item types</dt><dd>${h(JSON.stringify(observed.completedItemsByType || {}))}</dd></div>
    </dl>`;
  $("#final-response").textContent = result.finalResponse || "No final response text.";
  $("#receipt").textContent = JSON.stringify(result, null, 2);
  renderTimeline(timeline);
}

async function loadRecentRuns(autoLoadLatest = false) {
  const root = $("#recent-runs");
  try {
    const data = await request("/api/runs");
    root.innerHTML = data.runs.length ? data.runs.map((item) => `<button type="button" data-run-id="${h(item.runId)}"><b>${h(item.memoryMode || "off")} · ${h(item.turnCount)} turn${item.turnCount === 1 ? "" : "s"}</b><small>${h(item.runId.slice(0, 8))} · ${h(item.sandbox || "—")}</small></button>`).join("") : "<span>No saved runs.</span>";
    $$("#recent-runs button").forEach((button) => button.addEventListener("click", () => loadSavedRun(button.dataset.runId)));
    if (autoLoadLatest && data.runs.length) await loadSavedRun(data.runs[0].runId);
  } catch (error) {
    root.innerHTML = `<span>${h(error.message)}</span>`;
  }
}

async function loadSavedRun(runId) {
  try {
    const state = await request(`/api/runs/${runId}`);
    activeRun = null;
    $("#run-status").textContent = state.status;
    renderEvents(state.events || []);
    renderTimeline(state.timeline || state.result?.timeline || []);
    renderReceipt(state.result, state.error);
    $("#run").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    renderReceipt(null, error.message);
  }
}

async function poll() {
  clearTimeout(pollTimer);
  if (!activeRun) return;
  try {
    const state = await request(`/api/runs/${activeRun}`);
    $("#run-status").textContent = state.status;
    renderEvents(state.events);
    renderTimeline(state.timeline || []);
    if (state.pendingApproval && !$("#approval-dialog").open) {
      $("#approval-detail").textContent = JSON.stringify(
        state.pendingApproval.params,
        null,
        2,
      );
      $("#approval-dialog").showModal();
    }
    if (state.status === "completed" || state.status === "failed") {
      renderReceipt(state.result, state.error);
      await loadRecentRuns();
      $("#run-button").disabled = false;
      return;
    }
    pollTimer = setTimeout(poll, 600);
  } catch (error) {
    renderReceipt(null, error.message);
    $("#run-button").disabled = false;
  }
}

async function approve(decision) {
  if (!activeRun) return;
  await request(`/api/runs/${activeRun}/approval`, {
    method: "POST",
    body: JSON.stringify({ decision }),
  });
  $("#approval-dialog").close();
  poll();
}

$$('input[name="memory"]').forEach((input) =>
  input.addEventListener("change", recompileMemory),
);
$$(".preset").forEach((button) =>
  button.addEventListener("click", () => applyPreset(button.dataset.preset)),
);
$$("input, textarea, select").forEach((input) =>
  input.addEventListener("change", syncJson),
);
$("#thread-list").addEventListener("change", recompileSelectedThreads);
$("#load-threads").addEventListener("click", loadThreads);
$("#compile").addEventListener("click", compile);
$("#run-button").addEventListener("click", run);
$("#apply-json").addEventListener("click", () => {
  try {
    applyManifest(JSON.parse(value("#manifest-json")));
    compile();
  } catch (error) {
    $("#valid-state").textContent = `Invalid JSON · ${error.message}`;
  }
});
$$("[data-decision]").forEach((button) =>
  button.addEventListener("click", (event) => {
    event.preventDefault();
    approve(button.dataset.decision);
  }),
);
syncJson();
compile();
loadRecentRuns(true);
