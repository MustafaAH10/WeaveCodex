# Source provenance

This repository is an independent downstream import, not a GitHub fork.

- Upstream: `https://github.com/openai/codex.git`
- Pinned upstream commit: `9ded177ce7c1c0bd2047f902936c177612ab3434`
- Pinned upstream tree: `80af093a595d2e4a0b45dd666f5390e9dbad5d98`
- Local import commits: `889cf63`, followed by `34998ea`
- License and notice: the upstream `LICENSE` and `NOTICE` remain at the repository root.

At commit `34998ea`, `git rev-parse HEAD^{tree}` equals the pinned upstream tree. The import was
squashed so the downstream control-plane history remains separate from upstream Codex. The
`upstream` remote still points to OpenAI so future updates can be fetched and reviewed.

To inspect drift without merging it:

```bash
git fetch upstream main
git diff --stat main..upstream/main
```

Do not merge upstream blindly. Re-run the control-plane tests and re-check app-server schemas first.
