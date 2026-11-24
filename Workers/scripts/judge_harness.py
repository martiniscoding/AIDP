"""Measure the clause judge on a frozen clause set, with error bars.

A full 170-clause run costs about $0.85 and five minutes, and the number it
returns cannot be read on its own: across six runs of the same corpus only 52%
of clauses returned the same verdict every time, so a single run's accuracy
moves by several points for no reason at all. Two prompt changes were made in
one sitting on the strength of a run that the next two runs showed to be an
outlier. This exists so that does not happen again.

    python Workers/scripts/judge_harness.py --repeats 3
    python Workers/scripts/judge_harness.py --band must --repeats 5
    python Workers/scripts/judge_harness.py --model openai/gpt-4.1 --repeats 2
    python Workers/scripts/judge_harness.py --baseline runs/base.json --repeats 3

## What it measures, and what it does not

It drives the same per-clause path production does — `llm.judge_document`, then
`_normalise`, `_checked_quotes`, `_applied`, `_guard_document`, then
`_read_and_vote` — so a change to any of those shows up here. It writes no
findings and creates no run.

It does **not** run the passes that sit outside the clause loop: the absent
re-read (`_confirm_absents`, search mode only), the covered review
(`_review_covered`), coverage, advice, lifecycle or root causes. A clause whose
verdict here is `absent` might be overturned in a real run; nothing else is
affected. Those passes are not what this is for.

## Cost, stated plainly because the budget is small

One judge call on this corpus bills about 11.9k input tokens, of which ~90%
are a prompt-cache read, plus ~375 output. That is roughly **$0.00215 a call**
at gpt-4.1-mini's $0.40/$1.60. A clause costs 2 calls when its first two
readings agree and 3 when they do not — about **$0.005 a clause-judgement**.

    30 clauses x 3 repeats  =  90 judgements  ~ $0.47
    46 clauses x 5 repeats  = 230 judgements  ~ $1.19   (dearer than a full run)

So the harness is not cheaper per judgement than a full run — repeats are the
whole point and repeats are what cost. What it buys is a spread instead of a
single number, on the clauses that decide anything.

One economy that is free: every reading's own verdict is recorded, not only the
voted one. Within-pass disagreement between readings is a variance signal that
costs nothing extra, so fewer repeats are needed to see instability than if the
vote were all that came back.

## Attribution

Spend is bound to a synthetic run id (`harness-<uuid>`) so that it (a) carries
a `session_id` and therefore keeps the prompt cache warm, which is most of the
cost, and (b) can be totalled afterwards:

    SELECT sum("inputTokens"), sum("cachedTokens"), sum("outputTokens")
      FROM "token_usage" WHERE "runId" LIKE 'harness-%';
"""

from __future__ import annotations

import argparse
import contextvars
import json
import os
import pathlib
import re
import statistics
import sys
import time
import uuid
from collections import Counter, defaultdict
from concurrent import futures

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from aidp import config, db, logs, stack, usage, whole_document  # noqa: E402
from aidp.ai import llm  # noqa: E402
from aidp.config import get_config  # noqa: E402
from aidp.stages import analyse  # noqa: E402

REPO = pathlib.Path(__file__).resolve().parents[2]
KEY_PATH = REPO / "samples" / "MERIDIAN_ANSWER_KEY.md"
DESIGN_TITLE = "MERIDIAN ONE"


# ---------------------------------------------------------------- the clause set

#: Stable defects outside the must list: wrong the same way in all six measured
#: runs, every one of them a breach the engine grades `partial`. This is the
#: regression set that means something — a change that moves these has moved a
#: real defect, not a coin.
STABLE_DEFECTS = (
    "SOL-016", "SEC-012", "SEC-022", "SEC-024", "SEC-028",
    "INT-005", "INT-038", "INT-040", "DAT-001", "DAT-023", "DAT-028", "EA-009",
)

#: Right in all six runs, and stable. These are the tripwires: nothing here
#: should move, and anything that does is a regression with no ambiguity. Five
#: `partial`, four `covered` and the one `contradicts` the engine has never got
#: wrong — chosen because over-promotion is the standing risk of every change
#: aimed at finding more breaches.
TRIPWIRES = (
    "SOL-003", "SOL-006", "SOL-019", "SEC-026", "SEC-031",
    "SOL-024", "SOL-030", "INT-003", "INT-016",
    "SOL-011",
)

