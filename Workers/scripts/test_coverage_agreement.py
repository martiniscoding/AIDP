"""Several reads of one design, reduced to what most of them saw.

No database and no model: `coverage.agree` is given reads that already went
through `check`, because what is under test is the reduction — which gaps
survive, which version of one is kept, what happens to the suggestions that
pointed at the ones that did not, and that nothing is quietly lost from the
counts.

    docker run --rm -v "$PWD":/w -w /w -e STAGE=analyse \\
      -e DATABASE_URL=postgresql://nobody@127.0.0.1:1/none \\
      --entrypoint python aidp-worker-test scripts/test_coverage_agreement.py
"""

from __future__ import annotations

import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from aidp import coverage  # noqa: E402

passed = failed = 0


def ok(name: str, condition: bool, extra: object = "") -> None:
    global passed, failed
    if condition:
        passed += 1
        print(f"  PASS {name}")
    else:
        failed += 1
        print(f"  FAIL {name} {extra}")


def gap(section: int, quote: str, what: str = "does a thing") -> dict:
    return {
        "section": section,
        "title": f"Section {section}",
        "headingPath": f"Design › Section {section}",
        "pageStart": section,
        "pageEnd": section,
        "what": what,
        "quote": quote,
        "page": section,
    }


def read(gaps: list[dict], suggestions: list[dict] | None = None, **counts) -> coverage.Checked:
    out = coverage.Checked()
    out.gaps = gaps
    out.suggestions = suggestions or []
    for name, value in counts.items():
        if name in out.dropped:
            out.dropped[name] = value
        else:
            out.corrected[name] = value
    return out


def suggestion(title: str, sections: list[int]) -> dict:
    return {"title": title, "covers": "something", "why": "because", "sections": sections}


print("\nWhat survives three reads")
READS = [
    read(
        [gap(4, "Card numbers are cached."), gap(5, "Sensors publish over MQTT."), gap(9, "Once.")],
        [suggestion("Payment card data", [4, 9]), suggestion("IoT devices", [5])],
        unverified=1,
    ),
    read(
        [gap(4, "Card numbers are cached for retries."), gap(5, "Sensors publish over MQTT.")],
        [suggestion("Payment Card Data", [4]), suggestion("IoT devices", [5])],
        unverified=2,
        lineQuote=1,
    ),
    read(
        [gap(4, "Card numbers are cached."), gap(5, "Sensors publish over MQTT.")],
        [suggestion("payment card data", [4]), suggestion("A name reached for once", [4])],
        alreadyJudged=1,
    ),
]
agreed = coverage.agree(READS, needed=2)
sections = [entry["section"] for entry in agreed.gaps]

ok("a gap every read found is kept", 4 in sections and 5 in sections, sections)
ok("a gap only one read found is dropped", 9 not in sections, sections)
ok("gaps come out in section order", sections == sorted(sections), sections)
ok(
    "the version most reads quoted is the one kept",
    agreed.gaps[0]["quote"] == "Card numbers are cached.",
    agreed.gaps[0]["quote"],
)
ok(
    "each gap says how many reads found it",
    [entry["reads"] for entry in agreed.gaps] == [3, 3],
    [entry["reads"] for entry in agreed.gaps],
)
ok(
    "refusals are summed over the reads, not taken from one",
    agreed.dropped["unverified"] == 3 and agreed.dropped["alreadyJudged"] == 1,
    agreed.dropped,
)
ok("rescues are summed too", agreed.corrected["lineQuote"] == 1, agreed.corrected)

titles = [entry["title"] for entry in agreed.suggestions]
ok(
    "the same standard proposed in several reads appears once",
    len(titles) == 2 and titles.count("Payment card data") <= 1,
    titles,
)
ok(
    "a suggestion keeps only the gaps that survived",
    agreed.suggestions[0]["sections"] == [4],
    agreed.suggestions[0],
)
ok(
    "a suggestion says how many reads proposed it",
    agreed.suggestions[0]["reads"] == 3,
    agreed.suggestions[0],
)
ok(
    "a standard only one read proposed is dropped, as a gap would be",
    "A name reached for once" not in titles,
    titles,
)

print("\nA suggestion left with nothing")
orphan = coverage.agree(
    [
        read([gap(4, "Kept.")], [suggestion("Only about nine", [9])]),
        read([gap(4, "Kept.")], []),
    ],
    needed=2,
)
ok("is dropped rather than shown pointing nowhere", orphan.suggestions == [], orphan.suggestions)

print("\nEdges")
ok("no reads at all yields nothing, and raises nothing", coverage.agree([], needed=1).gaps == [])
single = coverage.agree([read([gap(4, "Kept."), gap(5, "Also.")])], needed=1)
ok(
    "one read with one needed is that read",
    [entry["section"] for entry in single.gaps] == [4, 5] and single.gaps[0]["reads"] == 1,
    single.gaps,
)
none_agreed = coverage.agree([read([gap(4, "Once.")]), read([gap(5, "Once.")])], needed=2)
ok("reads that agree on nothing report nothing", none_agreed.gaps == [], none_agreed.gaps)

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
