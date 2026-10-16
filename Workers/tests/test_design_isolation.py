"""Rival candidates are judged apart; one solution's designs are judged together.

The assurance review's deepest finding was that a compliant design can mask a
non-compliant one. Tracing it produced something more specific than "the
verdicts are merged": the prompt was contradicting itself.

`_SCOPE_RULE` tells the judge "a requirement met in any one of these designs is
met". That is correct and load-bearing when a proposal, an architecture deck and
a data model describe one solution between them — a clause answered in the
second file is not a gap in the first, which is the cross-document fix this
engine needs. `_purpose` then tells the same judge, in the same prompt, that
"the designs are alternatives rather than parts of one system" whenever the
reviewer said they were comparing candidates. Both instructions reached the
model together, and for a comparison the merge rule actively licensed the
contamination the review found.

So the project now stores that choice explicitly. Free-text descriptions never
switch the assessment mode; the default remains one solution assembled from
components.

Alternative projects now write a separate verdict per clause and design. The
scope and relationship are captured on the run so resuming it cannot silently
include a later upload or change how candidates are interpreted.

    docker run --rm -v "$PWD":/w -w /w -e STAGE=analyse \\
      -e DATABASE_URL=postgresql://nobody@127.0.0.1:1/none \\
      --entrypoint python aidp-worker-test tests/test_design_isolation.py
"""

from __future__ import annotations

import inspect
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from aidp.ai import llm  # noqa: E402
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


def flat(text: str) -> str:
    """Prompt text as one line, so assertions survive hard wrapping."""
    return " ".join(text.split())


COMPARISON = "Comparing two candidate B2B integration solutions to pick one."
ONE_SOLUTION = "A high-level integration blueprint for Project Emerald."


def prompt(purpose: str, designs: int, *, alternatives: bool = False) -> str:
    return llm._JUDGE_PROMPT.format(
        scope_rule=llm._scope_block(designs, alternatives=alternatives),
        document_context=(purpose + "\n") if purpose else "",
        reference="Integration Standards — 4.1",
        clause="Interfaces shall define protocol, payload structure and data format.",
        extracts='<extract id="c1" design="Candidate A">REST over HTTPS, JSON.</extract>',
        precedents="",
    )


# ---------------------------------------------------------------------------
print("\n1. The explicit project setting decides how its designs are read")

projects_file = pathlib.Path(__file__).resolve().parents[2].joinpath("AIDP/src/lib/ingest/projects.ts").read_text(encoding="utf-8")
ok("project settings persist the selected relationship", "designRelationship: input.designRelationship === \"alternatives\"" in projects_file)
ok("free-text purpose does not change scope", "reads_as_comparison" not in inspect.getsource(llm))


# ---------------------------------------------------------------------------
print("\n2. A comparison project stops merging the candidates")

cmp_prompt = flat(prompt(COMPARISON, 2, alternatives=True))
ok(
    "the merge instruction is gone",
    "met in any one of these designs is met" not in cmp_prompt,
)
ok(
    "and replaced by its opposite",
    "A requirement met in one candidate is NOT met in another" in cmp_prompt,
)
ok(
    "evidence may not cross between candidates",
    "Never let evidence from one design answer the clause for a different one" in cmp_prompt,
)
ok(
    "covered requires every candidate to satisfy the clause",
    '"covered" needs every candidate to satisfy the clause' in cmp_prompt,
)
ok(
    "and a shortfall names the candidate",
    "names which candidate falls short and how" in cmp_prompt,
)
ok(
    "the difference between candidates is called the useful output",
    "has to choose between them" in cmp_prompt,
)
ok(
    "a breach in any candidate still holds, and is attributed",
    "says which one" in cmp_prompt,
)


# ---------------------------------------------------------------------------
print("\n3. A one-solution project is untouched")

