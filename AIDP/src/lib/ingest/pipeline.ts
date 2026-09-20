/**
 * Where a document is in its processing, in words a person waiting on it can use.
 *
 * A document's `status` names a stage and nothing more. A 95-page standard reads
 * "Reading the document" for the several minutes a model spends on its rules and
 * figures — exactly as it would if the worker had died holding it, or if no
 * worker were running at all. The queue knows the difference: whether a job was
 * picked up, when its lease runs out, how many attempts failed and why. The
 * workers add what they are doing right now (Workers/aidp/progress.py). This
 * reads the two together.
 *
 * Pure, so it can be checked without a database: rows in, a view out. The rows
 * come from documents.ts and projects.ts, already scoped to a member. Safe to
 * import from a client component.
 */

export const STAGES = ["parse", "chunk", "embed"] as const;
export type Stage = (typeof STAGES)[number];

export const STAGE_COPY: Record<Stage, { title: string; doing: string; about: string }> = {
  parse: {
    title: "Read the document",
    doing: "Reading the document",
    about: "Text, headings, tables and figures — and for a standard, its rules.",
  },
  chunk: {
    title: "Split into passages",
    doing: "Splitting into passages",
    about: "Each rule, table row, figure and section becomes a passage that can be found on its own.",
  },
  embed: {
    title: "Build the search index",
    doing: "Building the search index",
    about: "Every passage is embedded, so an assessment can find it.",
  },
};

/**
 * How long a job can sit unclaimed before it is worth remarking on. An idle
 * worker polls every 30 seconds at most, so two minutes means every worker for
 * the stage is busy, or none is running.
 */
export const SLOW_PICKUP_MS = 2 * 60_000;

/** The job columns the view reads, as a Prisma `select`. */
export const JOB_SELECT = {
  stage: true,
  state: true,
  attempts: true,
  maxAttempts: true,
  runAfter: true,
  leaseUntil: true,
  lastError: true,
  progress: true,
  createdAt: true,
  updatedAt: true,
} as const;

export type JobRow = {
  stage: string;
  state: string;
  attempts: number;
  maxAttempts: number;
  runAfter: Date;
  leaseUntil: Date | null;
  lastError: string | null;
  progress: unknown;
  createdAt: Date;
  updatedAt: Date;
};

export type TrailStep = { step: string; seconds: number };

export type Progress = {
  attempt: number;
  startedAt: Date | null;
  step: string | null;
  done: number | null;
  total: number | null;
  trail: TrailStep[];
};

export type Problem = { summary: string; detail: string | null };

export type StageState = "waiting" | "queued" | "running" | "retrying" | "stalled" | "done" | "failed";

export type StageView = {
  stage: Stage;
  title: string;
  about: string;
  state: StageState;
  /** What the worker says it is doing, or was doing when it stopped. */
  step: string | null;
  done: number | null;
  total: number | null;
  /** Steps finished in this attempt, with how long each took. */
  trail: TrailStep[];
  attempt: number;
  maxAttempts: number;
  /** Running: since this attempt started. Queued: since it became runnable. */
  sinceMs: number | null;
  /** Done: how long the attempt that finished took. */
  tookMs: number | null;
  /** Retrying: until the next attempt may start. */
  retryInMs: number | null;
  problem: Problem | null;
};

export type PipelineState = "working" | "waiting" | "attention" | "failed" | "ready";

export type PipelineView = {
  state: PipelineState;
  headline: string;
  detail: string | null;
  /** The first stage not yet done. */
  current: Stage | null;
  stages: StageView[];
  /** In flight: since the first stage was queued. */
  elapsedMs: number | null;
  /** Ready: from the first stage queued to the last one finished. */
  tookMs: number | null;
  failure: (Problem & { stage: Stage; attempts: number }) | null;
};

function isStage(value: string): value is Stage {
  return (STAGES as readonly string[]).includes(value);
}

/** A worker's progress report, or null for anything that is not one. */
export function readProgress(value: unknown): Progress | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const count = (x: unknown) =>
    typeof x === "number" && Number.isFinite(x) && x >= 0 ? Math.floor(x) : null;
  const started = typeof raw.startedAt === "string" ? new Date(raw.startedAt) : null;
  const trail = Array.isArray(raw.trail)
    ? raw.trail.flatMap((entry): TrailStep[] => {
        if (!entry || typeof entry !== "object") return [];
        const { step, seconds } = entry as Record<string, unknown>;
        return typeof step === "string" && typeof seconds === "number" && seconds >= 0
          ? [{ step: step.slice(0, 200), seconds }]
          : [];
      })
    : [];
  return {
    attempt: count(raw.attempt) ?? 0,
    startedAt: started && !Number.isNaN(started.getTime()) ? started : null,
    step: typeof raw.step === "string" && raw.step ? raw.step.slice(0, 200) : null,
    done: count(raw.done),
    total: count(raw.total),
    trail,
  };
}

