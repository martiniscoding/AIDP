"""The mega-clause, the self-contradicting finding, and the stranded hyphen.

All three came from one live run against a real 28-page architecture document
and a customer's `Standards v3`, and the database contents were reported
verbatim, which is what made them fixable.

1. **A whole standard stored as one clause.** Its title was the table's own
   column header — `# | Principle Name | Statement and Rationale | Implications`
   — and its requirement body held every row glued together: `#: 1 | Principle
   Name: … #: 2 | Principle Name: …`. The structured extractors never saw a
   table because by then there was none; the rows had been serialised into
   prose. So designs were measured against the entire standard as a single
   requirement, and because that one string mentioned "approved", the judge
   answered all of it as a governance question.

2. **A finding that argued against itself.** Verdict `not_assessable`, gap
   "nothing quoted records an approval, certification or waiver", and then a fix
   reading "The design uses service-oriented, client-server, MVC, and layered
   patterns appropriate for the system's business and operational needs,
   aligning with the clause's fit-for-purpose integration principle." The fix
   states compliance with the clause the verdict says was not met. Prompt rules
   already forbade both halves of this; a cheap model did it anyway, which is
   why the checks here are in Python and not in the prompt.

3. **`imple- mented`.** The PDF extraction is not at fault and this is worth
   recording, because the brief that reported it had the direction backwards:
   hyphens are preserved correctly on the way in — `service-oriented`,
   `client-server` and `model-view-controller` all survive extraction from the
   real file. What was wrong is the evidence excerpt, which collapsed a line
   break and left the hyphen stranded mid-word.

    docker run --rm -v "$PWD":/w -w /w -e STAGE=analyse \\
      -e DATABASE_URL=postgresql://nobody@127.0.0.1:1/none \\
      --entrypoint python aidp-worker-test tests/test_flattened_grid_and_gates.py
"""

from __future__ import annotations

import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from aidp import retrieval  # noqa: E402
from aidp.parsing import clauses as clause_parser  # noqa: E402
from aidp.parsing.sections import Section  # noqa: E402
from aidp.parsing.spans import Line  # noqa: E402
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


def line(text: str) -> Line:
    return Line(
        text=text, page=4, y=100.0, x0=72.0, bbox=(72.0, 100.0, 520.0, 112.0),
        sig=("Body", 11.0, False, False, 0),
    )


def section(title: str, body: str) -> Section:
    return Section(
        ordinal=1, number_text="3", title=title, depth=1,
        heading_path=f"Standards > {title}", page_start=4, page_end=5,
        lines=[line(title), line(body)],
    )


# The customer's row, as the database held it.
HEADER = "# | Principle Name | Statement and Rationale | Implications"
FLAT = (
    "#: 1 | Principle Name: Fit-for-Purpose Pattern Selection | Statement and Rationale: "
    "Architecture patterns must be selected to fit the business need. | Implications: "
    "Record the pattern choice. Alternatives must be assessed. "
    "#: 2 | Principle Name: Design for Reuse | Statement and Rationale: Components must be "
    "designed for reuse across solutions. | Implications: Shared components are registered. "
    "#: 3 | Principle Name: Approved Technology | Statement and Rationale: Only approved "
    "technologies shall be used in production. | Implications: An exception needs ARB sign-off."
)
MEGA = section(HEADER, FLAT)


# ---------------------------------------------------------------------------
print("\n1. The flattened grid becomes one clause per rule")

split = clause_parser.split_flattened_grid(MEGA)
ok("three records yield three clauses", len(split) == 3, len(split))
ok(
    "each is titled by its own row, not the column header",
    [c.title for c in split]
    == [
        "1 — Fit-for-Purpose Pattern Selection",
        "2 — Design for Reuse",
        "3 — Approved Technology",
    ],
    [c.title for c in split],
)
ok(
    "the rule's own words become the statement",
    any("fit the business need" in c.statement for c in split),
)
ok(
    "implications become requirements",
    any(len(c.requirements) == 2 for c in split),
    [(c.title, c.requirements) for c in split],
)
ok(
    "and the governance rule is now its own clause",
    any("Approved Technology" in (c.title or "") for c in split),
)

# The point of splitting: "approved" is confined to the clause it belongs to
# instead of colouring the whole standard.
approved = [c for c in split if "Approved" in (c.title or "")]
others = [c for c in split if "Approved" not in (c.title or "")]
ok(
    "the word 'approved' no longer appears in the other clauses",
    all("approved" not in (c.statement or "").lower() for c in others),
    [c.statement[:40] for c in others],
)
ok("and it does appear in its own", approved and "approved" in approved[0].statement.lower())


# ---------------------------------------------------------------------------
print("\n2. A column header is never a clause title")

ok("the header row is recognised", clause_parser.is_header_row(HEADER))
ok(
    "a real rule is not mistaken for one",
    not clause_parser.is_header_row("All external APIs are exposed through Apigee."),
)
ok(
    "nor a short sentence without pipes",
    not clause_parser.is_header_row("Design for Reuse"),
)
ok(
    "a pipe-separated line stating an obligation is not a header",
    not clause_parser.is_header_row("Rule | Components must be designed for reuse."),
)


# ---------------------------------------------------------------------------
print("\n3. The splitter is conservative")

ok("ordinary prose yields nothing", clause_parser.split_flattened_grid(
    section("3.1 Integration", "Integration follows the enterprise patterns.")) == [])
