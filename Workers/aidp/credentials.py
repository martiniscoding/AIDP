"""Which model key does this job's work.

Until now there was one answer, read from the environment at startup. Now a
customer may bring their own, so the answer is per *job* — and that is the whole
difficulty, because one analyse container serves every organisation in turn.

Two things follow from that, and both are mistakes waiting to be made:

1. The key is bound to the job, not to the process. `llm.client()` used to cache
   a single client in a module global; with per-organisation keys that global
   would serve the next company with whatever key the last one warmed it with.
   A ContextVar, bound once per job in __main__, exactly as usage.py does for
   attribution — and a ContextVar rather than a global because the lease reaper
   runs as a daemon thread beside the handler.

2. The workers never hold customer keys. They ask the app, through
   /api/internal/credentials with the shared secret, which is the arrangement
   src/lib/ingest/storage.ts already argues for with the UploadThing token: the
   means of decryption exists in one runtime, rotation does not mean
   redeploying two, and every read passes one audit point.

Generation only. Embeddings keep reading the environment (see ai/embeddings.py)
because a vector is only comparable with vectors from the same model and the
corpus is indexed by embedding model name — a customer whose key changed that
would lose dense retrieval over everything already ingested, silently.

No key, an inactive key, or one the app cannot decrypt all mean the same thing
here: use the environment's, which is what every organisation did before this
existed. What does *not* mean that is a lookup that could not be completed. That
raises, the job retries with backoff, and the reason is that the alternative —
treating an unreachable app as "no key" — quietly spends the operator's money on
a customer who had configured their own.
"""

from __future__ import annotations

import contextvars
from dataclasses import dataclass

import httpx

from . import logs
from .config import get_config

log = logs.get(__name__)

# One lookup per job rather than one per model call, so this is never in a hot
# path. Short anyway: the app answers from one indexed row.
TIMEOUT = httpx.Timeout(20.0, connect=10.0)

ORGANISATION = "organisation"
ENVIRONMENT = "environment"


@dataclass(frozen=True)
class Credential:
    """A provider, a key, and the models to call with it."""

    provider: str
    api_key: str | None
    model: str
    # The high-volume call — one preamble per chunk. Equal to `model` on a
    # provider with no separate cheap model.
    fast_model: str
    openrouter_providers: tuple[str, ...] = ()
    zdr: bool = False
    # Gemini only, and never customer-set: thinking is an operational setting,
    # not a commercial one, and a customer has no way to know that raising it
    # without raising max_tokens returns empty answers.
    thinking_budget: int = 0
    # Which key the provider will bill. Decides the `payer` on every usage row
    # and how a refusal is worded to whoever has to fix it.
    source: str = ENVIRONMENT

    @property
    def customers_own(self) -> bool:
        return self.source == ORGANISATION


class CredentialUnavailable(RuntimeError):
    """The key for this job could not be determined — so the job must not run.

    Distinct from "there is no key", which is an answer. This is the absence of
    an answer, and the right response to it is to try again later rather than to
    guess which account to bill.
    """


_context: contextvars.ContextVar[Credential | None] = contextvars.ContextVar(
    "aidp_model_credential", default=None
)


def current() -> Credential | None:
    return _context.get()


def bind(credential: Credential | None) -> None:
    _context.set(credential)


def active() -> Credential:
    """The bound credential, or the environment's.

    Falling back rather than raising keeps every script, smoke test and
    one-off that calls the AI modules directly working exactly as before: they
    bind nothing and get the environment, which is what they have always used.
    """
    return _context.get() or from_environment()


def from_environment() -> Credential:
    """The deployment's own key, as config.py read it at startup."""
    cfg = get_config()
    provider = cfg.llm_provider.lower()

    if provider == "openrouter":
        return Credential(
            provider="openrouter",
            api_key=cfg.openrouter_api_key,
            model=cfg.openrouter_model,
            fast_model=cfg.openrouter_fast_model,
            openrouter_providers=cfg.openrouter_providers,
            zdr=cfg.openrouter_zdr,
        )
    if provider == "anthropic":
        return Credential(
            provider="anthropic",
            api_key=cfg.anthropic_api_key,
            model=cfg.claude_model,
            fast_model=cfg.claude_fast_model,
        )
    if provider == "gemini":
        return Credential(
            provider="gemini",
            api_key=cfg.gemini_api_key,
            # Gemini's client takes one model: the figure pass and the preamble
            # pass both use it.
            model=cfg.gemini_model,
            fast_model=cfg.gemini_model,
            thinking_budget=cfg.gemini_thinking_budget,
        )
    # Unknown LLM_PROVIDER. Carried through rather than corrected, so the error
    # names what was configured instead of silently using another vendor.
    return Credential(provider=provider, api_key=None, model="", fast_model="")


def _from_payload(payload: dict) -> Credential:
    cfg = get_config()
    provider = str(payload.get("provider") or "").lower()
    model = str(payload.get("model") or "")
    return Credential(
        provider=provider,
        api_key=str(payload.get("apiKey") or "") or None,
        model=model,
        fast_model=str(payload.get("fastModel") or "") or model,
        openrouter_providers=tuple(
            str(name).strip().lower()
            for name in (payload.get("openrouterProviders") or [])
            if str(name).strip()
        ),
        zdr=bool(payload.get("zdr")),
        # Not from the payload: see the field's note.
        thinking_budget=cfg.gemini_thinking_budget,
        source=ORGANISATION,
    )


def for_job(organisation_id: str) -> Credential:
    """The credential this job's model calls should use.

    Called once per job from the worker loop. An analyse run makes hundreds of
    model calls behind this one lookup.
    """
    cfg = get_config()
    if not cfg.app_base_url or not cfg.worker_shared_secret:
        # No way to ask, which is the local development arrangement and the
        # same condition storage.py treats as "use the local backend". There is
        # nothing to fall back *from* here: a deployment where customers bring
        # keys has both of these set.
        return from_environment()

    endpoint = cfg.app_base_url.rstrip("/") + "/api/internal/credentials"
    try:
        with httpx.Client(timeout=TIMEOUT) as client:
            res = client.get(
                endpoint,
                params={"organisationId": organisation_id},
                headers={"x-worker-secret": cfg.worker_shared_secret},
            )
            res.raise_for_status()
            payload = res.json()
    except Exception as exc:  # noqa: BLE001 — see the class docstring
        raise CredentialUnavailable(
            f"could not read the organisation's model key: {str(exc)[:200]}"
        ) from exc

    found = payload.get("credential")
    if not found:
        return from_environment()

    credential = _from_payload(found)
    if not credential.api_key or not credential.provider:
        # The app answered with something unusable. Treating it as absent would
        # be a guess; the row exists and says this organisation wants its own
        # key used, so this is a fault to fix rather than to work around.
        raise CredentialUnavailable(
            "the organisation's model key came back incomplete from the app"
        )

    logs.info(
        log,
        "using the organisation's own model key",
        provider=credential.provider,
        model=credential.model,
    )
    return credential


def whose(credential: Credential | None = None) -> str:
    """How to name the key in a message somebody has to act on.

    A rejected key sends a person to one of two different places, and "the API
    key was rejected" sends them to neither.
    """
    chosen = credential or current()
    if chosen is not None and chosen.customers_own:
        return "your organisation's own model key"
    return "the platform's model key"
