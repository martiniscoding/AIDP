"""Chunk stage — turn parsed structure into embeddable units.

The document already told us where the boundaries are, so nothing here
re-derives them. No fixed-size windows, no recursive character splitting, no
embedding-breakpoint "semantic" chunking: those exist to recover structure from
a wall of text, and we have the structure.

  clause     one chunk, never split
  table      one chunk per row, headers bound inline, plus one for the table
  figure     the vision description
  section    the section's own prose, as a parent for broader queries

Each chunk carries its heading path and a one-line contextual preamble from
the configured model, so it can be understood — and retrieved — without its
neighbours.
"""

from __future__ import annotations

import hashlib
import json

from .. import db, logs, queue
from ..ai import llm
from ..config import get_config
from ..queue import Job

log = logs.get(__name__)

# Rough, and deliberately so. Used for reporting and for keeping the contextual
# preamble input bounded, never for splitting.
_CHARS_PER_TOKEN = 3.8

# A section's own prose becomes a parent chunk above this length. The threshold
# exists to stop a standards document emitting a near-duplicate of its own
# clause as a "parent" — it is about duplication, not about importance.
_MIN_SECTION_PROSE = 320

# …but when a section carries no clause, its prose is the only record of that
# content in words the document actually used. Dropping it makes the section
# unretrievable, and an assessment then reports "absent" for something the
# document plainly addresses — the exact false negative the analyse guards
# exist to prevent. Observed on a design document: five sections, including one
# 3 characters under the threshold, produced no chunk at all.
#
# Only a clause raises the floor, and the comment above says why: the guard is
# about a parent chunk duplicating its own clause. A figure does not duplicate
# the prose beside it — it is a model's reading of an image, and the two say
# different things. Counting one as "this section is already covered" is what
# silently deleted the text of every slide carrying a diagram, which on a
# solution deck is every slide that matters.
_MIN_ORPHAN_PROSE = 60


def handle(job: Job, heartbeat) -> None:
    with db.connection() as conn:
        document = db.one(conn, 'SELECT * FROM "document" WHERE "id" = %s', (job.document_id,))
        if document is None:
            raise RuntimeError(f"document {job.document_id} no longer exists")

        sections = db.query(
            conn,
            'SELECT * FROM "document_section" WHERE "documentId" = %s ORDER BY "ordinal"',
            (job.document_id,),
        )
        section_ids = [s["id"] for s in sections]
        clauses = _by_section(
            db.query(
                conn,
                'SELECT * FROM "clause" WHERE "sectionId" = ANY(%s) ORDER BY "ordinal"',
                (section_ids,),
            )
            if section_ids
            else []
        )
        table_blocks = _by_section(
            db.query(
                conn,
                'SELECT * FROM "table_block" WHERE "sectionId" = ANY(%s) ORDER BY "ordinal"',
                (section_ids,),
            )
            if section_ids
            else []
        )
        figures = _by_section(
            db.query(
                conn,
                'SELECT * FROM "figure" WHERE "sectionId" = ANY(%s) ORDER BY "ordinal"',
                (section_ids,),
            )
            if section_ids
            else []
        )

    _set_status(job.document_id, "chunking")
    drafts = _build(document, sections, clauses, table_blocks, figures)
    if not drafts:
        raise RuntimeError("no chunks produced — the document parsed to nothing usable")

    heartbeat()
    # The document's own purpose, written once from the whole of it. Done here
    # rather than in parse because this is where the whole document is already
    # assembled for the preambles, and it is one call either way.
    summary = _summarise(document, sections)
    heartbeat()
    _contextualise(document, sections, drafts)
    _persist(job, document, drafts, summary)


class _Draft:
    __slots__ = ("kind", "source_id", "heading_path", "body", "context", "page_start", "page_end")

    def __init__(self, kind, source_id, heading_path, body, page_start, page_end):
        self.kind = kind
        self.source_id = source_id
        self.heading_path = heading_path
        self.body = body
        self.context = ""
        self.page_start = page_start
        self.page_end = page_end

    def render(self) -> str:
        parts = [self.heading_path]
        if self.context:
            parts.append(self.context)
        parts.append(self.body)
        return "\n\n".join(p for p in parts if p)


