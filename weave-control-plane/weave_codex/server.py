"""Small local web host for the Weave Codex control plane."""

from __future__ import annotations

import argparse
import hmac
import json
import re
import secrets
import threading
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from pydantic import ValidationError

from .auth_service import NativeAuthService
from .manifest import HarnessManifest, compile_manifest
from .phase_program import PhaseProgram, compile_phase_program, phase_templates
from .runtime import HarnessRunner, RunSession
from .trace_projection import project_thread


class ControlPlane:
    def __init__(
        self,
        codex_bin: str,
        data_root: Path,
        workspace_root: Path | None = None,
    ) -> None:
        self.runner = HarnessRunner(codex_bin)
        self.auth = NativeAuthService(codex_bin)
        self.data_root = data_root
        current = Path.cwd().resolve()
        self.workspace_root = (
            workspace_root or (current.parent if current.name == "weave-control-plane" else current)
        ).resolve()
        self.sessions: dict[str, RunSession] = {}
        self.csrf_token = secrets.token_urlsafe(32)
        self._lock = threading.Lock()

    def close(self) -> None:
        self.auth.close()

    def create_run(self, manifest: HarnessManifest) -> RunSession:
        session = RunSession()
        with self._lock:
            self.sessions[session.run_id] = session

        def work() -> None:
            self.runner.run(manifest, session)
            self.data_root.mkdir(parents=True, exist_ok=True)
            payload = session.result or {"runId": session.run_id, "error": session.error}
            (self.data_root / f"{session.run_id}.json").write_text(
                json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8"
            )

        threading.Thread(target=work, name=f"weave-run-{session.run_id[:8]}", daemon=True).start()
        return session

    def saved_runs(self) -> list[dict[str, Any]]:
        if not self.data_root.exists():
            return []
        runs: list[dict[str, Any]] = []
        paths = sorted(
            self.data_root.glob("*.json"),
            key=lambda item: item.stat().st_mtime,
            reverse=True,
        )
        for path in paths:
            try:
                payload = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            runs.append(
                {
                    "runId": payload.get("runId") or path.stem,
                    "status": "completed" if payload.get("finalResponse") is not None else "failed",
                    "startedAt": payload.get("startedAt"),
                    "completedAt": payload.get("completedAt"),
                    "memoryMode": payload.get("memory", {}).get("mode"),
                    "sandbox": payload.get("controls", {}).get("sandbox"),
                    "turnCount": len(payload.get("turnIds", [])),
                    "phaseCount": len((payload.get("phaseProgram") or {}).get("executions", [])),
                    "completionStatus": payload.get("completionStatus", "completed"),
                    "verification": payload.get("verification", []),
                }
            )
        return runs[:30]

    def saved_run(self, run_id: str) -> dict[str, Any] | None:
        if re.fullmatch(r"[0-9a-f-]{36}", run_id) is None:
            return None
        path = self.data_root / f"{run_id}.json"
        if not path.is_file():
            return None
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None

    def product_examples(self) -> list[dict[str, Any]]:
        root = Path(__file__).parents[1] / "examples"
        examples: list[dict[str, Any]] = []
        for name in ("flappy-bird-observation.json", "checkout-repair-design.json"):
            try:
                value = json.loads((root / name).read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            if isinstance(value, dict):
                examples.append(value)
        return examples


class Handler(BaseHTTPRequestHandler):
    server: "ControlServer"

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if not self._local_request():
            self._json(HTTPStatus.FORBIDDEN, {"error": "WeaveCodex is local-only"})
            return
        if parsed.path == "/api/session":
            self._json(
                HTTPStatus.OK,
                {
                    "csrfToken": self.server.app.csrf_token,
                    "loopbackOnly": True,
                    "authenticationOwner": "codexAppServer",
                    "workspaceRoot": str(self.server.app.workspace_root),
                },
            )
            return
        if parsed.path == "/api/account":
            try:
                self._json(HTTPStatus.OK, self.server.app.auth.status())
            except Exception:  # noqa: BLE001 - never return raw auth errors
                self._json(
                    HTTPStatus.BAD_GATEWAY,
                    {"error": "Codex account status is unavailable."},
                )
            return
        if parsed.path == "/api/examples":
            self._json(HTTPStatus.OK, {"examples": self.server.app.product_examples()})
            return
        if parsed.path.startswith("/api/account/login/"):
            login_id = parsed.path.removeprefix("/api/account/login/")
            if re.fullmatch(r"[A-Za-z0-9_-]{1,160}", login_id) is None:
                self._json(HTTPStatus.BAD_REQUEST, {"error": "invalid login id"})
                return
            status = self.server.app.auth.login_status(login_id)
            self._json(
                HTTPStatus.OK if status is not None else HTTPStatus.NOT_FOUND,
                status or {"error": "login attempt not found"},
            )
            return
        if parsed.path == "/api/phase-templates":
            self._json(
                HTTPStatus.OK,
                {
                    "phasePrograms": True,
                    "compileEndpoint": "/api/compile",
                    "runEndpoint": "/api/runs",
                    "templates": phase_templates(),
                },
            )
            return
        if parsed.path == "/api/threads":
            cwd = parse_qs(parsed.query).get("cwd", [""])[0]
            try:
                self._json(HTTPStatus.OK, {"threads": self.server.app.runner.list_threads(cwd)})
            except Exception as exc:  # noqa: BLE001
                self._json(HTTPStatus.BAD_GATEWAY, {"error": str(exc)})
            return
        if parsed.path == "/api/runs":
            self._json(HTTPStatus.OK, {"runs": self.server.app.saved_runs()})
            return
        if parsed.path.startswith("/api/runs/"):
            run_id = parsed.path.removeprefix("/api/runs/")
            session = self.server.app.sessions.get(run_id)
            persisted = self.server.app.saved_run(run_id) if session is None else None
            self._json(
                HTTPStatus.OK if session or persisted else HTTPStatus.NOT_FOUND,
                session.snapshot()
                if session
                else {
                    "runId": run_id,
                    "status": (
                        "completed"
                        if persisted and persisted.get("finalResponse") is not None
                        else "failed"
                    ),
                    "events": [],
                    "timeline": persisted.get("timeline", []) if persisted else [],
                    "pendingApproval": None,
                    "result": persisted,
                    "error": persisted.get("error") if persisted else "run not found",
                },
            )
            return
        self._static(parsed.path)

    def do_POST(self) -> None:  # noqa: N802
        try:
            self._require_local_json()
            payload = self._body()
            if self.path == "/api/account/login/chatgpt":
                self._json(HTTPStatus.ACCEPTED, self.server.app.auth.start_chatgpt_login())
                return
            if self.path == "/api/compile":
                manifest = HarnessManifest.model_validate(payload)
                self._json(HTTPStatus.OK, compile_manifest(manifest))
                return
            if self.path == "/api/phase-compile":
                program = PhaseProgram.model_validate(payload)
                self._json(HTTPStatus.OK, compile_phase_program(program))
                return
            if self.path == "/api/thread-projection":
                cwd = str(payload.get("cwd", ""))
                thread_id = str(payload.get("threadId", ""))
                if not Path(cwd).is_absolute():
                    raise ValueError("cwd must be an absolute path")
                if re.fullmatch(r"[A-Za-z0-9_-]{1,160}", thread_id) is None:
                    raise ValueError("threadId contains unsupported characters")
                try:
                    thread = self.server.app.runner.read_thread(cwd, thread_id)
                except Exception as exc:  # noqa: BLE001
                    self._json(HTTPStatus.BAD_GATEWAY, {"error": str(exc)})
                    return
                self._json(HTTPStatus.OK, project_thread(thread))
                return
            if self.path == "/api/runs":
                manifest = HarnessManifest.model_validate(payload)
                session = self.server.app.create_run(manifest)
                self._json(HTTPStatus.ACCEPTED, {"runId": session.run_id})
                return
            if self.path.endswith("/approval") and self.path.startswith("/api/runs/"):
                run_id = self.path.split("/")[3]
                session = self.server.app.sessions.get(run_id)
                if session is None:
                    self._json(HTTPStatus.NOT_FOUND, {"error": "run not found"})
                    return
                session.decide(str(payload.get("decision", "")))
                self._json(HTTPStatus.OK, {"accepted": True})
                return
            self._json(HTTPStatus.NOT_FOUND, {"error": "route not found"})
        except (ValidationError, ValueError, json.JSONDecodeError) as exc:
            details = exc.errors() if isinstance(exc, ValidationError) else str(exc)
            self._json(HTTPStatus.BAD_REQUEST, {"error": details})

    def _local_request(self) -> bool:
        host = self.headers.get("Host", "")
        hostname = host.rsplit(":", 1)[0].strip("[]").lower()
        if hostname not in {"127.0.0.1", "localhost", "::1"}:
            return False
        origin = self.headers.get("Origin")
        if not origin:
            return True
        parsed = urlparse(origin)
        origin_host = (parsed.hostname or "").lower()
        return parsed.scheme == "http" and origin_host in {"127.0.0.1", "localhost", "::1"}

    def _require_local_json(self) -> None:
        if not self._local_request():
            raise ValueError("WeaveCodex accepts requests only from its loopback origin")
        media_type = self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
        if media_type != "application/json":
            raise ValueError("POST requests require application/json")
        supplied = self.headers.get("X-Weave-CSRF", "")
        if not hmac.compare_digest(supplied, self.server.app.csrf_token):
            raise ValueError("missing or invalid local session token")

    def _body(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        value = json.loads(self.rfile.read(length) or b"{}")
        if not isinstance(value, dict):
            raise ValueError("request body must be a JSON object")
        return value

    def _json(self, status: HTTPStatus, value: Any) -> None:
        body = json.dumps(value, default=str).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _static(self, request_path: str) -> None:
        name = {"/": "index.html"}.get(request_path, request_path.lstrip("/"))
        root = Path(__file__).with_name("static").resolve()
        path = (root / name).resolve()
        if root not in path.parents or not path.is_file():
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        content_type = {".html": "text/html", ".css": "text/css", ".js": "text/javascript"}.get(
            path.suffix, "application/octet-stream"
        )
        body = path.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", f"{content_type}; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: Any) -> None:
        print(f"weave-codex: {format % args}")


class ControlServer(ThreadingHTTPServer):
    def __init__(self, address: tuple[str, int], app: ControlPlane):
        super().__init__(address, Handler)
        self.app = app

    def server_close(self) -> None:
        self.app.close()
        super().server_close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the local Weave Codex control plane")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", default=8790, type=int)
    parser.add_argument("--codex-bin", default="codex")
    parser.add_argument("--data-root", default=".weave-codex/runs", type=Path)
    parser.add_argument("--workspace-root", type=Path)
    args = parser.parse_args()
    if args.host not in {"127.0.0.1", "localhost", "::1"}:
        parser.error("WeaveCodex currently binds only to a loopback host")
    server = ControlServer(
        (args.host, args.port),
        ControlPlane(args.codex_bin, args.data_root, args.workspace_root),
    )
    print(f"Weave Codex listening on http://{args.host}:{args.port}")
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
