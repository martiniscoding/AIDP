"""Whole-document assessment against a real database, with the models stubbed.

What this proves without an API key: the stage reads the stored page text,
quotes are checked against it before a verdict is believed, search is asked for
a second opinion on every "absent" and on nothing else, a run that cannot read
the whole document falls back to search and says why, and "Compare both" runs
both modes in one job, linked, with the job moved onto the second run.

    docker run --rm --network container:<postgres> -v "$PWD":/repo -w /repo \\
      -e PYTHONPATH=/repo/Workers -e STAGE=analyse -e DATABASE_URL=postgresql://... \\
      aidp-worker-test python Workers/scripts/smoke_analyse_document.py
"""

from __future__ import annotations

import pathlib
import re
import sys
import uuid
from types import SimpleNamespace

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from psycopg.types.json import Jsonb  # noqa: E402

from aidp import db  # noqa: E402
from aidp.ai import embeddings  # noqa: E402
from aidp.config import get_config  # noqa: E402
from aidp.queue import Job  # noqa: E402
from aidp.stages import analyse  # noqa: E402

passed = failed = 0


def ok(name: str, condition: bool, extra: object = "") -> None:
    global passed, failed
    if condition:
        passed += 1
        print(f"  PASS {name}")
    else:
        failed += 1
        print(f"  FAIL {name} {extra}")


cfg = get_config()
DIMS, MODEL = cfg.embedding_dims, cfg.embedding_model
calls = {"document": 0, "search": 0}

DOCUMENT_REPLIES = {
    "mfa-grounded": {
        "verdict": "covered",
        "confidence": 0.9,
        "rationale": "MFA via Okta.",
        "evidence": [{"quote": "uses multi-factor authentication via Okta", "page": 2}],
        "appliedDecisions": [],
    },
    "tls-invented": {
        "verdict": "covered",
        "confidence": 0.95,
        "rationale": "TLS everywhere.",
        "evidence": [{"quote": "all traffic is encrypted with TLS 1.3", "page": 2}],
        "appliedDecisions": [],
    },
    "dlq-absent": {
        "verdict": "absent",
        "confidence": 0.9,
        "rationale": "No dead-letter queue.",
        "evidence": [],
        "appliedDecisions": [],
    },
    "owner-absent": {
        "verdict": "absent",
        "confidence": 0.9,
        "rationale": "No owner named.",
        "evidence": [],
        "appliedDecisions": [],
    },
}
SEARCH_REPLIES = {
    "dlq-absent": {"verdict": "absent", "confidence": 0.9, "rationale": "Not in the extracts."},
    "owner-absent": {
        "verdict": "partial",
        "confidence": 0.8,
        "rationale": "An owner is listed as an open item.",
    },
}


def scripted(table: dict, clause: str) -> dict | None:
    for key in sorted(table, key=len, reverse=True):
        if key in clause:
            return dict(table[key])
    return None


def stub_judge_document(*, document, reference, clause, precedents=""):
    calls["document"] += 1
    assert "=== page 1 ===" in document, "the judge must be given the stored page text"
    return scripted(DOCUMENT_REPLIES, clause) or {
        "verdict": "needs_review",
        "confidence": 0.1,
        "rationale": "no script",
        "evidence": [],
        "appliedDecisions": [],
    }


def stub_judge(*, reference, clause, extracts, precedents="", document=""):
    calls["search"] += 1
    reply = scripted(SEARCH_REPLIES, clause) or {
        "verdict": "covered",
        "confidence": 0.9,
        "rationale": "Found by search.",
    }
    ids = re.findall(r'<extract id="([^"]+)"', extracts)
    reply["evidence"] = ids[:1] if reply["verdict"] in analyse.CITING_VERDICTS else []
    reply["appliedDecisions"] = []
    return reply


embeddings.embed_all = lambda texts, input_type="document": [[0.1] * DIMS for _ in texts]
analyse.llm.judge_document = stub_judge_document
analyse.llm.judge = stub_judge
analyse.llm.available = lambda: True

marker = uuid.uuid4().hex[:10]
org = db.new_id()
ref_doc, design, bare = db.new_id(), db.new_id(), db.new_id()
framework = db.new_id()
PAGES = [
    (1, "heading", "1. Platform Security"),
    (2, "text", "All administrative access uses multi-factor authentication via Okta."),
    (2, "text", "Telemetry is transmitted over plain MQTT to the ingestion workers."),
    (3, "text", "Open item: confirm the operational owner for the ingestion pipeline."),
]


