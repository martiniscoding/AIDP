"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Check,
  ChevronDown,
  CircleHelp,
  Loader2,
  Play,
  ShieldAlert,
  TriangleAlert,
} from "lucide-react";
import { cn } from "@/lib/cn";
import {
  VERDICTS,
  VERDICT_META,
  type EvidenceItem,
  type Verdict,
  type VerdictCounts,
} from "@/lib/ingest/verdicts";
import { reviewFinding, startAssessment } from "../actions";

export type FindingView = {
  id: string;
  clauseRef: string;
  clauseTitle: string;
  clauseStatement: string;
  verdict: string;
  confidence: number;
  rationale: string;
  evidence: EvidenceItem[];
  reviewerState: string;
  reviewerVerdict: string | null;
  reviewerNote: string | null;
};

export type RunView = {
  id: string;
  state: string;
  totalClauses: number;
  completedClauses: number;
  frameworkName: string;
  frameworkVersion: number;
  model: string | null;
  failureReason: string | null;
} | null;

const TONE: Record<string, string> = {
  bad: "border-red-400/30 bg-red-400/[0.07] text-red-300",
  warn: "border-amber-400/30 bg-amber-400/[0.07] text-amber-300",
  unknown: "border-white/15 bg-white/[0.05] text-white/60",
  good: "border-royal-mid/30 bg-royal/12 text-royal-soft",
};

/**
 * The assessment surface for a submitted design.
 *
 * Findings arrive worst-first and default to collapsed. A reviewer working a
 * hundred-clause run needs the shape of the result before any one row, and the
 * rows they will actually open are the handful at the top.
 */
export function Assessment({
  documentId,
  run,
  counts,
  findings,
}: {
  documentId: string;
  run: RunView;
  counts: VerdictCounts;
  findings: FindingView[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [filter, setFilter] = useState<Verdict | null>(null);

  const running = run?.state === "queued" || run?.state === "running";
  const shown = filter ? findings.filter((f) => f.verdict === filter) : findings;
  const reviewed = findings.filter((f) => f.reviewerState !== "pending").length;

  const begin = () =>
    startTransition(async () => {
      const result = await startAssessment(documentId);
      setMessage(result.message);
      router.refresh();
    });

  return (
    <section className="mb-10">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="font-display text-[17px] font-semibold tracking-[-0.01em] text-white">
            Assessment
          </h2>
          <p className="mt-1 text-[12.5px] text-white/40">
            {run
              ? `${run.frameworkName} v${run.frameworkVersion}` +
                (run.model ? ` · ${run.model}` : "")
              : "Measure this design against every clause in the standards library."}
          </p>
        </div>

        <button
          type="button"
          onClick={begin}
          disabled={pending || running}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-[12.5px] transition-colors",
            "border-royal-mid/40 bg-royal/15 text-white hover:bg-royal/25",
            "disabled:cursor-not-allowed disabled:opacity-55",
            "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-royal-mid",
          )}
        >
          {pending || running ? (
            <Loader2 size={13} className="animate-spin" />
          ) : (
            <Play size={13} />
          )}
          {running ? "Running…" : run ? "Re-run assessment" : "Run assessment"}
        </button>
      </div>

      {message && <p className="mb-3 text-[12.5px] text-white/50">{message}</p>}

      {run?.failureReason && (
        <p className="mb-4 rounded-xl border border-amber-400/25 bg-amber-400/[0.06] px-4 py-3 text-[13px] text-amber-200/90">
          {run.failureReason}
        </p>
      )}

      {running && (
        <div className="mb-4 rounded-xl border border-white/[0.09] bg-white/[0.02] px-4 py-3">
          <div className="mb-2 flex items-center justify-between text-[12.5px] text-white/55">
            <span>Assessing clause by clause…</span>
            <span>
              {run.completedClauses} / {run.totalClauses}
            </span>
          </div>
          <div className="h-1 overflow-hidden rounded-full bg-white/10">
            <div
              className="h-full rounded-full bg-royal-mid transition-[width] duration-700"
              style={{
                width: `${run.totalClauses ? (run.completedClauses / run.totalClauses) * 100 : 0}%`,
              }}
            />
          </div>
        </div>
      )}

      {run && findings.length > 0 && (
        <>
          {/* Coverage across the framework. Also the filter. */}
          <div className="mb-4 flex flex-wrap gap-2">
            {VERDICTS.map((verdict) => {
              const meta = VERDICT_META[verdict];
              const count = counts[verdict];
              const active = filter === verdict;
              return (
                <button
                  key={verdict}
                  type="button"
                  title={meta.blurb}
                  onClick={() => setFilter(active ? null : verdict)}
                  disabled={count === 0}
                  className={cn(
                    "inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-[12.5px] transition-opacity",
                    TONE[meta.tone],
                    count === 0 && "opacity-35",
                    active && "ring-2 ring-white/30",
                    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-royal-mid",
                  )}
                >
                  <span className="font-display text-[15px] font-semibold">{count}</span>
                  {meta.label}
                </button>
              );
            })}
          </div>

          <p className="mb-3 text-[12px] text-white/35">
            {reviewed} of {findings.length} reviewed
            {filter && (
              <>
                {" · "}
                <button
                  type="button"
                  onClick={() => setFilter(null)}
                  className="text-royal-soft hover:text-white"
                >
                  clear filter
                </button>
              </>
            )}
          </p>

          <ul className="space-y-2">
            {shown.map((finding) => (
              <FindingRow key={finding.id} finding={finding} />
            ))}
          </ul>
        </>
      )}

      {run && findings.length === 0 && !running && (
        <p className="rounded-xl border border-white/10 bg-white/[0.015] px-5 py-8 text-center text-[13.5px] text-white/40">
          No findings recorded. The run may have failed before it reached a clause.
        </p>
      )}
    </section>
  );
}

