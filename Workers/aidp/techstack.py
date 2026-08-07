"""The customer's technology reference, as context for an assessment.

The third input alongside standards and standing decisions. A finding that says
"the design does not specify an encryption approach" is a checklist item; one
that adds "this organisation runs on Azure, where the expected control is Key
Vault-managed keys" is the consultancy the product is selling.

Read from `tech_assessment.summary`, which the app renders on every save. The
option catalog is TypeScript and the database stores ids — "synapse", "fabric" —
so only the app can turn those into labels. Keeping a second copy of that
catalog here would be a second thing to keep in step for no gain.

Scoped to the organisation, like everything else a run touches. Before this it
was keyed to the user, which put it out of reach: a run has an organisation and
never a user, so there was no answer to "whose stack applies here?" once two
consultants shared a customer.

**Context, never a rule.** The stack may sharpen a rationale or a
recommendation; it may not decide a verdict. Nothing here needs a guard of its
own to enforce that — a verdict of covered, partial or contradicts already has
to cite a passage in the submitted document, and `absent` already has to survive
the retrieval-strength check. A stack summary cites nothing and so can never
satisfy either. The prompt says so in words; the existing guards make it true.
"""

from __future__ import annotations

import psycopg

from . import db, logs

log = logs.get(__name__)

_SUMMARY = """
SELECT "summary"
  FROM "tech_assessment"
 WHERE "organisationId" = %(org)s
   AND "summary" <> ''
 LIMIT 1
"""

# The app caps what it writes; this is a backstop against a stale oversized row
# reaching a prompt that runs once per clause.
MAX_CHARS = 1500


def for_organisation(conn: psycopg.Connection, organisation_id: str) -> str:
    """The rendered reference, or an empty string when there is none.

    Empty is an ordinary outcome, not an error: plenty of customers will be
    assessed before anyone fills the form in, and an assessment without it is
    exactly what the product did until now.
    """
    row = db.one(conn, _SUMMARY, {"org": organisation_id})
    if not row:
        return ""

    summary = (row["summary"] or "").strip()
    if len(summary) > MAX_CHARS:
        summary = summary[:MAX_CHARS].rstrip() + "…"
    return summary


def render(summary: str) -> str:
    """The block as the model sees it, or nothing at all.

    An empty reference contributes no header. A line announcing that the stack
    is unknown would be tokens on every clause of every run, and would invite
    the model to remark on the absence in a rationale a reviewer then has to
    read past.
    """
    if not summary.strip():
        return ""
    return (
        "\n<technology_context>\n"
        "What this organisation runs. Background for interpreting the design and "
        "for making a recommendation concrete — never grounds for a verdict.\n"
        f"{summary.strip()}\n"
        "</technology_context>\n"
    )
