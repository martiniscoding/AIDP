import { NextResponse } from "next/server";
import { NoAccess, requireAccess, type Access } from "@/lib/access/gate";
import { MAX_BYTES, authorise, identify, readRole, record } from "@/lib/ingest/intake";

/**
 * Document upload over plain multipart.
 *
 * Not the browser's door any more. Vercel caps a function's request body at
 * 4.5MB and answers 413 above it, so anything past a small PDF never arrived —
 * the interface offered 64MB and an 8MB deck failed with "too large". The app
 * now uploads to object storage directly; see src/app/api/uploadthing.
 *
 * This stays because a door that is only HTTP is worth having: scripts, the
 * workers' own tooling and scripts/verify-standards-http.mts all use it, and it
 * is where the standards guard can be exercised without a storage handshake.
 * Every rule it applies comes from lib/ingest/intake, which is also what the
 * browser's door calls — so the two cannot drift apart on who may add a
 * standard.
 */

export const runtime = "nodejs";

export async function POST(request: Request) {
  // `requireAccess` rather than a bare session check: a revoked employee may
  // still be holding a valid cookie, and this endpoint writes to the customer's
  // corpus. It also resolves the organisation, replacing `resolveActive` here.
  let access: Access;
  try {
    access = await requireAccess();
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof NoAccess ? error.message : "Not signed in." },
      { status: 401 },
    );
  }

  const form = await request.formData();
  const file = form.get("file");
  const role = readRole(form.get("role"));

  const verdict = await authorise(access, role, String(form.get("projectId") ?? ""));
  if ("error" in verdict) {
    return NextResponse.json({ error: verdict.error }, { status: verdict.status });
  }

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No file was attached." }, { status: 400 });
  }
  if (file.size === 0) {
    return NextResponse.json({ error: "That file is empty." }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: `That file is ${(file.size / 1024 / 1024).toFixed(1)}MB. The limit is 64MB.` },
      { status: 413 },
    );
  }

  const bytes = new Uint8Array(await file.arrayBuffer());

  const format = identify(bytes);
  if ("error" in format) {
    return NextResponse.json({ error: format.error }, { status: format.status });
  }

  const { document, duplicate } = await record({
    organisationId: access.organisation.id,
    userId: access.user.id,
    role,
    projectId: verdict.projectId,
    bytes,
    fileName: file.name,
    format,
  });

  return duplicate
    ? NextResponse.json({ document, duplicate: true })
    : NextResponse.json({ document, duplicate: false }, { status: 201 });
}
