import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { NotAMember, requireMembership } from "@/lib/ingest/org";
import { get } from "@/lib/ingest/storage";

/**
 * Serve a figure image to someone entitled to see it.
 *
 * This is what makes review possible at the point of use: a reviewer looking at
 * a finding that rests on a diagram can see the diagram beside the model's
 * reading of it. Verifying there — when a verdict depends on it — beats
 * reviewing every figure speculatively at ingest.
 *
 * Never a public URL. These pages are marked Internal Use, and an unguessable
 * link is not an access control.
 */

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const { id } = await params;
  const figure = await prisma.figure.findUnique({
    where: { id },
    select: {
      storageKey: true,
      section: { select: { document: { select: { organisationId: true } } } },
    },
  });
  if (!figure) return NextResponse.json({ error: "Not found." }, { status: 404 });

  try {
    await requireMembership(session.user.id, figure.section.document.organisationId);
  } catch (error) {
    // A figure in someone else's organisation is indistinguishable from one
    // that does not exist. Saying "forbidden" would confirm it is real.
    if (error instanceof NotAMember) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    throw error;
  }

  try {
    const bytes = await get(figure.storageKey);
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        "content-type": "image/png",
        // Private: it is one customer's Internal Use material, so no shared
        // cache may hold it. Immutable because the bytes for a given figure id
        // never change — a re-parse issues a new id.
        "cache-control": "private, max-age=3600, immutable",
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not read that image." },
      { status: 404 },
    );
  }
}
