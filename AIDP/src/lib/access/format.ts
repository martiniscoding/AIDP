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

/**
 * "3 minutes ago", "yesterday", "12 Aug" — when something happened.
 *
 * Relative while it is recent enough for "how long ago" to be the useful
 * question, absolute once it is not. A feed of "47 days ago" entries reads as
 * precision nobody asked for.
 *
 * Rendered on the client from a Date the server sent, so it follows the
 * reader's clock rather than the server's.
 */
export function formatWhen(at: Date | string | null): string {
  if (!at) return "—";
  const then = typeof at === "string" ? new Date(at) : at;
  const seconds = Math.round((Date.now() - then.getTime()) / 1000);

  if (seconds < 45) return "just now";
  if (seconds < 90) return "a minute ago";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? "an hour ago" : `${hours} hours ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;

  return then.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    ...(then.getFullYear() === new Date().getFullYear() ? {} : { year: "numeric" }),
  });
}
