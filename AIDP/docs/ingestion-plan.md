# AIDP ingestion — what the four standards documents change

Status: draft for review · 2 August 2026

Four documents landed as the first real corpus for the ingestion pipeline. This
is a read of what they actually contain, what breaks if we build the pipeline we
sketched, and what to do next in order.

The headline: **the template hypothesis holds, but not for the reason we
assumed.** Structure-aware parsing is viable. What will actually cost us time is
tables, figures, and near-duplicate text across documents — none of which were
in the plan.

---

## 1. What we received

Two different kinds of document, which is the most useful thing about the set.

All four came from the client. See [product.md](./product.md) for who they are
and what the product is.

| Document | Pages | Shape | State |
|---|---|---|---|
| Data Standards | 23 | Prose clauses + tables | Unfilled template (`DOC-DATA-STD V-1.0`, effective date `[DD/MM/YYYY]`) |
| Security Standards | 26 | Prose clauses + tables | Unfilled template (`DOC-SEC-STD V-1.0`) |
| Solution Architecture Standards | 27 | Prose clauses + patterns + tables | Unfilled template (`DOC-SOL-ARCH-STD V-1.0`) |
| Architecture and Design Guidelines | 24 | **Table-major principles** | Live internal draft (`DDD-XXX-YYY V-0.1`, named author, real context diagram) |

The first three are unfilled templates — placeholder dates, `[Name]` in the
revision history. They are the client's **target** standards library. The fourth
is their **current** one: a v0.1 initial draft, visibly unfinished.

That contrast is the whole value of this set. Documents 1–3 are the shape the
corpus is heading toward. Document 4 is what actually exists today, and it does
not have the same shape. The parser has to handle both.

---

## 2. The template is real and machine-readable

Documents 1–3 share an exact skeleton:

```
Cover        doc title / subtitle / DOC-ID V-n.n / effective date / sensitivity
Revision History      version | date | changed by | description
Table of Contents     dotted leaders, page numbers
1. Introduction       1.1 Purpose · 1.2 Objectives · 1.3 Scope · 1.4 Definitions
2..N Domain sections  N.N clause → Statement / Rationale / Requirements
N. Roles and Responsibilities    RACI matrix
N. Compliance, Exceptions, and Review
Appendix A            domain-specific reference table
Appendix B            Glossary of Terms
```

Every substantive clause is the same three-part unit:

> **Statement:** …one sentence, the rule
> **Rationale:** …one or two sentences, the why
> **Requirements:** …3–4 bullets, the testable obligations

Solution Architecture adds a fourth part, *Applicable Patterns / Technology
Guidance*, italicised rather than bold.

**This is the chunk boundary.** We debated structure-aware vs. embedding
breakpoint chunking in the abstract. The abstract question is now closed: the
document format hands us a clause-atomic unit with a heading path, and splitting
anywhere else destroys meaning. A Requirements bullet without its Statement is
unusable — "Access must be requested, approved, and periodically re-certified"
is meaningless without knowing it's under *least privilege*.

Concretely, one chunk =

```
heading path : Security Standards › 3. Identity and Access Management › 3.2 Authentication Standards
statement    : All access to systems must be authenticated using mechanisms…
rationale    : Passwords alone are increasingly insufficient…
requirements : [4 bullets]
```

Roughly 30 such clauses per document. That's ~120 primary chunks across this
corpus — small. Which means retrieval quality, not scale, is the problem to
solve.

### The Table of Contents is free ground truth

Each ToC lists every section and its page number. Parse it first, then parse the
body, then **assert the two agree**. Any section in the ToC that the body parser
missed is a detected failure rather than a silent one. This is the cheapest
quality gate available and it costs about twenty lines.

It also catches the numbering bugs already present in the corpus — the client
document has two sections both numbered `9.1.1` (Word auto-numbering drift), and
the templates mix `5.1.` and `5.2` inconsistently. **Section numbers are not
usable as identifiers.** Use `document_id + ordinal + slug`.

---

## 3. The real client document breaks the template

Document 4 is the warning shot. It is the same *genre* and almost none of the
same *structure*:

- **Principles live in a 4-column table**, not in prose: `# | Principle Name |
  Statement and Rationale | Implications`. Statement and Rationale are crammed
  into one cell. "Requirements" is called "Implications".
- **Page furniture is a table**, not a header line — a 2×3 grid with
  Effectivity Date and `Page: n of 24`.
