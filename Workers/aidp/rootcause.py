"""Which findings of a run come from one fact about the design.

A standard is a list of separate rules, so a design is judged against each of
them separately. That is right, and it is also why one mistake arrives as
several findings. On one real run of 61 clauses, twelve contradictions came
from five facts:

    5  one application reading another's database directly
    2  credentials kept in a configuration file
    2  a single undifferentiated code unit
    2  no monitoring, alerting or health checks
    1  synchronous point-to-point integration

The reviewer saw twelve problems and planned twelve pieces of work. Three of
those findings carried the same remediation sentence word for word.

So after the clauses are judged, the findings are read once more — this time
against each other — and the ones a single change would resolve together are
named as one cause.

**It groups; it does not merge.** Every finding keeps its clause reference, its
verdict, its evidence and its own review decision. A clause that was breached
has to stay answerable as that clause, because that is the question an audit
asks. The grouping is a lens over the findings, never a replacement for them,
and the report keeps both counts: how many clauses are breached, and how many
things there are to fix.

**It is a model's opinion, checked.** "These two come from the same cause" is a
judgement, not a string match, so a model makes it — and everything it says is
verified here before it is stored. A group naming a finding this run does not
have is dropped. A finding claimed by two groups stays in the first. A group of
one is not a group. Nothing here can change a verdict, because nothing here
writes to the findings at all.

Stored on the run as JSON (`assessment_run.rootCauses`), read by the app's
src/lib/ingest/root-causes.ts. Never fails a run: grouped findings are a
convenience and ungrouped ones are the normal case, so when this cannot be
worked out the report is exactly what it was before.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field

from psycopg.types.json import Jsonb

from . import db, logs
from .ai import llm

log = logs.get(__name__)

# Nothing to group under. `covered` and `not_applicable` are answers, not work,
# and a cause shared by two clauses the design already satisfies is not a thing
# a reviewer needs.
_WORK = ("contradicts", "absent", "partial", "not_assessable", "needs_review")

# A group of one is the finding itself, said twice.
_MIN_MEMBERS = 2

# Enough to read the findings as a list; past this the input is a different
# problem, and the whole point is to shorten a report rather than to summarise
# an enormous one badly.
_MAX_FINDINGS = 120

# Caps, so one long label cannot break the row it is drawn in. The prompt asks
# for shorter than this; these are what the engine enforces.
_MAX_LABEL = 80
_MAX_SENTENCE = 240

# Each finding's rationale, trimmed for the prompt. The whole rationale is
# rarely needed to tell what caused it, and sixty of them at full length is a
# large call for a small answer.
_RATIONALE_IN_PROMPT = 300


@dataclass
class Grouped:
    """What the grouping pass concluded, and what it threw away doing it."""

    groups: list[dict] = field(default_factory=list)
    # Counted rather than logged one by one: the numbers say whether the model
    # is being sloppy, and a run with many refusals is worth looking at.
    dropped: dict[str, int] = field(
        default_factory=lambda: {"unknown_finding": 0, "already_grouped": 0, "too_small": 0}
    )
    state: str = "complete"
    note: str | None = None

    def as_json(self) -> dict:
        return {
            "version": 1,
            "state": self.state,
            "note": self.note,
            "groups": self.groups,
            "dropped": self.dropped,
        }


_FINDINGS = """
SELECT f."id", f."clauseRef", f."clauseTitle", f."verdict", f."rationale"
  FROM "finding" f
 WHERE f."runId" = %(run)s
   AND f."verdict" = ANY(%(verdicts)s)
 ORDER BY f."clauseRef"
