import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { resolve } from "@/lib/access/credentials";

/**
 * The organisation's model key, for the Python workers.
 *
 * The workers do not hold customer keys. They ask here, once per job, with the
 * shared secret — the same arrangement as /api/internal/files and the same
 * reasoning: the means of decryption exists in one runtime, rotation does not
 * mean redeploying two, and every read of a customer's key passes one audit
 * point. Security Standards §5.2 asks for keys to be restricted to authorised
 * processes, and two runtimes each holding a copy is the arrangement that makes
 * rotation something nobody ever does.
 *
 *   GET /api/internal/credentials?organisationId=…
 *     → { credential: { provider, apiKey, model, fastModel, … } }
 *     → { credential: null }   no key, inactive, or unreadable
 *
 * `credential: null` is an answer, not a failure. It means "use the
 * environment's key", which is what every organisation did before customers
 * could bring their own. The worker distinguishes that from an *error* here,
 * which it retries — see Workers/aidp/credentials.py. Conflating the two is how
 * a deployment would quietly spend the operator's money on a customer who had
 * configured their own.
 */

export const runtime = "nodejs";

function authorised(request: Request): boolean {
  const expected = process.env.WORKER_SHARED_SECRET;
  if (!expected) return false;

  const presented = request.headers.get("x-worker-secret") ?? "";
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  // Constant-time, and length-guarded because timingSafeEqual throws on a
  // mismatch rather than returning false.
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function GET(request: Request) {
  if (!authorised(request)) {
    return NextResponse.json({ error: "Not authorised." }, { status: 401 });
  }

  const organisationId = new URL(request.url).searchParams.get("organisationId");
  if (!organisationId) {
    return NextResponse.json({ error: "organisationId is required." }, { status: 400 });
  }

  try {
    const credential = await resolve(organisationId);
    // Deliberately no logging of the organisation on the common path. This
    // endpoint is hit once per job; a line per job saying which customer is
    // working is a usage log nobody asked for, and the usage table already
    // records what was spent.
    return NextResponse.json(
      { credential },
      // Never cached anywhere, by anything. A revoked key has to stop working.
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    // A failure here must not read as "no key": the worker retries an error and
    // falls back on a null, and getting that backwards spends the wrong money.
    console.error(
      "[credentials] resolve failed",
      JSON.stringify({ organisationId, error: error instanceof Error ? error.message : "unknown" }),
    );
    return NextResponse.json({ error: "Could not resolve the credential." }, { status: 500 });
  }
}
