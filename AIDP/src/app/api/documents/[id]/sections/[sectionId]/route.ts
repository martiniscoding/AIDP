import { NextResponse } from "next/server";
import { NoAccess, requireAccess } from "@/lib/access/gate";
import { NotAMember } from "@/lib/ingest/org";
import { sectionContent } from "@/lib/ingest/documents";

/**
 * What one section of a document actually yielded.
 *
 * A route handler rather than a server action: this is a read, and the client
 * dispatches server actions one at a time per page — so expanding three
 * sections would have queued behind each other for no reason. Route handlers
 * are not cached by default, which is what per-customer data wants.
 *
 * Authorisation is `sectionContent`'s own, against the section's organisation.
 * A section id from another customer answers 404 rather than 403: saying
 * "forbidden" would confirm the document exists.
 */

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; sectionId: string }> },
) {
  const { id, sectionId } = await params;

  try {
    const { user } = await requireAccess();
    const content = await sectionContent(user.id, id, sectionId);
    if (!content) {
      return NextResponse.json({ error: "That section no longer exists." }, { status: 404 });
    }
    return NextResponse.json(content);
  } catch (error) {
    if (error instanceof NotAMember) {
      return NextResponse.json({ error: "That section no longer exists." }, { status: 404 });
    }
    return NextResponse.json(
      { error: error instanceof NoAccess ? error.message : "Not signed in." },
      { status: 401 },
    );
  }
}
