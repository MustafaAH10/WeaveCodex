"""Freeze and run three reusable-workflow trials in separate Runloop devboxes."""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import shlex
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from weave_codex.reusable_workflow_trials import TARGETS, canonical_hash, public_design


def parser() -> argparse.ArgumentParser:
    value = argparse.ArgumentParser(description=__doc__)
    value.add_argument("--env-file", type=Path, required=True)
    value.add_argument("--plan", type=Path, required=True)
    value.add_argument("--raw-root", type=Path, required=True)
    value.add_argument("--public-out", type=Path, required=True)
    value.add_argument("--execute", action="store_true")
    value.add_argument("--confirm-three-sandboxes", action="store_true")
    return value


def _load_required_env(path: Path) -> None:
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        if key.strip() in {"RUNLOOP_API_KEY", "OPENAI_API_KEY"}:
            os.environ.setdefault(key.strip(), value.strip().strip("'\""))
    missing = [key for key in ("RUNLOOP_API_KEY", "OPENAI_API_KEY") if not os.environ.get(key)]
    if missing:
        raise ValueError("missing required configured credentials: " + ", ".join(missing))


def plan_core() -> dict[str, Any]:
    return {
        "schemaVersion": 1,
        "study": "Reusable workflow source-to-target product trials",
        "model": "gpt-5.6-terra",
        "reasoningEffort": "medium",
        "memory": "off",
        "sandbox": "workspace-write",
        "sandboxCount": 3,
        "plannedRuns": 3,
        "execution": "one derived Weave workflow per isolated Runloop devbox",
        "trials": [
            {
                "trialId": trial.trial_id,
                "workflowLabel": trial.workflow_label,
                "taskFamily": trial.task_family,
                **public_design(trial),
            }
            for trial in TARGETS
        ],
    }


def freeze_or_verify(path: Path) -> dict[str, Any]:
    core = plan_core()
    if path.is_file():
        value = json.loads(path.read_text(encoding="utf-8"))
        saved_core = {
            key: item
            for key, item in value.items()
            if key not in {"frozenAtUtc", "planId"}
        }
        if saved_core != core or value.get("planId") != canonical_hash(core):
            raise ValueError("frozen plan differs from current trial code")
        return value
    value = {**core, "frozenAtUtc": datetime.now(UTC).isoformat(), "planId": canonical_hash(core)}
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
    return value


def _setup_command(trial_id: str, repository: str, commit: str, sandbox_id: str) -> str:
    parts = [
        "set -euo pipefail",
        "export PATH=\"$HOME/.local/bin:$PATH\"",
        "mkdir -p /home/user/weave-reuse/results /home/user/weave-reuse/raw",
        "cd /home/user/weave-reuse",
        "curl -LsSf https://astral.sh/uv/install.sh | sh",
        "npm install -g @openai/codex",
        "printf '%s' \"$OPENAI_API_KEY\" | codex login --with-api-key >/dev/null",
        (
            "git clone --depth 1 --branch main "
            "https://github.com/MustafaAH10/WeaveCodex.git WeaveCodex"
        ),
        f"git clone --filter=blob:none {shlex.quote(repository)} target",
        "cd target",
        f"git fetch --depth 1 origin {shlex.quote(commit)}",
        f"git checkout --detach {shlex.quote(commit)}",
        (
            "if [ -f package.json ]; then npm install; "
            "elif [ -f pyproject.toml ]; then uv sync; fi"
        ),
        "cd /home/user/weave-reuse/WeaveCodex/weave-control-plane",
        "uv sync",
        (
            "PYTHONPATH=. uv run python scripts/run_reusable_workflow_trial.py "
            f"--trial-id {shlex.quote(trial_id)} "
            "--repo /home/user/weave-reuse/target "
            f"--raw-out /home/user/weave-reuse/raw/{shlex.quote(trial_id)}.json "
            f"--public-out /home/user/weave-reuse/results/{shlex.quote(trial_id)}.json "
            f"--sandbox-id {shlex.quote(sandbox_id)} "
            "--execute --confirm-one-run"
        ),
    ]
    return "\n".join(parts)


