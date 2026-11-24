"""Worker configuration, read once from the environment at startup.

Every value is externalised rather than baked in — the customer's Solution
Architecture Standards §3.4 asks for exactly that, and it is also what lets one
image serve all four stages.
"""

from __future__ import annotations

import os
import socket
import uuid
from dataclasses import dataclass, field

from dotenv import load_dotenv

load_dotenv()

STAGES = ("parse", "chunk", "embed", "analyse")


def _int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    return int(raw) if raw else default


#: What counts as "no" in an environment variable. Everything else is yes.
_OFF = ("0", "off", "false", "no")


def _flag(name: str, default: bool) -> bool:
    """A boolean knob, where **unset and empty both mean the default**.

    This was written inline six times as

        os.environ.get("PREFER_WHOLE_DOCUMENT", "on").lower() not in _OFF

    which reads correctly and is wrong for one value: the empty string is not in
    `_OFF`, so `PREFER_WHOLE_DOCUMENT=` evaluated to **True**. Empty meant "on",
    not "default" and not "off" — the opposite of what anyone setting a variable
    to nothing intends.

    That is not hypothetical. `docker-compose.yml` passes
    `PREFER_WHOLE_DOCUMENT: ${PREFER_WHOLE_DOCUMENT:-}`, which is empty whenever
    compose is run somewhere that `Workers/.env` is not interpolated from — a
    different working directory, a recreate with the file out of scope. The
    knob's own comment in `.env` prices the accident: whole-document mode billed
    11,134 input tokens a call across 382 calls, 84% of a $2.03 run. A run would
    silently cost several times what it was meant to, and nothing would say so.

    `_int` above already got this right (`int(raw) if raw else default`). This is
    the same rule for flags, in one place rather than six.
    """
    raw = os.environ.get(name)
    return default if not raw else raw.strip().lower() not in _OFF


# Which key selects which provider, in the order they are tried.
_PROVIDER_KEYS = (
    ("gemini", ("GEMINI_API_KEY", "GOOGLE_API_KEY")),
    ("openrouter", ("OPENROUTER_API_KEY",)),
    ("anthropic", ("ANTHROPIC_API_KEY",)),
)


def _provider() -> str:
    """The provider to use: what LLM_PROVIDER says, else whichever key is set.

    An explicit LLM_PROVIDER always wins, including when its key is missing —
    a deployment that names a provider and forgets the key wants the error, not
    a silent switch to another vendor's model and another vendor's bill.

    Without it the old default was "gemini" whatever the environment held, so a
    worker given only an OpenRouter key reported no model configured and
    skipped the work that needed one. Every call reads the key belonging to the
    provider, so the two have to agree; picking the provider from the key that
    exists is the agreement that needs no second variable.
    """
    named = os.environ.get("LLM_PROVIDER", "").strip().lower()
    if named:
        return named
    for provider, keys in _PROVIDER_KEYS:
        if any(os.environ.get(key) for key in keys):
            return provider
    # Nothing configured. Keep the historic default so the error a caller sees
    # is "no API key" rather than "unknown provider ''".
    return "gemini"


