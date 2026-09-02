"""Discover and safely preview files produced during a recorded Codex run."""

from __future__ import annotations

import csv
import io
import json
import mimetypes
import os
import posixpath
import re
import zipfile
from pathlib import Path
from typing import Any
from xml.etree import ElementTree

_IGNORED_PARTS = {
    ".git",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    ".venv",
    ".weave-codex",
    "__pycache__",
    "build",
    "dist",
    "node_modules",
    "target",
}
_SENSITIVE_NAMES = {
    ".env",
    "auth.json",
    "credentials.json",
    "id_rsa",
    "id_ed25519",
}
_IMAGE_SUFFIXES = {".gif", ".jpeg", ".jpg", ".png", ".svg", ".webp"}
_SPREADSHEET_SUFFIXES = {".xlsx", ".xlsm"}
_TABLE_SUFFIXES = {".csv", ".tsv"}
_TEXT_SUFFIXES = {
    ".css",
    ".html",
    ".ini",
    ".js",
    ".json",
    ".jsx",
    ".log",
    ".md",
    ".mjs",
    ".py",
    ".rst",
    ".toml",
    ".ts",
    ".tsx",
    ".txt",
    ".xml",
    ".yaml",
    ".yml",
}
_MEDIA_SUFFIXES = {".m4a", ".mov", ".mp3", ".mp4", ".ogg", ".wav", ".webm"}
_MAX_DISCOVERED = 48
_MAX_SCAN = 12_000
_MAX_PREVIEW_BYTES = 512 * 1024
_MAX_RAW_BYTES = 32 * 1024 * 1024


def _run_workspace(receipt: dict[str, Any]) -> Path:
    workspaces = {
        str((execution.get("io") or {}).get("context", {}).get("workspace", "")).strip()
        for execution in (receipt.get("phaseProgram") or {}).get("executions", [])
    }
    workspaces.discard("")
    if len(workspaces) == 1:
        candidate = Path(workspaces.pop()).expanduser()
    else:
        trace_root = Path(str(receipt.get("traceRoot", ""))).expanduser()
        if trace_root.name != "traces" or trace_root.parent.name != ".weave-codex":
            raise ValueError("this run does not contain a usable workspace reference")
        candidate = trace_root.parent.parent
    resolved = candidate.resolve(strict=True)
    if not resolved.is_dir() or resolved == Path(resolved.anchor):
        raise ValueError("this run does not contain a usable workspace reference")
    return resolved


def _sensitive(path: Path) -> bool:
    lowered = path.name.lower()
    return (
        lowered in _SENSITIVE_NAMES
        or lowered.startswith(".env.")
        or "credential" in lowered
        or lowered.endswith((".key", ".pem", ".p12", ".pfx"))
    )