def seed() -> None:
    with db.transaction() as conn:
        db.execute(
            conn,
            'INSERT INTO "organisation" ("id","name","slug","updatedAt") VALUES (%s,%s,%s,now())',
            (org, f"Doc smoke {marker}", f"doc-{marker}"),
        )
        for doc_id, role, title in (
            (ref_doc, "reference", "Standard"),
            (design, "assessed", "Design"),
            (bare, "assessed", "Old design"),
        ):
            db.execute(
                conn,
                'INSERT INTO "document" ("id","organisationId","role","title",'
                '"storageKey","byteSize","sha256","status","updatedAt") '
                "VALUES (%s,%s,%s,%s,%s,1,%s,'ready',now())",
                (doc_id, org, role, title, f"{doc_id}.pdf", doc_id),
            )
        section = db.new_id()
        db.execute(
            conn,
            'INSERT INTO "document_section" ("id","documentId","ordinal","numberText",'
            '"title","headingPath","depth") VALUES (%s,%s,1,%s,%s,%s,1)',
            (section, ref_doc, "3", "Controls", "Standard › 3 Controls"),
        )
        for ordinal, title in enumerate(DOCUMENT_REPLIES, start=1):
            db.execute(
                conn,
                'INSERT INTO "clause" ("id","sectionId","ordinal","title","statement",'
                '"requirements") VALUES (%s,%s,%s,%s,%s,%s)',
                (
                    db.new_id(),
                    section,
                    ordinal,
                    title,
                    f"The design must satisfy {title}.",
                    ["a requirement"],
                ),
            )
        for doc_id in (design, bare):
            for ordinal, (page, _, text) in enumerate(PAGES, start=1):
                chunk = db.new_id()
                db.execute(
                    conn,
                    'INSERT INTO "chunk" ("id","organisationId","documentId",'
                    '"sourceKind","ordinal","headingPath","text","contentHash",'
                    '"pageStart","pageEnd") VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)',
                    (
                        chunk,
                        org,
                        doc_id,
                        "section",
                        ordinal,
                        "Design › 1",
                        text,
                        f"{doc_id}-{ordinal}",
                        page,
                        page,
                    ),
                )
                db.execute(
                    conn,
                    'INSERT INTO "embedding" ("id","chunkId","model","dims","vector") '
                    "VALUES (%s,%s,%s,%s,%s::vector)",
                    (db.new_id(), chunk, MODEL, DIMS, "[" + ",".join(["0.1"] * DIMS) + "]"),
                )
        # Only the new design has its pages stored.
        for ordinal, (page, kind, text) in enumerate(PAGES):
            db.execute(
                conn,
                'INSERT INTO "source_line" ("id","documentId","ordinal","ref","kind",'
                '"page","text") VALUES (%s,%s,%s,%s,%s,%s,%s)',
                (db.new_id(), design, ordinal, f"L{ordinal + 1}", kind, page, text),
            )
        db.execute(
            conn,
            'INSERT INTO "framework" ("id","organisationId","name","version",'
            "\"updatedAt\") VALUES (%s,%s,'Doc smoke',1,now())",
            (framework, org),
        )
        db.execute(
            conn,
            'INSERT INTO "framework_document" ("frameworkId","documentId") VALUES (%s,%s)',
            (framework, ref_doc),
        )


def start(document_id: str, mode: str, then: str | None = None) -> Job:
    run_id, job_id = db.new_id(), db.new_id()
    payload = {"runId": run_id, **({"then": then} if then else {})}
    with db.transaction() as conn:
        db.execute(
            conn,
            'INSERT INTO "assessment_run" ("id","organisationId","documentId",'
            '"frameworkId","totalClauses","mode") VALUES (%s,%s,%s,%s,%s,%s)',
            (run_id, org, document_id, framework, len(DOCUMENT_REPLIES), mode),
        )
        db.execute(
            conn,
            'INSERT INTO "job" ("id","organisationId","documentId","stage","state",'
            '"correlationId","payload","updatedAt") '
            "VALUES (%s,%s,%s,'analyse','leased',%s,%s,now())",
            (job_id, org, document_id, f"smoke-{marker}", Jsonb(payload)),
        )
    return Job(
        id=job_id,
        organisation_id=org,
        document_id=document_id,
        stage="analyse",
        attempts=1,
        correlation_id=f"smoke-{marker}",
        payload=payload,
    )


