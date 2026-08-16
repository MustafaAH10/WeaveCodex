const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
let compiled = null;
let activeRun = null;
let pollTimer = null;
const h = (text) => String(text).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

function value(id) { return $(id).value.trim(); }
function memoryMode() { return $('input[name="memory"]:checked').value; }
function selectedThreads() { return $$('#thread-list input:checked').map((item) => item.value); }

function manifestFromForm() {
  return {
    schemaVersion: 1,
    name: 'Codex visual harness',
    cwd: value('#cwd'),
    task: {
      instructions: value('#task'),
      contextPaths: value('#context').split('\n').map((item) => item.trim()).filter(Boolean),
    },
    memory: { mode: memoryMode(), selectedThreadIds: memoryMode() === 'selected' ? selectedThreads() : [] },
    agent: {
      model: value('#model') || null,
      reasoningEffort: value('#effort'),
      sandbox: value('#sandbox'),
      approvalGate: value('#approval'),
    },
    verification: {
      enabled: $('#verify').checked,
      criteria: value('#criteria'),
      maxRetries: Number(value('#retries')),
    },
    output: { format: 'text' },
    observability: { traceRoot: '.weave-codex/traces' },
  };
}

function syncJson() { $('#manifest-json').value = JSON.stringify(manifestFromForm(), null, 2); }

async function request(path, options = {}) {
  const response = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...options });
  const data = await response.json();
  if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : JSON.stringify(data.error));
  return data;
}

function renderCompile(result) {
  compiled = result;
  $('#graph').innerHTML = result.nodes.map((node) => `<article class="node" data-state="${h(node.state || 'active')}"><i>${h(node.kind)}</i><b>${h(node.label)}</b><small>${h(node.detail)}</small></article>`).join('');
  $('#actions').innerHTML = result.actions.map((action) => `<li>${h(action)}</li>`).join('');
  $('#turn-bound').textContent = result.maximumTurns;
  $('#valid-state').textContent = `Valid · ${result.manifestHash.slice(0, 18)}…`;
  $('#valid-state').style.color = 'var(--green)';
}

async function compile() {
  syncJson();
  try {
    renderCompile(await request('/api/compile', { method: 'POST', body: $('#manifest-json').value }));
    return true;
  } catch (error) {
    $('#valid-state').textContent = `Invalid · ${error.message}`;
    $('#valid-state').style.color = 'var(--accent)';
    return false;
  }
}

function applyManifest(manifest) {
  $('#task').value = manifest.task.instructions;
  $('#cwd').value = manifest.cwd;
  $('#model').value = manifest.agent.model || '';
  $('#context').value = (manifest.task.contextPaths || []).join('\n');
  $(`input[name="memory"][value="${manifest.memory.mode}"]`).checked = true;
  $('#sandbox').value = manifest.agent.sandbox;
  $('#approval').value = manifest.agent.approvalGate;
  $('#effort').value = manifest.agent.reasoningEffort;
  $('#verify').checked = manifest.verification.enabled;
  $('#retries').value = manifest.verification.maxRetries;
  $('#criteria').value = manifest.verification.criteria;
  if (manifest.memory.mode === 'selected') {
    $('#thread-list').innerHTML = manifest.memory.selectedThreadIds.map((id) => `<label><input type="checkbox" value="${h(id)}" checked><span><b>Selected thread</b><small>${h(id)}</small></span></label>`).join('');
  }
  updateMemoryPanel();
}

function updateMemoryPanel() {
  $('#trace-picker').classList.toggle('hidden', memoryMode() !== 'selected');
  syncJson();
}

