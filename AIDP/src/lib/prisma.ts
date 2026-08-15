import { PrismaNeon } from "@prisma/adapter-neon";
import { Prisma, PrismaClient } from "../../generated/prisma/client";

/**
 * Prisma client, wired to Neon over its serverless driver.
 *
 * Prisma 7 ships without the Rust query engine — the query compiler runs
 * in-process and every connection goes through a driver adapter, so the adapter
 * below is required rather than an optimisation. `PrismaNeon` speaks Neon's
 * WebSocket protocol, which keeps interactive transactions working; the HTTP
 * variant (`PrismaNeonHttp`) is faster per query but can't hold one open, and
 * Better Auth uses transactions when it creates a user and their account row
 * together.
 *
 * Node 22+ exposes a global WebSocket, so no `neonConfig.webSocketConstructor`
 * shim is needed here — but that makes the Node version a hard requirement
 * rather than a preference, which is why `engines` pins it in package.json.
 *
 * On Node 20 there is no global WebSocket and the adapter fails with a bare
 * `ErrorEvent`: no message, no stack, because it is a DOM-style event and not
 * an Error. Better Auth then logs that empty object and the failure looks like
 * an auth problem when every query is in fact failing. If this ever needs to
 * run on an older runtime, add `ws` and assign `neonConfig.webSocketConstructor`
 * rather than unpinning.
 */

function createPrismaClient() {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example to .env.local and paste your Neon pooled connection string.",
    );
  }

  return new PrismaClient({
    adapter: new PrismaNeon({ connectionString }),
  });
}

/**
 * Fingerprint of the generated client's schema.
 *
 * Everything here is generated from schema.prisma, so this string changes when
 * the generated client does — which is exactly when a cached one goes stale.
 * See the note on `globalForPrisma` below.
 *
 * `Prisma.ModelName` alone is not enough: it moves when a model is added or
 * removed, and sits perfectly still when a field is added to one that already
 * exists. That is the more common migration by far, and it produced a cached
 * client that knew `TechAssessment` but not its new `organisationId` — a query
 * rejected as "Unknown argument" against a column the database really had.
 *
 * Each model's `*ScalarFieldEnum` lists its own fields, so folding those in
 * catches field-level drift too. Relation fields still aren't listed, but a new
 * relation brings a foreign key or a new model with it, and both show up here.
 */
const schemaFingerprint = Object.entries(Prisma as Record<string, unknown>)
  .filter(([name]) => name.endsWith("ScalarFieldEnum"))
  .map(([name, fields]) => `${name}(${Object.keys(fields as object).sort().join(",")})`)
  .sort()
  .join(";");

/**
 * One client per process. Next.js reloads modules on every edit in dev, and a
 * fresh PrismaClient each time would leak a Neon connection pool per reload
 * until the database refuses new connections. Stashing it on globalThis
 * survives HMR; production gets a plain module-level instance.
 *
 * But surviving HMR also means surviving `prisma generate`. Add a model, run a
 * migration, and the dev server keeps handing back the client it built before
 * the model existed — so `prisma.newModel` is `undefined` and the first call
 * fails with "Cannot read properties of undefined (reading 'findMany')", which
 * points at the query rather than at the cache that caused it.
 *
 * Storing the fingerprint alongside the instance closes that: a regenerated
 * client no longer matches, the stale pool is released, and the next request
 * gets a client that knows about the new tables.
 */
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
  prismaSchemaFingerprint: string | undefined;
};

function resolvePrismaClient(): PrismaClient {
  const cached = globalForPrisma.prisma;
  if (cached && globalForPrisma.prismaSchemaFingerprint === schemaFingerprint) {
    return cached;
  }

  // Let the superseded pool go rather than orphaning its Neon connections.
  void cached?.$disconnect().catch(() => {});

  const client = createPrismaClient();
  if (process.env.NODE_ENV !== "production") {
    globalForPrisma.prisma = client;
    globalForPrisma.prismaSchemaFingerprint = schemaFingerprint;
  }
  return client;
}

export const prisma = resolvePrismaClient();
