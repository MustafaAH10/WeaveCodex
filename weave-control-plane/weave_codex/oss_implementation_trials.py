"""Frozen seeded-regression tasks for matched Codex and WeaveCodex trials.

The tasks in this module are product acceptance probes, not upstream bug reports.
Each task starts from an exact public commit and applies a small, declared regression
before either arm runs.
"""

from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .manifest import HarnessManifest


@dataclass(frozen=True)
class SeedEdit:
    path: str
    before: str
    after: str


@dataclass(frozen=True)
class OssImplementationTask:
    id: str
    title: str
    repository: str
    directory: str
    commit: str
    instructions: str
    target_paths: tuple[str, ...]
    context_paths: tuple[str, ...]
    seed_edits: tuple[SeedEdit, ...]
    upstream_test: tuple[str, ...]
    hidden_test: tuple[str, ...]
    phases: tuple[dict[str, Any], ...]


TASKS = (
    OssImplementationTask(
        id="jinja-autoescape-case",
        title="Restore Jinja autoescape case handling",
        repository="https://github.com/pallets/jinja",
        directory="jinja",
        commit="5ef70112a1ff19c05324ff889dd30405b1002044",
        instructions=(
            "A seeded regression in select_autoescape made extension matching case-sensitive. "
            "Restore the documented case-insensitive behavior for both configured extension "
            "names and incoming template filenames. Preserve handling of leading dots, None, "
            "and the existing defaults. Modify only the implementation required for the fix; "
            "do not edit tests. Run the focused upstream test before finishing."
        ),
        target_paths=("src/jinja2/utils.py",),
        context_paths=("src/jinja2/utils.py", "tests/test_utils.py"),
        seed_edits=(
            SeedEdit(
                path="src/jinja2/utils.py",
                before=(
                    "enabled_patterns = tuple(f\".{x.lstrip('.').lower()}\" "
                    "for x in enabled_extensions)\n"
                    "    disabled_patterns = tuple(f\".{x.lstrip('.').lower()}\" "
                    "for x in disabled_extensions)"
                ),
                after=(
                    "enabled_patterns = tuple(f\".{x.lstrip('.')}\" "
                    "for x in enabled_extensions)\n"
                    "    disabled_patterns = tuple(f\".{x.lstrip('.')}\" "
                    "for x in disabled_extensions)"
                ),
            ),
            SeedEdit(
                path="src/jinja2/utils.py",
                before="        template_name = template_name.lower()\n",
                after="",
            ),
        ),
        upstream_test=(
            "uv",
            "run",
            "--frozen",
            "pytest",
            "-q",
            "tests/test_utils.py",
            "-k",
            "autoescape_select",
        ),
        hidden_test=(
            "uv",
            "run",
            "--frozen",
            "python",
            "-c",
            (
                "from jinja2.utils import select_autoescape; "
                "f=select_autoescape(enabled_extensions=('HtMl',), "
                "disabled_extensions=('.TxT',), default='fallback'); "
                "assert f('INDEX.HTML') is True; assert f('notes.txt') is False; "
                "assert f('other.bin') == 'fallback'; assert f(None) is True"
            ),
        ),
        phases=(
            {
                "id": "diagnose-contract",
                "kind": "work",
                "name": "Diagnose the contract",
                "goal": (
                    "Read the implementation, docstring, and focused tests. Explain the two "
                    "case-normalization boundaries and propose the smallest repair. Do not edit."
                ),
            },
            {
                "id": "approve-repair",
                "kind": "checkpoint",
                "name": "Approve repair scope",
                "question": "Is the diagnosis narrow enough to proceed with the implementation?",
            },
            {
                "id": "repair-and-test",
                "kind": "work",
                "name": "Repair and test",
                "goal": (
                    "Implement the approved minimal repair and run the focused upstream test. "
                    "Inspect the diff for unrelated changes."
                ),
            },
            {
                "id": "verify-contract",
                "kind": "verify",
                "name": "Verify the contract",
                "criteria": (
                    "Configured extensions and filenames match case-insensitively; leading dots, "
                    "None, and defaults retain their documented behavior; focused tests pass."
                ),
                "maxRepairs": 1,
            },
        ),
    ),
    OssImplementationTask(
        id="starlette-header-invariants",
        title="Repair Starlette header normalization and order",
        repository="https://github.com/Kludex/starlette",
        directory="starlette",
        commit="398e5a3430eb1ddd33e1d48d766efe41426e231f",
        instructions=(
            "Two seeded regressions broke Headers invariants. Mapping input keys must be stored "
            "case-insensitively, and assigning a duplicate MutableHeaders key must collapse all "
            "duplicates while retaining the position of the first occurrence. Repair both "
            "behaviors without changing the public API. Modify only starlette/datastructures.py, "
            "do not edit tests, and run the focused header tests."
        ),
        target_paths=("starlette/datastructures.py",),
        context_paths=("starlette/datastructures.py", "tests/test_datastructures.py"),
        seed_edits=(
            SeedEdit(
                path="starlette/datastructures.py",
                before=(
                    'self._list = [(key.lower().encode("latin-1"), '
                    'value.encode("latin-1")) for key, value in headers.items()]'
                ),
                after=(
                    'self._list = [(key.encode("latin-1"), value.encode("latin-1")) '
                    "for key, value in headers.items()]"
                ),
            ),
            SeedEdit(
                path="starlette/datastructures.py",
                before=(
                    "        for idx in reversed(found_indexes[1:]):\n"
                    "            del self._list[idx]\n\n"
                    "        if found_indexes:\n"
                    "            idx = found_indexes[0]\n"
                    "            self._list[idx] = (set_key, set_value)"
                ),
                after=(
                    "        for idx in reversed(found_indexes[:-1]):\n"
                    "            del self._list[idx]\n\n"
                    "        if found_indexes:\n"
                    "            idx = found_indexes[-1] - len(found_indexes) + 1\n"
                    "            self._list[idx] = (set_key, set_value)"
                ),
            ),
        ),
        upstream_test=(
            "{starlette_python}",
            "-m",
            "pytest",
            "-q",
            "tests/test_datastructures.py",
            "-k",
            "headers",
        ),
        hidden_test=(
            "{starlette_python}",
            "-c",
            (
                "from starlette.datastructures import Headers,MutableHeaders; "
                "h=Headers({'X-Custom':'v'}); assert h.raw==[(b'x-custom',b'v')]; "
                "m=MutableHeaders(raw=[(b'a',b'1'),(b'x',b'x'),(b'a',b'2')]); "
                "m['A']='3'; assert m.raw==[(b'a',b'3'),(b'x',b'x')]"
            ),
        ),
        phases=(
            {
                "id": "map-invariants",
                "kind": "work",
                "name": "Map header invariants",
                "goal": (
                    "Inspect construction, lookup, mutation, and existing tests. Map where key "
                    "normalization and insertion-order preservation are enforced. Do not edit."
                ),
                "reasoningEffort": "medium",
            },
            {
                "id": "design-cases",
                "kind": "work",
                "name": "Design adversarial cases",
                "goal": (
                    "Before editing, reason through mixed-case mapping keys and non-adjacent "
                    "duplicate raw headers. State the expected raw-list behavior."
                ),
            },
            {
                "id": "implement-fix",
                "kind": "work",
                "name": "Implement the repair",
                "goal": (
                    "Repair both invariants with a minimal change to datastructures.py and run "
                    "the focused header tests. Do not modify tests."
                ),
            },
            {
                "id": "verify-invariants",
                "kind": "verify",
                "name": "Verify invariants",
                "criteria": (
                    "Mixed-case mapping keys normalize to lowercase bytes; duplicate assignment "
                    "retains the first occurrence position and removes later duplicates; focused "
                    "tests pass; only datastructures.py changed."
                ),
                "maxRepairs": 1,
            },
        ),
    ),
    OssImplementationTask(
        id="commander-option-identity",
        title="Restore Commander option identity",
        repository="https://github.com/tj/commander.js",
        directory="commander",
        commit="ba6d13ddb4243e5913367734f8c159089ffe7834",
        instructions=(
            "Two seeded regressions broke option property identity. Kebab-case conversion must "
            "capitalize only the first character after a dash while preserving the remaining "
            "case, and negated --no-* options must share the same attribute name as their "
            "positive dual. Repair both behaviors in lib/option.js without changing tests or "
            "public APIs. Run the focused camelcase and dual-option tests."
        ),
        target_paths=("lib/option.js",),
        context_paths=(
            "lib/option.js",
            "tests/options.camelcase.test.js",
            "tests/options.dual-options.test.js",
        ),
        seed_edits=(
            SeedEdit(
                path="lib/option.js",
                before=(
                    "  attributeName() {\n"
                    "    if (this.negate) {\n"
                    "      return camelcase(this.name().replace(/^no-/, ''));\n"
                    "    }\n"
                    "    return camelcase(this.name());\n"
                    "  }"
                ),
                after=("  attributeName() {\n    return camelcase(this.name());\n  }"),
            ),
            SeedEdit(
                path="lib/option.js",
                before="    return str + word[0].toUpperCase() + word.slice(1);",
                after=("    return str + word[0].toUpperCase() + word.slice(1).toLowerCase();"),
            ),
        ),
        upstream_test=(
            "node",
            "--test",
            "tests/options.camelcase.test.js",
            "tests/options.dual-options.test.js",
        ),
        hidden_test=(
            "node",
            "--input-type=module",
            "-e",
            (
                "import {Command} from './index.js'; "
                "const p=new Command(); p.option('--my-oPTION').option('--feature')"
                ".option('--no-feature'); p.parse(['node','x','--my-oPTION','--no-feature']); "
                "const o=p.opts(); if(o.myOPTION!==true||o.feature!==false||"
                "Object.hasOwn(o,'noFeature')) process.exit(1);"
            ),
        ),
        phases=(
            {
                "id": "reproduce-identities",
                "kind": "work",
                "name": "Reproduce option identities",
                "goal": (
                    "Inspect the option-name conversion and dual-option pairing code. Reproduce "
                    "the failures with focused tests and identify both violated contracts. "
                    "Do not edit."
                ),
            },
            {
                "id": "approve-contract",
                "kind": "checkpoint",
                "name": "Approve contract",
                "question": "Do the identified contracts match the existing test evidence?",
            },
            {
                "id": "repair-identities",
                "kind": "work",
                "name": "Repair option identity",
                "goal": (
                    "Implement the smallest repair in lib/option.js and run both focused test "
                    "files."
                ),
            },
            {
                "id": "review-compatibility",
                "kind": "work",
                "name": "Review compatibility",
                "goal": (
                    "Review the diff against mixed-case option names and positive/negative duals. "
                    "Correct any remaining issue and rerun focused tests."
                ),
            },
            {
                "id": "verify-options",
                "kind": "verify",
                "name": "Verify option behavior",
                "criteria": (
                    "Camelcase preserves existing character case after each dash; --feature and "
                    "--no-feature share the feature attribute; focused tests pass; only "
                    "option.js changed."
                ),
                "maxRepairs": 0,
            },
        ),
    ),
)


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sha256_json(value: Any) -> str:
    return "sha256:" + hashlib.sha256(canonical_json(value).encode()).hexdigest()


