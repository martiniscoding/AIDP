import { CATEGORY_LABEL, type AdviceCategory, type AdviceView } from "./advice";
import type { LifecycleView } from "./lifecycle";
import {
  briefSeverityOf,
  readObligation,
  type BriefSeverity,
  type Obligation,
} from "./verdicts";

/**
 * Risk, along the five dimensions the brief names.
 *
 * FR-06: "Risk scoring runs alongside: single points of failure, security
 * exposure, scalability, vendor lock-in, and data residency."
 *
 * Nothing here is new analysis. Every input was already worked out during the
 * run and stored on it — the findings, the suggestions an experienced reviewer
 * would still make, and what public data says about the technologies named.
 * This reads those three and arranges them along the brief's own axes, because
 * a reviewer deciding whether to escalate wants "where is this weak?" and the
 * report currently answers "here are sixty things".
 *
 * ## Two rules it keeps
 *
 * **A dimension nothing spoke to is "not assessed", never "no risk".** They are
 * completely different claims and only one of them is ever supported. A run
 * from before the lock-in category existed has no lock-in findings, and saying
 * "low risk" on that basis would be the report inventing reassurance. The same
 * goes for a submission so thin that the suggestions found nothing to say.
 *
 * **Severity is carried through, not recomputed.** `briefSeverityOf` already
 * grades a finding from its verdict and the obligation the standard
 * established; the highest grade reaching a dimension is the one shown. Working
 * it out a second way here would eventually disagree with the register, and a
 * finding that is Critical on one screen and Moderate on another is worse than
 * either label alone.
 */

/** The brief's five, in the order it lists them. */
export const RISK_DIMENSIONS = [
  "availability",
  "security",
  "scalability",
  "lock_in",
  "data_residency",
] as const;

export type RiskDimension = (typeof RISK_DIMENSIONS)[number];

export const RISK_LABEL: Record<RiskDimension, string> = {
  availability: "Single points of failure",
  security: "Security exposure",
  scalability: "Scalability",
  lock_in: "Vendor lock-in",
  data_residency: "Data residency",
};

/** What each dimension is, for a reader who has not read FR-06. */
export const RISK_BLURB: Record<RiskDimension, string> = {
  availability:
    "Components with no redundancy, and what happens to the system when one of them stops.",
  security: "Interfaces, secrets and privileges the design exposes.",
  scalability: "Whether the described architecture can carry the load the design claims.",
  lock_in: "Where the design commits to one vendor with no stated way back.",
  data_residency: "Where data is held, replicated and moved.",
};

/**
 * Which suggestion categories answer which dimension.
 *
 * The engine groups a reviewer's suggestions by the subject a reviewer thinks
 * in — `resilience`, `security`, `performance` — and the brief names risks.
 * They are the same things under different headings, and this is where the two
 * vocabularies meet. Written out rather than inferred, so that a category added
 * to the engine later is a deliberate decision here rather than a silent
 * disappearance into "other".
 */
const CATEGORY_TO_DIMENSION: Partial<Record<AdviceCategory, RiskDimension>> = {
  resilience: "availability",
  security: "security",
  performance: "scalability",
  lock_in: "lock_in",
  data: "data_residency",
};

/** Clause references, by the dimension their subject belongs to.
 *
 *  Findings carry a clause reference and a verdict, not a category — the
 *  standard decides what a clause is about, not us. So a finding reaches a
 *  dimension only through the suggestions that cite it, which is the one link
 *  the engine already draws (`Suggestion.clauses`). A breach no suggestion
 *  mentions still appears in the report; it simply has no dimension, which is
 *  honest rather than a gap. */
export type RiskContribution = {
  /** The clause, as the finding denormalised it. */
  ref: string;
  severity: BriefSeverity;
  /** Whether that grade is settled, or a placement the evidence did not support.
   *  Carried from `briefSeverityOf` — see its note on the three-tier scale. */
  settled: boolean;
};

export type RiskRow = {
  dimension: RiskDimension;
  label: string;
  blurb: string;
  /** Null when nothing in this run spoke to the dimension at all. The screen
   *  must read this as "not assessed", never as "no risk". */
  severity: BriefSeverity | null;
  /** True when the run carried no information about this dimension — as
   *  distinct from carrying information and finding nothing wrong. */
  assessed: boolean;
  /** How many suggestions landed here. */
  suggestions: number;
  /** The clauses that reached it, worst first. */
  clauses: RiskContribution[];
  /** Technologies whose support has ended, for the dimensions that care. */
  notes: string[];
};

