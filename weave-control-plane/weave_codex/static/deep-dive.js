(() => {
  "use strict";

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  let securitySession = null;
  let loginPollTimer = null;

  async function request(path, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (options.method && options.method !== "GET") {
      headers["Content-Type"] = "application/json";
      headers["X-Weave-CSRF"] = securitySession?.csrfToken || "";
    }
    const response = await fetch(path, { ...options, headers });
    const data = await response.json();
    if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : `HTTP ${response.status}`);
    return data;
  }

  function setView(view, { updateHash = true } = {}) {
    const active = view === "setup" ? "setup" : "architecture";
    $$(".page-view").forEach((panel) => {
      const selected = panel.id === `${active}-view`;
      panel.classList.toggle("active", selected);
      panel.hidden = !selected;
    });
    $$(".page-tab").forEach((button) => {
      const selected = button.dataset.view === active;
      button.classList.toggle("active", selected);
      button.setAttribute("aria-selected", String(selected));
    });
    if (updateHash) history.replaceState(null, "", `#${active}`);
    if (updateHash) window.scrollTo(0, 0);
    if (active === "setup") void checkAccount();
  }

  function setLayer(enabled) {
    document.documentElement.dataset.weave = enabled ? "on" : "off";
    $("#codex-layer").classList.toggle("active", !enabled);
    $("#weave-layer").classList.toggle("active", enabled);
    $("#codex-layer").setAttribute("aria-pressed", String(!enabled));
    $("#weave-layer").setAttribute("aria-pressed", String(enabled));
    $("#diagram-caption").innerHTML = enabled
      ? "<b>Weave revealed.</b> The manifest, phase compiler, human checkpoint, and receipt wrap app-server. The native Codex loop is unchanged."
      : "<b>Codex only.</b> A client sends a task through app-server; Codex owns the adaptive context → model → tools loop.";
  }

  function renderAccount(account) {
    const message = $("#account-message");
    const privacy = $("#account-privacy");
    const login = $("#chatgpt-login");
    if (account?.canRun) {
      const type = account.accountType === "chatgpt" ? "ChatGPT" : account.accountType === "apiKey" ? "API key" : "Codex";
      message.textContent = account.message || `Ready to run through ${type}.`;
      privacy.textContent = "No secrets, tokens, or email are returned to this page.";
      login.classList.toggle("hidden", account.accountType === "chatgpt");
    } else {
      message.textContent = account?.message || "Codex is installed, but this account is not ready to run.";
      privacy.textContent = "Use the native ChatGPT browser flow or run codex login in a terminal.";
      login.classList.remove("hidden");
    }
  }

  async function checkAccount() {
    try {
      securitySession ||= await request("/api/session");
      renderAccount(await request("/api/account"));
    } catch (error) {
      renderAccount({ canRun: false, message: `Local Codex connection unavailable: ${error.message}` });
    }
  }

  async function pollLogin(loginId) {
    clearTimeout(loginPollTimer);
    try {
      const result = await request(`/api/account/login/${encodeURIComponent(loginId)}`);
      if (result.state === "succeeded") return renderAccount(result.account || await request("/api/account"));
      if (result.state === "failed") return renderAccount({ canRun: false, message: result.message });
      $("#account-message").textContent = result.message || "Waiting for ChatGPT sign-in to finish…";
      loginPollTimer = window.setTimeout(() => pollLogin(loginId), 900);
    } catch (error) {
      renderAccount({ canRun: false, message: error.message });
    }
  }

  async function startLogin() {
    const button = $("#chatgpt-login");
    button.disabled = true;
    try {
      securitySession ||= await request("/api/session");
      const result = await request("/api/account/login/chatgpt", { method: "POST", body: "{}" });
      if (result.authUrl) window.open(result.authUrl, "_blank", "noopener,noreferrer");
      $("#account-message").textContent = result.message || "Finish signing in through the Codex browser flow.";
      if (result.loginId) void pollLogin(result.loginId);
    } catch (error) {
      renderAccount({ canRun: false, message: error.message });
    } finally {
      button.disabled = false;
    }
  }

  async function copyCommand(button) {
    await navigator.clipboard.writeText(button.dataset.copy || "");
    const original = button.textContent;
    button.textContent = "Copied";
    window.setTimeout(() => { button.textContent = original; }, 1200);
  }

  $$(".page-tab").forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));
  $("#codex-layer").addEventListener("click", () => setLayer(false));
  $("#weave-layer").addEventListener("click", () => setLayer(true));
  $("#check-account").addEventListener("click", checkAccount);
  $("#chatgpt-login").addEventListener("click", startLogin);
  $$(".copy-command").forEach((button) => button.addEventListener("click", () => copyCommand(button).catch(() => { button.textContent = "Copy failed"; })));
  window.addEventListener("hashchange", () => setView(location.hash === "#setup" ? "setup" : "architecture", { updateHash: false }));
  setLayer(false);
  setView(location.hash === "#setup" ? "setup" : "architecture", { updateHash: false });
})();