def task_by_id(task_id: str) -> OssImplementationTask:
    return next(task for task in TASKS if task.id == task_id)


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=repo, check=True, capture_output=True, text=True
    ).stdout.strip()


def seed_digest(task: OssImplementationTask) -> str:
    return sha256_json(
        [
            {"path": edit.path, "before": edit.before, "after": edit.after}
            for edit in task.seed_edits
        ]
    )


def materialize_seeded_repository(
    task: OssImplementationTask, source: Path, destination: Path
) -> str:
    if _git(source, "rev-parse", "HEAD") != task.commit:
        raise ValueError(f"source commit mismatch for {task.id}")
    destination = destination.resolve()
    if destination.exists():
        shutil.rmtree(destination)
    subprocess.run(
        ["git", "clone", "--quiet", "--shared", str(source.resolve()), str(destination)],
        check=True,
    )
    _git(destination, "checkout", "--quiet", "--detach", task.commit)
    for edit in task.seed_edits:
        target = destination / edit.path
        text = target.read_text(encoding="utf-8")
        if text.count(edit.before) != 1:
            raise ValueError(f"seed anchor is not unique for {task.id}: {edit.path}")
        target.write_text(text.replace(edit.before, edit.after, 1), encoding="utf-8")
    return "sha256:" + hashlib.sha256(_git(destination, "diff", "--binary").encode()).hexdigest()


