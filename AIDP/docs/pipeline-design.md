# AIDP — parse / chunk / embed, in detail

Status: design · 2 August 2026
Implements Phases 2–4 of [build-plan.md](./build-plan.md). Grounded in the four
sample PDFs; every technique below is chosen against a real case in that corpus.

Stack: Python workers, PyMuPDF (`fitz`), Postgres + pgvector on Neon.

---

## Stage 1 — Parse

Input: a PDF in object storage. Output: `document_section`, `clause`,
`table_block`, `figure`, `ingest_issue`.

### 1.1 Triage

Open, read metadata, then check for a text layer:

```python
sample = "".join(doc[i].get_text() for i in range(min(5, doc.page_count)))
if len(sample.strip()) < 200:
    raise NeedsOCR   # v1: fail loudly, don't guess
```

All four samples are Word exports with clean text layers. A scanned document is a
different pipeline and should say so rather than silently produce nothing.

### 1.2 Font-signature profiling

This is how headings get found. `get_text("dict")` yields blocks → lines → spans,
each span carrying font, size, flags and bbox:

```python
for span in spans:
    sig = (
        span["font"],
        round(span["size"], 1),
        bool(span["flags"] & 16),   # bold
        bool(span["flags"] & 2),    # italic
        span["color"],
    )
```

Count signature frequency across the whole document. **The most common signature
is body text.** Everything meaningfully larger, bolder, or in a different colour
is a heading candidate; sort those by size descending to get level 1, 2, 3.

This works here because all four documents are Word exports with consistent
styles — section headings are larger and dark blue, subsection headings are bold
black, body is regular black. It is not a heuristic that survives arbitrary PDFs,
which is exactly what Phase 0 exists to verify.

### 1.3 Page furniture

Normalise each line's text (strip digits, collapse whitespace) and group by
`(normalised_text, y_band)`. Anything appearing on **>70% of pages at a
consistent vertical position** is furniture.

In this corpus: a right-aligned header (`Data Standards | Page 7`) and a centred
footer on grey fill (`SENSITIVITY CLASSIFICATION: Internal Use`) — roughly 100
repetitions across the four documents. Left in, that boilerplate lands in every
chunk and degrades embeddings corpus-wide.

**Capture before stripping:**

```python
m = re.search(r"SENSITIVITY CLASSIFICATION:\s*(.+)", footer_text, re.I)
document.sensitivity = m.group(1).strip() if m else None
```

That field drives access control later. It is governance data, not noise.

The fourth document's furniture is a **table**, not text lines, so run the same
repetition test over detected tables as well.

### 1.4 The Table of Contents is ground truth

Find the section titled "Table of Contents", then:

```python
TOC_LINE = re.compile(r"^(.*?)[\s.]{3,}(\d+)\s*$")
```

Each hit gives `(title, page)`, with depth from the leading number or the line's
indent. Store as `expected_sections`.

After the body parse, reconcile:

| Condition | Action |
|---|---|
| ToC entry with no matching body section | `ingest_issue` — **high** |
| Body section absent from ToC | `ingest_issue` — low (probably a misdetected heading) |
| Page differs by more than 1 | `ingest_issue` — medium |

Twenty lines of code, and it converts silent parse failures into reported ones.
Nothing else in the pipeline gives that much assurance that cheaply.

### 1.5 Section tree

Walk lines in reading order (page, then y, then x). A line is a heading when its
font signature is a heading level **and** it matches:

```python
r"^(\d+(?:\.\d+)*)\.?\s+(\S.*)$"        # 3.2 Authentication Standards
r"^(Appendix\s+[A-Z]):\s*(.+)$"          # Appendix B: Glossary of Terms
```

Requiring both font and pattern avoids catching body lines that happen to start
with a number.

**Section numbers are not identifiers.** The fourth document contains two
sections both numbered `9.1.1` — Word auto-numbering drift, already present in
the corpus we have. Identity is `(document_id, ordinal, slug)`; `number_text` is
metadata.

### 1.6 Profile detection

Two shapes, chosen per section rather than per document — the fourth sample has
prose sections *and* table-principle sections:

- **prose-clause** — content contains the literal labels `Statement:`,
  `Rationale:`, `Requirements:`
- **table-principle** — content is dominated by a table whose headers match
  `/principle|statement|implication/i`

Default to prose-clause; fall back to raw prose if neither matches.

### 1.7 Clause extraction

**Prose profile** — split the section's text on the labels:

```
Statement:    … up to Rationale:
Rationale:    … up to Requirements:
Requirements: bullets, up to the next heading or "Applicable Patterns"
Applicable Patterns / Technology Guidance:  bullets   (Solution Architecture only)
```

Bullets come from the `•` glyph, which PyMuPDF emits as its own span, with
list indentation as the fallback signal.

**Table-principle profile** — one clause per table row. Columns map:
`Principle Name` → title, `Statement and Rationale` → split on the in-cell
`Statement:` / `Rationale:` markers, `Implications` → requirements.

### 1.8 Tables

`page.find_tables()`, then for each table:

1. **Bind every cell to its column header.** Position alone is not recoverable
   downstream.
