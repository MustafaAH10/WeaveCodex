const modeCopy = {
  codex: "Give Codex a goal and let it choose the route.",
  weave: "Draw the important stages, decisions, and checks around Codex.",
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

const exampleTabs = [...document.querySelectorAll("[role='tab'][data-example]")];
const examplePanels = [...document.querySelectorAll("[role='tabpanel']")];

function selectExample(tab) {
  const panelId = tab.getAttribute("aria-controls");
  for (const candidate of exampleTabs) {
    const selected = candidate === tab;
    candidate.setAttribute("aria-selected", String(selected));
    candidate.tabIndex = selected ? 0 : -1;
  }
  for (const panel of examplePanels) panel.hidden = panel.id !== panelId;
}

for (const [index, tab] of exampleTabs.entries()) {
  tab.addEventListener("click", () => selectExample(tab));
  tab.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    let next = index;
    if (event.key === "ArrowRight") next = (index + 1) % exampleTabs.length;
    if (event.key === "ArrowLeft") next = (index - 1 + exampleTabs.length) % exampleTabs.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = exampleTabs.length - 1;
    selectExample(exampleTabs[next]);
    exampleTabs[next].focus();
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

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
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
}

const demo = document.querySelector("[data-workflow-demo]");
const demoNodes = [...document.querySelectorAll(".rail-node")];
let demoTimers = [];

function playWorkflow() {
  for (const timer of demoTimers) window.clearTimeout(timer);
  demoTimers = [];
  demo.classList.remove("playing");
  for (const node of demoNodes) node.classList.remove("active");
  void demo.offsetWidth;
  demo.classList.add("playing");
  demoNodes.forEach((node, index) => {
    demoTimers.push(window.setTimeout(() => {
      node.classList.add("active");
      demo.querySelector(".demo-status").textContent = index === demoNodes.length - 1 ? "Complete" : node.querySelector("b").textContent;
    }, 320 + index * 570));
  });
}

if (demo && !reduceMotion && "IntersectionObserver" in window) {
  const demoObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) if (entry.isIntersecting) playWorkflow();
  }, { threshold: 0.45 });
  demoObserver.observe(demo);
} else if (demo) {
  demo.classList.add("playing");
  for (const node of demoNodes) node.classList.add("active");
  demo.querySelector(".demo-status").textContent = "Complete";
}
