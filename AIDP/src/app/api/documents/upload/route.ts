import { NextResponse } from "next/server";
import { NoAccess, requireAccess, type Access } from "@/lib/access/gate";
import {
  MAX_BYTES,
  MAX_FILES,
  authorise,
  identify,
  readRole,
  record,
  type Recorded,
} from "@/lib/ingest/intake";

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
 *
 * Several files at once, because a standards library arrives as a folder. Each
 * one is identified, hashed and recorded on its own, and reported on its own:
 * one unreadable file in a batch of eight must not cost the other seven, and a
 * batch that silently kept the first file and dropped the rest — which is what
 * `form.get("file")` did — is worse than a refusal.
 *
 * The response shape depends on how many files were sent, so that every caller
 * written against the single-file door keeps working:
 *
 *   one file   → `{ document, duplicate }`, or `{ error }` with its own status
 *   several    → `{ files: [...], added, duplicates, refused }`, 201 when all
 *                landed and 207 when some did not
 */

export const runtime = "nodejs";

/** One file's outcome, named so a caller can tell which file it is about. */
type Outcome =
  | ({ name: string; ok: true } & Recorded)
  | { name: string; ok: false; error: string; status: number };

async function take(
  file: File,
  context: { organisationId: string; userId: string; role: ReturnType<typeof readRole>; projectId: string | null },
): Promise<Outcome> {
  if (file.size === 0) {
    return { name: file.name, ok: false, error: "That file is empty.", status: 400 };
  }
  if (file.size > MAX_BYTES) {
    return {
      name: file.name,
      ok: false,
      error: `That file is ${(file.size / 1024 / 1024).toFixed(1)}MB. The limit is 64MB.`,
      status: 413,
    };
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const format = identify(bytes);
  if ("error" in format) {
    return { name: file.name, ok: false, error: format.error, status: format.status };
  }

  const recorded = await record({ ...context, bytes, fileName: file.name, format });
  return { name: file.name, ok: true, ...recorded };
}

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
  const files = form.getAll("file").filter((entry): entry is File => entry instanceof File);
  const role = readRole(form.get("role"));

  // Before the files are read: who may add a standard does not depend on what
  // they attached, and a member should be told that rather than told their
  // first file is empty.
  const verdict = await authorise(access, role, String(form.get("projectId") ?? ""));
  if ("error" in verdict) {
    return NextResponse.json({ error: verdict.error }, { status: verdict.status });
  }

  if (files.length === 0) {
    return NextResponse.json({ error: "No file was attached." }, { status: 400 });
  }
  if (files.length > MAX_FILES) {
    return NextResponse.json(
      {
        error: `That is ${files.length} files. Up to ${MAX_FILES} can be uploaded at once.`,
      },
      { status: 413 },
    );
  }

  const context = {
    organisationId: access.organisation.id,
    userId: access.user.id,
    role,
    projectId: verdict.projectId,
  };

  // In order, not in parallel: each body is already in memory and each file
  // commits a row and a parse job, and the stages behind them are a queue, so
  // concurrency here would be serialised a moment later anyway. In order also
  // means two copies of the same file in one batch resolve as one document and
  // one duplicate, rather than racing to be the original.
  const outcomes: Outcome[] = [];
  for (const file of files) {
    outcomes.push(await take(file, context));
  }

  // One file answers exactly as it did before this door took more than one.
  if (files.length === 1) {
    const only = outcomes[0]!;
    if (!only.ok) return NextResponse.json({ error: only.error }, { status: only.status });
    return only.duplicate
      ? NextResponse.json({ document: only.document, duplicate: true })
      : NextResponse.json({ document: only.document, duplicate: false }, { status: 201 });
  }

  const refused = outcomes.filter((o) => !o.ok).length;
  const duplicates = outcomes.filter((o) => o.ok && o.duplicate).length;
  return NextResponse.json(
    {
      files: outcomes,
      added: outcomes.length - refused - duplicates,
      duplicates,
      refused,
    },
    // 207 when the batch is not all one answer: a caller that checks `res.ok`
    // alone would otherwise read "three of eight were refused" as success.
    { status: refused === 0 ? 201 : 207 },
  );
}