BANDS = ("must", "defects", "tripwires")


def answer_key(path: pathlib.Path) -> dict[str, tuple[str, bool]]:
    """{clause ref: (expected verdict, is it a must row)}.

    The same state machine `AIDP/scripts/score-run.mts` uses, so the two agree
    on what the key says. `## … as one project` opens the section,
    `### Must get these right` marks the twenty-four rows that decide anything,
    and the next heading closes it.
    """
    out: dict[str, tuple[str, bool]] = {}
    inside = must = False
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.startswith("## "):
            inside = "as one project" in line
            must = False
        if line.startswith("### "):
            must = "Must get" in line
        if not inside:
            continue
        row = re.match(r"^\|\s*([A-Z]{2,4}-\d{2,4})\s*\|\s*\*{0,2}(\w+)\*{0,2}\s*\|", line.strip())
        if row:
            out[row.group(1)] = (row.group(2), must)
    if not out:
        raise SystemExit(f"no clause rows found in {path} — has its headings changed?")
    return out


def chosen(key: dict[str, tuple[str, bool]], bands: tuple[str, ...]) -> dict[str, str]:
    """The refs to judge, as {ref: band}, in a fixed order."""
    picked: dict[str, str] = {}
    if "must" in bands:
        for ref, (_, is_must) in key.items():
            if is_must:
                picked[ref] = "must"
    for ref in STABLE_DEFECTS if "defects" in bands else ():
        picked.setdefault(ref, "defect")
    for ref in TRIPWIRES if "tripwires" in bands else ():
        picked.setdefault(ref, "tripwire")
    missing = [ref for ref in picked if ref not in key]
    if missing:
        raise SystemExit(f"these refs are not in the answer key: {', '.join(missing)}")
    return picked


# ---------------------------------------------------------------- the corpus

def corpus(conn, refs: set[str]) -> tuple[whole_document.WholeDocument, list[dict], str, str]:
    """(the design read whole, the chosen clauses, the stack block, the org id).

    Looked up by title and by "the newest framework still in force" rather than
    by id, so the harness survives a reseed. It fails loudly rather than
    quietly judging the wrong thing.
    """
    design = db.one(
        conn,
        'SELECT "id", "title", "organisationId" FROM "document"'
        ' WHERE "title" = %(title)s AND "role" = \'assessed\' AND "status" = \'ready\''
        ' ORDER BY "createdAt" DESC LIMIT 1',
        {"title": DESIGN_TITLE},
    )
    if not design:
        raise SystemExit(f"no ready design titled {DESIGN_TITLE!r}")

    framework = db.one(
        conn,
        'SELECT "id", "version" FROM "framework"'
        ' WHERE "organisationId" = %(org)s AND "isBaseline" = false AND "supersededAt" IS NULL'
        ' ORDER BY "version" DESC LIMIT 1',
        {"org": design["organisationId"]},
    )
    if not framework:
        raise SystemExit("no framework in force for this organisation")

    whole = whole_document.load(conn, design["id"], design["title"])
    if whole is None:
        raise SystemExit(
            f"{design['title']} has no stored pages — it was processed before they were kept. "
            "Reprocess it before measuring the whole-document judge."
        )

    every = analyse._framework_clauses(conn, framework["id"])
    by_ref = {(c["numberText"] or c["id"]): c for c in every}
    clauses = [by_ref[ref] for ref in refs if ref in by_ref]
    absent = sorted(refs - set(by_ref))
    if absent:
        raise SystemExit(
            f"framework v{framework['version']} has no clause for: {', '.join(absent)}"
        )

    rows = stack.load(conn, design["organisationId"])
    text = stack.design_text(conn, [design["id"]])
    block = (
        stack.render(rows, stack.names_in(rows, text), analyse._unmatched(rows, text))
        if rows and text
        else ""
    )

    print(
        f"  design     {design['title']} ({whole.tokens:,} tokens, {len(whole.pages)} pages)\n"
        f"  framework  v{framework['version']} ({len(every)} clauses, {len(clauses)} chosen)\n"
        f"  stack      {len(rows.rows) if rows else 0} technologies"
        f"{' (block built)' if block else ' (no block)'}"
    )
    return whole, clauses, block, design["organisationId"]