"""


def _render(rows: list[dict]) -> str:
    """The findings as a numbered list, which is what the model answers against.

    Indices rather than database ids: an id is thirty characters of noise in a
    prompt, costs tokens on every line, and invites the model to copy one
    wrongly. A number it cannot misread maps back here.
    """
    lines = []
    for index, row in enumerate(rows, start=1):
        rationale = " ".join(str(row["rationale"] or "").split())[:_RATIONALE_IN_PROMPT]
        lines.append(
            f"[{index}] {row['verdict']} — {row['clauseTitle'] or row['clauseRef']}\n"
            f"     {rationale}"
        )
    return "\n".join(lines)


def _clean(raw: dict, rows: list[dict]) -> Grouped:
    """The model's answer, kept only where it refers to findings this run has.

    Every rule here exists because the alternative is a reviewer being shown a
    grouping that is not true of their report — which is worse than no grouping
    at all, because it is invisible. A finding quietly filed under the wrong
    cause is a finding they will not read.
    """
    out = Grouped()
    taken: set[int] = set()

    for item in raw.get("groups") or []:
        if not isinstance(item, dict):
            continue

        members: list[int] = []
        for value in item.get("findings") or []:
            try:
                index = int(value)
            except (TypeError, ValueError):
                out.dropped["unknown_finding"] += 1
                continue
            if not 1 <= index <= len(rows):
                # A number for a finding that is not in this run. The model has
                # invented a member; the group may still be sound without it.
                out.dropped["unknown_finding"] += 1
                continue
            if index in taken:
                # Claimed by an earlier group. One cause per finding, and the
                # first claim wins rather than the last, so the order the model
                # chose is the order kept.
                out.dropped["already_grouped"] += 1
                continue
            members.append(index)

        # Deduplicate within the group too: the same index listed twice is one
        # member, not two, and would otherwise inflate the count on screen.
        members = list(dict.fromkeys(members))

        label = " ".join(str(item.get("label") or "").split())[:_MAX_LABEL]
        if len(members) < _MIN_MEMBERS or not label:
            out.dropped["too_small"] += 1
            continue

        taken.update(members)
        out.groups.append(
            {
                "label": label,
                "summary": " ".join(str(item.get("summary") or "").split())[:_MAX_SENTENCE],
                "fix": " ".join(str(item.get("fix") or "").split())[:_MAX_SENTENCE],
                "findings": [rows[index - 1]["id"] for index in members],
            }
        )

    return out


def record(run: dict) -> dict:
    """Group this run's findings, and store the result on the run.

    Never raises. A report without groups is the report as it has always been.
    """
    run_id = run["id"]
    result = Grouped().as_json()
    try:
        with db.connection() as conn:
            rows = db.query(conn, _FINDINGS, {"run": run_id, "verdicts": list(_WORK)})

        if len(rows) < _MIN_MEMBERS:
            result = Grouped(
                state="skipped", note="Too few findings to have a shared cause."
            ).as_json()
        elif len(rows) > _MAX_FINDINGS:
            result = Grouped(
                state="skipped",
                note=f"{len(rows)} findings is more than this reads in one pass.",
            ).as_json()
        else:
            raw = llm.group_findings(findings=_render(rows))
            grouped = _clean(raw, rows)
            result = grouped.as_json()
            logs.info(
                log,
                "findings grouped",
                runId=run_id,
                findings=len(rows),
                groups=len(grouped.groups),
                covered=sum(len(g["findings"]) for g in grouped.groups),
                **grouped.dropped,
            )
    except Exception as exc:  # noqa: BLE001 — a report without groups is still a report
        logs.warn(log, "findings not grouped", runId=run_id, error=str(exc)[:300])
        result = Grouped(state="failed", note="The findings could not be grouped.").as_json()

    try:
        with db.connection() as conn:
            db.execute(
                conn,
                'UPDATE "assessment_run" SET "rootCauses" = %s WHERE "id" = %s',
                (Jsonb(result), run_id),
            )
    except Exception as exc:  # noqa: BLE001 — e.g. the column not migrated yet
        logs.warn(log, "root causes not recorded", runId=run_id, error=str(exc)[:300])
    return result


def describe(result: dict) -> str:
    """One line for a log or a smoke test."""
    groups = result.get("groups") or []
    return json.dumps(
        {"state": result.get("state"), "groups": len(groups),
         "findings": sum(len(g.get("findings") or []) for g in groups)}
    )
