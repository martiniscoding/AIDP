"use client";

import { useId, useMemo, useRef, useState } from "react";
import { Check, Plus, X } from "lucide-react";
import { BrandMark } from "@/components/brand/BrandMark";
import { cn } from "@/lib/cn";
import { resolveOption, type Option } from "@/lib/tech-stack/catalog";

/**
 * Multi-select field with a write-in.
 *
 * The template says "fill in the blanks or check the boxes", so both have to
 * be first-class: the catalog covers the common answers and the write-in
 * carries everything else. A written-in answer becomes a chip alongside the
 * catalog ones rather than a second-class "other" text box, because a client on
 * Teradata should not feel like they picked the wrong product.
 */
export function OptionGrid({
  label,
  description,
  options,
  value,
  onChange,
  addLabel = "Add your own",
}: {
  label: string;
  description?: string;
  options: readonly Option[];
  value: string[];
  onChange: (next: string[]) => void;
  addLabel?: string;
}) {
  const groupId = useId();
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const selected = useMemo(() => new Set(value), [value]);

  // Anything selected that isn't a catalog id is a write-in, and needs its own
  // chip — the catalog loop below would never render it.
  const writeIns = useMemo(
    () => value.filter((item) => !options.some((option) => option.id === item)),
    [value, options],
  );

  function toggle(id: string) {
    onChange(
      selected.has(id) ? value.filter((item) => item !== id) : [...value, id],
    );
  }

  function commitDraft() {
    const entry = draft.trim();
    if (!entry) {
      setAdding(false);
      return;
    }

    // If the client types something the catalog already offers, select that
    // option instead of storing a near-duplicate string.
    const match = options.find(
      (option) => option.label.toLowerCase() === entry.toLowerCase(),
    );
    const next = match ? match.id : entry;

    if (!value.some((item) => item.toLowerCase() === next.toLowerCase())) {
      onChange([...value, next]);
    }

    setDraft("");
    setAdding(false);
  }

  return (
    <fieldset className="min-w-0">
      <legend className="text-[13px] font-medium text-white/75">{label}</legend>
      {description ? (
        <p className="mt-1 text-[12.5px] text-white/40">{description}</p>
      ) : null}

      <div
        role="group"
        aria-labelledby={groupId}
        className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3"
      >
        <span id={groupId} className="sr-only">
          {label}
        </span>

        {options.map((option) => {
          const isOn = selected.has(option.id);
          return (
            <button
              key={option.id}
              type="button"
              onClick={() => toggle(option.id)}
              aria-pressed={isOn}
              className={cn(
                "group flex items-center gap-3 rounded-xl border px-3 py-2.5 text-left",
                "transition-[border-color,background-color] duration-200",
                isOn
                  ? "border-white/25 bg-white/[0.07]"
                  : "border-white/10 bg-white/[0.02] hover:border-white/20 hover:bg-white/[0.04]",
              )}
            >
              <BrandMark
                brand={option.brand}
                label={option.label}
                size="sm"
                active={isOn}
              />

              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13.5px] text-white/90">
                  {option.label}
                </span>
                {option.hint ? (
                  <span className="block truncate text-[11.5px] text-white/35">
                    {option.hint}
                  </span>
                ) : null}
              </span>

              <span
                aria-hidden="true"
                className={cn(
                  "grid size-4 shrink-0 place-items-center rounded-[5px] border transition-colors duration-200",
                  isOn
                    ? "border-royal-mid bg-royal-mid text-white"
                    : "border-white/20 text-transparent group-hover:border-white/35",
                )}
              >
                <Check size={11} strokeWidth={3.5} />
              </span>
            </button>
          );
        })}

        {writeIns.map((entry) => {
          const option = resolveOption(options, entry);
          return (
            <span
              key={entry}
              className="flex items-center gap-3 rounded-xl border border-royal-mid/40 bg-royal/[0.14] px-3 py-2.5"
            >
              <BrandMark label={option.label} size="sm" active />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13.5px] text-white/90">
                  {option.label}
                </span>
                <span className="block text-[11.5px] text-royal-soft/70">
                  Added by you
                </span>
              </span>
              <button
                type="button"
                onClick={() => onChange(value.filter((item) => item !== entry))}
                className="grid size-5 shrink-0 place-items-center rounded-md text-white/40 transition-colors hover:bg-white/10 hover:text-white"
              >
                <X size={12} strokeWidth={2.6} />
                <span className="sr-only">Remove {option.label}</span>
              </button>
            </span>
          );
        })}

        {adding ? (
          <span className="flex items-center gap-2 rounded-xl border border-royal-mid/50 bg-white/[0.04] px-2.5 py-2">
            <input
              ref={inputRef}
              autoFocus
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onBlur={commitDraft}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  commitDraft();
                }
                if (event.key === "Escape") {
                  setDraft("");
                  setAdding(false);
                }
              }}
              placeholder="Type a name…"
              aria-label={`Add to ${label}`}
              className="h-7 min-w-0 flex-1 bg-transparent text-[13.5px] text-white placeholder:text-white/30 focus:outline-none"
            />
            <kbd className="rounded border border-white/15 px-1.5 py-0.5 text-[10px] text-white/40">
              ↵
            </kbd>
          </span>
        ) : (
          <button
            type="button"
            onClick={() => {
              setAdding(true);
              requestAnimationFrame(() => inputRef.current?.focus());
            }}
            className={cn(
              "flex items-center gap-3 rounded-xl border border-dashed border-white/15 px-3 py-2.5 text-left",
              "text-[13.5px] text-white/45 transition-colors duration-200",
              "hover:border-royal-mid/50 hover:bg-white/[0.03] hover:text-white/80",
            )}
          >
            <span className="grid size-7 shrink-0 place-items-center rounded-lg border border-dashed border-white/20">
              <Plus size={14} strokeWidth={2.2} />
            </span>
            {addLabel}
          </button>
        )}
      </div>
    </fieldset>
  );
}
