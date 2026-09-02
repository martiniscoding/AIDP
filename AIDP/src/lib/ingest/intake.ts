import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import type { Access } from "@/lib/access/gate";
import { canManageStandards } from "@/lib/access/roles";
import { documentKey, put, sha256 } from "@/lib/ingest/storage";

/**
 * Taking a document in — the rules, once.
 *
 * There are two doors: a browser uploads straight to object storage and the
 * storage service calls us back (src/app/api/uploadthing), and a plain
 * multipart POST arrives at /api/documents/upload. They exist for different
 * reasons — the first because Vercel caps a function's request body at 4.5MB
 * and these documents are tens of megabytes, the second because scripts and
 * tests need a door that is just HTTP.
 *
 * Two doors are only safe if they cannot disagree, so every rule that decides
 * *whether* a document may be taken, and everything that happens once it is,
 * lives here and nowhere else.
 */

export type Role = "reference" | "assessed";

export type Refusal = { error: string; status: number };

export type Format = { mimeType: string; extension: string };

const PDF_MAGIC = "%PDF-";
const ZIP_MAGIC = "PK";

export const PPTX_MIME =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";
export const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** The largest file we will take. Enforced on our side of the upload, wherever
 *  the bytes came from — a storage service's own limit is configuration, not a
 *  rule of this product. */
export const MAX_BYTES = 64 * 1024 * 1024;

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
export function identify(bytes: Uint8Array): Format | Refusal {
  const head = Buffer.from(bytes.subarray(0, 5)).toString("latin1");
  if (head === PDF_MAGIC) {
    return { mimeType: "application/pdf", extension: "pdf" };
  }

  if (head.startsWith(ZIP_MAGIC)) {
    const buffer = Buffer.from(bytes);
    if (buffer.includes("ppt/presentation.xml")) {
      return { mimeType: PPTX_MIME, extension: "pptx" };
    }
    if (buffer.includes("xl/workbook.xml")) {
      return { mimeType: XLSX_MIME, extension: "xlsx" };
    }
    if (buffer.includes("word/document.xml")) {
      return {
        error: "Word documents aren't supported yet — PDF, PowerPoint and Excel only.",
        status: 415,
      };
    }
  }

  return {
    error:
      "That doesn't look like a PDF, PowerPoint or Excel file. Only those can be ingested.",
    status: 415,
  };
}

/** A role sent by a client, read the safe way round. */
export function readRole(value: unknown): Role {
  return value === "assessed" ? "assessed" : "reference";
}

/**
 * May this caller put this document here?
 *
 * Both doors call this before a single byte is stored, so neither can be the
 * lenient one.
 */
export async function authorise(
  access: Access,
  role: Role,
  requestedProjectId: string,
): Promise<{ projectId: string | null } | Refusal> {
  // Standards are the administrator's to curate. Whoever controls the reference
  // documents controls every verdict this customer will ever get, so an
  // employee submitting a design must not be able to widen the standard they
  // are about to be judged against. Checked here rather than only in the UI,
  // because both doors accept a direct request and the role arrives in it —
  // the client asking nicely is not an access control.
  //
  // Note `readRole` defaults to "reference": an employee sending a missing or
  // malformed role is refused rather than quietly granted the privileged path.
  // Failing closed is the right direction for this one.
  if (role === "reference" && !canManageStandards(access.organisation.role)) {
    return {
      error:
        "Only an administrator can add standards documents. You can submit a design for assessment instead.",
      status: 403,
    };
  }

  // A reference standard belongs to the organisation, not to any one piece of
  // work.
  if (role !== "assessed") return { projectId: null };

  // A design belongs to a piece of work. Resolved before the file is read, so
  // a bad project id costs nothing, and checked against this organisation so a
  // guessed id from another customer is indistinguishable from a typo.
  if (!requestedProjectId) {
    return { error: "Choose a project for this design.", status: 400 };
  }
  const project = await prisma.project.findFirst({
    where: { id: requestedProjectId, organisationId: access.organisation.id },
    select: { id: true, status: true },
  });
  if (!project) return { error: "That project no longer exists.", status: 404 };
  if (project.status !== "active") {
    return {
      error: "That project is archived. Reopen it before adding designs.",
      status: 409,
    };
  }
  return { projectId: project.id };
}

export type Recorded = {
  document: { id: string; title: string; status: string };
  duplicate: boolean;
};

/**
 * Write the row and queue the parse.
 *
 * `storageKey` is passed when the bytes are already in storage — the browser
 * uploaded them there directly and we are being told after the fact. Without
 * it, this stores them itself.
 *
 * The write is transactional: the document row and its parse job commit
 * together, so there is no window where a document exists with nothing queued
 * to process it.
 */
export async function record(input: {
  /** Ids rather than an `Access`, because the storage service's completion
   *  callback is a server-to-server request carrying no session cookie — there
   *  is nobody to resolve there, only what the middleware already established
   *  and passed along. */
  organisationId: string;
  userId: string;
  role: Role;
  projectId: string | null;
  bytes: Uint8Array;
  fileName: string;
  format: Format;
  storageKey?: string;
}): Promise<Recorded> {
  const { organisationId, userId, role, projectId, bytes, fileName, format } = input;
  const hash = sha256(bytes);

  // Content-addressed idempotency. Re-uploading the same bytes resolves to the
  // existing document instead of paying to parse and embed it twice.
  const existing = await prisma.document.findUnique({
    where: { organisationId_sha256: { organisationId, sha256: hash } },
    select: { id: true, title: true, status: true },
  });
  if (existing) return { document: existing, duplicate: true };

  // The stored key is whatever the backend issues: under UploadThing that is
  // their file key, not the path suggested here.
  const key =
    input.storageKey ??
    (await put(documentKey(organisationId, hash, format.extension), bytes, format.mimeType));

  // A readable placeholder until the parser reads the real title off the cover
  // page — or, for a deck, off the title of slide one. Leading dots and
  // separators are stripped so "Data_Standards.pdf" and ".sample.xlsx" both
  // come out as something a person would recognise.
  const title =
    fileName
      .replace(/\.(pdf|pptx|xlsx)$/i, "")
      .replace(/[_-]+/g, " ")
      .replace(/\s+/g, " ")
      .replace(/^[.\s]+/, "")
      .trim() || "Untitled document";
  const correlationId = randomUUID();

  const document = await prisma.$transaction(async (tx) => {
    const created = await tx.document.create({
      data: {
        organisationId,
        role,
        projectId,
        title: title.slice(0, 500),
        storageKey: key,
        mimeType: format.mimeType,
        byteSize: bytes.byteLength,
        sha256: hash,
        status: "pending",
        // Whoever submits the work owns what it costs to process. The workers
        // read this back to attribute model spend — see Workers/aidp/usage.py.
        uploadedById: userId,
      },
      select: { id: true, title: true, status: true },
    });

    await tx.job.create({
      data: {
        organisationId,
        documentId: created.id,
        stage: "parse",
        correlationId,
      },
    });

    return created;
  });

  return { document, duplicate: false };
}
