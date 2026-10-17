"""Grouping findings that share a cause — and refusing the groups that are wrong.

One real run of 61 clauses produced twelve contradictions from five facts: five
findings for one application reading another's database directly, two for
credentials in a configuration file, two for a single undifferentiated code
unit, two for missing observability, one for synchronous integration. The
reviewer saw twelve problems and planned twelve pieces of work, and three of
the findings carried the same remediation sentence word for word.

A model decides which findings share a cause, because that is a judgement and
not a string match. Everything it says is then checked, and this is where that
checking is pinned down. Almost every case below is about *refusing* something:
a grouping the reviewer cannot see is worse than no grouping at all, because a
finding quietly filed under the wrong cause is a finding they will not read.

What this proves:

  · a sound answer survives intact, with the right findings in the right group;
  · an index for a finding this run does not have is dropped, and its group
    survives without it;
  · a finding claimed by two groups stays in the first;
  · a group of fewer than two members is not a group;
  · nothing here can change a verdict, because nothing here writes a finding;
  · a model that returns nonsense costs the report its groups and nothing else.

No database and no model.

    docker run --rm -v "$PWD":/repo -w /repo/Workers -e STAGE=analyse \
      -e DATABASE_URL=postgresql://nobody@127.0.0.1:1/none \
      --entrypoint python workers-analyse tests/test_rootcause.py
"""

from __future__ import annotations

import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from aidp import rootcause  # noqa: E402

passed = 0
failed = 0


def ok(name: str, condition: bool, extra: object = "") -> None:
    global passed, failed
    if condition:
        passed += 1
        print(f"  PASS {name}")
    else:
        failed += 1
        print(f"  FAIL {name}", extra)


# The real shape, from run cmvc9y2hp000008ifpfdqbpx6.
ROWS = [
    {"id": "f1", "clauseRef": "r1", "clauseTitle": "Principle 6 – Interoperability",
     "verdict": "contradicts", "rationale": "WAH queries the Timekeeping DB directly."},
    {"id": "f2", "clauseRef": "r2", "clauseTitle": "Policy 5 – No Direct DB Coupling",
     "verdict": "contradicts", "rationale": "RCLP writes to shared tables."},
    {"id": "f3", "clauseRef": "r3", "clauseTitle": "Abstract System of Record",
     "verdict": "contradicts", "rationale": "Direct database access to a System of Record."},
    {"id": "f4", "clauseRef": "r4", "clauseTitle": "Principle 2 – Security by Design",
     "verdict": "contradicts", "rationale": "Credentials are stored in a configuration file."},
    {"id": "f5", "clauseRef": "r5", "clauseTitle": "Secure by Design",
     "verdict": "contradicts", "rationale": "No approved secret management."},
]

SOUND = {
    "groups": [
        {"label": "Cross-application database coupling",
         "summary": "WAH reads the Timekeeping DB directly and RCLP writes shared tables.",
         "fix": "Replace direct DB access with a governed API or ETL feed.",
         "findings": [1, 2, 3]},
        {"label": "Credentials in configuration files",
         "summary": "RCLP keeps credentials in a config file with no secret manager.",
         "fix": "Move them into approved secret storage and rotate.",
         "findings": [4, 5]},
    ]
}

print("\nA sound answer survives intact")
got = rootcause._clean(SOUND, ROWS)
ok("both groups are kept", len(got.groups) == 2, len(got.groups))
ok(
    "members are stored as finding ids, not the prompt's indices",
    got.groups[0]["findings"] == ["f1", "f2", "f3"],
    got.groups[0]["findings"],
)
ok("the second group keeps its own members", got.groups[1]["findings"] == ["f4", "f5"])
ok("the label is carried through", got.groups[0]["label"].startswith("Cross-application"))
ok("so is the single fix the group shares", "governed API" in got.groups[0]["fix"])
ok("and nothing was dropped", sum(got.dropped.values()) == 0, got.dropped)
ok("the whole thing reports itself complete", got.as_json()["state"] == "complete")