def _by_section(rows: list[dict]) -> dict[str, list[dict]]:
    grouped: dict[str, list[dict]] = {}
    for row in rows:
        grouped.setdefault(row["sectionId"], []).append(row)
    return grouped


def _build(document, sections, clauses, table_blocks, figures) -> list[_Draft]:
    drafts: list[_Draft] = []
    # Formats whose sections are short because the format is short, not because
    # the content is thin. Recorded by the parse stage, so this reads it rather
    # than guessing from the text.
    terse_format = (document.get("profile") or "") in ("slide-deck", "workbook")

    for section in sections:
        sid = section["id"]
        path = section["headingPath"]

        for clause in clauses.get(sid, []):
            drafts.append(
                _Draft("clause", clause["id"], path, _render_clause(clause),
                       clause["pageStart"], clause["pageEnd"])
            )

        for table in table_blocks.get(sid, []):
            columns = table["columns"] or []
            rows = table["rows"]
            if isinstance(rows, str):
                rows = json.loads(rows)
            if not columns or not rows:
                continue

            caption = table["caption"] or section["title"]
            for row in rows:
                drafts.append(
                    _Draft("table_row", table["id"], path,
                           f"{caption}\n{_render_row(columns, row)}",
                           table["pageStart"], table["pageEnd"])
                )
            # Whole-table chunk as well, for questions about the table itself
            # ("what are the criticality tiers?") rather than one of its rows.
            drafts.append(
                _Draft("table", table["id"], path,
                       f"{caption}\n\n{_render_table(columns, rows)}",
                       table["pageStart"], table["pageEnd"])
            )

        for figure in figures.get(sid, []):
            # A rejected description was judged wrong by a person. Indexing it
            # anyway would be worse than having no chunk for the figure at all —
            # the whole point of the review is that generated text can otherwise
            # read like a quotation from the document.
            if figure["reviewState"] == "rejected":
                continue
            # The correction wins where there is one.
            body = (figure["correctedDescription"] or figure["description"] or "").strip()
            if not body:
                continue
            caption = figure["caption"] or "Figure"
            drafts.append(
                _Draft("figure", figure["id"], path,
                       f"{caption}\n\n{body}",
                       figure["page"], figure["page"])
            )

        prose = (section["introText"] or "").strip()
        # A clause is drawn from this prose and can restate it; a table or a
        # figure cannot. See the note on the thresholds above.
        floor = _MIN_SECTION_PROSE if clauses.get(sid) else _MIN_ORPHAN_PROSE
        if terse_format and not clauses.get(sid):
            # A slide is a unit of meaning whatever its length, and a deck is
            # terse by design: "Same-day settlement / No exit fee" is thirty
            # characters and is the whole commercial case for a vendor. Held to
            # the prose floor, that slide produces no chunk at all — and then
            # its title, which is only ever carried *on* a chunk, is not
            # indexed either, so the slide leaves no trace.
            floor = 1
        if len(prose) >= floor:
            drafts.append(
                _Draft("section", sid, path, prose[:8000],
                       section["pageStart"], section["pageEnd"])
            )

    return drafts


def _render_clause(clause: dict) -> str:
    parts = []
    if clause["statement"]:
        parts.append(f"Statement: {clause['statement']}")
    if clause["rationale"]:
        parts.append(f"Rationale: {clause['rationale']}")
    if clause["requirements"]:
        parts.append("Requirements:\n" + "\n".join(f"• {r}" for r in clause["requirements"]))
    if clause["guidance"]:
        parts.append(
            "Applicable patterns / technology guidance:\n"
            + "\n".join(f"• {g}" for g in clause["guidance"])
        )
    return "\n\n".join(parts)


def _render_row(columns: list[str], row: dict) -> str:
    """A table row as a sentence, with every column named.

    `not specified` is written out rather than omitted. That is what makes an
    empty cell retrievable, and what stops a model inventing the neighbouring
    row's value — the failure the criticality-tier table in the sample corpus
    invites.
    """
    lead = (row.get(columns[0]) or "").strip()
    rest = [f"{col}: {(row.get(col) or 'not specified').strip()}" for col in columns[1:]]
    return (f"{lead} — " if lead else "") + ". ".join(rest) + "."


