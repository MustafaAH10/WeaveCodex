from __future__ import annotations

import csv
from pathlib import Path

root = Path(__file__).parent
with (root / "renewal-plan.csv").open(newline="", encoding="utf-8") as handle:
    rows = {row["account_id"]: row for row in csv.DictReader(handle)}
assert set(rows) == {"ACC-101", "ACC-102", "ACC-103", "ACC-104"}
assert rows["ACC-101"]["action"] == "recovery_plan"
assert rows["ACC-102"]["action"] == "expansion_review"
assert rows["ACC-103"]["action"] == "escalation_only"
assert rows["ACC-104"]["action"] == "monitor"
for row in rows.values():
    assert row.get("policy_rule", "").strip()
note = (root / "team-note.md").read_text(encoding="utf-8")
assert "ACC-103" in note and "severity" in note.lower()
print("customer operations artifacts accepted")
