"""Long-lived, Codex-owned ChatGPT authentication for the local control plane."""

from __future__ import annotations

import hashlib
import json
import threading
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

from pydantic import BaseModel

from .auth_status import project_account_status


class AuthClient(Protocol):
    def start(self) -> None: ...
    def initialize(self) -> Any: ...
    def close(self) -> None: ...
    def account_read(self, params: dict[str, Any]) -> Any: ...
    def account_login_start(self, params: Any) -> Any: ...
    def wait_for_login_completed(self, login_id: str) -> Any: ...
    def request(
        self,
        method: str,
        params: dict[str, Any] | None,
        *,
        response_model: type[BaseModel],
    ) -> BaseModel: ...


@dataclass
class LoginAttempt:
    login_id: str
    state: str = "pending"
    message: str = "Finish signing in in the browser."

    def public(self) -> dict[str, str]:
        return {
            "loginId": self.login_id,
            "state": self.state,
            "message": self.message,
        }


def _sdk_client(codex_bin: str) -> AuthClient:
    from openai_codex.client import CodexClient, CodexConfig

    return CodexClient(
        CodexConfig(
            codex_bin=codex_bin,
            client_name="weave_codex_auth",
            client_title="WeaveCodex",
            client_version="0.1.0",
        )
    )


def _chatgpt_params() -> Any:
    from openai_codex.generated.v2_all import (
        ChatgptLoginAccountParams,
        LoginAccountParams,
        LoginAppBrand,
    )

    return LoginAccountParams(
        root=ChatgptLoginAccountParams(
            type="chatgpt",
            use_hosted_login_success_page=True,
            app_brand=LoginAppBrand.chatgpt,
        )
    )


