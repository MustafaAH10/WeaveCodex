const modeCopy = {
  codex: "Codex chooses the route inside one adaptive run. You see the conversation and result.",
  weave:
    "You draw the route around Codex: when to explore, where you decide, and what must pass before completion.",
};

const modeButtons = [...document.querySelectorAll(".mode-button")];
const modeScene = document.querySelector(".mode-scene");
const modeDescription = document.querySelector(".mode-description");

for (const button of modeButtons) {
  button.addEventListener("click", () => {
    const mode = button.dataset.mode;
    modeScene.dataset.currentMode = mode;
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
  for (const panel of examplePanels) {
    panel.hidden = panel.id !== panelId;
  }
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
    label.textContent = "Select commands above";
  }
  window.setTimeout(() => {
    label.textContent = "Copy commands";
  }, 1800);
});

const revealItems = [...document.querySelectorAll(".reveal")];
if ("IntersectionObserver" in window && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
  document.documentElement.classList.add("has-reveal");
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add("is-visible");
        observer.unobserve(entry.target);
      }
    },
    { threshold: 0.12 },
  );
  for (const item of revealItems) observer.observe(item);
}
