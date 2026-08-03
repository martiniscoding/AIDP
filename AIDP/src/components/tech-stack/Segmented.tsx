"use client";

import { cn } from "@/lib/cn";

/**
 * Compact single-choice control for the platform matrix.
 *
 * Buttons rather than radios so a client can clear an answer by pressing the
 * selected option again. "Not answered" is a real state here — it is what the
 * form starts in, and it means something different from a deliberate "No".
 * A radio group can be set but never unset without a third "clear" control.
 */
export function Segmented<T extends string>({
  label,
  choices,
  value,
  onChange,
  tone = "neutral",
}: {
  label: string;
  choices: readonly { value: T; label: string }[];
  value: string | null;
  onChange: (next: T | null) => void;
  tone?: "neutral" | "accent";
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="inline-flex rounded-lg border border-white/10 bg-white/[0.02] p-0.5"
    >
      {choices.map((choice) => {
        const isOn = value === choice.value;
        return (
          <button
            key={choice.value}
            type="button"
            aria-pressed={isOn}
            onClick={() => onChange(isOn ? null : choice.value)}
            className={cn(
              "min-w-11 rounded-[7px] px-2.5 py-1.5 text-[12px] font-medium",
              "transition-[background-color,color] duration-150",
              isOn
                ? tone === "accent"
                  ? "bg-royal text-white"
                  : "bg-white/[0.14] text-white"
                : "text-white/45 hover:text-white/80",
            )}
          >
            {choice.label}
          </button>
        );
      })}
    </div>
  );
}
