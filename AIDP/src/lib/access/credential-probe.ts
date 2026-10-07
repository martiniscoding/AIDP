/**
 * Does this key actually work, and can it do the work?
 *
 * The question is not "is the string shaped like an API key" — it is whether
 * the provider will answer, and whether what comes back is the sort of answer
 * this engine is built on. Three things are tested, mirroring what the Python
 * workers really send (Workers/aidp/ai/llm.py):
 *
 *   authentication  the obvious one, and the cheapest to get wrong.
 *   a JSON object   every verdict, every rule reading, every coverage pass is a
 *                   structured reply. A model that cannot return one breaks
 *                   assessments *one clause at a time*, caught by the
 *                   per-clause guard — which is to say silently, over hours,
 *                   with a finished-looking report at the end.
 *   vision          figure descriptions. Not fatal: the parse stage already
 *                   degrades and raises a `figure_undescribed` issue. So this
 *                   is reported as a limitation rather than a refusal.
 *
 * Why it runs at save time rather than at first use: the alternative is finding
 * out during somebody's assessment. The OpenRouter path sends `strict` schemas
 * with `require_parameters`, and a model that takes no `temperature` leaves no
 * endpoint able to serve the request — which is how changing the model once
 * took the whole analyse stage down. One request while an administrator is
 * looking at the screen is worth a great deal.
 */

/** A 16×16 PNG with an X drawn on it. Small enough to be free, real enough that
 *  a provider which cannot accept images says so. */
const PROBE_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAS0lEQVR42mNgYGD4TzRggKgmUg9UMTKHoGqEBvx6" +
  "kKUYcEngEmQgII1hBD4jsVuIM/hweIkaGkhzEmmeJi1YSYs40pIGaYmP1OQNADofnX+Hjn2uAAAAAElFTkSuQmCC";

/**
 * One shape, two spellings — the same split Workers/aidp/ai/llm.py lives with.
 *
 * Gemini's `response_schema` is an OpenAPI subset: it has no
 * `additionalProperties` and answers 400 "Unknown name
 * \"additionalProperties\" at 'generation_config.response_schema'" when it is
 * sent one. OpenAI-style strict mode is the mirror image and *requires* every
 * object closed with it, which is what makes a reply conform rather than merely
 * try to.
 *
 * Sending one schema to both is how a perfectly good Gemini key was saved
 * switched off with a provider error that looked like the key's fault. The
 * probe exists to send what the workers send, so it has to split the same way:
 * `_strict_schema` converts there, and with one property it is two literals
 * off one shape here.
 */
const PROBE_SHAPE = {
  type: "object",
  properties: { ok: { type: "boolean" } },
  required: ["ok"],
} as const;

const PROBE_SCHEMA_GEMINI = { ...PROBE_SHAPE, propertyOrdering: ["ok"] } as const;
const PROBE_SCHEMA_STRICT = { ...PROBE_SHAPE, additionalProperties: false } as const;

const ASK = 'Reply with this exact JSON object and nothing else: {"ok": true}';
const ASK_IMAGE =
  'An image is attached. Reply with this exact JSON object and nothing else: {"ok": true}';

export type ProbeResult = {
  /** Whether the key may be used. Authentication and JSON both have to hold. */
  ok: boolean;
  authOk: boolean;
  jsonOk: boolean;
  /** False is a limitation, not a refusal — figures go undescribed. */
  visionOk: boolean;
  /** What went wrong, said the way an administrator would say it. */
  notes: string[];
  model: string;
  checkedAt: string;
};

export type ProbeInput = {
  provider: string;
  apiKey: string;
  model: string;
  openrouterProviders?: string[];
  zdr?: boolean;
};

/** Long enough for a slow cold start, short enough that a wrong base URL does
 *  not hold a form open. */
const TIMEOUT_MS = 30_000;

async function post(
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<{ status: number; json: unknown; text: string }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await response.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Left null: a provider answering with HTML is a wrong endpoint, and the
    // status code already says so.
  }
  return { status: response.status, json, text };
}

/** `{"ok": true}` somewhere in the reply, however the model wrapped it. Lenient
 *  on purpose: the engine's own parser strips code fences and finds the first
 *  object, so the probe must not be stricter than the thing it predicts. */
