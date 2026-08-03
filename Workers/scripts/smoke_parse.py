"""Smoke test for the parsing package — no database, no network.

Builds a PDF that reproduces the traps found in the real corpus, then runs the
parser over it and asserts on the result:

  · a running header and footer on every page          → stripped, but the
    sensitivity classification read off it first
  · a table of contents with dotted leaders            → parsed as ground truth
    and reconciled against the body
  · numbered headings in a larger, bolder face         → section tree
  · a Statement / Rationale / Requirements clause      → clause extraction
  · a bordered table with a deliberately empty cell    → the cell survives as
    None rather than shifting every later value one column left
  · a section with a heading and nothing under it      → flagged, not swallowed

Run inside the worker image, which already has PyMuPDF:

    docker run --rm -v "$PWD":/w -w /w aidp-worker:dev \
        python scripts/smoke_parse.py
"""

from __future__ import annotations

import sys
from pathlib import Path

import fitz

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from aidp.parsing import clauses, furniture, sections, spans, tables, toc  # noqa: E402

BODY, BOLD = "helv", "hebo"
HEADER = "Test Standards   |   Page {n}"
FOOTER = "SENSITIVITY CLASSIFICATION: Internal Use"

failures: list[str] = []


def check(label: str, condition: bool, detail: str = "") -> None:
    mark = "PASS" if condition else "FAIL"
    print(f"  [{mark}] {label}{('  — ' + detail) if detail and not condition else ''}")
    if not condition:
        failures.append(label)


def furnish(page: fitz.Page, number: int) -> None:
    page.insert_text((360, 40), HEADER.format(n=number), fontsize=8, fontname=BODY)
    page.insert_text((150, 800), FOOTER, fontsize=8, fontname=BODY)


def build_pdf(path: Path) -> None:
    doc = fitz.open()

    # 1 — cover
    page = doc.new_page()
    furnish(page, 1)
    page.insert_text((72, 300), "Test Standards", fontsize=26, fontname=BOLD)
    page.insert_text((72, 330), "Enterprise Test Standards", fontsize=12, fontname=BODY)
    page.insert_text((72, 360), "DOC-TEST-STD V-1.0", fontsize=9, fontname=BODY)

    # 2 — table of contents, dotted leaders
    page = doc.new_page()
    furnish(page, 2)
    page.insert_text((72, 90), "Table of Contents", fontsize=17, fontname=BOLD)
    entries = [
        ("1. Introduction", 3),
        ("1.1 Purpose", 3),
        ("2. Governance Standards", 3),
        ("2.1 Ownership", 3),
        ("3. Criticality Tiers", 4),
        ("4. Cybersecurity Guidelines", 5),
        ("Appendix A: Glossary", 6),
    ]
    y = 130
    for title, page_no in entries:
        page.insert_text((72, y), f"{title} {'.' * 60} {page_no}", fontsize=10, fontname=BODY)
        y += 22

    # 3 — prose sections with a clause
    page = doc.new_page()
    furnish(page, 3)
    page.insert_text((72, 90), "1. Introduction", fontsize=17, fontname=BOLD)
    page.insert_text((72, 120), "1.1 Purpose", fontsize=13, fontname=BOLD)
    page.insert_text(
        (72, 145),
        "This document defines the standards that govern how test systems are built.",
        fontsize=10,
        fontname=BODY,
    )
    page.insert_text((72, 195), "2. Governance Standards", fontsize=17, fontname=BOLD)
    page.insert_text((72, 225), "2.1 Ownership", fontsize=13, fontname=BODY)
    lines = [
        ("Statement: Every data domain must have a designated Data Owner", BOLD),
        ("accountable for its definition and quality.", BODY),
        ("Rationale: Clear ownership prevents ambiguity in decision-making and", BOLD),
        ("provides an escalation path for governance decisions.", BODY),
        ("Requirements:", BOLD),
        ("• Every critical data domain must have an assigned Data Owner", BODY),
        ("• Data Owners must approve changes to data definitions", BODY),
        ("• Stewardship responsibilities must be reviewed annually", BODY),
    ]
    y = 255
    for text, font in lines:
        page.insert_text((72, y), text, fontsize=10, fontname=font)
        y += 20

    # 4 — a bordered table whose last row leaves two cells empty
    page = doc.new_page()
    furnish(page, 4)
    page.insert_text((72, 90), "3. Criticality Tiers", fontsize=17, fontname=BOLD)

    cols = [72, 172, 302, 402, 502]
    rows = [130, 160, 190, 220, 250]
    for x in cols:
        page.draw_line(fitz.Point(x, rows[0]), fitz.Point(x, rows[-1]))
    for y in rows:
        page.draw_line(fitz.Point(cols[0], y), fitz.Point(cols[-1], y))

    grid = [
        ["Tier", "Criticality", "RPO", "RTO"],
        ["Tier 1", "Mission-critical", "0 to 2 hours", "1 to 2 hours"],
        ["Tier 3", "Productivity", "4 to 8 hours", "4 to 8 hours"],
        # The trap: RPO and RTO are blank. Drop them and Tier 4 inherits Tier 3.
        ["Tier 4", "Function Specific", "", ""],
    ]
    for r, row in enumerate(grid):
        for c, cell in enumerate(row):
            if cell:
                page.insert_text(
                    (cols[c] + 5, rows[r] + 19),
                    cell,
                    fontsize=9,
                    fontname=BOLD if r == 0 else BODY,
                )

    # 5 — a heading with nothing under it
    page = doc.new_page()
    furnish(page, 5)
    page.insert_text((72, 90), "4. Cybersecurity Guidelines", fontsize=17, fontname=BOLD)
    page.insert_text((72, 120), "This template ensures:", fontsize=10, fontname=BODY)

    # 6 — appendix
    page = doc.new_page()
    furnish(page, 6)
    page.insert_text((72, 90), "Appendix A: Glossary", fontsize=17, fontname=BOLD)
    page.insert_text(
        (72, 120), "RPO  Recovery Point Objective.", fontsize=10, fontname=BODY
    )

    doc.save(path)
    doc.close()


