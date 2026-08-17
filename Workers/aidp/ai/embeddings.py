"""Embeddings, behind a provider interface.

Gemini is the default and covers both halves of the AI work — unlike Anthropic,
which has no embeddings endpoint at all, so running Claude for the figure
descriptions forces a second vendor purely for vectors. On Gemini one API key
does both.

Voyage and OpenAI remain available through `EMBEDDING_PROVIDER`. Everything is
reached over plain HTTP rather than through a vendor SDK, so adding another is
one small class.

Two invariants worth knowing:

  - `dims` must equal the `vector(N)` width in the migration. Changing the model
    to one with a different width needs a migration, so the mismatch is caught
    at startup rather than as a confusing insert error later.
  - Document and query embeddings are asymmetric on providers that support it.
    `input_type` is threaded through rather than defaulted, because getting it
    backwards degrades retrieval quietly.
"""

from __future__ import annotations

import time
from typing import Literal, Protocol

import httpx

from .. import cache, logs, usage
from ..config import get_config

log = logs.get(__name__)

InputType = Literal["document", "query"]

# Providers reject oversized batches, and a failure costs the whole batch.
# Gemini's batchEmbedContents caps at 100 requests; 96 leaves headroom.
BATCH_SIZE = 96
TIMEOUT = httpx.Timeout(120.0, connect=15.0)


class EmbeddingProvider(Protocol):
    model: str
    dims: int

    def embed(self, texts: list[str], input_type: InputType) -> list[list[float]]: ...


def _post_with_retry(url: str, headers: dict, payload: dict, attempts: int = 5) -> dict:
    """POST with exponential backoff on rate limits and transient failures."""
    delay = 1.0
    last: Exception | None = None
    for attempt in range(attempts):
        try:
            with httpx.Client(timeout=TIMEOUT) as client:
                res = client.post(url, headers=headers, json=payload)
            if res.status_code == 429 or res.status_code >= 500:
                raise httpx.HTTPStatusError(
                    f"{res.status_code}: {res.text[:200]}", request=res.request, response=res
                )
            res.raise_for_status()
            return res.json()
        except Exception as exc:  # noqa: BLE001 — retried below, re-raised at the end
            last = exc
            if attempt == attempts - 1:
                break
            logs.warn(log, "embedding request failed, retrying", attempt=attempt + 1, delay=delay)
            time.sleep(delay)
            delay = min(delay * 2, 30)
    raise RuntimeError(f"embedding request failed after {attempts} attempts: {last}")


class GeminiProvider:
    """Google's embedding endpoint.

    `outputDimensionality` uses Matryoshka truncation, so asking for 1024 to
    match the column costs far less quality than moving to a smaller model
    would. Google only L2-normalises the full-width output; at other widths the
    vectors are unnormalised, which is harmless here because pgvector is
    configured for cosine distance and cosine ignores magnitude.

    `taskType` is what makes a question and a passage embed differently. Getting
    it backwards degrades retrieval quietly rather than loudly, which is why it
    is threaded through from the caller rather than defaulted.
    """

    BASE = "https://generativelanguage.googleapis.com/v1beta/models"
    TASK = {"document": "RETRIEVAL_DOCUMENT", "query": "RETRIEVAL_QUERY"}

    def __init__(self, api_key: str, model: str, dims: int) -> None:
        self.api_key = api_key
        self.model = model
        self.dims = dims

    def embed(self, texts: list[str], input_type: InputType) -> list[list[float]]:
        data = _post_with_retry(
            f"{self.BASE}/{self.model}:batchEmbedContents",
            {"x-goog-api-key": self.api_key, "content-type": "application/json"},
            {
                "requests": [
                    {
                        "model": f"models/{self.model}",
                        "content": {"parts": [{"text": text}]},
                        "taskType": self.TASK[input_type],
                        "outputDimensionality": self.dims,
                    }
                    for text in texts
                ]
            },
        )
        # Order is guaranteed to match the request order, and there is no index
        # field to sort on, so a length mismatch is the only detectable fault.
        embeddings = data.get("embeddings", [])
        if len(embeddings) != len(texts):
            raise RuntimeError(
                f"gemini returned {len(embeddings)} embeddings for {len(texts)} inputs"
            )
        return [e["values"] for e in embeddings]


class VoyageProvider:
    """Anthropic's recommended embedding partner."""

    def __init__(self, api_key: str, model: str, dims: int) -> None:
        self.api_key = api_key
        self.model = model
        self.dims = dims

    def embed(self, texts: list[str], input_type: InputType) -> list[list[float]]:
        data = _post_with_retry(
            "https://api.voyageai.com/v1/embeddings",
            {"Authorization": f"Bearer {self.api_key}", "content-type": "application/json"},
            {"model": self.model, "input": texts, "input_type": input_type},
        )
        ordered = sorted(data["data"], key=lambda d: d["index"])
        return [d["embedding"] for d in ordered]


