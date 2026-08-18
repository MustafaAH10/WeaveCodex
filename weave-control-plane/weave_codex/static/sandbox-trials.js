"use strict";

const fallbackTrials = [
  ["click-default-map", "Click nested default-map resolution", "Map → checkpoint → trace → challenge → verify"],
  ["requests-proxy-precedence", "Requests proxy and environment precedence", "Map inputs → checkpoint → trace precedence → adversarial review → verify"],
  ["express-async-errors", "Express asynchronous error propagation", "Map lifecycle → checkpoint → trace errors → challenge failures → verify"],
];

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function metric(label, value) {
  const node = el("div", "metric");
  node.append(el("small", "", label), el("b", "", String(value)));
  return node;
}

function facts(data) {
  const items = [
    ["Runtime", "Codex app-server"],
    ["Model", data?.model || "gpt-5.6-terra"],
    ["Memory", data?.memory || "off"],
    ["Repositories", data?.results?.length || 3],
  ];
  const root = document.querySelector("#study-facts");
  items.forEach(([term, description]) => {
    const wrapper = el("div");
    wrapper.append(el("dt", "", term), el("dd", "", description));
    root.append(wrapper);
  });
}

function fileList(files) {
  const details = el("details", "files");
  details.append(el("summary", "", `Verified local files (${files.length})`));
  const list = el("ul");
  files.forEach((file) => list.append(el("li", "", `${file.path}\n${file.sha256}`)));
  details.append(list);
  return details;
}

function resultCard(result) {
  const card = el("article", "trial-card");
  const passed = Boolean(result.grade?.passed);
  card.append(el("span", `status ${passed ? "passed" : ""}`, passed ? "Accepted" : "Needs review"));
  card.append(el("h3", "", result.title));
  card.append(el("p", "question", result.question));
  const phases = el("ul", "phases");
  (result.receipt?.phaseExecutions || []).forEach((phase) => phases.append(el("li", "", phase.phaseId)));
  card.append(phases);
  const metrics = el("div", "metrics");
  metrics.append(
    metric("Controller turns", result.receipt?.controllerTurns ?? "—"),
    metric("Model completions", result.receipt?.modelCompletions ?? "—"),
    metric("Command items", result.receipt?.completedItemsByType?.commandExecution ?? 0),
    metric("External test", result.grade?.externalVerification?.exitCode === 0 ? "exit 0" : "failed"),
  );
  card.append(metrics);
  card.append(el("p", "eyebrow", result.commit.slice(0, 12)));
  card.append(fileList(result.grade?.referencedFiles || []));
  return card;
}

function plannedCard([id, title, shape]) {
  const card = el("article", "trial-card");
  card.append(el("span", "status", "Awaiting execution"), el("h3", "", title));
  card.append(el("p", "question", shape));
  card.append(el("p", "eyebrow", id));
  return card;
}

async function load() {
  let data = null;
  try {
    const response = await fetch("sandbox-trials.json", { cache: "no-store" });
    if (!response.ok) throw new Error(String(response.status));
    data = await response.json();
  } catch (_error) {
    document.querySelector("#result-status").textContent = "Frozen plans are ready; execution receipt is not published yet.";
  }
  facts(data);
  const grid = document.querySelector("#trial-grid");
  if (data?.results?.length) {
    data.results.forEach((result) => grid.append(resultCard(result)));
    document.querySelector("#result-status").textContent = `${data.results.filter((item) => item.grade?.passed).length}/${data.results.length} artifacts accepted by the independent grader.`;
  } else {
    fallbackTrials.forEach((trial) => grid.append(plannedCard(trial)));
  }
  const limits = data?.claimLimits || [
    "One rollout per repository cannot establish a quality advantage.",
    "The tasks are source-analysis acceptance trials, not a benchmark.",
    "No result implies that an upstream repository has a defect.",
  ];
  limits.forEach((limit) => document.querySelector("#claim-limits").append(el("li", "", limit)));
}

load();
