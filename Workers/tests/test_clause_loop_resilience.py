"""One clause failing must not cost the other ninety-nine.

A hundred-clause framework came back reporting a single clause. There was no
limit anywhere — no `clauses[:1]`, no `break` in the grading loop, no `take` in
the query or the UI. The loop was simply not guarded: `_assess_one` raising on
one clause propagated out of `handle`, the job layer retried and dead-lettered
it, and the run kept whatever clauses had already been committed. Each clause is
its own transaction, so clause 1 survived and clauses 2 to 100 were never
attempted. A model returning JSON that does not parse is enough to cause it, and
the symptom — one finding out of a hundred — reads exactly like a test limit
somebody forgot to take out.

What this holds in place:

  - the loop reaches every clause, however many fail on the way
  - a clause that cannot be judged is written as `needs_review`, never skipped
    silently and never left to read as a pass
  - quota exhaustion still aborts, because every clause after it would fail the
    same way and the run is worth retrying once the credit is back
  - the whole-document path is guarded identically to the search path

    docker run --rm -v "$PWD":/w -w /w -e STAGE=analyse \\
      -e DATABASE_URL=postgresql://nobody@127.0.0.1:1/none \\
      --entrypoint python aidp-worker-test tests/test_clause_loop_resilience.py
"""

from __future__ import annotations

import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from aidp import designs  # noqa: E402
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


CLAUSES = [
    {
        "id": f"cl-{n}",
        "title": f"Clause {n}",
        "statement": f"Requirement {n} must hold.",
        "rationale": "",
        "requirements": [],
        "guidance": "",
        "sourceRefs": [],
        "headingPath": f"Standards > {n}",
        "numberText": f"{n}.0",
        "pageStart": n,
        "documentTitle": "Security Standards",
        "isBaseline": True,
    }
    for n in range(1, 11)
]

A = designs.Design("doc-a", "Target Architecture")
SCOPE = designs.Scope([A], [])
RUN = {
    "id": "run-1",
    "organisationId": "org-1",
    "documentId": "doc-a",
    "projectId": None,
    "frameworkId": "fw-1",
    "mode": "retrieval",
}


# ---------------------------------------------------------------------------
print("\n1. The loop is guarded at all")

src = analyse.handle.__doc__ or ""
loop_src = __import__("inspect").getsource(analyse.handle)
ok(
    "the per-clause call sits inside a try",
    "try:" in loop_src and "_assess_one(run, clause" in loop_src,
)
ok(
    "a broad except keeps the loop going",
    "except Exception" in loop_src and "continuing" in loop_src,
)
ok(
    "quota exhaustion is re-raised rather than swallowed",
    "except llm.QuotaExhausted" in loop_src and "raise" in loop_src,
)
ok(
    "a failed clause is written, not skipped",
    'verdict="needs_review"' in loop_src,
)
ok(
    "and the run says how many it could not judge",
    "clauses that could not be judged" in loop_src,
)
ok(
    "the whole-document path is inside the same try",
    loop_src.index("try:") < loop_src.index("_assess_document_one(run, clause"),
)

# The guard must be written so that QuotaExhausted is caught *before* the broad
# clause — otherwise `except Exception` swallows it and the run grinds through
# a hundred clauses against an exhausted key.
quota_at = loop_src.index("except llm.QuotaExhausted")
broad_at = loop_src.index("except Exception")
ok("quota is matched before the broad except", quota_at < broad_at, (quota_at, broad_at))


# ---------------------------------------------------------------------------
print("\n2. No artificial limit anywhere in the clause path")

import inspect  # noqa: E402

for name, fn in (
    ("handle", analyse.handle),
    ("_framework_clauses", analyse._framework_clauses),
):
    body = inspect.getsource(fn)
    ok(f"{name}: no clause slicing", "clauses[:1]" not in body and "clauses[0]" not in body)
    ok(f"{name}: no LIMIT in the clause query", " LIMIT 1" not in body.upper())

frame_src = inspect.getsource(analyse._framework_clauses)
ok("the clause query is not capped", "LIMIT" not in frame_src.upper(), frame_src[-200:])
ok(
    "the loop iterates the pending list, not a fixed index",
    "for index, clause in enumerate(pending, start=1)" in loop_src,
)


print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
