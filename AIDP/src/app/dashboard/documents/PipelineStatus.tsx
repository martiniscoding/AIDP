import { AlertTriangle, Check, Clock, LoaderCircle, RotateCw, X } from "lucide-react";
import { cn } from "@/lib/cn";
import {
  SLOW_PICKUP_MS,
  STAGE_COPY,
  formatCount,
  formatDuration,
  type PipelineView,
  type StageState,
  type StageView,
  type TrailStep,
} from "@/lib/ingest/pipeline";
import { Ticker } from "./Ticker";

/**
 * Processing, stage by stage, for a document still on its way in.
 *
 * Says what is happening, how far along it is where that can be counted, how
 * long it has taken, and — when something is wrong — what is wrong, in words,
 * and what to do about it. A spinner beside a stage name cannot tell a slow
 * document from a stuck one, or a stuck one from a queue with no worker behind
 * it; this can.
 */
export function PipelineStatus({ view, canRerun }: { view: PipelineView; canRerun: boolean }) {
  const failedAt = view.failure
    ? view.stages.findIndex((stage) => stage.stage === view.failure?.stage)
    : -1;
  const troubled = view.state === "failed" || view.state === "attention";

  return (
    <section
      aria-labelledby="pipeline-heading"
      className={cn(
        "card-sheen mb-8 rounded-2xl border bg-card p-5 shadow-card sm:p-6",
        troubled ? "border-warn-line" : "border-line",
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0 flex-1" aria-live="polite">
          <p className="text-[11px] font-medium tracking-[0.08em] text-ink/58 uppercase">
            Processing
          </p>
          <h2
            id="pipeline-heading"
            className={cn(
              "mt-1 font-display text-[18px] font-semibold tracking-[-0.01em]",
              troubled ? "text-warn" : "text-ink",
            )}
          >
            {view.headline}
          </h2>
        </div>
        {view.elapsedMs !== null && (
          <p className="shrink-0 text-[12px] text-ink/62 sm:text-right">
            <span className="block">Elapsed</span>
            <span className="block text-[15px] font-medium text-ink/88">
              <Ticker ms={view.elapsedMs} />
            </span>
          </p>
        )}
      </div>

      <ol className="mt-5 border-t border-line-soft pt-5">
        {view.stages.map((stage, index) => (
          <StageRow
            key={stage.stage}
            stage={stage}
            last={index === view.stages.length - 1}
            notReached={failedAt !== -1 && index > failedAt}
          />
        ))}
      </ol>

      {view.failure && (
        <div className="mt-5 rounded-xl border border-warn-line bg-warn-tint px-4 py-3.5">
          <p className="flex items-start gap-2 text-[13.5px] font-medium text-warn">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
            {view.failure.summary}
          </p>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink/72">
            {canRerun
              ? "Once the cause is dealt with, use Re-run above to process the document again from the start."
              : "Once the cause is dealt with, an administrator can re-run it."}
          </p>
          {view.failure.detail && (
            <details className="mt-2">
              <summary className="cursor-pointer text-[12px] text-ink/62 hover:text-ink/82">
                Technical detail
              </summary>
              <pre className="mt-1.5 max-h-48 overflow-auto rounded-lg border border-line bg-card p-2.5 text-[11.5px] leading-relaxed break-words whitespace-pre-wrap text-ink/74">
                {view.failure.detail}
              </pre>
            </details>
          )}
        </div>
      )}
    </section>
  );
}

function StageRow({
  stage,
  last,
  notReached,
}: {
  stage: StageView;
  last: boolean;
  notReached: boolean;
}) {
  const counted = stage.total !== null && stage.total > 0 && stage.done !== null;

  return (
    <li className="relative flex gap-3.5 pb-6 last:pb-0">
      {!last && (
        <span
          aria-hidden="true"
          className={cn(
            "absolute top-8 bottom-1.5 left-[13.5px] w-px",
            stage.state === "done" ? "bg-ok-line" : "bg-line",
          )}
        />
      )}
      <Marker state={stage.state} />

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 pt-1">
          <h3
            className={cn(
              "text-[14px] font-medium",
              stage.state === "waiting" ? "text-ink/62" : "text-ink/92",
            )}
          >
            {stage.title}
          </h3>
          <StateLine stage={stage} notReached={notReached} />
        </div>

        <p className="mt-0.5 text-[12.5px] leading-relaxed text-ink/66">
          <Body stage={stage} notReached={notReached} counted={counted} />
        </p>

        {stage.state === "running" &&
          (counted ? (
            <div
              role="progressbar"
              aria-label={stage.step ?? stage.title}
              aria-valuemin={0}
              aria-valuemax={stage.total ?? 0}
              aria-valuenow={stage.done ?? 0}
              className="mt-2 h-1.5 max-w-md overflow-hidden rounded-full bg-canvas-sunk"
            >
              <div
                className="h-full rounded-full bg-linear-to-r from-royal to-royal-mid transition-[width] duration-700 ease-out"
                style={{
                  width: `${Math.max(2, Math.min(100, ((stage.done ?? 0) / (stage.total ?? 1)) * 100))}%`,
                }}
              />
            </div>
          ) : (
            // Nothing countable in this step, so the bar says "moving", not "how far".
            <span
              aria-hidden="true"
              className="mt-2 block h-1.5 max-w-md overflow-hidden rounded-full bg-canvas-sunk"
            >
              <span className="rail-slide block h-full w-1/4 bg-linear-to-r from-transparent via-royal to-transparent" />
            </span>
          ))}

        {stage.trail.length > 0 &&
          (stage.state === "done" ? (
            <details className="mt-1.5">
              <summary className="cursor-pointer text-[11.5px] text-ink/58 hover:text-ink/80">
                What it did
              </summary>
              <Trail trail={stage.trail} />
            </details>
          ) : (
            <Trail trail={stage.trail} />
          ))}
      </div>
    </li>
  );
}

const MARKER: Record<StageState, { className: string; icon: React.ReactNode }> = {
  done: { className: "border-ok-line bg-ok-tint text-ok", icon: <Check size={13} /> },
  running: {
    className: "border-royal-mid/40 bg-royal-tint text-royal",
    icon: <LoaderCircle size={14} className="motion-safe:animate-spin" />,
  },
  queued: { className: "border-line bg-canvas-sunk text-ink/60", icon: <Clock size={13} /> },
  retrying: { className: "border-warn-line bg-warn-tint text-warn", icon: <RotateCw size={13} /> },
  stalled: {
    className: "border-warn-line bg-warn-tint text-warn",
    icon: <AlertTriangle size={13} />,
  },
  failed: { className: "border-warn-line bg-warn-tint text-warn", icon: <X size={13} /> },
  waiting: {
    className: "border-line bg-card text-ink/40",
    icon: <span className="block size-1.5 rounded-full bg-current" />,
  },
};

function Marker({ state }: { state: StageState }) {
  const { className, icon } = MARKER[state];
  return (
    <span
      aria-hidden="true"
      className={cn(
        "relative grid size-7 shrink-0 place-items-center rounded-full border",
        className,
      )}
    >
      {icon}
    </span>
  );
}

function StateLine({ stage, notReached }: { stage: StageView; notReached: boolean }) {
  const tone: Record<StageState, string> = {
    done: "text-ok",
    running: "text-royal",
    queued: "text-ink/62",
    retrying: "text-warn",
    stalled: "text-warn",
    failed: "text-warn",
    waiting: "text-ink/58",
  };

  let content: React.ReactNode;
  switch (stage.state) {
    case "done":
      content = stage.tookMs === null ? "Done" : `Done in ${formatDuration(stage.tookMs)}`;
      break;
    case "running":
      content = (
        <>
          Running
          {stage.sinceMs !== null && (
            <>
              {" · "}
              <Ticker ms={stage.sinceMs} />
            </>
          )}
          {stage.attempt > 1 && ` · attempt ${stage.attempt} of ${stage.maxAttempts}`}
        </>
      );
      break;
    case "queued":
      content = (
        <>
          Queued
          {stage.sinceMs !== null && (
            <>
              {" · "}
              <Ticker ms={stage.sinceMs} />
            </>
          )}
        </>
      );
      break;
    case "retrying":
      content = stage.retryInMs ? (
        <>
          Next attempt in <Ticker ms={stage.retryInMs} direction="down" />
        </>
      ) : (
        "Next attempt shortly"
      );
      break;
    case "stalled":
      content = "Not responding";
      break;
    case "failed":
      content = stage.attempt > 1 ? `Failed after ${stage.attempt} attempts` : "Failed";
      break;
    default:
      content = notReached ? "Not reached" : "Waiting";
  }

  return <p className={cn("text-[12px] whitespace-nowrap", tone[stage.state])}>{content}</p>;
}

function Body({
  stage,
  notReached,
  counted,
}: {
  stage: StageView;
  notReached: boolean;
  counted: boolean;
}) {
  switch (stage.state) {
    case "running":
      if (!stage.step) return stage.about;
      return (
        <>
          {stage.step}
          {counted && (
            <>
              {" · "}
              <span className="tabular-nums">
                {formatCount(stage.done ?? 0)} of {formatCount(stage.total ?? 0)}
              </span>
            </>
          )}
        </>
      );
    case "queued":
      return (stage.sinceMs ?? 0) >= SLOW_PICKUP_MS
        ? `No ${stage.stage} worker has picked this up yet. Every one may be busy with other documents, or none may be running.`
        : `Waiting for a ${stage.stage} worker to pick it up.`;
    case "retrying":
      return `Attempt ${stage.attempt} of ${stage.maxAttempts} failed${
        stage.problem ? `: ${stage.problem.summary}` : "."
      }`;
    case "stalled":
      return `${stage.step ? `Last seen: ${stage.step}. ` : ""}It goes back in the queue automatically once the worker's lease runs out.`;
    case "failed":
      return stage.step ? `Stopped while: ${stage.step}` : "Stopped here.";
    case "waiting":
      return notReached ? "Runs once the step before it succeeds." : stage.about;
    default:
      return stage.about;
  }
}

function Trail({ trail }: { trail: TrailStep[] }) {
  return (
    <ul className="mt-2 flex flex-wrap gap-x-3.5 gap-y-1 text-[11.5px] text-ink/60">
      {trail.map((entry, index) => (
        <li key={`${index}-${entry.step}`} className="inline-flex items-center gap-1">
          <Check size={10} className="text-ok" aria-hidden="true" />
          {entry.step}
          <span className="text-ink/58 tabular-nums">
            {entry.seconds < 1 ? "<1s" : formatDuration(entry.seconds * 1000)}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** The same, in one line, for a row in a list. */
export function PipelineBadge({ view }: { view: PipelineView }) {
  const stage = view.stages.find((candidate) => candidate.stage === view.current) ?? null;
  const warn = view.state === "attention" || view.state === "failed";

  return (
    <span className="flex min-w-0 items-center gap-2.5">
      <Rail stages={view.stages} />
      <span
        className={cn(
          "min-w-0 truncate text-[11.5px] whitespace-nowrap",
          warn ? "text-warn" : "text-ink/68",
        )}
      >
        {warn && <AlertTriangle size={10} className="mr-1 inline align-[-1px]" aria-hidden="true" />}
        <BadgeText view={view} stage={stage} />
      </span>
    </span>
  );
}

function BadgeText({ view, stage }: { view: PipelineView; stage: StageView | null }) {
  if (!stage) return view.headline;
  switch (stage.state) {
    case "running": {
      const doing = STAGE_COPY[stage.stage].doing;
      if (stage.total && stage.done !== null) {
        return (
          <>
            {doing} ·{" "}
            <span className="tabular-nums">
              {formatCount(stage.done)}/{formatCount(stage.total)}
            </span>
          </>
        );
      }
      return stage.sinceMs === null ? (
        doing
      ) : (
        <>
          {doing} · <Ticker ms={stage.sinceMs} />
        </>
      );
    }
    case "queued":
      return (stage.sinceMs ?? 0) >= SLOW_PICKUP_MS ? (
        <>
          Waiting for a worker · <Ticker ms={stage.sinceMs ?? 0} />
        </>
      ) : (
        "Queued"
      );
    case "retrying":
      return "Retrying after an error";
    case "stalled":
      return "Worker not responding";
    case "failed":
      return "Failed";
    default:
      return "Queued";
  }
}

/** Three stages, each filled as far as it has got. */
function Rail({ stages }: { stages: StageView[] }) {
  return (
    <span aria-hidden="true" className="hidden shrink-0 items-center gap-1 sm:flex">
      {stages.map((stage) => {
        const fraction =
          stage.state === "done"
            ? 1
            : stage.state === "running" && stage.total
              ? Math.min(1, (stage.done ?? 0) / stage.total)
              : 0;
        return (
          <span
            key={stage.stage}
            className="relative block h-1 w-5 overflow-hidden rounded-full bg-canvas-sunk"
          >
            {fraction > 0 && (
              <span
                className="absolute inset-y-0 left-0 rounded-full bg-royal transition-[width] duration-700 ease-out"
                style={{ width: `${fraction * 100}%` }}
              />
            )}
            {stage.state === "running" && !stage.total && (
              <span className="rail-slide absolute inset-y-0 w-1/2 bg-linear-to-r from-transparent via-royal to-transparent" />
            )}
            {(stage.state === "retrying" || stage.state === "stalled") && (
              <span className="absolute inset-0 rounded-full bg-warn/60" />
            )}
          </span>
        );
      })}
    </span>
  );
}
