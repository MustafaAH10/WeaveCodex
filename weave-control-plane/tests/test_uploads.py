from __future__ import annotations

import base64
from pathlib import Path

import pytest

from weave_codex.uploads import MAX_FILE_BYTES, store_local_uploads


def encoded(name: str, content: bytes) -> dict[str, str]:
    return {"name": name, "contentBase64": base64.b64encode(content).decode()}


def test_store_local_uploads_writes_an_immutable_local_batch(tmp_path: Path) -> None:
    result = store_local_uploads(
        tmp_path / "uploads",
        {"files": [encoded("brief.txt", b"local context"), encoded("table.csv", b"a,b\n1,2\n")]},
    )

    assert result["privacy"] == "stored only in the local Weave data directory"
    assert result["totalBytes"] == 21
    assert [item["name"] for item in result["files"]] == ["brief.txt", "table.csv"]
    assert Path(result["files"][0]["path"]).read_bytes() == b"local context"
    assert Path(result["files"][1]["path"]).read_bytes() == b"a,b\n1,2\n"


@pytest.mark.parametrize("name", ["../secret", "folder/file", "folder\\file", "", ".."])
def test_store_local_uploads_rejects_unsafe_names(tmp_path: Path, name: str) -> None:
    with pytest.raises(ValueError, match="plain file name"):
        store_local_uploads(tmp_path, {"files": [encoded(name, b"x")]})
    assert not tmp_path.exists() or not any(tmp_path.iterdir())


def test_store_local_uploads_rejects_invalid_or_oversize_content(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="valid base64"):
        store_local_uploads(tmp_path, {"files": [{"name": "bad.txt", "contentBase64": "***"}]})
    with pytest.raises(ValueError, match="4 MB"):
        store_local_uploads(
            tmp_path,
            {"files": [encoded("large.bin", b"x" * (MAX_FILE_BYTES + 1))]},
        )
    assert not tmp_path.exists() or not any(tmp_path.iterdir())


def test_store_local_uploads_rejects_case_insensitive_duplicate_names(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="unique"):
        store_local_uploads(
            tmp_path,
            {"files": [encoded("Brief.txt", b"one"), encoded("brief.TXT", b"two")]},
        )
    assert not tmp_path.exists() or not any(tmp_path.iterdir())
