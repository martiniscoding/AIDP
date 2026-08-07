import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";

/**
 * Object storage for uploaded documents and extracted figure images.
 *
 * Two backends:
 *
 *   local        development. The app and the workers share a directory through
 *                a mounted volume, so no cloud account is needed to run this.
 *   uploadthing  deployment.
 *
 * The UploadThing token lives here and nowhere else. The Python workers do not
 * hold it — they read and write through an internal endpoint on this app
 * (src/app/api/internal/files/route.ts), authenticated with a shared secret.
 * That costs one network hop and buys a single place where storage credentials
 * exist, which is what Security Standards §5.2 asks for and what makes rotating
 * the token a one-line change rather than a redeploy of two runtimes.
 */

export type StorageBackend = "local" | "uploadthing";

export const backend = (process.env.STORAGE_BACKEND ?? "local") as StorageBackend;
const localRoot = path.resolve(process.env.STORAGE_LOCAL_PATH ?? ".storage");

/** Content address. The same bytes uploaded twice must not re-run the pipeline. */
export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Suggested key for a source document.
 *
 * Under `local` this is the path. Under `uploadthing` the service issues its
 * own key on upload and that is what gets stored — this only shapes the
 * filename, so a file listing in their dashboard is legible.
 *
 * The extension is passed in rather than assumed. It is not decoration: the
 * worker reads it as a fallback when deciding which parser to run, for rows
 * written before `mimeType` carried anything but the PDF default.
 */
export function documentKey(organisationId: string, hash: string, extension = "pdf"): string {
  return `documents/${organisationId}/${hash}.${extension}`;
}

function resolveLocal(key: string): string {
  const target = path.resolve(localRoot, key);
  if (target !== localRoot && !target.startsWith(localRoot + path.sep)) {
    throw new Error(`storage key escapes root: ${key}`);
  }
  return target;
}

async function utapi() {
  const { UTApi } = await import("uploadthing/server");
  const token = process.env.UPLOADTHING_TOKEN;
  if (!token) {
    throw new Error(
      "UPLOADTHING_TOKEN is not set. Copy it from the UploadThing dashboard, or set STORAGE_BACKEND=local for development.",
    );
  }
  return new UTApi({ token });
}

/**
 * Store bytes, returning the key to record on the row.
 *
 * The returned key is authoritative — under UploadThing it is the service's own
 * file key, not the one suggested. Callers must persist what comes back rather
 * than what they passed in.
 */
export async function put(
  suggestedKey: string,
  bytes: Uint8Array,
  contentType = "application/pdf",
): Promise<string> {
  if (backend === "uploadthing") {
    const api = await utapi();
    const name = suggestedKey.split("/").pop() || `${randomUUID()}.pdf`;
    const file = new File([bytes as BlobPart], name, { type: contentType });
    const result = await api.uploadFiles(file);
    if (result.error || !result.data) {
      throw new Error(`UploadThing upload failed: ${result.error?.message ?? "unknown"}`);
    }
    return result.data.key;
  }

  const target = resolveLocal(suggestedKey);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, bytes);
  return suggestedKey;
}

/**
 * Whether a stored key belongs to the backend now configured.
 *
 * UploadThing issues opaque flat keys; the local backend stores paths. A
 * document uploaded under one backend is unreachable under the other, and the
 * failure is otherwise silent-ish: `generateSignedURL` will happily sign a
 * string it has never seen, and the CDN answers 404 with no hint that the real
 * problem is a configuration change.
 */
export function keyMatchesBackend(key: string): boolean {
  return backend === "uploadthing" ? !key.includes("/") : true;
}

function wrongBackend(key: string): Error {
  return new Error(
    `Storage key "${key.slice(0, 48)}" was written by the ${
      key.includes("/") ? "local" : "uploadthing"
    } backend, but STORAGE_BACKEND is now "${backend}". This document predates ` +
      "the change and its bytes are not reachable — re-upload it, or switch the " +
      "backend back.",
  );
}

export async function get(key: string): Promise<Buffer> {
  if (!keyMatchesBackend(key)) throw wrongBackend(key);
  if (backend === "uploadthing") {
    // Retried, because the CDN edge occasionally refuses a connection outright
    // and a single timeout would otherwise render as a broken image with no
    // explanation. Observed in practice: ConnectTimeoutError against the
    // Cloudflare front for a file that demonstrably exists.
    let last: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const url = await signedUrl(key);
        // Happy Eyeballs. The CDN is behind anycast and, on some networks,
        // one of the advertised addresses blackholes while the other is fine —
        // observed here as a 10s ConnectTimeoutError against a file that
        // demonstrably exists. Without this, Node picks one address and sticks
        // with it, so whether an image loads becomes a coin flip.
        const res = await fetch(url, {
          signal: AbortSignal.timeout(20_000),
          // @ts-expect-error — undici option, not in the DOM fetch types
          autoSelectFamily: true,
          autoSelectFamilyAttemptTimeout: 1_500,
        });
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        return Buffer.from(await res.arrayBuffer());
      } catch (error) {
        last = error;
        if (attempt < 2) await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      }
    }
    throw new Error(
      `Could not fetch ${key} after 3 attempts: ${
        last instanceof Error ? last.message : String(last)
      }`,
    );
  }
  return readFile(resolveLocal(key));
}

/**
 * A short-lived URL for one file.
 *
 * Files are uploaded with private access, so this is the only way to read one.
 * An unguessable public URL would be security by obscurity on documents marked
 * Internal Use, which is precisely what their Data Standards §6.1 handling
 * rules exist to prevent.
 */
export async function signedUrl(key: string, expiresInSeconds = 900): Promise<string> {
  if (backend !== "uploadthing") {
    throw new Error("signedUrl is only meaningful for the uploadthing backend");
  }
  if (!keyMatchesBackend(key)) throw wrongBackend(key);
  const api = await utapi();
  const { ufsUrl } = await api.generateSignedURL(key, { expiresIn: expiresInSeconds });
  return ufsUrl;
}

/**
 * Remove blobs.
 *
 * Data Standards §10.4 requires disposal to be "auditable, authorized, and
 * verifiable" and to reach "all copies and dependent systems", so this returns
 * a count the caller can record rather than deleting silently.
 */
export async function remove(keys: string[]): Promise<number> {
  if (keys.length === 0) return 0;

  if (backend === "uploadthing") {
    const api = await utapi();
    const result = await api.deleteFiles(keys);
    return result.deletedCount ?? keys.length;
  }

  let removed = 0;
  for (const key of keys) {
    try {
      await rm(resolveLocal(key), { force: true });
      removed += 1;
    } catch {
      // Already gone is the desired end state, not an error.
    }
  }
  return removed;
}