function applyPreset(name) {
  $$('.preset').forEach((button) => button.classList.toggle('active', button.dataset.preset === name));
  $('input[name="memory"][value="off"]').checked = true;
  if (name === 'edit') {
    $('#sandbox').value = 'workspace-write'; $('#approval').value = 'manual'; $('#verify').checked = true; $('#retries').value = '1';
  } else if (name === 'review') {
    $('#sandbox').value = 'read-only'; $('#approval').value = 'deny'; $('#verify').checked = false; $('#retries').value = '0';
  } else {
    $('#sandbox').value = 'read-only'; $('#approval').value = 'manual'; $('#verify').checked = true; $('#retries').value = '1';
  }
  updateMemoryPanel(); compile();
}

async function loadThreads() {
  const list = $('#thread-list');
  list.innerHTML = '<span>Reading Codex thread metadata…</span>';
  try {
    const data = await request(`/api/threads?cwd=${encodeURIComponent(value('#cwd'))}`);
    list.innerHTML = data.threads.length ? data.threads.map((thread) => `<label><input type="checkbox" value="${h(thread.id)}"><span><b>${h(thread.name || thread.preview || 'Untitled thread')}</b><small>${h(thread.id)}</small></span></label>`).join('') : '<span>No saved threads for this workspace.</span>';
  } catch (error) { list.innerHTML = `<span>${h(error.message)}</span>`; }
}

async function run() {
  if (!(await compile())) return;
  $('#run-button').disabled = true;
  $('#events').innerHTML = '<p>Starting Codex app-server…</p>';
  $('#receipt').textContent = 'Run in progress.';
  try {
    const data = await request('/api/runs', { method: 'POST', body: JSON.stringify(manifestFromForm()) });
    activeRun = data.runId; $('#run-status').textContent = 'Running'; poll();
  } catch (error) {
    $('#run-status').textContent = 'Failed'; $('#receipt').textContent = error.message; $('#run-button').disabled = false;
  }
}

function renderEvents(events) {
  $('#events').innerHTML = events.length ? events.map((event) => `<div class="event"><b>${h(event.method || 'event')}</b>${event.truncated ? ' · payload truncated' : ''}</div>`).join('') : '<p>Waiting for the first event…</p>';
  $('#events').scrollTop = $('#events').scrollHeight;
}

async function poll() {
  clearTimeout(pollTimer);
  if (!activeRun) return;
  try {
    const state = await request(`/api/runs/${activeRun}`);
    $('#run-status').textContent = state.status;
    renderEvents(state.events);
    if (state.pendingApproval && !$('#approval-dialog').open) {
      $('#approval-detail').textContent = JSON.stringify(state.pendingApproval.params, null, 2);
      $('#approval-dialog').showModal();
    }
    if (state.status === 'completed' || state.status === 'failed') {
      $('#receipt').textContent = JSON.stringify(state.result || { error: state.error }, null, 2);
      $('#run-button').disabled = false; return;
    }
    pollTimer = setTimeout(poll, 600);
  } catch (error) { $('#receipt').textContent = error.message; $('#run-button').disabled = false; }
}

async function approve(decision) {
  if (!activeRun) return;
  await request(`/api/runs/${activeRun}/approval`, { method: 'POST', body: JSON.stringify({ decision }) });
  $('#approval-dialog').close(); poll();
}

$$('input[name="memory"]').forEach((input) => input.addEventListener('change', updateMemoryPanel));
$$('.preset').forEach((button) => button.addEventListener('click', () => applyPreset(button.dataset.preset)));
$$('input, textarea, select').forEach((input) => input.addEventListener('change', syncJson));
$('#thread-list').addEventListener('change', syncJson);
$('#load-threads').addEventListener('click', loadThreads);
$('#compile').addEventListener('click', compile);
$('#run-button').addEventListener('click', run);
$('#apply-json').addEventListener('click', () => { try { applyManifest(JSON.parse(value('#manifest-json'))); compile(); } catch (error) { $('#valid-state').textContent = `Invalid JSON · ${error.message}`; } });
$$('[data-decision]').forEach((button) => button.addEventListener('click', (event) => { event.preventDefault(); approve(button.dataset.decision); }));
syncJson(); compile();
