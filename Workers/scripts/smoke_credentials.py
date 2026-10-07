"""Smoke test for per-organisation model keys — no network, no database.

A customer may bring their own key, and one container serves every customer in
turn. That combination is where the bugs live, so this pins the behaviour down:

  · resolution       the organisation's key when they have one, the
                     environment's when they do not — and a lookup that cannot
                     be completed raises, because treating an unreachable app
                     as "no key" spends the operator's money on a customer who
                     had configured their own
  · isolation        two organisations in one process get their own clients,
                     carrying their own keys and their own models. This is the
                     one that matters: `llm.client()` held a single module
                     global before, which would have handed the first
                     customer's key to every customer after them
  · attribution      a run records the model that actually judged it, and a
                     usage row records whose account the provider billed —
                     generation only, since embeddings stay on the deployment's
                     key by design
  · wording          a refusal names whose key was rejected, because the two
                     send a person to different places

    PYTHONPATH=Workers python3 Workers/scripts/smoke_credentials.py
"""

from __future__ import annotations

import json
import os
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
os.environ.setdefault("STAGE", "analyse")
os.environ.setdefault("DATABASE_URL", "postgresql://smoke/test")
# Pinned rather than defaulted: Workers/.env is loaded into this process too.
os.environ["LLM_PROVIDER"] = "openrouter"
os.environ["OPENROUTER_API_KEY"] = "platform-key"
os.environ["OPENROUTER_MODEL"] = "openai/gpt-4.1-mini"
os.environ["OPENROUTER_FAST_MODEL"] = "openai/gpt-4.1-nano"
os.environ["OPENROUTER_PROVIDERS"] = "openai,azure"
os.environ["APP_BASE_URL"] = "http://app.invalid"
os.environ["WORKER_SHARED_SECRET"] = "shared"

import httpx  # noqa: E402

from aidp import credentials, usage  # noqa: E402
from aidp.ai import llm  # noqa: E402

passed = failed = 0


def ok(name: str, condition: bool, extra: object = "") -> None:
    global passed, failed
    if condition:
        passed += 1
        print(f"  PASS {name}")
    else:
        failed += 1
        print(f"  FAIL {name} {extra}")


class FakeResponse:
    def __init__(self, status: int, body: dict) -> None:
        self.status_code = status
        self._body = body
        self.text = json.dumps(body)
        self.request = httpx.Request("GET", "http://app.invalid")

    def json(self) -> dict:
        return self._body

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise httpx.HTTPStatusError(
                self.text, request=self.request, response=httpx.Response(self.status_code)
            )


class FakeClient:
    """Stands in for the app. `answers` is keyed by organisation id."""

    answers: dict[str, object] = {}
    asked: list[tuple[str, str]] = []

    def __init__(self, *args, **kwargs) -> None:
        pass

    def __enter__(self) -> FakeClient:
        return self

    def __exit__(self, *args) -> None:
        return None

    def get(self, url, params=None, headers=None):
        organisation = (params or {}).get("organisationId", "")
        FakeClient.asked.append((organisation, (headers or {}).get("x-worker-secret", "")))
        answer = FakeClient.answers.get(organisation, {"credential": None})
        if isinstance(answer, Exception):
            raise answer
        return FakeResponse(200, answer)  # type: ignore[arg-type]


def key_of(client: object) -> str:
    return getattr(client, "api_key", "")


ACME = {
    "credential": {
        "provider": "anthropic",
        "apiKey": "acme-key",
        "model": "claude-sonnet-4-5",
        "fastModel": "claude-haiku-4-5-20251001",
        "openrouterProviders": [],
        "zdr": False,
    }
}
BEECH = {
    "credential": {
        "provider": "openrouter",
        "apiKey": "beech-key",
        "model": "openai/gpt-5",
        "fastModel": "openai/gpt-5-mini",
        "openrouterProviders": ["openai"],
        "zdr": True,
    }
}

httpx.Client = FakeClient  # type: ignore[misc,assignment]
credentials.httpx.Client = FakeClient  # type: ignore[attr-defined]

# ---------------------------------------------------------------------------
print("\n1. Which key answers for a job")
FakeClient.answers = {"acme": ACME, "none": {"credential": None}}

acme = credentials.for_job("acme")
ok("the organisation's own key is used when they have one", acme.api_key == "acme-key")
ok(
    "with their provider and model",
    (acme.provider, acme.model) == ("anthropic", "claude-sonnet-4-5"),
)
ok(
    "and it is marked as theirs",
    acme.customers_own and acme.source == credentials.ORGANISATION,
)
ok("asked with the shared secret", FakeClient.asked[-1] == ("acme", "shared"))

