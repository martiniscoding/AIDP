"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, ArrowLeftRight, Check, Info, KeyRound, Trash2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { PROVIDERS, type ProviderName } from "@/lib/access/credential-providers";
import type { CredentialView } from "@/lib/access/credentials";
import { ProviderMark, type MarkName } from "./ProviderMark";
import { removeModelKey, saveModelKey, setModelKeyEnabled } from "./actions";

/**
 * The company's own model key.
 *
 * Three things this screen has to get across, because each of them is a
 * question an administrator will otherwise ask support:
 *
 *   1. Not setting one is fine. The default is the platform's key and that is
 *      stated first, so the empty state reads as a working system rather than
 *      something unfinished.
 *   2. The key is verified when it is saved, and the result is shown. A key
 *      that authenticates but cannot return a JSON object is useless to the
 *      engine, and finding that out mid-assessment is how an afternoon goes.
 *   3. It pays for generation, not for search. Embeddings stay on the
 *      platform's key, and saying so here heads off "I set my key, why is there
 *      still platform spend".
 *
 * The key itself is never sent back to the browser — only its last four
 * characters — so there is no "show key" control to write and no plaintext in a
 * React payload. Replacing is the only way to change it, which is also the only
 * safe way.
 */
export function ModelKey({
  credential,
  storageReady,
}: {
  credential: CredentialView | null;
  /** False when CREDENTIAL_ENCRYPTION_KEY is unset: nothing can be stored. */
  storageReady: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState(false);
  const [provider, setProvider] = useState<ProviderName>(credential?.provider ?? "openrouter");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const defaults = PROVIDERS[provider];

  function act(run: () => Promise<{ ok: boolean; message: string }>, closeOnSuccess: boolean) {
    startTransition(async () => {
      const result = await run();
      setMessage({ ok: result.ok, text: result.message });
      if (result.ok && closeOnSuccess) setEditing(false);
      router.refresh();
    });
  }

  return (
    <section className="mt-6 rounded-2xl border border-line bg-card shadow-card p-5 sm:p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 font-display text-[17px] font-semibold tracking-[-0.01em] text-ink">
            <KeyRound size={15} className="text-ink/55" />
            Model key
          </h2>
          <p className="mt-1.5 max-w-xl text-[13px] leading-relaxed text-ink/68">
            Assessments are run by a language model. Use ours, or bring your own key and your
            company pays the provider directly for the work.
          </p>
        </div>

        {credential && !editing && (
          <div className="flex flex-wrap items-center gap-2">
            {/* The reversible switch, first and in the ordinary style, because
                it is what somebody trying a provider reaches for. Remove stays,
                but deleting a key to stop using it for an afternoon is not what
                they meant and used to be the only way to say it. */}
            <button
              type="button"
              disabled={pending}
              onClick={() => act(() => setModelKeyEnabled(!credential.enabled), false)}
              className="flex items-center gap-1.5 rounded-full border border-line px-3.5 py-1.5 text-[12.5px] font-medium text-ink transition-colors hover:bg-ink/4 disabled:opacity-40"
            >
              <ArrowLeftRight size={12} className="text-ink/55" />
              {credential.enabled ? "Use the platform's key" : "Use my key"}
            </button>
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="rounded-full border border-line px-3.5 py-1.5 text-[12.5px] font-medium text-ink transition-colors hover:bg-ink/4"
            >
              Replace
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => act(() => removeModelKey(), false)}
              className="flex items-center gap-1.5 rounded-full border border-line px-3.5 py-1.5 text-[12.5px] font-medium text-warn transition-colors hover:bg-warn/8 disabled:opacity-40"
            >
              <Trash2 size={12} />
              Remove
            </button>
          </div>
        )}
      </header>

      {!storageReady && (
        <Banner tone="warn">
          This deployment cannot store a key yet — <code>CREDENTIAL_ENCRYPTION_KEY</code> is not
          configured. Ask whoever operates the platform to set it; until then every assessment runs
          on the platform&rsquo;s own key.
        </Banner>
      )}

      {credential ? (
        <Installed credential={credential} />
      ) : (
        <Banner tone="info">
          No key of your own. Assessments run on the platform&rsquo;s key and the model spend shows
          on your usage page as usual.
        </Banner>
      )}

      {storageReady && (!credential || editing) && (
        <form
          action={(formData) => act(() => saveModelKey(formData), true)}
          className="mt-5 border-t border-line pt-5"
        >
          <fieldset>
            <legend className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.12em] text-ink/62">
              Provider
            </legend>
            <div className="grid gap-2.5 sm:grid-cols-3">
              {(Object.keys(PROVIDERS) as ProviderName[]).map((name) => {
                const chosen = name === provider;
                return (
                  <label
                    key={name}
                    className={cn(
                      "group flex cursor-pointer items-center gap-2.5 rounded-xl border px-3 py-2.5 transition-colors",
                      // The accent marks the choice, as it does everywhere else
                      // in this interface. The marks themselves stay in the
                      // text colour and take their weight from it.
                      chosen
                        ? "border-royal bg-royal/6 text-ink"
                        : "border-line text-ink/62 hover:bg-ink/4 hover:text-ink/80",
                      "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-1 has-[:focus-visible]:outline-royal-mid",
                    )}
                  >
                    <input
                      type="radio"
                      name="provider"
                      value={name}
                      checked={chosen}
                      onChange={() => setProvider(name)}
                      className="sr-only"
                    />
                    <ProviderMark name={name as MarkName} size={18} />
                    <span className="text-[13px] font-medium">{PROVIDERS[name].label}</span>
                  </label>
                );
              })}
            </div>
            <Hint>{defaults.note}</Hint>
          </fieldset>

          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <label className="block">
              <Label>API key</Label>
              <input
                name="apiKey"
                type="password"
                required
                autoComplete="off"
                spellCheck={false}
                placeholder={credential ? `Replaces the key ending ${credential.keyLast4}` : "Paste it here"}
                className="w-full rounded-lg border border-line bg-card px-2.5 py-1.5 font-mono text-[13px] text-ink placeholder:font-sans placeholder:text-ink/58 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-royal-mid"
              />
              <Hint>From {defaults.where}. Stored encrypted, and never shown again.</Hint>
            </label>

            <label className="block">
              <Label>Model</Label>
              <input
                name="model"
                defaultValue={credential?.provider === provider ? credential.model : ""}
                placeholder={defaults.model}
                spellCheck={false}
                className="w-full rounded-lg border border-line bg-card px-2.5 py-1.5 font-mono text-[13px] text-ink placeholder:font-sans placeholder:text-ink/58 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-royal-mid"
              />
              <Hint>
                Judges every clause and reads every standard. Leave blank for {defaults.model},
                which is what the product is tested against.
              </Hint>
            </label>

            {defaults.twoModels && (
              <label className="block">
                <Label>Cheaper model</Label>
                <input
                  name="fastModel"
                  defaultValue={credential?.provider === provider ? credential.fastModel : ""}
                  placeholder={defaults.fastModel}
                  spellCheck={false}
                  className="w-full rounded-lg border border-line bg-card px-2.5 py-1.5 font-mono text-[13px] text-ink placeholder:font-sans placeholder:text-ink/58 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-royal-mid"
                />
                <Hint>
                  One call per chunk of every document — the largest single line on the bill, and a
                  summarising job, so it gets the cheap model.
                </Hint>
              </label>
            )}

            {provider === "openrouter" && (
              <>
                <label className="block">
                  <Label>Hosts allowed</Label>
                  <input
                    name="openrouterProviders"
                    defaultValue={(credential?.provider === "openrouter"
                      ? credential.openrouterProviders
                      : ["openai", "azure"]
                    ).join(", ")}
                    spellCheck={false}
                    className="w-full rounded-lg border border-line bg-card px-2.5 py-1.5 text-[13px] text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-royal-mid"
                  />
                  <Hint>
                    Which upstreams may serve a request. Pinning these keeps your documents off
                    whichever host is cheapest that minute. Blank means OpenRouter chooses.
                  </Hint>
                </label>

                <label className="flex items-start gap-2.5 pt-6">
                  <input
                    type="checkbox"
                    name="zdr"
                    defaultChecked={credential?.provider === "openrouter" ? credential.zdr : false}
                    className="mt-0.5 size-3.5 rounded border-line accent-royal"
                  />
                  <span className="text-[12.5px] leading-relaxed text-ink/72">
                    Zero-retention endpoints only.
                    <span className="block text-[11.5px] text-ink/58">
                      Not every model offers one — the request is refused outright rather than
                      quietly served by a host that keeps data.
                    </span>
                  </span>
                </label>
              </>
            )}
          </div>

          <div className="mt-5 flex flex-wrap items-center gap-3">
            <button
              type="submit"
              disabled={pending}
              className="rounded-full bg-royal px-4 py-1.5 text-[12.5px] font-medium text-white transition-colors hover:bg-royal-mid disabled:opacity-40"
            >
              {pending ? "Checking the key…" : credential ? "Replace key" : "Save and verify"}
            </button>
            {credential && (
              <button
                type="button"
                onClick={() => {
                  setEditing(false);
                  setMessage(null);
                }}
                className="text-[12.5px] text-ink/62 hover:text-ink"
              >
                Cancel
              </button>
            )}
            <p className="text-[11.5px] text-ink/58">
              Saving sends one small request to the provider to check the key can do the work.
            </p>
          </div>
        </form>
      )}

      {message && (
        <p
          role="status"
          className={cn("mt-4 text-[12.5px] leading-relaxed", message.ok ? "text-ok" : "text-warn")}
        >
          {message.text}
        </p>
      )}

      <p className="mt-5 border-t border-line pt-4 text-[11.5px] leading-relaxed text-ink/58">
        Your key pays for judging, reading standards, describing figures and writing suggestions.
        Search indexing stays on the platform&rsquo;s key — the index is tied to one embedding
        model, and changing it would make everything already uploaded unsearchable.
      </p>
    </section>
  );
}

