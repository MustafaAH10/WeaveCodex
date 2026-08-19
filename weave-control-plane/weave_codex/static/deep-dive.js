(() => {
  "use strict";

  const $ = (selector) => document.querySelector(selector);

  function setLayer(enabled) {
    document.documentElement.dataset.weave = enabled ? "on" : "off";
    $("#codex-layer").classList.toggle("active", !enabled);
    $("#weave-layer").classList.toggle("active", enabled);
    $("#codex-layer").setAttribute("aria-pressed", String(!enabled));
    $("#weave-layer").setAttribute("aria-pressed", String(enabled));
    $("#diagram-caption").innerHTML = enabled
      ? "<b>Weave on.</b> Goals, checkpoints, and receipts wrap the unchanged Codex loop."
      : "<b>Codex only.</b> The client supplies a goal; Codex chooses the path.";
  }

  $("#codex-layer").addEventListener("click", () => setLayer(false));
  $("#weave-layer").addEventListener("click", () => setLayer(true));
  setLayer(false);
})();
