"""Pinned, source-linked repository trials for the Weave phase runtime."""

from __future__ import annotations

import hashlib
import json
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .manifest import HarnessManifest


@dataclass(frozen=True)
class RepositoryTrial:
    id: str
    title: str
    repository: str
    directory: str
    artifact: str
    question: str
    context_paths: tuple[str, ...]
    source_prefixes: tuple[str, ...]
    test_prefixes: tuple[str, ...]
    required_terms: tuple[str, ...]
    verification_command: tuple[str, ...]
    phases: tuple[tuple[str, str, str], ...]


TRIALS = (
    RepositoryTrial(
        id="click-default-map",
        title="Click nested default-map resolution",
        repository="https://github.com/pallets/click",
        directory="click",
        artifact=".weave/evidence/click-default-map.json",
        question=(
            "How does a value in a nested command Context.default_map become the final option "
            "value, and where does it sit in Click's value-precedence rules?"
        ),
        context_paths=("src/click/core.py", "tests/test_defaults.py", "tests/test_context.py"),
        source_prefixes=("src/click/",),
        test_prefixes=("tests/",),
        required_terms=("default_map", "Context", "consume_value"),
        verification_command=(
            ".venv/bin/python",
            "-m",
            "pytest",
            "-q",
            "tests/test_defaults.py",
            "tests/test_context.py",
        ),
        phases=(
            (
                "map-contract",
                "Map the contract",
                "Inspect the implementation and existing tests. Build a symbol-level map of the "
                "value path and precedence boundaries. Do not write the final artifact yet.",
            ),
            (
                "trace-behavior",
                "Trace and test",
                "Follow the mapped path through concrete source and test cases. Run the focused "
                "tests, then write the required JSON evidence artifact.",
            ),
            (
                "challenge-evidence",
                "Challenge the evidence",
                "Try to falsify the draft using nested commands, missing keys, and competing value "
                "sources. Correct the JSON artifact when the evidence requires it.",
            ),
        ),
    ),
    RepositoryTrial(
        id="requests-proxy-precedence",
        title="Requests proxy and environment precedence",
        repository="https://github.com/psf/requests",
        directory="requests",
        artifact=".weave/evidence/requests-proxy-precedence.json",
        question=(
            "How do Session settings, per-request proxies, environment variables, trust_env, and "
            "NO_PROXY combine before Requests sends a prepared request?"
        ),
        context_paths=(
            "src/requests/sessions.py",
            "src/requests/utils.py",
            "tests/test_utils.py",
        ),
        source_prefixes=("src/requests/",),
        test_prefixes=("tests/",),
        required_terms=("merge_environment_settings", "no_proxy", "should_bypass_proxies"),
        verification_command=(
            ".venv/bin/python",
            "-m",
            "pytest",
            "-q",
            "tests/test_utils.py",
            "-k",
            "proxy or bypass",
        ),
        phases=(
            (
                "map-inputs",
                "Map proxy inputs",
                "Inspect every relevant source of proxy configuration and map where each enters "
                "the request lifecycle. Do not write the final artifact yet.",
            ),
            (
                "trace-precedence",
                "Trace precedence",
                "Trace environment merging and bypass decisions through exact symbols and existing "
                "tests. Run the focused tests, then write the required JSON evidence artifact.",
            ),
            (
                "adversarial-review",
                "Review edge cases",
                "Challenge the draft with trust_env disabled, explicit empty proxy mappings, "
                "CIDR or hostname bypasses, and session/request conflicts. Correct the artifact.",
            ),
        ),
    ),
    RepositoryTrial(
        id="express-async-errors",
        title="Express asynchronous error propagation",
        repository="https://github.com/expressjs/express",
        directory="express",
        artifact=".weave/evidence/express-async-errors.json",
        question=(
            "How does Express 5 propagate synchronous throws and rejected promises from a route "
            "through error middleware to the final handler?"
        ),
        context_paths=("lib/application.js", "lib/response.js", "test/app.routes.error.js"),
        source_prefixes=("lib/", "index.js"),
        test_prefixes=("test/",),
        required_terms=("finalhandler", "next", "rejected"),
        verification_command=(
            "./node_modules/.bin/mocha",
            "--require",
            "test/support/env",
            "--reporter",
            "dot",
            "--check-leaks",
            "test/app.routes.error.js",
            "test/acceptance/error.js",
        ),
        phases=(
            (
                "map-lifecycle",
                "Map the lifecycle",
                "Inspect the application, router boundary, error middleware conventions, and final "
                "handler. Build a lifecycle map without writing the final artifact yet.",
            ),
            (
                "trace-errors",
                "Trace error paths",
                "Trace synchronous and asynchronous failures through exact files and tests. Run "
                "the focused tests, then write the required JSON evidence artifact.",
            ),
            (
                "challenge-failures",
                "Challenge failure paths",
                "Check rejected promises with and without values, errors raised inside error "
                "middleware, and the no-handler boundary. Correct the artifact.",
            ),
        ),
    ),
)


def _artifact_contract(trial: RepositoryTrial, commit: str) -> str:
    return f"""Write {trial.artifact} as JSON with exactly this conceptual structure:
{{
  "schemaVersion": 1,
  "trialId": "{trial.id}",
  "repository": {{"url": "{trial.repository}", "commit": "{commit}"}},
  "question": "...",
  "findings": [
    {{"claim": "...", "sourcePaths": ["relative/tracked/file"],
      "symbols": ["..."], "evidence": "concise explanation"}}
  ],
  "verification": [{{"command": "...", "exitCode": 0, "purpose": "..."}}],
  "limitations": ["..."],
  "conclusion": "..."
}}
Include at least three findings and four distinct tracked file references, including source and
test files. Never invent a file, symbol, command result, or upstream bug. Do not change tracked
repository files: the evidence JSON is the only artifact you may create."""