def main() -> int:
    path = Path("/tmp/aidp-smoke.pdf")
    build_pdf(path)
    doc = fitz.open(path)

    print(f"\nBuilt {path} — {doc.page_count} pages\n")

    print("Typography")
    lines = spans.extract_lines(doc)
    profile = spans.profile_fonts(lines)
    check("lines extracted", len(lines) > 30, f"got {len(lines)}")
    check("body style identified", profile.body[1] == 10.0, f"got {profile.body[1]}pt")
    check("heading levels found", len(profile.levels) >= 2, f"got {len(profile.levels)}")

    print("\nFurniture")
    content, sensitivity = furniture.strip(lines, doc.page_count)
    check("sensitivity captured", sensitivity == "Internal Use", f"got {sensitivity!r}")
    check(
        "running header stripped",
        not any("Page" in ln.text and "Test Standards" in ln.text for ln in content),
    )
    check("footer stripped", not any(FOOTER in ln.text for ln in content))

    print("\nTable of contents")
    entries = toc.parse(lines)
    check("entries parsed", len(entries) == 7, f"got {len(entries)}")
    check(
        "numbering understood",
        any(e.number == "1.1" and e.title == "Purpose" for e in entries),
    )
    check("appendix understood", any(e.number == "Appendix A" for e in entries))

    print("\nSections")
    toc_pages = {2}
    built = sections.build(content, profile, document_title="Test Standards", skip_pages=toc_pages)
    titles = [s.title for s in built]
    check("sections found", len(built) >= 5, f"got {len(built)}: {titles}")
    check("subsection nested", any(s.number_text == "2.1" and s.depth == 2 for s in built))
    check(
        "heading path built",
        any("Test Standards ›" in s.heading_path for s in built),
        built[0].heading_path if built else "",
    )

    print("\nClauses")
    ownership = next((s for s in built if s.number_text == "2.1"), None)
    check("ownership section located", ownership is not None)
    found = clauses.from_prose(ownership) if ownership else []
    check("clause extracted", len(found) == 1, f"got {len(found)}")
    if found:
        clause = found[0]
        check("statement captured", "designated Data Owner" in clause.statement, clause.statement)
        check("rationale captured", "ambiguity" in clause.rationale, clause.rationale)
        check("requirements split", len(clause.requirements) == 3, str(clause.requirements))
        check(
            "continuation joined onto its bullet",
            all(len(r) > 20 for r in clause.requirements),
            str(clause.requirements),
        )

    print("\nTables — the empty-cell trap")
    found_tables = tables.extract(doc)
    check("table detected", len(found_tables) >= 1, f"got {len(found_tables)}")
    if found_tables:
        table = found_tables[0]
        check("headers bound", "RPO" in table.columns, str(table.columns))
        tier4 = next((r for r in table.rows if (r.get("Tier") or "").startswith("Tier 4")), None)
        check("Tier 4 row present", tier4 is not None, str(table.rows))
        if tier4:
            check("empty RPO kept as null", tier4.get("RPO") in (None, ""), repr(tier4.get("RPO")))
            check(
                "Tier 4 did NOT inherit Tier 3's value",
                (tier4.get("RPO") or "") != "4 to 8 hours",
                repr(tier4.get("RPO")),
            )
            rendered = table.render_row(tier4)
            check("renders as 'not specified'", "not specified" in rendered, rendered)

    print("\nEmpty section")
    cyber = next((s for s in built if "Cybersecurity" in s.title), None)
    check("section parsed", cyber is not None)
    if cyber:
        has_clause = bool(clauses.from_prose(cyber))
        check("no clause extracted from it", not has_clause)
        check("prose is trivially short", len(cyber.text) < 200, f"{len(cyber.text)} chars")

    print("\nReconciliation")
    report = toc.reconcile(entries, [(s.title, s.page_start) for s in built])
    check("coverage complete", report.coverage >= 0.99, f"{report.coverage:.0%}")
    check("nothing missing", not report.missing, str([m.title for m in report.missing]))

    doc.close()

    print()
    if failures:
        print(f"{len(failures)} check(s) failed: {', '.join(failures)}")
        return 1
    print("All checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