# ---------------------------------------------------------------- judging

def judge(clause: dict, whole, block: str, readings: int) -> tuple[analyse._Judged, list[str]]:
    """One clause, through the engine's own judging step.

    `analyse.judged_document_once` is the function production runs — the same
    normalise, the same quote checking, the same guards — so a change to any of
    them lands here without this file being touched. A harness carrying its own
    copy of those six steps would drift from the engine silently, which is the
    one failure a measuring instrument cannot have.

    No standing decisions are passed: they are a per-organisation input that
    would make two measurements of the same clause set incomparable the moment
    somebody recorded one.

    Returns the voted answer and the verdict each individual reading reached.
    The per-reading list is the cheap half of the variance signal — production
    discards it after voting, and it is what says whether a clause is settled
    or a coin.
    """
    seen: list[str] = []
    reference = f"{clause['documentTitle']} — {clause['headingPath']}"

    def once(reading: int) -> analyse._Judged:
        judged = analyse.judged_document_once(
            clause, whole, reference=reference, stack_block=block, reading=reading
        )
        seen.append(judged.verdict)
        return judged

    return analyse._read_and_vote(once, readings, best=0.0, clause=clause), seen


#: Raw `contrary_practice` / `recorded_exception` per clause, keyed by the
#: reference string the judge is given. Collected by teeing `llm.judge_document`
#: rather than by changing what production returns: the fields the verdict turns
#: on are what a regression has to be read from, and a measuring instrument that
#: needed the engine altered to be observable would be the wrong way round.
#: `smoke_analyse_document.py` establishes the same monkeypatch pattern.
FACTS: dict[str, list[dict]] = defaultdict(list)


def record_facts() -> None:
    """Tee every judge reply into FACTS. Idempotent."""
    if getattr(analyse.llm.judge_document, "_teed", False):
        return
    inner = analyse.llm.judge_document

    def teed(*, document, reference, clause, precedents="", reading=0):
        raw = inner(
            document=document,
            reference=reference,
            clause=clause,
            precedents=precedents,
            reading=reading,
        )
        FACTS[reference].append(
            {
                "reading": reading,
                "verdict": raw.get("verdict"),
                "contrary_practice": raw.get("contrary_practice"),
                "recorded_exception": raw.get("recorded_exception"),
            }
        )
        return raw

    teed._teed = True
    analyse.llm.judge_document = teed


def why(judged: analyse._Judged) -> str:
    """The one line that says how a clause was decided.

    Kept because the first A/B could not be diagnosed from what was saved. Three
    clauses regressed, the measurement held only their verdicts, and finding out
    why would have meant paying for the cycle twice. A rationale is a few
    hundred bytes and answers it for nothing.
    """
    return " ".join(str(judged.rationale or "").split())[:400]


# ---------------------------------------------------------------- reporting

