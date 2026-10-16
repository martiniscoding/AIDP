"use client";

import { useState } from "react";
import { Check, ChevronRight, Lightbulb, X } from "lucide-react";
import { cn } from "@/lib/cn";
import {
  ADVICE_PRIORITIES,
  CATEGORY_LABEL,
  type AdvicePriority,
  type AdviceView,
  type Suggestion,
} from "@/lib/ingest/advice";
import { RefreshSuggestions } from "./RefreshSuggestions";
import { ImprovementDialog } from "./ItemDialogs";
import { itemKey, useReviewMarks } from "@/lib/ingest/review-marks";

/**
 * The report's "Suggested improvements": what an experienced reviewer would still
 * ask of this design, beyond whether it meets the standards.
 *
 * Set apart from the findings on purpose. A finding is a verdict against a clause
 * the customer wrote; a suggestion is general practice a model proposed. A reader
 * must never take one for the other, so the section says what it is before it
 * lists anything, and no suggestion wears a verdict's colours.
 *
 * Each is shown with the part of the design it concerns and, where it asks for a
 * change, the design's own words — checked against the document before they were
 * kept.
 */

const PRIORITY_META: Record<AdvicePriority, { label: string; tone: string }> = {
  high: { label: "High", tone: "border-royal-mid/40 bg-royal-tint text-royal-deep" },
  medium: { label: "Medium", tone: "border-line-strong bg-canvas-sunk text-ink/80" },
  low: { label: "Low", tone: "border-line bg-card text-ink/62" },
};

/**
 * A stable name for one suggestion.
 *
 * Built from what it is about rather than where it sits, so a mark follows the
 * suggestion across a page load and does not transfer to whatever takes its
 * index after a refresh.
 */
function keyOf(suggestion: Suggestion): string {
  return itemKey([
    suggestion.section,
    suggestion.component,
    suggestion.title,
    suggestion.recommendation.slice(0, 80),
  ]);
}

function Notice({ children, warn = false }: { children: React.ReactNode; warn?: boolean }) {
  return (
    <p
      className={cn(
        "rounded-xl border px-4 py-3 text-[12.5px] leading-relaxed",
        warn ? "border-warn-line bg-warn-tint text-warn" : "border-line bg-card text-ink/64",
      )}
    >
      {children}
    </p>
  );
}