def format_command(command: tuple[str, ...], *, starlette_python: str) -> tuple[str, ...]:
    return tuple(part.format(starlette_python=starlette_python) for part in command)


def ordinary_prompt(task: OssImplementationTask, test_command: tuple[str, ...]) -> str:
    return f"""Repair the seeded regression in this repository.

<task>
{task.instructions}
</task>
<focused_test>
{" ".join(test_command)}
</focused_test>

Memory is disabled. Work in the current repository using the normal Codex agent loop. Inspect the
existing implementation and tests, make the smallest correct change, run the focused test, and
review the final diff. Do not ask questions and do not change tests."""


def weave_manifest(
    task: OssImplementationTask,
    workspace: Path,
    *,
    model: str,
    test_command: tuple[str, ...],
) -> HarnessManifest:
    phases = []
    command = " ".join(test_command)
    for value in task.phases:
        phase = dict(value)
        if phase["kind"] == "work":
            phase["goal"] = f"{phase['goal']}\n\nFocused test command: {command}"
        phases.append(phase)
    return HarnessManifest.model_validate(
        {
            "schemaVersion": 2,
            "name": f"OSS repair · {task.title}",
            "cwd": str(workspace.resolve()),
            "task": {
                "instructions": task.instructions,
                "contextPaths": list(task.context_paths),
            },
            "memory": {"mode": "off", "selectedThreadIds": []},
            "integrations": {"requested": []},
            "agent": {
                "model": model,
                "reasoningEffort": "low",
                "sandbox": "workspace-write",
                "approvalGate": "deny",
            },
            "verification": {"enabled": True, "criteria": task.instructions, "maxRetries": 0},
            "observability": {"traceRoot": ".weave-codex/traces"},
            "phaseProgram": {"projectionVersion": 1, "phases": phases},
        }
    )


def tracked_changes(repo: Path) -> list[str]:
    return [line for line in _git(repo, "diff", "--name-only").splitlines() if line]
