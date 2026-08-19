"""Three source-to-target workflow-reuse trials on pinned OSS repositories."""

from __future__ import annotations

import hashlib
import json
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .manifest import HarnessManifest
from .phase_program import PhaseProgram
from .repo_trials import TRIALS, RepositoryTrial, _artifact_contract, grade_evidence
from .workflow_adaptation import validate_goal_only_adaptation
from .workflow_store import program_hash


@dataclass(frozen=True)
class ReusableWorkflowTrial:
    trial_id: str
    workflow_label: str
    task_family: str
    source_trial_id: str
    source_commit: str
    target: RepositoryTrial
    target_commit: str
    target_phases: tuple[tuple[str, str, str], ...]


TARGETS = (
    ReusableWorkflowTrial(
        trial_id="click-to-typer-parameter-resolution",
        workflow_label="Parameter contract investigation",
        task_family="CLI value resolution",
        source_trial_id="click-default-map",
        source_commit="cbd7a4109da16ce58f54c2a618b4c986e3041fcf",
        target=RepositoryTrial(
            id="typer-envvar-resolution",
            title="Typer environment and prompt value resolution",
            repository="https://github.com/fastapi/typer",
            directory="typer",
            artifact=".weave/evidence/typer-envvar-resolution.json",
            question=(
                "How do explicit option values, declared environment variables, automatic "
                "environment prefixes, defaults, and prompts become the final Typer option value?"
            ),
            context_paths=("typer/core.py", "tests/test_others.py", "tests/test_main.py"),
            source_prefixes=("typer/",),
            test_prefixes=("tests/",),
            required_terms=("resolve_envvar_value", "auto_envvar_prefix", "ParameterSource"),
            verification_command=(
                "uv",
                "run",
                "pytest",
                "-q",
                "tests/test_others.py",
                "-k",
                "envvar",
            ),
            phases=(),
        ),
        target_commit="9a7b2e83f6b62c750d6026b0de9ebf2026a8b8fa",
        target_phases=(
            (
                "map-contract",
                "Map Typer's value contract",
                "Inspect Typer's parameter and option implementation plus focused tests. Map "
                "each value source and its precedence boundary without writing the final artifact.",
            ),
            (
                "trace-behavior",
                "Trace environment resolution",
                "Trace declared and automatic environment variables through concrete symbols "
                "and tests. Run the focused tests, then write the required JSON evidence artifact.",
            ),
            (
                "challenge-evidence",
                "Challenge value precedence",
                "Try to falsify the draft with empty environment values, explicit command-line "
                "values, defaults, prompts, and automatic prefixes. Correct the artifact when "
                "evidence requires it.",
            ),
        ),
    ),
    ReusableWorkflowTrial(
        trial_id="requests-to-httpx-proxy-precedence",
        workflow_label="Proxy precedence investigation",
        task_family="HTTP environment policy",
        source_trial_id="requests-proxy-precedence",
        source_commit="8f8b212de8c2129d7954c6cd373762880375620a",
        target=RepositoryTrial(
            id="httpx-proxy-precedence",
            title="HTTPX proxy and environment precedence",
            repository="https://github.com/encode/httpx",
            directory="httpx",
            artifact=".weave/evidence/httpx-proxy-precedence.json",
            question=(
                "How do explicit transports or proxies, trust_env, HTTP_PROXY or ALL_PROXY, and "
                "NO_PROXY become HTTPX mounts before a request is sent?"
            ),
            context_paths=("httpx/_utils.py", "httpx/_client.py", "tests/test_utils.py"),
            source_prefixes=("httpx/",),
            test_prefixes=("tests/",),
            required_terms=("get_environment_proxies", "NO_PROXY", "trust_env"),
            verification_command=(
                "uv",
                "run",
                "pytest",
                "-q",
                "tests/test_utils.py",
                "tests/client/test_proxies.py",
            ),
            phases=(),
        ),
        target_commit="b5addb64f0161ff6bfe94c124ef76f6a1fba5254",
        target_phases=(
            (
                "map-inputs",
                "Map HTTPX proxy inputs",
                "Inspect every explicit and environment-derived source of HTTPX proxy "
                "configuration. Map where each input enters client initialization without "
                "writing the final artifact.",
            ),
            (
                "trace-precedence",
                "Trace mount precedence",
                "Trace environment proxy mounts, trust_env, and bypass decisions through exact "
                "symbols and tests. Run focused tests, then write the required JSON artifact.",
            ),
            (
                "adversarial-review",
                "Review bypass edge cases",
                "Challenge the draft with trust_env disabled, wildcard bypass, hostname suffixes, "
                "IPv6, CIDR, and explicit mounts. Correct the artifact.",
            ),
        ),
    ),
    ReusableWorkflowTrial(
        trial_id="express-to-fastify-async-errors",
        workflow_label="Async error-path investigation",
        task_family="Web framework error lifecycle",
        source_trial_id="express-async-errors",
        source_commit="a3714473feb3d2908add734d340e7755fd85e0a3",
        target=RepositoryTrial(
            id="fastify-async-errors",
            title="Fastify asynchronous error propagation",
            repository="https://github.com/fastify/fastify",
            directory="fastify",
            artifact=".weave/evidence/fastify-async-errors.json",
            question=(
                "How does Fastify propagate synchronous throws and rejected promises through "
                "onError hooks, encapsulated error handlers, fallback handling, and the reply?"
            ),
            context_paths=(
                "lib/error-handler.js",
                "lib/wrap-thenable.js",
                "test/encapsulated-error-handler.test.js",
            ),
            source_prefixes=("lib/", "fastify.js"),
            test_prefixes=("test/",),
            required_terms=("setErrorHandler", "onError", "wrapThenable"),
            verification_command=(
                "npx",
                "borp",
                "test/encapsulated-error-handler.test.js",
                "test/reply-error.test.js",
            ),
            phases=(),
        ),
        target_commit="9334d07129589f7340adfa4729ebe6c55e34bbfd",
        target_phases=(
            (
                "map-lifecycle",
                "Map Fastify's error lifecycle",
                "Inspect the request, reply, thenable, onError, custom-handler, and fallback "
                "boundaries. Build a lifecycle map without writing the final artifact.",
            ),
            (
                "trace-errors",
                "Trace thrown and rejected errors",
                "Trace synchronous throws and rejected promises through exact source and tests. "
                "Run focused tests, then write the required JSON artifact.",
            ),
            (
                "challenge-failures",
                "Challenge nested failure paths",
                "Check errors raised inside encapsulated handlers, onError behavior, rejected "
                "values, serialization failure, and fallback handling. Correct the artifact.",
            ),
        ),
    ),
)


