# WeaveCodex public site

This folder is the independently deployable promotional website. It is intentionally separate from
the local workflow studio in `weave-control-plane/weave_codex/static/`.

Preview the marketing site on its own:

```bash
python3 -m http.server 8789 --directory public-site
```

Then open <http://127.0.0.1:8789/>. The functional app remains a separate process at
<http://127.0.0.1:8790/> and continues to own all account, filesystem, workflow, and run APIs. The
public site neither opens nor depends on that private local address. It can be deployed by itself.

The site has no build step, third-party scripts, remote fonts, or copied brand assets. Its visual
system, workflow illustrations, and animation are implemented in local HTML, CSS, SVG, and
JavaScript.

The side-by-side execution examples are concise visualizations of the tracked acceptance trials in
`experiments/platform-workflow-trials/results-v2/`. Both Codex and WeaveCodex artifacts passed the
declared graders. The comparison demonstrates visible calibration, drift control, and evidence. It
does not claim a model-quality or efficiency advantage.

## Design provenance

The visual direction takes high-level inspiration from [pi.dev](https://pi.dev/): one clear thesis,
editorial type contrast, generous whitespace, restrained navigation, and a live product proof
instead of a long feature grid. The WeaveCodex identity, copy, canvas diagrams, node system, mark,
color palette, and animations are original and use no Pi code or assets.
