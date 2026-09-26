"""The sample corpus, checked against the verdicts samples/ANSWER_KEY.md expects.

The key documents a correct verdict for 33 clauses across the two sample
designs, which is what makes samples/ an eval set rather than test data. A
model and a database are needed to produce those verdicts, and neither is
available here -- so what this asserts is everything the pipeline does *after*
the reply comes back, which is where the precision upgrade lives.

For each row the harness takes the clause text out of the real standard, the
page text out of the real design, and the reply a correct model would give,
and asserts the verdict that survives verification and the guards. A row fails
only when a guard eats a correct answer or lets a wrong one through. That will
not catch a model that reads a clause badly; it will catch the far likelier
regression of a threshold quietly moving.

Both failure modes the key calls worst have their own section: a contradiction
reported as covered on the strength of a diagram, and a confident absent on
something the design does address.

    docker run --rm -v "$PWD":/w -w /w -e STAGE=analyse \\
      -e DATABASE_URL=postgresql://nobody@127.0.0.1:1/none \\
      --entrypoint python aidp-worker-test tests/test_answer_key_audit.py
"""

from __future__ import annotations

import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import pymupdf  # noqa: E402

from aidp import whole_document  # noqa: E402
from aidp.stages import analyse  # noqa: E402

REPO = pathlib.Path(__file__).resolve().parents[2]
SAMPLES = REPO / "samples"

STANDARD = {
    "Architecture": SAMPLES / "standards" / "Solution_Architecture_Standards.pdf",
    "Data": SAMPLES / "standards" / "Data_Standards.pdf",
    "Security": SAMPLES / "standards" / "Security_Standards.pdf",
}
DESIGN = {
    "portal": SAMPLES / "designs" / "Customer_Portal_Modernisation_SAD.pdf",
    "telem": SAMPLES / "designs" / "Field_Telemetry_Ingestion_SAD.pdf",
}

passed = 0
failed = 0


def ok(name: str, condition: bool, detail: object = "") -> None:
    global passed, failed
    if condition:
        passed += 1
        print(f"  ok   {name}")
    else:
        failed += 1
        print(f"  FAIL {name}" + (f"  -> {detail!r}" if detail != "" else ""))


def read(path: pathlib.Path) -> list[tuple[int, str]]:
    """(page number, page text) for a sample PDF, as the parse stage would see it."""
    doc = pymupdf.open(path)
    try:
        # The generator writes a few glyphs the text layer returns as U+FFFD.
        # They are bullets and dashes; nothing a quote or a clause turns on.
        return [(i, page.get_text().replace("�", "-")) for i, page in enumerate(doc, 1)]
    finally:
        doc.close()


STANDARD_TEXT = {book: "\n".join(t for _, t in read(p)) for book, p in STANDARD.items()}
DESIGN_PAGES = {name: read(p) for name, p in DESIGN.items()}


def clause(book: str, number: str) -> str:
    """A clause's body, skipping its dotted-leader entry in the contents."""
    text = STANDARD_TEXT[book]
    for match in re.finditer(r"(?m)^" + re.escape(number) + r"\s+(?!\.)(\S.*)$", text):
        if "...." in match.group(0):
            continue
        return re.sub(r"\s+", " ", text[match.start() : match.start() + 1100]).strip()
    return ""


def parse_key() -> list[tuple[str, str, str, str, bool]]:
    """(design, book, clause, expected verdict, is it a must-get row) per table row."""
    rows: list[tuple[str, str, str, str, bool]] = []
    design: str | None = None
    must = False
    for line in (SAMPLES / "ANSWER_KEY.md").read_text(encoding="utf-8").splitlines():
        if line.startswith("##") and "Customer Portal Modernisation" in line:
            design = "portal"
        elif line.startswith("##") and "Field Telemetry Ingestion" in line:
            design = "telem"
        if line.startswith("### "):
            must = "Must get" in line
        match = re.match(
            r"\|\s*(Architecture|Data|Security)\s*§(\d+\.\d+)[^|]*\|\s*\*{0,2}(\w+)",
            line.strip(),
        )
        if match and design:
            rows.append((design, match.group(1), match.group(2), match.group(3), must))
    return rows


ROWS = parse_key()

# What a model that had read the document would report on a clear-cut row. The
# verdict is the key's; only the confidence is supplied, and it is above every
# floor so that a demotion here means a guard fired that should not have.
CONFIDENCE = {"contradicts": 0.92, "covered": 0.88, "absent": 0.85, "partial": 0.80}

# A description of the sample's own rasterised Figure 1, as a model would write
# it. Used to prove a diagram cannot carry a clause it is not about.
CONTEXT_DIAGRAM = (
    "Enterprise context diagram. Customer, billing and field domains are drawn as "
    "grouped boxes. Arrows show governed data flow passing through a central "
    "integration platform rather than directly between systems."
)


