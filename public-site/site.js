const SVG_NS = "http://www.w3.org/2000/svg";
const workflows = globalThis.WEAVE_WORKFLOWS;
const comparisons = globalThis.WEAVE_COMPARISONS;
const graph = document.querySelector("#workflow-graph");
const workflowButtons = [...document.querySelectorAll("[data-workflow-key]")];
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
let activeWorkflow = "finance";
let graphTimers = [];
let showcaseVisible = false;
let activeComparison = "forecast";
let comparisonTimers = [];
let comparisonVisible = false;

function svgElement(name, attributes = {}) {
  const element = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  return element;
}

function renderWorkflow(key, { animate = showcaseVisible } = {}) {
  const workflow = workflows[key];
  activeWorkflow = key;
  for (const timer of graphTimers) window.clearTimeout(timer);
  graphTimers = [];
  graph.replaceChildren();

  const definitions = svgElement("defs");
  const marker = svgElement("marker", { id: "graph-arrow", markerWidth: 8, markerHeight: 8, refX: 7, refY: 4, orient: "auto", markerUnits: "strokeWidth" });
  marker.append(svgElement("path", { d: "M0,0 L8,4 L0,8 Z", fill: "#858a80" }));
  definitions.append(marker);
  graph.append(definitions);

  const nodeById = new Map(workflow.nodes.map((node) => [node.id, node]));
  for (const [fromId, toId] of workflow.edges) {
    const from = nodeById.get(fromId);
    const to = nodeById.get(toId);
    const startX = from.x + 150;
    const startY = from.y + 39;
    const endX = to.x;
    const endY = to.y + 39;
    const curve = Math.max(36, (endX - startX) * .46);
    graph.append(svgElement("path", {
      class: "graph-edge",
      d: `M${startX} ${startY} C${startX + curve} ${startY},${endX - curve} ${endY},${endX} ${endY}`,
      "data-target": toId,
    }));
  }

  for (const node of workflow.nodes) {
    const group = svgElement("g", { class: `graph-node ${node.kind}`, transform: `translate(${node.x} ${node.y})`, "data-node": node.id });
    group.append(svgElement("rect", { width: 150, height: 78 }));
    const mark = svgElement("text", { class: "node-mark", x: 13, y: 23 });
    mark.textContent = node.eyebrow;
    const title = svgElement("text", { class: "node-title", x: 13, y: 52 });
    title.textContent = node.title;
    group.append(mark, title);
    graph.append(group);
  }

  document.querySelector("#workflow-label").textContent = `${workflow.label} workflow`;
  document.querySelector("#workflow-title").textContent = workflow.title;
  document.querySelector("#workflow-description").textContent = workflow.description;
  document.querySelector("#workflow-result").textContent = workflow.result;
  document.querySelector("#workflow-stats").textContent = `${workflow.nodes.length} steps · ${workflow.edges.length} connections · branches and merges`;
  for (const button of workflowButtons) {
    const selected = button.dataset.workflowKey === key;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-pressed", String(selected));
  }

  if (reduceMotion || !animate) {
    if (reduceMotion || !("IntersectionObserver" in window)) graph.querySelectorAll(".graph-node, .graph-edge").forEach((item) => item.classList.add("active"));
    return;
  }
  playWorkflowGraph();
}

function playWorkflowGraph() {
  for (const timer of graphTimers) window.clearTimeout(timer);
  graphTimers = [];
  graph.querySelectorAll(".graph-node, .graph-edge").forEach((item) => item.classList.remove("active"));
  workflows[activeWorkflow].nodes.forEach((node, index) => {
    graphTimers.push(window.setTimeout(() => {
      graph.querySelector(`[data-node="${node.id}"]`).classList.add("active");
      graph.querySelectorAll(`[data-target="${node.id}"]`).forEach((edge) => edge.classList.add("active"));
    }, 100 + index * 190));
  });
}

for (const [index, button] of workflowButtons.entries()) {
  button.addEventListener("click", () => renderWorkflow(button.dataset.workflowKey, { animate: true }));
  button.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    let next = index;
    if (event.key === "ArrowRight") next = (index + 1) % workflowButtons.length;
    if (event.key === "ArrowLeft") next = (index - 1 + workflowButtons.length) % workflowButtons.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = workflowButtons.length - 1;
    workflowButtons[next].focus();
    renderWorkflow(workflowButtons[next].dataset.workflowKey, { animate: true });
  });
}

