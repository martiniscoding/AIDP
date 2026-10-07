import { PROVIDERS } from "./credential-providers";

/**
 * The OpenRouter models an administrator may choose from.
 *
 * Typing a model id from memory is how somebody installs a key pointed at a
 * model that cannot do the work — and the engine's one hard requirement is not
 * obvious from a name: every judgement is a strict JSON reply, and a model
 * without structured outputs fails the probe at best and breaks assessments one
 * clause at a time at worst.
 *
 * So the list is read from OpenRouter's own catalogue rather than written here,
 * and filtered by what the catalogue says each model supports. A hard-coded
 * list would be wrong within a month: the catalogue moves, and a model that has
 * been retired reads exactly like one that was never there.
 *
 * Never throws. A settings page that cannot load because a third party is down
 * is worse than one offering a text box, which is what the form falls back to.
 */

const CATALOGUE = "https://openrouter.ai/api/v1/models";

/** An hour. The catalogue changes on the order of weeks. */
const REVALIDATE_SECONDS = 3600;

const TIMEOUT_MS = 6000;

/**
 * How many of each vendor's models to offer.
 *
 * Unfiltered this is 195 entries, most of them a vendor's older generations —
 * OpenAI alone hosts 62. Sorted newest first, a dozen is the current generation
 * and a little history, which is what somebody picking a model is choosing
 * between. The rest stay reachable by typing the id.
 */
const PER_VENDOR = 12;

/**
 * Whose models to offer, in this order.
 *
 * The catalogue carries 48 vendors, most of them re-hosts and experiments. A
 * consultancy putting client documents through one wants the houses it can name
 * in a vendor assessment, so this is an allowlist rather than a blocklist —
 * a new re-host appearing should not silently become an option.
 */
const VENDORS: { prefix: string; label: string }[] = [
  { prefix: "openai", label: "OpenAI" },
  { prefix: "anthropic", label: "Anthropic" },
  { prefix: "google", label: "Google" },
  { prefix: "x-ai", label: "xAI" },
  { prefix: "meta-llama", label: "Meta" },
  { prefix: "mistralai", label: "Mistral" },
  { prefix: "deepseek", label: "DeepSeek" },
  { prefix: "qwen", label: "Qwen" },
  { prefix: "cohere", label: "Cohere" },
];

export type ModelOption = {
  id: string;
  label: string;
  /** Whether it can read a figure. Not required — parsing degrades without it. */
  vision: boolean;
  /** US dollars per million input / output tokens, for the label. */
  inPerM: number;
  outPerM: number;
};

export type ModelGroup = { label: string; models: ModelOption[] };

type Row = {
  id?: unknown;
  name?: unknown;
  created?: unknown;
  architecture?: { input_modalities?: unknown; output_modalities?: unknown };
  pricing?: { prompt?: unknown; completion?: unknown };
  supported_parameters?: unknown;
};

function perMillion(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n * 1_000_000 : 0;
}

function usable(row: Row): row is Row & { id: string } {
  if (typeof row.id !== "string" || !row.id) return false;

  // The one hard requirement. Everything the engine asks a model for is a
  // schema-constrained reply; without this it cannot judge a clause.
  const params = Array.isArray(row.supported_parameters) ? row.supported_parameters : [];
  if (!params.includes("structured_outputs")) return false;

  // Variants, not models. ":batch" is answered asynchronously and every call
  // here is synchronous; ":free" is rate-limited to the point of uselessness on
  // a hundred-clause run.
  if (row.id.includes(":")) return false;

  // Image generators. They take a prompt and return a picture, which is not
  // what any stage asks for.
  const out = row.architecture?.output_modalities;
  if (Array.isArray(out) && out.includes("image")) return false;

  return true;
}

/**
 * The catalogue, grouped and filtered, or an empty list if it cannot be read.
 *
 * Cached by the fetch layer rather than in a module variable, so every running
 * instance shares one answer and a deploy does not start cold.
 */
export async function openrouterModels(): Promise<ModelGroup[]> {
  let rows: Row[];
  try {
    const response = await fetch(CATALOGUE, {
      next: { revalidate: REVALIDATE_SECONDS },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return [];
    const body = (await response.json()) as { data?: unknown };
    rows = Array.isArray(body.data) ? (body.data as Row[]) : [];
  } catch {
    // A page that still renders, with a text box instead of a list.
    return [];
  }

  const kept = rows.filter(usable);
  const groups: ModelGroup[] = [];

  for (const vendor of VENDORS) {
    const models = kept
      .filter((row) => row.id.startsWith(`${vendor.prefix}/`))
      // Newest first. The catalogue has no popularity to sort on, and release
      // order is the closest honest proxy — nobody scrolling this list is
      // looking for the oldest model a vendor still hosts.
      .sort((a, b) => Number(b.created ?? 0) - Number(a.created ?? 0))
      .slice(0, PER_VENDOR)
      .map((row) => {
        const input = row.architecture?.input_modalities;
        return {
          id: row.id,
          label: typeof row.name === "string" && row.name ? row.name : row.id,
          vision: Array.isArray(input) && input.includes("image"),
          inPerM: perMillion(row.pricing?.prompt),
          outPerM: perMillion(row.pricing?.completion),
        };
      });
    if (models.length) groups.push({ label: vendor.label, models });
  }

  // The product's own defaults first, however the vendors sort. Somebody who
  // has no opinion should not have to find them among two hundred others, and
  // "what this was tested against" is the most useful thing the list can say.
  // Looked up in the unfiltered set, not in the groups: the product's defaults
  // are older than a dozen releases on some vendors, so the cap above would
  // otherwise hide the one pair somebody should pick by default.
  const tested = [PROVIDERS.openrouter.model, PROVIDERS.openrouter.fastModel];
  const pinned = tested.flatMap((id) => {
    const row = kept.find((candidate) => candidate.id === id);
    if (!row) return [];
    const input = row.architecture?.input_modalities;
    return [
      {
        id: row.id,
        label: typeof row.name === "string" && row.name ? row.name : row.id,
        vision: Array.isArray(input) && input.includes("image"),
        inPerM: perMillion(row.pricing?.prompt),
        outPerM: perMillion(row.pricing?.completion),
      },
    ];
  });
  if (pinned.length) {
    groups.unshift({ label: "Tested with this product", models: pinned });
  }

  return groups;
}
