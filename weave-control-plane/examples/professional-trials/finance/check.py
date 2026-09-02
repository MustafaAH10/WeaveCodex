from __future__ import annotations

import csv
import os
from pathlib import Path

root = Path(os.environ.get("WEAVE_TRIAL_ROOT", Path(__file__).parent))
expected = {
    "Revenue": (125000, 120000, 5000, "true"),
    "COGS": (-62000, -60000, -2000, "true"),
    "Payroll": (-34000, -33000, -1000, "false"),
    "Marketing": (-9500, -7000, -2500, "true"),
}
with (root / "analysis.csv").open(newline="", encoding="utf-8") as handle:
    rows = list(csv.DictReader(handle))
observed = {
    row["account"]: (
        int(row["actual"]),
        int(row["budget"]),
        int(row["variance"]),
        row["material"].strip().lower(),
    )
    for row in rows
}
assert observed == expected, observed
brief = (root / "cfo-brief.md").read_text(encoding="utf-8")
for value in ("19,500", "20,000", "Revenue", "COGS", "Marketing"):
    assert value in brief, value
brief_lower = brief.lower()
assert any(
    phrase in brief_lower
    for phrase in (
        "unknown",
        "not provided",
        "does not identify the cause",
        "cause is not identified",
    )
), "unsupported causes must remain explicitly unidentified"
print("finance artifacts accepted")