/**
 * Failures a reader can act on, said the way they would say them. The raw error
 * is kept alongside for whoever has to fix it.
 */
const KNOWN: [RegExp, string][] = [
  [
    /lease expired/i,
    "The worker stopped before it finished — it may have been restarted, redeployed or run out of memory.",
  ],
  [
    /QuotaExhausted|\b402\b|insufficient credits/i,
    "The model provider turned the request down because the account's credits or quota are used up.",
  ],
  [/\b429\b|rate.?limit/i, "The model provider is limiting how fast requests can be made."],
  [
    /no usable text layer|needs OCR/i,
    "This PDF has no text layer — it looks like a scan, and scanned documents cannot be read yet.",
  ],
  [/API_KEY is not set/i, "The workers have no model API key configured."],
  [
    /no chunks produced|parsed to nothing usable/i,
    "Nothing usable was read from the document, so there was nothing to index.",
  ],
  [/no longer exists/i, "The document was deleted while it was being processed."],
  [/storage key|no url returned for/i, "The uploaded file could not be fetched from storage."],
  [/timed? ?out|timeout/i, "A request took too long and was abandoned."],
];

export function explain(raw: string | null | undefined): Problem | null {
  const text = (raw ?? "").trim();
  if (!text) return null;
  const known = KNOWN.find(([pattern]) => pattern.test(text));
  if (known) return { summary: known[1], detail: text };
  // Workers record `TypeName: message`, and the type name says nothing to a reader.
  const message = (text.split("\n")[0] ?? text).replace(/^[A-Za-z_][\w.]*:\s+/, "");
  const summary = message.length > 220 ? `${message.slice(0, 217)}…` : message;
  return { summary, detail: summary === text ? null : text };
}

export type JobState = "queued" | "running" | "retrying" | "stalled" | "done" | "failed";

/** One job, as a person waiting on it would want it told. */
export type JobView = {
  state: JobState;
  /** What the worker says it is doing, or was doing when it stopped. */
  step: string | null;
  done: number | null;
  total: number | null;
  /** Steps finished in this attempt, with how long each took. */
  trail: TrailStep[];
  attempt: number;
  maxAttempts: number;
  /** Running: since this attempt started. Queued: since it became runnable. */
  sinceMs: number | null;
  /** Done: how long the attempt that finished took. */
  tookMs: number | null;
  /** Retrying: until the next attempt may start. */
  retryInMs: number | null;
  problem: Problem | null;
};

/**
 * A job's state from the queue's columns and the worker's report.
 *
 * Shared by the processing stages and by an assessment, whose run row cannot
 * tell on its own whether a worker has picked it up, is retrying after an
 * error, or died holding it. `fallbackError` is the reason recorded somewhere
 * else — the document's, for a stage — for a job that died without one.
 */
export function describeJob(
  job: JobRow,
  now: Date = new Date(),
  fallbackError: string | null = null,
): JobView {
  const at = now.getTime();
  const reported = readProgress(job.progress);
  // A report from an earlier attempt describes work that was abandoned.
  const progress = reported && reported.attempt === job.attempts ? reported : null;
  const startedAt = progress?.startedAt?.getTime() ?? null;
  const said: JobView = {
    state: "queued",
    step: progress?.step ?? null,
    done: progress?.done ?? null,
    total: progress?.total ?? null,
    trail: progress?.trail ?? [],
    attempt: job.attempts,
    maxAttempts: job.maxAttempts,
    sinceMs: null,
    tookMs: null,
    retryInMs: null,
    problem: null,
  };

  switch (job.state) {
    case "done":
      return {
        ...said,
        state: "done",
        step: null,
        done: null,
        total: null,
        tookMs: startedAt === null ? null : Math.max(0, job.updatedAt.getTime() - startedAt),
      };
    case "dead":
    case "failed":
      return { ...said, state: "failed", problem: explain(job.lastError ?? fallbackError) };
    case "leased": {
      // Past its lease, nobody is working on it: the reaper hands it back.
      const stalled = job.leaseUntil !== null && job.leaseUntil.getTime() < at;
      return {
        ...said,
        state: stalled ? "stalled" : "running",
        sinceMs: startedAt === null ? null : Math.max(0, at - startedAt),
      };
    }
    default: {
      if (job.attempts > 0) {
        return {
          ...said,
          state: "retrying",
          done: null,
          total: null,
          retryInMs: Math.max(0, job.runAfter.getTime() - at),
          problem: explain(job.lastError),
        };
      }
      const runnable = Math.max(job.createdAt.getTime(), job.runAfter.getTime());
      return {
        ...said,
        state: "queued",
        step: null,
        done: null,
        total: null,
        trail: [],
        sinceMs: Math.max(0, at - runnable),
      };
    }
  }
}

