"""The project section of samples/ANSWER_KEY.md, audited against the rest of it.

A project is assessed as one piece of work, and the two sample designs are the
eval set for that because they disagree: where the portal is silent the
telemetry design answers, and where one complies the other breaches. The key now
states the verdict each clause should get for the two of them together.

A hand-written table is worth very little on its own, so nothing here trusts it.
What this proves:

  · the project column follows from the two per-design columns by the rule the
    key states, computed rather than read — a row typed wrong fails here;
  · the rule is the one the judge is given, so the key and the prompt cannot
    drift apart silently;
  · each clause the key credits to one design is actually answerable from that
    design's own words, and is not answerable from the other's — which is the
    property the per-design quote check rests on, and the one a project run
    would quietly lose by checking a quote against the wrong design;
  · the verdicts the key expects survive verification and the guards.

No database and no model: the same technique as test_answer_key_audit.py, which
this deliberately mirrors.

    docker run --rm -v "$PWD":/repo -w /repo/Workers -e STAGE=analyse \\
      -e DATABASE_URL=postgresql://nobody@127.0.0.1:1/none \\
      --entrypoint python workers-analyse tests/test_project_answer_key.py
"""

from __future__ import annotations

import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import pymupdf  # noqa: E402

from aidp import whole_document  # noqa: E402
from aidp.ai import llm  # noqa: E402
from aidp.stages import analyse  # noqa: E402

REPO = pathlib.Path(__file__).resolve().parents[2]
SAMPLES = REPO / "samples"
KEY = SAMPLES / "ANSWER_KEY.md"

STANDARD = {
    "Architecture": SAMPLES / "standards" / "Solution_Architecture_Standards.pdf",
    "Data": SAMPLES / "standards" / "Data_Standards.pdf",
    "Security": SAMPLES / "standards" / "Security_Standards.pdf",
}
DESIGN = {
    "portal": SAMPLES / "designs" / "Customer_Portal_Modernisation_SAD.pdf",
    "telem": SAMPLES / "designs" / "Field_Telemetry_Ingestion_SAD.pdf",
}

passed = failed = 0


def ok(name: str, condition: bool, detail: object = "") -> None:
    global passed, failed
    if condition:
        passed += 1
        print(f"  ok   {name}")
    else:
        failed += 1
        print(f"  FAIL {name}" + (f"  -> {detail!r}" if detail != "" else ""))


def read(path: pathlib.Path) -> list[tuple[int, str]]:
    doc = pymupdf.open(path)
    try:
        return [(i, page.get_text().replace("�", "-")) for i, page in enumerate(doc, 1)]
    finally:
        doc.close()


STANDARD_TEXT = {book: "\n".join(t for _, t in read(p)) for book, p in STANDARD.items()}
DESIGN_PAGES = {name: read(p) for name, p in DESIGN.items()}


def clause(book: str, number: str) -> str:
    text = STANDARD_TEXT[book]
    for match in re.finditer(r"(?m)^" + re.escape(number) + r"\s+(?!\.)(\S.*)$", text):
        if "...." in match.group(0):
            continue
        return re.sub(r"\s+", " ", text[match.start() : match.start() + 1100]).strip()
    return ""


# ---------------------------------------------------------------------------
# The rule, as code. The key states it as a table; this is the same thing in the
# order the judge is told to apply it (llm._SCOPE_RULE).
# ---------------------------------------------------------------------------
ORDER = ("contradicts", "covered", "partial", "needs_review")


def combine(verdicts: list[str]) -> str:
    """The project verdict a set of per-design verdicts implies."""
    for verdict in ORDER:
        if verdict in verdicts:
            return verdict
    return "absent"


ROW = re.compile(
    r"\|\s*(Architecture|Data|Security)\s*§(\d+\.\d+)[^|]*\|"  # clause
    r"\s*([\w—-]+)\s*\|"  # portal
    r"\s*([\w—-]+)\s*\|"  # telemetry
    r"\s*\*{0,2}(\w+)"  # expected
)

PER_DESIGN = re.compile(
    r"\|\s*(Architecture|Data|Security)\s*§(\d+\.\d+)[^|]*\|\s*\*{0,2}(\w+)"
)


def parse_project_rows() -> list[tuple[str, str, str, str, str, bool]]:
    """(book, number, portal, telemetry, expected, must) from the project tables."""
    rows = []
    inside = False
    must = False
    for line in KEY.read_text(encoding="utf-8").splitlines():
        if line.startswith("## "):
            inside = "as one project" in line
        if line.startswith("### "):
            must = "Must get" in line
        if not inside:
            continue
        match = ROW.match(line.strip())
        if match:
            book, number, portal, telem, expected = match.groups()
            rows.append((book, number, portal, telem, expected, must))
    return rows


def parse_design_rows() -> dict[tuple[str, str, str], str]:
    """(design, book, number) -> expected verdict, from the two per-design sections."""
    out: dict[tuple[str, str, str], str] = {}
    design: str | None = None
    for line in KEY.read_text(encoding="utf-8").splitlines():
        if line.startswith("## "):
            if "Customer Portal Modernisation" in line:
                design = "portal"
            elif "Field Telemetry Ingestion" in line:
                design = "telem"
            else:
                design = None
        if design is None:
            continue
        match = PER_DESIGN.match(line.strip())
        if match:
            out[(design, match.group(1), match.group(2))] = match.group(3)
    return out


ROWS = parse_project_rows()
BY_DESIGN = parse_design_rows()

print(
    f"ANSWER_KEY.md lists {len(ROWS)} project rows "
    f"({sum(1 for r in ROWS if r[5])} must-get) over {len(BY_DESIGN)} per-design verdicts"
)
ok("the project section was found and parsed", len(ROWS) >= 20, len(ROWS))


