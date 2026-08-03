import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { backend, get, put, signedUrl } from "@/lib/ingest/storage";

/**
 * Storage access for the Python workers.
 *
 * The workers parse PDFs and write extracted figure images, so they need to
 * read and write blobs — but they do not hold the UploadThing token. It lives
 * only in this app, and they reach storage through here with a shared secret.
 *
 * That is one extra hop, and it buys: one place where the storage credential
 * exists, rotation without redeploying the workers, and an audit point where
 * every blob access can be logged. Security Standards §5.2 asks for keys to be
 * restricted to authorised processes; two runtimes each holding a copy is the
 * arrangement that makes rotation something nobody ever does.
 *
 *   GET  /api/internal/files?key=…   → { url } for the worker to fetch
 *   POST /api/internal/files         → body is the bytes; returns { key }
 */

export const runtime = "nodejs";

// Enough for an extracted figure render; source documents go up through the
// user-facing upload route, not this one.
const MAX_BYTES = 24 * 1024 * 1024;

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

function unauthorised() {
  return NextResponse.json({ error: "Not authorised." }, { status: 401 });
}

export async function GET(request: Request) {
  if (!authorised(request)) return unauthorised();

  const key = new URL(request.url).searchParams.get("key");
  if (!key) return NextResponse.json({ error: "key is required." }, { status: 400 });

  try {
    if (backend === "uploadthing") {
      return NextResponse.json({ url: await signedUrl(key) });
    }
    // Local development: no signing to do, so serve the bytes directly.
    const bytes = await get(key);
    return new NextResponse(new Uint8Array(bytes), {
      headers: { "content-type": "application/octet-stream" },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not read that file." },
      { status: 404 },
    );
  }
}

export async function POST(request: Request) {
  if (!authorised(request)) return unauthorised();

  const url = new URL(request.url);
  const suggestedKey = url.searchParams.get("key");
  const contentType = url.searchParams.get("contentType") ?? "application/octet-stream";
  if (!suggestedKey) {
    return NextResponse.json({ error: "key is required." }, { status: 400 });
  }

  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength === 0) {
    return NextResponse.json({ error: "Empty body." }, { status: 400 });
  }
  if (bytes.byteLength > MAX_BYTES) {
    return NextResponse.json({ error: "Too large." }, { status: 413 });
  }

  try {
    // The stored key is whatever the backend issues, which under UploadThing is
    // not the one suggested. The worker persists what comes back.
    const key = await put(suggestedKey, bytes, contentType);
    return NextResponse.json({ key }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not store that file." },
      { status: 500 },
    );
  }
}
