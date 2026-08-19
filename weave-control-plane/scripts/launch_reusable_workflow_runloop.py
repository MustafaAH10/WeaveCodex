"""Prepare or run the reusable-workflow study in one ChatGPT-authenticated sandbox.

This helper intentionally does not create a sandbox or handle OpenAI credentials. Create one
persistent sandbox with the provider of your choice, open its terminal, and complete the official
``codex login --device-auth`` flow. Then copy this repository into the sandbox and run this helper
there. Codex owns the login state; WeaveCodex never reads or transports the token.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

from weave_codex.reusable_workflow_trials import canonical_hash


def parser() -> argparse.ArgumentParser:
    value = argparse.ArgumentParser(description=__doc__)
    value.add_argument("--plan", type=Path, required=True)
    value.add_argument("--sandbox-id", required=True)
    value.add_argument("--target-root", type=Path, required=True)
    value.add_argument("--raw-root", type=Path, required=True)
    value.add_argument("--public-root", type=Path, required=True)
    value.add_argument("--execute", action="store_true")
    value.add_argument("--confirm-one-chatgpt-sandbox", action="store_true")
    return value


def _load_plan(path: Path) -> dict[str, Any]:
    plan = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(plan, dict):
        raise ValueError("frozen plan must be an object")
    core = {key: item for key, item in plan.items() if key not in {"frozenAtUtc", "planId"}}
    if plan.get("planId") != canonical_hash(core):
        raise ValueError("frozen plan ID does not match its content")
    auth = plan.get("authentication") or {}
    if (
        plan.get("sandboxCount") != 1
        or plan.get("plannedRuns") != 3
        or auth.get("method") != "chatgpt-device-code"
        or auth.get("accountMode") != "chatgpt"
        or auth.get("apiKeyInjected") is not False
    ):
        raise ValueError("plan must bind three runs to one ChatGPT-authenticated sandbox")
    return plan


def _login_status() -> str:
    if os.environ.get("OPENAI_API_KEY"):
        raise RuntimeError("OPENAI_API_KEY must not be injected into this external-user flow")
    completed = subprocess.run(
        ["codex", "login", "status"],
        check=False,
        capture_output=True,
        text=True,
    )
    status = (completed.stdout + completed.stderr).strip()
    if completed.returncode != 0 or "Logged in using ChatGPT" not in status:
        raise RuntimeError(
            "Codex is not authenticated through ChatGPT. Run `codex login --device-auth` "
            "in this sandbox, finish the browser flow, and retry."
        )
    return "Logged in using ChatGPT"


def _trial_command(
    *,
    trial: dict[str, Any],
    target_root: Path,
    raw_root: Path,
    public_root: Path,
    sandbox_id: str,
) -> list[str]:
    trial_id = str(trial["trialId"])
    target_directory = str(trial["targetRepo"]).rstrip("/").rsplit("/", 1)[-1]
    target = target_root / target_directory
    return [
        sys.executable,
        "scripts/run_reusable_workflow_trial.py",
        "--trial-id",
        trial_id,
        "--repo",
        str(target),
        "--raw-out",
        str(raw_root / "clean" / f"{trial_id}.raw.json"),
        "--public-out",
        str(public_root / "clean" / f"{trial_id}.public.json"),
        "--sandbox-id",
        sandbox_id,
        "--execute",
        "--confirm-one-run",
    ]


def main() -> None:
    args = parser().parse_args()
    plan = _load_plan(args.plan)
    commands = [
        _trial_command(
            trial=trial,
            target_root=args.target_root,
            raw_root=args.raw_root,
            public_root=args.public_root,
            sandbox_id=args.sandbox_id,
        )
        for trial in plan["trials"]
    ]
    if not args.execute:
        print(
            json.dumps(
                {
                    "state": "ready-for-user-authentication",
                    "planId": plan["planId"],
                    "sandboxId": args.sandbox_id,
                    "loginCommand": "codex login --device-auth",
                    "authentication": "ChatGPT subscription; no API key",
                    "commands": commands,
                },
                indent=2,
            )
        )
        return
    if not args.confirm_one_chatgpt_sandbox:
        raise SystemExit("--execute requires --confirm-one-chatgpt-sandbox")
    login_status = _login_status()
    args.raw_root.mkdir(parents=True, exist_ok=True)
    args.public_root.mkdir(parents=True, exist_ok=True)
    for command in commands:
        subprocess.run(command, cwd=Path(__file__).parents[1], check=True)
    print(
        json.dumps(
            {
                "state": "complete",
                "planId": plan["planId"],
                "sandboxId": args.sandbox_id,
                "authentication": login_status,
                "runs": len(commands),
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
