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

export type VerdictCounts = Record<Verdict, number>;

export function emptyCounts(): VerdictCounts {
  return Object.fromEntries(VERDICTS.map((v) => [v, 0])) as VerdictCounts;
}

export type EvidenceItem = {
  chunkId: string;
  headingPath: string;
  page: number | null;
  excerpt: string;
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
      },
    ];
  });
}
