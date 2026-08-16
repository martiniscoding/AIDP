/**
 * Presentation helpers for usage figures.
 *
 * Separate from usage.ts, which imports Prisma. The roster table is a Client
 * Component and needs to format a token count; importing it from the module
 * that opens a database connection drags the server into the browser bundle,
 * which Turbopack refuses outright rather than shipping.
 */

/** "1.2M", "48.3k", "912" — a spend figure at a glance. */
export function formatTokens(total: number): string {
  if (total >= 1_000_000) return `${(total / 1_000_000).toFixed(total >= 10_000_000 ? 0 : 1)}M`;
  if (total >= 1_000) return `${(total / 1_000).toFixed(total >= 10_000 ? 0 : 1)}k`;
  return String(total);
}
