# Contributing to WeaveCodex

WeaveCodex is an independent downstream built around the open-source Codex
runtime. Product changes should normally stay inside `weave-control-plane/`.
Changes to the imported Codex tree require a clear upstream reason and a note
in `UPSTREAM.md` so the next upstream sync remains auditable.

## Local checks

From `weave-control-plane/`:

```bash
uv sync --frozen
uv run ruff check .
uv run ruff format --check .
uv run pytest
node --check weave_codex/static/home.js
node --check ../public-site/site.js
node --test ../public-site/tests/site.test.mjs
uv run python scripts/check_public_release.py
git diff --check
```

Run the server only on loopback during development:

```bash
uv run python -m weave_codex.server \
  --codex-bin "$(command -v codex)" \
  --host 127.0.0.1 \
  --port 8790
```

Never commit a Codex login cache, API key, `.env` file, raw private thread, or
unredacted model trace. Tests should use fixtures or explicitly sanitized
receipts. A contribution must not weaken Codex sandbox or approval settings.

## Product boundary

A Weave Work phase represents a goal handed to the native Codex loop. It does
not represent one model call or one tool call. Keep that boundary intact when
adding visualizations or execution features.

The local HTTP server is not a multi-user security boundary. Do not expose it
directly to the public internet. Use a separate sanitized, read-only results
surface for demonstrations.

## Public website and local app

These are deliberately separate products:

- `public-site/` is an independently deployable static marketing website. It has no account,
  filesystem, Codex, or local API access. Preview it with
  `python3 -m http.server 8789 --directory public-site` from the repository root.
- `weave-control-plane/weave_codex/static/` is the functional loopback application. It may access
  Codex and a user-selected workspace through the local control-plane server, and must remain bound
  to `127.0.0.1`, `localhost`, or `::1`.

Do not add authenticated or filesystem-backed behavior to the public website.
