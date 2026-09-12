"""Smoke test for the structure repairs a live Word blueprint needed.

No database, no network, and no client text: every grid and heading below is
synthetic, shaped like the real ones.

  · a header cell merged across grid columns   → the column put back together,
    its values bound to its name instead of to "column 1"
  · a column title wrapped onto a second row   → folded into the header
  · a deliberately blank named column          → left alone
  · a merged cell repeating its text            → one column, not two
  · diagram labels, a paragraph in a box        → not tables
  · a key/value table, the empty-cell trap      → still tables, still correct
  · "3.4.3.1.1 Virtual Servers" at 11pt bold    → a heading, over 12pt body
  · an 18pt regular label among bold headings   → content, not a heading
  · a table under the second of two headings    → attached to that heading
  · a design document                           → no "clause not extracted"
  · many doubtful tables, a stale contents page → one finding each

Run inside the worker image:

    python -m scripts.smoke_structure
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from aidp.parsing import sections, spans, tables  # noqa: E402
from aidp.stages import parse  # noqa: E402

failures: list[str] = []


def ok(name: str, condition: bool, detail: object = "") -> None:
    print(f"  {'PASS' if condition else 'FAIL'} {name}" + ("" if condition else f"  {detail!r}"))
    if not condition:
        failures.append(name)


# ---------------------------------------------------------------------------
print("\n1. Merged cells are put back together")

merged = [
    ["", "Version", "", "", "Date", "", "", "Author", "", "", "Notes", ""],
    [
        "0.1",
        None,
        None,
        "1 Jan 2020",
        None,
        None,
        "A. Writer",
        None,
        None,
        "First draft",
        None,
        None,
    ],
    ["0.2", None, None, "2 Feb 2020", None, None, "B. Editor", None, None, "", None, None],
]
shaped = tables.shape(merged)
ok(
    "twelve grid columns become four",
    shaped and shaped[0] == ["Version", "Date", "Author", "Notes"],
    shaped and shaped[0],
)
ok(
    "each value sits under its own name",
    shaped
    and shaped[1][0]
    == {"Version": "0.1", "Date": "1 Jan 2020", "Author": "A. Writer", "Notes": "First draft"},
    shaped and shaped[1][0],
)
ok(
    "a blank cell is still empty, not borrowed",
    shaped and shaped[1][1]["Notes"] is None,
    shaped and shaped[1][1],
)

wrapped_role = [
    ["", "", "", "Approver"],
    [None, "Role", None, None],
    ["Sponsor", None, None, "C. Person"],
    ["Architect", None, None, "D. Person"],
]
shaped = tables.shape(wrapped_role)
ok(
    "a header cell pushed into the first row is folded back",
    shaped and shaped[0] == ["Role", "Approver"],
    shaped and shaped[0],
)
ok(
    "and the rows bind to it",
    shaped and shaped[1][0] == {"Role": "Sponsor", "Approver": "C. Person"},
    shaped and shaped[1],
)

wrapped_title = [
    ["Capability", "", "How the solution", "", "Impact"],
    [None, None, "supports it", None, None],
    ["Take orders", "Online checkout", None, None, "Staff retrained"],
]
shaped = tables.shape(wrapped_title)
ok(
    "a title wrapped onto a second row is joined",
    shaped and shaped[0] == ["Capability", "How the solution supports it", "Impact"],
    shaped and shaped[0],
)
ok(
    "its value is under the joined title",
    shaped and shaped[1][0].get("How the solution supports it") == "Online checkout",
    shaped and shaped[1],
)

blank_named = [
    ["Tier", "", "Comments"],
    ["Tier 1", "15 minutes", ""],
    ["Tier 2", "1 hour", ""],
]
shaped = tables.shape(blank_named)
ok(
    "a deliberately empty named column keeps its name to itself",
    shaped and shaped[0] == ["Tier", "column 2", "Comments"],
    shaped and shaped[0],
)

repeated = [
    ["", "Interface table", None, None, ""],
    ["", "Interface number", "", "7", None],
    ["Description", "Description", None, "Nightly export", None],
    ["", "Protocol", "", "SFTP", None],
]
shaped = tables.shape(repeated)
ok(
    "a merged cell repeating its text is one column",
    shaped and len(shaped[0]) == 2,
    shaped and shaped[0],
)
ok(
    "and the pairs stay paired",
    shaped and shaped[1][1] == {shaped[0][0]: "Description", shaped[0][1]: "Nightly export"},
    shaped and shaped[1],
)


# ---------------------------------------------------------------------------
three_line = [
    ["", "App", "", "Server"],
    [None, "Component", None, None],
    [None, "hosted", None, None],
    ["App Server", None, None, "Node 1"],
    ["Web Server", None, None, "Node 2"],
]
shaped = tables.shape(three_line)
ok(
    "a title wrapped over several rows is joined whole",
    shaped and shaped[0] == ["App Component hosted", "Server"],
    shaped and shaped[0],
)
ok(
    "and its values bind to it",
    shaped and shaped[1][0] == {"App Component hosted": "App Server", "Server": "Node 1"},
    shaped and shaped[1],
)


print("\n2. Outlines that are not tables are dropped; tables are not")

ok(
    "scattered diagram labels",
    tables.shape([["", None, None, None], [None, "", "", None], [None, None, None, "Printer"]])
    is None,
)
ok(
    "a paragraph that sits in a bordered box",
    tables.shape(
        [
            ["A paragraph that happens to sit in a box and wraps", None],
            ["onto a second line of prose", None],
            ["and a third.", ""],
        ]
    )
    is None,
)
ok(
    "labels scattered one per row",
    tables.shape(
        [
            [None, None, "Firewall", "Router"],
            [None, None, "Internal user", None],
            [None, "Auth", None, None],
        ]
    )
    is None,
)
ok(
    "a key/value table is still a table",
    tables.shape(
        [["Interface number", "3"], ["Interface name", "Address check"], ["Protocol", "HTTPS"]]
    )
    is not None,
)
tier = tables.shape([["Tier", "RPO", "RTO"], ["Tier 3", "4 hours", "8 hours"], ["Tier 4", "", ""]])
ok(
    "the empty-cell trap still holds",
    tier is not None and tier[1][1] == {"Tier": "Tier 4", "RPO": None, "RTO": None},
    tier,
)


# ---------------------------------------------------------------------------
print("\n3. Headings")

BODY = ("Arial", 12.0, False, False, 0)
BOLD14 = ("Arial-Bold", 14.0, True, False, 0)
BOLD12 = ("Arial-Bold", 12.0, True, False, 0)
SMALL = ("Arial-BoldItalic", 11.0, True, True, 0)
LARGE = ("Arial", 18.0, False, False, 0)


def line(text: str, page: int, y: float, sig) -> spans.Line:
    return spans.Line(
        text=text,
        page=page,
        y=y,
        x0=50.0,
        bbox=(50.0, y, 400.0, y + 12),
        sig=sig,
        has_bold=bool(sig[2]),
    )


profile = spans.FontProfile(body=BODY, levels=[LARGE, BOLD14, BOLD12])
doc_lines = [
    line("1 Document", 1, 50, BOLD14),
    line("1.1 Purpose", 1, 80, BOLD12),
    line("What the document is for, stated at some length for the parser.", 1, 100, BODY),
    line("2 Summary", 1, 130, BOLD14),
    line("2.1 Overview", 1, 160, BOLD12),
    line("An overview of the solution, again long enough to be prose.", 1, 180, BODY),
    line("3 Technology", 2, 50, BOLD14),
    line("3.4 Instances", 2, 80, BOLD12),
    line("3.4.3.1.1 Virtual Servers", 2, 110, SMALL),
    line("Servers are listed in the attached inventory.", 2, 130, BODY),
    line("Automation Service Catalog", 2, 300, LARGE),
    line("A catalogue of automated builds.", 2, 330, BODY),
    line("3.4.4 Storage", 3, 100, BOLD12),
]
built = sections.build(doc_lines, profile, document_title="Doc")
titles = [s.title for s in built]
virtual = next((s for s in built if s.title == "Virtual Servers"), None)
ok("a bold heading a point under body size is found", virtual is not None, titles)
ok("with its number", virtual is not None and virtual.number_text == "3.4.3.1.1", virtual)
ok(
    "a large regular label is not a heading in a bold document",
    "Automation Service Catalog" not in titles,
    titles,
)
ok(
    "its text stays with the section above it",
    virtual is not None and any(ln.text == "Automation Service Catalog" for ln in virtual.lines),
    virtual and [ln.text for ln in virtual.lines],
)
storage = next((s for s in built if s.title == "Storage"), None)
ok("a heading records where it sits", storage is not None and storage.y_start == 100, storage)

plain = spans.FontProfile(body=BODY, levels=[LARGE, ("Arial", 16.0, False, False, 0)])
PLAIN16 = ("Arial", 16.0, False, False, 0)
plain_lines = [line(f"{n} Chapter {n}", n, 50, PLAIN16) for n in range(1, 6)] + [
    line("Glossary", 6, 50, LARGE),
    line("Terms used throughout.", 6, 80, BODY),
]
ok(
    "where headings are not bold, a large regular heading still counts",
    "Glossary" in [s.title for s in sections.build(plain_lines, plain, document_title="Doc")],
)


# ---------------------------------------------------------------------------
print("\n4. Tables and figures go to the heading above them")

S = sections.Section
page46 = [
    S(1, "3.3", "Data", 2, "D › 3.3", 46, 46, y_start=80.0),
    S(2, "3.3.1", "Model", 3, "D › 3.3 › 3.3.1", 46, 46, y_start=104.0),
    S(3, "3.3.2", "Objects", 3, "D › 3.3 › 3.3.2", 46, 47, y_start=469.0),
]
ok(
    "between two headings on a page → the one above",
    parse._section_for_page(page46, 46, 300.0) == 1,
)
ok("below the second heading → the second", parse._section_for_page(page46, 46, 500.0) == 2)
ok("without a position, the page rule is unchanged", parse._section_for_page(page46, 46) == 2)
ok("a later page → the last section before it", parse._section_for_page(page46, 47, 10.0) == 2)


# ---------------------------------------------------------------------------
print("\n5. Review findings say what matters, once")

instructions = S(
    1,
    "1",
    "Instructions",
    1,
    "D › 1",
    1,
    1,
    lines=[
        line("All sections must be completed and shall not be deleted by the author.", 1, 100, BODY)
    ],
)
design = parse._Result()
design.sections = [instructions]
parse._flag_missed_obligations(design, {"role": "assessed"})
ok("a design gets no 'clause not extracted'", not design.issues, design.issues)
standard = parse._Result()
standard.sections = [instructions]
parse._flag_missed_obligations(standard, {"role": "reference"})
ok(
    "a standard still does",
    any(i["kind"] == "clause_not_extracted" for i in standard.issues),
    standard.issues,
)

weak = [
    (
        0,
        tables.Table(
            page_start=p,
            page_end=p,
            bbox=(0.0, 0.0, 1.0, 1.0),
            columns=["column 1", "x"],
            rows=[{"column 1": "a", "x": "b"}],
            confidence=0.3,
        ),
    )
    for p in range(1, 9)
]
many = parse._Result()
many.sections = [S(1, "1", "A", 1, "D › A", 1, 9)]
parse._flag_doubtful_tables(many, weak, 20)
found = [i for i in many.issues if i["kind"] == "table_low_confidence"]
ok(
    "eight doubtful tables are one finding",
    len(found) == 1 and "8 of 20" in found[0]["detail"],
    found,
)
few = parse._Result()
few.sections = many.sections
parse._flag_doubtful_tables(few, weak[:2], 20)
ok(
    "two are still listed one by one",
    len([i for i in few.issues if i["kind"] == "table_low_confidence"]) == 2,
    few.issues,
)


class _Report:
    def __init__(self, drift):
        self.missing, self.page_drift, self.coverage, self.matched = [], drift, 1.0, len(drift)


real_reconcile = parse.toc.reconcile
try:
    parse.toc.reconcile = lambda entries, parsed: _Report(
        [("A", 10, 12), ("B", 42, 44), ("C", 63, 65)]
    )
    stale = parse._Result()
    parse._reconcile(stale, [object()])
    drift = [i for i in stale.issues if i["kind"] == "toc_mismatch"]
    ok(
        "a contents page off by a page or two is one low finding",
        len(drift) == 1 and drift[0]["severity"] == "low",
        drift,
    )

    parse.toc.reconcile = lambda entries, parsed: _Report([("A", 10, 12), ("B", 20, 31)])
    wrong = parse._Result()
    parse._reconcile(wrong, [object()])
    drift = [i for i in wrong.issues if i["kind"] == "toc_mismatch"]
    ok(
        "a real jump is still reported entry by entry",
        len(drift) == 2 and all(i["severity"] == "medium" for i in drift),
        drift,
    )
finally:
    parse.toc.reconcile = real_reconcile


# ---------------------------------------------------------------------------
print("\n6. A section that only points at an attachment says so")

attached = parse._Result()
attached.sections = [
    S(
        1,
        "3.4.4.1.1",
        "Retired Servers",
        5,
        "D › Retired Servers",
        54,
        54,
        lines=[
            line("The following servers will be retired once testing is verified.", 54, 240, BODY),
            line("Server_Inventory_Mas", 54, 260, BODY),
            line("ter (All Sites).xlsx", 54, 272, BODY),
        ],
    ),
    S(
        2,
        "4.2",
        "Migration",
        2,
        "D › Migration",
        55,
        55,
        lines=[
            line("Details - TBD", 55, 100, BODY),
        ],
    ),
]
parse._flag_empty_sections(attached)
kinds = {i["kind"]: i for i in attached.issues}
ok(
    "an attachment-only section is not called incomplete",
    "section_attachment" in kinds and kinds["section_attachment"]["severity"] == "medium",
    attached.issues,
)
ok(
    "and the attachment is named whole, across the wrap",
    "Server_Inventory_Master (All Sites).xlsx"
    in kinds.get("section_attachment", {}).get("detail", ""),
    kinds.get("section_attachment"),
)
ok(
    "a genuinely empty section is still reported high",
    kinds.get("section_empty", {}).get("severity") == "high",
    attached.issues,
)


# ---------------------------------------------------------------------------
short = parse._Result()
short.sections = [
    S(
        1,
        "5.3",
        "Availability",
        2,
        "D › Availability",
        4,
        4,
        lines=[
            line(
                "The platform runs across two availability zones. Brief outages are tolerable",
                4,
                624,
                BODY,
            ),
            line(
                "because devices buffer locally for four hours and replay on reconnection.",
                4,
                636,
                BODY,
            ),
        ],
    ),
    S(
        2,
        "5.4",
        "New Technologies",
        2,
        "D › New Technologies",
        5,
        5,
        lines=[
            line(
                "Name Description Manufacturer Domain Category Owner Reason for inclusion",
                5,
                100,
                BODY,
            ),
            line(
                "New Technology Name Security considerations Backup Monitoring Usage", 5, 112, BODY
            ),
        ],
    ),
    S(
        3,
        "5.5",
        "Migration Approach",
        2,
        "D › Migration Approach",
        6,
        6,
        lines=[
            line(
                "Long term strategy is to move the contact centre to a new vendor platform. "
                "Details - TBD",
                6,
                100,
                BODY,
            ),
        ],
    ),
]
parse._flag_empty_sections(short)
flagged = {i["sectionRef"] for i in short.issues if i["kind"] == "section_empty"}
ok("two short, complete sentences are content", "D › Availability" not in flagged, short.issues)
ok(
    "a template's column titles run together are still empty",
    "D › New Technologies" in flagged,
    short.issues,
)
ok(
    "a placeholder such as 'Details - TBD' is still empty",
    "D › Migration Approach" in flagged,
    short.issues,
)


print("\n7. A table whose later pages repeat no header is joined back up")

PAGE = 792.0


def piece(page: int, top: float, bottom: float, raw: list) -> tables.Table:
    shaped = tables.shape(raw)
    assert shaped is not None, raw
    cols, rows = shaped
    return tables.Table(
        page_start=page,
        page_end=page,
        bbox=(50.0, top, 550.0, bottom),
        columns=cols,
        rows=rows,
        confidence=tables._confidence(cols, rows),
        raw=raw,
    )


def inventory_head() -> tables.Table:
    return piece(
        1,
        400,
        760,
        [
            ["Node", "Env", "Cores", "Status"],
            ["Node 1", "PROD", "8", "Existing"],
            ["Node 2", "DR", "4", "Existing"],
        ],
    )


joined = tables.stitch(
    [
        inventory_head(),
        piece(2, 60, 760, [["Node 9", "PROD", "8", "N/A"], ["Node 10", "DR", "4", "N/A"]]),
        piece(
            3,
            60,
            300,
            [["", "replica", "", ""], ["Node 11", "PT", "2", "N/A"], ["Node 12", "PT", "2", "N/A"]],
        ),
        piece(
            4,
            60,
            500,
            [["Name", "Owner", "Review", "Notes"], ["Portal", "Team A", "Annual", "None"]],
        ),
    ],
    {n: PAGE for n in range(1, 5)},
)
inventory = joined[0]
ok(
    "pages that repeat no header join the table before them",
    len(joined) == 2,
    [t.columns for t in joined],
)
ok(
    "a first row that is data is bound to the real headers",
    len(inventory.rows) > 2
    and inventory.rows[2] == {"Node": "Node 9", "Env": "PROD", "Cores": "8", "Status": "N/A"},
    inventory.rows[2:4],
)
ok(
    "a cell's text wrapped over the break goes back into its cell",
    len(inventory.rows) > 3 and inventory.rows[3]["Env"] == "DR replica",
    inventory.rows[3:4],
)
ok(
    "every row arrives, in order",
    [r["Node"] for r in inventory.rows]
    == ["Node 1", "Node 2", "Node 9", "Node 10", "Node 11", "Node 12"],
    [r["Node"] for r in inventory.rows],
)
ok("and the table spans its pages", inventory.page_end == 3, inventory.page_end)
ok(
    "a table that ended mid-page is not continued",
    joined[1].columns == ["Name", "Owner", "Review", "Notes"],
    joined[1].columns,
)
ok(
    "a new table with a header of its own starts fresh",
    len(
        tables.stitch(
            [
                inventory_head(),
                piece(
                    2,
                    60,
                    500,
                    [["Name", "Owner", "Review", "Notes"], ["Portal", "Team A", "Annual", "None"]],
                ),
            ],
            {1: PAGE, 2: PAGE},
        )
    )
    == 2,
)


reshaped = tables.stitch(
    [
        piece(
            1,
            400,
            760,
            [["", "Name", "", "Env"], ["web-1", None, None, "PROD"], ["web-2", None, None, "DR"]],
        ),
        piece(2, 60, 300, [["web-9", "PROD"], ["web-10", "DR"]]),
    ],
    {1: PAGE, 2: PAGE},
)
ok(
    "a table merged cells reshaped is continued by its shaped columns",
    len(reshaped) == 1
    and [r["Name"] for r in reshaped[0].rows] == ["web-1", "web-2", "web-9", "web-10"],
    [t.rows for t in reshaped],
)


print(f"\n{len(failures)} failed" if failures else "\nall passed")
sys.exit(1 if failures else 0)