def judged(design: str, book: str, number: str, verdict: str) -> str:
    """The verdict that survives, given evidence a correct model would cite."""
    page, text = DESIGN_PAGES[design][1]
    whole = whole_document.build(
        design,
        [
            {"page": page, "kind": "text", "text": line.strip()}
            for line in text.splitlines()
            if line.strip()
        ],
        [],
    )
    if verdict == "absent":
        evidence: list[dict] = []
        unverified: list[tuple[str, str]] = []
    else:
        flat = re.sub(r"\s+", " ", text)
        quote = next(
            (s.strip() for s in re.split(r"(?<=\.)\s+", flat) if len(s.split()) >= 6),
            flat[:120],
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


print(
    f"ANSWER_KEY.md lists {len(ROWS)} rows "
    f"({sum(1 for r in ROWS if r[4])} must-get, {sum(1 for r in ROWS if not r[4])} directional)"
)

print("\nEvery clause the key names is in the standards")
for _, book, number, _, _ in ROWS:
    body = clause(book, number)
    ok(f"{book} {number} has a body", len(body) > 80, len(body))

print("\nEvery expected verdict survives verification and the guards")
for design, book, number, expected, must in ROWS:
    got = judged(design, book, number, expected)
    ok(f"[{'MUST' if must else 'dir '}] {design} {book} {number} -> {expected}",
       got == expected, got)

print("\nA contradiction cannot be covered by a diagram that is not about it")
for book, number, subject in (
    ("Data", "6.3", "encryption"),
    ("Data", "3.2", "single source of truth"),
    ("Data", "7.2", "resilience"),
    ("Architecture", "5.1", "event-driven integration"),
):
    body = clause(book, number)
    ok(
        f"a context diagram does not answer {book} {number} ({subject})",
        not analyse._figure_corroborates(body, CONTEXT_DIAGRAM, 1),
        sorted(analyse._keywords(body) & analyse._keywords(CONTEXT_DIAGRAM)),
    )

print("\nAn absent nobody is sure of does not reach the report")
for confidence, expected in ((0.85, "absent"), (0.50, "needs_review"), (0.30, "needs_review")):
    got, _ = analyse._guard_document(
        "absent",
        confidence,
        "Nothing in the document addresses it.",
        evidence=[],
        unverified=[],
        fabricated=[],
        conflicted=False,
        clause_text=clause("Data", "8.1"),
    )
    ok(f"absent at {confidence:.2f} -> {expected}", got == expected, got)

print("\nThe parser cases the key embeds on purpose")
architecture = pymupdf.open(STANDARD["Architecture"])
try:
    rasterised = [i for i, page in enumerate(architecture, 1) if page.get_images(full=True)]
finally:
    architecture.close()
ok("Architecture holds exactly one rasterised diagram", rasterised == [4], rasterised)
ok("and 1.3 is the section carrying it", "Figure 1" in clause("Architecture", "1.3"))
ok(
    "a diagram about that clause still corroborates it",
    analyse._figure_corroborates(clause("Architecture", "1.3"), CONTEXT_DIAGRAM, 1),
)

print("\nQuotes from the designs verify against the real page text")
for design, needle, verdict in (
    ("portal", "session state", "contradicts"),
    ("portal", "CustomerOrders", "contradicts"),
    ("portal", "multi-factor", "covered"),
    ("telem", "MQTT", "contradicts"),
    ("telem", "snake_case", "covered"),
):
    page, text = next(
        (p, t) for p, t in DESIGN_PAGES[design]
        if needle.lower() in re.sub(r"\s+", " ", t).lower()
    )
    flat = re.sub(r"\s+", " ", text)
    match = re.search(r"[^.]*(?:" + re.escape(needle) + r")[^.]*\.", flat, re.IGNORECASE)
    whole = whole_document.build(
        design,
        [
            {"page": page, "kind": "text", "text": line.strip()}
            for line in text.splitlines()
            if line.strip()
        ],
        [],
    )
    evidence, unverified = analyse._checked_quotes(
        {"evidence": [{"quote": (match.group(0) if match else needle).strip(), "page": page}]},
        whole,
    )
    ok(f"{design} p{page} {needle!r} verifies", len(evidence) == 1 and not unverified,
       (len(evidence), unverified))

print("\nAn invented quote is refused however confident the model is")
page, text = DESIGN_PAGES["portal"][1]
whole = whole_document.build(
    "portal",
    [
        {"page": page, "kind": "text", "text": line.strip()}
        for line in text.splitlines()
        if line.strip()
    ],
    [],
)
evidence, unverified = analyse._checked_quotes(
    {
        "evidence": [
            {"quote": "The system uses quantum-resistant lattice cryptography.", "page": page}
        ]
    },
    whole,
)
got, _ = analyse._guard_document(
    "covered",
    0.99,
    "Stated plainly.",
    evidence=evidence,
    unverified=unverified,
    fabricated=[],
    conflicted=False,
    clause_text=clause("Security", "2.2"),
)
ok("a quote in no document cannot carry a verdict", got == "needs_review", got)

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
