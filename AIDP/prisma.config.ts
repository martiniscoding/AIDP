import { config } from "dotenv";
import { defineConfig } from "prisma/config";

/**
 * Prisma 7 no longer reads `.env` on its own, and it knows nothing about
 * Next.js's file precedence. Loading `.env.local` first mirrors what `next dev`
 * does, so the CLI (`prisma migrate`, `prisma studio`) talks to the same
 * database the app does instead of silently falling back to `.env`.
 *
 * Only affects the CLI — the running app gets DATABASE_URL from Next.
 */
config({ path: [".env.local", ".env"], quiet: true });

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    /**
     * Migrations go to the *direct* (non-pooled) Neon host when one is
     * configured, and only fall back to the pooled string otherwise.
     *
     * Neon's pooler runs PgBouncer in transaction mode, which cannot hold the
     * session-level advisory lock `prisma migrate` takes for the length of a
     * migration — against the pooled host it can hang or fail partway. The
     * running app is the opposite case and wants the pooled host, so the two
     * deliberately read different variables.
     */
    url: process.env["DIRECT_DATABASE_URL"] || process.env["DATABASE_URL"],
  },
});
