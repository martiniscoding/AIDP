/**
 * Decision vocabulary — no database, no server-only imports.
 *
 * Split from decisions.ts for the reason given at the top of verdicts.ts: that
 * module reaches Prisma, which reaches `node:module`, and a client component
 * importing it fails the build with a chunking error naming the component
 * rather than the import that caused it.
 *
 * Anything here must stay pure and dependency-free.
 */

export const DECISION_EFFECTS = ["accepts", "rejects", "context"] as const;

export type DecisionEffect = (typeof DECISION_EFFECTS)[number];

export const EFFECT_META: Record<
  DecisionEffect,
  { label: string; tone: "good" | "bad" | "neutral"; blurb: string }
> = {
  accepts: {
    label: "Accepts",
    tone: "good",
    blurb: "What this describes satisfies the clause. Stop raising it.",
  },
  rejects: {
    label: "Rejects",
    tone: "bad",
    blurb: "What this describes does not satisfy the clause, and is a breach.",
  },
  context: {
    label: "Context",
    tone: "neutral",
    blurb: "Background to weigh. Does not settle the clause on its own.",
  },
};

export const DECISION_STATUSES = ["active", "superseded", "expired"] as const;

export type DecisionStatus = (typeof DECISION_STATUSES)[number];

export const STATUS_META: Record<DecisionStatus, { label: string; blurb: string }> = {
  active: { label: "In force", blurb: "Applied to every assessment from now on." },
  superseded: { label: "Superseded", blurb: "Replaced by a later decision." },
  expired: { label: "Expired", blurb: "Past its end date, or retired by hand." },
};

/** Shown on a finding: the decisions that shaped it. Denormalised at write. */
export type AppliedDecision = {
  id: string;
  title: string;
  effect: DecisionEffect;
};

export function readAppliedDecisions(value: unknown): AppliedDecision[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    if (typeof row.id !== "string" || typeof row.title !== "string") return [];
    const effect = (DECISION_EFFECTS as readonly string[]).includes(String(row.effect))
      ? (row.effect as DecisionEffect)
      : "context";
    return [{ id: row.id, title: row.title, effect }];
  });
}