function streamMarkup(lines) {
  return lines.map(([kind, text], index) => `<div class="stream-line ${kind}" data-stream-index="${index}"><small>${kind}</small><pre>${String(text).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</pre></div>`).join("");
}

function playComparison() {
  for (const timer of comparisonTimers) window.clearTimeout(timer);
  comparisonTimers = [];
  const lines = [...document.querySelectorAll(".stream-line")];
  const pathNodes = [...document.querySelectorAll(".contract-node")];
  lines.forEach((line) => line.classList.remove("active"));
  pathNodes.forEach((node) => node.classList.remove("active"));
  if (reduceMotion || !comparisonVisible) {
    if (reduceMotion) {
      lines.forEach((line) => line.classList.add("active"));
      pathNodes.forEach((node) => node.classList.add("active"));
    }
    return;
  }
  for (let index = 0; index < comparisons[activeComparison].codex.length; index += 1) {
    comparisonTimers.push(window.setTimeout(() => {
      document.querySelectorAll(`[data-stream-index="${index}"]`).forEach((line) => line.classList.add("active"));
      pathNodes[index]?.classList.add("active");
    }, 180 + index * 620));
  }
}

function renderComparison(key, { animate = comparisonVisible } = {}) {
  const comparison = comparisons[key];
  activeComparison = key;
  document.querySelector("#comparison-label").textContent = comparison.label;
  document.querySelector("#comparison-title").textContent = comparison.title;
  document.querySelector("#comparison-task").textContent = comparison.task;
  document.querySelector("#comparison-result").textContent = comparison.result;
  document.querySelector("#codex-stream").innerHTML = streamMarkup(comparison.codex);
  document.querySelector("#weave-stream").innerHTML = streamMarkup(comparison.weave);
  document.querySelector("#contract-path").innerHTML = comparison.path.map((label, index) => `<span class="contract-node ${index === 1 ? "calibrate" : ""}">${label}</span>`).join("");
  document.querySelectorAll("[data-comparison-key]").forEach((button) => {
    const selected = button.dataset.comparisonKey === key;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
  if (animate) playComparison();
}

document.querySelectorAll("[data-comparison-key]").forEach((button) => button.addEventListener("click", () => renderComparison(button.dataset.comparisonKey, { animate: true })));
document.querySelector("#replay-comparison")?.addEventListener("click", playComparison);

document.querySelectorAll(".copy-button").forEach((copyButton) => copyButton.addEventListener("click", async () => {
  const label = copyButton.querySelector(".copy-label");
  try {
    await navigator.clipboard.writeText(copyButton.dataset.copy);
    label.textContent = "Copied";
  } catch {
    label.textContent = "Select";
  }
  window.setTimeout(() => { label.textContent = "Copy"; }, 1800);
}));

const revealItems = [...document.querySelectorAll(".reveal")];
if ("IntersectionObserver" in window && !reduceMotion) {
  document.documentElement.classList.add("has-reveal");
  const revealObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add("is-visible");
      revealObserver.unobserve(entry.target);
    }
  }, { threshold: 0.12 });
  for (const item of revealItems) revealObserver.observe(item);

  const graphObserver = new IntersectionObserver((entries) => {
    if (!entries.some((entry) => entry.isIntersecting)) return;
    showcaseVisible = true;
    playWorkflowGraph();
    graphObserver.disconnect();
  }, { threshold: 0.4 });
  graphObserver.observe(document.querySelector("#workflow"));

  const comparisonObserver = new IntersectionObserver((entries) => {
    if (!entries.some((entry) => entry.isIntersecting)) return;
    comparisonVisible = true;
    playComparison();
    comparisonObserver.disconnect();
  }, { threshold: 0.35 });
  comparisonObserver.observe(document.querySelector("#execution-demo"));
} else {
  showcaseVisible = true;
  comparisonVisible = true;
}

renderWorkflow(activeWorkflow, { animate: false });
renderComparison(activeComparison, { animate: false });
