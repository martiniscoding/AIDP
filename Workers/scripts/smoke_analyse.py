"""Exercise the analyse stage against the real database, with the model stubbed.

What this can prove without an API key: the clause loop, the SQL, the guards
that demote unsupported verdicts, resumability after a crash, and progress
accounting. What it cannot prove is judgement quality — whether "absent" really
means absent. That needs real documents and real model calls, and it is what the
eval set is for.

The guards are the point. A compliance tool that is confidently wrong at scale
is worse than one that admits uncertainty, so each demotion is asserted here:

  · covered/partial/contradicts with no cited evidence  → needs_review
  · absent on top of weak retrieval                     → needs_review
  · absent with low confidence                          → needs_review
  · an unrecognised verdict string                      → needs_review
  · a decisive verdict resting only on a figure         → needs_review

That last one is the figure-review guarantee: a diagram description is a model's
reading of an image, not text from the page, and it may corroborate a verdict
but never carry one alone.

    docker run --rm -v "$PWD":/w -w /w \\
      -e STAGE=analyse -e DATABASE_URL="$DIRECT_DATABASE_URL" \\
      -e GEMINI_API_KEY=stub \\
      --entrypoint python aidp-worker:dev scripts/smoke_analyse.py
"""

from __future__ import annotations

import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from aidp import db, retrieval  # noqa: E402
from aidp.config import get_config  # noqa: E402
from aidp.queue import Job  # noqa: E402
from aidp.stages import analyse  # noqa: E402

failures: list[str] = []
DIMS = 1024


def check(label: str, condition: bool, detail: str = "") -> None:
    suffix = f"  — {detail}" if not condition and detail else ""
    print(f"  [{'PASS' if condition else 'FAIL'}] {label}{suffix}")
    if not condition:
        failures.append(label)


# --- stubs -------------------------------------------------------------------

# Every query embeds to the same vector, so dense ranking is stable and the
# lexical half is what varies the fused score — which is how the weak-retrieval
# guard gets exercised deterministically.
def _stub_embed(texts, input_type="document"):  # noqa: ARG001
    return [[0.1] * DIMS for _ in texts]


_scripted: dict[str, dict] = {}


def _stub_judge(
    *, reference: str, clause: str, extracts: str, precedents: str = "", document: str = ""
):  # noqa: ARG001
    # Same signature as `llm.judge`. When the analyse stage began passing
    # `document=`, a stub without it raised TypeError on every clause — exactly
    # the failure the real wrapper had, and this test hid it instead of catching it.
    # Longest key first. Matching on substrings otherwise lets one clause name
    # shadow another ("grounded-covered" contains no other key, but the earlier
    # "cited-covered" was a substring of "uncited-covered" and silently returned
    # the wrong script).
    for key in sorted(_scripted, key=len, reverse=True):
        if key in clause:
            return _scripted[key]
    return {"verdict": "needs_review", "confidence": 0.1, "rationale": "no script", "evidence": []}


_confirmations: list[str] = []


def _stub_confirm(*, document: str, clauses: str):
    """The re-read of everything the search called absent, answered by number.

    One clause is answered with words that are in the stored pages, one with
    words that are not. The analyse stage is expected to tell them apart.
    """
    _confirmations.append(clauses)
    assert "=== page 1 ===" in document, "the re-read must be given the stored page text"

    blocks: dict[int, str] = {}
    current: int | None = None
    for line in clauses.splitlines():
        head = line[1 : line.index("]")] if line.startswith("[") and "]" in line else ""
        if head.isdigit():
            current = int(head)
            blocks[current] = line
        elif current is not None:
            blocks[current] += "\n" + line

    replies = []
    for number, block in blocks.items():
        if "recovered-absent" in block:
            replies.append(
                {
                    "clause": number,
                    "verdict": "partial",
                    "quote": "Recovery codes are printed once and stored in the corporate vault.",
                    "page": 2,
                    "rationale": "The vault is named; rotation is not.",
                }
            )
        elif "invented-quote" in block:
            replies.append(
                {
                    "clause": number,
                    "verdict": "covered",
                    "quote": "Enrolment events are streamed to the central SIEM.",
                    "page": 2,
                    "rationale": "Words that are nowhere in the document.",
                }
            )
        else:
            replies.append(
                {
                    "clause": number,
                    "verdict": "absent",
                    "quote": "",
                    "page": None,
                    "rationale": "Nothing in the document addresses it.",
                }
            )
    return {"clauses": replies}


