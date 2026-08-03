# AIDP workers

Python workers for the ingestion pipeline. One image, four possible roles —
`STAGE` picks the loop at startup.

```
upload → parse → chunk → embed → (assessed documents only) → analyse
```

A `reference` document — a customer's standards — stops after embed. A document
uploaded as `assessed` continues into analyse, which fires every clause in the
framework at it and records a verdict per clause.

## Layout

```
aidp/
  __main__.py     the loop: claim → run → commit → repeat
  config.py       environment, read once at startup
  queue.py        Postgres queue — claim, lease, heartbeat, reap, dead-letter
  db.py           connection pool, id generation, transactions
  storage.py      object storage (local disk, or UploadThing via the app)
  logs.py         structured logs with a correlation id, PII scrubbed
  ai/
    llm.py        figure descriptions, contextual chunk preambles
    embeddings.py provider interface — Gemini, Voyage or OpenAI
  parsing/
    spans.py      lines and font signatures; finds headings by typography
    furniture.py  running headers/footers; lifts the sensitivity classification
    toc.py        table of contents, parsed as ground truth and reconciled
    sections.py   the section tree
    clauses.py    Statement / Rationale / Requirements extraction
    tables.py     header-bound cells; empty cells preserved
    figures.py    embedded rasters and clustered vector drawings
    retrieval.py  hybrid search, scoped to one document
  stages/
    parse.py chunk.py embed.py analyse.py
```

## Running

```bash
cp .env.example .env      # DATABASE_URL + GEMINI_API_KEY
docker compose up --build
```

Scale one stage when documents back up — `SKIP LOCKED` means replicas of the
same stage never collide:

```bash
docker compose up --scale embed=3
```

Or run a single worker directly:

```bash
STAGE=parse python -m aidp
```

## Smoke test

Three, none of which need an API key.

```bash
# Parsing, against a synthetic PDF carrying the traps of the real corpus.
docker run --rm -v "$PWD":/w -w /w --entrypoint python aidp-worker:dev \
  scripts/smoke_parse.py

# The queue, against the real database — claim, lease, chain, backoff, DLQ.
docker run --rm -v "$PWD":/w -w /w -e STAGE=parse -e DATABASE_URL="$DIRECT_URL" \
  --entrypoint python aidp-worker:dev scripts/smoke_queue.py

# The analyse stage with the model stubbed — the clause loop, the guards that
# demote unsupported verdicts, and resumability after a crash.
docker run --rm -v "$PWD":/w -w /w -e STAGE=analyse -e DATABASE_URL="$DIRECT_URL" \
  -e GEMINI_API_KEY=stub --entrypoint python aidp-worker:dev scripts/smoke_analyse.py
```

What none of them prove is judgement *quality* — whether "absent" really means
absent. That needs the real documents and real model calls, and it is what the
eval set is for.

## Two things that will bite

**Use Neon's direct connection string, not the pooled one.** Workers hold
interactive transactions for the length of a stage; PgBouncer's transaction mode
breaks the lease semantics the queue depends on. The host without `-pooler` in
it. (The Next.js app is the opposite case and wants the pooled string.)

**`EMBEDDING_DIMS` must match the `vector(N)` column** in the Prisma migration,
currently 1024. A model with a different width needs a migration. The worker
asserts the match on the first batch rather than failing later with a confusing
insert error.

## Model providers

Two jobs need a model: describing figures whose text layer is empty, and writing
the one-line contextual preamble each chunk carries into its embedding.

**Gemini is the default and covers both halves**, embeddings included, so one
API key does everything. Anthropic remains available via `LLM_PROVIDER=anthropic`
— but note that Claude has no embeddings endpoint at all, so that path needs a
second vendor (Voyage or OpenAI) purely for vectors.

Without a key the pipeline still completes: figures are stored but not
described, and chunks embed without a preamble. Both are recorded as ingest
issues rather than passing silently.
