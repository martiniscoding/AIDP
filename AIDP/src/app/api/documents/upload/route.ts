import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { NoAccess, requireAccess, type Access } from "@/lib/access/gate";
import { canManageStandards } from "@/lib/access/roles";
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
const ZIP_MAGIC = "PK";

const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

type Format = { mimeType: string; extension: string };

/**
 * What these bytes actually are, or a reason they can't be ingested.
 *
 * Trust the bytes, not the extension or the browser's content type. A PDF says
 * so in its first five; an Office file is a ZIP, and every Office format shares
 * that signature — so the distinguishing step is which parts the package
 * contains. Entry names sit uncompressed in the archive's local headers, which
 * makes this a substring search rather than a reason to add a zip dependency.
 *
 * Word and Excel are named specifically when found. "That doesn't look like a
 * PDF" is a bad answer to someone who just dropped a .docx and can see
 * perfectly well what it is.
 */
function identify(bytes: Uint8Array): Format | { error: string; status: number } {
  const head = Buffer.from(bytes.subarray(0, 5)).toString("latin1");
  if (head === PDF_MAGIC) {
    return { mimeType: "application/pdf", extension: "pdf" };
  }

  if (head.startsWith(ZIP_MAGIC)) {
    const buffer = Buffer.from(bytes);
    if (buffer.includes("ppt/presentation.xml")) {
      return { mimeType: PPTX_MIME, extension: "pptx" };
    }
    if (buffer.includes("word/document.xml")) {
      return { error: "Word documents aren't supported yet — PDF and PowerPoint only.", status: 415 };
    }
    if (buffer.includes("xl/workbook.xml")) {
      return { error: "Excel workbooks aren't supported yet — PDF and PowerPoint only.", status: 415 };
    }
  }

  return {
    error: "That doesn't look like a PDF or a PowerPoint file. Only those can be ingested.",
    status: 415,
  };
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
  const file = form.get("file");
  const role = form.get("role") === "assessed" ? "assessed" : "reference";

  // Standards are the administrator's to curate. Whoever controls the reference
  // documents controls every verdict this customer will ever get, so an
  // employee submitting a design must not be able to widen the standard they
  // are about to be judged against. Checked here rather than only in the UI,
  // because this endpoint accepts a direct POST and the role arrives in the
  // form body — the client asking nicely is not an access control.
  //
  // Note the parse above defaults to "reference": an employee sending a missing
  // or malformed role is refused rather than quietly granted the privileged
  // path. Failing closed is the right direction for this one.
  if (role === "reference" && !canManageStandards(access.organisation.role)) {
    return NextResponse.json(
      {
        error:
          "Only an administrator can add standards documents. You can submit a design for assessment instead.",
      },
      { status: 403 },
    );
  }

  // A design belongs to a piece of work. Resolved before the file is read, so
  // a bad project id costs nothing, and checked against this organisation so a
  // guessed id from another customer is indistinguishable from a typo.
  let projectId: string | null = null;
  if (role === "assessed") {
    const requested = String(form.get("projectId") ?? "");
    if (!requested) {
      return NextResponse.json(
        { error: "Choose a project for this design." },
        { status: 400 },
      );
    }
    const project = await prisma.project.findFirst({
      where: { id: requested, organisationId: access.organisation.id },
      select: { id: true, status: true },
    });
    if (!project) {
      return NextResponse.json({ error: "That project no longer exists." }, { status: 404 });
    }
    if (project.status !== "active") {
      return NextResponse.json(
        { error: "That project is archived. Reopen it before adding designs." },
        { status: 409 },
      );
    }
    projectId = project.id;
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

  const organisation = access.organisation;
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
  const key = await put(
    documentKey(organisation.id, hash, format.extension),
    bytes,
    format.mimeType,
  );

  // A readable placeholder until the parser reads the real title off the cover
  // page — or, for a deck, off the title of slide one. Leading dots and
  // separators are stripped so "Data_Standards.pdf" and ".sample.pptx" both
  // come out as something a person would recognise.
  const title =
    file.name
      .replace(/\.(pdf|pptx)$/i, "")
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
        // Null for a reference standard: those belong to the organisation, not
        // to any one piece of work.
        projectId,
        title: title.slice(0, 500),
        storageKey: key,
        mimeType: format.mimeType,
        byteSize: bytes.byteLength,
        sha256: hash,
        status: "pending",
        // Whoever submits the work owns what it costs to process. The workers
        // read this back to attribute model spend — see Workers/aidp/usage.py.
        uploadedById: access.user.id,
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
