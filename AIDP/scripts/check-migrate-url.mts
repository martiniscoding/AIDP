/**
 * Refuse to run a migration against Neon's connection pooler.
 *
 * `prisma migrate deploy` takes a session-level advisory lock and holds it for
 * the length of the migration. Neon's pooler runs PgBouncer in transaction
 * mode, which cannot hold one: the lock is taken on whichever backend served
 * that statement and is gone by the next. Prisma then waits ten seconds for a
 * lock it will never get and fails with
 *
 *   Error: P1002 ... Timed out trying to acquire a postgres advisory lock
 *   (SELECT pg_advisory_lock(72707369)). Timeout: 10000ms.
 *
 * which says nothing about pooling and sends people to look at the database's
 * health. The deploy that produced it had reached Neon perfectly well; the
 * host simply ended in `-pooler`.
 *
 * `prisma.config.ts` already prefers DIRECT_DATABASE_URL for exactly this, and
 * falls back to DATABASE_URL when it is unset — which is the right fallback
 * locally, where there is usually no pooler, and the wrong one on Vercel, where
 * DATABASE_URL is the pooled string. So this runs first and says what is
 * actually wrong, before ten seconds of waiting turn into a build failure
 * nobody can read.
 *
 * It only refuses the case it is sure about: a pooled host with no direct URL
 * set. Anything else — a direct URL present, a non-Neon database, a host
 * without `-pooler` — passes through untouched.
 */

const direct = process.env.DIRECT_DATABASE_URL?.trim();
const pooled = process.env.DATABASE_URL?.trim();
const chosen = direct || pooled;

if (!chosen) {
  console.error(
    "\nNo database URL is set, so migrations cannot run.\n\n" +
      "  Set DATABASE_URL (the app's pooled connection string) and\n" +
      "  DIRECT_DATABASE_URL (the same host with `-pooler` removed).\n",
  );
  process.exit(1);
}

function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

if (!direct && host(pooled ?? "").includes("-pooler")) {
  console.error(
    "\nDIRECT_DATABASE_URL is not set, and DATABASE_URL points at Neon's pooler.\n\n" +
      "  Migrations take a session-level advisory lock. Neon's pooler runs in\n" +
      "  transaction mode and cannot hold one, so `prisma migrate deploy` waits\n" +
      "  ten seconds and fails with P1002 — which looks like the database is\n" +
      "  down when it is simply the wrong host for this one command.\n\n" +
      "  Set DIRECT_DATABASE_URL to the same connection string with `-pooler`\n" +
      "  removed from the host:\n\n" +
      `    pooled  ${host(pooled ?? "")}\n` +
      `    direct  ${host(pooled ?? "").replace("-pooler", "")}\n\n` +
      "  On Vercel that is Project Settings -> Environment Variables, for every\n" +
      "  environment the build runs in. The app itself keeps using the pooled\n" +
      "  DATABASE_URL; only migrations use the direct one.\n",
  );
  process.exit(1);
}

// Said once, so a successful deploy's log records which host it migrated.
console.log(
  `[dexter] migrating against ${host(chosen)}${direct ? " (DIRECT_DATABASE_URL)" : ""}`,
);