export type RiskView = {
  rows: RiskRow[];
  /** The dimensions nothing in this run could speak to, named so the report can
   *  say so once rather than five times. */
  unassessed: RiskDimension[];
};

const SEVERITY_ORDER: Record<BriefSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

/** The findings a risk row may cite. Structural, so this stays testable without
 *  Prisma. */
export type RiskFinding = {
  clauseRef: string;
  verdict: string;
  obligation: unknown;
};

export function buildRisk(
  findings: RiskFinding[],
  advice: AdviceView | null,
  lifecycle: LifecycleView | null,
): RiskView {
  const graded = new Map<string, { severity: BriefSeverity; settled: boolean }>();
  for (const finding of findings) {
    const obligation: Obligation = readObligation(finding.obligation);
    const grade = briefSeverityOf(finding.verdict, obligation);
    // Null for a covered or inapplicable clause: nothing to act on, so nothing
    // to weigh. The same reasoning `severityOf` gives.
    if (!grade) continue;
    const existing = graded.get(finding.clauseRef);
    if (!existing || SEVERITY_ORDER[grade.tier] < SEVERITY_ORDER[existing.severity]) {
      graded.set(finding.clauseRef, { severity: grade.tier, settled: grade.settled });
    }
  }

  const suggestions = advice?.suggestions ?? [];

  const rows: RiskRow[] = RISK_DIMENSIONS.map((dimension) => {
    const mine = suggestions.filter(
      (suggestion) => CATEGORY_TO_DIMENSION[suggestion.category] === dimension,
    );

    const clauses: RiskContribution[] = [];
    const seen = new Set<string>();
    for (const suggestion of mine) {
      for (const ref of suggestion.clauses ?? []) {
        const grade = graded.get(ref);
        if (!grade || seen.has(ref)) continue;
        seen.add(ref);
        clauses.push({ ref, severity: grade.severity, settled: grade.settled });
      }
    }
    clauses.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

    // Support dates belong to the dimensions they actually bear on. An
    // unsupported component is a thing that can stop (availability) and a thing
    // that stops receiving security fixes — it is *not* evidence about lock-in,
    // which is the mistake this whole category exists to avoid.
    const ended = (lifecycle?.technologies ?? []).filter((tech) => tech.status === "ended");
    const notes =
      dimension === "availability" || dimension === "security"
        ? ended.map((tech) =>
            tech.version
              ? `${tech.name} ${tech.version} is past its supported life.`
              : `${tech.name} is past its supported life.`,
          )
        : [];

    // Assessed means something in this run could speak to the dimension —
    // a suggestion filed under it, or a fact that bears on it. A run that
    // produced no suggestions at all assessed none of them.
    const assessed = mine.length > 0 || notes.length > 0;

    const severity = clauses[0]?.severity ?? (mine.length > 0 ? worstOf(mine) : null);

    return {
      dimension,
      label: RISK_LABEL[dimension],
      blurb: RISK_BLURB[dimension],
      severity: assessed ? severity : null,
      assessed,
      suggestions: mine.length,
      clauses,
      notes,
    };
  });

  return {
    rows,
    unassessed: rows.filter((row) => !row.assessed).map((row) => row.dimension),
  };
}

/**
 * A dimension's grade when no breached clause reached it.
 *
 * Suggestions carry their own priority, which is a reviewer's sense of what to
 * do first rather than a measurement against a standard. So it maps to the
 * lower half of the scale and never to Critical: nothing a suggestion says on
 * its own is a breach, and the brief reserves Critical for what blocks a
 * submission.
 */
function worstOf(suggestions: { priority: string }[]): BriefSeverity {
  if (suggestions.some((suggestion) => suggestion.priority === "high")) return "high";
  if (suggestions.some((suggestion) => suggestion.priority === "medium")) return "medium";
  return "low";
}

/** The category labels, for a screen that wants to say what fed a dimension. */
export function categoriesFor(dimension: RiskDimension): string[] {
  return (Object.keys(CATEGORY_TO_DIMENSION) as AdviceCategory[])
    .filter((category) => CATEGORY_TO_DIMENSION[category] === dimension)
    .map((category) => CATEGORY_LABEL[category]);
}