plain = credentials.for_job("none")
ok("no key of their own falls back to the environment's", plain.api_key == "platform-key")
ok(
    "which is the configured provider and model",
    (plain.provider, plain.model) == ("openrouter", "openai/gpt-4.1-mini"),
)
ok("and is not marked as the customer's", not plain.customers_own)

FakeClient.answers = {"broken": httpx.ConnectError("refused")}
try:
    credentials.for_job("broken")
    ok("an unreachable app stops the job rather than guessing whose key to use", False)
except credentials.CredentialUnavailable as exc:
    ok(
        "an unreachable app stops the job rather than guessing whose key to use",
        "could not read the organisation's model key" in str(exc),
        exc,
    )

FakeClient.answers = {"half": {"credential": {"provider": "anthropic", "apiKey": ""}}}
try:
    credentials.for_job("half")
    ok("a key that comes back incomplete is a fault, not an absence", False)
except credentials.CredentialUnavailable:
    ok("a key that comes back incomplete is a fault, not an absence", True)

# ---------------------------------------------------------------------------
print("\n2. One container, two customers")
llm.forget_clients()
FakeClient.answers = {"acme": ACME, "beech": BEECH, "none": {"credential": None}}

credentials.bind(credentials.for_job("acme"))
first = llm.client()
ok("the first customer gets a client for their provider", isinstance(first, llm.AnthropicLLM))
ok("carrying their key", key_of(first) == "acme-key")
ok(
    "and the run records the model that judged it",
    llm.model_name() == ("anthropic", "claude-sonnet-4-5"),
)

credentials.bind(credentials.for_job("beech"))
second = llm.client()
ok("the next customer does not inherit it", second is not first)
ok("they get their own provider", isinstance(second, llm.OpenRouterLLM))
ok("their own key", key_of(second) == "beech-key")
ok("their own model", llm.model_name() == ("openrouter", "openai/gpt-5"))
ok("and their own routing", second.providers == ("openai",) and second.zdr is True)

credentials.bind(credentials.for_job("acme"))
again = llm.client()
ok("a second job for the first customer reuses their client", again is first)

credentials.bind(credentials.for_job("none"))
ok(
    "an organisation with no key of its own uses the environment's",
    key_of(llm.client()) == "platform-key",
)

credentials.bind(None)
ok("and nothing bound at all still works, for scripts and smoke tests", llm.available())
ok("on the environment's key", key_of(llm.client()) == "platform-key")

llm.forget_clients()
for index in range(llm._CLIENT_CACHE_MAX + 4):
    credentials.bind(
        credentials.Credential(
            provider="anthropic",
            api_key=f"key-{index}",
            model="claude-sonnet-4-5",
            fast_model="claude-haiku-4-5-20251001",
            source=credentials.ORGANISATION,
        )
    )
    llm.client()
ok(
    "the client cache is bounded, so a long-lived worker does not grow one per customer",
    len(llm._clients) <= llm._CLIENT_CACHE_MAX,
    len(llm._clients),
)

# ---------------------------------------------------------------------------
print("\n3. A key with no model behind it")
credentials.bind(
    credentials.Credential(provider="anthropic", api_key=None, model="", fast_model="")
)
ok("no key means no model is available", not llm.available())
try:
    llm.client()
    ok("and asking for one says which key is missing", False)
except RuntimeError as exc:
    ok("and asking for one says which key is missing", "ANTHROPIC_API_KEY" in str(exc), exc)

# ---------------------------------------------------------------------------
print("\n4. Who pays")
credentials.bind(credentials.for_job("acme"))
ok("a model call on the customer's key is billed to them", usage._payer("llm") == "organisation")
ok(
    "an embedding is the platform's either way, because embeddings never move",
    usage._payer("embedding") == "platform",
)
credentials.bind(credentials.for_job("none"))
ok("a model call on the environment's key is the platform's", usage._payer("llm") == "platform")

# ---------------------------------------------------------------------------
print("\n5. What a refusal says")
credentials.bind(credentials.for_job("acme"))
ok(
    "the customer's key is named as theirs",
    credentials.whose() == "your organisation's own model key",
)
credentials.bind(credentials.for_job("none"))
ok("and the deployment's as the platform's", credentials.whose() == "the platform's model key")
credentials.bind(None)

print(f"\n{passed} passed, {failed} failed")
sys.exit(0 if failed == 0 else 1)
