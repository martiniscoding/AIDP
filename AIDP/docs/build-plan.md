# AIDP — build plan

Status: draft for review · 2 August 2026
Companion to [ingestion-plan.md](./ingestion-plan.md), which analyses the client corpus.

---

## The one architectural change

The pipeline we sketched was **parse → chunk → embed → retrieve**. That's a
search product. What the client's documents describe is a *compliance* product,
and it needs a fifth stage:

```
parse → chunk → embed → [ analyse ] → findings
```

**Analyse** is where the product lives. For every clause in the reference
standards, it searches the document under assessment and returns a verdict —
covered, partial, absent, or contradicts — with cited evidence and a confidence
score. Retrieval isn't the destination; it's the analyse worker's inner loop.

This also means documents have a **role**, set at upload:

| Role | Example | Pipeline |
|---|---|---|
| `reference` | Data Standards, Security Standards | parse → chunk → embed → index |
| `assessed` | A vendor's Solution Architecture Document | parse → chunk → embed → **analyse** |

Same first three workers, different terminal stage. That keeps the one-image,
stage-selected worker model intact — analyse is just another `STAGE` value.

---

## North-star milestone

**Upload Meralco's Architecture & Design Guidelines v0.1, assess it against the
three standards templates, produce a gap report.**

Every input already exists — they're the four PDFs the client sent. The correct
output is largely knowable in advance: their Cybersecurity Guidelines section is
empty, their Data Guidelines cover 4 of ~12 areas, they have no
solution-architecture coverage at all. If AIDP finds those gaps and cites them to
page and section, the product works. If it misses them, no amount of UI helps.

Everything below is sequenced to reach that milestone and then harden around it.

---

## Phase 0 — De-risk the parser · 3–5 days

No infrastructure. No database. A throwaway Python harness over the four PDFs.

**Build**
- `harness/` — PyMuPDF over each PDF, emitting per-document JSON: font-signature
  profile, detected headings, detected tables, detected figures, detected page
  furniture.
- ToC cross-check: parse each Table of Contents, diff against detected body
  sections, report misses in both directions.
- The eval set — ~30 golden Q&A pairs in YAML, drawn from the traps in the
  corpus (RPO for Tier 4 is *not specified*; password minimum lives only in a
  nested table; RACI verdicts need 2D recovery; "who approves exceptions"
  differs per document).

**Exit criteria**
- ≥95% of ToC sections detected across all four documents
- Meralco's criticality-tier table extracts with correct column binding
  **including the empty Tier 4 cells** — this is the single hardest case and it
  is the one most likely to produce confidently wrong answers
- The Enterprise Context Diagram comes out as an image file
- Both document profiles (prose-clause, table-principle) detected automatically

**Why first:** every later phase assumes structure detection works on real files.
If PyMuPDF's `find_tables()` can't handle these, that changes the tool choice,
and finding out in week 1 costs days rather than weeks.

---

## Phase 1 — Foundations · ~1 week

**Storage.** Object store for source PDFs and extracted images. Recommend
S3-compatible (R2 or S3) rather than Vercel Blob, since the Python workers need
first-class access and won't run on Vercel. *Decision needed.*

**Schema.** Extend the existing Prisma schema:

```
organisation         a customer of the consultancy — THE TENANT BOUNDARY
membership           user × organisation × role; consultants span many
project              organisation's engagement or system under design
framework            versioned set of reference documents, scoped to an
                     organisation; `is_baseline` marks the shared house standard
document             organisation_id, role(reference|assessed), title, doc_code,
                     version, effective_date, sensitivity, sha256, profile, status
document_section     ordinal, number_text, title, heading_path, pages, is_empty
clause               statement, rationale, requirements[], guidance[]
table_block          caption, columns[], rows(jsonb), pages
figure               page, bbox, image_uri, caption, vlm_description
chunk                source_kind(clause|table_row|figure|prose), heading_path,
                     text, token_count, sensitivity
embedding            vector, model, dims
assessment_run       assessed_document × framework_version, state
finding              run × reference_clause → verdict, evidence[], confidence,
                     reviewer_state
job                  the queue (below)
ingest_issue         empty sections, ToC mismatches, low-confidence tables
```