- **Sections are empty.** §3 Cybersecurity Guidelines reads, in full: *"This
  template ensures:"* — and stops. §8 Telecommunication Guidelines reads *"Clean
  conversion to PDF"*, an author's note left in the shipped document. §1.3
  Definition of Terms is a heading with nothing under it.

Three consequences:

1. The parser needs **two profiles**, prose-clause and table-principle, selected
   per document rather than assumed. Do not hard-code the template.
2. **Empty sections must surface, not vanish.** If §3 silently produces zero
   chunks, nobody notices the client shipped an incomplete document — and then
   the assistant answers "what are the cybersecurity guidelines?" from a
   different document and sounds confident. Emit a zero-content section record
   and flag it on the document's ingest report.
3. Author notes like *"Clean conversion to PDF"* are noise that looks exactly
   like content. Worth a low-confidence flag, not automated deletion.

---

## 4. Tables carry meaning that linear extraction destroys

This is the finding that most changes the build. A large share of the highest-value
facts in this corpus live **only** in tables, and `page.get_text()` flattens them
into unrecoverable word salad.

**Proof, from the RACI matrix in Data Standards §11.** Extracted linearly:

```
Activity  Data Owner  Data Steward  Data Custodian  Governance Council
Define data domain and business rules  A R C I
```

Four letters, four columns, positionally recoverable *if* you know the column
count. Now the criticality tier table from the client document, §9.1.1:

```
Tier 4  Function Specific  Departmental tools, dev/test environments
        Stand-alone or limited-use systems for specific teams or functions
```

Six columns, four values — **the RPO and RTO cells are empty**. Nothing in the
linear text stream says *which* two columns are missing. Positional recovery is
impossible. A question like "what's the RPO for Tier 4?" is unanswerable from
flattened text, and worse, a naive parser will confidently align the values one
column left and answer "4 to 8 hours" — which is Tier 3's number.

Further table complications already present in the corpus:

- **Tables split across page breaks** with the header row repeated — Security
  Standards §9.3 spans pages 18–19, Solution Architecture §6 spans 17–18. Both
  halves must rejoin into one logical table.
- **Tables nested inside a clause.** Security Standards §3.2 has its
  Requirements bullets *and then* a password-policy table, both belonging to the
  same standard. A table is not always a peer of a section; sometimes it's a
  child of a clause.
- **The answer is often only in the table.** "Minimum 12 characters (14+ for
  privileged accounts)" appears nowhere in the prose.

**Recommendation:** extract tables as structured objects, store them separately
from prose, and serialise each row to text *with its column headers attached*
for embedding:

> Tier 4 — Criticality: Function Specific. RPO: not specified. RTO: not
> specified. Business alignment: Stand-alone or limited-use systems…

Losing the visual grid but keeping header–cell binding is what makes table facts
retrievable. Keep the structured form too, so the UI can render the real table
in a citation.

PyMuPDF's `find_tables()` handles ruled tables like these reasonably well. It
should be evaluated on these four files before we commit to it — that's a
half-day of work and it de-risks the largest unknown in the pipeline.

---

## 5. Figures carry meaning that no text extraction reaches

The client document's §1.2 Enterprise Context Diagram is **a single image with an
empty text layer**. What's inside it: their entire application landscape —
MyMeralco, CMS v10, SCADA, ADMS, EGIS, the Meralco Data Platform, Hybrid
Integration Platform, and the data flows between them, grouped into Digital
Customer / Digital Enterprise / Digital Grid / Digital Employee.

That single figure is arguably the most valuable page in all four documents for
answering "what systems does this client run, and how do they connect?" — and a
text-only pipeline extracts precisely nothing from it.

This settles the earlier question about whether to store extracted images:
**yes, and captioning them is not optional.** The pipeline needs:

1. Figure extraction, including vector-drawn figures that `get_images()` misses
   — render the region to raster as the fallback.
2. A vision model pass producing a dense description, stored as the figure's
   searchable text, with the image retained for citation.
3. The figure bound to its heading path and its caption text, so
   "Enterprise Context Diagram" is part of what gets matched.

Budget note: this corpus has few figures, so per-document cost is low. It is
worth doing well rather than cheaply.

---

## 6. Near-duplicate text across documents will wreck retrieval

The three templates deliberately overlap. Some passages are **verbatim
identical** across documents:

> "Data in transit must use TLS 1.2 or higher (or equivalent current standard)"
> — Data Standards §8.3 *and* Security Standards §7.1, word for word.

> "All new and existing systems must be assessed against these standards;
> non-compliant systems must maintain a documented remediation plan"
> — appears verbatim in all three templates.

