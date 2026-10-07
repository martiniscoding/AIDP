/**
 * Verdict vocabulary and shapes — no database, no server-only imports.
 *
 * Split out from assessment.ts so the client can have it. That module reaches
 * Prisma, which reaches `node:module`, and a client component importing it
 * fails the build with a chunking error that names the component rather than
 * the import that caused it.
 *
 * Anything here must stay pure and dependency-free.
 */

export const VERDICTS = [
  "contradicts",
  "absent",
  "partial",
  "needs_review",
  "covered",
] as const;

export type Verdict = (typeof VERDICTS)[number];

/** Ordered worst-first: the review queue should open on what matters. */
export const VERDICT_META: Record<
  Verdict,
  { label: string; tone: "bad" | "warn" | "unknown" | "good"; blurb: string }
> = {
  contradicts: {
    label: "Contradicts",
    tone: "bad",
    blurb: "The design states something the standard forbids.",
  },
  absent: {
    label: "Absent",
    tone: "bad",
    blurb: "The design does not address this requirement at all.",
  },
  partial: {
    label: "Partial",
    tone: "warn",
    blurb: "Addressed, but a requirement is left unmet.",
  },
  needs_review: {
    label: "Needs review",
    tone: "unknown",
    blurb: "The evidence was inconclusive. A person has to decide.",
  },
  covered: { label: "Covered", tone: "good", blurb: "Every requirement is met." },
};

/**
 * How much a finding should worry the person reading it.
 *
 * Distinct from the verdict, and the distinction is the point. The verdict says
 * what the engine concluded; this says where to start. A reviewer with eighty
 * findings open is not asking "what category is this" — they are asking "which
 * of these do I have to deal with before the design ships".
 *
 * It replaced the model's confidence percentage on the row. That number was
 * answering a question nobody had: it is the model's opinion of itself, it does
 * not mean the gap is serious, and 87% next to "Contradicts" invited a reader
 * to treat a breach as 13% fine. The confidence is still there, inside the
 * finding, where somebody doubting a verdict will look for it.
 */
export const SEVERITIES = ["critical", "moderate", "check"] as const;

export type Severity = (typeof SEVERITIES)[number];

export const SEVERITY_META: Record<
  Severity,
  { label: string; tone: "bad" | "warn" | "unknown"; blurb: string }
> = {
  critical: {
    label: "Critical",
    tone: "bad",
    blurb: "The design breaks this requirement or does not address it. Fix before it ships.",
  },
  moderate: {
    label: "Moderate",
    tone: "warn",
    blurb: "Addressed, but something the requirement asks for is missing.",
  },
  check: {
    label: "Check",
    tone: "unknown",
    blurb: "The engine could not settle this one. A person has to look.",
  },
};

/**
 * The line above which an "absent" is treated as settled rather than as a
 * question.
 *
 * Not a number picked for this screen. It is `CONFIRM_CONFIDENCE` from
 * Workers/aidp/stages/analyse.py — the confidence the engine records for an
 * absent it has gone back and *confirmed* with a second read and a checked
 * quote. So the rule reads: anything at least as sure as a double-checked
 * finding is treated as settled.
 *
 * Picking the engine's other constant (0.85, "sure enough to need no second
 * opinion") would have been worse, because it sits above 0.7 and would file
 * every confirmed absent under "check" — the most thoroughly verified findings
 * in the report marked as the doubtful ones.
 *
 * Nothing weaker than 0.55 reaches here at all: the analyse stage demotes those
 * to `needs_review` before they are ever written.
 */
export const SETTLED_CONFIDENCE = 0.7;

/**
 * How serious this finding is, from what the finding already carries.
 *
 * Null for `covered` — there is nothing to act on, and a row that says
 * "Covered · Low" reads as a problem when it is the opposite.
 *
 * `contradicts` is never softened by confidence. The analyse stage is already
 * asymmetric about it: a contradiction with no evidence behind it is demoted
 * rather than reported, so one that reaches a screen has been through a
 * stricter gate than any other verdict, and the design actively stating
 * something the standard forbids is the worst thing this tool can find.
 */
export function severityOf(verdict: string, confidence: number): Severity | null {
  if (verdict === "covered") return null;
  if (verdict === "contradicts") return "critical";
  if (verdict === "absent") return confidence >= SETTLED_CONFIDENCE ? "critical" : "check";
  if (verdict === "partial") return "moderate";
  // needs_review, and anything a future engine adds that this has not been
  // taught: "a person has to look" is the safe answer, never "critical".
  return "check";
}

export type VerdictCounts = Record<Verdict, number>;

/**
 * Which findings a report is showing.
 *
 * "attention" is what a report opens on: everything except covered. A covered
 * finding is the evidence that a clause was checked and passed — an audit asks
 * for exactly that, and a wrong one is the most expensive mistake this tool can
 * make, so they are folded rather than dropped and the count stays on screen.
 */
export type Lens = Verdict | "attention" | "all";

/**
 * Apply a lens. Pure, and separate from the component, so the rule can be
 * tested as a rule — the component is a Client Component, and every finding
 * reaches the browser in its props whether or not it is drawn, which makes
 * "is it on the page?" unanswerable from the HTML.
 */
export function applyLens<T extends { verdict: string }>(findings: T[], lens: Lens): T[] {
  if (lens === "all") return findings;
  if (lens === "attention") return findings.filter((finding) => finding.verdict !== "covered");
  return findings.filter((finding) => finding.verdict === lens);
}

export function emptyCounts(): VerdictCounts {
  return Object.fromEntries(VERDICTS.map((v) => [v, 0])) as VerdictCounts;
}

export type EvidenceItem = {
  chunkId: string;
  headingPath: string;
  page: number | null;
  excerpt: string;
  /** "clause" | "table_row" | "figure" | … — where the passage came from. */
  sourceKind: string;
  /**
   * Set only when the passage is a model's reading of a diagram. The finding
   * renders the diagram beside it, so the claim can be checked against the
   * thing it was made about.
   */
  figureId: string | null;
  /**
   * Which design the passage is from, on a run over a whole project. A page
   * number is not an address when four designs each have a page 12, so the
   * finding names the file. Empty on a design run, and on findings from before
   * projects could be assessed.
   */
  documentId: string;
  documentTitle: string;
};

/** `evidence` is Json in the schema; narrow it before rendering. */
export function readEvidence(value: unknown): EvidenceItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    if (typeof row.chunkId !== "string") return [];
    return [
      {
        chunkId: row.chunkId,
        headingPath: typeof row.headingPath === "string" ? row.headingPath : "",
        page: typeof row.page === "number" ? row.page : null,
        excerpt: typeof row.excerpt === "string" ? row.excerpt : "",
        sourceKind: typeof row.sourceKind === "string" ? row.sourceKind : "clause",
        figureId: typeof row.figureId === "string" ? row.figureId : null,
        documentId: typeof row.documentId === "string" ? row.documentId : "",
        documentTitle: typeof row.documentTitle === "string" ? row.documentTitle : "",
      },
    ];
  });
}
