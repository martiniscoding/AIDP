/**
 * What an assessment can end in — no database, no server-only imports.
 *
 * Split out for the reason given at the top of verdicts.ts: the module that
 * reaches Prisma cannot be imported by a client component without failing the
 * build with a chunking error that names the wrong file.
 *
 * The four outcomes are the ones the product promises, and they are deliberately
 * not "pass/fail". An architecture review rarely ends in a verdict; it ends in a
 * decision about what happens next, and "escalate" is a real answer rather than
 * an absence of one.
 *
 * "Reject" and "revise" are both refusals, and what separates them is the
 * instruction attached. Revise names what has to change and expects the design
 * back; reject says this design is not the way forward and does not. A tool
 * offering only revise makes a reviewer phrase a dead end as homework, and the
 * author resubmits the same approach with the edges sanded off.
 *
 * Ordered as the brief lists them, because that is the order the people who
 * wrote the governance process will look for them in.
 */

export const OUTCOMES = ["approved", "rejected", "revise", "escalated"] as const;

export type Outcome = (typeof OUTCOMES)[number];

export const OUTCOME_META: Record<
  Outcome,
  {
    label: string;
    tone: "good" | "bad" | "warn" | "escalate";
    blurb: string;
    /** Whether a reason has to be given. */
    requiresNote: boolean;
    /**
     * Whether the decision has to rest on a finding the report actually cited.
     *
     * Only a rejection does. Everything else in this system refuses an uncited
     * claim made *by the engine*; this refuses one made by a person, and for
     * the same reason — "rejected, basis unrecorded" is the row a governance
     * audit cannot act on, and the author cannot answer. Enforced in `record`
     * in outcomes.ts, which is where the report is in reach.
     */
    requiresFinding: boolean;
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
    requiresFinding: false,
    commitment: "This design may proceed as submitted.",
  },
  rejected: {
    label: "Reject",
    tone: "bad",
    blurb: "The design is refused. It is not coming back as a revision of itself.",
    // A refusal with no stated basis is the one outcome an author cannot act on
    // and an audit cannot defend.
    requiresNote: true,
    requiresFinding: true,
    commitment:
      "This design is refused on the findings you cite. The author is not being asked to resubmit it.",
  },
  revise: {
    label: "Revise & resubmit",
    tone: "warn",
    blurb: "Address the findings and submit the design again.",
    // Without saying what must change, "revise" is not an instruction.
    requiresNote: true,
    requiresFinding: false,
    commitment: "The author must address what you write below and resubmit.",
  },
  escalated: {
    label: "Escalate to ARB",
    tone: "escalate",
    blurb: "Route to the architecture review board with this report attached.",
    // A board needs to know why it is being asked.
    requiresNote: true,
    // A board can be convened over a question the report did not raise — an
    // unpriced risk, a precedent nobody is comfortable setting — so this is the
    // one refusal-shaped outcome that does not have to cite a finding.
    requiresFinding: false,
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
