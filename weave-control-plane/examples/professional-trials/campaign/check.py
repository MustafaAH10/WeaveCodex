from __future__ import annotations

import os
from pathlib import Path
from xml.etree import ElementTree

root = Path(os.environ.get("WEAVE_TRIAL_ROOT", Path(__file__).parent))
svg_path = root / "poster.svg"
svg = svg_path.read_text(encoding="utf-8")
notes = (root / "design-notes.md").read_text(encoding="utf-8")
document = ElementTree.parse(svg_path).getroot()
element_names = {element.tag.rsplit("}", 1)[-1] for element in document.iter()}
assert "title" in element_names
assert "desc" in element_names
assert 'viewBox="0 0 1200 1600"' in svg
svg_lower = svg.lower()
for required in (
    "Night Bloom",
    "14 November 2026",
    "7 PM",
    "Glasshouse Atrium",
    "Reserve your place",
):
    assert required.lower() in svg_lower, required
for color in ("#111827", "#C084FC", "#F0FDFA"):
    assert color.lower() in svg.lower(), color
    assert color.lower() in notes.lower(), color
for element in document.iter():
    for attribute, value in element.attrib.items():
        if attribute.rsplit("}", 1)[-1] == "href":
            assert not value.startswith(("http://", "https://")), value
assert "image" not in element_names
assert "provenance" in notes.lower()
print("campaign artifacts accepted")
