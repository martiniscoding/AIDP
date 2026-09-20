import { ChevronDown, Lightbulb } from "lucide-react";
import { cn } from "@/lib/cn";
import {
  ADVICE_PRIORITIES,
  CATEGORY_LABEL,
  type AdvicePriority,
  type AdviceView,
  type Suggestion,
} from "@/lib/ingest/advice";
import { RefreshSuggestions } from "./RefreshSuggestions";

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

function where(suggestion: Suggestion): string {
  // A document with no title stores paths that start " › ", so trim each part.
  const path = suggestion.headingPath
    .split("›")
    .map((part) => part.trim())
    .filter(Boolean);
  // The first part is the document's own title, which the reader is already looking
  // at: a section directly under it is named alone, a deeper one by its last two.
  const name =
    path.length === 0
      ? suggestion.sectionTitle
      : path.length <= 2
        ? path[path.length - 1]
        : path.slice(-2).join(" › ");
  const { pageStart, pageEnd } = suggestion;
  const pages =
    pageStart === null
      ? ""
      : pageEnd !== null && pageEnd !== pageStart
        ? `pages ${pageStart}–${pageEnd}`
        : `page ${pageStart}`;
  return [name, pages].filter(Boolean).join(", ");
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
            <ol className="space-y-2">
              {complete.suggestions.map((suggestion) => (
                <SuggestionRow key={suggestion.title} suggestion={suggestion} />
              ))}
            </ol>
          )}
        </div>
      )}
    </section>
  );
}

function SuggestionRow({ suggestion }: { suggestion: Suggestion }) {
  const meta = PRIORITY_META[suggestion.priority];
  return (
    <li className="rounded-xl border border-line bg-card">
      <details className="group">
        <summary className="flex cursor-pointer list-none items-start gap-3 px-4 py-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-royal-mid [&::-webkit-details-marker]:hidden">
          <span
            className={cn(
              "mt-0.5 shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium",
              meta.tone,
            )}
          >
            {meta.label}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[13.5px] font-medium text-ink">{suggestion.title}</span>
            <span className="mt-0.5 block text-[12px] text-ink/62">
              {suggestion.component && (
                <span className="mr-1.5 rounded-md border border-line bg-canvas px-1.5 py-px text-ink/78">
                  {suggestion.component}
                </span>
              )}
              {CATEGORY_LABEL[suggestion.category]} ·{" "}
              {suggestion.kind === "add" ? "Missing from the design" : "Change to the design"}
              {where(suggestion) && ` · ${where(suggestion)}`}
            </span>
          </span>
          <ChevronDown
            size={15}
            aria-hidden="true"
            className="mt-1 shrink-0 text-ink/50 transition-transform group-open:rotate-180"
          />
        </summary>
        <div className="space-y-3 border-t border-line px-4 py-3 text-[13px] leading-relaxed text-ink/84">
          <p>{suggestion.recommendation}</p>
          {suggestion.why && (
            <p className="text-ink/70">
              <span className="font-medium text-ink/82">Why: </span>
              {suggestion.why}
            </p>
          )}
          {suggestion.quote && (
            <figure className="rounded-lg border border-line bg-canvas-sunk px-3 py-2">
              <blockquote className="text-[12.5px] text-ink/82">“{suggestion.quote}”</blockquote>
              <figcaption className="mt-1 text-[11.5px] text-ink/58">
                From the design{suggestion.page !== null ? `, page ${suggestion.page}` : ""}
              </figcaption>
            </figure>
          )}
          {suggestion.clauses.length > 0 && (
            <p className="flex flex-wrap items-center gap-1.5 text-[12px] text-ink/62">
              Would help with
              {suggestion.clauses.map((ref) => (
                <span
                  key={ref}
                  className="rounded-md border border-line bg-canvas px-1.5 py-0.5 text-ink/78"
                >
                  {ref}
                </span>
              ))}
            </p>
          )}
        </div>
      </details>
    </li>
  );
}