def main() -> int:
    marker = uuid.uuid4().hex[:10]
    org = db.new_id()
    ref_doc, sub_doc = db.new_id(), db.new_id()
    section = db.new_id()
    framework, run_id, job_id = db.new_id(), db.new_id(), db.new_id()
    model = get_config().embedding_model

    retrieval.embeddings.embed_all = _stub_embed  # type: ignore[assignment]
    analyse.llm.judge = _stub_judge  # type: ignore[assignment]
    analyse.llm.confirm_absent = _stub_confirm  # type: ignore[assignment]
    analyse.llm.available = lambda: True  # type: ignore[assignment]

    print(f"\nThrowaway organisation smoke-{marker}\n")

    try:
        # --- seed ------------------------------------------------------------
        with db.transaction() as conn:
            db.execute(
                conn,
                'INSERT INTO "organisation" ("id","name","slug","updatedAt")'
                " VALUES (%s,%s,%s,now())",
                (org, f"Smoke {marker}", f"smoke-{marker}"),
            )
            for doc_id, role, title in (
                (ref_doc, "reference", "Reference Standards"),
                (sub_doc, "assessed", "Submitted Design"),
            ):
                db.execute(
                    conn,
                    """
                    INSERT INTO "document"
                        ("id","organisationId","role","title","storageKey","byteSize",
                         "sha256","status","updatedAt")
                    VALUES (%s,%s,%s,%s,%s,1,%s,'ready',now())
                    """,
                    (doc_id, org, role, title, f"k/{doc_id}", f"{marker}-{role}"),
                )

            db.execute(
                conn,
                """
                INSERT INTO "document_section"
                    ("id","documentId","ordinal","numberText","title","headingPath","depth")
                VALUES (%s,%s,1,'3.2','Authentication','Reference › 3.2 Authentication',2)
                """,
                (section, ref_doc),
            )

            # Five clauses, one per behaviour under test. The title is the hook
            # the stubbed judge scripts against.
            clauses = [
                ("grounded-covered", "MFA must be enforced for administrative access"),
                ("uncited-covered", "Session state must be externalised"),
                ("absent-weak", "Zzyzx quorum thresholds must be ratified"),
                ("absent-lowconf", "MFA must be reviewed annually"),
                ("bogus-verdict", "MFA must be logged"),
                ("figure-only", "The architecture must show an integration layer"),
                # Both come back "absent" from the search with strong retrieval and
                # high confidence, so they survive the guards and reach the re-read.
                ("recovered-absent", "MFA recovery codes must be stored securely"),
                ("invented-quote", "MFA enrolment must be logged centrally"),
            ]
            for i, (title, statement) in enumerate(clauses, start=1):
                db.execute(
                    conn,
                    """
                    INSERT INTO "clause"
                        ("id","sectionId","ordinal","title","statement","requirements")
                    VALUES (%s,%s,%s,%s,%s,%s)
                    """,
                    (db.new_id(), section, i, title, statement, ["a requirement"]),
                )

            # Two chunks in the submitted document. Both mention MFA, so a
            # clause about MFA matches lexically as well as densely; the
            # "Zzyzx" clause matches neither, which is the weak case.
            chunk_ids = []
            for i, text in enumerate(
                [
                    "Design 4.2 Authentication. Administrative access uses MFA via the "
                    "identity provider.",
                    "Design 6.1 Sessions. MFA tokens are cached in application memory "
                    "for the session.",
                ],
                start=1,
            ):
                cid = db.new_id()
                chunk_ids.append(cid)
                db.execute(
                    conn,
                    """
                    INSERT INTO "chunk"
                        ("id","organisationId","documentId","sourceKind","ordinal",
                         "headingPath","text","contentHash")
                    VALUES (%s,%s,%s,'clause',%s,%s,%s,%s)
                    """,
                    (cid, org, sub_doc, i, f"Submitted Design › {i}", text, f"h{i}{marker}"),
                )
                db.execute(
                    conn,
                    'INSERT INTO "embedding" ("id","chunkId","model","dims","vector")'
                    " VALUES (%s,%s,%s,%s,%s::vector)",
                    (db.new_id(), cid, model, DIMS, "[" + ",".join(["0.1"] * DIMS) + "]"),
                )

            db.execute(
                conn,
                'INSERT INTO "framework" ("id","organisationId","name","version","updatedAt")'
                " VALUES (%s,%s,'Smoke',1,now())",
                (framework, org),
            )
            db.execute(
                conn,
                'INSERT INTO "framework_document" ("frameworkId","documentId") VALUES (%s,%s)',
                (framework, ref_doc),
            )
            # A figure-derived chunk: generated text, indistinguishable from a
            # quotation once it is a chunk. The guard exists for exactly this.
            fig_chunk = db.new_id()
            chunk_ids.append(fig_chunk)
            db.execute(
                conn,
                """
                INSERT INTO "chunk"
                    ("id","organisationId","documentId","sourceKind","sourceId","ordinal",
                     "headingPath","text","contentHash")
                VALUES (%s,%s,%s,'figure',%s,99,%s,%s,%s)
                """,
                (
                    fig_chunk, org, sub_doc, "fig-" + marker,
                    "Submitted Design › Figure",
                    "Figure 1. The diagram shows an integration layer between the "
                    "portal and the billing engine.",
                    "hf" + marker,
                ),
            )
            db.execute(
                conn,
                'INSERT INTO "embedding" ("id","chunkId","model","dims","vector")'
                " VALUES (%s,%s,%s,%s,%s::vector)",
                (db.new_id(), fig_chunk, model, DIMS, "[" + ",".join(["0.1"] * DIMS) + "]"),
            )

            # The design's pages, which the re-read of anything absent works from.
            # The search only ever sees the chunks above; these are the whole text.
            for ordinal, (page, text) in enumerate(
                [
                    (1, "Design 4.2 Authentication. Administrative access uses MFA via the "
                        "identity provider."),
                    (2, "Recovery codes are printed once and stored in the corporate vault."),
                    (2, "Enrolment events are written to the local application log only."),
                ]
            ):
                db.execute(
                    conn,
                    """
                    INSERT INTO "source_line"
                        ("id","documentId","ordinal","ref","kind","page","text")
                    VALUES (%s,%s,%s,%s,'text',%s,%s)
                    """,
                    (db.new_id(), sub_doc, ordinal, f"L{ordinal + 1}", page, text),
                )

            db.execute(
                conn,
                """
                INSERT INTO "assessment_run"
                    ("id","organisationId","documentId","frameworkId","state","totalClauses")
                VALUES (%s,%s,%s,%s,'queued',8)
                """,
                (run_id, org, sub_doc, framework),
            )
            db.execute(
                conn,
                """
                INSERT INTO "job"
                    ("id","organisationId","documentId","stage","state","correlationId",
                     "payload","updatedAt")
                VALUES (%s,%s,%s,'analyse','leased',%s,%s,now())
                """,
                (job_id, org, sub_doc, str(uuid.uuid4()), f'{{"runId":"{run_id}"}}'),
            )

        # --- script the judge -------------------------------------------------
        with db.connection() as conn:
            first_chunk = chunk_ids[0]
        _scripted.update(
            {
                "grounded-covered": {
                    "verdict": "covered",
                    "confidence": 0.9,
                    "rationale": "MFA is specified.",
                    "evidence": [first_chunk],
                },
                "uncited-covered": {
                    "verdict": "covered",
                    "confidence": 0.95,
                    "rationale": "Claimed without citing anything.",
                    "evidence": [],
                },
                "absent-weak": {
                    "verdict": "absent",
                    "confidence": 0.99,
                    "rationale": "Not mentioned.",
                    "evidence": [],
                },
                "absent-lowconf": {
                    "verdict": "absent",
                    "confidence": 0.20,
                    "rationale": "Probably missing.",
                    "evidence": [],
                },
                "bogus-verdict": {
                    "verdict": "definitely-fine",
                    "confidence": 0.8,
                    "rationale": "Invented a verdict.",
                    "evidence": [first_chunk],
                },
                "figure-only": {
                    "verdict": "covered",
                    "confidence": 0.95,
                    "rationale": "The diagram shows it.",
                    "evidence": [chunk_ids[-1]],
                },
                "recovered-absent": {
                    "verdict": "absent",
                    "confidence": 0.9,
                    "rationale": "The extracts say nothing about recovery codes.",
                    "evidence": [],
                },
                "invented-quote": {
                    "verdict": "absent",
                    "confidence": 0.9,
                    "rationale": "The extracts say nothing about enrolment logging.",
                    "evidence": [],
                },
            }
        )

        # --- run --------------------------------------------------------------
        job = Job(
            id=job_id,
            organisation_id=org,
            document_id=sub_doc,
            stage="analyse",
            attempts=1,
            correlation_id=str(uuid.uuid4()),
            payload={"runId": run_id},
        )
        analyse.handle(job, lambda: None)

        with db.connection() as conn:
            rows = db.query(
                conn,
                """
                SELECT f."clauseTitle", f."verdict", f."confidence", f."retrievalScore",
                       jsonb_array_length(f."evidence") AS evidence_count
                  FROM "finding" f WHERE f."runId" = %s
                """,
                (run_id,),
            )
            run = db.one(conn, 'SELECT * FROM "assessment_run" WHERE "id" = %s', (run_id,))
            job_row = db.one(conn, 'SELECT "state" FROM "job" WHERE "id" = %s', (job_id,))

        by_title = {r["clauseTitle"]: r for r in rows}

        print("Coverage")
        check("a finding per clause", len(rows) == 8, f"got {len(rows)}")
        check("run marked complete", run and run["state"] == "complete", str(run and run["state"]))
        check("progress reached the total", run and run["completedClauses"] == 8)
        check("job marked done", job_row and job_row["state"] == "done")
        check("model recorded", bool(run and run["model"]))

        print("\nGuards")
        check(
            "grounded 'covered' survives",
            by_title.get("grounded-covered", {}).get("verdict") == "covered",
            str(by_title.get("grounded-covered")),
        )
        check(
            "uncited 'covered' demoted to needs_review",
            by_title.get("uncited-covered", {}).get("verdict") == "needs_review",
            str(by_title.get("uncited-covered")),
        )
        check(
            "'absent' on weak retrieval demoted",
            by_title.get("absent-weak", {}).get("verdict") == "needs_review",
            str(by_title.get("absent-weak")),
        )
        check(
            "low-confidence 'absent' demoted",
            by_title.get("absent-lowconf", {}).get("verdict") == "needs_review",
            str(by_title.get("absent-lowconf")),
        )
        check(
            "a decisive verdict resting only on a figure is demoted",
            by_title.get("figure-only", {}).get("verdict") == "needs_review",
            str(by_title.get("figure-only")),
        )
        check(
            "unrecognised verdict falls back to needs_review",
            by_title.get("bogus-verdict", {}).get("verdict") == "needs_review",
            str(by_title.get("bogus-verdict")),
        )
        check(
            "evidence stored for the grounded finding",
            by_title.get("grounded-covered", {}).get("evidence_count") == 1,
        )
        check(
            "retrieval score recorded",
            all(r["retrievalScore"] is not None for r in rows),
        )

        print("\nRe-reading what looked absent")
        check(
            "one call for every absent clause, not one call each",
            len(_confirmations) == 1,
            f"calls={len(_confirmations)}",
        )
        recovered = by_title.get("recovered-absent", {})
        check(
            "an absent the document does address is corrected, quoting the document",
            recovered.get("verdict") == "partial" and recovered.get("evidence_count") == 1,
            str(recovered),
        )
        check(
            "an invented quote leaves the verdict as the search left it",
            by_title.get("invented-quote", {}).get("verdict") == "absent",
            str(by_title.get("invented-quote")),
        )

        print("\nResumability")
        # Delete two findings and re-run: the handler should only redo those.
        with db.transaction() as conn:
            db.execute(
                conn,
                'DELETE FROM "finding" WHERE "runId" = %s AND "clauseTitle" = ANY(%s)',
                (run_id, ["grounded-covered", "absent-weak"]),
            )
            db.execute(
                conn,
                "UPDATE \"job\" SET \"state\" = 'leased' WHERE \"id\" = %s",
                (job_id,),
            )

        seen: list[str] = []
        original = _stub_judge

        def counting_judge(**kwargs):
            seen.append(kwargs["clause"])
            return original(**kwargs)

        analyse.llm.judge = counting_judge  # type: ignore[assignment]
        analyse.handle(job, lambda: None)

        check("only missing clauses re-judged", len(seen) == 2, f"judged {len(seen)}")
        with db.connection() as conn:
            total = db.one(
                conn, 'SELECT count(*)::int AS n FROM "finding" WHERE "runId" = %s', (run_id,)
            )
        check("full set restored", total and total["n"] == 8, str(total))

        return 1 if failures else 0

    finally:
        with db.transaction() as conn:
            db.execute(conn, 'DELETE FROM "organisation" WHERE "id" = %s', (org,))
        print(f"\nCleaned up smoke-{marker}")
        db.close()


if __name__ == "__main__":
    code = main()
    summary = (
        "All checks passed." if not failures else f"{len(failures)} failed: {', '.join(failures)}"
    )
    print("\n" + summary)
    sys.exit(code)
