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
            llm_provider=os.environ.get("LLM_PROVIDER", "gemini"),
            gemini_api_key=os.environ.get("GEMINI_API_KEY")
            or os.environ.get("GOOGLE_API_KEY"),
            gemini_model=os.environ.get("GEMINI_MODEL", "gemini-2.5-flash"),
            gemini_thinking_budget=_int("GEMINI_THINKING_BUDGET", 0),
            contextual_preambles=os.environ.get("CONTEXTUAL_PREAMBLES", "on").lower()
            not in ("0", "off", "false", "no"),
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
