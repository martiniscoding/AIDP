"""Parse stage — PDF in, structured document out.

Order matters here. Tables are extracted before figures so their regions can be
excluded from figure detection (both are drawn with the same vector primitives,
and a re-rendered table described by a vision model is expensive noise). The ToC
is read before the body so the body parse has something to be checked against.

Everything is written in one transaction together with the job's completion and
the handoff to chunking, so a crash leaves no half-parsed document behind.
"""

from __future__ import annotations

import fitz
from psycopg.types.json import Jsonb

from .. import db, logs, queue, storage
from ..ai import llm
from ..parsing import clauses as clause_parser
from ..parsing import figures as figure_parser
from ..parsing import furniture, sections, spans, tables, toc
from ..queue import Job

log = logs.get(__name__)

# Below this, the file is almost certainly a scan. OCR is a different pipeline
# and this fails loudly rather than producing an empty document.
_MIN_TEXT_CHARS = 200


def handle(job: Job, heartbeat) -> None:
    with db.connection() as conn:
        document = db.one(
            conn,
            'SELECT * FROM "document" WHERE "id" = %s',
            (job.document_id,),
        )
    if document is None:
        raise RuntimeError(f"document {job.document_id} no longer exists")

    _set_status(job.document_id, "parsing")
    raw = storage.storage().get(document["storageKey"])
    doc = fitz.open(stream=raw, filetype="pdf")

    try:
        result = _parse(doc, document, heartbeat)
    finally:
        doc.close()

    _persist(job, document, result)


class _Result:
    def __init__(self) -> None:
        self.title: str | None = None
        self.sensitivity: str | None = None
        self.page_count: int = 0
        self.profile: str = "prose-clause"
        self.sections: list = []
        self.clauses: dict[int, list] = {}
        self.tables: dict[int, list] = {}
        self.figures: dict[int, list] = {}
        self.issues: list[dict] = []

    def issue(self, severity: str, kind: str, detail: str, *, page=None, ref=None) -> None:
        self.issues.append(
            {"severity": severity, "kind": kind, "detail": detail, "page": page, "sectionRef": ref}
        )


def _parse(doc: fitz.Document, document: dict, heartbeat) -> _Result:
    out = _Result()
    out.page_count = doc.page_count

    lines = spans.extract_lines(doc)
    text_chars = sum(len(line.text) for line in lines)
    if text_chars < _MIN_TEXT_CHARS:
        raise RuntimeError(
            f"no usable text layer ({text_chars} characters across {doc.page_count} pages) — "
            "this looks like a scan and needs OCR, which is not wired up"
        )

    profile = spans.profile_fonts(lines)
    if not profile.confident:
        out.issue("high", "structure_uncertain", profile.note)

    out.title = _cover_title(lines, profile) or document["title"]

    content, classification = furniture.strip(lines, doc.page_count)
    out.sensitivity = classification
    if classification is None:
        out.issue(
            "low",
            "no_classification",
            "No sensitivity classification found on any page. Access control will "
            "fall back to the organisation default.",
        )

    toc_entries = toc.parse(lines)
    skip = _toc_pages(lines) | _cover_pages(lines)

    out.sections = sections.build(
        content, profile, document_title=out.title, skip_pages=skip
    )
    if not out.sections:
        out.issue("high", "no_sections", "No sections were detected in this document.")
        return out

    out.profile = sections.detect_profile(out.sections)
    heartbeat()

    # Tables first: their regions are excluded from figure detection below.
    all_tables = tables.extract(doc)
    exclude: dict[int, list] = {}
    for table in all_tables:
        index = _section_for_page(out.sections, table.page_start)
        out.tables.setdefault(index, []).append(table)
        for page in range(table.page_start, table.page_end + 1):
            exclude.setdefault(page, []).append(table.bbox)
        if table.confidence < tables.LOW_CONFIDENCE:
            out.issue(
                "medium",
                "table_low_confidence",
                f"Table on page {table.page_start} extracted at "
                f"{table.confidence:.0%} confidence — headers or cells may be wrong.",
                page=table.page_start,
                ref=out.sections[index].heading_path if index < len(out.sections) else None,
            )
    heartbeat()

    for figure in figure_parser.extract(doc, exclude):
        index = _section_for_page(out.sections, figure.page)
        out.figures.setdefault(index, []).append(figure)
    heartbeat()

    for index, section in enumerate(out.sections):
        if section.is_structural:
            continue
        found = clause_parser.from_prose(section)
        if not found:
            for table in out.tables.get(index, []):
                found.extend(clause_parser.from_table(section, table.rows))
        if found:
            out.clauses[index] = found

    _flag_empty_sections(out)
    _reconcile(out, toc_entries)
    return out


def _toc_pages(lines: list) -> set[int]:
    """Pages the contents occupies, so the body parse can skip them."""
    by_page: dict[int, int] = {}
    for line in lines:
        if toc._ENTRY.match(line.text.strip()):  # noqa: SLF001 — same package
            by_page[line.page] = by_page.get(line.page, 0) + 1
    return {page for page, hits in by_page.items() if hits >= 5}