And the dangerous variant — near-identical text with a **materially different
answer**:

| Document | Exceptions approved by |
|---|---|
| Data Standards §12 | the Data Governance Council |
| Security Standards §15 | an authorized risk owner |
| Solution Architecture §12 | the Architecture Review Board |

Three sentences that differ by four words. A vector search for *"who approves
policy exceptions?"* returns all three at nearly identical similarity, and any
one of them alone is a wrong answer to a question that had a domain in mind.

Two things follow:

- **Retrieval needs diversity, not just similarity.** MMR or an equivalent
  penalty on near-duplicates, so the three copies of the TLS clause don't consume
  the whole context window.
- **Retrieval needs document scoping as a first-class filter**, and answers must
  cite which standard they came from. "Per the Security Standards, an authorized
  risk owner" is correct; "an authorized risk owner" alone is a coin flip.

Also: cross-document references are explicit and frequent — Solution Architecture
§7.2 says *"see the organization's Data Standards criticality tiers"*, §3.7 says
*"aligned to the organization's Security Standards and Data Standards"*. Chunks
should carry outbound reference links so the retriever can follow them.

---

## 7. Page furniture is ~100 repetitions of the same two lines

Every page of documents 1–3 carries a header (`Data Standards | Page 7`) and a
footer (`SENSITIVITY CLASSIFICATION: Internal Use`). Across the corpus that's
roughly 100 repetitions of near-identical boilerplate. Left in, it appears in
every chunk, and near-duplicate boilerplate degrades embedding quality across the
entire corpus.

Strip it — but **capture the sensitivity classification first**, because it is a
governance field, not noise. See §9.

Detection: any line repeating on >70% of pages at consistent y-position is
furniture. Do it per document, since the client document's furniture is a table
rather than text lines.

The Table of Contents is the same category of problem — it looks like dense
content and is 100% redundant. Drop it from the chunk stream after using it for
validation.

---

## 8. What this means for the schema

Sketch, not final:

```
document           id, tenant/user, title, doc_code, version, effective_date,
                   sensitivity, source_uri, sha256, page_count, profile, status
document_section   document_id, ordinal, number_text, title, heading_path,
                   page_start, page_end, is_empty
clause             section_id, statement, rationale, requirements[], guidance[],
                   ordinal
table_block        section_id | clause_id, caption, columns[], rows(jsonb),
                   page_start, page_end
figure             section_id, page, bbox, image_uri, caption, vlm_description
chunk              document_id, source_kind(clause|table_row|figure|prose),
                   source_id, heading_path, text, token_count, sensitivity
embedding          chunk_id, vector, model, dims
ingest_job         document_id, stage, state, attempts, lease_until,
                   correlation_id, last_error
ingest_issue       document_id, severity, kind, detail   -- empty sections,
                                                          -- ToC mismatches,
                                                          -- low-confidence tables
```

Two notes:

- `sha256` on the document enables content-addressed idempotency: re-uploading
  the same file must not re-embed it.
- `ingest_issue` is what makes §3's "empty sections must surface" real. Without
  it there is nowhere for that signal to go.

On **pgvector dimensions** — still open, still blocking. `text-embedding-3-large`
is 3072 dims; HNSW indexes cap around 2000 (~4000 with `halfvec`). Either reduce
dimensions at the API, use `halfvec`, or pick a smaller model. This needs a
decision and an ADR before the embed worker is written.

---

## 9. These documents also impose requirements on AIDP itself

Easy to miss: if Dexter delivers a data solution to a client like the one behind
document 4, then *their* standards bind *us*. Security Standards §1.3 and §11 say
so directly — the standards are "binding for internal teams, contractors, and
external vendors."

The obligations that actually bite:

**Classification must propagate.** Every page of every document is marked
`SENSITIVITY CLASSIFICATION: Internal Use`. Data Standards §8.1 defines the
handling rules per tier; §8.2 requires need-to-know access, and §8.1 reserves a
`Restricted` tier above it. So chunk rows and vector queries must carry and
filter on classification.

This is **cross-tenant isolation and then some**. AIDP serves an advisory firm
with multiple enterprise customers, so organisation is a hard wall: one
customer's Internal-Use standards must never surface in another's assessment.
Below that wall there is *also* internal segmentation — project teams shouldn't
pull Restricted material through the Q&A surface because it happened to rank
well.

Enforce both at the query, not in the prompt. Every retrieval carries an
`organisation_id` predicate, and no code path may construct one without it.

