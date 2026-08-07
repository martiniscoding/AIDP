"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArrowUpRight, Check, Gavel, RefreshCw } from "lucide-react";
import { cn } from "@/lib/cn";
import {
  OUTCOMES,
  OUTCOME_META,
  type Outcome,
  type OutcomeSnapshot,
} from "@/lib/ingest/outcomes-vocabulary";
import { recordOutcome } from "../actions";

export type OutcomeView = {
  id: string;
  decision: Outcome;
  note: string;
  decidedByName: string;
  createdAt: string;
  snapshot: OutcomeSnapshot | null;
};

const TONE: Record<string, string> = {
  good: "border-emerald-400/30 bg-emerald-400/[0.08] text-emerald-300",
  warn: "border-amber-400/30 bg-amber-400/[0.08] text-amber-300",
  escalate: "border-royal-mid/40 bg-royal/[0.12] text-royal-soft",
};

const ICON = {
  approved: Check,
  revise: RefreshCw,
  escalated: ArrowUpRight,
} as const;

/**
 * The end of the review.
 *
 * A report with no decision on it is an unfinished piece of work — there is no
 * record of who accepted a design or why, which is the first thing a governance
 * audit asks for. This is where that gets written down.
 *
 * The panel deliberately shows what is still outstanding without blocking on
 * it. Approving a report with contradictions open is a legitimate call an
 * architect is entitled to make; the system's job is to make sure the call was
 * an informed one and that it is on the record.
 */
export function Decide({
  runId,
  history,
  unreviewed,
  open,
}: {
  runId: string;
  history: OutcomeView[];
  /** Findings nobody has confirmed or overridden yet. */
  unreviewed: number;
  /** Findings that contradict the standard or leave it unaddressed. */
  open: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [chosen, setChosen] = useState<Outcome | null>(null);
  const [note, setNote] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  const current = history[0] ?? null;
  const meta = chosen ? OUTCOME_META[chosen] : null;

  const submit = () =>
    chosen &&
    startTransition(async () => {
      const result = await recordOutcome(runId, chosen, note);
      setMessage(result.message);
      if (result.ok) {
        setChosen(null);
        setNote("");
      }
      router.refresh();
    });

  return (
    <section className="mb-10">
      <h2 className="mb-1 font-display text-[17px] font-semibold tracking-[-0.01em] text-white">
        Decision
      </h2>
      <p className="mb-4 text-[12.5px] text-white/40">
        {current
          ? "This submission has been decided. Recording another adds to the history."
          : "Every assessment ends in a recorded outcome."}
      </p>

      {history.length > 0 && (
        <ol className="mb-5 space-y-2">
          {history.map((entry, index) => {
            const entryMeta = OUTCOME_META[entry.decision];
            const Icon = ICON[entry.decision];
            return (
              <li
                key={entry.id}
                className={cn(
                  "rounded-xl border p-4",
                  index === 0 ? "border-white/[0.12] bg-white/[0.03]" : "border-white/[0.07] opacity-70",
                )}
              >
                <div className="flex flex-wrap items-center gap-2.5">
                  <span
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11.5px]",
                      TONE[entryMeta.tone],
                    )}
                  >
                    <Icon size={11} />
                    {entryMeta.label}
                  </span>
                  <span className="text-[12.5px] text-white/45">
                    {entry.decidedByName || "Unattributed"} ·{" "}
                    {new Date(entry.createdAt).toLocaleDateString(undefined, {
                      day: "numeric",
                      month: "short",
                      year: "numeric",
                    })}
                  </span>
                  {index === 0 && history.length > 1 && (
                    <span className="text-[11px] text-white/30">current</span>
                  )}
                </div>

                {entry.note && (
                  <p className="mt-2.5 text-[13px] leading-relaxed text-white/70">{entry.note}</p>
                )}

                {/* What the report said at the moment of the decision. Findings
                    stay editable afterwards, so without this the record drifts. */}
                {entry.snapshot && (
                  <p className="mt-2 text-[11.5px] text-white/35">
                    At the time: {entry.snapshot.total} findings
                    {entry.snapshot.unreviewed > 0 &&
                      `, ${entry.snapshot.unreviewed} unreviewed`}
                    {Object.entries(entry.snapshot.verdicts)
                      .filter(([, n]) => n > 0)
                      .map(([verdict, n]) => ` · ${n} ${verdict.replace(/_/g, " ")}`)
                      .join("")}
                  </p>
                )}
              </li>
            );
          })}
        </ol>
      )}

      {(unreviewed > 0 || open > 0) && !chosen && (
        <p className="mb-3 text-[12.5px] text-amber-200/70">
          {open > 0 && `${open} finding${open === 1 ? "" : "s"} still contradict or are unaddressed`}
          {open > 0 && unreviewed > 0 && " · "}
          {unreviewed > 0 && `${unreviewed} not yet reviewed`}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        {OUTCOMES.map((outcome) => {
          const outcomeMeta = OUTCOME_META[outcome];
          const Icon = ICON[outcome];
          return (
            <button
              key={outcome}
              type="button"
              disabled={pending}
              aria-pressed={chosen === outcome}
              onClick={() => setChosen(chosen === outcome ? null : outcome)}
              title={outcomeMeta.blurb}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-[12.5px] transition-[box-shadow,opacity]",
                TONE[outcomeMeta.tone],
                chosen === outcome ? "ring-2 ring-white/50" : "opacity-70 hover:opacity-100",
                "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-royal-mid",
              )}
            >
              <Icon size={13} />
              {outcomeMeta.label}
            </button>
          );
        })}
      </div>

      {chosen && meta && (
        <div className="mt-3.5 rounded-xl border border-white/10 bg-ink-950/40 p-4">
          <p className="mb-3 text-[12.5px] text-white/55">{meta.commitment}</p>

          <label className="block">
            <span className="mb-1.5 block text-[11.5px] text-white/40">
              {meta.requiresNote ? "Reason (required)" : "Reason (optional)"}
            </span>
            <textarea
              value={note}
              onChange={(event) => setNote(event.target.value)}
              rows={3}
              placeholder={
                chosen === "revise"
                  ? "What has to change before this is resubmitted?"
                  : chosen === "escalated"
                    ? "What is the board being asked to decide?"
                    : "Anything worth recording alongside the approval."
              }
              className="w-full resize-y rounded-lg border border-white/12 bg-white/[0.03] px-2.5 py-2 text-[13px] text-white/85 placeholder:text-white/25 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-royal-mid"
            />
          </label>

          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              disabled={pending || (meta.requiresNote && !note.trim())}
              onClick={submit}
              className="inline-flex items-center gap-1.5 rounded-full bg-royal px-4 py-1.5 text-[12.5px] font-medium text-white transition-colors hover:bg-royal-mid disabled:opacity-40"
            >
              <Gavel size={13} />
              Record {OUTCOME_META[chosen].label.toLowerCase()}
            </button>
            <button
              type="button"
              onClick={() => {
                setChosen(null);
                setNote("");
              }}
              className="text-[12.5px] text-white/35 transition-colors hover:text-white/70"
            >
              cancel
            </button>
          </div>
        </div>
      )}

      {message && (
        <p role="status" className="mt-3 text-[12.5px] text-white/55">
          {message}
        </p>
      )}
    </section>
  );
}