def _cover_pages(lines: list) -> set[int]:
    """Page one, when it is a cover rather than the start of the body.

    A cover sets the document title, subtitle and department in display sizes,
    and every one of them looks like an unnumbered heading. Left in, each
    becomes a section that exists in the body and not in the contents — which
    then reports as a reconciliation failure on a document that parsed fine.

    The test is the absence of a numbered heading: a real first page of content
    opens with "1. Introduction".
    """
    first = [ln for ln in lines if ln.page == 1]
    if not first:
        return set()
    if any(sections._NUMBERED.match(ln.text.strip()) for ln in first):  # noqa: SLF001
        return set()
    return {1}


def _cover_title(lines: list, profile: spans.FontProfile) -> str | None:
    """The largest text on page one — the document's own name for itself."""
    first = [ln for ln in lines if ln.page == 1 and len(ln.text) > 3]
    if not first:
        return None
    biggest = max(first, key=lambda ln: ln.size)
    candidates = [ln.text for ln in first if ln.size >= biggest.size - 0.6]
    title = max(candidates, key=len) if candidates else biggest.text
    return title if 3 < len(title) <= 160 else None


def _section_for_page(section_list: list, page: int) -> int:
    """Index of the section a page-anchored artefact belongs to."""
    index = 0
    for i, section in enumerate(section_list):
        if section.page_start <= page:
            index = i
        else:
            break
    return index


def _empty_sections(out: _Result) -> set[int]:
    """Indices of sections that genuinely carry nothing.

    The single definition of "empty" — used both for the `isEmpty` flag on the
    row and for the review issue below. Two definitions is one too many: the
    outline once marked fourteen sections empty while the review reported one,
    and both were reading the same document.
    """
    empty: set[int] = set()
    for index, section in enumerate(out.sections):
        if section.is_structural:
            continue
        # A parent heading carries its substance in its children.
        nxt = out.sections[index + 1] if index + 1 < len(out.sections) else None
        if nxt is not None and nxt.depth > section.depth:
            continue
        has_content = bool(
            out.clauses.get(index)
            or out.tables.get(index)
            or out.figures.get(index)
            or len(section.text) > 200
        )
        if not has_content:
            empty.add(index)
    return empty


def _flag_empty_sections(out: _Result) -> None:
    """A section with nothing under it is reported, never silently dropped.

    The live customer document's Cybersecurity Guidelines section reads, in
    full, "This template ensures:" — and stops. A tool that swallows that will
    later answer a cybersecurity question from a sibling document and sound
    certain.
    """
    for index in sorted(_empty_sections(out)):
        section = out.sections[index]
        out.issue(
            "high",
            "section_empty",
            f"Section '{section.title}' has no clauses, tables, figures or "
            "substantive prose. The source document appears incomplete here.",
            page=section.page_start,
            ref=section.heading_path,
        )


def _reconcile(out: _Result, entries: list) -> None:
    if not entries:
        out.issue(
            "low",
            "no_toc",
            "No table of contents found, so section detection could not be "
            "cross-checked against one.",
        )
        return

    parsed = [(s.title, s.page_start) for s in out.sections]
    report = toc.reconcile(entries, parsed)

    for entry in report.missing:
        out.issue(
            "high",
            "section_missing",
            f"'{entry.title}' is listed in the table of contents (page {entry.page}) "
            "but no matching section was found in the body.",
            page=entry.page,
            ref=entry.number,
        )
    for title, expected, found in report.page_drift:
        out.issue(
            "medium",
            "toc_mismatch",
            f"'{title}' is listed on page {expected} but was parsed at page {found}.",
            page=expected,
        )
    logs.info(
        log,
        "reconciled against table of contents",
        coverage=round(report.coverage, 3),
        matched=report.matched,
        missing=len(report.missing),
    )


def _set_status(document_id: str, status: str) -> None:
    with db.connection() as conn:
        db.execute(
            conn,
            'UPDATE "document" SET "status" = %s, "updatedAt" = now() WHERE "id" = %s',
            (status, document_id),
        )


