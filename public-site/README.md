# WeaveCodex public site

This folder is the independently deployable promotional website. It is intentionally separate from
the local workflow studio in `weave-control-plane/weave_codex/static/`.

Preview the marketing site on its own:

```bash
python3 -m http.server 8789 --directory public-site
```

Then open <http://127.0.0.1:8789/>. The functional app remains a separate process at
<http://127.0.0.1:8790/> and continues to own all account, filesystem, workflow, and run APIs. The
public site can link to that local address for people who have already started the app, but it does
not depend on the app server and can be deployed by itself.

The site has no build step, third-party scripts, remote fonts, or copied brand assets. Its visual
system, workflow illustrations, and animation are implemented in local HTML, CSS, SVG, and
JavaScript.

## Design provenance

The visual direction takes high-level inspiration from [pi.dev](https://pi.dev/): one clear thesis,
editorial type contrast, generous whitespace, restrained navigation, and a live product proof
instead of a long feature grid. The WeaveCodex identity, copy, canvas diagrams, node system, mark,
color palette, and animations are original and use no Pi code or assets.
