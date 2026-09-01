from __future__ import annotations

import json
import subprocess
from pathlib import Path

from weave_codex.manifest import HarnessManifest, compile_manifest
from weave_codex.phase_program import PhaseProgram, ordered_phases, phase_templates

STATIC_HOME = Path(__file__).parents[1] / "weave_codex" / "static" / "home.js"


def _browser_manifests() -> dict[str, object]:
    script = r"""
const { buildManifest, displaySteps } = require(process.argv[1]);
const common = {
  cwd: "/tmp/project",
  instructions: "Inspect the available context and complete the requested task.",
  integrations: {
    inventoryId: null,
    requested: [{ kind: "skill", id: "review", label: "Review", phaseIds: ["work"] }],
  },
  agent: {
    model: null,
    reasoningEffort: "medium",
    sandbox: "workspace-write",
    approvalGate: "manual",
  },
  program: {
    projectionVersion: 1,
    phases: [{ id: "work", kind: "work", name: "Complete", goal: "Complete the task." }],
  },
};
const direct = buildManifest({ ...common, mode: "ordinary", name: "Codex direct" });
const weave = buildManifest({ ...common, mode: "weave", name: "Weave review" });
process.stdout.write(JSON.stringify({ direct, directSteps: displaySteps(direct), weave }));
"""
    result = subprocess.run(
        ["node", "-e", script, str(STATIC_HOME)],
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(result.stdout)


def test_codex_direct_browser_manifest_compiles_as_one_native_schema_v1_run() -> None:
    values = _browser_manifests()
    direct = values["direct"]

    assert direct["schemaVersion"] == 1
    assert "phaseProgram" not in direct
    assert direct["integrations"]["requested"][0]["phaseIds"] == []
    assert values["directSteps"] == [
        {
            "id": "native-codex-run",
            "kind": "native",
            "name": "One native adaptive Codex run",
        }
    ]

    compiled = compile_manifest(HarnessManifest.model_validate(direct))
    assert compiled["maximumTurns"] == 1
    assert "turn/start solver" in compiled["actions"]
    assert [node["id"] for node in compiled["nodes"]].count("agent") == 1


def test_weave_browser_manifest_remains_schema_v2_with_phase_program() -> None:
    weave = _browser_manifests()["weave"]

    assert weave["schemaVersion"] == 2
    assert weave["phaseProgram"]["phases"][0]["id"] == "work"
    compiled = compile_manifest(HarnessManifest.model_validate(weave))
    assert compiled["schemaVersion"] == 2
    assert compiled["executionOrder"] == ["work"]


def test_backend_catalog_owns_real_executable_graphs_at_different_granularities() -> None:
    templates = {item["id"]: item for item in phase_templates()}
    fullstack = PhaseProgram.model_validate(templates["full-stack-product"]["program"])
    poster = PhaseProgram.model_validate(templates["creative-poster"]["program"])
    fullstack_order = [phase.id for phase in ordered_phases(fullstack)]
    poster_order = [phase.id for phase in ordered_phases(poster)]

    assert len(fullstack.edges) == 9
    assert len(poster.edges) == 7
    assert fullstack_order == [
        "shape-product",
        "build-backend",
        "build-auth",
        "build-frontend",
        "product-review",
        "run-suite",
        "security-review",
        "prove-product",
    ]
    assert poster_order[-1] == "final-artwork"
    assert all(phase.position is not None for phase in poster.phases)

    manifest = HarnessManifest.model_validate(
        {
            "schemaVersion": 2,
            "name": "Full-stack canvas",
            "cwd": "/tmp/project",
            "task": {"instructions": "Build the complete product."},
            "phaseProgram": fullstack.model_dump(by_alias=True, mode="json"),
        }
    )
    compiled = compile_manifest(manifest)
    assert compiled["executionOrder"] == fullstack_order
    assert {("shape-product", "build-backend"), ("shape-product", "build-auth")} <= {
        (edge["from"], edge["to"]) for edge in compiled["edges"]
    }
