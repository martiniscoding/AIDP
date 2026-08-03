import { randomUUID } from "node:crypto";
import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { resolveActive } from "@/lib/ingest/org";
import { documentKey, put, sha256 } from "@/lib/ingest/storage";

/**
 * Document upload.
 *
 * A Route Handler rather than a Server Action because Server Actions cap
 * request bodies at 1MB by default and these documents are tens of megabytes —
 * raising that limit globally to accommodate one endpoint is the wrong trade.
 *
 * The write is transactional: the document row and its parse job commit
 * together, so there is no window where a document exists with nothing queued
 * to process it. The blob is written first because an orphaned blob is
 * recoverable and an orphaned row is a document that never parses.
 */

export const runtime = "nodejs";

const MAX_BYTES = 64 * 1024 * 1024;
const PDF_MAGIC = "%PDF-";

export async function POST(request: Request) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const form = await request.formData();
  const file = form.get("file");
  const role = form.get("role") === "assessed" ? "assessed" : "reference";

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

  // Trust the bytes, not the extension or the browser's content type.
  if (Buffer.from(bytes.subarray(0, 5)).toString("latin1") !== PDF_MAGIC) {
    return NextResponse.json(
      { error: "That doesn't look like a PDF. Only PDFs can be ingested." },
      { status: 415 },
    );
  }

  const user = session.user as typeof session.user & { company?: string };
  const organisation = await resolveActive(user);
  const hash = sha256(bytes);

  // Content-addressed idempotency. Re-uploading the same bytes resolves to the
  // existing document instead of paying to parse and embed it twice.
  const existing = await prisma.document.findUnique({
    where: { organisationId_sha256: { organisationId: organisation.id, sha256: hash } },
    select: { id: true, title: true, status: true },
  });
  if (existing) {
    return NextResponse.json({ document: existing, duplicate: true });
  }

  // The stored key is whatever the backend issues: under UploadThing that is
  // their file key, not the path suggested here.
  const key = await put(documentKey(organisation.id, hash), bytes, "application/pdf");

  // A readable placeholder until the parser reads the real title off the cover
  // page. Leading dots and separators are stripped so "Data_Standards.pdf" and
  // ".sample.pdf" both come out as something a person would recognise.
  const title =
    file.name
      .replace(/\.pdf$/i, "")
      .replace(/[_-]+/g, " ")
      .replace(/\s+/g, " ")
      .replace(/^[.\s]+/, "")
      .trim() || "Untitled document";
  const correlationId = randomUUID();

  const document = await prisma.$transaction(async (tx) => {
    const created = await tx.document.create({
      data: {
        organisationId: organisation.id,
        role,
        title: title.slice(0, 500),
        storageKey: key,
        mimeType: "application/pdf",
        byteSize: bytes.byteLength,
        sha256: hash,
        status: "pending",
      },
      select: { id: true, title: true, status: true },
    });

    await tx.job.create({
      data: {
        organisationId: organisation.id,
        documentId: created.id,
        stage: "parse",
        correlationId,
      },
    });

    return created;
  });

  return NextResponse.json({ document, duplicate: false }, { status: 201 });
}