print("\nA finding this run does not have is refused")
invented = {"groups": [{"label": "Coupling", "summary": "s", "fix": "f",
                        "findings": [1, 2, 99]}]}
got = rootcause._clean(invented, ROWS)
ok("the invented member is dropped", got.groups[0]["findings"] == ["f1", "f2"], got.groups)
ok("and counted", got.dropped["unknown_finding"] == 1, got.dropped)
ok(
    "the group survives, because it is still true of the two that are real",
    len(got.groups) == 1,
)
for bad in (0, -1, 6, "x", None):
    out = rootcause._clean(
        {"groups": [{"label": "L", "summary": "", "fix": "", "findings": [1, 2, bad]}]}, ROWS
    )
    ok(f"index {bad!r} is refused", out.groups[0]["findings"] == ["f1", "f2"], out.groups)

print("\nOne cause per finding")
overlapping = {
    "groups": [
        {"label": "First", "summary": "", "fix": "", "findings": [1, 2]},
        {"label": "Second", "summary": "", "fix": "", "findings": [2, 3, 4]},
    ]
}
got = rootcause._clean(overlapping, ROWS)
ok("the first claim wins", got.groups[0]["findings"] == ["f1", "f2"])
ok("and the second keeps only what was left", got.groups[1]["findings"] == ["f3", "f4"])
ok("the double claim is counted", got.dropped["already_grouped"] == 1, got.dropped)
ok(
    "no finding appears in two groups",
    len([f for g in got.groups for f in g["findings"]])
    == len({f for g in got.groups for f in g["findings"]}),
)
ok(
    "a member listed twice in one group counts once",
    rootcause._clean(
        {"groups": [{"label": "L", "summary": "", "fix": "", "findings": [1, 1, 2]}]}, ROWS
    ).groups[0]["findings"]
    == ["f1", "f2"],
)

print("\nA group of one is not a group")
ok(
    "a single member is refused",
    rootcause._clean(
        {"groups": [{"label": "Lonely", "summary": "", "fix": "", "findings": [1]}]}, ROWS
    ).groups
    == [],
)
ok(
    "so is a group emptied by the checks above",
    rootcause._clean(
        {"groups": [{"label": "L", "summary": "", "fix": "", "findings": [98, 99]}]}, ROWS
    ).groups
    == [],
)
ok(
    "and a group with no label, however many members",
    rootcause._clean(
        {"groups": [{"label": "   ", "summary": "s", "fix": "f", "findings": [1, 2]}]}, ROWS
    ).groups
    == [],
)

print("\nNonsense costs the groups and nothing else")
for raw in ({}, {"groups": None}, {"groups": "nope"}, {"groups": [None, 7, "x"]}):
    out = rootcause._clean(raw, ROWS)
    ok(f"{str(raw)[:28]:30} → no groups, no crash", out.groups == [])
ok(
    "a label longer than the row is cut, not refused",
    len(
        rootcause._clean(
            {"groups": [{"label": "x" * 500, "summary": "y" * 900, "fix": "z" * 900,
                         "findings": [1, 2]}]},
            ROWS,
        ).groups[0]["label"]
    )
    <= rootcause._MAX_LABEL,
)

print("\nThe prompt shows findings by number, never by id")
rendered = rootcause._render(ROWS)
ok("every finding is numbered", all(f"[{n}]" in rendered for n in range(1, 6)))
ok("the verdict is on the line", "contradicts" in rendered)
ok(
    "no database id reaches the model",
    not any(row["id"] in rendered for row in ROWS),
    rendered[:120],
)

print("\nWhat it will and will not look at")
ok("covered is not work to group", "covered" not in rootcause._WORK)
ok("neither is not_applicable", "not_applicable" not in rootcause._WORK)
for verdict in ("contradicts", "absent", "partial", "not_assessable", "needs_review"):
    ok(f"{verdict} is", verdict in rootcause._WORK)

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
