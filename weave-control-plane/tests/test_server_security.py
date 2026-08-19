from __future__ import annotations

import http.client
import json
import threading
from pathlib import Path
from typing import Any

import pytest

from weave_codex.server import ControlPlane, ControlServer, list_workspace_paths


class FakeAuth:
    def __init__(self) -> None:
        self.closed = False

    def status(self) -> dict[str, Any]:
        return {
            "state": "ready",
            "accountType": "chatgpt",
            "subscriptionAccess": True,
            "privacy": {"containsSecrets": False},
        }

    def start_chatgpt_login(self) -> dict[str, str]:
        return {
            "loginId": "login-1",
            "state": "pending",
            "message": "Finish signing in in the browser.",
            "authUrl": "https://chatgpt.com/auth/example",
        }

    def integrations(self, cwd: str) -> dict[str, Any]:
        return {
            "cwd": cwd,
            "skills": [{"name": "spreadsheet", "enabled": True}],
            "mcpServers": [{"name": "browser", "tools": ["open"]}],
            "apps": [{"id": "drive", "name": "Google Drive", "accessible": True}],
            "warnings": [],
            "privacy": {"secretsIncluded": False},
        }

    def login_status(self, login_id: str) -> dict[str, str] | None:
        if login_id != "login-1":
            return None
        return {"loginId": login_id, "state": "succeeded", "message": "done"}

    def close(self) -> None:
        self.closed = True


def _request(
    port: int,
    method: str,
    path: str,
    *,
    body: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
) -> tuple[int, dict[str, Any]]:
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=3)
    encoded = json.dumps(body or {}).encode()
    connection.request(
        method,
        path,
        body=encoded if method == "POST" else None,
        headers=headers or {},
    )
    response = connection.getresponse()
    value = json.loads(response.read())
    connection.close()
    return response.status, value