ok(
    "a single record is not split out on its own",
    clause_parser.split_flattened_grid(
        section(HEADER, "#: 1 | Principle Name: Only One | Statement and Rationale: Must hold.")
    )
    == [],
)
ok(
    "a catalogue row with no obligation is refused",
    all(
        "Layered" not in (c.title or "")
        for c in clause_parser.split_flattened_grid(
            section(
                HEADER,
                "#: 1 | Principle Name: Layered | Statement and Rationale: Separates concerns. "
                "#: 2 | Principle Name: Other | Statement and Rationale: Also separates things.",
            )
        )
    ),
)


# ---------------------------------------------------------------------------
print("\n4. A fix that argues compliance is caught")

SCREENSHOT = {
    "verdict": "not_assessable",
    "confidence": 0.8,
    "rationale": (
        "The clause governs what is 'approved', and nothing quoted records an approval, "
        "certification or waiver. Naming the technology is not the approval. The design uses "
        "service-oriented, client-server, MVC, and layered patterns appropriate for the "
        "system's business and operational needs, aligning with the clause's fit-for-purpose "
        "integration principle."
    ),
    "evidence": ["c1"],
    "appliedDecisions": [],
}
TECHNICAL = {
    "title": "1 — Fit-for-Purpose Pattern Selection",
    "statement": "Architecture patterns must be selected to fit the business need.",
    "requirements": ["Record the pattern choice."],
}

ok(
    "the compliance-shaped fix is detected",
    analyse._fix_is_a_compliance_claim("not_assessable", SCREENSHOT["rationale"]),
)
verdict, _conf, rationale, _cited, _claimed = analyse._normalise(SCREENSHOT, TECHNICAL)
ok("so the verdict no longer contradicts its own fix", verdict != "not_assessable", verdict)

ok(
    "a real remediation is left alone",
    not analyse._fix_is_a_compliance_claim(
        "partial",
        "No retention period is stated for audit logs. A breach could not be reconstructed. "
        "Set a 7-year retention policy on the audit log store.",
    ),
)
ok(
    "and a covered verdict is never touched by this rule",
    not analyse._fix_is_a_compliance_claim("covered", SCREENSHOT["rationale"]),
)


# ---------------------------------------------------------------------------
print("\n5. A technical clause is not answered with paperwork")

ok(
    "the governance answer to a technical clause is caught",
    analyse._paperwork_answer_to_a_technical_clause(
        "not_assessable", SCREENSHOT["rationale"], TECHNICAL
    ),
)
ok(
    "a clause that really asks for a record is left alone",
    not analyse._paperwork_answer_to_a_technical_clause(
        "not_assessable",
        "Nothing records an approval for the named platform. The ARB holds it. Obtain the "
        "ARB decision.",
        {
            "title": "Approval of technology",
            "statement": "Technology must be approved by the ARB before use.",
            "requirements": [],
        },
    ),
)
ok(
    "and no clause text means no opinion",
    not analyse._paperwork_answer_to_a_technical_clause(
        "not_assessable", SCREENSHOT["rationale"], None
    ),
)


# ---------------------------------------------------------------------------
print("\n6. A hyphen survives, and a line wrap does not")


def excerpt(text: str) -> str:
    return retrieval.Candidate(
        chunk_id="x", heading_path="H", text=text, page_start=1, score=1.0,
        vector_rank=1, lexical_rank=1,
    ).excerpt


for src, want in (
    ("imple-\nmented", "implemented"),
    ("architec-\nture", "architecture"),
    ("service-\noriented", "service-oriented"),
    ("client-\nserver", "client-server"),
    ("request-\nresponse", "request-response"),
    ("co-\nop", "co-op"),
    ("Shibboleth-\nBased", "Shibboleth-Based"),
    ("ISO-\n27001", "ISO-27001"),
    ("service-oriented", "service-oriented"),
    ("model-view-controller", "model-view-controller"),
    ("N-layered", "N-layered"),
):
    ok(f"{src!r} -> {want}", excerpt(src) == want, excerpt(src))

# A table keeps its line structure, so the rejoin must not reach it.
rows = retrieval.Candidate(
    chunk_id="t", heading_path="H", text="Col: a\nCol: b", page_start=1, score=1.0,
    vector_rank=1, lexical_rank=1, source_kind="table_row",
).excerpt
ok("a table row keeps its lines", "\n" in rows, repr(rows))


# ---------------------------------------------------------------------------
print("\n7. The advice lenses are in the prompt, in order")

from aidp.ai import llm  # noqa: E402

ADVICE = llm._advice_system(design="D", findings="F", title="T")
order = [ADVICE.find(f"LENS {n}") for n in (1, 2, 3, 4)]
ok("all four lenses are present", all(i >= 0 for i in order), order)
ok("and in priority order", order == sorted(order), order)
ok(
    "contradictions are the highest priority",
    "CONTRADICTS ITSELF" in ADVICE and "Highest priority" in ADVICE,
)
ok(
    "the availability contradiction is named",
    "single point of failure" in ADVICE and "active redundancy" in ADVICE,
)
ok("the diagram mismatch is named", "two diagrams describing different stacks" in ADVICE)
ok("the integration contradiction is named", "denying external" in ADVICE)
ok(
    "a deferred view may not be reported as missing",
    "HARD RULE" in ADVICE and "scoped that view" in ADVICE,
)
for generic in ("backup strategy", "deployment pipeline", "firewall", "tracing", "caching"):
    ok(f"'{generic}' is named as a false finding on a scoped-out view", generic in ADVICE)


print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
