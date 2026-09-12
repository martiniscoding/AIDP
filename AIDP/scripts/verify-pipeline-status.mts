/**
 * The processing status a person sees, read from queue rows.
 *
 * Every state the queue can be in, including the ones that matter most and turn
 * up least in development: a worker that died holding a job, a stage nobody is
 * running, a retry after a provider refused, a dead letter, a report left over
 * from an attempt that was abandoned. Pure — no database, no server.
 *
 * Run with:  npx tsx scripts/verify-pipeline-status.mts
 */
import {
  describePipeline,
  explain,
  formatDuration,
  readProgress,
  SLOW_PICKUP_MS,
  type JobRow,
} from "../src/lib/ingest/pipeline";

let pass = 0;
let fail = 0;
const ok = (name: string, condition: boolean, extra: unknown = "") => {
  if (condition) {
    pass += 1;
    console.log(`  PASS ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name} ${typeof extra === "string" ? extra : JSON.stringify(extra)}`);
  }
};

const NOW = new Date("2026-09-13T10:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const ahead = (ms: number) => new Date(NOW.getTime() + ms);

function job(stage: string, over: Partial<JobRow> = {}): JobRow {
  return {
    stage,
    state: "queued",
    attempts: 0,
    maxAttempts: 5,
    runAfter: ago(10_000),
    leaseUntil: null,
    lastError: null,
    progress: null,
    createdAt: ago(10_000),
    updatedAt: ago(10_000),
    ...over,
  };
}

const report = (attempt: number, over: Record<string, unknown> = {}) => ({
  attempt,
  startedAt: ago(90_000).toISOString(),
  step: null,
  done: null,
  total: null,
  trail: [],
  at: NOW.toISOString(),
  ...over,
});

const pending = { status: "pending", failureReason: null };
const states = (view: ReturnType<typeof describePipeline>) =>
  view.stages.map((stage) => stage.state).join(",");

console.log("\nJust uploaded");
{
  const view = describePipeline(pending, [job("parse")], NOW);
  ok("queued, not yet a problem", view.state === "waiting" && view.headline === "Queued", view);
  ok("parse queued, the rest waiting", states(view) === "queued,waiting,waiting", states(view));
  ok("waited ten seconds", view.stages[0]!.sinceMs === 10_000, view.stages[0]);
  ok("elapsed counts from the upload", view.elapsedMs === 10_000, view.elapsedMs);
}

console.log("\nNo worker picks it up");
{
  const old = ago(SLOW_PICKUP_MS + 60_000);
  const view = describePipeline(pending, [job("parse", { createdAt: old, runAfter: old })], NOW);
  ok("flagged for attention", view.state === "attention", view.state);
  ok("says it is waiting for a worker", view.headline === "Still waiting for a worker", view.headline);
  ok("names the stage whose worker is missing", /No parse worker/.test(view.detail ?? ""), view.detail);
}

console.log("\nReading, with a count");
{
  const parse = job("parse", {
    state: "leased",
    attempts: 1,
    leaseUntil: ahead(300_000),
    progress: report(1, {
      step: "Describing figures",
      done: 3,
      total: 12,
      trail: [{ step: "Fetching the file", seconds: 0.4 }],
    }),
  });
  const view = describePipeline({ status: "parsing", failureReason: null }, [parse], NOW);
  const stage = view.stages[0]!;
  ok("working", view.state === "working" && view.headline === "Reading the document", view);
  ok("carries the step and count", stage.step === "Describing figures" && stage.done === 3 && stage.total === 12, stage);
  ok("running for as long as the attempt has", stage.sinceMs === 90_000, stage.sinceMs);
  ok("keeps the finished steps", stage.trail.length === 1 && stage.trail[0]!.step === "Fetching the file", stage.trail);
}

console.log("\nA report left over from an abandoned attempt");
{
  const parse = job("parse", {
    state: "leased",
    attempts: 2,
    leaseUntil: ahead(300_000),
    progress: report(1, { step: "Describing figures", done: 11, total: 12 }),
  });
  const stage = describePipeline(pending, [parse], NOW).stages[0]!;
  ok("is not shown as this attempt's progress", stage.step === null && stage.done === null, stage);
  ok("says which attempt this is", stage.attempt === 2, stage.attempt);
}

console.log("\nThe worker died holding the job");
{
  const parse = job("parse", {
    state: "leased",
    attempts: 1,
    leaseUntil: ago(5_000),
    progress: report(1, { step: "Reading the rules, pass 1 of 2" }),
  });
  const view = describePipeline({ status: "parsing", failureReason: null }, [parse], NOW);
  ok("stalled, not running", view.stages[0]!.state === "stalled", view.stages[0]!.state);
  ok("flagged for attention", view.state === "attention" && /stopped responding/.test(view.headline), view.headline);
  ok("remembers what it was doing", view.stages[0]!.step === "Reading the rules, pass 1 of 2");
}

console.log("\nRetrying after a provider refused");
{
  const parse = job("parse", {
    attempts: 2,
    runAfter: ahead(30_000),
    lastError: "RuntimeError: 429 after 6 attempts: rate limited",
  });
  const view = describePipeline({ status: "parsing", failureReason: null }, [parse], NOW);
  const stage = view.stages[0]!;
  ok("retrying", stage.state === "retrying" && view.state === "attention", stage.state);
  ok("counts down to the next attempt", stage.retryInMs === 30_000, stage.retryInMs);
  ok("explains the error in words", /limiting how fast/.test(stage.problem?.summary ?? ""), stage.problem);
  ok("keeps the raw error for whoever fixes it", stage.problem?.detail?.includes("429") === true);
  ok("headline says which attempt failed", /Attempt 2 of 5 failed/.test(view.detail ?? ""), view.detail);
}

console.log("\nOne stage done, the next under way");
{
  const parse = job("parse", {
    state: "done",
    attempts: 1,
    createdAt: ago(200_000),
    updatedAt: ago(60_000),
    progress: report(1, { startedAt: ago(160_000).toISOString(), trail: [{ step: "Fetching the file", seconds: 1 }] }),
  });
  const chunk = job("chunk", {
    state: "leased",
    attempts: 1,
    createdAt: ago(60_000),
    leaseUntil: ahead(500_000),
    progress: report(1, { startedAt: ago(50_000).toISOString(), step: "Summarising the document" }),
  });
  const view = describePipeline({ status: "chunking", failureReason: null }, [chunk, parse], NOW);
  ok("parse done, chunk running, embed waiting", states(view) === "done,running,waiting", states(view));
  ok("parse took from its start to its finish", view.stages[0]!.tookMs === 100_000, view.stages[0]!.tookMs);
  ok("current stage is chunk", view.current === "chunk" && view.headline === "Splitting into passages", view);
  ok("elapsed counts from the first job", view.elapsedMs === 200_000, view.elapsedMs);
}

console.log("\nDead-lettered");
{
  const parse = job("parse", {
    state: "dead",
    attempts: 5,
    lastError: "RuntimeError: no usable text layer (12 characters across 30 pages) — this looks like a scan and needs OCR, which is not wired up",
  });
  const view = describePipeline({ status: "failed", failureReason: parse.lastError }, [parse], NOW);
  ok("failed", view.state === "failed" && states(view) === "failed,waiting,waiting", states(view));
  ok("says where and after how many attempts", /Read the document.*after 5 attempts/.test(view.detail ?? ""), view.detail);
  ok("explains a scan in words", /looks like a scan/.test(view.failure?.summary ?? ""), view.failure);
  ok("no ticking clock on a failure", view.elapsedMs === null);
}

console.log("\nMarked failed with no job to show for it");
{
  const view = describePipeline({ status: "failed", failureReason: "ValueError: bad file" }, [], NOW);
  ok("the first stage carries the failure", view.stages[0]!.state === "failed", states(view));
  ok("the type name is dropped from the summary", view.failure?.summary === "bad file", view.failure);
}

console.log("\nFinished");
{
  const rows = [
    job("parse", { state: "done", attempts: 1, createdAt: ago(400_000), updatedAt: ago(300_000) }),
    job("chunk", { state: "done", attempts: 1, createdAt: ago(300_000), updatedAt: ago(250_000) }),
    job("embed", { state: "done", attempts: 1, createdAt: ago(250_000), updatedAt: ago(200_000) }),
    job("analyse", { state: "leased", attempts: 1, createdAt: ago(10_000), updatedAt: ago(1_000) }),
  ];
  const view = describePipeline({ status: "ready", failureReason: null }, rows, NOW);
  ok("ready", view.state === "ready" && states(view) === "done,done,done", states(view));
  ok("an assessment job is not a processing stage", view.current === null);
  ok("took from upload to index", view.tookMs === 200_000, view.tookMs);

  const legacy = describePipeline({ status: "ready", failureReason: null }, [], NOW);
  ok("a ready document with no jobs left is ready, with no time claimed", legacy.state === "ready" && legacy.tookMs === null, legacy);
}

console.log("\nA corrected figure re-embeds a ready document");
{
  const rows = [
    job("parse", { state: "done", attempts: 1, createdAt: ago(900_000), updatedAt: ago(800_000) }),
    job("chunk", { state: "done", attempts: 1, createdAt: ago(800_000), updatedAt: ago(700_000) }),
    job("embed", { state: "queued", createdAt: ago(5_000), runAfter: ago(5_000) }),
  ];
  const view = describePipeline({ status: "ready", failureReason: null }, rows, NOW);
  ok("embed is shown as queued again", states(view) === "done,done,queued", states(view));
}

console.log("\nThe newest job per stage wins");
{
  const rows = [
    job("embed", { state: "done", attempts: 1, createdAt: ago(100_000) }),
    job("embed", { state: "leased", attempts: 1, createdAt: ago(5_000), leaseUntil: ahead(60_000) }),
  ];
  const view = describePipeline({ status: "embedding", failureReason: null }, rows, NOW);
  ok("earlier stages count as done once a later one exists", states(view) === "done,done,running", states(view));
}

console.log("\nReading reports defensively");
{
  ok("not an object", readProgress("nope") === null && readProgress(null) === null && readProgress([]) === null);
  const odd = readProgress({ attempt: "1", done: -3, total: 4.7, step: 7, startedAt: "garbage", trail: [{ step: "a", seconds: 1 }, { step: 2 }, null] });
  ok("bad fields fall away", odd !== null && odd.attempt === 0 && odd.done === null && odd.total === 4 && odd.step === null && odd.startedAt === null, odd);
  ok("only well-formed trail entries survive", odd?.trail.length === 1, odd?.trail);
}

console.log("\nExplaining errors");
{
  ok("credits", /credits or quota/.test(explain("QuotaExhausted: openrouter 402")?.summary ?? ""));
  ok("lease", /stopped before it finished/.test(explain("lease expired before completion")?.summary ?? ""));
  ok("nothing to explain", explain(null) === null && explain("   ") === null);
  const long = explain(`RuntimeError: ${"x".repeat(400)}`);
  ok("a long message is cut to a readable length", (long?.summary.length ?? 0) <= 220 && long?.detail !== null, long?.summary.length);
}

console.log("\nDurations");
ok("seconds", formatDuration(0) === "0s" && formatDuration(59_400) === "59s");
ok("minutes", formatDuration(60_000) === "1m 00s" && formatDuration(192_000) === "3m 12s");
ok("hours", formatDuration(3_725_000) === "1h 02m", formatDuration(3_725_000));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
