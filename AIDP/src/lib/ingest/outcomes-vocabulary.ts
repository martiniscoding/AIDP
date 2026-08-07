/**
 * What an assessment can end in — no database, no server-only imports.
 *
 * Split out for the reason given at the top of verdicts.ts: the module that
 * reaches Prisma cannot be imported by a client component without failing the
 * build with a chunking error that names the wrong file.
 *
 * The three outcomes are the ones the product promises, and they are deliberately
 * not "pass/fail". An architecture review rarely ends in a verdict; it ends in a
 * decision about what happens next, and "escalate" is a real answer rather than
 * an absence of one.
 */

export const OUTCOMES = ["approved", "revise", "escalated"] as const;

export type Outcome = (typeof OUTCOMES)[number];

export const OUTCOME_META: Record<
  Outcome,
  {
    label: string;
    tone: "good" | "warn" | "escalate";
    blurb: string;
    /** Whether a reason has to be given. */
    requiresNote: boolean;
    /** What the person deciding is committing to. */
    commitment: string;
  }
> = {
  approved: {
    label: "Approve",
    tone: "good",
    blurb: "The findings are acceptable. The design proceeds.",
    // An approval can stand on the report itself; the findings are the record.
    requiresNote: false,
    commitment: "This design may proceed as submitted.",
  },
  revise: {
    label: "Revise & resubmit",
    tone: "warn",
    blurb: "Address the findings and submit the design again.",
    // Without saying what must change, "revise" is not an instruction.
    requiresNote: true,
    commitment: "The author must address what you write below and resubmit.",
  },
  escalated: {
    label: "Escalate to ARB",
    tone: "escalate",
    blurb: "Route to the architecture review board with this report attached.",
    // A board needs to know why it is being asked.
    requiresNote: true,
    commitment: "The board will decide, and will record its own outcome here.",
  },
};

/** Counts captured at the moment a decision was taken. */
export type OutcomeSnapshot = {
  verdicts: Record<string, number>;
  /** Findings still unreviewed when the decision was made. */
  unreviewed: number;
  total: number;
};

export function readSnapshot(value: unknown): OutcomeSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const verdicts = row.verdicts;
  if (!verdicts || typeof verdicts !== "object") return null;
  return {
    verdicts: Object.fromEntries(
      Object.entries(verdicts as Record<string, unknown>).map(([k, v]) => [k, Number(v) || 0]),
    ),
    unreviewed: Number(row.unreviewed) || 0,
    total: Number(row.total) || 0,
  };
}

export function isOutcome(value: unknown): value is Outcome {
  return typeof value === "string" && (OUTCOMES as readonly string[]).includes(value);
}
