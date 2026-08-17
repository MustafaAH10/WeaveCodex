(() => {
  "use strict";

  const STORAGE_KEY = "weave-codex:deep-dive:reveal";
  const root = document.documentElement;
  const toggle = document.querySelector("#weave-toggle");
  const closingToggle = document.querySelector("#closing-toggle");
  const modeTitle = document.querySelector("#mode-title");
  const modeDescription = document.querySelector("#mode-description");
  const progress = document.querySelector("#reading-progress");
  const railLinks = [...document.querySelectorAll(".section-rail a[data-section]")];
  const sections = [...document.querySelectorAll("article [id]")].filter((node) =>
    railLinks.some((link) => link.dataset.section === node.id),
  );

  function storedPreference() {
    const query = new URLSearchParams(window.location.search).get("weave");
    if (query === "1" || query === "on") return true;
    if (query === "0" || query === "off") return false;
    try {
      return window.localStorage.getItem(STORAGE_KEY) === "on";
    } catch {
      return false;
    }
  }

  function setWeave(enabled, { persist = true, announce = false } = {}) {
    root.dataset.weave = enabled ? "on" : "off";
    toggle.setAttribute("aria-checked", String(enabled));
    modeTitle.textContent = enabled ? "Weave diff revealed" : "Codex only";
    modeDescription.textContent = enabled
      ? "Additions are marked in coral. Codex stays visible underneath."
      : "Read the system before we change it.";

    if (persist) {
      try {
        window.localStorage.setItem(STORAGE_KEY, enabled ? "on" : "off");
      } catch {
        // Persistence is a convenience. The comparison still works without it.
      }
    }

    if (announce) {
      const live = document.createElement("span");
      live.className = "sr-only";
      live.setAttribute("aria-live", "polite");
      live.textContent = enabled ? "Weave comparison layer revealed." : "Showing Codex architecture only.";
      document.body.append(live);
      window.setTimeout(() => live.remove(), 900);
    }

    updateActiveSection();
  }

  function toggleWeave() {
    setWeave(root.dataset.weave !== "on", { announce: true });
  }

  function updateProgress() {
    const scrollable = document.documentElement.scrollHeight - window.innerHeight;
    const ratio = scrollable > 0 ? Math.min(1, Math.max(0, window.scrollY / scrollable)) : 0;
    progress.style.width = `${ratio * 100}%`;
  }

  function updateActiveSection() {
    const eligible = sections.filter((section) => {
      if (root.dataset.weave === "off" && section.classList.contains("weave-only")) return false;
      return true;
    });
    const marker = window.scrollY + Math.min(window.innerHeight * 0.32, 260);
    let active = eligible[0]?.id;
    eligible.forEach((section) => {
      if (section.offsetTop <= marker) active = section.id;
    });
    railLinks.forEach((link) => link.classList.toggle("active", link.dataset.section === active));
  }

  let scheduled = false;
  function onScroll() {
    if (scheduled) return;
    scheduled = true;
    window.requestAnimationFrame(() => {
      updateProgress();
      updateActiveSection();
      scheduled = false;
    });
  }

  toggle.addEventListener("click", toggleWeave);
  closingToggle.addEventListener("click", () => {
    setWeave(true, { announce: true });
    document.querySelector("#difference")?.scrollIntoView({ behavior: "smooth", block: "start" });
  });

  document.addEventListener("keydown", (event) => {
    const target = event.target;
    const isTyping = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target?.isContentEditable;
    if (!isTyping && event.key.toLowerCase() === "w" && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      toggleWeave();
    }
  });

  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onScroll, { passive: true });
  setWeave(storedPreference(), { persist: false });
  updateProgress();
  updateActiveSection();
})();