`assessment_run` gains `project_id` and pins the `framework_version` it ran
against, so a finding stays interpretable after the customer revises a standard.

`sha256` on document gives content-addressed idempotency — re-uploading the same
file must not re-embed it. Scope it per organisation: two customers may legitimately
hold the same baseline document, and neither should see the other's copy.

**Tenancy is enforced at the query.** Every retrieval carries an
`organisation_id` predicate and no code path may build one without it. Prefer a
single choke-point helper over discipline — this is the failure that ends the
product, and their own Data Standards §8.2 is the rule we'd be breaking.

**Queue.** One table, `SELECT … FOR UPDATE SKIP LOCKED`, lease + reaper, adaptive
backoff:

```sql
job(id, document_id, stage, state, attempts, max_attempts,
    run_after, lease_until, correlation_id, payload, last_error)
```

This satisfies their Integration principle 12 and Data Standards §9.3 as written
— retry count, backoff, timeout, dead-letter state, idempotency, correlation ID.
Worth noting in the ADR; it's free compliance evidence.

**Worker skeleton.** One Python image, `STAGE` env var selects the loop. Claim →
process → commit → release, with the reaper reclaiming expired leases. Deploy one
container per stage. *Decision needed: where these run — Fly / Railway / Render /
a managed container service.*

**Upload path.** Next.js route: file → object store → `document` row → enqueue
parse job, all in one transaction.

**Exit:** a file uploaded through the UI lands in storage, creates a row, and a
no-op worker picks the job up and marks it done.

---

## Phase 2 — Parse worker · ~2 weeks

The largest phase, because it's three problems wearing one coat.

**Text and structure.** Font-signature profiling to build the heading tree.
Strip page furniture (headers, footers, ToC) — but capture the sensitivity
classification off the footer first, it's a governance field. Detect the document
profile and route to the prose-clause or table-principle extractor. Emit sections
and clauses.

**Tables.** Extract as structured objects with column headers bound to cells.
Rejoin tables split across page breaks. Handle tables nested inside a clause
(Security §3.2). Store both the structured form, for rendering citations, and a
row-serialised text form for embedding:

> *Tier 4 — Criticality: Function Specific. RPO: not specified. RTO: not
> specified. Business alignment: Stand-alone or limited-use systems…*

**Figures.** Extract embedded images, and render regions to raster for
vector-drawn figures that `get_images()` misses. Vision-model pass produces a
dense description stored as the figure's searchable text, image retained for
citation.

**Issues.** Empty sections, ToC mismatches, and low-confidence table extractions
write to `ingest_issue` rather than vanishing. A document that parses to zero
content in a section must say so — silent gaps are how a compliance tool ends up
lying.

**Exit:** all four PDFs parse, the eval set's structure-dependent questions are
answerable from stored records, Meralco's context diagram has a usable
description.

---

## Phase 3 — Chunk worker · ~1 week

Clause-atomic. One chunk = Statement + Rationale + Requirements, prefixed with
its heading path. Tables emit one chunk per row plus one for the whole table.
Figures emit their description as a chunk.

Contextual retrieval: a short generated preamble situating each chunk in its
document, using prompt caching against the full document text (~0.1× on cached
reads) and the Batch API where latency allows (50% off).

**Exit:** ~120 chunks from the current corpus, every one carrying heading path,
source kind, page range, and sensitivity.

---

## Phase 4 — Embed worker and index · 3–4 days

Short phase, one blocking decision in front of it.

**Embedding model and dimensionality.** `text-embedding-3-large` is 3072 dims;
pgvector's HNSW caps near 2000, ~4000 with `halfvec`. Options: reduce dimensions
at the API, use `halfvec`, or pick a smaller model. Needs a decision and an ADR
before this phase starts.

Hybrid retrieval from the outset — pgvector plus Postgres full-text. Absence
detection in Phase 5 depends on recall, and pure vector search will not carry it
alone.

**Exit:** the corpus is searchable; the eval set's retrieval questions pass.

---

## Phase 5 — Analyse worker · ~2 weeks

The product.

For each clause in the reference framework, against the assessed document:

1. Build a query from the clause — statement plus its requirements bullets, since
   the bullets carry the vocabulary the other document will actually use.