def _persist(job: Job, document: dict, out: _Result) -> None:
    store = storage.storage()
    empty = _empty_sections(out)

    # Figure descriptions are written before the transaction opens: they are
    # slow network calls, and holding a Postgres transaction across them would
    # pin a connection for minutes.
    described: dict[tuple[int, int], tuple[str, str]] = {}
    if llm.available():
        for section_index, figure_list in out.figures.items():
            section = out.sections[section_index]
            for ordinal, figure in enumerate(figure_list, start=1):
                key = store.put(
                    storage.figure_key(job.document_id, figure.page, ordinal),
                    figure.png,
                    "image/png",
                )
                try:
                    description = llm.describe_figure(
                        figure.png, heading_path=section.heading_path, caption=figure.caption
                    )
                except Exception as exc:  # noqa: BLE001 — degrade, don't fail the document
                    logs.warn(
                        log,
                        "figure description failed",
                        page=figure.page,
                        error=str(exc)[:200],
                    )
                    description = ""
                described[(section_index, ordinal)] = (key, description)
        undescribed = sum(1 for _, desc in described.values() if not desc.strip())
        if undescribed:
            out.issue(
                "medium",
                "figure_undescribed",
                f"{undescribed} figure(s) could not be described by the model — most "
                "often a quota or rate limit. Diagrams with no text layer contribute "
                "nothing to retrieval until they are described; re-run to retry.",
            )
    else:
        for section_index, figure_list in out.figures.items():
            for ordinal, figure in enumerate(figure_list, start=1):
                key = store.put(
                    storage.figure_key(job.document_id, figure.page, ordinal),
                    figure.png,
                    "image/png",
                )
                described[(section_index, ordinal)] = (key, "")
        if out.figures:
            out.issue(
                "medium",
                "figure_undescribed",
                "No model API key is configured, so figures were stored but not described. "
                "Diagrams with no text layer contribute nothing to retrieval until they are.",
            )

    with db.transaction() as conn:
        # Re-parsing replaces: sections cascade to clauses, tables and figures.
        db.execute(
            conn, 'DELETE FROM "document_section" WHERE "documentId" = %s', (job.document_id,)
        )
        db.execute(conn, 'DELETE FROM "ingest_issue" WHERE "documentId" = %s', (job.document_id,))

        for index, section in enumerate(out.sections):
            section_id = db.new_id()
            db.execute(
                conn,
                """
                INSERT INTO "document_section"
                    ("id","documentId","ordinal","numberText","title","headingPath",
                     "depth","pageStart","pageEnd","introText","isEmpty")
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                """,
                (
                    section_id,
                    job.document_id,
                    section.ordinal,
                    section.number_text,
                    section.title[:500],
                    section.heading_path[:1000],
                    section.depth,
                    section.page_start,
                    section.page_end,
                    section.text[:20000],
                    index in empty,
                ),
            )

            clause_ids: list[str] = []
            for clause in out.clauses.get(index, []):
                clause_id = db.new_id()
                clause_ids.append(clause_id)
                db.execute(
                    conn,
                    """
                    INSERT INTO "clause"
                        ("id","sectionId","ordinal","title","statement","rationale",
                         "requirements","guidance","pageStart","pageEnd")
                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                    """,
                    (
                        clause_id,
                        section_id,
                        clause.ordinal,
                        (clause.title or "")[:500] or None,
                        clause.statement,
                        clause.rationale,
                        clause.requirements,
                        clause.guidance,
                        clause.page_start,
                        clause.page_end,
                    ),
                )

            # A table belongs to the clause when the section holds exactly one —
            # Security §3.2 carries its password policy inside the standard
            # rather than beside it.
            owner = clause_ids[0] if len(clause_ids) == 1 else None
            for ordinal, table in enumerate(out.tables.get(index, []), start=1):
                db.execute(
                    conn,
                    """
                    INSERT INTO "table_block"
                        ("id","sectionId","clauseId","ordinal","caption","columns",
                         "rows","pageStart","pageEnd","confidence")
                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                    """,
                    (
                        db.new_id(),
                        section_id,
                        owner,
                        ordinal,
                        table.caption,
                        table.columns,
                        Jsonb(table.rows),
                        table.page_start,
                        table.page_end,
                        table.confidence,
                    ),
                )

            for ordinal, figure in enumerate(out.figures.get(index, []), start=1):
                key, description = described.get((index, ordinal), ("", ""))
                db.execute(
                    conn,
                    """
                    INSERT INTO "figure"
                        ("id","sectionId","ordinal","page","bbox","storageKey",
                         "caption","description")
                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s)
                    """,
                    (
                        db.new_id(),
                        section_id,
                        ordinal,
                        figure.page,
                        list(figure.bbox),
                        key,
                        figure.caption,
                        description,
                    ),
                )

        for issue in out.issues:
            db.execute(
                conn,
                """
                INSERT INTO "ingest_issue"
                    ("id","documentId","severity","kind","detail","page","sectionRef")
                VALUES (%s,%s,%s,%s,%s,%s,%s)
                """,
                (
                    db.new_id(),
                    job.document_id,
                    issue["severity"],
                    issue["kind"],
                    issue["detail"][:2000],
                    issue["page"],
                    (issue["sectionRef"] or None) and str(issue["sectionRef"])[:500],
                ),
            )

        db.execute(
            conn,
            """
            UPDATE "document"
               SET "title" = %s, "sensitivity" = %s, "pageCount" = %s,
                   "profile" = %s, "status" = 'chunking', "failureReason" = NULL,
                   "updatedAt" = now()
             WHERE "id" = %s
            """,
            (
                (out.title or document["title"])[:500],
                out.sensitivity,
                out.page_count,
                out.profile,
                job.document_id,
            ),
        )

        queue.complete(conn, job)

    logs.info(
        log,
        "parsed",
        sections=len(out.sections),
        clauses=sum(len(c) for c in out.clauses.values()),
        tables=sum(len(t) for t in out.tables.values()),
        figures=sum(len(f) for f in out.figures.values()),
        issues=len(out.issues),
        profile=out.profile,
    )