class NativeAuthService:
    """Own one app-server connection so its browser callback remains alive."""

    def __init__(
        self,
        codex_bin: str,
        *,
        client_factory: Callable[[str], AuthClient] = _sdk_client,
    ) -> None:
        self._codex_bin = codex_bin
        self._client_factory = client_factory
        self._client: AuthClient | None = None
        self._attempts: dict[str, LoginAttempt] = {}
        self._lock = threading.RLock()

    def _ensure_client(self) -> AuthClient:
        with self._lock:
            if self._client is None:
                client = self._client_factory(self._codex_bin)
                client.start()
                try:
                    client.initialize()
                except Exception:
                    client.close()
                    raise
                self._client = client
            return self._client

    def status(self) -> dict[str, Any]:
        client = self._ensure_client()
        account = client.account_read({"refreshToken": False})
        return project_account_status(account)

    def integrations(self, cwd: str) -> dict[str, Any]:
        """Project the user's Codex-native integrations without exposing secrets."""

        from openai_codex.generated.v2_all import (
            AppsListResponse,
            ListMcpServerStatusResponse,
            SkillsListResponse,
        )

        workspace = Path(cwd).resolve(strict=True)
        if not workspace.is_dir():
            raise ValueError("cwd must be an existing directory")
        client = self._ensure_client()
        warnings: list[str] = []

        try:
            skills_response = client.request(
                "skills/list",
                {"cwds": [str(workspace)], "forceReload": False},
                response_model=SkillsListResponse,
            )
            skills = [
                {
                    "name": skill.name,
                    "description": skill.description,
                    "enabled": skill.enabled,
                    "scope": str(getattr(skill.scope, "value", skill.scope)),
                }
                for entry in skills_response.data
                for skill in entry.skills
            ]
            for entry in skills_response.data:
                if entry.errors:
                    warnings.append(
                        f"Codex reported {len(entry.errors)} skill loading error(s); "
                        "details stay local."
                    )
        except Exception:  # noqa: BLE001 - app-server errors may include local paths
            skills = []
            warnings.append("Codex could not enumerate skills for this workspace.")

        try:
            mcp_response = client.request(
                "mcpServerStatus/list",
                {"cursor": None, "limit": 100, "detail": "full"},
                response_model=ListMcpServerStatusResponse,
            )
            mcp_servers = [
                {
                    "name": server.name,
                    "authStatus": str(getattr(server.auth_status, "value", server.auth_status)),
                    "tools": sorted(server.tools),
                    "resourceCount": len(server.resources),
                    "resourceTemplateCount": len(server.resource_templates),
                }
                for server in mcp_response.data
            ]
            mcp_truncated = mcp_response.next_cursor is not None
        except Exception:  # noqa: BLE001 - fail partially, without raw config/errors
            mcp_servers = []
            mcp_truncated = False
            warnings.append("Codex could not enumerate MCP servers.")

        try:
            apps_response = client.request(
                "app/list",
                {"cursor": None, "limit": 100, "forceRefetch": False},
                response_model=AppsListResponse,
            )
            apps = [
                {
                    "id": app.id,
                    "name": app.name,
                    "description": app.description,
                    "accessible": bool(app.is_accessible),
                    "enabled": bool(app.is_enabled),
                    "installUrl": (
                        app.install_url
                        if app.install_url and app.install_url.startswith("https://")
                        else None
                    ),
                }
                for app in apps_response.data
            ]
            apps_truncated = apps_response.next_cursor is not None
        except Exception:  # noqa: BLE001 - connector discovery is optional
            apps = []
            apps_truncated = False
            warnings.append("Codex could not enumerate connector apps.")

        skills = sorted(skills, key=lambda value: value["name"].lower())
        mcp_servers = sorted(mcp_servers, key=lambda value: value["name"].lower())
        apps = sorted(
            apps,
            key=lambda value: (not value["accessible"], value["name"].lower()),
        )
        inventory_payload = {
            "workspace": str(workspace),
            "skills": [
                {
                    "name": item["name"],
                    "enabled": item["enabled"],
                    "scope": item["scope"],
                }
                for item in skills
            ],
            "mcpServers": [
                {
                    "name": item["name"],
                    "authStatus": item["authStatus"],
                    "tools": item["tools"],
                }
                for item in mcp_servers
            ],
            "apps": [
                {
                    "id": item["id"],
                    "accessible": item["accessible"],
                    "enabled": item["enabled"],
                }
                for item in apps
            ],
        }
        inventory_id = "sha256:" + hashlib.sha256(
            json.dumps(
                inventory_payload,
                ensure_ascii=False,
                separators=(",", ":"),
                sort_keys=True,
            ).encode()
        ).hexdigest()

        return {
            "cwd": str(workspace),
            "inventoryId": inventory_id,
            "skills": skills,
            "mcpServers": mcp_servers,
            "apps": apps,
            "warnings": warnings,
            "pagination": {
                "mcpTruncated": mcp_truncated,
                "appsTruncated": apps_truncated,
            },
            "privacy": {
                "secretsIncluded": False,
                "skillPathsIncluded": False,
                "configurationFilesIncluded": False,
            },
            "semantics": {
                "agents": (
                    "Inherited automatically by Codex from global and workspace AGENTS.md files."
                ),
                "skills": (
                    "Available skills can be invoked in a task; this inventory does not copy "
                    "their files."
                ),
                "mcp": (
                    "Configured MCP tools remain governed by Codex configuration, policy, "
                    "sandboxing, and approvals."
                ),
                "apps": (
                    "Accessible connector apps are Codex-owned connections. Weave never "
                    "receives their credentials."
                ),
            },
        }

    def start_chatgpt_login(self) -> dict[str, str]:
        """Start only the documented, Codex-managed browser flow."""

        client = self._ensure_client()
        response = client.account_login_start(_chatgpt_params())
        root = getattr(response, "root", response)
        login_id = str(getattr(root, "login_id", ""))
        auth_url = str(getattr(root, "auth_url", ""))
        if not login_id or not auth_url.startswith("https://"):
            raise RuntimeError("Codex did not return a valid ChatGPT login attempt")
        attempt = LoginAttempt(login_id=login_id)
        with self._lock:
            self._attempts = {login_id: attempt}
        threading.Thread(
            target=self._wait_for_login,
            args=(client, attempt),
            name=f"weave-login-{uuid.uuid4().hex[:8]}",
            daemon=True,
        ).start()
        # The short-lived URL is returned once to the initiating local UI. It is
        # never stored on the attempt, logged, or written into a run receipt.
        return {**attempt.public(), "authUrl": auth_url}

    def login_status(self, login_id: str) -> dict[str, Any] | None:
        with self._lock:
            attempt = self._attempts.get(login_id)
            public = attempt.public() if attempt else None
        if public is None:
            return None
        if public["state"] == "succeeded":
            public["account"] = self.status()
        return public

    def _wait_for_login(self, client: AuthClient, attempt: LoginAttempt) -> None:
        try:
            result = client.wait_for_login_completed(attempt.login_id)
            success = bool(getattr(result, "success", False))
            with self._lock:
                attempt.state = "succeeded" if success else "failed"
                attempt.message = (
                    "ChatGPT sign-in completed."
                    if success
                    else "ChatGPT sign-in did not complete. Try again."
                )
        except Exception:  # noqa: BLE001 - errors may contain auth data; fail closed
            with self._lock:
                attempt.state = "failed"
                attempt.message = "ChatGPT sign-in did not complete. Try again."

    def close(self) -> None:
        with self._lock:
            client, self._client = self._client, None
        if client is not None:
            client.close()