2. **Empty cells become explicit nulls, never skipped.** This is the Tier 4 row
   in the fourth document — six columns, four values, RPO and RTO blank. Drop the
   blanks and every later value shifts one column left, turning "not specified"
   into Tier 3's "4 to 8 hours". Confidently wrong is the worst failure mode a
   compliance tool has.
3. **Rejoin across page breaks.** If a table ends at the page bottom and the next
   page opens with a table whose header row is identical, merge and drop the
   repeated header. Two tables in this corpus need it.
4. **Attach to the right parent.** Usually the enclosing section — but if the
   table falls inside a clause's span it belongs to the clause. Security §3.2
   carries its password-policy table *inside* the standard.
5. Low extraction confidence → `ingest_issue`.

### 1.9 Figures

```python
page.get_images(full=True)      # embedded rasters
page.get_drawings()             # vector primitives → cluster → bbox
page.get_pixmap(clip=bbox, dpi=200)   # render the region
```

Vector-drawn diagrams don't appear in `get_images()`, so cluster drawing
primitives by proximity and render the bounding region instead.

The fourth document's Enterprise Context Diagram is the case that matters: a
single figure holding the customer's entire application landscape, with an empty
text layer. Each figure gets a vision-model pass producing a dense description,
stored as its searchable text; the image is kept for citation.

### 1.10 Emit

Write everything in one transaction with the job state update, so a crash cannot
half-commit. A section with no clause, no table, no figure and under ~200
characters is **empty** → `ingest_issue`.

That rule is what catches the fourth document's §3 Cybersecurity Guidelines,
which reads in full: *"This template ensures:"*. A compliance tool that silently
drops an empty section will later answer a cybersecurity question from a
different document and sound certain.

---

## Stage 2 — Chunk

The document already told us where the boundaries are. We are not re-deriving
them.

**Not doing:** fixed-size windows, recursive character splitting, or
embedding-breakpoint "semantic" chunking.

### 2.1 One clause, one chunk — never split

Statement, Rationale, Requirements and Guidance stay together, prefixed with the
heading path:

```
Security Standards › 3. Identity and Access Management › 3.2 Authentication Standards

Statement: All access to systems must be authenticated using mechanisms
appropriate to the sensitivity of the system, with MFA required for privileged
and remote access.
Rationale: Passwords alone are increasingly insufficient against credential-based
attacks…
Requirements:
• MFA must be enforced for all remote access, administrative access, and access
  to Confidential/Restricted systems
• Passwords must meet minimum complexity, length, and rotation requirements…
```

Clauses in this corpus run 150–350 tokens. Nothing is near a limit, so there is
no reason to split and every reason not to: a Requirements bullet severed from
its Statement is unusable, and in the analyse stage it is a useless probe.

### 2.2 Tables — one chunk per row, plus one for the whole table

Row chunks carry their headers inline:

```
Architecture and Design Guidelines › 9.1.1 Criticality Tiers Summary
Tier 4 — Criticality: Function Specific. General standard process: Departmental
tools, dev/test environments. RPO: not specified. RTO: not specified.
```

**`not specified` is written literally.** That is what makes the absence
retrievable, and what stops a model inventing a number.

### 2.3 Figures — the description is the chunk

Vision-model description plus caption plus heading path, linked to the stored
image so a citation can render the real diagram.

### 2.4 Contextual preamble

One or two generated sentences situating each chunk in its document, prepended
before embedding. The full document text goes in the cached prefix, so with
prompt caching the document tokens cost ~0.1× per chunk, and the Batch API halves
it again where latency allows.

### 2.5 Parent–child

Each section also emits a chunk from its own intro prose. Child chunks link to
it, so retrieval can widen from a clause to its section when a query is broader
than any single clause.

---

## Stage 3 — Embed

### 3.1 Batching and idempotency

Batch ~100 chunks per request. Each chunk carries a content hash; on re-parse,
unchanged chunks are not re-embedded. Combined with `sha256` on the document,
re-uploading the same file costs nothing.

Store `model` and `dims` alongside every vector so a re-embed can run
side-by-side during a model migration rather than as a big-bang swap.

### 3.2 Model and dimensions — open

`text-embedding-3-large` is 3072 dims; pgvector's HNSW caps near 2000, ~4000 with
`halfvec`. Reduce dimensions at the API, use `halfvec`, or pick a smaller model.
**Needs a decision and an ADR before this stage is built.**

### 3.3 Hybrid from day one

A `tsvector` column with a GIN index beside the vector index. The analyse stage
has to distinguish *"this requirement is genuinely unaddressed"* from *"retrieval
missed it"*, and that rests on recall. Vector search alone will not carry it —
exact terms like "TLS 1.2", "RPO", "snake_case" are precisely what lexical search
is good at and dense retrieval is soft on.

### 3.4 Tenant filtering — the wrinkle worth knowing now

Every query must carry an `organisation_id` predicate. But **HNSW does not
pre-filter**: it searches the graph and then discards non-matching rows, so a
tight filter can return fewer than `k` results, or drift into a slow exhaustive
scan.

Three options, in order of preference:

1. **Partition by organisation** — clean, and the tenant wall becomes physical
2. **pgvector 0.8+ iterative scan** — keeps scanning until `k` survivors are found
3. Raise `ef_search` and over-fetch — simplest, least predictable

Route every retrieval through one helper that takes `organisation_id` as a
required argument. No code path should be able to build a query without it.

---

## The queue

```
upload → parse → chunk → embed → (role=assessed) → analyse
```

### Why a plain table, not PGMQ

PGMQ is good software, but a hand-rolled table wins here for three reasons:

1. **The UI constantly joins jobs to documents** — "show every document and its
   pipeline status" is the library screen. That's a join against a table; against
   PGMQ it's JSON extraction across queue tables.
2. **Compliance wants first-class columns.** `correlation_id`, `attempts`,
   `last_error`, `dead_letter` are named requirements in Data Standards §9.3 and
   the customer's Integration principle 12. Columns, not payload keys.
3. **Extension availability on Neon needs verifying** and I'd rather not have the
   queue depend on the answer.

It's about 150 lines. `SKIP LOCKED` does the hard part.

### Schema

```sql
create type job_state as enum ('queued','leased','done','failed','dead');

create table job (
  id              bigserial primary key,
  organisation_id uuid        not null,
  document_id     uuid        not null,
  stage           text        not null,     -- parse|chunk|embed|analyse
  state           job_state   not null default 'queued',
  attempts        int         not null default 0,
  max_attempts    int         not null default 5,
  run_after       timestamptz not null default now(),
  lease_until     timestamptz,
  lease_owner     text,
  correlation_id  uuid        not null,
  payload         jsonb       not null default '{}',
  last_error      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index on job (stage, run_after) where state = 'queued';
create index on job (lease_until)      where state = 'leased';

-- Idempotency at the queue: one live job per document per stage.
create unique index on job (document_id, stage)
  where state in ('queued','leased');
```

### Claiming — one atomic statement

```sql
update job
   set state       = 'leased',
       lease_until = now() + interval '10 minutes',
       lease_owner = $2,
       attempts    = attempts + 1,
       updated_at  = now()
 where id = (
   select id from job
    where stage = $1 and state = 'queued' and run_after <= now()
    order by created_at
      for update skip locked
    limit 1
 )
returning *;
```

`SKIP LOCKED` lets N workers on the same stage claim concurrently without
blocking each other or handing the same job out twice.

### Leases, heartbeats, and the reaper

A worker that dies mid-job holds nothing — its lease simply expires. The reaper
runs every minute:

```sql
update job
   set state       = case when attempts >= max_attempts then 'dead' else 'queued' end,
       run_after   = now() + (interval '1 second' * pow(2, attempts)),
       lease_until = null,
       lease_owner = null
 where state = 'leased' and lease_until < now();
```

Exponential backoff on retry; `dead` is the dead-letter state — nothing is ever
silently dropped.

Parsing a long PDF with vision calls can outrun a ten-minute lease, so
long-running handlers heartbeat:

```sql
update job set lease_until = now() + interval '10 minutes'
 where id = $1 and lease_owner = $2;
```

### The property that makes it crash-safe

On success, the stage's **outputs, its own completion, and the next stage's job
all commit in one transaction**:

```sql
begin;
  insert into document_section ... ;   -- this stage's work
  update job set state = 'done' where id = $1;
  insert into job (organisation_id, document_id, stage, correlation_id)
       values ($2, $3, 'chunk', $4);   -- hand off
commit;
```

There is no window where work is written but the handoff is lost, or a job is
marked done but its output isn't there. A crash anywhere rolls back to a clean
retry.

### Workers

One image, `STAGE` selects the loop:

```python
STAGE    = os.environ["STAGE"]
HANDLERS = {"parse": parse_document, "chunk": chunk_document,
            "embed": embed_document, "analyse": analyse_document}

while not shutting_down:
    job = claim(STAGE, worker_id)
    if job is None:
        sleep(backoff.next())      # 1s busy → 30s idle
        continue
    backoff.reset()
    try:
        HANDLERS[STAGE](job)
    except Exception as e:
        fail(job, e)               # reaper handles retry/backoff
```

Deploy one container per stage and scale them independently — embed workers are
I/O-bound on API calls and want concurrency; parse workers want memory.

### Neon specifics

- **`LISTEN/NOTIFY` will not work** through the pooled connection string.
  pgbouncer's transaction mode breaks it. Poll instead, or connect directly.
- **Adaptive backoff** keeps idle polling near-free: three stages at one query
  per 30s is a handful of indexed lookups returning zero rows.
- **Autosuspend is the real cost**, not query volume. A polling worker keeps the
  compute awake, so it never scales to zero. Assessments are bursty and
  user-initiated, so the cleaner option is for the app to **ping the workers on
  enqueue** and let them idle long between polls.
- Use the **direct** connection string in workers where interactive transactions
  matter; the pooled one for the Next.js app.

This satisfies Data Standards §9.3 and the customer's Integration principle 12 as
written — retries with backoff, dead-letter path, idempotent processing,
correlation ID per transaction. Worth citing in the ADR: it's compliance evidence
we get for free.