def findings(run_id: str) -> dict[str, dict]:
    with db.connection() as conn:
        rows = db.query(conn, 'SELECT * FROM "finding" WHERE "runId" = %s', (run_id,))
    return {row["clauseTitle"]: row for row in rows}


def run_row(run_id: str) -> dict:
    with db.connection() as conn:
        return db.one(conn, 'SELECT * FROM "assessment_run" WHERE "id" = %s', (run_id,))


try:
    seed()

    print("\n1. Reading the whole document")
    job = start(design, "document")
    analyse.handle(job, lambda: None)
    run = run_row(job.payload["runId"])
    got = findings(run["id"])
    ok(
        "the run completes in document mode, recording the model",
        run["state"] == "complete"
        and run["mode"] == "document"
        and run["model"]
        and run["note"] is None,
        {k: run[k] for k in ("state", "mode", "model", "note")},
    )
    ok(
        "every clause was read whole, and only absents went to search",
        calls["document"] == 4 and calls["search"] == 2,
        calls,
    )
    mfa = got.get("mfa-grounded", {})
    ok(
        "a checked quote carries 'covered', on the page it is really on",
        mfa.get("verdict") == "covered"
        and mfa["evidence"]
        and mfa["evidence"][0]["sourceKind"] == "quote"
        and mfa["evidence"][0]["page"] == 2,
        mfa.get("evidence"),
    )
    tls = got.get("tls-invented", {})
    ok(
        "an invented quote cannot carry a verdict",
        tls.get("verdict") == "needs_review" and "could not be found" in tls.get("rationale", ""),
        tls.get("rationale"),
    )
    ok(
        "an absent that search agrees with stands",
        got.get("dlq-absent", {}).get("verdict") == "absent",
        got.get("dlq-absent", {}).get("verdict"),
    )
    owner = got.get("owner-absent", {})
    ok(
        "an absent that search disputes becomes a question, with search's passages",
        owner.get("verdict") == "needs_review"
        and "search of the same document" in owner["rationale"]
        and owner["evidence"]
        and owner["evidence"][0]["sourceKind"] == "section",
        owner.get("rationale"),
    )

    print("\n2. When the whole document cannot be read")
    before = dict(calls)
    job = start(bare, "document")
    analyse.handle(job, lambda: None)
    run = run_row(job.payload["runId"])
    ok(
        "a document without stored pages is assessed by search, and the run says why",
        run["state"] == "complete"
        and run["mode"] == "retrieval"
        and "processed before its pages were stored" in (run["note"] or ""),
        run["note"],
    )
    ok(
        "no clause was sent to the whole-document judge",
        calls["document"] == before["document"] and calls["search"] == before["search"] + 4,
        calls,
    )

    real_config = analyse.get_config
    analyse.get_config = lambda: SimpleNamespace(whole_document_max_tokens=5)
    job = start(design, "document")
    analyse.handle(job, lambda: None)
    analyse.get_config = real_config
    run = run_row(job.payload["runId"])
    ok(
        "a document over the size limit falls back to search, and says how big it is",
        run["mode"] == "retrieval" and "tokens" in (run["note"] or ""),
        run["note"],
    )

    print("\n3. Compare both")
    job = start(design, "retrieval", then="document")
    first = job.payload["runId"]
    analyse.handle(job, lambda: None)
    with db.connection() as conn:
        second = db.one(
            conn, 'SELECT * FROM "assessment_run" WHERE "comparedWithId" = %s', (first,)
        )
        job_row = db.one(conn, 'SELECT "state", "payload" FROM "job" WHERE "id" = %s', (job.id,))
    ok(
        "the search run completes first",
        run_row(first)["state"] == "complete" and run_row(first)["mode"] == "retrieval",
    )
    ok(
        "then a whole-document run is opened, linked to it, and completed by the same job",
        second is not None and second["mode"] == "document" and second["state"] == "complete",
        second and {k: second[k] for k in ("mode", "state")},
    )
    ok(
        "both runs hold a finding for every clause",
        second is not None and len(findings(first)) == 4 and len(findings(second["id"])) == 4,
    )
    ok(
        "the job ends done, pointing at the second run",
        job_row["state"] == "done"
        and second is not None
        and job_row["payload"].get("runId") == second["id"],
        job_row,
    )
finally:
    with db.transaction() as conn:
        db.execute(conn, 'DELETE FROM "organisation" WHERE "id" = %s', (org,))

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
