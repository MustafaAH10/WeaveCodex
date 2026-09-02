from __future__ import annotations

import importlib.util
import os
import shutil
import subprocess
import sys
from pathlib import Path

from weave_codex.manifest import HarnessManifest, compile_manifest

SCRIPT = Path(__file__).parents[1] / "scripts/run_professional_workflows.py"
SPEC = importlib.util.spec_from_file_location("run_professional_workflows", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def test_four_professional_trials_are_bounded_and_use_real_fixture_checks(tmp_path: Path) -> None:
    assert [trial["id"] for trial in MODULE.TRIALS] == [
        "finance-variance",
        "campaign-poster",
        "crm-shortlist",
        "renewal-triage",
    ]
    for trial in MODULE.TRIALS:
        fixture = MODULE.FIXTURES / trial["fixture"]
        manifest = HarnessManifest.model_validate(
            MODULE.trial_manifest(trial, tmp_path / trial["id"])
        )
        compiled = compile_manifest(manifest)
        assert fixture.is_dir()
        assert (fixture / "check.py").is_file()
        assert compiled["maximumTurns"] == 4
        assert compiled["executionOrder"] == [
            trial["work"][0][0],
            "calibrate",
            trial["work"][1][0],
            "exact-check",
            "final-review",
        ]
        assert manifest.memory.mode == "off"
        assert manifest.agent.reasoning_effort == "low"


def test_fixture_acceptance_checks_reject_missing_outputs(tmp_path: Path) -> None:
    for trial in MODULE.TRIALS:
        fixture = MODULE.FIXTURES / trial["fixture"]
        assert not any(
            path.name in {"analysis.csv", "poster.svg", "shortlist.md", "renewal-plan.csv"}
            for path in fixture.iterdir()
        )


def test_semantic_checkers_accept_valid_wording_and_svg_metadata(tmp_path: Path) -> None:
    finance = tmp_path / "finance"
    shutil.copytree(MODULE.FIXTURES / "finance", finance)
    (finance / "analysis.csv").write_text(
        "account,actual,budget,variance,material\n"
        "Revenue,125000,120000,5000,true\n"
        "COGS,-62000,-60000,-2000,true\n"
        "Payroll,-34000,-33000,-1000,false\n"
        "Marketing,-9500,-7000,-2500,true\n",
        encoding="utf-8",
    )
    (finance / "cfo-brief.md").write_text(
        "Revenue 19,500 20,000 COGS Marketing. The source does not identify the cause.\n",
        encoding="utf-8",
    )

    campaign = tmp_path / "campaign"
    shutil.copytree(MODULE.FIXTURES / "campaign", campaign)
    (campaign / "poster.svg").write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 1600">'
        '<title id="poster-title">Night Bloom</title><desc id="poster-desc">Poster</desc>'
        '<rect fill="#111827"/><text fill="#C084FC">NIGHT BLOOM</text>'
        '<text fill="#F0FDFA">14 November 2026 7 PM Glasshouse Atrium '
        "RESERVE YOUR PLACE</text></svg>\n",
        encoding="utf-8",
    )
    (campaign / "design-notes.md").write_text(
        "Palette #111827 #C084FC #F0FDFA. Provenance: original inline vector artwork.\n",
        encoding="utf-8",
    )

    for fixture, checker in (
        (finance, MODULE.FIXTURES / "finance/check.py"),
        (campaign, MODULE.FIXTURES / "campaign/check.py"),
    ):
        result = subprocess.run(
            [sys.executable, str(checker)],
            capture_output=True,
            check=False,
            env={**os.environ, "WEAVE_TRIAL_ROOT": str(fixture)},
            text=True,
        )
        assert result.returncode == 0, result.stderr
