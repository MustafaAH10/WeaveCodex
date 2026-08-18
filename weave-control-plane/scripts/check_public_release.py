"""Fail closed on credential-shaped files and missing public release contracts."""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CONTROL_PLANE = ROOT / "weave-control-plane"
REQUIRED_FILES = (
    ROOT / "LICENSE",
    ROOT / "README.md",
    CONTROL_PLANE / "CONTRIBUTING.md",
    CONTROL_PLANE / "SECURITY.md",
    CONTROL_PLANE / "UPSTREAM.md",
)
FORBIDDEN_NAMES = {".env", "auth.json", "credentials.json", "service-account.json"}
SECRET_PATTERNS = (
    re.compile(rb"sk-proj-[A-Za-z0-9_-]{20,}"),
    re.compile(rb"ghp_[A-Za-z0-9]{30,}"),
    re.compile(rb"github_pat_[A-Za-z0-9_]{30,}"),
)


def tracked_paths() -> list[Path]:
    result = subprocess.run(
        ["git", "ls-files", "-z"],
        cwd=ROOT,
        check=True,
        capture_output=True,
    )
    return [ROOT / item.decode() for item in result.stdout.split(b"\0") if item]


def main() -> None:
    missing = [str(path.relative_to(ROOT)) for path in REQUIRED_FILES if not path.is_file()]
    if missing:
        raise SystemExit(f"missing public release files: {', '.join(missing)}")

    findings: list[str] = []
    for path in tracked_paths():
        relative = path.relative_to(ROOT)
        downstream = (
            relative.parts[0] in {"weave-control-plane", ".github"} or len(relative.parts) == 1
        )
        if path.name in FORBIDDEN_NAMES:
            findings.append(f"credential-shaped tracked path: {relative}")
            continue
        # The pinned upstream tree contains public test certificates and
        # credential-shaped parser fixtures. Scan downstream release material
        # for those patterns without misclassifying upstream test data.
        if downstream and path.suffix in {".pem", ".p12", ".pfx"}:
            findings.append(f"credential-shaped tracked path: {relative}")
            continue
        if not downstream:
            continue
        if not path.is_file() or path.stat().st_size > 2_000_000:
            continue
        data = path.read_bytes()
        for pattern in SECRET_PATTERNS:
            if pattern.search(data):
                findings.append(f"secret-shaped content: {relative}")
                break

    if findings:
        raise SystemExit("\n".join(findings))
    print(f"public release surface verified across {len(tracked_paths())} tracked paths")


if __name__ == "__main__":
    main()