def test_local_session_token_guards_side_effects_and_auth_flow(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    app = ControlPlane("codex", tmp_path, workspace)
    native = app.auth
    fake = FakeAuth()
    app.auth = fake  # type: ignore[assignment]
    native.close()
    server = ControlServer(("127.0.0.1", 0), app)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    port = server.server_address[1]
    try:
        status, session = _request(port, "GET", "/api/session")
        assert status == 200
        assert session["authenticationOwner"] == "codexAppServer"
        assert session["workspaceRoot"] == str(workspace.resolve())
        token = session["csrfToken"]

        status, error = _request(
            port,
            "POST",
            "/api/account/login/chatgpt",
            body={},
            headers={"Content-Type": "application/json"},
        )
        assert status == 400
        assert "session token" in error["error"]

        common = {
            "Content-Type": "application/json",
            "X-Weave-CSRF": token,
            "Origin": f"http://127.0.0.1:{port}",
        }
        status, started = _request(
            port,
            "POST",
            "/api/account/login/chatgpt",
            body={},
            headers=common,
        )
        assert status == 202
        assert started["authUrl"].startswith("https://chatgpt.com/")

        status, account = _request(port, "GET", "/api/account")
        assert status == 200
        assert account["subscriptionAccess"] is True

        status, integrations = _request(
            port,
            "GET",
            f"/api/integrations?cwd={workspace}",
        )
        assert status == 200
        assert integrations["skills"][0]["name"] == "spreadsheet"
        assert integrations["mcpServers"][0]["tools"] == ["open"]
        assert integrations["privacy"]["secretsIncluded"] is False

        (workspace / "src").mkdir()
        (workspace / "src" / "main.py").write_text("SECRET_FILE_CONTENT", encoding="utf-8")
        status, paths = _request(
            port,
            "POST",
            "/api/workspace/paths",
            body={"cwd": str(workspace), "query": "main", "limit": 20},
            headers=common,
        )
        assert status == 200
        assert paths["privacy"] == "names-only"
        assert paths["entries"] == [{"path": "src/main.py", "kind": "file"}]
        assert "SECRET_FILE_CONTENT" not in json.dumps(paths)

        status, workflow = _request(
            port,
            "POST",
            "/api/workflows",
            body={
                "name": "Inspect then build",
                "description": "Reusable process only.",
                "phaseProgram": {
                    "projectionVersion": 1,
                    "phases": [
                        {
                            "id": "inspect",
                            "kind": "work",
                            "name": "Inspect",
                            "goal": "Inspect the repository and propose a direction.",
                        },
                        {
                            "id": "build",
                            "kind": "work",
                            "name": "Build",
                            "goal": "Implement the approved direction and verify it.",
                        },
                    ],
                },
            },
            headers=common,
        )
        assert status == 201
        assert workflow["programHash"].startswith("sha256:")
        assert "task" not in workflow
        status, workflows = _request(port, "GET", "/api/workflows")
        assert status == 200
        assert workflows["workflows"][0]["workflowId"] == workflow["workflowId"]

        status, completed = _request(port, "GET", "/api/account/login/login-1")
        assert status == 200
        assert completed["state"] == "succeeded"
    finally:
        server.shutdown()
        server.server_close()
        worker.join(timeout=2)
    assert fake.closed


def test_workspace_listing_is_bounded_deterministic_and_skips_heavy_trees(
    tmp_path: Path,
) -> None:
    root = tmp_path / "project"
    (root / "src" / "feature").mkdir(parents=True)
    (root / "src" / "feature" / "view.ts").write_text("private contents", encoding="utf-8")
    (root / "README.md").write_text("private readme", encoding="utf-8")
    (root / "node_modules" / "package").mkdir(parents=True)
    (root / "node_modules" / "package" / "index.js").write_text("hidden", encoding="utf-8")
    (root / ".git").mkdir()
    (root / ".git" / "config").write_text("hidden", encoding="utf-8")
    (root / ".weave-codex").mkdir()
    (root / ".weave-codex" / "receipt.json").write_text("hidden", encoding="utf-8")
    (root / "linked-src").symlink_to(root / "src", target_is_directory=True)

    value = list_workspace_paths(root, query="", limit=100)

    assert value["root"] == str(root.resolve())
    assert value["entries"] == [
        {"path": "linked-src", "kind": "symlink"},
        {"path": "README.md", "kind": "file"},
        {"path": "src/", "kind": "directory"},
        {"path": "src/feature/", "kind": "directory"},
        {"path": "src/feature/view.ts", "kind": "file"},
    ]
    serialized = json.dumps(value)
    assert "private contents" not in serialized
    assert "node_modules" not in serialized
    assert ".git" not in serialized
    assert ".weave-codex" not in serialized
    assert value == list_workspace_paths(root, query="", limit=100)


def test_workspace_listing_rejects_invalid_roots_and_caps_results(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="absolute"):
        list_workspace_paths(Path("relative"))
    missing = tmp_path / "missing"
    with pytest.raises(ValueError, match="existing directory"):
        list_workspace_paths(missing)

    for index in range(120):
        (tmp_path / f"file-{index:03d}.txt").write_text(str(index), encoding="utf-8")
    value = list_workspace_paths(tmp_path, limit=1_000)
    assert len(value["entries"]) == 100
    assert value["truncated"] is True


def test_non_json_and_hostile_host_are_rejected(tmp_path: Path) -> None:
    app = ControlPlane("codex", tmp_path)
    native = app.auth
    fake = FakeAuth()
    app.auth = fake  # type: ignore[assignment]
    native.close()
    server = ControlServer(("127.0.0.1", 0), app)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    port = server.server_address[1]
    try:
        status, session = _request(port, "GET", "/api/session")
        token = session["csrfToken"]
        status, error = _request(
            port,
            "POST",
            "/api/compile",
            body={},
            headers={"Content-Type": "text/plain", "X-Weave-CSRF": token},
        )
        assert status == 400
        assert "application/json" in error["error"]

        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=3)
        connection.putrequest("GET", "/api/session", skip_host=True)
        connection.putheader("Host", "attacker.example")
        connection.endheaders()
        response = connection.getresponse()
        assert response.status == 403
        connection.close()
    finally:
        server.shutdown()
        server.server_close()
        worker.join(timeout=2)
