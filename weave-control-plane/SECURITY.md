# WeaveCodex security

Report a suspected vulnerability through GitHub's private security advisory
flow for this repository. Do not include live credentials or private Codex
thread contents in a public issue.

## Deployment model

WeaveCodex is currently a local, single-user control plane. Keep it bound to
`127.0.0.1`. Its CSRF token and same-origin checks reduce accidental browser
requests; they do not make the execution API safe to publish on the internet.

Authentication remains owned by the official Codex app-server. WeaveCodex:

- inherits the user's configured `CODEX_HOME` when it starts Codex;
- reads only a redacted account status through `account/read`;
- never copies or persists `auth.json`, OAuth tokens, API keys, login URLs, or
  user email addresses; and
- uses the official ChatGPT browser/device flow when a login is required.

For a cloud demonstration, expose only a sanitized static results site. Keep
the Codex app-server and Weave execution API private to the sandbox.
