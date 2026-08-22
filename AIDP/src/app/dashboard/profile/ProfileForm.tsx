"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Info } from "lucide-react";
import { cn } from "@/lib/cn";
import { COUNTRIES } from "@/lib/countries";
import type { CompanyProfile } from "@/lib/access/profile";
import { saveProfile } from "./actions";

/**
 * The company's details, editable in place.
 *
 * One note earns its space: renaming the company changes what every employee
 * types at sign-in. That is not obvious from a text field, and finding out by
 * locking the team out would be an unpleasant way to learn it.
 */
export function ProfileForm({ profile }: { profile: CompanyProfile }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState(profile.name);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const renaming = name.trim() !== profile.name;

  return (
    <form
      action={(formData) =>
        startTransition(async () => {
          const result = await saveProfile(formData);
          setMessage({ ok: result.ok, text: result.message });
          if (result.ok) router.refresh();
        })
      }
      className="rounded-2xl border border-line bg-card shadow-card p-5 sm:p-6"
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          name="name"
          label="Company name"
          required
          value={name}
          onChange={setName}
          hint={
            renaming
              ? "Everyone signs in with this name — they will need to use the new one."
              : undefined
          }
        />
        <Field name="industry" label="Industry" defaultValue={profile.industry} placeholder="Optional" />
        <Field
          name="primaryContact"
          label="Primary contact"
          defaultValue={profile.primaryContact}
          placeholder="Who to speak to"
        />
        <Field
          name="contactEmail"
          label="Contact email"
          type="email"
          defaultValue={profile.contactEmail}
          placeholder="Optional"
        />
        <Field
          name="contactPhone"
          label="Contact phone"
          defaultValue={profile.contactPhone}
          placeholder="Optional"
        />

        <label className="block">
          <span className="mb-1 block text-[11px] font-medium uppercase tracking-[0.12em] text-ink/62">
            Country
          </span>
          <select
            name="country"
            defaultValue={profile.country}
            className="w-full rounded-lg border border-line bg-card px-2.5 py-1.5 text-[13px] text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-royal-mid"
          >
            <option value="">Not set</option>
            {COUNTRIES.map((country) => (
              <option key={country} value={country}>
                {country}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className="mt-4 block">
        <span className="mb-1 block text-[11px] font-medium uppercase tracking-[0.12em] text-ink/62">
          Notes
        </span>
        <textarea
          name="notes"
          rows={3}
          defaultValue={profile.notes}
          placeholder="Anything worth recording about this company."
          className="w-full resize-y rounded-lg border border-line bg-card px-2.5 py-2 text-[13px] text-ink placeholder:text-ink/58 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-royal-mid"
        />
      </label>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-full bg-royal px-4 py-1.5 text-[12.5px] font-medium text-white transition-colors hover:bg-royal-mid disabled:opacity-40"
        >
          {pending ? "Saving…" : "Save changes"}
        </button>

        {message && (
          <p
            role="status"
            className={cn("text-[12.5px]", message.ok ? "text-ok" : "text-warn")}
          >
            {message.text}
          </p>
        )}
      </div>
    </form>
  );
}

function Field({
  name,
  label,
  type = "text",
  required,
  placeholder,
  defaultValue,
  value,
  onChange,
  hint,
}: {
  name: string;
  label: string;
  type?: string;
  required?: boolean;
  placeholder?: string;
  defaultValue?: string;
  value?: string;
  onChange?: (next: string) => void;
  hint?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium uppercase tracking-[0.12em] text-ink/62">
        {label}
      </span>
      <input
        name={name}
        type={type}
        required={required}
        placeholder={placeholder}
        {...(onChange
          ? { value: value ?? "", onChange: (event) => onChange(event.target.value) }
          : { defaultValue })}
        className="w-full rounded-lg border border-line bg-card px-2.5 py-1.5 text-[13px] text-ink placeholder:text-ink/58 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-royal-mid"
      />
      {hint && (
        <span className="mt-1.5 flex items-start gap-1.5 text-[11.5px] leading-relaxed text-warn">
          <Info size={12} className="mt-0.5 shrink-0" />
          {hint}
        </span>
      )}
    </label>
  );
}
