"""The designs one assessment run covers.

A run is over one design or over a whole project, and everything downstream —
retrieval, the absent re-read, coverage, advice, lifecycle — needs the same
answer to "which documents am I reading?". That answer lives here rather than
being derived from `run["documentId"]` in each of them, which is how the scope
came to be assumed in eight places.

A project run reads every *finished* design in the project. A design still
parsing has no chunks, so including it would put an empty document in scope and
let a clause it answers come back absent; it is left out and named in the run's
note instead, so the report says what it did not read.
"""

from __future__ import annotations

from dataclasses import dataclass

from . import db

# Designs, not standards. A project holds the work under review; the standards
# it is measured against are organisation-wide and reached through the
# framework.
_ROLE = "assessed"

# Everything before this and the document has no chunks to search.
_READY = "ready"


@dataclass(frozen=True)
class Design:
    document_id: str
    title: str


_OF_PROJECT = """
SELECT "id", "title", "status"
  FROM "document"
 WHERE "projectId" = %(project)s
   AND "organisationId" = %(org)s
   AND "role" = %(role)s
 ORDER BY "createdAt", "id"
"""


@dataclass(frozen=True)
class Scope:
    """What a run reads, and what it had to leave out."""

    designs: list[Design]
    # Titles of designs in the project that are not finished processing. Named
    # in the run's note so nobody reads the report as covering them.
    unready: list[str]

    @property
    def document_ids(self) -> list[str]:
        return [d.document_id for d in self.designs]

    @property
    def titles(self) -> dict[str, str]:
        return {d.document_id: d.title for d in self.designs}

    @property
    def is_project(self) -> bool:
        return len(self.designs) > 1 or bool(self.unready)


def for_run(conn, run: dict) -> Scope:
    """The designs this run assesses, in a stable order.

    Ordered by upload time so a project's designs are rendered, quoted and
    numbered the same way on every run — a report whose sections moved between
    runs of unchanged documents would be unreadable as a diff.
    """
    project_id = run.get("projectId")
    if not project_id:
        row = db.one(
            conn,
            'SELECT "id", "title" FROM "document" WHERE "id" = %s',
            (run["documentId"],),
        )
        if row is None:
            return Scope([], [])
        return Scope([Design(row["id"], row["title"] or "")], [])

    rows = db.query(
        conn,
        _OF_PROJECT,
        {"project": project_id, "org": run["organisationId"], "role": _ROLE},
    )
    designs = [Design(r["id"], r["title"] or "") for r in rows if r["status"] == _READY]
    unready = [r["title"] or r["id"] for r in rows if r["status"] != _READY]
    return Scope(designs, unready)


def describe(scope: Scope) -> str:
    """The designs in scope, as a line for a prompt or a log."""
    if not scope.designs:
        return "no designs"
    return ", ".join(f'"{d.title}"' if d.title else d.document_id for d in scope.designs)


def tag(outcome: dict, design: Design, *, keys: tuple[str, ...]) -> dict:
    """Name the design every item in an outcome came from.

    A project's coverage gap or suggested improvement is about one design, and
    the report has to say which — "section 4 is ungoverned" is not actionable
    when the project has four designs with a section 4. Written with setdefault
    so a reply that already named a design keeps what it said.
    """
    for key in keys:
        for item in outcome.get(key) or []:
            if isinstance(item, dict):
                item.setdefault("documentId", design.document_id)
                item.setdefault("documentTitle", design.title)
    return outcome


def _sum(outcomes: list[dict], key: str) -> dict:
    """One counter dict with every outcome's counts added up."""
    total: dict[str, int] = {}
    for outcome in outcomes:
        for name, value in (outcome.get(key) or {}).items():
            if isinstance(value, bool) or not isinstance(value, int):
                continue
            total[name] = total.get(name, 0) + value
    return total


def merge(
    outcomes: list[dict],
    *,
    items: tuple[str, ...],
    dedupe: dict[str, str] | None = None,
) -> dict:
    """Several designs' outcomes read as one, in the shape the report expects.

    The lists are concatenated in the designs' own order, the counters are added
    up, and everything else is taken from the first outcome — the version, the
    model and the timestamps are the same across a run by construction, since
    one run reads every design with one model.

    State is the most informative of the three: "complete" if any design was
    worked out, "failed" if none was and one failed, otherwise whatever the
    first said. A project where four designs' coverage was worked out and the
    fifth's model call failed has coverage, and the note says what is missing.

    `dedupe` keeps the first item per value of a field — technologies, where
    three designs naming PostgreSQL is one fact about the project, not three.
    """
    if not outcomes:
        return {}
    if len(outcomes) == 1:
        return outcomes[0]

    states = [str(o.get("state") or "") for o in outcomes]
    state = "complete" if "complete" in states else "failed" if "failed" in states else states[0]

    merged = dict(outcomes[0])
    merged["state"] = state
    seen_notes: list[str] = []
    for note in (str(o.get("note") or "").strip() for o in outcomes):
        if note and note not in seen_notes:
            seen_notes.append(note)
    merged["note"] = " ".join(seen_notes) or None

    for key in items:
        collected: list[dict] = []
        field = (dedupe or {}).get(key)
        seen: set[str] = set()
        for outcome in outcomes:
            for item in outcome.get(key) or []:
                if field and isinstance(item, dict):
                    mark = str(item.get(field) or "")
                    if mark and mark in seen:
                        continue
                    if mark:
                        seen.add(mark)
                collected.append(item)
        merged[key] = collected

    for key in ("dropped", "corrected"):
        if any(key in o for o in outcomes):
            merged[key] = _sum(outcomes, key)
    if any("sections" in o for o in outcomes):
        merged["sections"] = sum(int(o.get("sections") or 0) for o in outcomes)
    if any("truncated" in o for o in outcomes):
        merged["truncated"] = any(bool(o.get("truncated")) for o in outcomes)
    if any("reads" in o for o in outcomes):
        merged["reads"] = max(int(o.get("reads") or 1) for o in outcomes)
    # Reused only if every design's was. One fresh call makes the set new.
    if any("source" in o for o in outcomes):
        merged["source"] = (
            "cache" if all(o.get("source") == "cache" for o in outcomes) else "model"
        )
    if any("generatedAt" in o for o in outcomes):
        written = [str(o["generatedAt"]) for o in outcomes if o.get("generatedAt")]
        merged["generatedAt"] = max(written) if written else None
    return merged