export function describePipeline(
  document: { status: string; failureReason: string | null },
  jobs: JobRow[],
  now: Date = new Date(),
): PipelineView {
  const at = now.getTime();

  // Re-running a document deletes its jobs first, so the newest row per stage
  // is the current run. A corrected figure re-queues embed on its own, which is
  // also current: that stage really is running again.
  const latest = new Map<Stage, JobRow>();
  for (const job of jobs) {
    if (!isStage(job.stage)) continue;
    const held = latest.get(job.stage);
    if (!held || job.createdAt > held.createdAt) latest.set(job.stage, job);
  }

  const stages = STAGES.map((stage, index): StageView => {
    const job = latest.get(stage);
    const base: StageView = {
      stage,
      title: STAGE_COPY[stage].title,
      about: STAGE_COPY[stage].about,
      state: "waiting",
      step: null,
      done: null,
      total: null,
      trail: [],
      attempt: job?.attempts ?? 0,
      maxAttempts: job?.maxAttempts ?? 5,
      sinceMs: null,
      tookMs: null,
      retryInMs: null,
      problem: null,
    };

    if (!job) {
      // A later stage's job, or a finished document, means this one ran.
      const later = STAGES.slice(index + 1).some((next) => latest.has(next));
      return { ...base, state: later || document.status === "ready" ? "done" : "waiting" };
    }

    return { ...base, ...describeJob(job, now, document.failureReason) };
  });

  // A document marked failed with no dead job to show for it: say where it stopped.
  if (document.status === "failed" && !stages.some((stage) => stage.state === "failed")) {
    const open = stages.findIndex((stage) => stage.state !== "done");
    const index = open === -1 ? stages.length - 1 : open;
    stages[index] = {
      ...stages[index]!,
      state: "failed",
      problem: explain(document.failureReason) ?? {
        summary: "Processing stopped without recording why.",
        detail: null,
      },
    };
  }

  const rows = [...latest.values()];
  const firstQueued = rows.length ? Math.min(...rows.map((job) => job.createdAt.getTime())) : null;

  const failed = stages.find((stage) => stage.state === "failed");
  if (failed) {
    return {
      state: "failed",
      headline: "Processing failed",
      detail: `Stopped at “${failed.title}”${
        failed.attempt > 1 ? ` after ${failed.attempt} attempts` : ""
      }.`,
      current: failed.stage,
      stages,
      elapsedMs: null,
      tookMs: null,
      failure: {
        ...(failed.problem ?? { summary: "Processing stopped.", detail: null }),
        stage: failed.stage,
        attempts: failed.attempt,
      },
    };
  }

  const current = stages.find((stage) => stage.state !== "done");
  if (!current) {
    const finished = rows.length === STAGES.length && firstQueued !== null;
    const lastDone = Math.max(...rows.map((job) => job.updatedAt.getTime()));
    return {
      state: "ready",
      headline: "Ready",
      detail: null,
      current: null,
      stages,
      elapsedMs: null,
      tookMs: finished ? Math.max(0, lastDone - firstQueued) : null,
      failure: null,
    };
  }

  const copy = STAGE_COPY[current.stage];
  const view = (state: PipelineState, headline: string, detail: string | null): PipelineView => ({
    state,
    headline,
    detail,
    current: current.stage,
    stages,
    elapsedMs: firstQueued === null ? null : Math.max(0, at - firstQueued),
    tookMs: null,
    failure: null,
  });

  switch (current.state) {
    case "running":
      return view("working", copy.doing, current.step);
    case "stalled":
      return view(
        "attention",
        "The worker stopped responding",
        `“${current.title}” is handed back to the queue automatically, and another attempt starts within a minute or two.`,
      );
    case "retrying":
      return view(
        "attention",
        "Trying again after an error",
        current.problem
          ? `Attempt ${current.attempt} of ${current.maxAttempts} failed: ${current.problem.summary}`
          : `Attempt ${current.attempt} of ${current.maxAttempts} failed.`,
      );
    case "queued":
      return (current.sinceMs ?? 0) >= SLOW_PICKUP_MS
        ? view(
            "attention",
            "Still waiting for a worker",
            `No ${current.stage} worker has picked this up yet. Every one may be busy with other documents, or none may be running.`,
          )
        : view("waiting", "Queued", `Waiting for a ${current.stage} worker to pick it up.`);
    default:
      return view("waiting", "Queued", null);
  }
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export function formatCount(value: number): string {
  return value.toLocaleString("en-GB");
}
