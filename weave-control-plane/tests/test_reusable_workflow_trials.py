from __future__ import annotations

from pathlib import Path

from weave_codex.reusable_workflow_trials import TARGETS, programs_for, public_design
from weave_codex.workflow_adaptation import validate_goal_only_adaptation


def test_three_programs_preserve_structure_but_change_task_specific_wording() -> None:
    assert len(TARGETS) == 3
    hashes: set[str] = set()
    for trial in TARGETS:
        source, derived = programs_for(trial)
        assert [(item.id, item.kind) for item in source.phases] == [
            (item.id, item.kind) for item in derived.phases
        ]
        assert validate_goal_only_adaptation(source, derived)
        design = public_design(trial)
        assert design["structurePreserved"] is True
        assert design["sourceProgramHash"] != design["derivedProgramHash"]
        hashes.add(design["sourceProgramHash"])
    assert len(hashes) == 3


def test_target_repositories_are_distinct_pinned_and_memory_contract_is_external() -> None:
    assert {trial.target.directory for trial in TARGETS} == {"typer", "httpx", "fastify"}
    assert all(len(trial.target_commit) == 40 for trial in TARGETS)
    assert all(trial.target.artifact.startswith(".weave/evidence/") for trial in TARGETS)


def test_runner_is_explicitly_gated() -> None:
    script = Path(__file__).parents[1] / "scripts/run_reusable_workflow_trial.py"
    source = script.read_text(encoding="utf-8")
    assert "--confirm-one-run" in source
    assert 'memory": "off"' in source
    assert "session.decide" in source

    launcher = Path(__file__).parents[1] / "scripts/launch_reusable_workflow_runloop.py"
    launch_source = launcher.read_text(encoding="utf-8")
    assert "--confirm-three-sandboxes" in launch_source
    assert "await box.shutdown()" in launch_source
    assert "await sdk.secret.delete(secret)" in launch_source
    assert "PYTHONPATH=. uv run python scripts/run_reusable_workflow_trial.py" in launch_source
