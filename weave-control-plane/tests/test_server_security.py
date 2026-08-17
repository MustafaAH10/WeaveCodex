from __future__ import annotations

import http.client
import json
import threading
from pathlib import Path
from typing import Any

from weave_codex.server import ControlPlane, ControlServer


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

        status, completed = _request(port, "GET", "/api/account/login/login-1")
        assert status == 200
        assert completed["state"] == "succeeded"
    finally:
        server.shutdown()
        server.server_close()
        worker.join(timeout=2)
    assert fake.closed


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
