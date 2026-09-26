"""Coverage quotes made of table cells and diagram labels, without a database or a model.

The sections are built from the lines a real design (the LCL proposal) was parsed
into, and the quotes are ones a model really gave for it — the ones the phrase
check refused on one run and kept on another. What this proves: a quote made of
the section's own lines is kept and shown as those lines; a quote with one line
the design does not have, or in the wrong section, is still refused; and a gap
quoted this way is still dropped when a finding already cited its words.

    docker run --rm -v "$PWD/Workers":/w -w /w -e STAGE=analyse \\
      -e DATABASE_URL=postgresql://nobody@127.0.0.1:1/none \\
      --entrypoint python workers-analyse scripts/test_coverage_lines.py
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
    {"ordinal": 16, "title": "Proposed Tools & Technologies",
     "headingPath": "LCL › Proposed Tools & Technologies", "pageStart": 16, "pageEnd": 16},
    {"ordinal": 18, "title": "Dev-Sec-Ops CI/CD Pipeline on PCF",
     "headingPath": "LCL › Dev-Sec-Ops CI/CD Pipeline on PCF", "pageStart": 18, "pageEnd": 18},
    {"ordinal": 21, "title": "Delivery Methodology",
     "headingPath": "LCL › Delivery Methodology", "pageStart": 21, "pageEnd": 21},
]


def row(page: int, section: int, text: str, kind: str = "text") -> dict:
    return {"page": page, "kind": kind, "text": text, "sectionOrdinal": section}


ROWS = [
    row(16, 16, "Proposed Tools & Technologies", "heading"),
    row(16, 16, "Area | Tools | Tools Description"),
    row(16, 16, "Development & Code Quality | IntelliJ IDEA, Maven, Junit, SonarQube"),
    row(16, 16, "Build & Compile | Bit-Bucket, Git, Jenkins Cloud Bees, Docker, NexusOSS,"),
    row(16, 16, "ALM"),
    row(16, 16, "Frameworks & Libraries | Angular, HTML5, SpringBoot, Java"),
    row(16, 16, "Automation Testing | Selenium, DevTest, HP ALM"),
    row(16, 16, "Security | Harbor"),
    row(16, 16, "Deployment | Spinnaker"),
    row(16, 16, "Monitoring |"),
    row(16, 16, "AppDynamics"),
    row(18, 18, "Dev-Sec-Ops CI/CD Pipeline on PCF", "heading"),
    row(18, 18, "On Premises"),
    row(18, 18, "Build Failure"),
    row(18, 18, "Artifact repository"),
    row(18, 18, "Build and Test(Junit)"),
    row(18, 18, "Source Code Repository"),
    row(18, 18, "Trusted Image"),
    row(18, 18, "Deployment"),
    row(18, 18, "Vulnerability Scanning"),
    row(18, 18, "Authentication"),
    row(18, 18, "Audit log"),
    row(21, 21, "Delivery MethodologyAgile Delivery with a “2 Week Sprint” Cycle", "heading"),
    row(21, 21, "2 Weeks"),
]
SECTIONS = coverage.group(HEADS, ROWS)
WHOLE = whole_document.build("LCL B2B Proposal", ROWS, [])


def gap(section: int, quote: str, page: int | None = None, what: str = "A part") -> dict:
    return {"section": section, "page": page if page is not None else section, "what": what,
            "quote": quote}


def one(item: dict, cited: list[str] | None = None) -> coverage.Checked:
    return coverage.check({"gaps": [item]}, SECTIONS, WHOLE, cited or [])


print("\nQuotes the phrase check refused on a real run, now kept")
for label, item, expected in (
    ("a short table row", gap(16, "Security | Harbor"), "Security | Harbor"),
    ("another", gap(16, "Deployment | Spinnaker"), "Deployment | Spinnaker"),
    ("diagram labels a line or two apart, shown in the design's order",
     gap(18, "Build and Test(Junit)\nSource Code Repository\nVulnerability Scanning\n"
             "Authentication\nAudit log"),
     "Build and Test(Junit) · Source Code Repository · Vulnerability Scanning · "
     "Authentication · Audit log"),
    ("a short table row the parse split over two lines",
     gap(16, "Monitoring | AppDynamics"), "Monitoring | · AppDynamics"),
    ("the same row with different punctuation", gap(16, "Security - Harbor"), "Security | Harbor"),
):
    checked = one(item)
    kept = checked.gaps[0]["quote"] if checked.gaps else None
    ok(label, kept == expected, kept)
    ok("  counted as quoted by its lines, not as set aside",
       checked.corrected["lineQuote"] == 1 and sum(checked.dropped.values()) == 0,
       (checked.corrected, checked.dropped))

print("\nStill refused")
for label, item in (
    ("one invented line among real ones", gap(16, "Security | Harbor\nSecurity | Vault")),
    ("a single word", gap(16, "Security")),
    # A number is not a word here: this row is a delivery estimate, and one of
    # these coming and going is what moved the reported count between reads.
    ("a line that is a number and a unit", gap(21, "2 Weeks")),
    ("part of a line that is too short to identify it", gap(16, "Area | Tools")),
    ("real lines, but claimed for the wrong section", gap(18, "Security | Harbor")),
    ("an empty quote", gap(16, "")),
    ("words the design does not contain", gap(16, "Secrets | HashiCorp Vault")),
):
    checked = one(item)
    ok(label, not checked.gaps and checked.corrected["lineQuote"] == 0, checked.gaps)

print("\nThe ordinary path is untouched")
split = one(gap(16, "Build & Compile | Bit-Bucket, Git, Jenkins Cloud Bees, Docker, NexusOSS, ALM"))
ok("a long row split over two lines is kept by the phrase check already, as before",
   split.gaps and split.corrected["lineQuote"] == 0, (split.gaps, split.corrected))
normal = one(gap(16, "Frameworks & Libraries | Angular, HTML5, SpringBoot, Java"))
ok("a long enough phrase is kept by the phrase check, not by lines",
   normal.gaps and normal.corrected["lineQuote"] == 0
   and normal.gaps[0]["quote"] == "Frameworks & Libraries | Angular, HTML5, SpringBoot, Java",
   (normal.gaps, normal.corrected))
elsewhere = coverage.check(
    {"gaps": [gap(18, "Frameworks & Libraries | Angular, HTML5, SpringBoot, Java")]},
    SECTIONS, WHOLE, [],
)
ok("words found in another section are still refused as the wrong section",
   not elsewhere.gaps and elsewhere.dropped["outsideSection"] == 1, elsewhere.dropped)

print("\nA gap quoted by its lines is still checked against the findings")
labels = ("Build and Test(Junit)\nSource Code Repository\nVulnerability Scanning\n"
          "Authentication\nAudit log")
cited = [whole_document.normalise(
    "Build and Test(Junit) Source Code Repository Vulnerability Scanning Authentication Audit log"
)]
judged = one(gap(18, labels), cited)
ok("dropped when a finding already cited those words",
   not judged.gaps and judged.dropped["alreadyJudged"] == 1, judged.dropped)

print("\nWhat is stored")
stored = coverage._outcome("complete", None, gaps=[], dropped={"unverified": 0},
                           corrected={"lineQuote": 3})
ok("the replacements are stored apart from the refusals",
   stored["corrected"] == {"lineQuote": 3} and "lineQuote" not in stored["dropped"])
page = one(gap(16, "Security | Harbor", page=99)).gaps[0]["page"]
ok("a page the section does not have is replaced by the section's page", page == 16, page)

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