**PII is already in the corpus.** The revision history tables name individuals —
document 4 names its author. Data Standards §8.4 requires minimisation and
pseudonymisation for analytics. At minimum, mask names in logs.

**Idempotency, DLQ, correlation IDs.** Data Standards §9.3 and the client's
Integration principle 12 both require retries with backoff, a dead-letter path
for messages that never succeed, idempotent processing, and a unique correlation
ID per transaction. This maps directly onto the Postgres queue we designed —
`SELECT … FOR UPDATE SKIP LOCKED`, lease/reaper, attempt counters. Add a
`dead_letter` state and a correlation ID column and the queue satisfies the
standard as written. Cheap, and worth being able to say.

**Observability.** Solution Architecture §7.3 and the client's DevOps principle 9
require structured logs with correlation IDs propagated across stages, plus
metrics. Our three-stage pipeline is exactly the case they're describing.

**Deletion must be verifiable.** Data Standards §10.4 requires disposal to be
"auditable, authorized, and verifiable" and that "all copies and dependent
systems must be identified and addressed." Deleting a document must cascade to
chunks, vectors, extracted images, and blob storage — and be able to prove it
did. Design the cascade now; retrofitting it is painful.

**Key management.** Security Standards §7.2 wants keys in a dedicated store,
separate from the data. Relevant to our embedding-provider keys and Neon
credentials.

**ADRs.** Solution Architecture §2.2 and §10.2 require significant decisions to
be recorded, version-controlled beside the code, with alternatives and
consequences — and Appendix A gives the template. We have already made four
decisions that qualify:

1. Postgres-backed queue instead of RabbitMQ
2. One image, three stage-selected workers, instead of three services
3. Clause-atomic structure-aware chunking instead of embedding-breakpoint
4. Embedding model and vector dimensionality *(pending)*

Writing these up is maybe two hours and it is directly demonstrable compliance
with a standard the client will assess us against.

---

## 10. Build order

**Now — parse harness (highest value, no infrastructure).**
Run PyMuPDF over all four PDFs. Dump the font-signature profile, detected
headings, detected tables, detected figures. Diff detected sections against each
ToC. This answers the only question that actually gates the design: *does
structure detection work on real files?* Everything downstream assumes yes. Find
out before building on it.

**Next — the eval set, built from these four documents.**
Do this before writing the parser, not after. These files exercise every hard
case, so ~30 golden Q&A pairs fall out of them for free, each targeting a known
failure mode:

| Question | Answer | Tests |
|---|---|---|
| What's the RPO for a Tier 1 system? | 0 to 2 hours | Table-only fact |
| What's the RPO for Tier 4? | Not specified | Empty cell — must not answer "4 to 8 hours" |
| Minimum password length? | 12 chars, 14+ privileged | Table nested inside a clause |
| Who is Accountable for approving data disposal? | Data Owner | 2D RACI recovery |
| Who approves policy exceptions? | Depends on standard — must disambiguate | Near-duplicate across documents |
| What systems appear in the enterprise context diagram? | MyMeralco, SCADA, ADMS, … | Figure captioning |
| What are the cybersecurity guidelines? | Section is empty in the source | Must not hallucinate from a sibling document |

That table is the acceptance criteria for the whole pipeline. Every row is a
real trap present in the current corpus.

**Then, in order:** schema and storage → parse worker (text + tables + figures)
→ chunk worker → embed worker → retrieval with MMR and document scoping.

---

## 11. Open questions for you

1. **Will the three templates be filled in, and when?** They are unfilled today,
   so the reference framework is going to change under us. Argues for versioning
   documents and frameworks from day one, and for an assessment run recording
   which framework version it ran against.
2. **How much of the future corpus looks like document 4?** The parser's
   flexibility budget depends on it. If most of what arrives is table-major, the
   table-principle profile is the primary path and the prose profile secondary.
3. **What else gets assessed besides standards documents?** Vendor Solution
   Architecture Documents are the obvious case, but their §10.1 SAD spec implies
   diagrams, sequence flows, and NFR tables — a different parsing problem again.
4. **Embedding model and dimensionality** — blocking the embed worker.

---

## Appendix — corpus at a glance

- 100 pages, 4 documents, ~120 clause chunks
- ~25 tables, of which at least 2 span page breaks and 1 has empty cells that
  defeat positional recovery
- 1 figure carrying an entire client application landscape, with an empty text layer
- 3 sections that are empty or contain author notes rather than content
- ≥2 passages appearing verbatim in more than one document
- Every page classified `Internal Use`
