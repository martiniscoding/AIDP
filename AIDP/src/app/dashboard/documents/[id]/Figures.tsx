"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Eye, Pencil, Sparkles, TriangleAlert, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { reviewFigure } from "../actions";

export type FigureView = {
  id: string;
  page: number;
  caption: string | null;
  description: string;
  correctedDescription: string | null;
  reviewState: string;
  complexity: number;
  headingPath: string;
};

/**
 * Figure review — the diagram beside the model's reading of it.
 *
 * A description is generated text, and once it becomes a chunk nothing
 * distinguishes it from a passage lifted off the page. That is the risk: not a
 * corrupted index, but fabricated evidence that reads like a quotation.
 *
 * Review is not a gate. The document indexed the moment it finished; this is
 * where someone checks the readings that matter, sorted so the dense diagrams
 * a vision model actually struggles with come first.
 */
export function Figures({ figures }: { figures: FigureView[] }) {
  if (figures.length === 0) return null;

  const pending = figures.filter((f) => f.reviewState === "pending").length;

  return (
    <section className="mb-9">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-display text-[17px] font-semibold tracking-[-0.01em] text-white">
          Figures
        </h2>
        <p className="text-[12.5px] text-white/40">
          {pending > 0
            ? `${pending} of ${figures.length} unreviewed — a diagram's description is written by a model, not read off the page.`
            : "All descriptions reviewed."}
        </p>
      </div>

      <ul className="space-y-3">
        {figures.map((figure) => (
          <li key={figure.id}>
            <FigureCard figure={figure} />
          </li>
        ))}
      </ul>
    </section>
  );
}

const STATE: Record<string, { label: string; tone: string }> = {
  pending: { label: "Unreviewed", tone: "border-white/15 bg-white/[0.05] text-white/55" },
  confirmed: { label: "Confirmed", tone: "border-royal-mid/30 bg-royal/12 text-royal-soft" },
  corrected: { label: "Corrected", tone: "border-amber-400/30 bg-amber-400/[0.08] text-amber-300" },
  rejected: { label: "Rejected", tone: "border-red-400/30 bg-red-400/[0.07] text-red-300" },
};

function FigureCard({ figure }: { figure: FigureView }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(figure.correctedDescription ?? figure.description);
  const [message, setMessage] = useState<string | null>(null);

  const state = STATE[figure.reviewState] ?? STATE.pending;
  const shown = figure.correctedDescription ?? figure.description;
  const decided = figure.reviewState !== "pending";

  const act = (action: "confirm" | "correct" | "reject") =>
    startTransition(async () => {
      const result = await reviewFigure(figure.id, { action, description: draft });
      setMessage(result.message);
      setEditing(false);
      router.refresh();
    });

  return (
    <div className="overflow-hidden rounded-xl border border-white/[0.09] bg-white/[0.02]">
      <div className="grid gap-0 md:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
        {/*
          The image, on white. Diagrams are drawn for paper; on a near-black
          panel a navy-on-white schematic is unreadable, which defeats the
          entire point of showing it.
        */}
        <div className="border-b border-white/[0.07] bg-white p-2 md:border-r md:border-b-0">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`/api/figures/${figure.id}`}
            alt={figure.caption ?? `Figure on page ${figure.page}`}
            className="h-auto w-full rounded"
          />
        </div>

        <div className="min-w-0 p-4">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px]",
                state.tone,
              )}
            >
              {figure.reviewState === "rejected" ? (
                <X size={10} />
              ) : decided ? (
                <Check size={10} />
              ) : (
                <Eye size={10} />
              )}
              {state.label}
            </span>
            <span className="text-[11.5px] text-white/30">page {figure.page}</span>
            {figure.complexity >= 40 && (
              <span
                title="Many labels and shapes — the case vision models most often get wrong"
                className="inline-flex items-center gap-1 text-[11.5px] text-amber-300/75"
              >
                <TriangleAlert size={10} />
                dense
              </span>
            )}
            {!figure.correctedDescription && (
              <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-white/30">
                <Sparkles size={10} />
                model-written
              </span>
            )}
          </div>

          {editing ? (
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={7}
              className={cn(
                "w-full resize-y rounded-lg border border-white/15 bg-ink-900 px-3 py-2",
                "text-[13px] leading-relaxed text-white/85",
                "focus:border-royal-mid/60 focus:outline-none",
              )}
            />
          ) : figure.reviewState === "rejected" ? (
            <p className="text-[13px] leading-relaxed text-white/40">
              Rejected as unusable. This figure is not indexed and cannot be cited as
              evidence.
            </p>
          ) : (
            <p className="text-[13px] leading-relaxed whitespace-pre-line text-white/70">
              {shown || "No description was produced for this figure."}
            </p>
          )}

          {figure.correctedDescription && !editing && (
            <details className="mt-2">
              <summary className="cursor-pointer text-[11.5px] text-white/30 hover:text-white/55">
                What the model originally wrote
              </summary>
              <p className="mt-1.5 text-[12px] leading-relaxed whitespace-pre-line text-white/40">
                {figure.description}
              </p>
            </details>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {editing ? (
              <>
                <Action onClick={() => act("correct")} disabled={pending} tone="primary">
                  <Check size={12} />
                  Save and re-index
                </Action>
                <Action onClick={() => setEditing(false)} disabled={pending}>
                  Cancel
                </Action>
              </>
            ) : (
              <>
                <Action onClick={() => act("confirm")} disabled={pending}>
                  <Check size={12} />
                  {figure.reviewState === "confirmed" ? "Confirmed" : "Looks right"}
                </Action>
                <Action onClick={() => setEditing(true)} disabled={pending}>
                  <Pencil size={12} />
                  Correct it
                </Action>
                <Action onClick={() => act("reject")} disabled={pending} tone="danger">
                  <X size={12} />
                  Unusable
                </Action>
              </>
            )}
            {message && <span className="text-[11.5px] text-white/40">{message}</span>}
          </div>
        </div>
      </div>
    </div>
  );
}

function Action({
  children,
  onClick,
  disabled,
  tone = "default",
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  tone?: "default" | "primary" | "danger";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px]",
        "transition-colors disabled:opacity-50",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-royal-mid",
        tone === "primary"
          ? "border-royal-mid/40 bg-royal/15 text-white hover:bg-royal/25"
          : tone === "danger"
            ? "border-white/12 text-white/50 hover:border-red-400/40 hover:text-red-300"
            : "border-white/12 text-white/60 hover:border-white/28 hover:text-white",
      )}
    >
      {children}
    </button>
  );
}