function saysOk(reply: string): boolean {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start === -1 || end <= start) return false;
  try {
    const parsed = JSON.parse(reply.slice(start, end + 1));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

/** What a provider said, trimmed to something a person can read on a form. */
function reason(status: number, text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const said = flat.length > 180 ? `${flat.slice(0, 177)}…` : flat;
  if (status === 401 || status === 403) return `the provider rejected the key (${status})`;
  if (status === 402) return "the provider says the account is out of credits (402)";
  if (status === 404) return `the provider does not recognise that model (404): ${said}`;
  if (status === 429) return "the provider is rate-limiting this key (429)";
  return `the provider answered ${status}: ${said}`;
}

type Attempt = { ok: boolean; status: number; reply: string; detail: string };

async function gemini(input: ProbeInput, image: boolean): Promise<Attempt> {
  const parts: unknown[] = [{ text: image ? ASK_IMAGE : ASK }];
  if (image) parts.push({ inline_data: { mime_type: "image/png", data: PROBE_PNG } });

  const { status, json, text } = await post(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(input.model)}:generateContent`,
    { "x-goog-api-key": input.apiKey },
    {
      contents: [{ role: "user", parts }],
      generationConfig: {
        maxOutputTokens: 64,
        temperature: 0,
        // The workers disable thinking, and a thinking model bills reasoning
        // against the same output budget — at 64 tokens it would spend the lot
        // and return nothing, failing a key that is perfectly good.
        thinkingConfig: { thinkingBudget: 0 },
        responseMimeType: "application/json",
        responseSchema: PROBE_SCHEMA_GEMINI,
      },
    },
  );
  if (status !== 200) return { ok: false, status, reply: "", detail: reason(status, text) };

  const candidate = (json as { candidates?: { content?: { parts?: { text?: string }[] } }[] })
    ?.candidates?.[0];
  const reply = (candidate?.content?.parts ?? []).map((part) => part.text ?? "").join("");
  return { ok: true, status, reply, detail: "" };
}

async function anthropic(input: ProbeInput, image: boolean): Promise<Attempt> {
  const content: unknown[] = [];
  if (image) {
    content.push({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: PROBE_PNG },
    });
  }
  content.push({ type: "text", text: image ? ASK_IMAGE : ASK });

  const { status, json, text } = await post(
    "https://api.anthropic.com/v1/messages",
    { "x-api-key": input.apiKey, "anthropic-version": "2023-06-01" },
    { model: input.model, max_tokens: 64, messages: [{ role: "user", content }] },
  );
  if (status !== 200) return { ok: false, status, reply: "", detail: reason(status, text) };

  const blocks = (json as { content?: { type?: string; text?: string }[] })?.content ?? [];
  const reply = blocks
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("");
  return { ok: true, status, reply, detail: "" };
}

async function openrouter(input: ProbeInput, image: boolean): Promise<Attempt> {
  const content: unknown[] = [{ type: "text", text: image ? ASK_IMAGE : ASK }];
  if (image) {
    content.push({ type: "image_url", image_url: { url: `data:image/png;base64,${PROBE_PNG}` } });
  }

  const provider: Record<string, unknown> = { data_collection: "deny" };
  if (input.openrouterProviders?.length) provider.only = input.openrouterProviders;
  if (input.zdr) provider.zdr = true;
  // The workers send this with every schema request, so the probe must too —
  // routing a strict schema to a host that would ignore it is the failure this
  // whole function exists to catch.
  provider.require_parameters = true;

  const { status, json, text } = await post(
    "https://openrouter.ai/api/v1/chat/completions",
    { Authorization: `Bearer ${input.apiKey}`, "X-Title": "AIDP" },
    {
      model: input.model,
      messages: [{ role: "user", content }],
      max_tokens: 64,
      provider,
      response_format: {
        type: "json_schema",
        json_schema: { name: "probe", strict: true, schema: PROBE_SCHEMA_STRICT },
      },
    },
  );
  if (status !== 200) return { ok: false, status, reply: "", detail: reason(status, text) };

  // OpenRouter answers 200 with an error body when no endpoint can serve the
  // request — the exact shape of the incident that took the analyse stage down.
  const error = (json as { error?: { message?: string } })?.error;
  if (error) {
    return {
      ok: false,
      status,
      reply: "",
      detail: `no provider could serve that request: ${String(error.message ?? "").slice(0, 160)}`,
    };
  }

  const reply =
    (json as { choices?: { message?: { content?: string } }[] })?.choices?.[0]?.message?.content ??
    "";
  return { ok: true, status, reply, detail: "" };
}

const PROBES: Record<string, (input: ProbeInput, image: boolean) => Promise<Attempt>> = {
  gemini,
  anthropic,
  openrouter,
};

/**
 * Test a key against its provider.
 *
 * Never throws. A probe that cannot complete — the provider unreachable, DNS
 * refusing, a timeout — is a failed probe with a readable note, because the
 * caller is a form submission and an unhandled rejection there says nothing to
 * anybody.
 */
export async function probeCredential(input: ProbeInput): Promise<ProbeResult> {
  const checkedAt = new Date().toISOString();
  const run = PROBES[input.provider];
  if (!run) {
    return {
      ok: false,
      authOk: false,
      jsonOk: false,
      visionOk: false,
      notes: [`${input.provider} is not a provider this engine can talk to`],
      model: input.model,
      checkedAt,
    };
  }

  const notes: string[] = [];
  let first: Attempt;
  try {
    first = await run(input, false);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      authOk: false,
      jsonOk: false,
      visionOk: false,
      notes: [`the provider could not be reached: ${detail.slice(0, 160)}`],
      model: input.model,
      checkedAt,
    };
  }

  if (!first.ok) {
    return {
      ok: false,
      authOk: false,
      jsonOk: false,
      visionOk: false,
      notes: [first.detail],
      model: input.model,
      checkedAt,
    };
  }

  const jsonOk = saysOk(first.reply);
  if (!jsonOk) {
    notes.push(
      "the key works, but this model did not answer with a JSON object — every " +
        "verdict in an assessment is one, so it cannot be used for judging",
    );
  }

  // Only worth the second call once the first has proved the key itself.
  let visionOk = false;
  try {
    const second = await run(input, true);
    visionOk = second.ok && saysOk(second.reply);
    if (!visionOk) {
      notes.push(
        "this model would not read an image, so diagrams and figures will go " +
          "undescribed — assessments still run, with less to retrieve from" +
          (second.detail ? ` (${second.detail})` : ""),
      );
    }
  } catch {
    notes.push("the image check could not be completed, so figures may go undescribed");
  }

  return { ok: jsonOk, authOk: true, jsonOk, visionOk, notes, model: input.model, checkedAt };
}