async def _execute(args: argparse.Namespace, plan: dict[str, Any]) -> dict[str, Any]:
    from runloop_api_client import AsyncRunloopSDK

    sdk = AsyncRunloopSDK()
    secret_name = (
        "WEAVE_CODEX_REUSE_"
        + hashlib.sha256(plan["planId"].encode()).hexdigest()[:12].upper()
    )
    secret = await sdk.secret.create(secret_name, os.environ["OPENAI_API_KEY"])
    boxes: list[Any] = []
    results: list[dict[str, Any]] = []
    try:
        for trial in TARGETS:
            box = await sdk.devbox.create(
                name=f"weave-reuse-{trial.target.directory}-{trial.target_commit[:7]}",
                secrets={"OPENAI_API_KEY": secret.name},
                metadata={"study": "weave-reusable-workflows", "trial": trial.trial_id},
            )
            boxes.append(box)
        for trial, box in zip(TARGETS, boxes, strict=True):
            command = _setup_command(
                trial.trial_id,
                trial.target.repository,
                trial.target_commit,
                box.id,
            )
            execution = await box.cmd.exec(command, timeout=3_600)
            args.raw_root.mkdir(parents=True, exist_ok=True)
            stdout = await execution.stdout()
            stderr = await execution.stderr()
            (args.raw_root / f"{trial.trial_id}.stdout.log").write_text(
                stdout, encoding="utf-8"
            )
            (args.raw_root / f"{trial.trial_id}.stderr.log").write_text(
                stderr, encoding="utf-8"
            )
            (args.raw_root / f"{trial.trial_id}.setup.json").write_text(
                json.dumps(
                    {
                        "devboxId": box.id,
                        "executionId": execution.execution_id,
                        "exitCode": execution.exit_code,
                        "stdoutSha256": "sha256:"
                        + hashlib.sha256(stdout.encode()).hexdigest(),
                        "stderrSha256": "sha256:"
                        + hashlib.sha256(stderr.encode()).hexdigest(),
                    },
                    indent=2,
                )
                + "\n",
                encoding="utf-8",
            )
            if not execution.success:
                raise RuntimeError(f"sandbox execution failed for {trial.trial_id}")
            public_text = await box.file.read(
                file_path=f"/home/user/weave-reuse/results/{trial.trial_id}.json"
            )
            raw_text = await box.file.read(
                file_path=f"/home/user/weave-reuse/raw/{trial.trial_id}.json"
            )
            (args.raw_root / f"{trial.trial_id}.json").write_text(raw_text, encoding="utf-8")
            results.append(json.loads(public_text))
    finally:
        for box in boxes:
            try:
                await box.shutdown()
            except Exception:
                pass
        await sdk.secret.delete(secret)
    public_trials = []
    for trial, result in zip(TARGETS, results, strict=True):
        public_trials.append(
            {
                **result,
                "sourceRepo": trial.source_trial_id.split("-")[0].title(),
                "targetRepo": trial.target.directory.title(),
                "changedFiles": [trial.target.artifact],
                "upstreamChecks": (
                    "passed"
                    if result["grade"]["externalVerification"]["exitCode"] == 0
                    else "failed"
                ),
                "verification": (
                    "evidence contract + focused upstream checks passed"
                    if result["artifactAccepted"]
                    else "acceptance checks failed"
                ),
            }
        )
    public = {
        "schemaVersion": 1,
        "study": plan["study"],
        "planId": plan["planId"],
        "sandboxCount": len(boxes),
        "trials": public_trials,
        "claimBoundary": (
            "Three one-rollout product acceptance trials. Source runs are historical and target "
            "runs have no ordinary-Codex comparison arm. The result tests immutable lineage, "
            "goal adaptation, execution, and external verification—not general model quality."
        ),
    }
    public["summarySha256"] = canonical_hash(public)
    args.public_out.parent.mkdir(parents=True, exist_ok=True)
    args.public_out.write_text(json.dumps(public, indent=2) + "\n", encoding="utf-8")
    return public


def main() -> None:
    args = parser().parse_args()
    _load_required_env(args.env_file)
    plan = freeze_or_verify(args.plan)
    if not args.execute:
        print(json.dumps({"state": "dry-run", **plan}, indent=2))
        return
    if not args.confirm_three_sandboxes:
        raise SystemExit("--execute requires --confirm-three-sandboxes")
    print(json.dumps(asyncio.run(_execute(args, plan)), indent=2))


if __name__ == "__main__":
    main()
