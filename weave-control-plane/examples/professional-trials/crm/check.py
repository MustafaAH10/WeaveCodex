from __future__ import annotations

from pathlib import Path

text = (Path(__file__).parent / "shortlist.md").read_text(encoding="utf-8")
lower = text.lower()
assert "atlascrm" in lower and "northstar" in lower
assert "relayone" not in lower or "excluded" in lower or "reject" in lower
assert "ledgerlead" not in lower or "excluded" in lower or "reject" in lower
for term in ("sso", "eu data", "salesforce", "public api", "30", "60", "90"):
    assert term in lower, term
assert lower.count("unresolved") >= 2 or lower.count("open question") >= 2
print("crm artifacts accepted")