one_prompt = flat(prompt(ONE_SOLUTION, 2))
ok(
    "the merge rule still applies",
    "met in any one of these designs is met" in one_prompt,
)
ok("and the alternatives rule is absent", "NOT met in another" not in one_prompt)
ok(
    "a clause answered in the second file is still not a gap in the first",
    "Do not report it absent or partial because another design is silent" in one_prompt,
)

# A single design must be byte-for-byte what it was: its verdicts are tuned and
# cached against that exact prompt.
solo = prompt(ONE_SOLUTION, 1)
baseline = llm._JUDGE_PROMPT.replace("{scope_rule}", "").format(
    reference="Integration Standards — 4.1",
    clause="Interfaces shall define protocol, payload structure and data format.",
    extracts='<extract id="c1" design="Candidate A">REST over HTTPS, JSON.</extract>',
    precedents="",
    document_context=ONE_SOLUTION + "\n",
)
ok("a single-design prompt is unchanged, to the character", solo == baseline)


# ---------------------------------------------------------------------------
print("\n4. The flag reaches the model, not just the helper")

judge_src = inspect.getsource(llm.judge)
ok("the module-level judge takes it", "alternatives: bool = False" in judge_src)
ok("and forwards it to the client", "alternatives=alternatives," in judge_src)

analyse_src = inspect.getsource(analyse._judge_by_search)
ok(
    "the analyse stage follows the project's explicit relationship setting",
    "alternatives=scope.alternatives" in analyse_src,
)

# Every client implementation has to accept it, or a provider swap raises
# TypeError on the first clause of every run — the trap the comment in
# llm.judge already records for `document` and `designs`.
CLIENTS = ("GeminiLLM", "AnthropicLLM", "OpenRouterLLM")
ok("all three providers were found", all(hasattr(llm, c) for c in CLIENTS), CLIENTS)
for client in CLIENTS:
    sig = inspect.signature(getattr(getattr(llm, client), "judge"))
    ok(f"{client}.judge accepts alternatives", "alternatives" in sig.parameters, sig)
ok(
    "and the Protocol declares it, so a new provider must too",
    "alternatives" in inspect.signature(llm.LLM.judge).parameters,
)


# ---------------------------------------------------------------------------
print("\n5. Findings and runs preserve candidate boundaries")

schema = pathlib.Path(__file__).resolve().parents[2] / "AIDP" / "prisma" / "schema.prisma"
schema_text = schema.read_text(encoding="utf-8")
analyse_file = pathlib.Path(analyse.__file__).read_text(encoding="utf-8")
designs_file = pathlib.Path(sys.modules["aidp.designs"].__file__).read_text(encoding="utf-8")
projects_file = pathlib.Path(__file__).resolve().parents[2].joinpath("AIDP/src/lib/ingest/projects.ts").read_text(encoding="utf-8")
ok("findings are unique per run, clause and design", "@@unique([runId, clauseId, designKey])" in schema_text)
ok("each finding records its source design", '"documentId","designKey"' in analyse_file)
ok("alternative clauses are scheduled once per design", "for design in scope.designs" in analyse_file and "for clause in clauses" in analyse_file)
ok("resumes restrict scope to design IDs captured on the run", "designIds" in designs_file and 'ANY(%(scope_ids)s::text[])' in designs_file)
ok("new project runs snapshot ready and unready designs separately", "designIds: ready.map((design) => design.id)" in projects_file and "unreadyDesignIds" in projects_file)
ok("new project runs snapshot the relationship", "designRelationship: project.designRelationship" in projects_file)
# What must keep holding:
ok(
    "evidence still carries the design it came from",
    '"documentId": c.document_id' in inspect.getsource(analyse._judge_by_search),
)
ok(
    "each design is still searched in its own window",
    "_woven" in inspect.getsource(sys.modules["aidp.retrieval"]),
)
ok(
    "and the extracts are labelled per design for a project run",
    "named=len(scope.designs) > 1" in inspect.getsource(analyse._judge_by_search),
)


print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
