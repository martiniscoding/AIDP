import { prisma } from "@/lib/prisma";
import { currentUser } from "@/lib/access/gate";

/**
 * Proves whether the database connection works, outside Better Auth.
 *
 * Better Auth reports a failed connection as a bare `ErrorEvent` with no
 * message, because that is what the Neon WebSocket driver throws and there was
 * never an Error to carry one. This returns the real failure as text instead,
 * plus the two runtime facts that decide it.
 *
 * Operators only.
 * ---------------
 * This answered anybody, including a signed-out stranger, and the answer was a
 * reconnaissance kit: whether the deployment can reach its database, whether
 * `DATABASE_URL` is set and pooled, the Node version, and — through the error
 * text — the driver's own account of why a connection failed, which can carry
 * the host. The user count told an outsider how large the customer base is.
 *
 * It is a diagnostic worth keeping, so it is gated rather than deleted: the
 * proxy cannot help here (it only checks that *some* session cookie exists, and
 * any customer has one), so admission is settled against the database, the same
 * way src/app/admin/layout.tsx settles it.
 *
 * 404, not 403. A refusal confirms the route exists; this is the arrangement the
 * admin console uses, for the same reason.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const user = await currentUser();
  if (!user?.isPlatformAdmin) {
    return Response.json({ error: "Not found." }, { status: 404 });
  }

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
