/**
 * First-run bootstrap for `.env.local`: provisions a local dev secret and makes
 * sure the keys the app reads at boot are at least present.
 *
 * Wired to `predev`. It is idempotent per *key*, not per file — an .env.local
 * generated before Neon was introduced has no DATABASE_URL line, and a script
 * that bailed on `existsSync` would never repair it, leaving the app to throw
 * at the first query with nothing in the file to hint at why.
 *
 * Existing values are never touched: a key that is already there, even if it is
 * empty, is left exactly as the developer left it.
 *
 * Schema is not this script's job. Postgres lives in Neon and the tables are
 * owned by `prisma/schema.prisma`; run `npm run db:migrate` to apply them. Node
 * strips the TypeScript at load, so there's no build step involved.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

const envPath = ".env.local";

type Entry = {
  key: string;
  /** Generated lazily so a fresh secret is only minted when one is missing. */
  value: () => string;
  comment?: string[];
};

const REQUIRED: Entry[] = [
  {
    key: "BETTER_AUTH_SECRET",
    // Without this Better Auth falls back to a shared default and warns on
    // every request. Generated into .env.local, which is gitignored —
    // production should set it through the real environment instead.
    value: () => randomBytes(32).toString("base64"),
  },
  {
    key: "BETTER_AUTH_URL",
    value: () => "http://localhost:3000",
  },
  {
    key: "DATABASE_URL",
    // Left empty on purpose: only the developer has this string. The app fails
    // loudly and specifically when it is blank (see src/lib/prisma.ts).
    value: () => "",
    comment: [
      "# Neon *pooled* connection string — the app will not serve a request",
      "# without it. Neon Console → Connection string → pooling ON, or run",
      "# `vercel env pull .env.local` if the project is linked. See .env.example.",
    ],
  },
  {
    key: "PLATFORM_ADMIN_EMAILS",
    // Empty is the correct default: on a fresh database nobody should hold the
    // operator console until someone deliberately names themselves.
    value: () => "",
    comment: [
      "# Comma-separated emails that get the operator console at /admin.",
      "# Bootstrap only — an account listed here is promoted on its next",
      "# sign-in, and the database column is the authority afterwards.",
    ],
  },
];

const HEADER = [
  "# Generated on first run. Local development only — do not commit.",
  "# Production should set these through the deployment environment.",
];

const existing = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";

// Matches `KEY=`, tolerating leading whitespace and an `export` prefix. A
// commented-out key does not count as present — that's a placeholder, not a
// setting.
const declares = (key: string) =>
  new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`, "m").test(existing);

const missing = REQUIRED.filter((entry) => !declares(entry.key));

if (missing.length === 0) {
  process.exit(0);
}

const block = missing.flatMap((entry) => [
  ...(entry.comment ?? []),
  `${entry.key}=${entry.value()}`,
  "",
]);

const body = existing
  ? // Separate the appended block from whatever is already there, without
    // collapsing the developer's own spacing.
    `${existing.replace(/\s*$/, "")}\n\n${block.join("\n")}`
  : `${[...HEADER, ...block].join("\n")}`;

writeFileSync(envPath, body);

console.log(
  `[dexter] ${existsSync(envPath) && existing ? "added" : "generated"} ${envPath}: ${missing
    .map((entry) => entry.key)
    .join(", ")}`,
);

if (missing.some((entry) => entry.key === "DATABASE_URL")) {
  console.log(
    "[dexter] DATABASE_URL is empty — paste your Neon pooled connection string into .env.local, then run `npm run db:migrate`.",
  );
}
