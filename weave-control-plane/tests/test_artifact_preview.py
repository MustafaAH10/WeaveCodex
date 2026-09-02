from __future__ import annotations

import os
import zipfile
from pathlib import Path

import pytest

from weave_codex.artifact_preview import (
    discover_run_artifacts,
    preview_run_artifact,
    resolve_run_artifact,
)


def receipt(root: Path) -> dict:
    return {
        "startedAt": 100,
        "completedAt": 200,
        "finalResponse": "",
        "observed": {"completedItemsByType": {"fileChange": 1}},
        "phaseProgram": {
            "executions": [{"io": {"context": {"workspace": str(root)}, "output": ""}}]
        },
    }


def touch_during_run(path: Path) -> None:
    os.utime(path, (150, 150))


def write_small_xlsx(path: Path) -> None:
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr(
            "xl/workbook.xml",
            '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
            'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
            '<sheets><sheet name="Summary" sheetId="1" r:id="rId1"/></sheets></workbook>',
        )
        archive.writestr(
            "xl/_rels/workbook.xml.rels",
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
        )
        archive.writestr(
            "xl/worksheets/sheet1.xml",
            '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
            '<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Account</t></is></c>'
            '<c r="B1" t="inlineStr"><is><t>Variance</t></is></c></row>'
            '<row r="2"><c r="A2" t="inlineStr"><is><t>Revenue</t></is></c>'
            '<c r="B2"><v>5000</v></c></row></sheetData></worksheet>',
        )


def test_discovers_only_files_changed_during_the_run(tmp_path: Path) -> None:
    output = tmp_path / "analysis.csv"
    output.write_text("account,variance\nRevenue,5000\n", encoding="utf-8")
    touch_during_run(output)
    source = tmp_path / "source.csv"
    source.write_text("account,actual\nRevenue,125000\n", encoding="utf-8")
    os.utime(source, (50, 50))
    secret = tmp_path / ".env"
    secret.write_text("TOKEN=private", encoding="utf-8")
    touch_during_run(secret)

    result = discover_run_artifacts(receipt(tmp_path))

    assert [item["path"] for item in result["artifacts"]] == ["analysis.csv"]
    assert result["artifacts"][0]["kind"] == "table"


def test_previews_csv_and_xlsx_as_bounded_tables(tmp_path: Path) -> None:
    table = tmp_path / "analysis.csv"
    table.write_text("account,variance\nRevenue,5000\nCOGS,-2000\n", encoding="utf-8")
    touch_during_run(table)
    workbook = tmp_path / "finance.xlsx"
    write_small_xlsx(workbook)
    touch_during_run(workbook)
    run = receipt(tmp_path)

    csv_preview = preview_run_artifact(run, "analysis.csv")
    xlsx_preview = preview_run_artifact(run, "finance.xlsx")

    assert csv_preview["columns"] == ["account", "variance"]
    assert csv_preview["rows"][0] == ["Revenue", "5000"]
    assert xlsx_preview["sheets"] == ["Summary"]
    assert xlsx_preview["columns"] == ["Account", "Variance"]
    assert xlsx_preview["rows"] == [["Revenue", "5000"]]


def test_rejects_traversal_and_files_not_bound_to_the_run(tmp_path: Path) -> None:
    output = tmp_path / "result.md"
    output.write_text("done", encoding="utf-8")
    touch_during_run(output)
    run = receipt(tmp_path)

    assert resolve_run_artifact(run, "result.md") == output
    with pytest.raises(ValueError, match="relative"):
        resolve_run_artifact(run, str(output))
    with pytest.raises(ValueError, match="not part"):
        resolve_run_artifact(run, "../secret.txt")


def test_shared_workspace_does_not_claim_concurrent_files_without_a_recorded_change(
    tmp_path: Path,
) -> None:
    output = tmp_path / "somebody-elses-edit.md"
    output.write_text("not created by this run", encoding="utf-8")
    touch_during_run(output)

    run = receipt(tmp_path)
    run["observed"]["completedItemsByType"] = {}
    result = discover_run_artifacts(run)

    assert result["artifacts"] == []