@dataclass(frozen=True)
class Config:
    # Which loop this container runs. One image, four possible roles.
    stage: str

    # Workers hold interactive transactions, so they want Neon's *direct* host,
    # not the pooled one. PgBouncer's transaction mode would break the lease
    # semantics the queue depends on.
    database_url: str

    # Identifies the lease holder in the job table, so an abandoned lease can be
    # traced back to a container rather than just timing out anonymously.
    worker_id: str = field(
        default_factory=lambda: f"{socket.gethostname()}-{uuid.uuid4().hex[:8]}"
    )

    # A claimed job is invisible to other workers for this long. Handlers that
    # can outrun it — parsing a long PDF with vision calls — extend it instead
    # of being reaped mid-work.
    lease_seconds: int = 600

    # Adaptive backoff. Fast while there is work, slow when idle: three stages
    # polling every 30s is a handful of indexed lookups returning nothing.
    poll_min_seconds: float = 1.0
    poll_max_seconds: float = 30.0

    # Which model provider does the figure descriptions and chunk preambles.
    # "gemini" | "anthropic" — see aidp/ai/llm.py.
    llm_provider: str = "gemini"

    gemini_api_key: str | None = None
    # A flash-class model: the preamble runs once per chunk, so this is the
    # cost-dominant call in the pipeline.
    gemini_model: str = "gemini-2.5-flash"
    # 0 disables thinking. 2.5 Flash bills thinking against the same output
    # budget as the answer, and at these sizes it spends the whole allowance
    # reasoning and returns nothing. Raise it only for a model that cannot
    # disable thinking, and raise max_tokens with it.
    gemini_thinking_budget: int = 0
    # One model call per chunk — comfortably the largest consumer of
    # generation quota in the pipeline, and a retrieval-quality nicety
    # rather than a requirement. Turn it off on a constrained key.
    contextual_preambles: bool = True
    # Whether a reference standard's rules are read by a model, with every line
    # reference checked by code (see aidp/parsing/rules.py), rather than taken
    # only from the rule-based parser. Off falls back to the parser alone.
    rules_by_model: bool = True
    #: Let the model's own findings of fact overturn a hedged verdict.
    #:
    #: Off by default, because it changes what a verdict means. On, a clause
    #: graded "partial" whose `contrary_practice` field names a sentence where
    #: this design does what the clause forbids — and whose quote survives
    #: verification, and which the document does not record as an approved
    #: exception — is recorded as "contradicts" instead.
    #:
    #: It exists to be measured against the clauses it is aimed at: twenty-one
    #: breaches that six consecutive runs all graded "partial". Compare the two
    #: settings on the same clause set with
    #: `scripts/judge_harness.py --baseline <saved>`.
    verdict_procedure: bool = False
    stack_unlisted: bool = False

    # Independent readings per standard. The second is the cross-check: lines
    # the two readings disagree about are put in front of a reviewer. One
    # halves the cost and loses that check.
    rules_readings: int = 2
    # How many times each clause is judged before a verdict is written.
    #
    # One reading is one opinion, and a model does not hold the same opinion
    # twice: two runs over one design have come back 9 absent and 4 needing
    # review, then 7 and 7. On an assessment somebody takes to an architecture
    # board that is the whole credibility of the thing — a reviewer who runs it
    # again on Thursday to show their manager, and is shown a different report,
    # stops believing either one.
    #
    # So a clause is read more than once and the readings are voted on, which
    # is what `coverage_reads` already does for the parts of a design no clause
    # governs, and for the same reason. Readings stop early when they agree, so
    # the common case costs two and only a genuinely contested clause costs
    # three. 1 turns voting off and restores the single-reading behaviour.
    # See `_vote` in stages/analyse.py.
    judge_readings: int = 3
    # How many clauses are judged at once.
    #
    # Each clause is an independent question, committed in its own transaction,
    # and the loop that asked them was strictly sequential: at roughly fifteen
    # seconds a clause, a hundred-and-twenty-clause framework took half an hour
    # of a reviewer's afternoon, and a project of three designs took ninety
    # minutes. Nothing about the work needed that — it was waiting on one
    # provider call at a time.
    #
    # The ceiling is the provider's rate limit rather than this machine: the
    # work is entirely I/O. Keep it under the database pool (`DB_POOL_MAX`,
    # which is sized from this) and under whatever the key allows. 1 restores
    # the sequential loop.
    assess_concurrency: int = 8
    # Whether a run that was not told how to read the design reads it whole
    # when it fits, rather than by search.
    #
    # Search shows the judge the eight passages it ranked closest to a clause,
    # and the dominant failure of an assessment is the clause whose answer was
    # on page 23 and did not make that window: the report says "not addressed"
    # about something the design plainly addresses, which is the single fastest
    # way to lose a reviewer's trust. Reading the document whole cannot make
    # that mistake, checks every quote word for word, and is what the
    # provider's prompt cache makes affordable.
    #
    # Only for a run whose mode is "auto" — a reviewer who explicitly asked for
    # search gets search. A single design that will not fit the token budget
    # falls back and says so in the run's note. See `_resolve_mode`.
    prefer_whole_document: bool = True
    # The largest document a whole-document assessment reads at once, in
    # tokens. Above it the run falls back to search and says so. Well inside
    # the model's context; the ceiling is cost, since every clause of a run
    # sends the whole document (cached after the first).
    whole_document_max_tokens: int = 250_000
    # How many times the design is read for parts no standard governs. A model
    # asked once answers a slightly different question each time — on a real
    # proposal the count moved between 5 and 14 — so it is asked several times
    # and only what most reads found is reported. 1 turns that off. See
    # `coverage.agree`.
    coverage_reads: int = 3
    # Whether an assessment ends with improvements to the design itself, suggested
    # by a model after every clause is judged. One whole-document call per run.
    improvement_suggestions: bool = True
    # How long a design's suggested improvements are reused, in days, while the
    # design, the standards, the model and the prompt are all unchanged. Asking
    # again inside that window gives the same suggestions rather than a new set
    # from the same inputs. 0 turns the reuse off. See advice.py.
    advice_cache_days: int = 90
    # Whether an assessment looks up the support status of the technologies a
    # design names on endoflife.date. Only public product ids are sent, never
    # anything from the design — see lifecycle.py. Off for a customer who wants
    # nothing looked up outside at all.
    lifecycle_check: bool = True
    # Support ending within this many days is reported as ending soon.
    lifecycle_soon_days: int = 365
    lifecycle_base_url: str = "https://endoflife.date/api"
    # Whether slides drawn as diagrams in PowerPoint's own shapes are
    # photographed — through LibreOffice, inside this container — so the vision
    # model can read their arrows. Off, such a slide is read as its words alone.
    # See aidp/parsing/slide_render.py.
    slide_diagrams: bool = True

    # OpenRouter: one key for every model call, OpenAI's models behind it.
    openrouter_api_key: str | None = None
    # Everything a verdict or a rule rests on — reading a standard's rules,
    # judging a clause, describing a figure, summarising a document. Strict
    # JSON schema support, no hidden reasoning tokens on the bill.
    openrouter_model: str = "openai/gpt-4.1-mini"
    # The high-volume call: one contextual preamble per chunk.
    openrouter_fast_model: str = "openai/gpt-4.1-nano"
    # Upstream hosts a request may be served by. OpenAI's models are hosted by
    # OpenAI and Azure; pinning keeps client documents off any other host.
    # Empty means OpenRouter's own routing.
    openrouter_providers: tuple[str, ...] = ("openai", "azure")
    # Demand zero-data-retention endpoints. Off by default because not every
    # model has one — gpt-4.1-mini has none, and OpenRouter refuses the request
    # outright rather than falling back. `data_collection: deny` is always sent.
    openrouter_zdr: bool = False

    anthropic_api_key: str | None = None
    # Describing a diagram is a judgement call and gets the stronger model.
    claude_model: str = "claude-sonnet-4-5"
    # The contextual preamble runs once per chunk — hundreds of calls per
    # document — and is a summarising task, so it gets the cheap model. Prompt
    # caching already carries most of the cost saving; this carries the rest.
    claude_fast_model: str = "claude-haiku-4-5-20251001"

    # Gemini does have an embeddings endpoint, so one provider can cover both
    # roles. See aidp/ai/embeddings.py.
    embedding_provider: str = "gemini"
    embedding_model: str = "gemini-embedding-001"
    # Must match the vector(N) column width in the migration. Changing it needs
    # a migration, which is why it is asserted at startup rather than trusted.
    embedding_dims: int = 1024
    voyage_api_key: str | None = None
    openai_api_key: str | None = None

    # "local" writes under storage_local_path; "app" reaches UploadThing
    # through the Next.js app's internal endpoint. Workers deliberately do not
    # hold the UploadThing token — see aidp/storage.py.
    storage_backend: str = "local"
    storage_local_path: str = "./.storage"
    app_base_url: str | None = None
    worker_shared_secret: str | None = None

    @classmethod
    def from_env(cls) -> Config:
        stage = os.environ.get("STAGE", "").strip()
        if stage not in STAGES:
            raise SystemExit(
                f"STAGE must be one of {', '.join(STAGES)} — got {stage!r}"
            )

        url = os.environ.get("DATABASE_URL", "").strip()
        if not url:
            raise SystemExit("DATABASE_URL is required")
        if "-pooler." in url:
            # Not fatal, but it will bite under load in a way that looks like a
            # queue bug rather than a connection-mode bug.
            print(
                "[warn] DATABASE_URL points at Neon's pooled host. Workers hold "
                "interactive transactions and want the direct host.",
                flush=True,
            )

        return cls(
            stage=stage,
            database_url=url,
            lease_seconds=_int("LEASE_SECONDS", 600),
            poll_min_seconds=float(os.environ.get("POLL_MIN_SECONDS", "1")),
            poll_max_seconds=float(os.environ.get("POLL_MAX_SECONDS", "30")),
            llm_provider=_provider(),
            gemini_api_key=os.environ.get("GEMINI_API_KEY")
            or os.environ.get("GOOGLE_API_KEY"),
            gemini_model=os.environ.get("GEMINI_MODEL", "gemini-2.5-flash"),
            gemini_thinking_budget=_int("GEMINI_THINKING_BUDGET", 0),
            contextual_preambles=_flag("CONTEXTUAL_PREAMBLES", True),
            rules_by_model=_flag("RULES_BY_MODEL", True),
            verdict_procedure=_flag("VERDICT_PROCEDURE", False),
            stack_unlisted=_flag("STACK_UNLISTED", False),
            rules_readings=max(1, min(2, _int("RULES_READINGS", 2))),
            judge_readings=max(1, min(5, _int("JUDGE_READINGS", 3))),
            assess_concurrency=max(1, min(32, _int("ASSESS_CONCURRENCY", 8))),
            prefer_whole_document=_flag("PREFER_WHOLE_DOCUMENT", True),
            whole_document_max_tokens=max(1_000, _int("WHOLE_DOCUMENT_MAX_TOKENS", 250_000)),
            coverage_reads=max(1, min(5, _int("COVERAGE_READS", 3))),
            improvement_suggestions=_flag("IMPROVEMENT_SUGGESTIONS", True),
            advice_cache_days=max(0, _int("ADVICE_CACHE_DAYS", 90)),
            lifecycle_check=_flag("LIFECYCLE_CHECK", True),
            lifecycle_soon_days=max(0, _int("LIFECYCLE_SOON_DAYS", 365)),
            lifecycle_base_url=os.environ.get("LIFECYCLE_BASE_URL", "https://endoflife.date/api"),
            slide_diagrams=_flag("SLIDE_DIAGRAMS", True),
            openrouter_api_key=os.environ.get("OPENROUTER_API_KEY") or None,
            openrouter_model=os.environ.get("OPENROUTER_MODEL", "openai/gpt-4.1-mini"),
            openrouter_fast_model=os.environ.get("OPENROUTER_FAST_MODEL", "openai/gpt-4.1-nano"),
            openrouter_providers=tuple(
                name.strip().lower()
                for name in os.environ.get("OPENROUTER_PROVIDERS", "openai,azure").split(",")
                if name.strip()
            ),
            openrouter_zdr=os.environ.get("OPENROUTER_ZDR", "off").lower()
            in ("1", "on", "true", "yes"),
            anthropic_api_key=os.environ.get("ANTHROPIC_API_KEY"),
            claude_model=os.environ.get("CLAUDE_MODEL", "claude-sonnet-4-5"),
            claude_fast_model=os.environ.get(
                "CLAUDE_FAST_MODEL", "claude-haiku-4-5-20251001"
            ),
            embedding_provider=os.environ.get("EMBEDDING_PROVIDER", "gemini"),
            embedding_model=os.environ.get("EMBEDDING_MODEL", "gemini-embedding-001"),
            embedding_dims=_int("EMBEDDING_DIMS", 1024),
            voyage_api_key=os.environ.get("VOYAGE_API_KEY"),
            openai_api_key=os.environ.get("OPENAI_API_KEY"),
            storage_backend=os.environ.get("STORAGE_BACKEND", "local"),
            storage_local_path=os.environ.get("STORAGE_LOCAL_PATH", "./.storage"),
            app_base_url=os.environ.get("APP_BASE_URL"),
            worker_shared_secret=os.environ.get("WORKER_SHARED_SECRET"),
        )


CONFIG = Config.from_env() if os.environ.get("STAGE") else None


def get_config() -> Config:
    """Lazy accessor, so importing a module doesn't require a configured env."""
    global CONFIG
    if CONFIG is None:
        CONFIG = Config.from_env()
    return CONFIG