def canonical_hash(value: Any) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), default=str).encode()
    return "sha256:" + hashlib.sha256(encoded).hexdigest()


def _source_trial(trial_id: str) -> RepositoryTrial:
    return next(trial for trial in TRIALS if trial.id == trial_id)


def phase_program_for(trial: RepositoryTrial, commit: str) -> PhaseProgram:
    phases: list[dict[str, Any]] = []
    for index, (phase_id, name, goal) in enumerate(trial.phases):
        phases.append(
            {
                "id": phase_id,
                "kind": "work",
                "name": name,
                "goal": f"{goal}\n\n{_artifact_contract(trial, commit)}",
                "reasoningEffort": "high" if index == 2 else "medium",
            }
        )
        if index == 0:
            phases.append(
                {
                    "id": "review-map",
                    "kind": "checkpoint",
                    "name": "Review the map",
                    "question": "Is the initial evidence map concrete enough to continue?",
                }
            )
    phases.append(
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
    return PhaseProgram(phases=phases)


def programs_for(trial: ReusableWorkflowTrial) -> tuple[PhaseProgram, PhaseProgram]:
    source_trial = _source_trial(trial.source_trial_id)
    source = phase_program_for(source_trial, trial.source_commit)
    target_definition = RepositoryTrial(
        **{**trial.target.__dict__, "phases": trial.target_phases}
    )
    derived = phase_program_for(target_definition, trial.target_commit)
    validate_goal_only_adaptation(source, derived)
    return source, derived


def build_manifest(trial: ReusableWorkflowTrial, repo: Path, model: str) -> HarnessManifest:
    actual_commit = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=repo, check=True, capture_output=True, text=True
    ).stdout.strip()
    if actual_commit != trial.target_commit:
        raise ValueError(f"target commit mismatch: {actual_commit}")
    _, derived = programs_for(trial)
    return HarnessManifest.model_validate(
        {
            "schemaVersion": 2,
            "name": f"Reused workflow · {trial.target.title}",
            "cwd": str(repo.resolve()),
            "task": {
                "instructions": (
                    f"{trial.target.question}\n\n"
                    f"{_artifact_contract(trial.target, actual_commit)}"
                ),
                "contextPaths": list(trial.target.context_paths),
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
            "phaseProgram": derived.model_dump(by_alias=True, mode="json"),
        }
    )


def public_design(trial: ReusableWorkflowTrial) -> dict[str, Any]:
    source, derived = programs_for(trial)
    return {
        "sourceRepo": _source_trial(trial.source_trial_id).repository,
        "sourceCommit": trial.source_commit,
        "sourceProgramHash": program_hash(source),
        "targetRepo": trial.target.repository,
        "targetCommit": trial.target_commit,
        "derivedProgramHash": program_hash(derived),
        "phaseIds": [phase.id for phase in derived.phases],
        "phaseKinds": [phase.kind for phase in derived.phases],
        "changedGoals": len(validate_goal_only_adaptation(source, derived)),
        "structurePreserved": True,
    }


def grade(trial: ReusableWorkflowTrial, repo: Path) -> dict[str, Any]:
    return grade_evidence(trial.target, repo)