def report(
    key: dict[str, tuple[str, bool]],
    bands: dict[str, str],
    results: dict[str, list[str]],
    readings_seen: dict[str, list[str]],
    reasons: dict[str, list[str]],
    repeats: int,
    seconds: float,
) -> dict:
    """What the run says, with its spread, and never one number on its own."""
    print("\n" + "=" * 72)

    # --- per repeat, the headline figures, so the spread is visible
    per_repeat = []
    for i in range(repeats):
        right = sum(1 for ref, vs in results.items() if i < len(vs) and vs[i] == key[ref][0])
        must_right = sum(
            1
            for ref, vs in results.items()
            if key[ref][1] and i < len(vs) and vs[i] == key[ref][0]
        )
        per_repeat.append((right, must_right))
    must_total = sum(1 for ref in results if key[ref][1])
    total = len(results)

    accs = [100 * r / total for r, _ in per_repeat]
    musts = [100 * m / must_total for _, m in per_repeat] if must_total else [0.0]
    spread = lambda xs: f"{statistics.mean(xs):.1f}%" + (  # noqa: E731
        f"  (sd {statistics.pstdev(xs):.1f}, {min(xs):.1f}-{max(xs):.1f})" if len(xs) > 1 else ""
    )
    print(f"  accuracy over {total} clauses   {spread(accs)}")
    if must_total:
        print(f"  must-get over {must_total} rows        {spread(musts)}")

    # --- stability: the number this harness exists for
    settled = sum(1 for vs in results.values() if len(set(vs)) == 1)
    settled_right = sum(
        1 for ref, vs in results.items() if len(set(vs)) == 1 and vs[0] == key[ref][0]
    )
    print(
        f"\n  same verdict in all {repeats} repeats    {settled}/{total}"
        f" ({100 * settled / total:.0f}%)   of which right: {settled_right}"
    )
    agree = [
        100 * Counter(rs).most_common(1)[0][1] / len(rs)
        for rs in readings_seen.values()
        if rs
    ]
    if agree:
        print(f"  agreement between readings       {statistics.mean(agree):.0f}% mean")

    # --- where the errors are, which is what a change is steered by
    print("\n  by what the key expects:")
    for want in ("contradicts", "partial", "covered", "absent", "not_applicable"):
        refs = [r for r in results if key[r][0] == want]
        if not refs:
            continue
        hits = sum(1 for r in refs for v in results[r] if v == want)
        print(
            f"    {want:<16}{hits / repeats:5.1f} of {len(refs):<3}"
            f"  ({100 * hits / (repeats * len(refs)):3.0f}%)"
        )

    went = Counter()
    for ref, vs in results.items():
        if key[ref][0] == "contradicts":
            for v in vs:
                if v != "contradicts":
                    went[v] += 1
    if went:
        print("\n  breaches that landed elsewhere (per repeat):")
        for verdict, n in went.most_common():
            mark = "   <- a gap reported as compliance" if verdict == "covered" else ""
            print(f"    -> {verdict:<16}{n / repeats:5.1f}{mark}")

    print("\n  by band:")
    for band in ("must", "defect", "tripwire"):
        refs = [r for r in results if bands.get(r) == band]
        if not refs:
            continue
        hits = sum(1 for r in refs for v in results[r] if v == key[r][0])
        moved = sum(1 for r in refs if len(set(results[r])) > 1)
        print(
            f"    {band:<10}{hits / repeats:5.1f} of {len(refs):<3}"
            f"  ({100 * hits / (repeats * len(refs)):3.0f}%)   unstable: {moved}"
        )

    print(f"\n  took {seconds:.0f}s")
    print("=" * 72)

    return {
        "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "repeats": repeats,
        "clauses": total,
        "model": llm.model_name()[1],
        "accuracy_mean": round(statistics.mean(accs), 1),
        "accuracy_sd": round(statistics.pstdev(accs), 2),
        "must_mean": round(statistics.mean(musts), 1),
        "settled": settled,
        "settled_right": settled_right,
        "seconds": round(seconds),
        "verdicts": results,
        # Why each clause was decided, so a regression can be read off a
        # saved measurement instead of paid for a second time.
        "reasons": reasons,
    }


def compare(now: dict, before: dict, key: dict[str, tuple[str, bool]]) -> None:
    """This measurement against a stored one, read against its own noise."""
    print("\n  AGAINST THE BASELINE")
    print(
        f"    accuracy   {before['accuracy_mean']:.1f}% (sd {before.get('accuracy_sd', 0):.2f})"
        f"  ->  {now['accuracy_mean']:.1f}% (sd {now.get('accuracy_sd', 0):.2f})"
    )
    print(f"    must-get   {before['must_mean']:.1f}%  ->  {now['must_mean']:.1f}%")
    band = max(before.get("accuracy_sd", 0), now.get("accuracy_sd", 0)) * 2
    moved = now["accuracy_mean"] - before["accuracy_mean"]
    verdict = "inside the noise" if abs(moved) <= band else "outside the noise"
    print(f"    moved {moved:+.1f} points against a ~{band:.1f} point band — {verdict}")

    gained, lost = [], []
    for ref, vs in now["verdicts"].items():
        old = before["verdicts"].get(ref)
        if not old:
            continue
        want = key[ref][0]
        was = sum(1 for v in old if v == want) / len(old)
        is_ = sum(1 for v in vs if v == want) / len(vs)
        if is_ > was:
            gained.append(f"{ref} {was:.1f}->{is_:.1f}")
        elif is_ < was:
            lost.append(f"{ref} {was:.1f}->{is_:.1f}")
    print(f"    clauses better: {len(gained)}   worse: {len(lost)}")
    for label, rows in (("better", gained), ("worse", lost)):
        if rows:
            print(f"      {label}: {', '.join(rows[:12])}" + (" …" if len(rows) > 12 else ""))


