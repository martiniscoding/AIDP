"""Parts of a design that no standard governs, and the standards that would.

An assessment asks, clause by clause, what a design does about each rule the
organisation has. That leaves the opposite question unasked: what the design does
that no rule covers. A blueprint that takes card payments through a processor, or
ships a regulated product through a carrier, is checked on nothing in those parts
when no standard speaks to them — and a report listing only gaps against existing
rules reads as though everything else were fine.

So after the clauses, a model reads the design section by section beside every
clause in the framework, and says which sections no clause governs, what the
design does there, and which standards would cover them. The same discipline as
the rest of the pipeline applies:

- **Sections are named by number.** A number that is not a section of this
  design is dropped.
- **A gap quotes the design.** The quote must be in the document word for word
  (see whole_document.py) and inside the section it is claimed for. A gap
  without one is not reported. Table cells and diagram labels are too short or
  too scattered for that phrase check, so a quote made of them is taken line by
  line instead, and shown as the section's own lines (`_line_quote`).
- **A passage a clause already judged is not ungoverned.** If a finding in the
  same run cited the quoted words as evidence for a clause, the gap is dropped.
- **Suggestions are suggestions.** Named standards are a model's proposal for
  whoever owns the standards library, stored and shown as such, never a
  requirement on a design.

Stored on the run as JSON (`assessment_run.coverage`, read by the app's
src/lib/ingest/coverage.ts). It never fails a run: judged clauses are worth
having even when this could not be worked out, and the run says why.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field

from psycopg.types.json import Jsonb

from . import db, logs, whole_document
from .ai import llm
from .config import get_config

log = logs.get(__name__)

# Each clause field is cut to this in the catalogue the model checks sections
# against. The title and the opening of each part say what a clause governs; a
# hundred clauses at full length would crowd the design out of the reading.
CLAUSE_FIELD_CHARS = 320

# No section is shortened below this, however long the design: less says too
# little about what a section describes to judge whether anything governs it.
MIN_SECTION_CHARS = 600

# Kept from one reply. A design with more ungoverned parts than this has a
# standards-library problem that the first forty already show.
MAX_GAPS = 40
MAX_SUGGESTIONS = 12

# Verdicts whose evidence says a clause was found to bear on a passage.
CITING_VERDICTS = ("covered", "partial", "contradicts")

VERSION = 1

# What a gap and a suggested standard may say, in characters. The prompt asks
# for 180/280/200; these leave room for a reply a shade over rather than cutting
# a sentence in half, and `_sentences` snaps each to a sentence end.
MAX_GAP_WHAT = 220
MAX_SUGGESTION_COVERS = 300
MAX_SUGGESTION_WHY = 220


@dataclass
class Section:
    ordinal: int
    title: str
    heading_path: str
    page_start: int | None
    page_end: int | None
    lines: list[str] = field(default_factory=list)
    pages: set[int] = field(default_factory=set)

    @property
    def text(self) -> str:
        return "\n".join(self.lines)


@dataclass
class Checked:
    gaps: list[dict] = field(default_factory=list)
    suggestions: list[dict] = field(default_factory=list)
    dropped: dict[str, int] = field(
        default_factory=lambda: {
            "unknownSection": 0,
            "unverified": 0,
            "outsideSection": 0,
            "alreadyJudged": 0,
            "generic": 0,
        }
    )
    # Kept, but quoted by the section's own lines rather than the model's words;
    # see `_line_quote`. Not a refusal, so not in `dropped`, which the report
    # counts as set aside.
    corrected: dict[str, int] = field(default_factory=lambda: {"lineQuote": 0})


def group(heads: list[dict], rows: list[dict]) -> list[Section]:
    """Sections with their own lines, from `document_section` and `source_line` rows.

    A line carries the ordinal of the section the parse put it in. Sections with
    no lines are left out: there is nothing in them to be governed.
    """
    sections = {
        head["ordinal"]: Section(
            ordinal=head["ordinal"],
            title=str(head.get("title") or ""),
            heading_path=str(head.get("headingPath") or ""),
            page_start=head.get("pageStart"),
            page_end=head.get("pageEnd"),
        )
        for head in heads
    }
    for row in rows:
        section = sections.get(row.get("sectionOrdinal"))
        text = " ".join(str(row.get("text") or "").split())
        if section is None or not text:
            continue
        kind = row.get("kind")
        prefix = "## " if kind == "heading" else "- " if kind == "bullet" else ""
        section.lines.append(prefix + text)
        if isinstance(row.get("page"), int):
            section.pages.add(row["page"])
    return [section for section in sections.values() if section.lines]


def render_standards(clauses: list[dict]) -> str:
    """Every clause as the model checks sections against it: where it is, what it says."""

    def cut(value: str) -> str:
        value = " ".join(value.split())
        return value if len(value) <= CLAUSE_FIELD_CHARS else value[: CLAUSE_FIELD_CHARS - 1] + "…"

    rows: list[str] = []
    for index, clause in enumerate(clauses, start=1):
        where = str(clause.get("headingPath") or clause.get("documentTitle") or "")
        rows.append(f"C{index} [{where}] {clause.get('title') or ''}".rstrip())
        statement = cut(str(clause.get("statement") or ""))
        if statement:
            rows.append(f"   Statement: {statement}")
        requirements = cut("; ".join(str(r) for r in clause.get("requirements") or []))
        if requirements:
            rows.append(f"   Requirements: {requirements}")
    return "\n".join(rows)


def render_design(sections: list[Section], budget: int) -> tuple[str, bool]:
    """The design section by section, each behind its number. (text, shortened?)

    Over budget, the longest sections are cut to a common length and short ones
    are left whole, so a one-slide integration is never lost to make room for a
    ten-page appendix.
    """
    lengths = [len(section.text) for section in sections]
    cap: int | None = None
    if sum(lengths) > budget:
        low, high = MIN_SECTION_CHARS, max(lengths)
        while low < high:
            middle = (low + high + 1) // 2
            if sum(min(length, middle) for length in lengths) <= budget:
                low = middle
            else:
                high = middle - 1
        cap = low

    out: list[str] = []
    shortened = False
    for section in sections:
        pages = sorted(section.pages)
        where = (
            ""
            if not pages
            else f" (page {pages[0]})"
            if pages[0] == pages[-1]
            else f" (pages {pages[0]}-{pages[-1]})"
        )
        out.append(f"=== S{section.ordinal}: {section.heading_path or section.title}{where} ===")
        body = section.text
        if cap is not None and len(body) > cap:
            body = body[:cap].rstrip() + "\n[... the rest of this section is not shown]"
            shortened = True
        out.append(body)
    return "\n".join(out), shortened


def _integer(value) -> int | None:
    if isinstance(value, bool):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _clean(value, limit: int) -> str:
    text = " ".join(str(value or "").split())
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def _sentences(value, limit: int) -> str:
    """Whole sentences within `limit`, falling back to `_clean`.

    A recommendation cut mid-clause reads as though the tool broke. Where there
    is a sentence end inside the limit the text is cut there instead, and only a
    first sentence longer than the whole limit is clipped by `_clean`.
    """
    text = " ".join(str(value or "").split())
    if len(text) <= limit:
        return text
    window = text[:limit]
    cut = max(window.rfind(". "), window.rfind("! "), window.rfind("? "))
    if cut >= limit // 3:
        return window[: cut + 1]
    return _clean(text, limit)


# The fewest words a recommendation, a gap or a suggested standard can say
# something in. Fewer than this is a heading, not a statement.
MIN_SPECIFIC_WORDS = 6

# Boilerplate that reads as advice and says nothing. Every one of these was in a
# suggestion that passed the anchoring checks â€” it named a real component and
# quoted the design â€” and still told the reviewer to do no particular thing.
_GENERIC = re.compile(
    r"\b("
    r"consider\s+(implementing|adding|reviewing|using|adopting)"
    r"|ensure\s+(that\s+)?proper"
    r"|confirm\s+(its\s+|the\s+)?support\s+status"
    r"|align\s+with\s+stakeholders"
    r"|review\s+and\s+update"
    r"|follow\s+(industry\s+)?best\s+practices?"
    r"|as\s+appropriate|where\s+appropriate"
    r")\b",
    re.IGNORECASE,
)


def _is_generic(text: str) -> bool:
    """Whether a line of advice says nothing a reviewer could act on.

    Deterministic on purpose. The prompt asks for a concrete change and mostly
    gets one; this is the floor under it, so a reply that drifts back to filler
    is refused by the same rule every time rather than by a model's mood.
    """
    if len(text.split()) < MIN_SPECIFIC_WORDS:
        return True
    return bool(_GENERIC.search(text))

# The design is rendered uncut for the cache key. The budget the model is given
# shrinks as the findings grow, and a key that moved with it would miss whenever
# a verdict changed â€” the one thing the key is built to ignore.
_UNCUT = 10**12


def _page_for(check, named: int | None, section: Section) -> int | None:
    if check.page in section.pages:
        return check.page
    if named in section.pages:
        return named
    return min(section.pages) if section.pages else check.page


def _rehome(
    candidate: str, sections: list[Section], skip: Section
) -> Section | None:
    """The one other section whose own words contain this quote, if exactly one does.

    A model reading a long design puts a quote in the section next to the one it
    came from often enough to matter — six of fifteen suggestions in one live run
    were refused for it, every quote verified against the document and only the
    ordinal wrong. The quote is real either way, so rather than lose the
    suggestion the section is corrected to the one that actually holds it.

    Only when exactly one section does. Two sections quoting the same sentence
    cannot tell us which the model meant, and guessing would attach a suggestion
    to the wrong part of the design — the failure the section check exists to
    prevent.
    """
    homes = [
        other
        for other in sections
        if other.ordinal != skip.ordinal and whole_document.contains(other.text, candidate)
    ]
    return homes[0] if len(homes) == 1 else None


def _checked_quote(
    item: dict,
    section: Section,
    whole: whole_document.WholeDocument,
    sections: list[Section] | None = None,
) -> tuple[str | None, int | None, str, Section]:
    """(quote, page, "", section) when the quote is a section's own words.

    On failure the quote is None and the third value says why. The fourth is the
    section the quote belongs to: the one that was cited, unless `sections` was
    given and the quote turned out to live in exactly one other — see `_rehome`.

    A quote joining two sentences from different places is tried sentence by
    sentence, as the whole-document judge's quotes are; one real sentence from
    the section is enough to show what the section says.
    """
    quote = " ".join(str(item.get("quote") or "").split())
    named = _integer(item.get("page"))
    pieces = whole.sentences(quote)
    candidates = [quote] + (pieces if len(pieces) > 1 else [])

    found_elsewhere = False
    for candidate in candidates:
        check = whole.verify(candidate, named)
        if not check.verified:
            continue
        if whole_document.contains(section.text, candidate):
            return candidate, _page_for(check, named, section), "", section
        # In the document, but not in the section the model named.
        home = _rehome(candidate, sections, section) if sections else None
        if home is not None:
            return candidate, _page_for(check, named, home), "", home
        found_elsewhere = True
    return None, None, "outsideSection" if found_elsewhere else "unverified", section


# How many consecutive lines one line of a quote may stand for: a table row the
# parse split ("… Docker, NexusOSS," then "ALM").
_LINE_WINDOW = 5

# Fewer words than this, across every line kept, identifies nothing.
#
# A bare number is not one of them. "2 Weeks" and "Security | Harbor" are both two
# tokens, and the phrase check's four-word floor would refuse them equally — but
# the second names a technology choice worth governing and the first is a delivery
# estimate, which rule 2 of the prompt says is never a gap. Counting only the words
# that are not numbers separates them where length cannot, and it was a row of that
# shape whose coming and going moved the reported count between reads of one design.
_MIN_LINE_WORDS = 2
_NUMBER = re.compile(r"^\d+$")


def _plain(line: str) -> str:
    """A section line as the design shows it, without the marker `group` adds."""
    return re.sub(r"^(## |- )", "", line)


def _line_quote(item: dict, section: Section) -> str | None:
    """The design's own lines, for a quote made of them that the phrase check refuses.

    The phrase check wants four or more words running on in the document. Designs
    put a great deal in table cells and diagram labels, which fail it for reasons
    that say nothing about whether the model read the design: a table row is short
    ("Security | Harbor"), and labels listed together sit a line or two apart in
    the parse ("Build and Test(Junit)", then "Trusted Image", then "Vulnerability
    Scanning"). On a real design this refused a genuine gap on one run and kept it
    on the next, so the report's count moved for no reason in the design.

    So such a quote is taken line by line. Every line of it must be one of the
    section's lines, or a run of up to `_LINE_WINDOW` of them read together — a row
    the parse split — and a line long enough to identify a passage may also be a
    phrase inside them. One line that is none of these refuses the whole quote: a
    quote with one invented line is not the design's words. What is kept is the
    section's own lines, in the design's order, never the model's rendering.
    """
    pieces = [
        piece
        for piece in (
            whole_document.normalise(part) for part in str(item.get("quote") or "").splitlines()
        )
        if piece
    ]
    if not pieces:
        return None
    lines = [_plain(line) for line in section.lines]
    normal = [whole_document.normalise(line) for line in lines]
    used: set[int] = set()
    for piece in pieces:
        long_enough = len(piece.split()) >= whole_document.MIN_QUOTE_WORDS
        match: range | None = None
        for size in range(1, _LINE_WINDOW + 1):
            for start in range(len(lines) - size + 1):
                window = " ".join(text for text in normal[start : start + size] if text)
                if piece == window or (long_enough and f" {piece} " in f" {window} "):
                    match = range(start, start + size)
                    break
            if match is not None:
                break
        if match is None:
            return None
        used.update(index for index in match if normal[index])
    named = [
        word
        for index in used
        for word in normal[index].split()
        if not _NUMBER.match(word)
    ]
    if len(named) < _MIN_LINE_WORDS:
        return None
    return " · ".join(lines[index] for index in sorted(used))


def _overlaps(quote: str, passage: str) -> bool:
    """Whether a cited passage is the quoted text, give or take its surroundings.

    Only a passage not much longer than the quote counts. A search-mode citation
    can be a whole section, and one clause citing that section for sign-in does
    not govern the payment flow described further down it.
    """
    padded_quote, padded_passage = f" {quote} ", f" {passage} "
    if padded_passage.find(padded_quote) != -1 and len(passage) <= 3 * len(quote):
        return True
    return padded_quote.find(padded_passage) != -1


def check(
    raw: dict,
    sections: list[Section],
    whole: whole_document.WholeDocument,
    cited: list[str],
) -> Checked:
    """Keep what the design and the run's own findings bear out; count the rest."""
    by_ordinal = {section.ordinal: section for section in sections}
    out = Checked()
    seen: set[int] = set()

    items = raw.get("gaps") if isinstance(raw.get("gaps"), list) else []
    for item in items[:MAX_GAPS]:
        if not isinstance(item, dict):
            continue
        ordinal = _integer(item.get("section"))
        section = by_ordinal.get(ordinal) if ordinal is not None else None
        if section is None:
            out.dropped["unknownSection"] += 1
            continue
        if section.ordinal in seen:
            continue
        quote, page, reason, section = _checked_quote(item, section, whole, sections)
        # The quote may have moved the gap to the section that really holds it.
        if section.ordinal in seen:
            continue
        # Only for words not found at all. Words found in another section are
        # the wrong section, whatever shape they are in.
        if quote is None and reason == "unverified":
            lines = _line_quote(item, section)
            if lines is not None:
                named = _integer(item.get("page"))
                quote = lines
                page = (
                    named
                    if named in section.pages
                    else min(section.pages)
                    if section.pages
                    else section.page_start
                )
                out.corrected["lineQuote"] += 1
        if quote is None:
            logs.warn(
                log,
                "coverage gap refused",
                section=section.ordinal,
                reason=reason,
                quote=str(item.get("quote") or "")[:300],
            )
            out.dropped[reason] += 1
            continue
        if any(_overlaps(whole_document.normalise(quote), passage) for passage in cited):
            out.dropped["alreadyJudged"] += 1
            continue

        what = _sentences(item.get("what"), MAX_GAP_WHAT)
        # A gap a reader could not act on. It named a real section and quoted
        # it, so it passed every other check, and still said nothing.
        if _is_generic(what):
            logs.warn(log, "coverage gap refused as generic", section=section.ordinal, what=what)
            out.dropped["generic"] += 1
            continue

        seen.add(section.ordinal)
        pages = sorted(section.pages)
        out.gaps.append(
            {
                "section": section.ordinal,
                "title": section.title[:300],
                "headingPath": section.heading_path[:1000],
                "pageStart": pages[0] if pages else section.page_start,
                "pageEnd": pages[-1] if pages else section.page_end,
                "what": what,
                "quote": quote[:1500],
                "page": page,
            }
        )

    kept = [gap["section"] for gap in out.gaps]
    offered = raw.get("suggestions") if isinstance(raw.get("suggestions"), list) else []
    for item in offered[:MAX_SUGGESTIONS]:
        if not isinstance(item, dict):
            continue
        title = _clean(item.get("title"), 160)
        numbers: list[int] = []
        values = item.get("sections") if isinstance(item.get("sections"), list) else []
        for value in values:
            number = _integer(value)
            if number in kept and number not in numbers:
                numbers.append(number)
        # A standard justified only by gaps that failed their checks has nothing
        # left in the design to point at.
        if not title or not numbers:
            continue
        covers = _sentences(item.get("covers"), MAX_SUGGESTION_COVERS)
        why = _sentences(item.get("why"), MAX_SUGGESTION_WHY)
        # A standard nobody could write from. Both halves have to be filler:
        # a vague "why" beside a concrete "covers" is still worth showing.
        if _is_generic(covers) and _is_generic(why):
            logs.warn(log, "coverage suggestion refused as generic", title=title)
            out.dropped["generic"] += 1
            continue
        out.suggestions.append(
            {
                "title": title,
                "covers": covers,
                "why": why,
                "sections": numbers,
            }
        )
    return out


def _most_quoted(found: list[dict]) -> dict:
    """The version of a gap most reads quoted, and the fullest of those."""
    counts: dict[str, int] = {}
    for gap in found:
        counts[gap["quote"]] = counts.get(gap["quote"], 0) + 1
    return max(found, key=lambda gap: (counts[gap["quote"]], len(gap["quote"])))


def agree(reads: list[Checked], needed: int) -> Checked:
    """One answer out of several reads: what most of them saw.

    Asked the same question three times, a model does not answer it the same way
    three times. On a real proposal the reported count moved between 5 and 14,
    and the parts that came and went were the borderline ones — a delivery table
    read as part of the system, a section some clause already governs. Those turn
    up in one read. A part of the design that genuinely nothing governs turns up
    in all of them.

    So a gap is reported once `needed` reads found it, and the version stored is
    the one most of them quoted. A suggestion survives if any gap it points at
    did, and keeps the sections that survived.

    What was refused is summed across the reads rather than picked from one: it
    describes how the model behaved over the whole exercise.
    """
    out = Checked()
    if not reads:
        return out

    for name in out.dropped:
        out.dropped[name] = sum(read.dropped.get(name, 0) for read in reads)
    for name in out.corrected:
        out.corrected[name] = sum(read.corrected.get(name, 0) for read in reads)

    seen: dict[int, list[dict]] = {}
    for read in reads:
        for gap in read.gaps:
            seen.setdefault(gap["section"], []).append(gap)

    kept: set[int] = set()
    for section, found in sorted(seen.items()):
        if len(found) < needed:
            continue
        kept.add(section)
        # `reads` is how many of them saw it. Stored for a reader who wants to
        # know how sure this is, and ignored by anything that does not.
        out.gaps.append({**_most_quoted(found), "reads": len(found)})

    titles: dict[str, dict] = {}
    for read in reads:
        for suggestion in read.suggestions:
            sections = sorted(number for number in suggestion["sections"] if number in kept)
            if not sections:
                continue
            key = whole_document.normalise(suggestion["title"])
            held = titles.get(key)
            if held is None:
                titles[key] = {**suggestion, "sections": sections, "reads": 1}
            else:
                held["sections"] = sorted(set(held["sections"]) | set(sections))
                held["reads"] += 1
    # Held to the same bar as a gap. One read proposing "Third-Party API
    # Integration Standards" beside two proposing "Third-Party SaaS Integration
    # Standards" is the model reaching for a name, not the library needing three
    # standards for two sections.
    out.suggestions = sorted(
        (entry for entry in titles.values() if entry["reads"] >= needed),
        key=lambda entry: (min(entry["sections"]), entry["title"]),
    )
    return out


def _load(conn, document_id: str) -> tuple[list[Section], whole_document.WholeDocument | None]:
    rows = db.query(
        conn,
        'SELECT "page", "kind", "text", "sectionOrdinal" FROM "source_line" '
        'WHERE "documentId" = %s ORDER BY "ordinal"',
        (document_id,),
    )
    if not rows:
        return [], None
    heads = db.query(
        conn,
        'SELECT "ordinal", "title", "headingPath", "pageStart", "pageEnd" '
        'FROM "document_section" WHERE "documentId" = %s ORDER BY "ordinal"',
        (document_id,),
    )
    document = db.one(conn, 'SELECT "title" FROM "document" WHERE "id" = %s', (document_id,))
    whole = whole_document.build((document or {}).get("title") or "", rows, [])
    return group(heads, rows), whole


def _cited(conn, run_id: str) -> list[str]:
    """Normalised passages this run's findings cited for a clause."""
    rows = db.query(
        conn,
        'SELECT "evidence" FROM "finding" WHERE "runId" = %s AND "verdict" = ANY(%s)',
        (run_id, list(CITING_VERDICTS)),
    )
    passages: list[str] = []
    for row in rows:
        items = row.get("evidence") or []
        if isinstance(items, str):
            items = json.loads(items)
        for item in items if isinstance(items, list) else []:
            if not isinstance(item, dict):
                continue
            passage = whole_document.normalise(str(item.get("excerpt") or ""))
            if len(passage.split()) >= whole_document.MIN_QUOTE_WORDS:
                passages.append(passage)
    return passages


def _outcome(state: str, note: str | None, **rest) -> dict:
    return {
        "version": VERSION,
        "state": state,
        "note": note,
        "checkedAt": db.now().isoformat(),
        "model": llm.model_name()[1],
        # How many reads the reported gaps came out of. See `agree`.
        "reads": rest.get("reads", 1),
        "sections": rest.get("sections", 0),
        "truncated": rest.get("truncated", False),
        "gaps": rest.get("gaps", []),
        "suggestions": rest.get("suggestions", []),
        "dropped": rest.get("dropped", {}),
        "corrected": rest.get("corrected", {}),
    }


def work_out(run: dict, clauses: list[dict]) -> dict:
    """The coverage of one run's design, ready to store. Raises on a model failure."""
    if not clauses:
        return _outcome("skipped", "There are no standard clauses to compare this design with.")

    with db.connection() as conn:
        sections, whole = _load(conn, run["documentId"])
        cited = _cited(conn, run["id"])

    if whole is None or not sections:
        return _outcome(
            "skipped",
            "This design was processed before its pages were stored, so the parts no standard "
            "covers could not be worked out. Reprocess it, then run the assessment again.",
        )
    if not llm.available():
        return _outcome(
            "skipped",
            "No model API key is configured, so the parts of this design no standard covers "
            "could not be worked out.",
        )

    standards = render_standards(clauses)
    budget = max(
        20_000,
        get_config().whole_document_max_tokens * whole_document.CHARS_PER_TOKEN - len(standards),
    )
    design, shortened = render_design(sections, budget)

    # Read several times and keep what most reads found; see `agree`.
    reads = max(1, get_config().coverage_reads)
    needed = reads // 2 + 1
    found = [
        check(
            llm.find_uncovered(design=design, standards=standards, title=whole.title),
            sections,
            whole,
            cited,
        )
        for _ in range(reads)
    ]
    checked = agree(found, needed)
    logs.info(
        log,
        "coverage worked out",
        runId=run["id"],
        reads=reads,
        needed=needed,
        eachRead=[len(read.gaps) for read in found],
        sections=len(sections),
        gaps=len(checked.gaps),
        suggestions=len(checked.suggestions),
        shortened=shortened,
        lineQuote=checked.corrected["lineQuote"],
        **checked.dropped,
    )
    return _outcome(
        "complete",
        None,
        reads=reads,
        sections=len(sections),
        truncated=shortened,
        gaps=checked.gaps,
        suggestions=checked.suggestions,
        dropped=checked.dropped,
        corrected=checked.corrected,
    )


def record(run: dict, clauses: list[dict]) -> dict:
    """Work out and store the run's coverage. Never raises."""
    try:
        result = work_out(run, clauses)
    except Exception as exc:  # noqa: BLE001 — a run's clauses stand without this
        logs.warn(log, "coverage could not be worked out", runId=run["id"], error=str(exc)[:300])
        why = (
            "the model provider's credits or quota are used up"
            if isinstance(exc, llm.QuotaExhausted)
            else "the model could not be reached or did not answer usably"
        )
        result = _outcome(
            "failed",
            f"The parts of this design no standard covers could not be worked out: {why}. "
            "Run the assessment again to retry.",
        )
    try:
        with db.connection() as conn:
            db.execute(
                conn,
                'UPDATE "assessment_run" SET "coverage" = %s WHERE "id" = %s',
                (Jsonb(result), run["id"]),
            )
    except Exception as exc:  # noqa: BLE001 — e.g. the column not migrated yet
        logs.warn(log, "coverage not recorded", runId=run["id"], error=str(exc)[:300])
    return result
