/**
 * Which providers a company may bring a key for, and what to point them at.
 *
 * Split out of credentials.ts so the settings form can import it. That file
 * reaches Prisma and node:crypto, and a client component importing from it
 * would pull the database client and the decryption code into the browser
 * bundle — the build may even allow it, which is worse.
 *
 * Nothing here is a secret or touches one. It is the catalogue, and both the
 * server store and the form read it from here so there is one list rather than
 * two that drift.
 */

export type ProviderName = "openrouter" | "anthropic" | "gemini";

/**
 * What each provider is called and what it should be pointed at by default.
 *
 * The models here are the same ones Workers/aidp/config.py defaults to, and
 * they have to stay that way: an administrator who brings a key and changes
 * nothing else should get the behaviour the product was built and tested
 * against, not a different model because two files drifted.
 */
export const PROVIDERS: Record<
  ProviderName,
  {
    label: string;
    /** Where an administrator gets a key, named rather than linked blindly. */
    where: string;
    model: string;
    fastModel: string;
    /** Whether the provider has a separate cheap model for the high-volume call. */
    twoModels: boolean;
    note: string;
  }
> = {
  openrouter: {
    label: "OpenRouter",
    where: "openrouter.ai → Keys",
    model: "openai/gpt-4.1-mini",
    fastModel: "openai/gpt-4.1-nano",
    twoModels: true,
    note:
      "One key, most models behind it. Requests are pinned to the model's own vendor and " +
      "sent with data collection denied, so documents are not routed to whichever host is " +
      "cheapest.",
  },
  anthropic: {
    label: "Anthropic",
    where: "console.anthropic.com → API keys",
    model: "claude-sonnet-4-5",
    fastModel: "claude-haiku-4-5-20251001",
    twoModels: true,
    note:
      "Caches the document as a prompt prefix, so a long run pays for reading it roughly " +
      "once rather than once per chunk.",
  },
  gemini: {
    label: "Google Gemini",
    where: "aistudio.google.com → Get API key",
    model: "gemini-2.5-flash",
    fastModel: "gemini-2.5-flash",
    twoModels: false,
    note:
      "Cheapest of the three at these volumes. A free-tier key will exhaust its daily " +
      "quota partway through a real document set.",
  },
};

export function isProvider(value: string): value is ProviderName {
  return value === "openrouter" || value === "anthropic" || value === "gemini";
}