/** The installed key, and what it was found to be capable of. */
function Installed({ credential }: { credential: CredentialView }) {
  const probe = credential.probe;

  return (
    <div className="mt-4 space-y-3">
      <dl className="grid gap-x-6 gap-y-2.5 text-[13px] sm:grid-cols-2">
        <Row
          label="Provider"
          value={
            <span className="flex items-center justify-end gap-2">
              <ProviderMark name={credential.provider as MarkName} size={15} />
              {credential.providerLabel}
            </span>
          }
        />
        <Row label="Key" value={`•••• ${credential.keyLast4}`} mono />
        <Row label="Model" value={credential.model} mono />
        {credential.fastModel !== credential.model && (
          <Row label="Cheaper model" value={credential.fastModel} mono />
        )}
        {credential.provider === "openrouter" && (
          <Row
            label="Hosts allowed"
            value={
              credential.openrouterProviders.length
                ? credential.openrouterProviders.join(", ") + (credential.zdr ? " · zero-retention" : "")
                : "OpenRouter chooses"
            }
          />
        )}
        <Row
          label="Installed by"
          value={`${credential.setBy ?? "an account since removed"} · ${credential.updatedAt.toLocaleDateString(
            undefined,
            { day: "numeric", month: "long", year: "numeric" },
          )}`}
        />
      </dl>

      {credential.unreadable ? (
        <Banner tone="warn">
          This key cannot be decrypted — <code>CREDENTIAL_ENCRYPTION_KEY</code> has changed since it
          was saved. Assessments are running on the platform&rsquo;s key. Paste the key again to fix
          it.
        </Banner>
      ) : !credential.enabled ? (
        /* Parked by choice, which is not the same as broken and must not read
           like it. Nothing is wrong, nothing needs fixing, and the way back is
           the button above. */
        <Banner tone="info">
          Set aside. Assessments are running on the platform&rsquo;s key, and this one is kept —
          switch back whenever you like.
          {!credential.active && " It did not pass its check, so replace it before switching back."}
        </Banner>
      ) : credential.active ? (
        <Banner tone="ok">
          Verified{" "}
          {credential.probedAt?.toLocaleDateString(undefined, { day: "numeric", month: "long" })} and
          in use for new assessments.
          {probe && !probe.visionOk && " It cannot read images, so figures will go undescribed."}
        </Banner>
      ) : (
        <Banner tone="warn">
          Saved but switched off, so assessments are running on the platform&rsquo;s key.
          {probe?.notes.length ? ` Why: ${probe.notes.join("; ")}.` : ""}
        </Banner>
      )}
    </div>
  );
}

function Row({
  label,
  value,
  mono,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-line/60 pb-2 sm:border-0 sm:pb-0">
      <dt className="text-[11px] font-medium uppercase tracking-[0.12em] text-ink/62">{label}</dt>
      <dd className={cn("text-right text-ink/85", mono && "font-mono text-[12.5px]")}>{value}</dd>
    </div>
  );
}

function Banner({ tone, children }: { tone: "ok" | "warn" | "info"; children: React.ReactNode }) {
  const Icon = tone === "ok" ? Check : tone === "warn" ? AlertTriangle : Info;
  return (
    <p
      className={cn(
        "mt-4 flex items-start gap-2 rounded-lg px-3 py-2.5 text-[12.5px] leading-relaxed",
        tone === "ok" && "bg-ok/8 text-ok",
        tone === "warn" && "bg-warn/8 text-warn",
        tone === "info" && "bg-ink/4 text-ink/72",
      )}
    >
      <Icon size={13} className="mt-0.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="mb-1 block text-[11px] font-medium uppercase tracking-[0.12em] text-ink/62">
      {children}
    </span>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return <span className="mt-1.5 block text-[11.5px] leading-relaxed text-ink/58">{children}</span>;
}
