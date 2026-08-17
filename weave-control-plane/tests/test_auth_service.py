from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any

from weave_codex.auth_service import NativeAuthService


@dataclass
class FakeRoot:
    login_id: str = "login-1"
    auth_url: str = "https://chatgpt.com/auth/example"


@dataclass
class FakeResponse:
    root: FakeRoot


@dataclass
class FakeCompletion:
    success: bool


class FakeClient:
    def __init__(self, *, completion: bool = True) -> None:
        self.started = False
        self.initialized = False
        self.closed = False
        self.completion = completion
        self.login_params: Any = None

    def start(self) -> None:
        self.started = True

    def initialize(self) -> None:
        self.initialized = True

    def close(self) -> None:
        self.closed = True

    def account_read(self, params: dict[str, Any]) -> dict[str, Any]:
        assert params == {"refreshToken": False}
        return {
            "account": {"type": "chatgpt", "email": "not-leaked", "planType": "plus"},
            "requiresOpenaiAuth": True,
        }

    def account_login_start(self, params: Any) -> FakeResponse:
        self.login_params = params
        return FakeResponse(FakeRoot())

    def wait_for_login_completed(self, login_id: str) -> FakeCompletion:
        assert login_id == "login-1"
        return FakeCompletion(success=self.completion)


def _wait(service: NativeAuthService, expected: str) -> dict[str, Any]:
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        value = service.login_status("login-1")
        if value and value["state"] == expected:
            return value
        time.sleep(0.01)
    raise AssertionError(f"login did not reach {expected}")


def test_status_reuses_one_long_lived_client_and_redacts_email() -> None:
    fake = FakeClient()
    service = NativeAuthService("codex", client_factory=lambda _: fake)

    first = service.status()
    second = service.status()

    assert fake.started and fake.initialized
    assert first == second
    assert first["usageSource"] == "chatgptSubscription"
    assert "not-leaked" not in repr(first)
    service.close()
    assert fake.closed


def test_browser_login_returns_url_once_and_polls_secret_free_status() -> None:
    fake = FakeClient()
    service = NativeAuthService("codex", client_factory=lambda _: fake)

    started = service.start_chatgpt_login()
    assert started["authUrl"] == "https://chatgpt.com/auth/example"
    completed = _wait(service, "succeeded")

    assert "authUrl" not in completed
    assert completed["account"]["subscriptionAccess"] is True
    assert service.login_status("unknown") is None
    assert fake.login_params.root.type == "chatgpt"
    assert fake.login_params.root.use_hosted_login_success_page is True
    assert fake.login_params.root.app_brand.value == "chatgpt"


def test_login_failure_never_exposes_the_source_error() -> None:
    fake = FakeClient(completion=False)
    service = NativeAuthService("codex", client_factory=lambda _: fake)

    service.start_chatgpt_login()
    failed = _wait(service, "failed")

    assert failed == {
        "loginId": "login-1",
        "state": "failed",
        "message": "ChatGPT sign-in did not complete. Try again.",
    }
