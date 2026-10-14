"""How strongly a clause binds, read from the standard rather than guessed.

The parser has always recorded whether each requirement is a must, a should or a
may. Nothing used it: the judge got a flat bullet list and severity was a
function of the verdict and the model's own confidence, so breaching an advisory
"may" and breaching a mandatory "shall" produced the same finding at the same
severity.

What this proves:

  · the parser's own strengths are used when they can be trusted, and are NOT
    used when the two lists it stores them across have fallen out of step —
    attaching one requirement's obligation to another's words would make a
    report call an advisory rule mandatory and cite the wrong sentence for it;
  · a modal verb in the clause's own words is read when the parser recorded
    nothing, and is labelled `read` rather than `parsed`, because it is an
    interpretation;
  · "may not" and "shall not" are prohibitions, not permissions;
  · a clause that establishes no obligation comes back `unstated`, and
    `unstated` never becomes `must`. This is the rule that keeps the engine from
    inventing mandatory language, which is the one thing section 4 of the brief
    forbids outright.

No database, no model, no fixtures — the module is deliberately dependency-free.

    python tests/test_obligations.py
"""

from __future__ import annotations

import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from aidp import obligations  # noqa: E402

passed = 0
failed = 0


def ok(name: str, condition: bool, extra: object = "") -> None:
    global passed, failed
    if condition:
        passed += 1
        print(f"  PASS {name}")
    else:
        failed += 1
        print(f"  FAIL {name}", extra)


print("\nThe parser's own strengths, when they line up")
clause = {
    "requirements": ["Records are retained", "Logs are archived"],
    "sourceRefs": {"requirements": [{"strength": "should"}, {"strength": "must"}]},
}
got = obligations.of(clause)
ok("the strongest requirement sets the clause's obligation", got.strength == "must", got)
ok("and it is reported as the standard's own", got.source == obligations.PARSED, got)
ok(
    "each requirement keeps its own strength for the prompt",
    obligations.per_requirement(clause) == [
        ("Records are retained", "should"),
        ("Logs are archived", "must"),
    ],
    obligations.per_requirement(clause),
)

print("\nAnd when they do not line up, they are not used")
# `requirements` drops any requirement whose text rendered empty; the refs list
# does not. One such clause is enough to put every strength on the wrong words.
skewed = {
    "requirements": ["Records are retained"],
    "sourceRefs": {"requirements": [{"strength": "may"}, {"strength": "must"}]},
    "statement": "Retention of records",
}
got = obligations.of(skewed)
ok("a mismatched count is refused rather than zipped", got.strength == obligations.UNSTATED, got)
ok(
    "and each requirement falls back to its own words, not to a neighbour's strength",
    obligations.per_requirement(skewed) == [("Records are retained", obligations.UNSTATED)],
    obligations.per_requirement(skewed),
)
ok(
    "a strength the parser never recorded is refused too",
    obligations.of(
        {"requirements": ["a"], "sourceRefs": {"requirements": [{"strength": ""}]}}
    ).strength
    == obligations.UNSTATED,
)

print("\nRead from the clause's own wording when the parser recorded nothing")
got = obligations.of({"requirements": ["Records shall be kept for seven years"]})
ok("a modal verb in a requirement is read", got.strength == "must", got)
ok("and labelled as read, not as the standard's structure", got.source == obligations.READ, got)
ok(
    "a statement carries the obligation when there are no requirements",
    obligations.of({"requirements": [], "statement": "Logs should be retained"}).strength
    == "should",
)
ok(
    "requirements outrank the statement, which only introduces the subject",
    obligations.of(
        {"statement": "Systems may be internet-facing", "requirements": ["Traffic shall be logged"]}
    ).strength
    == "must",
)

print("\nProhibitions are mandatory, not permissive")
for text in ("Data may not leave the region", "Keys shall not be shared", "Export is prohibited"):
    ok(f"“{text}” binds", obligations.of({"requirements": [text]}).strength == "must")

print("\nNothing invented")
ok(
    "a descriptive clause establishes no obligation",
    obligations.of({"statement": "Data retention", "requirements": ["Retention is described"]})
    == obligations.UNKNOWN,
)
ok(
    "an empty clause establishes no obligation",
    obligations.of({}) == obligations.UNKNOWN,
)
ok("unstated is not mandatory", not obligations.UNKNOWN.is_mandatory)
ok("unstated is not advisory either", not obligations.UNKNOWN.is_advisory)
ok("and it knows it does not know", not obligations.UNKNOWN.is_known)
# Word boundaries. These matter more than they look: a food manufacturer's
# standards really do discuss mustard, and "can" appears in every sentence about
# containers.
ok(
    "“mustard” is not a must",
    obligations.of({"requirements": ["Mustard supply is seasonal"]}) == obligations.UNKNOWN,
)
ok(
    "a sentence with no modal verb at all is unstated",
    obligations.of({"requirements": ["The platform runs on Kubernetes"]}) == obligations.UNKNOWN,
)

print("\nHow it describes itself")
ok(
    "a parsed must says only that",
    obligations.Obligation("must", obligations.PARSED).describe() == "must",
)
ok(
    "a read one admits how it was reached",
    "read from" in obligations.Obligation("must", obligations.READ).describe(),
)
ok(
    "and an unstated one says so in words a reviewer can act on",
    obligations.UNKNOWN.describe() == "obligation not stated in the standard",
)

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
