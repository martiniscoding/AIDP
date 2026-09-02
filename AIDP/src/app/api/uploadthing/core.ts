import { createUploadthing, type FileRouter } from "uploadthing/next";
import { UploadThingError } from "uploadthing/server";
import { requireAccess } from "@/lib/access/gate";
import { backend, get, remove } from "@/lib/ingest/storage";
import {
  MAX_BYTES,
  authorise,
  identify,
  readRole,
  record,
} from "@/lib/ingest/intake";

/**
 * The browser's door: it uploads straight to object storage, and storage tells
 * us afterwards.
 *
 * The reason is a hard platform limit rather than a preference. A Vercel
 * function's request body is capped at 4.5MB and returns 413 above it, so a
 * multipart POST of an 8MB deck never reached our code at all — the upload
 * failed with "too large" while the interface promised 64MB. Sending the bytes
 * to storage directly takes the function out of the path entirely; only the
 * metadata comes back through it.
 *
 * The guards are unchanged, and deliberately not reimplemented here: `authorise`
 * in lib/ingest/intake is the same function /api/documents/upload calls, so the
 * two doors cannot come to different conclusions about who may add a standard.
 *
 * Role and project arrive as headers rather than as `.input()`, which would
 * mean adding a schema library for two strings that are validated here anyway.
 */

const f = createUploadthing();

/** Anything, because we identify the bytes ourselves rather than believing a
 *  content type the client chose. */
export const fileRouter = {
  document: f({
    blob: { maxFileSize: "64MB", maxFileCount: 1 },
  })
    .middleware(async ({ req, files }) => {
      // `requireAccess` rather than a bare session check: a revoked employee
      // may still be holding a valid cookie, and this writes to the customer's
      // corpus.
      // Only meaningful when storage *is* UploadThing. Said plainly, because
      // the alternative is a developer on STORAGE_BACKEND=local watching every
      // upload fail with nothing to go on.
      if (backend !== "uploadthing") {
        throw new UploadThingError(
          'STORAGE_BACKEND is "local", so the browser has nowhere to upload to. Set it to "uploadthing", or post to /api/documents/upload instead.',
        );
      }

      const access = await requireAccess().catch(() => null);
      if (!access) throw new UploadThingError("Sign in to upload a document.");

      const role = readRole(req.headers.get("x-aidp-role"));
      const verdict = await authorise(access, role, req.headers.get("x-aidp-project") ?? "");
      if ("error" in verdict) throw new UploadThingError(verdict.error);

      // Checked before the presigned URL is issued, so an oversized file is
      // refused rather than uploaded and then rejected.
      const tooBig = files.find((file) => file.size > MAX_BYTES);
      if (tooBig) {
        throw new UploadThingError(
          `That file is ${(tooBig.size / 1024 / 1024).toFixed(1)}MB. The limit is 64MB.`,
        );
      }

      // Everything `onUploadComplete` will need. It runs on a callback from
      // the storage service — signed, but cookieless — so whatever is not
      // carried across here cannot be recovered there.
      return {
        organisationId: access.organisation.id,
        userId: access.user.id,
        role,
        projectId: verdict.projectId,
      };
    })
    .onUploadComplete(async ({ metadata, file }) => {
      // Fetched back so the bytes are identified and hashed by us. A client
      // that uploaded straight to storage has not been trusted with anything —
      // it chose the bytes, and everything we conclude about them is still
      // decided here.
      const bytes = new Uint8Array(await get(file.key));

      const format = identify(bytes);
      if ("error" in format) {
        // Nothing references it, and leaving it would be paying to store a file
        // the product just refused.
        await remove([file.key]);
        throw new UploadThingError(format.error);
      }

      const { document, duplicate } = await record({
        organisationId: metadata.organisationId,
        userId: metadata.userId,
        role: metadata.role,
        projectId: metadata.projectId,
        bytes,
        fileName: file.name,
        format,
        storageKey: file.key,
      });

      // These bytes are already on record under the first upload's key.
      if (duplicate) await remove([file.key]);

      return { documentId: document.id, duplicate };
    }),
} satisfies FileRouter;

export type AppFileRouter = typeof fileRouter;