function FindingRow({ finding }: { finding: FindingView }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [overriding, setOverriding] = useState(false);

  const meta = VERDICT_META[finding.verdict as Verdict] ?? VERDICT_META.needs_review;
  const decided = finding.reviewerState !== "pending";

  const decide = (confirm: boolean, verdict?: string) =>
    startTransition(async () => {
      await reviewFinding(finding.id, { confirm, verdict });
      setOverriding(false);
      router.refresh();
    });

  return (
    <li className="overflow-hidden rounded-xl border border-white/[0.09] bg-white/[0.02]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-white/[0.03] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-royal-mid"
      >
        <span
          className={cn(
            "mt-0.5 inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-1 text-[11px]",
            TONE[meta.tone],
          )}
        >
          {meta.tone === "bad" ? (
            <ShieldAlert size={11} />
          ) : meta.tone === "warn" ? (
            <TriangleAlert size={11} />
          ) : meta.tone === "good" ? (
            <Check size={11} />
          ) : (
            <CircleHelp size={11} />
          )}
          {meta.label}
        </span>

        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-mono text-[11.5px] text-white/35">{finding.clauseRef}</span>
            <span className="text-[13.5px] text-white/85">{finding.clauseTitle}</span>
          </span>
          {finding.rationale && (
            <span className="mt-1 block text-[12.5px] leading-relaxed text-white/45">
              {finding.rationale}
            </span>
          )}
        </span>

        <span className="flex shrink-0 items-center gap-2 text-[11.5px] text-white/30">
          {decided && (
            <span
              className={cn(
                "rounded px-1.5 py-0.5",
                finding.reviewerState === "overridden"
                  ? "bg-amber-400/15 text-amber-300/85"
                  : "bg-white/[0.07] text-white/50",
              )}
            >
              {finding.reviewerState === "overridden"
                ? `→ ${finding.reviewerVerdict ?? "changed"}`
                : "confirmed"}
            </span>
          )}
          <span>{Math.round(finding.confidence * 100)}%</span>
          <ChevronDown
            size={14}
            className={cn("transition-transform duration-200", open && "rotate-180")}
          />
        </span>
      </button>

      {open && (
        <div className="border-t border-white/[0.07] px-4 py-3.5">
          {finding.clauseStatement && (
            <p className="mb-3 text-[13px] leading-relaxed text-white/60">
              <span className="text-white/35">Requires: </span>
              {finding.clauseStatement}
            </p>
          )}

          {finding.evidence.length > 0 ? (
            <ul className="mb-3 space-y-2">
              {finding.evidence.map((item) => (
                <li
                  key={item.chunkId}
                  className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-2.5"
                >
                  <p className="mb-1 text-[11.5px] text-white/35">
                    {item.headingPath}
                    {item.page != null && ` · page ${item.page}`}
                  </p>
                  <p className="text-[12.5px] leading-relaxed text-white/70">{item.excerpt}</p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mb-3 text-[12.5px] text-white/35">
              No passage in the submitted document was cited for this finding.
            </p>
          )}

          {finding.reviewerNote && (
            <p className="mb-3 text-[12.5px] text-white/50">
              <span className="text-white/35">Note: </span>
              {finding.reviewerNote}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={pending}
              onClick={() => decide(true)}
              className="inline-flex items-center gap-1.5 rounded-full border border-white/12 px-3 py-1.5 text-[12px] text-white/60 transition-colors hover:border-white/28 hover:text-white disabled:opacity-50"
            >
              <Check size={12} />
              Confirm
            </button>

            {overriding ? (
              <span className="flex flex-wrap items-center gap-1.5">
                {VERDICTS.filter((v) => v !== finding.verdict).map((verdict) => (
                  <button
                    key={verdict}
                    type="button"
                    disabled={pending}
                    onClick={() => decide(false, verdict)}
                    className={cn(
                      "rounded-full border px-2.5 py-1 text-[11.5px] transition-opacity hover:opacity-80 disabled:opacity-50",
                      TONE[VERDICT_META[verdict].tone],
                    )}
                  >
                    {VERDICT_META[verdict].label}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => setOverriding(false)}
                  className="text-[12px] text-white/35 hover:text-white/70"
                >
                  cancel
                </button>
              </span>
            ) : (
              <button
                type="button"
                disabled={pending}
                onClick={() => setOverriding(true)}
                className="rounded-full border border-white/12 px-3 py-1.5 text-[12px] text-white/50 transition-colors hover:border-amber-400/40 hover:text-amber-300 disabled:opacity-50"
              >
                Override
              </button>
            )}
          </div>
        </div>
      )}
    </li>
  );
}
