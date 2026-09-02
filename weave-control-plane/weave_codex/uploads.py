"""Bounded local attachments for the loopback Weave workspace."""

from __future__ import annotations

import base64
import binascii
import secrets
import shutil
from pathlib import Path
from typing import Any

MAX_FILES = 8
MAX_FILE_BYTES = 4 * 1024 * 1024
MAX_TOTAL_BYTES = 12 * 1024 * 1024


def _safe_name(value: Any) -> str:
    name = str(value or "").strip()
    if (
        not name
        or name in {".", ".."}
        or len(name) > 160
        or "/" in name
        or "\\" in name
        or "\x00" in name
        or Path(name).name != name
    ):
        raise ValueError("attachment name must be a plain file name")
    return name


def store_local_uploads(root: Path, payload: dict[str, Any]) -> dict[str, Any]:
    """Validate a complete batch before writing it under the local data directory."""

    raw_files = payload.get("files")
    if not isinstance(raw_files, list) or not raw_files:
        raise ValueError("choose at least one file")
    if len(raw_files) > MAX_FILES:
        raise ValueError(f"choose at most {MAX_FILES} files")

    decoded: list[tuple[str, bytes]] = []
    names: set[str] = set()
    total = 0
    for item in raw_files:
        if not isinstance(item, dict):
            raise ValueError("each attachment must be an object")
        name = _safe_name(item.get("name"))
        folded = name.casefold()
        if folded in names:
            raise ValueError("attachment names must be unique")
        names.add(folded)
        encoded = item.get("contentBase64")
        if not isinstance(encoded, str):
            raise ValueError("attachment content must be base64 text")
        try:
            content = base64.b64decode(encoded, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise ValueError(f"attachment {name} is not valid base64") from exc
        if len(content) > MAX_FILE_BYTES:
            raise ValueError(f"attachment {name} exceeds the 4 MB limit")
        total += len(content)
        if total > MAX_TOTAL_BYTES:
            raise ValueError("attachments exceed the 12 MB batch limit")
        decoded.append((name, content))

    upload_id = f"upload-{secrets.token_hex(8)}"
    upload_root = root.resolve()
    batch = upload_root / upload_id
    batch.mkdir(parents=True, exist_ok=False)
    try:
        files: list[dict[str, Any]] = []
        for name, content in decoded:
            path = batch / name
            path.write_bytes(content)
            files.append({"name": name, "path": str(path), "size": len(content)})
    except OSError:
        shutil.rmtree(batch, ignore_errors=True)
        raise
    return {
        "uploadId": upload_id,
        "files": files,
        "totalBytes": total,
        "privacy": "stored only in the local Weave data directory",
    }
