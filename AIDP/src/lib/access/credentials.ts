import { prisma } from "@/lib/prisma";
import { isProvider, PROVIDERS, type ProviderName } from "./credential-providers";
import { probeCredential, type ProbeResult } from "./credential-probe";
import {
  decryptSecret,
  encryptSecret,
  secretsConfigured,
  SecretsUnavailable,
  SecretUnreadable,
} from "./secrets";

/**
 * A company's own model key.
 *
 * One per organisation, and absent is normal: an organisation with no key here
 * is served by the deployment's own from the environment, which is what every
 * organisation did before this existed. Nothing changes for a customer who
 * never opens the page.
 *
 * Generation only. Judging clauses, reading a standard's rules, describing a
 * figure, writing a chunk preamble, suggesting improvements. Embeddings stay on
 * the deployment's key for a reason worth repeating wherever this is read: a
 * vector is only comparable with vectors from the same model, the corpus is
 * indexed by embedding model name, and a company that changed theirs would lose
 * dense retrieval over everything already ingested — with no error raised, just
 * worse answers. See src/lib/ingest/retrieval.ts.
 *
 * The plaintext leaves this module in exactly one direction: `resolve`, called
 * only by /api/internal/credentials, which the Python workers reach with the
 * shared secret. Nothing that renders ever sees it.
 */

/** Everything about the installed key except the key. This is what renders. */
export { isProvider, PROVIDERS, type ProviderName };

export type CredentialView = {
  provider: ProviderName;
  providerLabel: string;
  keyLast4: string;
  model: string;
  fastModel: string;
  openrouterProviders: string[];
  zdr: boolean;
  /** The probe's verdict: whether the key can do the work. */
  active: boolean;
  /** The administrator's choice: off means the platform's key is in use. */
  enabled: boolean;
  probe: ProbeResult | null;
  probedAt: Date | null;
  setBy: string | null;
  updatedAt: Date;
  /** True when the stored value cannot be decrypted — a rotated or lost
   *  CREDENTIAL_ENCRYPTION_KEY. Shown, because the symptom otherwise is every
   *  assessment failing for no visible reason. */
  unreadable: boolean;
};

export class CredentialRefused extends Error {}

const SELECT = {
  provider: true,
  ciphertext: true,
  keyLast4: true,
  model: true,
  fastModel: true,
  openrouterProviders: true,
  zdr: true,
  active: true,
  enabled: true,
  probe: true,
  probedAt: true,
  updatedAt: true,
  setBy: { select: { name: true, email: true } },
} as const;

/**
 * The installed key as a screen should see it.
 *
 * Decrypts, and throws the result away. That sounds wasteful and is the point:
 * it is the only honest way to tell "a key is installed" from "a key is
 * installed and nothing can read it", and the second is worth saying out loud
 * before somebody spends an afternoon on why every run fails.
 */
export async function load(organisationId: string): Promise<CredentialView | null> {
  const row = await prisma.providerCredential.findUnique({
    where: { organisationId },
    select: SELECT,
  });
  if (!row) return null;

  let unreadable = false;
  try {
    decryptSecret(row.ciphertext, organisationId);
  } catch (error) {
    if (error instanceof SecretUnreadable || error instanceof SecretsUnavailable) {
      unreadable = true;
    } else {
      throw error;
    }
  }

  const provider = isProvider(row.provider) ? row.provider : "openrouter";
  return {
    provider,
    providerLabel: PROVIDERS[provider].label,
    keyLast4: row.keyLast4,
    model: row.model,
    fastModel: row.fastModel,
    openrouterProviders: row.openrouterProviders,
    zdr: row.zdr,
    active: row.active,
    enabled: row.enabled,
    probe: (row.probe as ProbeResult | null) ?? null,
    probedAt: row.probedAt,
    setBy: row.setBy?.name || row.setBy?.email || null,
    updatedAt: row.updatedAt,
    unreadable,
  };
}

export type CredentialInput = {
  provider: string;
  apiKey: string;
  model?: string;
  fastModel?: string;
  openrouterProviders?: string[];
  zdr?: boolean;
};

/**
 * Install or replace a company's key.
 *
 * The key is probed before it is stored, and a key that cannot return a JSON
 * object is stored `active: false` rather than refused outright. That is a
 * deliberate choice between two bad options: refusing loses what the
 * administrator typed and tells them only in a toast, while storing it live
 * would hand the whole organisation's assessments to a model that cannot judge.
 * Saved-but-inactive keeps the settings on screen next to the reason, and the
 * workers treat it exactly as they treat no key at all.
 */
