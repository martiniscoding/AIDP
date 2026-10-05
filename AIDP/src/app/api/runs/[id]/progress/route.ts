import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { NotAMember } from "@/lib/ingest/org";
import { readRunProgress } from "@/lib/ingest/run-progress";

/**
 * How far an assessment has got.
 *
 * Polled by the progress banner while a run is live, a few hundred bytes at a
 * time, instead of re-rendering the whole report page to move one number. The
 * page itself is refreshed once, when this says the run has finished — which is
 * the only moment there is anything new on it to show.
 */

export const runtime = "nodejs";
// Never cached, by anything. A cached progress reading is a stuck progress bar,
// which is the entire problem this route exists to solve.
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const { id } = await params;
  try {
    const progress = await readRunProgress(session.user.id, id);
    if (!progress) return NextResponse.json({ error: "Not found." }, { status: 404 });
    return NextResponse.json(progress, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    // A run in someone else's organisation is indistinguishable from one that
    // does not exist, for the same reason as the figures route.
    if (error instanceof NotAMember) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    throw error;
  }
}