def _render_table(columns: list[str], rows: list[dict]) -> str:
    out = [" | ".join(columns)]
    for row in rows:
        out.append(" | ".join((row.get(c) or "not specified") for c in columns))
    return "\n".join(out)


def _document_text(sections: list[dict]) -> str:
    return "\n\n".join(
        f"{s['headingPath']}\n{(s['introText'] or '')[:4000]}" for s in sections
    )


def _summarise(document: dict, sections: list[dict]) -> str:
    """What this document is for, in a few sentences.

    Retrieval can say what a document contains and never what it is *for*. The
    judge sees eight passages and is told it cannot see the rest — fine for a
    standard, whose clauses are self-contained by construction, and wrong for a
    submission. A deck comparing two vendors for a B2B programme reads, eight
    passages at a time, as unrelated claims about two products, and a verdict
    reached that way answers a question nobody asked.

    One call per document, against a run of a hundred-odd judge calls that all
    benefit from it.
    """
    text = _document_text(sections)
    if not text.strip():
        return ""
    summary = llm.summarise(text, title=document["title"])
    if summary:
        logs.info(log, "document summarised", chars=len(summary))
    else:
        logs.warn(log, "no document summary — the judge will go without")
    return summary


def _contextualise(document: dict, sections: list[dict], drafts: list[_Draft]) -> None:
    """Ask the model to situate each chunk in its document.

    Degrades rather than fails: an un-contextualised chunk still embeds and
    still retrieves, just slightly less well. Losing a whole document because a
    summarisation call timed out would be the worse trade.
    """
    if not get_config().contextual_preambles:
        logs.info(log, "contextual preambles disabled by configuration")
        return
    if not llm.available():
        logs.warn(log, "no model API key configured, skipping contextual preambles")
        return

    document_text = _document_text(sections)
    try:
        contexts = llm.contextualise_many(
            document_text, [d.body for d in drafts], title=document["title"]
        )
    except Exception as exc:  # noqa: BLE001
        logs.warn(log, "contextualisation unavailable, continuing without", error=str(exc)[:200])
        return

    for draft, context in zip(drafts, contexts, strict=False):
        draft.context = context


def _set_status(document_id: str, status: str) -> None:
    with db.connection() as conn:
        db.execute(
            conn,
            'UPDATE "document" SET "status" = %s, "updatedAt" = now() WHERE "id" = %s',
            (status, document_id),
        )


def _persist(job: Job, document: dict, drafts: list[_Draft], summary: str = "") -> None:
    with db.transaction() as conn:
        # Re-chunking replaces wholesale; embeddings cascade off chunk rows.
        db.execute(conn, 'DELETE FROM "chunk" WHERE "documentId" = %s', (job.document_id,))

        for ordinal, draft in enumerate(drafts, start=1):
            text = draft.render()
            db.execute(
                conn,
                """
                INSERT INTO "chunk"
                    ("id","organisationId","documentId","sourceKind","sourceId","ordinal",
                     "headingPath","text","tokenCount","sensitivity","pageStart","pageEnd",
                     "contentHash")
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                """,
                (
                    db.new_id(),
                    job.organisation_id,
                    job.document_id,
                    draft.kind,
                    draft.source_id,
                    ordinal,
                    draft.heading_path[:1000],
                    text,
                    int(len(text) / _CHARS_PER_TOKEN),
                    document["sensitivity"],
                    draft.page_start,
                    draft.page_end,
                    hashlib.sha256(text.encode()).hexdigest(),
                ),
            )

        # Written in the same transaction as the chunks it was read from, so a
        # document never carries a summary of a version it no longer has.
        db.execute(
            conn,
            'UPDATE "document" SET "status" = \'embedding\', "summary" = %s, '
            '"updatedAt" = now() WHERE "id" = %s',
            (summary or None, job.document_id),
        )
        queue.complete(conn, job)

    counts: dict[str, int] = {}
    for draft in drafts:
        counts[draft.kind] = counts.get(draft.kind, 0) + 1
    logs.info(log, "chunked", total=len(drafts), **counts)