export async function save(
  organisationId: string,
  input: CredentialInput,
  setById: string,
): Promise<CredentialView> {
  if (!secretsConfigured()) {
    throw new CredentialRefused(
      "This deployment cannot store a key yet — CREDENTIAL_ENCRYPTION_KEY is not configured. " +
        "Ask whoever operates the platform to set it.",
    );
  }
  if (!isProvider(input.provider)) {
    throw new CredentialRefused("Choose one of the providers listed.");
  }
  const provider = input.provider;
  const defaults = PROVIDERS[provider];

  // Pasted keys arrive with whitespace and the occasional smart quote from a
  // chat window. Refusing them is unhelpful when trimming is unambiguous.
  const apiKey = input.apiKey.trim().replace(/^["']|["']$/g, "");
  if (!apiKey) throw new CredentialRefused("Paste the API key.");
  if (apiKey.length < 16 || /\s/.test(apiKey)) {
    throw new CredentialRefused("That does not look like an API key — check what was pasted.");
  }

  const model = (input.model || "").trim() || defaults.model;
  // A provider with one model ignores the fast one; storing the same value
  // keeps the column honest rather than leaving a stale model name in it.
  const fastModel = defaults.twoModels
    ? (input.fastModel || "").trim() || defaults.fastModel
    : model;
  const openrouterProviders =
    provider === "openrouter"
      ? (input.openrouterProviders ?? ["openai", "azure"])
          .map((name) => name.trim().toLowerCase())
          .filter(Boolean)
      : [];
  const zdr = provider === "openrouter" ? Boolean(input.zdr) : false;

  const probe = await probeCredential({
    provider,
    apiKey,
    model,
    openrouterProviders,
    zdr,
  });

  const data = {
    provider,
    ciphertext: encryptSecret(apiKey, organisationId),
    keyLast4: apiKey.slice(-4),
    model,
    fastModel,
    openrouterProviders,
    zdr,
    active: probe.ok,
    probe: probe as unknown as object,
    probedAt: new Date(),
    setById,
  };

  await prisma.providerCredential.upsert({
    where: { organisationId },
    create: { organisationId, ...data },
    update: data,
  });

  const view = await load(organisationId);
  if (!view) throw new CredentialRefused("The key could not be saved.");
  return view;
}

/** Remove the company's key. Assessments go back to the deployment's own. */
export async function remove(organisationId: string): Promise<void> {
  await prisma.providerCredential.deleteMany({ where: { organisationId } });
}

/**
 * Switch between the company's key and the deployment's, keeping both.
 *
 * The reversible half of `remove`. Switching off leaves the row exactly as it
 * is, so coming back is one click rather than finding the key again — which is
 * what anyone trying a provider actually does.
 *
 * Not re-probed on the way back on purpose: the probe result and its date are
 * still on the row and still true of that key, and a silent model call every
 * time somebody flicks the switch would be a bill nobody asked for. A key that
 * has gone stale shows up as a failing run, and Replace is next to this.
 */
export async function setEnabled(
  organisationId: string,
  enabled: boolean,
): Promise<CredentialView> {
  const { count } = await prisma.providerCredential.updateMany({
    where: { organisationId },
    data: { enabled },
  });
  if (count === 0) throw new CredentialRefused("There is no key of your own to switch.");

  const view = await load(organisationId);
  if (!view) throw new CredentialRefused("There is no key of your own to switch.");
  return view;
}

/**
 * The key itself, for the workers.
 *
 * The one function here that returns plaintext, called from exactly one place:
 * /api/internal/credentials. Returns null for an organisation with no key, one
 * switched off by its administrator, one the probe found unusable, or one that
 * cannot be decrypted — all four mean the same thing to a worker, which is "use
 * the environment's key", and that is the behaviour every organisation had
 * before this table existed.
 *
 * An unreadable ciphertext is logged rather than thrown. The work should carry
 * on; the administrator is told on their own page, where the fix is.
 */
export async function resolve(organisationId: string): Promise<{
  provider: ProviderName;
  apiKey: string;
  model: string;
  fastModel: string;
  openrouterProviders: string[];
  zdr: boolean;
} | null> {
  const row = await prisma.providerCredential.findUnique({
    where: { organisationId },
    select: {
      provider: true,
      ciphertext: true,
      model: true,
      fastModel: true,
      openrouterProviders: true,
      zdr: true,
      active: true,
      enabled: true,
    },
  });
  if (!row || !row.active || !row.enabled) return null;
  if (!isProvider(row.provider)) return null;

  let apiKey: string;
  try {
    apiKey = decryptSecret(row.ciphertext, organisationId);
  } catch (error) {
    console.error(
      "[credentials] a stored key could not be decrypted",
      JSON.stringify({
        organisationId,
        provider: row.provider,
        reason: error instanceof Error ? error.message : String(error),
      }),
    );
    return null;
  }

  return {
    provider: row.provider,
    apiKey,
    model: row.model,
    fastModel: row.fastModel,
    openrouterProviders: row.openrouterProviders,
    zdr: row.zdr,
  };
}
