import { prisma } from "@/lib/prisma";

/**
 * Temporary: proves whether the database connection works, outside Better Auth.
 *
 * Better Auth reports a failed connection as a bare `ErrorEvent` with no
 * message, because that is what the Neon WebSocket driver throws and there was
 * never an Error to carry one. This returns the real failure as text instead,
 * plus the two runtime facts that decide it.
 *
 * Delete once the deployment is healthy.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const runtime = {
    node: process.version,
    hasGlobalWebSocket: typeof WebSocket !== "undefined",
    databaseUrlSet: Boolean(process.env.DATABASE_URL),
    pooled: (process.env.DATABASE_URL ?? "").includes("-pooler"),
  };

  try {
    const users = await prisma.user.count();
    return Response.json({ ok: true, users, runtime });
  } catch (error) {
    return Response.json(
      {
        ok: false,
        runtime,
        error: error instanceof Error ? error.message : String(error),
        kind: error?.constructor?.name ?? typeof error,
      },
      { status: 500 },
    );
  }
}
