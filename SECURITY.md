# Security Policy

This repository is an independent downstream of OpenAI Codex. Its Weave control
plane is not an OpenAI product.

## Reporting WeaveCodex issues

Use this repository's GitHub **private security advisory** flow for suspected
vulnerabilities in `weave-control-plane/`, its local web interface, trial
infrastructure, or downstream packaging. Do not put credentials, private Codex
threads, raw receipts, or rollout traces in a public issue.

WeaveCodex is currently a local, single-user application. Keep its server bound
to `127.0.0.1`; the execution API is not designed for public internet exposure.
Authentication and credential storage remain owned by the official Codex
app-server. WeaveCodex must not read, copy, display, or persist Codex login
tokens.

See [`weave-control-plane/SECURITY.md`](weave-control-plane/SECURITY.md) for the
control plane's deployment and credential boundary.

## Reporting upstream Codex issues

If the issue is reproducible in unmodified OpenAI Codex rather than the Weave
layer, follow OpenAI's security program and report it through the
[OpenAI Bugcrowd program](https://bugcrowd.com/engagements/openai). OpenAI's
Vulnerability Disclosure Program terms apply to that upstream report.

## How to operate CODEX safely

For details on Codex security boundaries, including sandboxing, approvals, and network controls, see [Agent approvals & security](https://developers.openai.com/codex/agent-approvals-security).
