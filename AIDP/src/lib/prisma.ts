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
 * Node 22+ (and Vercel's Node runtime) expose a global WebSocket, so no
 * `neonConfig.webSocketConstructor` shim is needed here.
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
 * `Prisma.ModelName` is generated from schema.prisma, so this string changes
 * the moment a model is added or removed — which is exactly when a cached
 * client goes stale. See the note on `globalForPrisma` below.
 */
const schemaFingerprint = Object.keys(Prisma.ModelName).sort().join(",");

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
