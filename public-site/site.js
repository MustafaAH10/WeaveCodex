const SVG_NS = "http://www.w3.org/2000/svg";
const workflows = globalThis.WEAVE_WORKFLOWS;
const graph = document.querySelector("#workflow-graph");
const workflowButtons = [...document.querySelectorAll("[data-workflow-key]")];
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
let activeWorkflow = "finance";
let graphTimers = [];
let showcaseVisible = false;

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

const modeCopy = {
  codex: "Give Codex a goal and let it choose the route.",
  weave: "Draw the branches, decisions, and evidence gates that matter to you.",
};
const modeButtons = [...document.querySelectorAll(".mode-button")];
const modeDiagram = document.querySelector(".mode-diagram");
const modeDescription = document.querySelector(".mode-description");
for (const button of modeButtons) {
  button.addEventListener("click", () => {
    const mode = button.dataset.mode;
    modeDiagram.dataset.currentMode = mode;
    modeDescription.textContent = modeCopy[mode];
    for (const candidate of modeButtons) {
      const selected = candidate === button;
      candidate.classList.toggle("is-active", selected);
      candidate.setAttribute("aria-pressed", String(selected));
    }
  });
}

const copyButton = document.querySelector(".copy-button");
copyButton?.addEventListener("click", async () => {
  const label = copyButton.querySelector(".copy-label");
  try {
    await navigator.clipboard.writeText(copyButton.dataset.copy);
    label.textContent = "Copied";
  } catch {
    label.textContent = "Select the commands above";
  }
  window.setTimeout(() => { label.textContent = "Copy commands"; }, 1800);
});

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
} else {
  showcaseVisible = true;
}

renderWorkflow(activeWorkflow, { animate: false });
