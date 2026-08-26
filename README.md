# WeaveCodex

WeaveCodex is an experimental, human-designable control plane built on the open-source Codex
runtime. It is an independent downstream project, not an OpenAI product.

Ordinary Codex lets you state a goal and lets its agent loop decide how to complete it. WeaveCodex
keeps that adaptive loop intact, then adds a layer around it that a person can inspect and edit:

- complete Codex work steps, where one step may contain many model and tool iterations;
- explicit human checkpoints that can continue, redirect the next step with feedback, or stop;
- structured verification with a declared repair bound;
- run-wide memory, sandbox, and approval choices;
- a deterministic compiled contract used by the runtime and exposed through the API; and
- a readable activity record that links the workflow to what Codex actually produced.

It does **not** turn every tool call into a canvas block, expose private reasoning, or replace
Codex's native tools, sandbox, approvals, authentication, compaction, or agent loop.

The latest external-user acceptance study ran four memory-off task pairs—forecast repair, poster
design, a local connector action draft, and an incident-support brief—inside one fresh container
using official ChatGPT device authorization and no API key. The one-turn Codex baseline and the
hand-authored Weave loop both produced contract-valid artifacts in all eight arms. Weave added four
accepted pre-production gates; it did not show a model-quality or efficiency advantage. See the
[methods, outputs, and receipts](experiments/platform-workflow-trials/results-v2/RESULTS.md).

## Run WeaveCodex locally

Prerequisites are Python 3.11+, `uv`, and an installed Codex CLI. Sign in with your ChatGPT
subscription using `codex login`; WeaveCodex talks to the official local app-server and reuses the
Codex-managed session. It does not copy tokens into this repository.

```bash
cd weave-control-plane
uv sync
uv run python -m weave_codex.server \
  --codex-bin "$(command -v codex)" \
  --host 127.0.0.1 \
  --port 8790
```

Then open <http://127.0.0.1:8790/>. The product has three places:

- **Create** — describe the goal, choose direct Codex or a visible workflow, run it, and optionally
  customize the steps;
- **Library** — reuse saved workflows, choose existing Codex skills/connectors, and manage local
  account setup; and
- **Activity** — review your runs in plain English and optionally open the bounded product checks.

Architecture is explained inline under Create. Setup and integrations live together in Library.
Evidence lives below personal run history in Activity. Technical hashes and raw identifiers remain
in machine-readable local artifacts and APIs; they do not dominate the normal interface. A saved
workflow can be loaded for another folder and its human-readable goals can be edited manually or
sent to Codex for a read-only rewrite proposal.

For implementation details, read the [control-plane guide](weave-control-plane/README.md), the complete source-level article
[Codex is not a flowchart](weave-control-plane/docs/CODEX_HARNESS_INTERNALS.md), and the
[upstream provenance record](weave-control-plane/UPSTREAM.md). The
[matched ordinary-Codex versus WeaveCodex trials](weave-control-plane/docs/MATCHED_CODEX_WEAVE_TRIALS.md)
report three real memory-off pairs and their compute/observability tradeoff.
The [Runloop repository trial report](weave-control-plane/docs/RUNLOOP_REPOSITORY_TRIALS.md)
documents three more complex goal-phase programs, independent test exits, and verified sandbox
file references.
The newer [matched OSS implementation study](weave-control-plane/docs/OSS_IMPLEMENTATION_TRIALS.md)
compares ordinary Codex and three different hand-authored Weave programs on pinned Jinja,
Starlette, and Commander regressions. Both arms repaired 3/3; ordinary Codex used 18 model
completions versus Weave's 32, while Weave added two reached checkpoints and three first-pass
verifier receipts. The result supports a control/observability claim, not a quality advantage.

The `weave-control-plane/` directory is additive. The pinned Codex source remains available below
it so the integration can be audited and updated against upstream.

---

## Upstream Codex

The remainder of this README describes the embedded OpenAI Codex source at the pinned upstream
revision. OpenAI owns and maintains Codex; WeaveCodex owns only its downstream control layer.

<p align="center"><strong>Codex CLI</strong> is a coding agent from OpenAI that runs locally on your computer.
<p align="center">
  <img src="https://github.com/openai/codex/blob/main/.github/codex-cli-splash.png" alt="Codex CLI splash" width="80%" />
</p>
</br>
If you want Codex in your code editor (VS Code, Cursor, Windsurf), <a href="https://developers.openai.com/codex/ide">install in your IDE.</a>
</br>If you want the desktop app experience, run <code>codex app</code> or visit <a href="https://chatgpt.com/codex?app-landing-page=true">the Codex App page</a>.
</br>If you are looking for the <em>cloud-based agent</em> from OpenAI, <strong>Codex Web</strong>, go to <a href="https://chatgpt.com/codex">chatgpt.com/codex</a>.</p>

---

## Quickstart

### Installing and running Codex CLI

Run the following on Mac or Linux to install Codex CLI:

```shell
curl -fsSL https://chatgpt.com/codex/install.sh | sh
```

Run the following on Windows to install Codex CLI:

```shell
powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"
```

The standalone installers download from `https://releases.openai.com/codex` by default and fall back to GitHub Releases if a metadata or asset download is unavailable. To force GitHub Releases, set `CODEX_INSTALLER_USE_RELEASES_OPENAI_COM` to `false` (`0` and `no` are also accepted):

```shell
curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_INSTALLER_USE_RELEASES_OPENAI_COM=false sh
```

```powershell
$env:CODEX_INSTALLER_USE_RELEASES_OPENAI_COM='false'; irm https://chatgpt.com/codex/install.ps1 | iex
```

Codex CLI can also be installed via the following package managers:

```shell
# Install using npm
npm install -g @openai/codex
```

```shell
# Install using Homebrew
brew install --cask codex
```

Then simply run `codex` to get started.

<details>
<summary>You can also go to the <a href="https://github.com/openai/codex/releases/latest">latest GitHub Release</a> and download the appropriate binary for your platform.</summary>

Each GitHub Release contains many executables, but in practice, you likely want one of these:

- macOS
  - Apple Silicon/arm64: `codex-aarch64-apple-darwin.tar.gz`
  - x86_64 (older Mac hardware): `codex-x86_64-apple-darwin.tar.gz`
- Linux
  - x86_64: `codex-x86_64-unknown-linux-musl.tar.gz`
  - arm64: `codex-aarch64-unknown-linux-musl.tar.gz`

Each archive contains a single entry with the platform baked into the name (e.g., `codex-x86_64-unknown-linux-musl`), so you likely want to rename it to `codex` after extracting it.

</details>

### Using Codex with your ChatGPT plan

Run `codex` and select **Sign in with ChatGPT**. We recommend signing into your ChatGPT account to use Codex as part of your Plus, Pro, Business, Edu, or Enterprise plan. [Learn more about what's included in your ChatGPT plan](https://help.openai.com/en/articles/11369540-codex-in-chatgpt).

You can also use Codex with an API key, but this requires [additional setup](https://developers.openai.com/codex/auth#sign-in-with-an-api-key).

## Docs

- [**Codex Documentation**](https://developers.openai.com/codex)
- [**Contributing**](./docs/contributing.md)
- [**Installing & building**](./docs/install.md)
- [**Open source fund**](./docs/open-source-fund.md)

This repository is licensed under the [Apache-2.0 License](LICENSE).
