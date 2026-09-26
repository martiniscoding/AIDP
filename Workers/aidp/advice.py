"""Improvements to a design, suggested after it has been assessed.

An assessment answers, clause by clause, whether a design meets the
organisation's standards, and coverage answers what those standards do not reach.
Neither says what an experienced reviewer would still ask for — a single database
with no replica, backups on the same array as the data they protect, retries with
no limit. So after the clauses and the coverage, a model reads the whole design
beside the findings that did not pass, and suggests improvements to the design
itself.

A suggestion is advice, not a verdict, and it keeps to the same discipline as the
rest of the pipeline so that it can sit in a compliance report without passing
for one:

- **Anchored to the design.** Every suggestion names a section of this design by
  number, and the component it concerns — a technology, interface or flow —
  exactly as the design names it. A component the design never mentions drops
  the suggestion: advice that cannot be tied to something in this design would
  fit any design, and a reviewer has no use for it. A component mentioned only
  in another section is placed by the suggestion's quote, or moved to the one
  section that mentions it; mentioned in several and quoted in none, it cannot
  be placed, and is dropped.
- **A change quotes what it would change.** An "improve" must quote the design's
  own words, found word for word and inside the section it names (coverage.py's
  check). A quote that does not check out is how an invented problem would reach
  a report, so the suggestion goes with it. An "add" — something the design is
  missing — says what is absent, which no quote can show; its quote only points
  at where, so one that does not check out is left off and the suggestion kept.
- **Not the findings again.** The findings that did not pass are shown to the
  model as already reported, so a suggestion goes beyond them. A clause
  reference is kept only when a finding in this run carries it and did not pass.
- **No claim that needs today's date.** The model has no internet access here.
  It is told not to say that a version is out of support or vulnerable — those
  facts change after its training — and to ask for the status to be confirmed.
- **Apart from the verdicts.** Made in its own call once every clause is judged,
  so wanting to be helpful never softens a verdict.

- **The same design gets the same suggestions.** Asked again about an unchanged
  design against unchanged standards, it reuses the suggestions it made before,
  for up to `ADVICE_CACHE_DAYS` (90 by default), rather than drawing a new set
  from the same inputs: advice that changes every time the report is run is not
  advice a reviewer can act on. The key (`cache.advice_key`) is the design's
  text, the clause set, the model and the exact prompt, so a changed design, a
  changed standard, a new model or reworded instructions each miss. The findings
  are left out of it on purpose — verdicts drift between runs of one design (two
  runs of the same document have come back 9 absent and 4 needing review, then 7
  and 7), and a key that held them would miss on exactly the repeat it is for.
  What the findings decide is re-decided on every reuse instead: what is stored
  is the model's reply, not the checked list, so it goes through `check` again
  against this run — a clause reference is kept only if this run failed that
  clause, and every quote is found in the design again, word for word.
  A reviewer can ask for a fresh set, which skips the stored reply and replaces
  it; the report says which it is showing and when that was worked out.

Stored on the run as JSON (`assessment_run.advice`, read by the app's
src/lib/ingest/advice.ts). It never fails a run: the verdicts stand without it,
and the run says why it is missing.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field

from psycopg.types.json import Jsonb

from . import cache, coverage, db, logs, usage, whole_document
from .ai import llm
from .config import get_config
from .coverage import (
    MIN_SPECIFIC_WORDS,
    _checked_quote,
    _clean,
    _integer,
    _is_generic,
    _sentences,
)

log = logs.get(__name__)

VERSION = 1

# Kept from one reply, highest priority first. A reviewer handed forty
# suggestions reads none of them.
MAX_SUGGESTIONS = 15

# Findings shown to the model, worst first, one line each, as already reported:
# the report shows them, so a suggestion has to go beyond them.
MAX_FINDINGS = 60
FINDING_CHARS = 280

KINDS = ("improve", "add")
PRIORITIES = ("high", "medium", "low")
CATEGORIES = (
    "security",
    "resilience",
    "data",
    "integration",
    "operations",
    "performance",
    "cost",
    "maintainability",
    "documentation",
)

# Verdicts that did not pass, in the order a reviewer would fix them.
FAILING = ("contradicts", "absent", "partial", "needs_review")

# A suggestion is one change to one component. These caps are the prompt's own
# limits (280 and 200) with a little room, so a reply a shade over them is
# trimmed rather than thrown away, and a reply far over is cut to a whole
# sentence instead of reaching a reviewer as three paragraphs.
MAX_RECOMMENDATION = 320
MAX_WHY = 220

# The filter and its word floor live beside the other text checks in
# coverage.py, because coverage applies them to its gaps and suggested standards
# too and cannot import this module.
MIN_RECOMMENDATION_WORDS = MIN_SPECIFIC_WORDS


# The design is rendered uncut for the cache key. The budget the model is given
# shrinks as the findings grow, and a key that moved with it would miss whenever
# a verdict changed — the one thing the key is built to ignore.
_UNCUT = 10**12


@dataclass
class Checked:
    suggestions: list[dict] = field(default_factory=list)
    dropped: dict[str, int] = field(
        default_factory=lambda: {
            "empty": 0,
            "unknownSection": 0,
            "unanchored": 0,
            "missingQuote": 0,
            "unverified": 0,
            "outsideSection": 0,
            "generic": 0,
            "duplicate": 0,
            "overLimit": 0,
        }
    )


def _label(row: dict) -> str:
    ref = _clean(row.get("clauseRef"), 160)
    title = _clean(row.get("clauseTitle"), 160)
    if ref:
        return f"[{ref}] {title}".rstrip()
    return title or "(unnamed clause)"


def render_findings(rows: list[dict]) -> str:
    """The run's findings that did not pass, one line each, worst first.

    The clause reference is in square brackets, so a suggestion can give it back
    on its own; see `_clause_refs`.
    """
    ordered = sorted(
        (row for row in rows if row.get("verdict") in FAILING),
        key=lambda row: (FAILING.index(row["verdict"]), str(row.get("clauseRef") or "")),
    )
    lines: list[str] = []
    for row in ordered[:MAX_FINDINGS]:
        why = _clean(row.get("rationale"), FINDING_CHARS)
        lines.append(f"- {_label(row)} — {row['verdict']}" + (f": {why}" if why else ""))
    if not lines:
        return "(none: every clause this design was assessed against passed)"
    if len(ordered) > len(lines):
        lines.append(f"- ... and {len(ordered) - len(lines)} more not shown")
    return "\n".join(lines)


def _key(value: str) -> str:
    """Words only, case folded: "API  Gateway," and "api gateway" are one name."""
    return " ".join(re.findall(r"\w+", value.casefold()))


def _names(text: str, component: str) -> bool:
    """Whether the text mentions the component, as whole words."""
    wanted = _key(component)
    return bool(wanted) and f" {wanted} " in f" {_key(text)} "


def _clause_refs(failing: list[dict]) -> dict[str, str]:
    """How a model may give back a failing finding's reference, to the reference.

    The bare reference, the reference with its title, or either in brackets —
    all of them name the same finding, and none of them may name another.
    """
    refs: dict[str, str] = {}
    for row in failing:
        ref = _clean(row.get("clauseRef"), 300)
        if not ref:
            continue
        title = _clean(row.get("clauseTitle"), 160)
        for spelling in (ref, f"[{ref}]", f"{ref} {title}", _label(row), f"{ref} — {title}"):
            refs.setdefault(" ".join(spelling.split()).casefold(), ref)
    return refs


def _clause_ref(value, refs: dict[str, str]) -> str | None:
    spelled = " ".join(str(value or "").split()).casefold()
    if not spelled:
        return None
    if spelled in refs:
        return refs[spelled]
    # "[8.2] Secure Disposal", "8.2 — Secure Disposal", "8.2 (Secure Disposal)"
    head = re.split(r"\s+[—–-]\s+|\s*\(|\]\s*", spelled.lstrip("["), maxsplit=1)[0]
    return refs.get(head.strip())


def _named(text: str, component: str) -> list[str]:
    """The names in a component that the text mentions, as whole words.

    A model sometimes gives several names for one suggestion ("MySQL and Pivotal
    Cloud Cache"). Each counts on its own, and only those the text mentions are
    kept, so nothing shown as a component is a name the design does not use.
    """
    if _names(text, component):
        return [component]
    parts: list[str] = []
    for part in re.split(r",|;|/|\s+and\s+|\s+&\s+", component):
        part = part.strip()
        if part and part != component and part not in parts and _names(text, part):
            parts.append(part)
    return parts


def check(
    raw: dict,
    sections: list[coverage.Section],
    whole: whole_document.WholeDocument,
    failing: list[dict],
) -> Checked:
    """Keep the suggestions the design bears out; count the rest."""
    by_ordinal = {section.ordinal: section for section in sections}
    refs = _clause_refs(failing)
    out = Checked()
    titles: set[str] = set()
    kept: list[dict] = []

    items = raw.get("suggestions") if isinstance(raw.get("suggestions"), list) else []
    for item in items:
        if not isinstance(item, dict):
            continue
        title = _clean(item.get("title"), 160)
        recommendation = _sentences(item.get("recommendation"), MAX_RECOMMENDATION)
        if not title or not recommendation:
            out.dropped["empty"] += 1
            continue
        if _is_generic(recommendation):
            logs.warn(
                log, "suggestion refused as generic", title=title, recommendation=recommendation
            )
            out.dropped["generic"] += 1
            continue
        ordinal = _integer(item.get("section"))
        section = by_ordinal.get(ordinal) if ordinal is not None else None
        if section is None:
            out.dropped["unknownSection"] += 1
            continue

        component = _clean(item.get("component"), 200)
        named = _named(section.text, component)
        homes = [] if named else [other for other in sections if _named(other.text, component)]
        if not named and not homes:
            out.dropped["unanchored"] += 1
            continue

        kind = item.get("kind") if item.get("kind") in KINDS else "improve"
        quote: str | None = None
        page: int | None = None
        if " ".join(str(item.get("quote") or "").split()):
            quote, page, reason = _checked_quote(item, section, whole)
            if quote is None:
                logs.warn(
                    log,
                    "suggestion quote refused",
                    section=section.ordinal,
                    kind=kind,
                    reason=reason,
                    quote=str(item.get("quote") or "")[:300],
                )
                # Whatever the kind. An "add" used to keep its place with the
                # quote dropped, which left a suggestion standing on words the
                # design does not contain — the reviewer saw no quote and no
                # sign that one had been refused.
                out.dropped[reason] += 1
                continue
        elif kind == "improve":
            # A change to what the design says, without showing where it says it.
            out.dropped["missingQuote"] += 1
            continue

        if not named:
            if quote is None:
                if len(homes) != 1:
                    # Mentioned in several sections and quoted from none: no way
                    # to say which part of the design this is about.
                    out.dropped["unanchored"] += 1
                    continue
                section = homes[0]
            named = _named(homes[0].text, component)

        key = whole_document.normalise(title)
        if key in titles:
            out.dropped["duplicate"] += 1
            continue
        titles.add(key)

        clauses: list[str] = []
        offered = item.get("clauses") if isinstance(item.get("clauses"), list) else []
        for value in offered:
            ref = _clause_ref(value, refs)
            if ref and ref not in clauses:
                clauses.append(ref)

        pages = sorted(section.pages)
        category = item.get("category")
        priority = item.get("priority")
        kept.append(
            {
                "title": title,
                "kind": kind,
                "category": category if category in CATEGORIES else "other",
                "priority": priority if priority in PRIORITIES else "medium",
                "section": section.ordinal,
                "component": ", ".join(named),
                "sectionTitle": section.title[:300],
                "headingPath": section.heading_path[:1000],
                "pageStart": pages[0] if pages else section.page_start,
                "pageEnd": pages[-1] if pages else section.page_end,
                "quote": quote[:1500] if quote else None,
                "page": page,
                "recommendation": recommendation,
                "why": _sentences(item.get("why"), MAX_WHY),
                "clauses": clauses,
            }
        )

    # Highest priority first; the model's own order holds within a priority.
    kept.sort(key=lambda suggestion: PRIORITIES.index(suggestion["priority"]))
    out.suggestions = kept[:MAX_SUGGESTIONS]
    out.dropped["overLimit"] = max(0, len(kept) - MAX_SUGGESTIONS)
    return out


def _failing(conn, run_id: str) -> list[dict]:
    return db.query(
        conn,
        'SELECT "clauseRef", "clauseTitle", "verdict", "rationale" FROM "finding" '
        'WHERE "runId" = %s AND "verdict" = ANY(%s)',
        (run_id, list(FAILING)),
    )


def _standards(conn, framework_id: str) -> str:
    """The clause set a run was assessed against, as one string for the cache key.

    Ordered by id, so the same set always reads the same whatever order the
    library lists it in. A clause added, removed or reworded changes it.
    """
    rows = db.query(
        conn,
        """
        SELECT cl."id", cl."title", cl."statement", cl."requirements"
          FROM "framework_document" fd
          JOIN "document_section" s ON s."documentId" = fd."documentId"
          JOIN "clause" cl          ON cl."sectionId" = s."id"
         WHERE fd."frameworkId" = %s
         ORDER BY cl."id"
        """,
        (framework_id,),
    )
    return "\n".join(
        "\x1f".join(
            (
                str(row["id"]),
                str(row.get("title") or ""),
                str(row.get("statement") or ""),
                json.dumps(row.get("requirements"), sort_keys=True, default=str),
            )
        )
        for row in rows
    )


def _read_standards(run: dict) -> str | None:
    """`_standards` for this run, or None when it cannot be read.

    None turns reuse off for the run rather than keying without the standards:
    a key missing one of its inputs would hand back advice built against a
    library that has since changed.
    """
    if not run.get("organisationId") or not run.get("frameworkId"):
        return None
    try:
        with db.connection() as conn:
            return _standards(conn, run["frameworkId"])
    except Exception as exc:  # noqa: BLE001 — reuse is an optimisation, never a failure
        logs.warn(log, "standards not read for reuse", runId=run.get("id"), error=str(exc)[:200])
        return None


def _outcome(state: str, note: str | None, **rest) -> dict:
    generated = rest.get("generated_at")
    return {
        "version": VERSION,
        "state": state,
        "note": note,
        "checkedAt": db.now().isoformat(),
        "model": llm.model_name()[1],
        "sections": rest.get("sections", 0),
        "truncated": rest.get("truncated", False),
        "suggestions": rest.get("suggestions", []),
        "dropped": rest.get("dropped", {}),
        # "model" when the reply was asked for on this run, "cache" when it was
        # reused; `generatedAt` is when the model wrote it, either way. The
        # report shows both, so reused advice never passes for new.
        "source": rest.get("source", "model"),
        "generatedAt": generated.isoformat() if generated else None,
        "refreshing": False,
    }


def work_out(run: dict, *, fresh: bool = False) -> dict:
    """The improvements suggested for one run's design, ready to store.

    Reuses the reply stored for the same design, standards, model and prompt
    unless `fresh` is set, in which case the model is asked again and its answer
    replaces the stored one. Raises on a model failure; `record` turns that into
    a stated reason.
    """
    cfg = get_config()
    if not cfg.improvement_suggestions:
        return _outcome(
            "skipped",
            "Improvement suggestions are turned off in this deployment "
            "(IMPROVEMENT_SUGGESTIONS=off).",
        )

    with db.connection() as conn:
        sections, whole = coverage._load(conn, run["documentId"])
        failing = _failing(conn, run["id"])

    if whole is None or not sections:
        return _outcome(
            "skipped",
            "This design was processed before its pages were stored, so improvements could not "
            "be suggested. Reprocess it, then run the assessment again.",
        )
    if not llm.available():
        return _outcome(
            "skipped",
            "No model API key is configured, so improvements to this design could not be "
            "suggested.",
        )

    findings = render_findings(failing)
    budget = max(
        20_000,
        cfg.whole_document_max_tokens * whole_document.CHARS_PER_TOKEN - len(findings),
    )
    design, shortened = coverage.render_design(sections, budget)

    organisation = run.get("organisationId")
    provider, model = llm.model_name()
    key: str | None = None
    if cfg.advice_cache_days > 0:
        standards = _read_standards(run)
        if standards is not None:
            key = cache.advice_key(
                design=coverage.render_design(sections, _UNCUT)[0],
                title=whole.title,
                standards=standards,
                provider=provider,
                model=model,
                prompt=llm.advice_prompt_identity(),
                version=VERSION,
            )

    stored = (
        cache.get_payload(organisation, cache.ADVICE, key, max_age_days=cfg.advice_cache_days)
        if key and not fresh
        else None
    )
    reply = stored.payload.get("raw") if stored else None
    if isinstance(reply, dict):
        raw, source, generated_at = reply, "cache", stored.created_at
        logs.info(
            log,
            "suggestions reused",
            runId=run["id"],
            generatedAt=generated_at.isoformat(),
            hits=stored.hits,
        )
    else:
        raw = llm.suggest_improvements(design=design, findings=findings, title=whole.title)
        # To the millisecond, as the cache column keeps it, so a set reused later
        # reports exactly the time this one does.
        now = db.now()
        source, generated_at = "model", now.replace(microsecond=now.microsecond // 1000 * 1000)
        if key:
            cache.put_payload(
                organisation,
                cache.ADVICE,
                key,
                model=model,
                payload={"raw": raw},
                # An estimate: the provider's own count is recorded in token_usage
                # against the run, and is not threaded back to here.
                cost_tokens=usage.estimate_tokens(design + findings)
                + usage.estimate_tokens(json.dumps(raw)),
                created_at=generated_at,
            )

    checked = check(raw, sections, whole, failing)
    logs.info(
        log,
        "improvements suggested",
        runId=run["id"],
        source=source,
        fresh=fresh,
        sections=len(sections),
        suggestions=len(checked.suggestions),
        shortened=shortened,
        **checked.dropped,
    )
    return _outcome(
        "complete",
        None,
        sections=len(sections),
        truncated=shortened,
        suggestions=checked.suggestions,
        dropped=checked.dropped,
        source=source,
        generated_at=generated_at,
    )


def record(run: dict, *, fresh: bool = False) -> dict:
    """Suggest and store improvements for the run's design. Never raises.

    A fresh set that could not be worked out does not wipe the one already on
    the report: that stays, with the reason the new attempt failed beside it.
    """
    why: str | None = None
    try:
        result = work_out(run, fresh=fresh)
    except Exception as exc:  # noqa: BLE001 — a run's verdicts stand without this
        logs.warn(log, "improvements could not be suggested", runId=run["id"], error=str(exc)[:300])
        why = (
            "the model provider's credits or quota are used up"
            if isinstance(exc, llm.QuotaExhausted)
            else "the model could not be reached or did not answer usably"
        )
        result = _outcome(
            "failed",
            f"Improvements to this design could not be suggested: {why}. "
            "Run the assessment again to retry.",
        )
    previous = run.get("advice")
    if (
        fresh
        and result["state"] != "complete"
        and isinstance(previous, dict)
        and previous.get("state") == "complete"
    ):
        result = {
            **previous,
            "refreshing": False,
            "refreshError": (
                f"A new set could not be worked out: {why}." if why else result["note"]
            ),
        }
    try:
        with db.connection() as conn:
            db.execute(
                conn,
                'UPDATE "assessment_run" SET "advice" = %s WHERE "id" = %s',
                (Jsonb(result), run["id"]),
            )
    except Exception as exc:  # noqa: BLE001 — e.g. the column not migrated yet
        logs.warn(log, "improvements not recorded", runId=run["id"], error=str(exc)[:300])
    return result