def build_trial_manifest(trial: RepositoryTrial, repo: Path, *, model: str) -> HarnessManifest:
    commit = git_output(repo, "rev-parse", "HEAD")
    phase_program: list[dict[str, Any]] = []
    for index, (phase_id, name, goal) in enumerate(trial.phases):
        phase_program.append(
            {
                "id": phase_id,
                "kind": "work",
                "name": name,
                "goal": f"{goal}\n\n{_artifact_contract(trial, commit)}",
                "reasoningEffort": "high" if index == 2 else "medium",
            }
        )
        if index == 0:
            phase_program.append(
                {
                    "id": "review-map",
                    "kind": "checkpoint",
                    "name": "Review the map",
                    "question": "Is the initial evidence map concrete enough to continue?",
                }
            )
    phase_program.append(
        {
            "id": "verify-artifact",
            "kind": "verify",
            "name": "Verify the evidence",
            "criteria": (
                f"{trial.artifact} exists, is valid JSON, matches commit {commit}, cites only "
                "inspected tracked files and symbols, reports real focused test results, and "
                "answers the question without claiming more than the evidence supports."
            ),
            "maxRepairs": 0,
        }
    )
    return HarnessManifest.model_validate(
        {
            "schemaVersion": 2,
            "name": trial.title,
            "cwd": str(repo.resolve()),
            "task": {
                "instructions": f"{trial.question}\n\n{_artifact_contract(trial, commit)}",
                "contextPaths": list(trial.context_paths),
            },
            "memory": {"mode": "off", "selectedThreadIds": []},
            "integrations": {"requested": []},
            "agent": {
                "model": model,
                "reasoningEffort": "medium",
                "sandbox": "workspace-write",
                "approvalGate": "deny",
            },
            "verification": {"enabled": True, "criteria": "See phase program", "maxRetries": 0},
            "output": {"format": "json"},
            "observability": {"traceRoot": ".weave-codex/traces"},
            "phaseProgram": {"projectionVersion": 1, "phases": phase_program},
        }
    )


def git_output(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=repo, check=True, capture_output=True, text=True
    ).stdout.strip()


def sha256_file(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def grade_evidence(trial: RepositoryTrial, repo: Path) -> dict[str, Any]:
    artifact = repo / trial.artifact
    checks: list[dict[str, Any]] = []

    def check(name: str, passed: bool, detail: str) -> None:
        checks.append({"name": name, "passed": passed, "detail": detail})

    try:
        payload = json.loads(artifact.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return {
            "passed": False,
            "checks": [{"name": "artifact", "passed": False, "detail": str(exc)}],
        }

    commit = git_output(repo, "rev-parse", "HEAD")
    check("identity", payload.get("trialId") == trial.id, str(payload.get("trialId")))
    repository = payload.get("repository") if isinstance(payload.get("repository"), dict) else {}
    check("commit", repository.get("commit") == commit, str(repository.get("commit")))
    findings = payload.get("findings") if isinstance(payload.get("findings"), list) else []
    check("finding-count", len(findings) >= 3, str(len(findings)))
    references: list[str] = []
    for finding in findings:
        if not isinstance(finding, dict):
            continue
        paths = finding.get("sourcePaths") if isinstance(finding.get("sourcePaths"), list) else []
        references.extend(str(path) for path in paths)
    unique = list(dict.fromkeys(references))
    valid: list[str] = []
    for relative in unique:
        candidate = (repo / relative).resolve()
        try:
            candidate.relative_to(repo.resolve())
        except ValueError:
            continue
        if (
            candidate.is_file()
            and subprocess.run(
                ["git", "ls-files", "--error-unmatch", relative],
                cwd=repo,
                capture_output=True,
            ).returncode
            == 0
        ):
            valid.append(relative)
    check(
        "tracked-references",
        len(valid) == len(unique) and len(valid) >= 4,
        f"{len(valid)}/{len(unique)}",
    )
    check(
        "source-reference",
        any(path.startswith(trial.source_prefixes) for path in valid),
        ", ".join(valid),
    )
    check(
        "test-reference",
        any(path.startswith(trial.test_prefixes) for path in valid),
        ", ".join(valid),
    )
    encoded = json.dumps(payload, sort_keys=True).lower()
    missing_terms = [term for term in trial.required_terms if term.lower() not in encoded]
    check("required-concepts", not missing_terms, ", ".join(missing_terms) or "all present")
    status_paths = [
        line[3:]
        for line in git_output(
            repo, "status", "--porcelain=v1", "--untracked-files=all"
        ).splitlines()
        if line
    ]
    outside = [path for path in status_paths if not path.startswith(".weave/")]
    check("source-unchanged", not outside, ", ".join(outside) or "only .weave artifacts")
    return {
        "passed": all(item["passed"] for item in checks),
        "checks": checks,
        "artifactPath": str(artifact),
        "artifactSha256": sha256_file(artifact),
        "referencedFiles": [
            {"path": str((repo / relative).resolve()), "sha256": sha256_file(repo / relative)}
            for relative in valid
        ],
    }