/** A day, the same on the server and in the browser — no locale or zone to disagree over. */
function day(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function Improvements({ advice, runId }: { advice: AdviceView | null; runId: string }) {
  const complete = advice?.state === "complete" ? advice : null;
  /**
   * Which suggestion is open, by its content key.
   *
   * An id rather than an index, for the reason the compliance list uses one:
   * the array is rewritten by a refresh, and an index would then point at a
   * different suggestion than the one on screen. A key built from the content
   * either finds the same suggestion or finds nothing and closes.
   */
  const [openKey, setOpenKey] = useState<string | null>(null);
  const { marks, mark } = useReviewMarks(runId, "advice");
  const refreshing = advice?.refreshing === true;
  const tally = complete
    ? ADVICE_PRIORITIES.map((priority) => ({
        priority,
        n: complete.suggestions.filter((s) => s.priority === priority).length,
      })).filter(({ n }) => n > 0)
    : [];
  // "skipped" means switched off, no key, or no stored pages — asking again
  // cannot change any of those, so there is nothing to offer.
  const askable = advice?.state !== "skipped";
  const openIndex =
    openKey === null || !complete
      ? -1
      : complete.suggestions.findIndex((s) => keyOf(s) === openKey);

  return (
    <section aria-labelledby="improvements-heading" className="mt-10">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3
          id="improvements-heading"
          className="flex items-center gap-2 font-display text-[15px] font-semibold tracking-[-0.01em] text-ink"
        >
          <Lightbulb size={15} className="text-royal" aria-hidden="true" />
          Suggested improvements
        </h3>
        <div className="flex flex-wrap items-center gap-3">
          {tally.length > 0 && (
            <p className="text-[12px] text-ink/62">
              {tally.map(({ priority, n }) => `${n} ${PRIORITY_META[priority].label.toLowerCase()}`).join(" · ")}
            </p>
          )}
          {askable && (
            <RefreshSuggestions
              runId={runId}
              refreshing={refreshing}
              label={complete ? "Get new suggestions" : "Suggest improvements"}
            />
          )}
        </div>
      </div>

      {refreshing && (
        <div className="mb-3">
          <Notice>
            {complete
              ? "Working out a new set of suggestions. The ones below stay until it is ready, in about a minute."
              : "Working out suggestions for this design. This takes about a minute."}
          </Notice>
        </div>
      )}

      {!advice ? (
        <Notice>
          This assessment ran before improvements were suggested. Use “Suggest improvements” to
          work them out without assessing the design again.
        </Notice>
      ) : !complete ? (
        refreshing ? null : (
          <Notice warn>
            {advice.note ?? "Improvements to this design could not be suggested for this run."}
          </Notice>
        )
      ) : (
        <div className="space-y-3">
          {complete.refreshError && !refreshing && (
            <Notice warn>
              {complete.refreshError} These are the earlier suggestions; try again in a moment.
            </Notice>
          )}
          <p className="text-[12.5px] leading-relaxed text-ink/68">
            General best practice{complete.model ? ` from ${complete.model}` : ""}, after reading the
            whole design. These are not requirements of your standards and change no finding above.
            Nothing here was checked against outside sources, so confirm anything that depends on
            current versions or support dates.
          </p>
          {complete.generatedAt && (
            <p className="text-[12px] text-ink/58">
              {complete.source === "cache"
                ? `Reused from ${day(complete.generatedAt)}: the design and your standards have not changed since, so the same suggestions are shown. Ask for new ones to have the design read again.`
                : `Worked out on ${day(complete.generatedAt)}.`}
            </p>
          )}
          {(complete.truncated || complete.setAside > 0 || complete.overLimit > 0) && (
            <p className="text-[12px] text-ink/58">
              {[
                complete.truncated &&
                  "Long sections were shortened to fit one reading, so something inside them may have been missed.",
                complete.setAside > 0 &&
                  `${complete.setAside} more ${complete.setAside === 1 ? "was" : "were"} set aside because ${complete.setAside === 1 ? "it" : "they"} could not be tied to a part of this design, in its own words.`,
                complete.overLimit > 0 &&
                  `${complete.overLimit} lower-priority ${complete.overLimit === 1 ? "suggestion was" : "suggestions were"} left out to keep the list short.`,
              ]
                .filter(Boolean)
                .join(" ")}
            </p>
          )}

          {complete.suggestions.length === 0 ? (
            <Notice>No specific improvements were suggested for this design.</Notice>
          ) : (
            <>
              <ol className="space-y-2">
                {complete.suggestions.map((suggestion) => {
                  const key = keyOf(suggestion);
                  return (
                    <SuggestionRow
                      key={key}
                      suggestion={suggestion}
                      mark={marks[key]}
                      onOpen={() => setOpenKey(key)}
                    />
                  );
                })}
              </ol>

              {/* One dialog for the list, so it can step between suggestions —
                  the same arrangement the compliance tab uses. */}
              {openIndex >= 0 && (
                <ImprovementDialog
                  suggestion={complete.suggestions[openIndex]!}
                  mark={marks[keyOf(complete.suggestions[openIndex]!)]}
                  onMark={(value) => {
                    mark(keyOf(complete.suggestions[openIndex]!), value);
                    // Decide and move: the point of the pattern is that a
                    // reviewer with thirty suggestions never goes back to the
                    // list to find their place. The last one closes.
                    const next = complete.suggestions[openIndex + 1];
                    setOpenKey(next ? keyOf(next) : null);
                  }}
                  position={{ index: openIndex, total: complete.suggestions.length }}
                  onNavigate={(delta) => {
                    const next = complete.suggestions[openIndex + delta];
                    if (next) setOpenKey(keyOf(next));
                  }}
                  onClose={() => setOpenKey(null)}
                />
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * One suggestion as a strip, with the detail over the top.
 *
 * Was a `<details>` that expanded in place, which is the pattern the
 * compliance tab moved away from: thirty suggestions expanding inline is the
 * wall of text the report exists to avoid, and a reviewer loses their place
 * every time they open one. The strip carries what decides whether to open it
 * — priority, category, the component and the first line — and the dialog
 * carries the rest.
 */
function SuggestionRow({
  suggestion,
  mark,
  onOpen,
}: {
  suggestion: Suggestion;
  mark: "accepted" | "dismissed" | undefined;
  onOpen: () => void;
}) {
  const meta = PRIORITY_META[suggestion.priority];
  const settled = mark !== undefined;

  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        aria-haspopup="dialog"
        className={cn(
          "flex w-full items-center gap-3 rounded-xl border px-3.5 py-2.5 text-left transition-colors",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-royal-mid",
          settled
            ? "border-line bg-canvas-sunk/60 hover:bg-canvas-sunk"
            : "border-line bg-card hover:border-line-strong",
        )}
      >
        <span
          className={cn(
            "shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium",
            meta.tone,
            settled && "opacity-70",
          )}
        >
          {meta.label}
        </span>

        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline gap-x-2">
            <span
              className={cn(
                "truncate text-[13.5px]",
                settled ? "text-ink/62" : "text-ink/88",
              )}
            >
              {suggestion.title}
            </span>
            {suggestion.component && (
              <span className="font-mono text-[11.5px] text-ink/58">{suggestion.component}</span>
            )}
          </span>
          <span
            className={cn(
              "mt-0.5 block truncate text-[12.5px] leading-relaxed",
              settled ? "text-ink/50" : "text-ink/66",
            )}
          >
            {suggestion.recommendation}
          </span>
        </span>

        <span className="flex shrink-0 items-center gap-2 text-[11.5px] text-ink/62">
          {mark === "accepted" && (
            <span className="hidden items-center gap-1 rounded bg-ok-tint px-1.5 py-0.5 text-ok sm:inline-flex">
              <Check size={10} aria-hidden="true" />
              Accepted
            </span>
          )}
          {mark === "dismissed" && (
            <span className="hidden items-center gap-1 rounded bg-canvas-sunk px-1.5 py-0.5 text-ink/68 sm:inline-flex">
              <X size={10} aria-hidden="true" />
              Dismissed
            </span>
          )}
          <span className="hidden text-ink/58 sm:inline">
            {CATEGORY_LABEL[suggestion.category]}
          </span>
          <ChevronRight size={14} className="text-ink/40" aria-hidden="true" />
        </span>
      </button>
    </li>
  );
}
