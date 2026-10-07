import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";

/**
 * Encryption for the few secrets a customer hands us.
 *
 * Today that is one thing: a company's own model API key. The requirement is
 * narrow and worth stating, because it decides the design — the key has to be
 * *recoverable*, since the workers need the real string to call a provider with.
 * So this is encryption, not hashing, and the question becomes where the
 * encrypting key lives.
 *
 * It lives in the environment, in this app only, exactly like the UploadThing
 * token. The Python workers never decrypt anything: they ask the app through
 * /api/internal/credentials. One runtime holds the means of decryption, one
 * place to rotate, and every read passes an audit point — the same arrangement
 * src/lib/ingest/storage.ts argues for, and Security Standards §5.2 asks for.
 *
 * AES-256-GCM rather than CBC because GCM authenticates: a ciphertext that has
 * been altered fails to decrypt instead of producing plausible rubbish that
 * then gets sent to a provider as somebody's API key.
 *
 * The organisation id is passed as additional authenticated data. That binds a
 * ciphertext to the row it belongs to, so copying one company's encrypted key
 * into another company's row fails loudly rather than working.
 */

/** Bumped only if the scheme changes, so old values stay readable. */
const VERSION = "v1";
const ALGORITHM = "aes-256-gcm";
/** 96 bits, the size GCM is specified for. */
const IV_BYTES = 12;

export class SecretsUnavailable extends Error {
  constructor(detail: string) {
    super(
      `CREDENTIAL_ENCRYPTION_KEY ${detail}. Generate one with: ` +
        `openssl rand -base64 32`,
    );
    this.name = "SecretsUnavailable";
  }
}

/**
 * The encrypting key, decoded and checked.
 *
 * Read per call rather than cached at module load, so that a missing variable
 * is an error on the one page that needs it rather than a server that will not
 * boot. Decoding 32 bytes of base64 costs nothing next to the HTTPS request
 * that follows.
 */
function key(): Buffer {
  const raw = process.env.CREDENTIAL_ENCRYPTION_KEY;
  if (!raw) throw new SecretsUnavailable("is not set");

  const bytes = Buffer.from(raw, "base64");
  if (bytes.length !== 32) {
    throw new SecretsUnavailable(
      `must be 32 bytes of base64 — this one decodes to ${bytes.length}`,
    );
  }
  return bytes;
}

/** Whether a secret can be stored at all. The page asks before offering a form
 *  nobody can submit. */
export function secretsConfigured(): boolean {
  try {
    key();
    return true;
  } catch {
    return false;
  }
}

/**
 * Encrypt a secret, bound to the thing it belongs to.
 *
 * `boundTo` is the additional authenticated data — pass the organisation id.
 * The same plaintext encrypted twice gives two different ciphertexts, because
 * the IV is fresh each time; that is intended and means nothing can be learned
 * by comparing two rows.
 */
export function encryptSecret(plaintext: string, boundTo: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key(), iv);
  cipher.setAAD(Buffer.from(boundTo, "utf8"));

  const sealed = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [VERSION, iv.toString("base64"), tag.toString("base64"), sealed.toString("base64")].join(
    ".",
  );
}

export class SecretUnreadable extends Error {
  constructor(reason: string) {
    super(`This stored secret could not be read: ${reason}.`);
    this.name = "SecretUnreadable";
  }
}

/**
 * Decrypt a secret.
 *
 * Throws rather than returning null on every failure path — a wrong
 * encryption key, a tampered ciphertext, a value bound to a different
 * organisation. A caller that cannot tell "no key configured" from "the key is
 * unreadable" would retry the second case forever, and the two want different
 * answers on screen.
 */
export function decryptSecret(stored: string, boundTo: string): string {
  const parts = stored.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new SecretUnreadable("it is not in a format this version understands");
  }
  const [, iv, tag, sealed] = parts as [string, string, string, string];

  try {
    const decipher = createDecipheriv(ALGORITHM, key(), Buffer.from(iv, "base64"));
    decipher.setAAD(Buffer.from(boundTo, "utf8"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(sealed, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch (error) {
    if (error instanceof SecretsUnavailable) throw error;
    // GCM's authentication failing is the interesting case and it is
    // indistinguishable from the others here by design: the only honest thing
    // to say is that this value and this encryption key do not belong together.
    throw new SecretUnreadable(
      "it was encrypted with a different key, or has been altered since",
    );
  }
}

/**
 * A stable, non-reversible label for a secret.
 *
 * Used to key the workers' client cache, so two jobs on the same key reuse one
 * HTTP client without the cache key being the key itself. Truncated because
 * collision resistance is not what this is for — telling two keys apart is.
 */
export function secretFingerprint(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex").slice(0, 16);
}
