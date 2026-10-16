"""Advice has to fit the system in front of it, and a fix has to answer its gap.

Two live complaints, both about the engine reasoning about some other system
than the one it was given.

1. **A 2014 monolith told to add dead-letter queues.** The review checklist in
   `_ADVICE_SYSTEM` named dead-letter queues, back-pressure and distributed
   tracing as examples of what to look for, so the model reached for them on a
   Tomcat/Oracle application that has nowhere to put any of them. A reviewer
   reads that and concludes the tool did not understand their architecture,
   which is worse than no advice.

2. **A gap about a missing certification "fixed" by describing MVC patterns.**
   The two halves of the finding were about different things, so the
   remediation resolved nothing.

What is asserted here is the prompt, not the model: there is no model in this
suite, and the instruction being absent is what regressed. Prompt text is a
weak guarantee — only a live run shows obedience — but it is the guarantee that
can be held in place automatically, and a rule deleted from the prompt is
exactly how this came back the first time.

    docker run --rm -v "$PWD":/w -w /w -e STAGE=analyse \\
      -e DATABASE_URL=postgresql://nobody@127.0.0.1:1/none \\
      --entrypoint python aidp-worker-test tests/test_proportionate_advice.py
"""

from __future__ import annotations

import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from aidp import advice  # noqa: E402
from aidp.ai import llm  # noqa: E402

passed = failed = 0


def ok(name: str, condition: bool, extra: object = "") -> None:
    global passed, failed
    if condition:
        passed += 1
        print(f"  ok   {name}")
    else:
        failed += 1
        print(f"  FAIL {name} {extra}")


# A 2010-era monolith, as the client's document describes one: one deployable,
# one relational database, synchronous HTTP, no broker anywhere.
MONOLITH = """\
=== S1: 1 Overview (page 1) ===
The Policy Management System is a Java web application deployed as a single WAR
on Apache Tomcat 7, fronted by an F5 load balancer, with an Oracle 11g database.
Users reach it over HTTPS from the corporate network. There is no message broker
and no asynchronous processing; every request is served in-process.

=== S2: 2 Deployment (page 4) ===
Two Tomcat instances run active-passive behind the load balancer. Nightly batch
jobs run on the same hosts via cron and write to the same Oracle schema.
"""

ADVICE_PROMPT = llm._advice_system(design=MONOLITH, findings="None reported.", title="PMS")


# ---------------------------------------------------------------------------
print("\n1. The prompt reads the stack before it reviews anything")

ok(
    "the model is told to identify the kind of system first",
    "Before any of this, read what kind of system this is" in ADVICE_PROMPT,
)
ok(
    "and that the era decides which questions apply",
    "era" in ADVICE_PROMPT and "topology" in ADVICE_PROMPT,
)
ok(
    "the checklist is explicitly a menu, not a list to answer in full",
    "taking only the items that" in ADVICE_PROMPT,
)
ok(
    "a monolith is named as its own failure profile",
    "monolith" in ADVICE_PROMPT.lower(),
)


# ---------------------------------------------------------------------------
print("\n2. Distributed mechanisms are forbidden on a non-distributed design")

# Each of these was either in the client's bad output or is the same mistake
# wearing another name.
FORBIDDEN = (
    "dead-letter queue",
    "back-pressure",
    "distributed tracing",
    "service mesh",
    "circuit breaker",
    "event sourcing",
    "sidecar",
    "saga",
)
low = ADVICE_PROMPT.lower()
missing = [term for term in FORBIDDEN if term not in low]
ok("every one of them is named as off-limits by default", not missing, missing)

ok(
    "with the reason: they presuppose independent services",
    "independently deployed services" in ADVICE_PROMPT,
)
ok(
    "and the escape hatch is the document's own words",
    "or states a scaling requirement that demands it" in ADVICE_PROMPT,
)
ok(
    "a monolith is said to have nowhere to put them",
    "has nowhere to put them" in ADVICE_PROMPT,
)
ok(
    "the reviewer's reading of such advice is spelled out",
    "not having understood theirs" in ADVICE_PROMPT,
)


# ---------------------------------------------------------------------------
print("\n3. What a legacy stack IS reviewed on")

# The point is not only a ban. Without naming the alternative the model has
# nothing to say about a monolith at all, and silence is its own failure.
FOR_LEGACY = (
    "connection pool",
    "transaction boundaries",
    "session replication",
    "index",
    "standby",
    "backup restore",
)
absent = [term for term in FOR_LEGACY if term not in low]
ok("the prompt names what to review on an older stack instead", not absent, absent)
ok(
    "framed as what its owner can act on",
    "act on this quarter" in ADVICE_PROMPT,
)
ok(
    "and a service mesh is named as the wrong answer",
    "adopt a service mesh is not a review" in ADVICE_PROMPT,
)


# ---------------------------------------------------------------------------
print("\n4. A fix has to resolve its own gap")

ok(
    "the reasoning block pairs gap with fix",
    "GAP AND FIX MUST MATCH" in ADVICE_PROMPT,
)
ok(
    "a missing record is fixed by obtaining the record",
    "obtain or produce that record" in ADVICE_PROMPT,
)
ok(
    "never by describing the architecture",
    "never a description of the technical architecture" in ADVICE_PROMPT,
)
ok(
    "a technical gap is fixed on the component it names",
    "not to a different one" in ADVICE_PROMPT,
)
ok(
    "the client's own bad pairing is named as the thing to catch",
    "certification answered by a fix about MVC" in ADVICE_PROMPT,
)
ok(
    "and such a suggestion is dropped rather than shipped",
    "drop that suggestion or rewrite" in ADVICE_PROMPT,
)

# Both judges reason the same way, because a finding's rationale carries the
# same gap/fix pair the advice does.
for name, prompt in (
    (
        "retrieval judge",
        llm._JUDGE_PROMPT.format(
            scope_rule="",
            document_context="",
            reference="Security Standards - 5.2",
            clause="Audit logs shall be retained.",
            extracts='<extract id="c1">Logs are written to disk.</extract>',
            precedents="",
        ),
    ),
    ("whole-document judge", llm._DOCUMENT_JUDGE_SYSTEM.format(document=MONOLITH)),
):
    ok(f"{name}: asks whether the fix answers the gap", "DOES THE" in prompt and "GAP" in prompt)
    # Matched on words, not on the wrapped line: the prompts are hard-wrapped
    # and "MVC patterns" straddles a newline in one of them.
    squashed = " ".join(prompt.split())
    ok(f"{name}: names the MVC mismatch", "a fix about MVC patterns" in squashed)


# ---------------------------------------------------------------------------
print("\n5. Nothing that already worked was dropped")

ok("suggestions are still anchored to a named component", "copied exactly as the design" in ADVICE_PROMPT)
ok("quotes are still checked against the design", "word for word" in ADVICE_PROMPT)
ok("generic advice is still refused", "fit any design" in ADVICE_PROMPT)
ok(
    "the principal-architect register survives",
    "principal enterprise architect" in ADVICE_PROMPT,
)
ok("and the lifecycle facts still reach it", "{lifecycle}" not in ADVICE_PROMPT)

# The cache key covers the prompt, so this rewrite retires stored advice on its
# own rather than serving pre-change suggestions for 90 days.
ok(
    "the prompt identity carries the new wording",
    "nowhere to put them" in llm.advice_prompt_identity(),
)

# And the check that keeps a suggestion honest is untouched.
ok("advice.check is still the gate", callable(advice.check))


print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
