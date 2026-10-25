import type { BriefSeverity } from "./verdicts";

/**
 * What the brief's Step 5 says should happen to this submission.
 *
 * The two checks run separately and answer different questions — how big a
 * change this is, and whether it breaks anything. The decision is a function of
 * both, and until now a reviewer had to hold one screen in their head while
 * reading the other.
 *
 * This states the rule; it does not act on it. Recording an outcome is still a
 * person pressing a button, and automating the fast path is Step 5's own work.
 * What this removes is the arithmetic, not the judgement.
 *
 * ## The row the brief's table does not have
 *
 * Its matrix has four rows, keyed on "Critical / High findings present". That
 * works while every finding carries a settled grade — and this engine
 * deliberately produces some that do not. `check` means "severity cannot be
 * settled from the document; a person has to look", and `briefSeverityOf` puts
 * it at the bottom of a four-tier scale because an unquantified finding has to
 * sit somewhere in a ranked list.
 *
 * Read the brief's table literally, a submission whose every finding is
 * unsettled has "no Critical or High findings" and takes the fast path — which
 * is the engine saying *nobody has looked at this* and the workflow answering
 * *then approve it*. So unsettled findings route to a person, and the reason is
 * stated on the screen rather than buried here.
 */

export const ROUTES = ["auto_approve", "architect", "board"] as const;

export type Route = (typeof ROUTES)[number];

export type NextStep = {
  route: Route;
  /** One line, in the words a reviewer would use. */
  headline: string;
  /** Why this route and not another. */
  because: string;
};

export type NextStepInput = {
  /** "significant" | "not_significant", or null when the check has not run —
   *  a design uploaded directly has no intake answers to classify. */
  significance: string | null;
  /** How many findings carry each grade, counting only those that need acting
   *  on. */
  counts: Record<BriefSeverity, number>;
  /** Findings the engine graded but could not settle. These are the reason the
   *  brief's four-row table needs a fifth. */
  unsettled: number;
  /** Findings nobody has reviewed yet. Not a blocker — approving an unread
   *  report is a call an architect is entitled to make — but worth saying. */
  unreviewed: number;
};

export function nextStep(input: NextStepInput): NextStep {
  const blocking = input.counts.critical + input.counts.high;
  const significant = input.significance === "significant";

  // Critical findings and a significant change is the board's case, and the
  // only one the brief sends there by default.
  if (significant && input.counts.critical > 0) {
    return {
      route: "board",
      headline: "Escalate to the architecture review board",
      because: `It is architecturally significant and carries ${plural(input.counts.critical, "Critical finding")}.`,
    };
  }

  if (blocking > 0) {
    return {
      route: "architect",
      headline: "An architect has to review this",
      because: significant
        ? `It is architecturally significant and carries ${describe(input.counts)}.`
        : // The brief is explicit that this case exists: a change below the
          // significance threshold can still breach a standard, and "a
          // standards violation is never silently waived".
          `It is not architecturally significant, but it carries ${describe(input.counts)} — a breach is never waived for being small.`,
    };
  }

  if (significant) {
    return {
      route: "architect",
      headline: "An architect has to review this",
      because: "It is architecturally significant, though nothing it was measured against is breached.",
    };
  }

  // The fifth row. See the note at the top.
  if (input.unsettled > 0) {
    return {
      route: "architect",
      headline: "An architect has to review this",
      because: `Nothing is breached and it is not significant, but ${plural(input.unsettled, "finding")} could not be graded from the document — the engine is saying a person has to look, not that there is nothing to see.`,
    };
  }

  if (input.significance === null) {
    return {
      route: "architect",
      headline: "An architect has to review this",
      because:
        "Nothing is breached, but this was not filed as an architecture request, so there are no intake answers to check the significance criteria against.",
    };
  }

  return {
    route: "auto_approve",
    headline: "This can be approved without a review",
    because:
      input.unreviewed > 0
        ? `It is not architecturally significant and nothing is breached. ${plural(input.unreviewed, "finding")} has not been read yet.`
        : "It is not architecturally significant and nothing it was measured against is breached.",
  };
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function describe(counts: Record<BriefSeverity, number>): string {
  const parts: string[] = [];
  if (counts.critical > 0) parts.push(plural(counts.critical, "Critical finding"));
  if (counts.high > 0) parts.push(plural(counts.high, "High finding"));
  return parts.join(" and ");
}
