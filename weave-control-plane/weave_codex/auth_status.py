"""Secret-free projections of the Codex app-server account surface.

Weave must ask the official Codex app-server about authentication.  It must not
read ``CODEX_HOME/auth.json`` or receive credentials in its own HTTP/UI layer.
This module deliberately accepts the narrow ``account/read`` result and emits a
small display model constructed from an allowlist of non-secret fields.

The returned projection is suitable for a local status page.  It is not an
authorization decision: sandboxing, approvals, workspace policy, and provider
availability remain owned by Codex.
"""

from __future__ import annotations

from collections.abc import Mapping
from enum import Enum
from typing import Any

SCHEMA_VERSION = 1

_AUTH_MODES = {
    "apikey",
    "chatgpt",
    "chatgptAuthTokens",
    "headers",
    "agentIdentity",
    "personalAccessToken",
    "bedrockApiKey",
}


def account_read_params() -> dict[str, bool]:
    """Return the passive account probe used by Weave.

    ``refreshToken`` is intentionally false.  Ordinary Codex execution still
    performs its own automatic refresh when needed; the status page should not
    turn a read into an authentication mutation.
    """

    return {"refreshToken": False}


def chatgpt_browser_login_params() -> dict[str, Any]:
    """Return the documented managed ChatGPT browser-login request.

    The app-server response contains a short-lived ``authUrl``.  A caller may
    return that URL only to the local browser that initiated login.  It must not
    log, persist, or include it in a run receipt.
    """

    return {
        "type": "chatgpt",
        "useHostedLoginSuccessPage": True,
        "appBrand": "chatgpt",
    }


def project_account_status(
    account_read: Any,
    *,
    account_updated: Any | None = None,
) -> dict[str, Any]:
    """Project app-server account state without copying credentials or email.

    ``account_read`` may be a JSON mapping or a generated SDK model.  An
    optional, latest ``account/updated`` payload improves the distinction
    between Codex-managed ChatGPT OAuth and host-managed/internal modes.  The
    projection never passes through arbitrary source fields.
    """

    payload = _mapping(account_read)
    requires_openai_auth = bool(
        payload.get("requiresOpenaiAuth", payload.get("requires_openai_auth", True))
    )
    account = _optional_mapping(payload.get("account"))
    updated = _notification_params(account_updated)
    observed_auth_mode = _enum_string(
        updated.get("authMode", updated.get("auth_mode")) if updated else None
    )
    if observed_auth_mode not in _AUTH_MODES:
        observed_auth_mode = None

    if account is None:
        if requires_openai_auth:
            return _status(
                state="signInRequired",
                can_run=False,
                account_type=None,
                observed_auth_mode=observed_auth_mode,
                plan_type=None,
                usage_source="none",
                credential_management="none",
                requires_openai_auth=True,
                message="Sign in with ChatGPT to use subscription access.",
            )
        return _status(
            state="providerReady",
            can_run=True,
            account_type=None,
            observed_auth_mode=observed_auth_mode,
            plan_type=None,
            usage_source="externalProvider",
            credential_management="providerOrHost",
            requires_openai_auth=False,
            message="The selected provider does not require an OpenAI sign-in.",
        )

    account_type = _enum_string(account.get("type"))
    if account_type == "chatgpt":
        plan_type = _enum_string(account.get("planType", account.get("plan_type")))
        management = {
            "chatgpt": "codexManaged",
            "chatgptAuthTokens": "hostManaged",
            "personalAccessToken": "hostOrEnterpriseManaged",
        }.get(observed_auth_mode, "notObserved")
        return _status(
            state="ready",
            can_run=True,
            account_type="chatgpt",
            observed_auth_mode=observed_auth_mode,
            plan_type=plan_type,
            usage_source="chatgptSubscription",
            credential_management=management,
            requires_openai_auth=requires_openai_auth,
            message=(
                f"Connected to ChatGPT ({_display_plan(plan_type)} plan)."
                if plan_type
                else "Connected to ChatGPT."
            ),
        )

    if account_type == "apiKey":
        return _status(
            state="ready",
            can_run=True,
            account_type="apiKey",
            observed_auth_mode=observed_auth_mode or "apikey",
            plan_type=None,
            usage_source="openaiApiAccount",
            credential_management="codexManaged",
            requires_openai_auth=requires_openai_auth,
            message="Connected with an API key; usage is billed to the API account.",
        )

    if account_type == "amazonBedrock":
        source = _bedrock_credential_source(account)
        return _status(
            state="providerReady",
            can_run=True,
            account_type="amazonBedrock",
            observed_auth_mode=observed_auth_mode,
            plan_type=None,
            usage_source="amazonBedrock",
            credential_management=("codexManaged" if source == "codexManaged" else "awsManaged"),
            requires_openai_auth=requires_openai_auth,
            message=(
                "Amazon Bedrock is selected with a Codex-managed credential."
                if source == "codexManaged"
                else "Amazon Bedrock is selected; AWS credential availability is not verified."
            ),
        )

    return _status(
        state="unknown",
        can_run=False,
        account_type=None,
        observed_auth_mode=observed_auth_mode,
        plan_type=None,
        usage_source="unknown",
        credential_management="unknown",
        requires_openai_auth=requires_openai_auth,
        message="Codex returned an account type this Weave build does not recognize.",
    )


def _status(
    *,
    state: str,
    can_run: bool,
    account_type: str | None,
    observed_auth_mode: str | None,
    plan_type: str | None,
    usage_source: str,
    credential_management: str,
    requires_openai_auth: bool,
    message: str,
) -> dict[str, Any]:
    return {
        "schemaVersion": SCHEMA_VERSION,
        "state": state,
        "canRun": can_run,
        "requiresOpenaiAuth": requires_openai_auth,
        "accountType": account_type,
        "observedAuthMode": observed_auth_mode,
        "planType": plan_type,
        "usageSource": usage_source,
        "credentialManagement": credential_management,
        "subscriptionAccess": usage_source == "chatgptSubscription",
        "message": message,
        "privacy": {
            "containsSecrets": False,
            "emailIncluded": False,
            "source": "codexAppServerAccountRead",
        },
    }


def _mapping(value: Any) -> dict[str, Any]:
    if isinstance(value, Mapping):
        return dict(value)
    if hasattr(value, "model_dump"):
        dumped = value.model_dump(by_alias=True, mode="json", exclude_none=True)
        if isinstance(dumped, Mapping):
            return dict(dumped)
    root = getattr(value, "root", None)
    if root is not None and root is not value:
        return _mapping(root)
    raise TypeError("account state must be a mapping or generated SDK model")


def _optional_mapping(value: Any) -> dict[str, Any] | None:
    if value is None:
        return None
    return _mapping(value)


def _notification_params(value: Any | None) -> dict[str, Any] | None:
    if value is None:
        return None
    payload = _mapping(value)
    params = payload.get("params")
    return _mapping(params) if params is not None else payload


def _enum_string(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, Enum):
        value = value.value
    text = str(value).strip()
    return text or None


def _bedrock_credential_source(account: Mapping[str, Any]) -> str:
    source = _enum_string(account.get("credentialSource", account.get("credential_source")))
    if source in {"codexManaged", "awsManaged"}:
        return source
    managed = account.get(
        "usesCodexManagedCredentials",
        account.get("uses_codex_managed_credentials"),
    )
    return "codexManaged" if managed is True else "awsManaged"


def _display_plan(value: str) -> str:
    return value.replace("_", " ").replace("-", " ")
