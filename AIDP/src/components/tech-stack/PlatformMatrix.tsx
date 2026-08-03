"use client";

import { useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import { BrandMark } from "@/components/brand/BrandMark";
import { Segmented } from "@/components/tech-stack/Segmented";
import { cn } from "@/lib/cn";
import {
  INTEREST_CHOICES,
  PLATFORMS,
  USAGE_CHOICES,
  customPlatformKey,
} from "@/lib/tech-stack/catalog";
import type { PlatformInput } from "@/lib/tech-stack/schema";

const CATALOG = new Map(PLATFORMS.map((platform) => [platform.id, platform]));

/**
 * Section 4 — current usage and interest level, one row per platform.
 *
 * The template draws this as a table. It stays a table on desktop, where
 * comparing a column down four rows is the whole point, and becomes stacked
 * cards under `md` where a three-column grid would force a horizontal scroll.
 */
export function PlatformMatrix({
  value,
  onChange,
}: {
  value: PlatformInput[];
  onChange: (next: PlatformInput[]) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  function update(platformKey: string, patch: Partial<PlatformInput>) {
    onChange(
      value.map((row) =>
        row.platformKey === platformKey ? { ...row, ...patch } : row,
      ),
    );
  }

  function commitDraft() {
    const label = draft.trim();
    if (!label) {
      setAdding(false);
      return;
    }

    const platformKey = customPlatformKey(label);
    if (!value.some((row) => row.platformKey === platformKey)) {
      onChange([
        ...value,
        {
          platformKey,
          label,
          isCustom: true,
          currentUsage: null,
          interestLevel: null,
        },
      ]);
    }

    setDraft("");
    setAdding(false);
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-white/10">
      {/* Column headers, desktop only — the stacked layout labels each control
          inline instead, so repeating them here would be read twice. */}
      <div className="hidden items-center gap-4 border-b border-white/10 bg-white/[0.02] px-4 py-2.5 md:grid md:grid-cols-[minmax(0,1fr)_auto_auto]">
        <span className="text-[11px] font-medium uppercase tracking-[0.14em] text-white/35">
          Platform / architecture
        </span>
        <span className="w-[104px] text-[11px] font-medium uppercase tracking-[0.14em] text-white/35">
          In use
        </span>
        <span className="w-[152px] text-[11px] font-medium uppercase tracking-[0.14em] text-white/35">
          Interest
        </span>
      </div>

      <div className="divide-y divide-white/[0.07]">
        {value.map((row) => {
          const option = CATALOG.get(row.platformKey);
          const answered = row.currentUsage || row.interestLevel;

          return (
            <div
              key={row.platformKey}
              className={cn(
                "grid gap-3 px-4 py-3.5 transition-colors duration-200 md:grid-cols-[minmax(0,1fr)_auto_auto] md:items-center md:gap-4",
                answered ? "bg-white/[0.03]" : "bg-transparent",
              )}
            >
              <div className="flex min-w-0 items-center gap-3">
                <BrandMark
                  brand={option?.brand}
                  label={row.label}
                  active={Boolean(answered)}
                />
                <div className="min-w-0">
                  <p className="truncate text-[14px] font-medium text-white/90">
                    {row.label}
                  </p>
                  <p className="truncate text-[12px] text-white/40">
                    {option?.hint ?? "Added by you"}
                  </p>
                </div>

                {row.isCustom ? (
                  <button
                    type="button"
                    onClick={() =>
                      onChange(
                        value.filter((item) => item.platformKey !== row.platformKey),
                      )
                    }
                    className="ml-auto grid size-6 shrink-0 place-items-center rounded-md text-white/35 transition-colors hover:bg-white/10 hover:text-white md:ml-0"
                  >
                    <X size={13} strokeWidth={2.4} />
                    <span className="sr-only">Remove {row.label}</span>
                  </button>
                ) : null}
              </div>

              <div className="flex items-center gap-2 md:w-[104px]">
                <span className="w-16 text-[11.5px] text-white/40 md:hidden">
                  In use
                </span>
                <Segmented
                  label={`${row.label} — currently in use`}
                  choices={USAGE_CHOICES}
                  value={row.currentUsage}
                  onChange={(next) => update(row.platformKey, { currentUsage: next })}
                />
              </div>

              <div className="flex items-center gap-2 md:w-[152px]">
                <span className="w-16 text-[11.5px] text-white/40 md:hidden">
                  Interest
                </span>
                <Segmented
                  label={`${row.label} — interest level`}
                  choices={INTEREST_CHOICES}
                  value={row.interestLevel}
                  onChange={(next) => update(row.platformKey, { interestLevel: next })}
                  tone="accent"
                />
              </div>
            </div>
          );
        })}
      </div>

      <div className="border-t border-white/[0.07] bg-white/[0.015] px-4 py-3">
        {adding ? (
          <div className="flex items-center gap-2">
            <span className="grid size-9 shrink-0 place-items-center rounded-xl border border-dashed border-white/20 text-white/40">
              <Plus size={15} strokeWidth={2.2} />
            </span>
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
              placeholder="Platform name, e.g. Teradata Vantage"
              aria-label="Add a platform"
              className="h-9 min-w-0 flex-1 bg-transparent text-[14px] text-white placeholder:text-white/30 focus:outline-none"
            />
          </div>
        ) : (
          <button
            type="button"
            onClick={() => {
              setAdding(true);
              requestAnimationFrame(() => inputRef.current?.focus());
            }}
            className="flex items-center gap-2 text-[13px] text-white/45 transition-colors hover:text-white/85"
          >
            <span className="grid size-6 place-items-center rounded-md border border-dashed border-white/20">
              <Plus size={13} strokeWidth={2.2} />
            </span>
            Add a platform we haven&rsquo;t listed
          </button>
        )}
      </div>
    </div>
  );
}