2. Hybrid retrieve, high recall, over that document's chunks only.
3. LLM judges: **verdict** (covered / partial / absent / contradicts),
   **evidence** (cited chunk ids and spans), **confidence**.
4. Write a `finding`.

**Absence is the hard case**, and it deserves explicit design. Proving a negative
requires confidence that retrieval didn't simply miss. Rule: never assert
`absent` on weak retrieval — emit `needs_review` instead. A false "compliant" and
a false "absent" are both expensive, and in a governance tool the second gets
noticed during an audit.

**Human-in-the-loop from day one.** Architects confirm or override every finding.
Overrides are the evaluation data, and they're also what makes the tool
trustworthy enough to be used at all.

Prompt-cache the reference clause set across the run — it's constant across every
clause in an assessment.

**Exit: the north-star milestone.** Meralco's v0.1 assessed against the three
standards, gap report generated, findings cited to page and section, and the
three known gaps surfaced correctly.

---

## Phase 6 — The workbench · ~2 weeks

Now the UI matters, and it builds on what already exists — the design system,
auth, and dashboard shell are done.

- **Document library** — upload, role, version, parse status, ingest issues
- **Assessment run** — progress, then the coverage map: framework sections down,
  verdicts across, drill into any cell
- **Finding detail** — the reference clause beside the retrieved evidence, source
  page rendered, with the table or figure in its real form; confirm / override /
  comment
- **Gap register** — filterable, severity-ranked, exportable
- **Q&A** — free-form questions across the corpus, with citations. Worth noting
  this is a *by-product* of the retrieval layer, not the product

Citations are non-negotiable throughout. Their standards demand traceability and
an ARB won't accept an uncited assertion.

---

## Phase 7 — Our own compliance pack · ~1 week

AIDP is assessed against the documents AIDP ingests. All four say their scope is
*"binding for internal teams, contractors, and external vendors."*

Needed to clear their gates: a Solution Architecture Document (SolArch §10.1),
ADRs for the significant decisions (§2.2, template in their Appendix A), a threat
model (§3.7, since we handle Confidential data), data classification and
retention decisions (Data Standards §8, §10.2), verifiable deletion cascade
(§10.4), key management (Security §7.2), and a vendor security risk assessment
(Security §11.1).

The ADRs are already owed on four decisions made: Postgres queue over RabbitMQ;
one image with stage-selected workers; clause-atomic chunking; embedding model
and dimensionality.

**Build this pack using AIDP.** Feed it our own SAD. If the tool can assess its
own delivery against their standards, that's the demo — and it's the most honest
possible test.

---

## Rough sizing

| Phase | Estimate |
|---|---|
| 0 — Parser de-risk | 3–5 days |
| 1 — Foundations | 1 week |
| 2 — Parse worker | 2 weeks |
| 3 — Chunk worker | 1 week |
| 4 — Embed + index | 3–4 days |
| 5 — Analyse worker | 2 weeks |
| 6 — Workbench | 2 weeks |
| 7 — Compliance pack | 1 week |

≈ **10–11 weeks** for one developer to a defensible first version. Phases 2 and 5
carry nearly all the risk; 0 exists to move Phase 2's risk forward by two months.

---

## Decisions blocking work

| Decision | Blocks | Recommendation |
|---|---|---|
| Object storage | Phase 1 | S3-compatible (R2/S3) — workers need direct access |
| Worker hosting | Phase 1 | Container host; their §8.3 points at k8s eventually |
| ~~Tenancy grain~~ | — | **Resolved:** organisation = customer of the consultancy; hard wall |
| Technology Stack form — per organisation or per project? | Phase 1 schema | Currently one-per-user-account, wrong either way; needs migration |
| Embedding model and dims | Phase 4 | Needs an ADR |
| LLM provider for analysis and figure captioning | Phase 2, 5 | — |

---

## Explicitly not building yet

Multiple frameworks beyond the client's own · a vendor-facing submission portal ·
cross-project analytics and benchmarking · automated remediation-plan drafting ·
anything that assumes the standards corpus is stable, since three of the four
documents are unfilled templates and will change under us.

Version documents from day one. That much is certain.
