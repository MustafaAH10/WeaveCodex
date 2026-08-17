from enum import Enum

import pytest

from weave_codex.auth_status import (
    account_read_params,
    chatgpt_browser_login_params,
    project_account_status,
)


def test_chatgpt_projection_is_subscription_aware_and_secret_free() -> None:
    source = {
        "account": {
            "type": "chatgpt",
            "email": "person@company.example",
            "planType": "business",
            "accessToken": "must-not-escape",
        },
        "requiresOpenaiAuth": True,
        "authToken": "must-not-escape",
    }

    assert project_account_status(
        source,
        account_updated={
            "method": "account/updated",
            "params": {"authMode": "chatgpt", "planType": "business"},
        },
    ) == {
        "schemaVersion": 1,
        "state": "ready",
        "canRun": True,
        "requiresOpenaiAuth": True,
        "accountType": "chatgpt",
        "observedAuthMode": "chatgpt",
        "planType": "business",
        "usageSource": "chatgptSubscription",
        "credentialManagement": "codexManaged",
        "subscriptionAccess": True,
        "message": "Connected to ChatGPT (business plan).",
        "privacy": {
            "containsSecrets": False,
            "emailIncluded": False,
            "source": "codexAppServerAccountRead",
        },
    }


@pytest.mark.parametrize(
    ("payload", "expected_state", "expected_can_run", "expected_usage"),
    [
        (
            {"account": None, "requiresOpenaiAuth": True},
            "signInRequired",
            False,
            "none",
        ),
        (
            {"account": None, "requiresOpenaiAuth": False},
            "providerReady",
            True,
            "externalProvider",
        ),
        (
            {"account": {"type": "apiKey"}, "requiresOpenaiAuth": True},
            "ready",
            True,
            "openaiApiAccount",
        ),
    ],
)
def test_projects_the_three_common_non_chatgpt_states(
    payload: dict[str, object],
    expected_state: str,
    expected_can_run: bool,
    expected_usage: str,
) -> None:
    result = project_account_status(payload)

    assert (result["state"], result["canRun"], result["usageSource"]) == (
        expected_state,
        expected_can_run,
        expected_usage,
    )
    assert result["subscriptionAccess"] is False


@pytest.mark.parametrize(
    ("account", "management", "message_suffix"),
    [
        (
            {"type": "amazonBedrock", "credentialSource": "codexManaged"},
            "codexManaged",
            "Codex-managed credential.",
        ),
        (
            {"type": "amazonBedrock", "usesCodexManagedCredentials": False},
            "awsManaged",
            "credential availability is not verified.",
        ),
    ],
)
def test_normalizes_bedrock_wire_shapes(
    account: dict[str, object], management: str, message_suffix: str
) -> None:
    result = project_account_status({"account": account, "requiresOpenaiAuth": False})

    assert result["credentialManagement"] == management
    assert result["message"].endswith(message_suffix)


def test_generated_sdk_models_are_accepted_without_importing_the_sdk() -> None:
    class Plan(Enum):
        plus = "plus"

    class FakeModel:
        def model_dump(self, **_: object) -> dict[str, object]:
            return {
                "account": {"type": "chatgpt", "email": None, "planType": Plan.plus},
                "requiresOpenaiAuth": True,
            }

    result = project_account_status(FakeModel())

    assert result["planType"] == "plus"
    assert result["observedAuthMode"] is None
    assert result["credentialManagement"] == "notObserved"


def test_unknown_source_fields_and_account_types_are_not_passed_through() -> None:
    result = project_account_status(
        {
            "account": {
                "type": "futureSecretProvider",
                "email": "private@example.com",
                "token": "secret",
            },
            "requiresOpenaiAuth": True,
        },
        account_updated={"authMode": "futureSecretMode", "accessToken": "secret"},
    )

    encoded = repr(result)
    assert result["state"] == "unknown"
    assert result["observedAuthMode"] is None
    assert "private@example.com" not in encoded
    assert "futureSecretProvider" not in encoded
    assert "secret" not in encoded


def test_passive_probe_and_managed_browser_login_contract() -> None:
    assert account_read_params() == {"refreshToken": False}
    assert chatgpt_browser_login_params() == {
        "type": "chatgpt",
        "useHostedLoginSuccessPage": True,
        "appBrand": "chatgpt",
    }

    first = chatgpt_browser_login_params()
    first["type"] = "mutated"
    assert chatgpt_browser_login_params()["type"] == "chatgpt"