# ---------------------------------------------------------------------------
print("\n1. Every project row's own columns agree with the per-design sections")
for book, number, portal, telem, expected, _ in ROWS:
    for label, shown in (("portal", portal), ("telem", telem)):
        recorded = BY_DESIGN.get((label, book, number))
        if shown in ("—", "-"):
            ok(
                f"{book} {number}: {label} is not in that design's table either",
                recorded is None,
                recorded,
            )
        else:
            ok(
                f"{book} {number}: {label} says {shown}, as its own table does",
                recorded == shown,
                recorded,
            )


# ---------------------------------------------------------------------------
print("\n2. Every expected project verdict follows from the rule, computed")
for book, number, portal, telem, expected, must in ROWS:
    designs = [v for v in (portal, telem) if v not in ("—", "-")]
    ok(
        f"[{'MUST' if must else 'dir '}] {book} {number}: {' + '.join(designs)} -> {expected}",
        combine(designs) == expected,
        combine(designs),
    )


# ---------------------------------------------------------------------------
print("\n3. The rule is the one the judge is given")
rule = llm._scope_block(2)
ok("a breach in any design stands", "does not undo" in rule)
ok("a requirement met in one is met", "met in any one of these designs is met" in rule)
ok("absent means no design engages", "no design engages with the clause at all" in rule)
ok(
    "and a single design is told none of it",
    llm._scope_block(1) == "",
    llm._scope_block(1),
)
# The orders have to match, or the key audits a rule the judge is not applying.
ok(
    "contradicts is tried before covered, in both",
    rule.index("contradicts") < rule.index("met in any one")
    or ORDER.index("contradicts") < ORDER.index("covered"),
)


# ---------------------------------------------------------------------------
print("\n4. The design the key credits is the one that can answer it")

WHOLE = {
    name: whole_document.build(
        name,
        [
            {"page": page, "kind": "text", "text": line.strip()}
            for page, text in pages
            for line in text.splitlines()
            if line.strip()
        ],
        [],
    )
    for name, pages in DESIGN_PAGES.items()
}
OTHER = {"portal": "telem", "telem": "portal"}

# The clauses one design answers and the other does not: a project verdict rests
# on a quote from the answering design, and that quote must not verify against
# the other one. A project run that checked it against the wrong design would
# report a quote as unfounded, or worse, accept an invented one.
CREDITED = [
    (book, number, "telem" if portal in ("absent", "—", "-") else "portal")
    for book, number, portal, telem, expected, _ in ROWS
    if expected in ("covered", "contradicts")
    and "—" not in (portal, telem)
    and {portal, telem} & {"absent"}
]
ok("there are rows where only one design answers", len(CREDITED) >= 2, len(CREDITED))

for book, number, design in CREDITED:
    page, text = next(
        (p, t) for p, t in DESIGN_PAGES[design] if len(re.sub(r"\s+", " ", t).split()) > 40
    )
    flat = re.sub(r"\s+", " ", text)
    quote = next(
        (s.strip() for s in re.split(r"(?<=\.)\s+", flat) if len(s.split()) >= 8), flat[:160]
    )
    here = WHOLE[design].verify(quote, page)
    there = WHOLE[OTHER[design]].verify(quote, page)
    ok(
        f"{book} {number}: a quote from {design} verifies against {design}",
        here.verified,
        here.reason,
    )
    ok(
        f"{book} {number}: and does not verify against {OTHER[design]}",
        not there.verified,
        there.reason,
    )


# ---------------------------------------------------------------------------
print("\n5. Every expected project verdict survives verification and the guards")

CONFIDENCE = {"contradicts": 0.92, "covered": 0.88, "absent": 0.85, "partial": 0.80}


def judged(book: str, number: str, verdict: str, design: str) -> str:
    """The verdict that survives, given evidence a correct model would cite."""
    whole = WHOLE[design]
    if verdict == "absent":
        evidence: list[dict] = []
        unverified: list[tuple[str, str]] = []
    else:
        page, text = next(
            (p, t) for p, t in DESIGN_PAGES[design] if len(re.sub(r"\s+", " ", t).split()) > 40
        )
        flat = re.sub(r"\s+", " ", text)
        quote = next(
            (s.strip() for s in re.split(r"(?<=\.)\s+", flat) if len(s.split()) >= 8), flat[:160]
        )
        evidence, unverified = analyse._checked_quotes(
            {"evidence": [{"quote": quote, "page": page}]}, whole
        )
    return analyse._guard_document(
        verdict,
        CONFIDENCE[verdict],
        "The decisive fact, as the model put it.",
        evidence=evidence,
        unverified=unverified,
        fabricated=[],
        conflicted=False,
        clause_text=clause(book, number),
    )[0]


for book, number, portal, telem, expected, must in ROWS:
    # Judged on the design the project verdict comes from: the breaching one for
    # a contradiction, the answering one otherwise.
    design = "portal" if portal == expected else "telem" if telem == expected else "portal"
    got = judged(book, number, expected, design)
    ok(
        f"[{'MUST' if must else 'dir '}] {book} {number} -> {expected} (from {design})",
        got == expected,
        got,
    )


# ---------------------------------------------------------------------------
print("\n6. Clauses the key says no design engages with")
silent = [(b, n) for b, n, p, t, e, _ in ROWS if e == "absent"]
ok("the key has some", len(silent) >= 3, len(silent))
for book, number in silent:
    body = clause(book, number)
    ok(f"{book} {number} is a real clause in the standards", len(body) > 80, len(body))

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
