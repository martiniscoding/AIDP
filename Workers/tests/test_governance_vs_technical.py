"""A technical clause is judged on the design, not on who signed it.

A technical design document was marked `not_assessable` against a clause asking
for an architectural property, because it carried no approval waiver. The clause
had not asked for a waiver. Answering a question about encryption with a
complaint about paperwork tells a reviewer nothing about their architecture, and
it reads as the tool refusing to do the job.

The existing rule was half right and that is why this slipped through. "A
document that does not say is not a document that breaches" exists so a missing
page of paperwork does not reach a report looking like a real breach, and it
earns its place — it is the rule that stops a missing RTO outranking an actual
contradiction. What it never said is that it applies only when the clause is
*asking* for a record. So both judges now decide what the clause wants before
deciding which verdicts are even available.

One correction to the brief that prompted this, worth writing down: it asked for
`not_assessable` to be reserved for malformed or unreadable requirements, with
missing documentation going to `not_evidenced` instead. This engine has no
`not_evidenced` verdict — `not_assessable` *is* its "the document does not say",
and `needs_review` is its "a person has to read this". Renaming the categories
would mean a schema change, a migration and every stored finding reinterpreted.
The defect was never the name; it was using that verdict on clauses that asked
for architecture. That is what is fixed.

    docker run --rm -v "$PWD":/w -w /w -e STAGE=analyse \\
      -e DATABASE_URL=postgresql://nobody@127.0.0.1:1/none \\
      --entrypoint python aidp-worker-test tests/test_governance_vs_technical.py
"""

from __future__ import annotations

import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from aidp.ai import llm  # noqa: E402
from aidp.stages import analyse  # noqa: E402

passed = failed = 0


def ok(name: str, condition: bool, extra: object = "") -> None:
    global passed, failed
    if condition:
        passed += 1
        print(f"  ok   {name}")
    else:
        failed += 1
        print(f"  FAIL {name} {extra}")


def flat(text: str) -> str:
    """Hard-wrapped prompt text as one line, so assertions survive rewrapping."""
    return " ".join(text.split())


RETRIEVAL = flat(
    llm._JUDGE_PROMPT.format(
        scope_rule="",
        document_context="",
        reference="Security Standards - 5.2",
        clause="Data in transit shall be encrypted.",
        extracts='<extract id="c1">All traffic uses TLS 1.3.</extract>',
        precedents="",
    )
)
DOCUMENT = flat(llm._DOCUMENT_JUDGE_SYSTEM.format(document="=== S1 ===\nAll traffic uses TLS 1.3."))

JUDGES = (("retrieval judge", RETRIEVAL), ("whole-document judge", DOCUMENT))


# ---------------------------------------------------------------------------
print("\n1. The clause's own subject is settled first")

for name, prompt in JUDGES:
    ok(
        f"{name}: decides what the clause asks for before choosing a verdict",
        "decides which verdict" in prompt or "decides which verdicts are available" in prompt,
        name,
    )
    ok(
        f"{name}: names architectural properties as the technical case",
        "encryption in transit" in prompt and "least privilege" in prompt,
        name,
    )


# ---------------------------------------------------------------------------
print("\n2. A technical clause may not be answered with paperwork")

for name, prompt in JUDGES:
    ok(
        f"{name}: forbids not_assessable for a missing signature",
        "may NOT answer" in prompt and "not_assessable" in prompt,
        name,
    )
    ok(
        f"{name}: lists the records that are not an excuse",
        all(word in prompt for word in ("approval", "waiver", "sign-off")),
        name,
    )
    ok(
        f"{name}: says why — that is not what the clause asked",
        "not what the clause asked" in prompt,
        name,
    )
    ok(
        f"{name}: gives the worked case",
        "countersigned" in prompt,
        name,
    )
    ok(
        f"{name}: and says such an answer tells the reviewer nothing",
        "tells a reviewer nothing" in prompt or "tells the reviewer nothing" in prompt,
        name,
    )


# ---------------------------------------------------------------------------
print("\n3. The governance case is preserved, not removed")

for name, prompt in JUDGES:
    ok(
        f"{name}: not_assessable still covers a clause about a record",
        "whose OWN subject is a record" in prompt or "whose own subject is the record" in prompt,
        name,
    )
    ok(
        f"{name}: and still asks which record and who holds it",
        "who would hold it" in prompt,
        name,
    )
    ok(
        f"{name}: a named technology is still not an approved one",
        "not proof it was approved" in prompt,
        name,
    )

# The rule this was in danger of undoing: a missing record must never be
# reported as a breach. That is the whole reason not_assessable exists.
ok(
    "a missing record is still never 'contradicts'",
    'never "contradicts"' in RETRIEVAL and 'never "contradicts"' in DOCUMENT,
)


# ---------------------------------------------------------------------------
print("\n4. Severity never lets a paperwork gap outrank a breach")

# The engine's own rule, unchanged by any of this, and the reason the verdict is
# safe to keep: an evidence gap cannot reach Critical.
ok("not_assessable is a real verdict in this engine", "not_assessable" in analyse.VERDICTS)
ok("so is needs_review, for wording a person must read", "needs_review" in analyse.VERDICTS)
ok(
    "there is no not_evidenced verdict to send these to",
    "not_evidenced" not in analyse.VERDICTS,
)

# The reason this verdict is safe to keep at all: the engine states in its own
# verdict table that an evidence gap is never Critical, and the app honours that
# (src/lib/ingest/verdicts.ts maps it to moderate on a mandatory clause and
# check otherwise). Read off the source so deleting that promise fails here.
import inspect  # noqa: E402

VERDICT_TABLE = inspect.getsource(analyse)[: inspect.getsource(analyse).index("not_applicable")]
ok(
    "the verdict table still promises it is never Critical",
    "never Critical" in VERDICT_TABLE,
)


print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