class OpenAIProvider:
    """Alternative. `dimensions` is honoured by text-embedding-3-*, which are
    Matryoshka-trained — truncating 3072 to 1024 costs far less quality than
    moving to a smaller model would."""

    def __init__(self, api_key: str, model: str, dims: int) -> None:
        self.api_key = api_key
        self.model = model
        self.dims = dims

    def embed(self, texts: list[str], input_type: InputType) -> list[list[float]]:
        payload: dict = {"model": self.model, "input": texts}
        if self.model.startswith("text-embedding-3"):
            payload["dimensions"] = self.dims
        data = _post_with_retry(
            "https://api.openai.com/v1/embeddings",
            {"Authorization": f"Bearer {self.api_key}", "content-type": "application/json"},
            payload,
        )
        ordered = sorted(data["data"], key=lambda d: d["index"])
        return [d["embedding"] for d in ordered]


def provider() -> EmbeddingProvider:
    cfg = get_config()
    name = cfg.embedding_provider.lower()
    if name == "gemini":
        if not cfg.gemini_api_key:
            raise SystemExit("GEMINI_API_KEY is required when EMBEDDING_PROVIDER=gemini")
        return GeminiProvider(cfg.gemini_api_key, cfg.embedding_model, cfg.embedding_dims)
    if name == "voyage":
        if not cfg.voyage_api_key:
            raise SystemExit("VOYAGE_API_KEY is required when EMBEDDING_PROVIDER=voyage")
        return VoyageProvider(cfg.voyage_api_key, cfg.embedding_model, cfg.embedding_dims)
    if name == "openai":
        if not cfg.openai_api_key:
            raise SystemExit("OPENAI_API_KEY is required when EMBEDDING_PROVIDER=openai")
        return OpenAIProvider(cfg.openai_api_key, cfg.embedding_model, cfg.embedding_dims)
    raise SystemExit(f"unknown EMBEDDING_PROVIDER {cfg.embedding_provider!r}")


def embed_all(texts: list[str], input_type: InputType = "document") -> list[list[float]]:
    """Embed in batches, preserving input order.

    Anything already in the cache is served from there and never reaches the
    provider. `embed(text)` is a pure function, so a stored vector is not a
    stale answer — it is the identical answer, and paying for it twice buys
    nothing. See aidp/cache.py for how the key is built.

    Two kinds of waste this removes. A revised standard re-uploaded after a
    small edit re-embeds every chunk, when almost all of them are unchanged.
    And every assessment run embeds the same hundred-odd clause queries again,
    because the framework did not move between runs.

    The width of the first vector is checked against the configured dimension:
    a mismatch means the column and the model have diverged, and every insert
    after this point would fail with a less obvious message.
    """
    if not texts:
        return []

    cfg = get_config()
    prov = provider()

    organisation_id = cache.organisation()
    keys = [cache.embedding_key(text, prov.model, input_type, prov.dims) for text in texts]
    stored = cache.get_embeddings(organisation_id, keys) if organisation_id else {}

    # What is left to buy, each distinct text once. A document that repeats a
    # line, or a batch holding the same clause twice, should pay once — the
    # provider has no idea they are the same request.
    pending_keys: list[str] = []
    pending_texts: list[str] = []
    queued: set[str] = set()
    for text, key in zip(texts, keys):
        if key in stored or key in queued:
            continue
        queued.add(key)
        pending_keys.append(key)
        pending_texts.append(text)

    fresh: dict[str, list[float]] = {}
    for start in range(0, len(pending_texts), BATCH_SIZE):
        batch = pending_texts[start : start + BATCH_SIZE]
        batch_keys = pending_keys[start : start + BATCH_SIZE]
        vectors = prov.embed(batch, input_type)
        if vectors and len(vectors[0]) != prov.dims:
            raise RuntimeError(
                f"{prov.model} returned {len(vectors[0])}-dim vectors but the column is "
                f"vector({prov.dims}). Set EMBEDDING_DIMS to match, or migrate the column."
            )
        fresh.update(zip(batch_keys, vectors))

        # Recorded only for what was actually sent, so a cached run costs
        # nothing on the People page — which is true, and is the number an
        # administrator is looking at.
        #
        # None of these three endpoints reports token counts, so the figure is
        # derived from input size and flagged as an estimate. Per batch rather
        # than per text: one row for ninety-six strings is the same number in
        # the total and a ninety-sixth of the writes.
        usage.record(
            kind="embedding",
            provider=cfg.embedding_provider.lower(),
            model=prov.model,
            input_tokens=sum(usage.estimate_tokens(text) for text in batch),
            estimated=True,
        )

        if organisation_id:
            cache.put_embeddings(
                organisation_id,
                [
                    (key, prov.model, vector, usage.estimate_tokens(text))
                    for key, vector, text in zip(batch_keys, vectors, batch)
                ],
            )

        logs.info(
            log, "embedded batch", count=len(batch), done=len(fresh), total=len(pending_texts)
        )

    if stored:
        logs.info(
            log,
            "embeddings served from cache",
            hits=len(texts) - len(pending_texts),
            calls=len(pending_texts),
            total=len(texts),
        )

    # Back into the caller's order, cached and fresh alike, with repeats
    # resolving to the same vector.
    return [stored[key] if key in stored else fresh[key] for key in keys]


def to_pgvector(vector: list[float]) -> str:
    """pgvector's text input format. psycopg sends it as a string and Postgres
    casts on the way in — no extra adapter needed for the volumes here."""
    return "[" + ",".join(f"{v:.7g}" for v in vector) + "]"