# ---------------------------------------------------------------- entry

def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--repeats", type=int, default=3, help="passes over the clause set (default 3)")
    ap.add_argument("--band", action="append", choices=BANDS, help="repeatable; default all three")
    ap.add_argument("--readings", type=int, default=None, help="override JUDGE_READINGS")
    ap.add_argument("--workers", type=int, default=None, help="override ASSESS_CONCURRENCY")
    ap.add_argument(
        "--only",
        default=None,
        help="comma-separated clause refs, in place of the bands — for diagnosing a "
        "handful of clauses without paying for a whole band",
    )
    ap.add_argument("--model", default=None, help="judge model, e.g. openai/gpt-4.1")
    ap.add_argument(
        "--procedure",
        choices=("on", "off"),
        default=None,
        help="override VERDICT_PROCEDURE for this cycle",
    )
    ap.add_argument("--save", type=pathlib.Path, help="write the measurement here as json")
    ap.add_argument("--baseline", type=pathlib.Path, help="compare against a saved measurement")
    ap.add_argument("--dry-run", action="store_true", help="resolve the corpus and stop")
    args = ap.parse_args()

    logs.setup()
    cfg = get_config()
    readings = args.readings or cfg.judge_readings
    workers = args.workers or cfg.assess_concurrency
    bands = tuple(args.band) if args.band else BANDS

    if args.model or args.procedure:
        # `CONFIG` is a module global built from the environment at import, and
        # the clients are cached against the model they were built for. Both
        # have to be dropped or an override is read and then ignored.
        if args.model:
            os.environ["OPENROUTER_MODEL"] = args.model
        if args.procedure:
            os.environ["VERDICT_PROCEDURE"] = args.procedure
        config.CONFIG = None
        llm.forget_clients()
        cfg = get_config()
        readings = args.readings or cfg.judge_readings
        workers = args.workers or cfg.assess_concurrency

    key = answer_key(KEY_PATH)
    if args.only:
        wanted = [ref.strip().upper() for ref in args.only.split(",") if ref.strip()]
        unknown = [ref for ref in wanted if ref not in key]
        if unknown:
            raise SystemExit(f"not in the answer key: {', '.join(unknown)}")
        picked = {ref: ('must' if key[ref][1] else 'chosen') for ref in wanted}
    else:
        picked = chosen(key, bands)

    print(f"\n  key        {KEY_PATH.name} ({len(key)} rows)")
    with db.connection() as conn:
        whole, clauses, block, organisation = corpus(conn, set(picked))

    judgements = len(clauses) * args.repeats
    print(
        f"  plan       {len(clauses)} clauses x {args.repeats} repeats = {judgements} judgements,"
        f" {readings} readings each, {workers} at once\n"
        f"  judge      {llm.model_name()[1]}"
        f", verdict_procedure={'on' if cfg.verdict_procedure else 'off'}\n"
        f"  estimate   ~${judgements * 0.005:.2f} (about $0.005 a judgement on this corpus)"
    )
    if args.dry_run:
        print("\n  --dry-run: nothing judged.\n")
        return 0
    if not llm.available():
        raise SystemExit("no model API key configured")

    record_facts()
    ref_of = {
        f"{c['documentTitle']} \u2014 {c['headingPath']}": (c["numberText"] or c["id"])
        for c in clauses
    }

    usage.bind(
        usage.Attribution(
            organisation_id=organisation,
            stage="analyse",
            run_id=f"harness-{uuid.uuid4().hex[:12]}",
        )
    )

    results: dict[str, list[str]] = defaultdict(list)
    readings_seen: dict[str, list[str]] = defaultdict(list)
    reasons: dict[str, list[str]] = defaultdict(list)
    started = time.time()

    for rep in range(args.repeats):
        print(f"\n  repeat {rep + 1}/{args.repeats}")
        # One repeat at a time, every clause of it at once. The repeat boundary
        # has to hold because `results[ref][i]` is the verdict from repeat i —
        # that indexing is what the stability figure is computed from. Within a
        # repeat the order does not matter and the clauses are independent.
        #
        # `copy_context().run` per task for the reason production does it
        # (analyse.py:705): the API credential and the usage attribution are
        # ContextVars bound on this thread, and a pool thread does not inherit
        # them. Without the copy every clause would look for a key that is not
        # there — and the attribution carries the session id that keeps the
        # prompt cache warm, which is most of what a cycle costs.
        done: dict[str, tuple[str, list[str], str]] = {}
        quota = False
        with futures.ThreadPoolExecutor(max_workers=workers, thread_name_prefix="judge") as pool:
            running = {
                pool.submit(
                    contextvars.copy_context().run, judge, clause, whole, block, readings
                ): clause["numberText"] or clause["id"]
                for clause in clauses
            }
            for future in futures.as_completed(running):
                ref = running[future]
                try:
                    judged, seen = future.result()
                except llm.QuotaExhausted:
                    quota = True
                    for pending in running:
                        pending.cancel()
                    break
                except Exception as exc:  # noqa: BLE001 — one clause must not cost the cycle
                    print(f"    ERR  {ref:<9} {type(exc).__name__}: {str(exc)[:90]}")
                    continue
                done[ref] = (judged.verdict, seen, why(judged))

        # Printed in the fixed clause order rather than as they land, so two
        # cycles can be read side by side.
        for clause in clauses:
            ref = clause["numberText"] or clause["id"]
            if ref not in done:
                continue
            verdict, seen, reason = done[ref]
            results[ref].append(verdict)
            readings_seen[ref].extend(seen)
            reasons[ref].append(reason)
            want = key[ref][0]
            mark = "ok  " if verdict == want else "MISS"
            split = "" if len(set(seen)) == 1 else f"  split {'/'.join(seen)}"
            print(f"    {mark} {ref:<9} want={want:<14} got={verdict:<14}{split}")

        if quota:
            print("\n  STOPPED: the model key is out of credit. Partial results below.\n")
            # A repeat that was cut short is not a repeat. Drop it whole rather
            # than averaging over a set of clauses that is no longer the same.
            short = [r for r in results if len(results[r]) > rep]
            if len(done) < len(clauses):
                for r in short:
                    del results[r][rep:]
                args.repeats = rep
            else:
                args.repeats = rep + 1
            break

    if not args.repeats:
        raise SystemExit("no complete repeat finished — nothing to report")
    return _finish(key, picked, results, readings_seen, reasons, args, started, ref_of)


def _finish(key, picked, results, readings_seen, reasons, args, started, ref_of=None) -> int:
    measured = report(
        key, picked, results, readings_seen, reasons, args.repeats, time.time() - started
    )
    measured["facts"] = {
        (ref_of or {}).get(reference, reference): seen for reference, seen in FACTS.items()
    }
    if args.save:
        args.save.parent.mkdir(parents=True, exist_ok=True)
        args.save.write_text(json.dumps(measured, indent=2), encoding="utf-8")
        print(f"\n  saved to {args.save}")
    if args.baseline:
        if args.baseline.exists():
            compare(measured, json.loads(args.baseline.read_text(encoding="utf-8")), key)
        else:
            print(f"\n  no baseline at {args.baseline} — nothing to compare against")
    print()
    return 0


if __name__ == "__main__":
    # Closed explicitly: the pool's own finaliser tries to join its worker
    # threads at interpreter shutdown, which Python 3.14 refuses, and the
    # traceback it prints looks like a failure in the measurement.
    try:
        code = main()
    finally:
        db.close()
    raise SystemExit(code)
