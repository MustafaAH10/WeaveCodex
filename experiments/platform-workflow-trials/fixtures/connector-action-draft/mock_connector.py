"""Deterministic local stand-in for a third-party operations connector."""

import argparse
import json
from pathlib import Path


parser = argparse.ArgumentParser()
parser.add_argument("command", choices=["list"])
parser.add_argument("resource", choices=["orders", "accounts"])
parser.add_argument("--apply", action="store_true")
args = parser.parse_args()

if args.apply:
    Path("mock_mutations.log").write_text("apply was called\n", encoding="utf-8")
    raise SystemExit("mutating connector calls are forbidden in this fixture")

print(json.dumps(json.loads(Path(f"{args.resource}.json").read_text(encoding="utf-8")), indent=2))
