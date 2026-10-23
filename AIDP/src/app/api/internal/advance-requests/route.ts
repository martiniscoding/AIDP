import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { advanceSubmitted } from "@/lib/ingest/requests";

/**
 * Start the assessment for submitted requests whose documents have finished
 * indexing.
 *
 * The step the engine does not take. `NEXT_STAGE["embed"]` is None, so the
 * worker chain lands a document as "ready" and stops; an analyse job is only
 * ever created by a person pressing "Assess". Deciding to assess needs the
 * framework version, which of a project's designs are ready and how many
 * findings that comes to — none of which the worker has — so the decision
 * stays here and the worker simply says when a document is ready.
 *
 *   POST /api/internal/advance-requests
 *   POST /api/internal/advance-requests  { "documentId": "..." }
 *     → { started, waiting, failed }
 *
 * With a `documentId` it advances the request that document belongs to, which
 * is what the embed worker asks for the moment it finishes one — see
 * Workers/aidp/notify.py. Without one it sweeps everything, which is what a
 * scheduled caller would do.
 *
 * Nothing schedules it today. The worker's push is the fast path and the
 * screens sweep for themselves before they render, which between them covers
 * the request that is waiting and the person waiting on it. This endpoint
 * stays because the push needs somewhere to arrive, and because a deployment
 * that would rather run a timer — beside the workers, or Vercel Cron on a plan
 * that allows one — has something to point it at.
 *
 * Idempotent and safe to call as often as you like: it only ever acts on
 * requests in "submitted" with a document and no run, and the first thing it
 * does to one is move it out of that set. A document that belongs to no
 * request — somebody's hand-uploaded design, which is most of them — matches
 * nothing and answers zero.
 *
 * ## Who may call it
 *
 * Two callers, and each proves itself differently.
 *
 * The embed worker presents `WORKER_SHARED_SECRET`, through the same header it
 * already uses for /api/internal/credentials and /api/internal/files. It holds
 * that secret wherever it runs, so this needs no new configuration anywhere.
 * The same header is what drives this by hand or from a test.
 *
 * Vercel Cron signs its own requests with `CRON_SECRET`, which it sends as a
 * bearer token when a variable of exactly that name is set on the project.
 * Accepted so that adding a `crons` entry to vercel.json is all a timer takes —
 * though Vercel's Hobby plan allows only a daily one, which is why there is no
 * entry there now and why the screens sweep instead.
 *
 * With neither configured the route refuses everything. An endpoint that starts
 * billable model work must never be open, and "no secret set" is a deployment
 * that has not finished rather than a reason to let anyone in.
 */

export const runtime = "nodejs";
/** Reads and writes rows on every call; a cached response would be a lie. */
export const dynamic = "force-dynamic";

function matches(presented: string, expected: string | undefined): boolean {
  if (!expected) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  // Constant-time, and length-guarded because timingSafeEqual throws on a
  // mismatch rather than returning false.
  return a.length === b.length && timingSafeEqual(a, b);
}

function authorised(request: Request): boolean {
  const bearer = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (bearer && matches(bearer, process.env.CRON_SECRET)) return true;

  const worker = request.headers.get("x-worker-secret") ?? "";
  return Boolean(worker) && matches(worker, process.env.WORKER_SHARED_SECRET);
}

/** The document named in the body, when there is a body naming one.
 *
 *  A missing, empty or unparseable body is the timer calling, not a fault:
 *  Vercel Cron issues a bare GET. Anything that is not a string is ignored
 *  rather than passed into a query. */
async function scope(request: Request): Promise<string | undefined> {
  if (request.method !== "POST") return undefined;
  try {
    const body = await request.json();
    const id = (body as { documentId?: unknown })?.documentId;
    return typeof id === "string" && id ? id : undefined;
  } catch {
    return undefined;
  }
}

async function handle(request: Request) {
  if (!authorised(request)) {
    return NextResponse.json({ error: "not authorised" }, { status: 401 });
  }

  // Never throws — see advanceSubmitted. One request that cannot be started
  // must not stop the sweep, and neither a worker nor a scheduler has anywhere
  // to report an exception to.
  const result = await advanceSubmitted({ documentId: await scope(request) });
  return NextResponse.json(result);
}

export const POST = handle;
/** Vercel Cron issues a GET. The work is the same. */
export const GET = handle;
