"""A contradiction may only quote the design in words the design used.

The report prints "what the design says" beside the clause it breaks. Until the
judge was asked which passage it convicted on, that panel took the first
retrieved passage per design — a guess, because retrieval ranks passages for
the judge to read, not for being the sentence that breaks the clause. Over one
project's fifteen contradictions the guess quoted a design the finding never
mentions in twenty of forty cases, and twice quoted a design's own remediation
plan ("P0: rotate credentials and move secrets into approved secret storage")
as though it were the breach.

The judge now names the extract and quotes it, and `_mark_conflict` verifies
that naming rather than trusting it. What matters most here is the rejections:
a quote that is nearly right would be printed inside quotation marks, attributed
to a customer's design, in a compliance record.

    docker run --rm -v "$PWD":/w -w /w -e PYTHONPATH=/w \\
      -e DATABASE_URL=postgresql://nobody@127.0.0.1:1/none \\
      --entrypoint python aidp-worker-test tests/test_conflict_quote.py
"""

from __future__ import annotations

import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from aidp.retrieval import Candidate  # noqa: E402
from aidp.stages.analyse import _mark_conflict  # noqa: E402

EXCERPT = ("Application and infrastructure decisions Area | Decision / current choice | "
           "Rationale or issue Application structure | One undifferentiated code unit | "
           "Modular design exception not documented or approved")

def setup():
    c = Candidate(chunk_id="c1", heading_path="4 Decisions", text=EXCERPT, page_start=1,
                  score=1.0, vector_rank=1, lexical_rank=1, source_kind="table",
                  source_id="t1", document_id="d1", document_title="RCLP")
    ev = [{"chunkId": "c1", "excerpt": EXCERPT}, {"chunkId": "c2", "excerpt": "other"}]
    return ev, {"c1": c}

cases, bad = [], 0

ev, by = setup()
_mark_conflict(ev, {"extract": "c1", "quote": "One undifferentiated code unit"}, by)
cases.append(
    ("a verbatim quote is marked", ev[0].get("conflictQuote") == "One undifferentiated code unit")
)

ev, by = setup()
_mark_conflict(ev, {"extract": "c1", "quote": "one   UNDIFFERENTIATED\ncode unit"}, by)
cases.append(
    ("whitespace and case differences still match", ev[0].get("conflictQuote") is not None)
)

ev, by = setup()
_mark_conflict(ev, {"extract": "c1", "quote": "a single undifferentiated code unit"}, by)
cases.append(("a near-miss paraphrase is rejected", ev[0].get("conflictQuote") is None))

ev, by = setup()
_mark_conflict(ev, {"extract": "nope", "quote": "One undifferentiated code unit"}, by)
cases.append(("an uncited extract is rejected", all("conflictQuote" not in e for e in ev)))

ev, by = setup()
_mark_conflict(ev, None, by)
cases.append(("a missing conflict is harmless", all("conflictQuote" not in e for e in ev)))

ev, by = setup()
_mark_conflict(ev, {"extract": "c1", "quote": ""}, by)
cases.append(("an empty quote is rejected", all("conflictQuote" not in e for e in ev)))

ev, by = setup()
_mark_conflict(ev, {"extract": "c1", "quote": "x" * 400 }, by)
cases.append(("a fabricated long quote is rejected", ev[0].get("conflictQuote") is None))

ev, by = setup()
_mark_conflict(ev, {"extract": "c1", "quote": EXCERPT}, by)
cases.append(("a whole-excerpt quote is capped", len(ev[0].get("conflictQuote") or "") <= 240))

ev, by = setup()
_mark_conflict(ev, "not a dict", by)
cases.append(("junk is harmless", all("conflictQuote" not in e for e in ev)))

# ---------------------------------------------------------------------------
# The schema must allow everything the prompt asks for.
#
# The prompt asked for "conflict" from the day the feature landed and not one
# reply carried it: `_VERDICT_SCHEMA` did not declare it, and strict mode
# allows only what the schema names. Fourteen of fourteen contradictions came
# back without one and the report went on guessing at the quote. The verdict
# enum had the same fault once — `not_assessable` and `not_applicable` were in
# the prompt and not in the enum, so the model could not answer them.
#
# Both are the same mistake, so this checks the rule rather than the instances:
# every key the reply template names is a property the schema allows.
from aidp.ai import llm  # noqa: E402

tail = llm._JUDGE_PROMPT.rindex("reply with JSON only")
template = llm._JUDGE_PROMPT[tail:]
asked = set(re.findall(r'"(\w+)"\s*:', template))
declared = set(llm._VERDICT_SCHEMA["properties"])
missing = sorted(asked - declared - {"extract", "quote"})
cases.append(
    (f"the schema declares every field the prompt asks for (missing: {missing})", not missing)
)

strict = llm._strict_schema(llm._VERDICT_SCHEMA)
cases.append(("strict mode keeps conflict", "conflict" in strict["properties"]))
cases.append((
    "and spells it nullable, since only a contradiction has one",
    "null" in strict["properties"]["conflict"]["type"],
))
cases.append((
    "every verdict the prompt offers is in the enum",
    set(llm._VERDICT_SCHEMA["properties"]["verdict"]["enum"])
    >= {"covered", "partial", "absent", "contradicts", "needs_review",
        "not_assessable", "not_applicable"},
))


for name, okk in cases:
    print(f"  {'ok  ' if okk else 'FAIL'} {name}")
    bad += 0 if okk else 1
print(f"\n{len(cases)-bad}/{len(cases)} passed")
raise SystemExit(1 if bad else 0)