def _kind(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix in _IMAGE_SUFFIXES:
        return "image"
    if suffix in _SPREADSHEET_SUFFIXES:
        return "spreadsheet"
    if suffix in _TABLE_SUFFIXES:
        return "table"
    if suffix == ".pdf":
        return "pdf"
    if suffix in _MEDIA_SUFFIXES:
        return "media"
    if suffix in _TEXT_SUFFIXES:
        return "text"
    return "file"


def _candidate_paths(receipt: dict[str, Any], root: Path) -> set[Path]:
    candidates: set[Path] = set()
    start = float(receipt.get("startedAt") or 0) - 2
    end = float(receipt.get("completedAt") or receipt.get("startedAt") or 0) + 2
    completed_types = (receipt.get("observed") or {}).get("completedItemsByType", {})
    recorded_file_changes = int(
        completed_types.get("fileChange", 0) or completed_types.get("file_change", 0) or 0
    )
    isolated_workspace = ".weave-codex" in root.parts
    scan_root = root if isolated_workspace or recorded_file_changes else root / ".weave-no-scan"
    scanned = 0
    for directory, names, files in os.walk(scan_root):
        names[:] = sorted(name for name in names if name not in _IGNORED_PARTS)
        for name in sorted(files):
            scanned += 1
            if scanned > _MAX_SCAN:
                break
            path = Path(directory, name)
            relative = path.relative_to(root)
            if _sensitive(path) or any(part in _IGNORED_PARTS for part in relative.parts):
                continue
            try:
                stat = path.stat()
            except OSError:
                continue
            if path.is_symlink() or not path.is_file() or stat.st_size > _MAX_RAW_BYTES:
                continue
            if start <= stat.st_mtime <= end:
                candidates.add(path.resolve())
        if scanned > _MAX_SCAN:
            break

    visible_text = [str(receipt.get("finalResponse", ""))]
    visible_text.extend(
        str((execution.get("io") or {}).get("output", ""))
        for execution in (receipt.get("phaseProgram") or {}).get("executions", [])
    )
    for text in visible_text:
        for raw_path in re.findall(r"\]\((/[^)\n]+)\)", text):
            try:
                path = Path(raw_path).resolve(strict=True)
                path.relative_to(root)
                stat = path.stat()
            except (OSError, ValueError):
                continue
            if (
                path.is_file()
                and not path.is_symlink()
                and not _sensitive(path)
                and start <= stat.st_mtime <= end
                and stat.st_size <= _MAX_RAW_BYTES
            ):
                candidates.add(path)
    return candidates


def discover_run_artifacts(receipt: dict[str, Any]) -> dict[str, Any]:
    """Return bounded metadata for files created or changed during the run."""

    root = _run_workspace(receipt)
    items: list[dict[str, Any]] = []
    for path in _candidate_paths(receipt, root):
        try:
            relative = path.relative_to(root).as_posix()
            stat = path.stat()
        except (OSError, ValueError):
            continue
        kind = _kind(path)
        mime_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        items.append(
            {
                "name": path.name,
                "path": relative,
                "kind": kind,
                "mimeType": mime_type,
                "size": stat.st_size,
                "modifiedAt": int(stat.st_mtime),
                "previewable": kind != "file",
            }
        )
    priority = {
        "spreadsheet": 0,
        "table": 1,
        "image": 2,
        "pdf": 3,
        "media": 4,
        "text": 5,
        "file": 6,
    }
    items.sort(key=lambda item: (priority[item["kind"]], item["path"].lower()))
    return {
        "workspace": root.name,
        "artifacts": items[:_MAX_DISCOVERED],
        "truncated": len(items) > _MAX_DISCOVERED,
        "privacy": "Only files created or changed during this run are shown.",
    }


def resolve_run_artifact(receipt: dict[str, Any], relative_path: str) -> Path:
    """Resolve a requested path only when it belongs to the discovered run outputs."""

    if not relative_path or "\x00" in relative_path or Path(relative_path).is_absolute():
        raise ValueError("artifact path must be a relative path")
    allowed = {item["path"] for item in discover_run_artifacts(receipt)["artifacts"]}
    if relative_path not in allowed:
        raise ValueError("artifact is not part of this run")
    root = _run_workspace(receipt)
    path = (root / relative_path).resolve(strict=True)
    path.relative_to(root)
    if path.is_symlink() or not path.is_file():
        raise ValueError("artifact is not a regular file")
    return path


def read_run_artifact(receipt: dict[str, Any], relative_path: str) -> tuple[Path, bytes]:
    path = resolve_run_artifact(receipt, relative_path)
    if path.stat().st_size > _MAX_RAW_BYTES:
        raise ValueError("artifact exceeds the 32 MB viewing limit")
    return path, path.read_bytes()


def _clip(value: Any, limit: int = 500) -> str:
    text = "" if value is None else str(value)
    return text if len(text) <= limit else f"{text[: limit - 1]}…"


def _table_preview(path: Path) -> dict[str, Any]:
    raw = path.read_text(encoding="utf-8-sig", errors="replace")
    delimiter = "\t" if path.suffix.lower() == ".tsv" else ","
    rows = list(csv.reader(io.StringIO(raw), delimiter=delimiter))
    width = min(max((len(row) for row in rows), default=0), 30)
    clipped = [[_clip(value) for value in row[:width]] for row in rows[:61]]
    return {
        "kind": "table",
        "columns": clipped[0] if clipped else [],
        "rows": clipped[1:] if clipped else [],
        "rowCount": max(0, len(rows) - 1),
        "columnCount": width,
        "truncated": len(rows) > 61 or any(len(row) > width for row in rows),
    }


def _shared_strings(archive: zipfile.ZipFile) -> list[str]:
    try:
        root = ElementTree.fromstring(archive.read("xl/sharedStrings.xml"))
    except KeyError:
        return []
    return [
        "".join(node.text or "" for node in item.iter() if node.tag.endswith("}t")) for item in root
    ]


def _column_index(reference: str) -> int:
    letters = re.match(r"[A-Z]+", reference.upper())
    if not letters:
        return 0
    value = 0
    for letter in letters.group(0):
        value = value * 26 + ord(letter) - 64
    return max(0, value - 1)


def _xlsx_preview(path: Path, requested_sheet: str | None) -> dict[str, Any]:
    with zipfile.ZipFile(path) as archive:
        workbook = ElementTree.fromstring(archive.read("xl/workbook.xml"))
        relationships = ElementTree.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
        relationship_targets = {
            item.attrib["Id"]: item.attrib["Target"]
            for item in relationships
            if "Id" in item.attrib
        }
        sheets: list[tuple[str, str]] = []
        for item in workbook.iter():
            if not item.tag.endswith("}sheet"):
                continue
            relation_id = item.attrib.get(
                "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"
            )
            if relation_id and relation_id in relationship_targets:
                target = relationship_targets[relation_id].lstrip("/")
                if not target.startswith("xl/"):
                    target = posixpath.normpath(posixpath.join("xl", target))
                sheets.append((item.attrib.get("name", "Sheet"), target))
        if not sheets:
            raise ValueError("workbook contains no readable sheets")
        selected = next((item for item in sheets if item[0] == requested_sheet), sheets[0])
        sheet_root = ElementTree.fromstring(archive.read(selected[1]))
        shared = _shared_strings(archive)
        values: dict[tuple[int, int], str] = {}
        max_row = 0
        max_col = 0
        for cell in (item for item in sheet_root.iter() if item.tag.endswith("}c")):
            reference = cell.attrib.get("r", "A1")
            row_match = re.search(r"\d+", reference)
            row_index = max(0, int(row_match.group(0)) - 1) if row_match else 0
            col_index = _column_index(reference)
            if row_index >= 61 or col_index >= 30:
                continue
            cell_type = cell.attrib.get("t")
            value_node = next((item for item in cell if item.tag.endswith("}v")), None)
            if cell_type == "inlineStr":
                value = "".join(node.text or "" for node in cell.iter() if node.tag.endswith("}t"))
            else:
                value = value_node.text if value_node is not None else ""
                if cell_type == "s" and value:
                    index = int(value)
                    value = shared[index] if index < len(shared) else value
                elif cell_type == "b":
                    value = "TRUE" if value == "1" else "FALSE"
            values[(row_index, col_index)] = _clip(value)
            max_row = max(max_row, row_index)
            max_col = max(max_col, col_index)
        grid = [
            [values.get((row, column), "") for column in range(max_col + 1)]
            for row in range(max_row + 1)
        ]
        return {
            "kind": "spreadsheet",
            "sheets": [name for name, _ in sheets],
            "sheet": selected[0],
            "columns": grid[0] if grid else [],
            "rows": grid[1:] if grid else [],
            "rowCount": max(0, max_row),
            "columnCount": max_col + 1,
            "truncated": max_row >= 60 or max_col >= 29,
        }


def preview_run_artifact(
    receipt: dict[str, Any], relative_path: str, *, sheet: str | None = None
) -> dict[str, Any]:
    """Return an inert JSON preview for a discovered run output."""

    path = resolve_run_artifact(receipt, relative_path)
    if path.stat().st_size > _MAX_PREVIEW_BYTES and _kind(path) in {"table", "text"}:
        raise ValueError("artifact exceeds the 512 KB text preview limit")
    kind = _kind(path)
    if kind == "table":
        value = _table_preview(path)
    elif kind == "spreadsheet":
        value = _xlsx_preview(path, sheet)
    elif kind == "text":
        raw = path.read_text(encoding="utf-8", errors="replace")
        if path.suffix.lower() == ".json":
            try:
                raw = json.dumps(json.loads(raw), indent=2, ensure_ascii=False)
            except json.JSONDecodeError:
                pass
        value = {"kind": "text", "text": raw[:_MAX_PREVIEW_BYTES]}
    else:
        value = {"kind": kind}
    return {"name": path.name, "path": relative_path, **value}
