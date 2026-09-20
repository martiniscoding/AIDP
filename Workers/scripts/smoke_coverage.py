"""The checks on "parts of a design no standard covers", without a database or a model.

The model's reply is scripted, so what this proves is what the code does with a
reply: a section number that is not a section is dropped, a quote that is not in
the design — or not in the section it is claimed for — is refused, a passage a
clause already cited is not reported as ungoverned, a suggestion keeps only the
gaps that survived, and a long design is shortened without losing short sections.

    docker run --rm -v "$PWD":/w -w /w -e STAGE=analyse \\
      -e DATABASE_URL=postgresql://nobody@127.0.0.1:1/none \\
      --entrypoint python aidp-worker-test scripts/smoke_coverage.py
"""

from __future__ import annotations

import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from aidp import coverage, whole_document  # noqa: E402

passed = failed = 0


def ok(name: str, condition: bool, extra: object = "") -> None:
    global passed, failed
    if condition:
        passed += 1
        print(f"  PASS {name}")
    else:
        failed += 1
        print(f"  FAIL {name} {extra}")


HEADS = [
    {
        "ordinal": 1,
        "title": "Solution Blueprint",
        "headingPath": "Blueprint",
        "pageStart": 1,
        "pageEnd": 1,
    },
    {
        "ordinal": 2,
        "title": "4 Payments",
        "headingPath": "Blueprint › 4 Payments",
        "pageStart": 2,
        "pageEnd": 2,
    },
    {
        "ordinal": 3,
        "title": "5 Access",
        "headingPath": "Blueprint › 5 Access",
        "pageStart": 3,
        "pageEnd": 3,
    },
    {
        "ordinal": 4,
        "title": "6 Shipping",
        "headingPath": "Blueprint › 6 Shipping",
        "pageStart": 4,
        "pageEnd": 5,
    },
    {
        "ordinal": 5,
        "title": "Empty",
        "headingPath": "Blueprint › Empty",
        "pageStart": 6,
        "pageEnd": 6,
    },
]
ROWS = [
    {"page": 1, "kind": "heading", "text": "Solution Blueprint", "sectionOrdinal": 1},
    {
        "page": 1,
        "kind": "text",
        "text": "Revision 0.3, approved by the architecture board.",
        "sectionOrdinal": 1,
    },
    {"page": 2, "kind": "heading", "text": "4 Payments", "sectionOrdinal": 2},
    {
        "page": 2,
        "kind": "text",
        "text": "Card payments are captured in the storefront and settled through Moneris nightly.",
        "sectionOrdinal": 2,
    },
    {"page": 3, "kind": "heading", "text": "5 Access", "sectionOrdinal": 3},
    {
        "page": 3,
        "kind": "text",
        "text": "Administrators sign in with multi-factor authentication through Okta.",
        "sectionOrdinal": 3,
    },
    {"page": 4, "kind": "heading", "text": "6 Shipping", "sectionOrdinal": 4},
    {
        "page": 4,
        "kind": "text",
        "text": "Orders are shipped with Canada Post using its label API.",
        "sectionOrdinal": 4,
    },
    {
        "page": 5,
        "kind": "bullet",
        "text": "Tracking numbers are emailed to the customer.",
        "sectionOrdinal": 4,
    },
]

sections = coverage.group(HEADS, ROWS)
whole = whole_document.build("Blueprint", ROWS, [])

print("\nGrouping")
ok("sections with no lines are left out", [s.ordinal for s in sections] == [1, 2, 3, 4])
shipping = next(s for s in sections if s.ordinal == 4)
ok("a section knows the pages its lines are on", shipping.pages == {4, 5}, shipping.pages)
ok("bullets keep their mark", "- Tracking numbers" in shipping.text, shipping.text)

REPLY = {
    "gaps": [
        {
            "section": 2,
            "what": "Takes card payments through Moneris.",
            "quote": "Card payments are captured in the storefront and settled through Moneris "
            "nightly.",
            "page": 2,
        },
        {
            "section": 2,
            "what": "Duplicate.",
            "quote": "Card payments are captured in the storefront",
            "page": 2,
        },
        {
            "section": 9,
            "what": "Not a section.",
            "quote": "Orders are shipped with Canada Post",
            "page": 4,
        },
        {
            "section": 4,
            "what": "Invented.",
            "quote": "Orders are delivered by drone within the hour.",
            "page": 4,
        },
        {
            "section": 1,
            "what": "Real words, wrong section.",
            "quote": "Orders are shipped with Canada Post using its label API.",
            "page": 4,
        },
        {
            "section": 3,
            "what": "Sign-in.",
            "quote": "Administrators sign in with multi-factor authentication through Okta.",
            "page": 3,
        },
        {
            "section": 4,
            "what": "Ships through Canada Post.",
            "quote": "Orders are shipped with Canada Post using its label API. "
            "Tracking numbers are emailed to the customer.",
            "page": 7,
        },
    ],
    "suggestions": [
        {
            "title": "Payment card data handling",
            "covers": "Capture and settlement of card data.",
            "why": "The design settles card payments through Moneris.",
            "sections": [2, 9, 2],
        },
        {
            "title": "Identity for administrators",
            "covers": "Admin sign-in.",
            "why": "Okta.",
            "sections": [3],
        },
        {
            "title": "Carrier integrations",
            "covers": "Shipping carriers.",
            "why": "Canada Post.",
            "sections": [4],
        },
        {"title": "", "covers": "No title.", "why": "", "sections": [2]},
    ],
}
cited = [
    whole_document.normalise(
        "Administrators sign in with multi-factor authentication through Okta."
    )
]

print("\nChecking a reply")
checked = coverage.check(REPLY, sections, whole, cited)
by_section = {gap["section"]: gap for gap in checked.gaps}
ok(
    "a real gap is kept, quoted, on its page",
    by_section.get(2, {}).get("page") == 2,
    by_section.get(2),
)
ok("a section is reported once", [g["section"] for g in checked.gaps].count(2) == 1)
ok(
    "a number that is not a section is dropped",
    checked.dropped["unknownSection"] == 1,
    checked.dropped,
)
ok("an invented quote is refused", checked.dropped["unverified"] == 1, checked.dropped)
ok(
    "real words claimed for the wrong section are refused",
    checked.dropped["outsideSection"] == 1,
    checked.dropped,
)
ok(
    "a passage a clause already cited is not ungoverned",
    3 not in by_section and checked.dropped["alreadyJudged"] == 1,
    checked.dropped,
)
ok(
    "a quote running over a page break is one real passage, kept whole on the page it starts",
    (by_section.get(4, {}).get("quote") or "").endswith(
        "Tracking numbers are emailed to the customer."
    )
    and by_section[4]["page"] == 4,
    by_section.get(4),
)

STITCHED = {
    "gaps": [
        {
            "section": 4,
            "what": "Ships through Canada Post.",
            "quote": "Orders are shipped with Canada Post using its label API. Card payments are "
            "captured in the storefront and settled through Moneris nightly.",
            "page": 4,
        },
    ],
    "suggestions": [],
}
stitched = coverage.check(STITCHED, sections, whole, [])
ok(
    "a quote stitched from two sections keeps only the sentence from this one",
    [g["quote"] for g in stitched.gaps]
    == ["Orders are shipped with Canada Post using its label API."],
    stitched.gaps,
)
ok(
    "a gap carries its section's page range",
    by_section.get(4, {}).get("pageStart") == 4 and by_section[4]["pageEnd"] == 5,
    by_section.get(4),
)

titles = [s["title"] for s in checked.suggestions]
ok(
    "a suggestion keeps only surviving gaps, once each",
    checked.suggestions[0]["sections"] == [2],
    checked.suggestions,
)
ok(
    "a suggestion whose gaps were all refused is dropped",
    "Identity for administrators" not in titles,
    titles,
)
ok(
    "an untitled suggestion is dropped",
    titles == ["Payment card data handling", "Carrier integrations"],
    titles,
)
ok(
    "a reply that is not the expected shape yields nothing, and raises nothing",
    coverage.check({"gaps": "nope", "suggestions": None}, sections, whole, []).gaps == [],
)

print("\nRendering")
design, shortened = coverage.render_design(sections, budget=10_000)
ok(
    "each section is behind its number, with its pages",
    "=== S4: Blueprint › 6 Shipping (pages 4-5) ===" in design,
    design[:400],
)
ok("a design within budget is not shortened", shortened is False)

long_heads = [
    {"ordinal": 1, "title": "Appendix", "headingPath": "Appendix", "pageStart": 1, "pageEnd": 9},
    {
        "ordinal": 2,
        "title": "Integration",
        "headingPath": "Integration",
        "pageStart": 10,
        "pageEnd": 10,
    },
]
long_rows = [
    {"page": 1, "kind": "text", "text": "x" * 5000, "sectionOrdinal": 1},
    {"page": 10, "kind": "text", "text": "Orders go to Canada Post.", "sectionOrdinal": 2},
]
design, shortened = coverage.render_design(coverage.group(long_heads, long_rows), budget=1_500)
ok("a long design is shortened, and says so", shortened and "not shown" in design)
ok("a short section survives the cut whole", "Orders go to Canada Post." in design)

standards = coverage.render_standards(
    [
        {
            "headingPath": "Security › 3 Access",
            "title": "Multi-factor authentication",
            "statement": "Admins must use MFA. " * 40,
            "requirements": ["Use TOTP", "No SMS"],
        },
    ]
)
ok(
    "a clause is numbered, placed and cut",
    standards.startswith("C1 [Security › 3 Access] Multi-factor authentication")
    and "…" in standards
    and "Requirements: Use TOTP; No SMS" in standards,
    standards[:300],
)

print("\nQuote containment")
ok(
    "ellipsis parts in order are contained",
    whole_document.contains("one two three four five six", "one two ... five six"),
)
ok(
    "parts out of order are not",
    not whole_document.contains("one two three four five six", "five six ... one two"),
)

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
