"use client";

import { useId, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { cn } from "@/lib/cn";

type FieldProps = {
  label: string;
  error?: string;
  hint?: React.ReactNode;
  /** Rendered to the right of the label, e.g. a "Forgot password?" link. */
  labelAction?: React.ReactNode;
  /** Leading glyph inside the input. Pass a 16px lucide icon. */
  icon?: React.ReactNode;
  className?: string;
} & React.InputHTMLAttributes<HTMLInputElement>;

export function Field({
  label,
  error,
  hint,
  labelAction,
  icon,
  className,
  type = "text",
  ...props
}: FieldProps) {
  const autoId = useId();
  const id = props.id ?? autoId;
  const [revealed, setRevealed] = useState(false);

  // The reveal toggle swaps the rendered type, so `type` can't just be spread.
  const isPassword = type === "password";
  const inputType = isPassword && revealed ? "text" : type;

  const describedBy = [
    error ? `${id}-error` : null,
    hint ? `${id}-hint` : null,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="text-[13px] font-medium text-ink/78">
          {label}
        </label>
        {labelAction}
      </div>

      <div className="relative">
        <input
          id={id}
          type={inputType}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy || undefined}
          className={cn(
            "peer h-12 w-full rounded-xl border bg-canvas-sunk/60 px-3.5 text-[15px] text-ink",
            "placeholder:text-ink/58",
            "transition-[border-color,box-shadow,background-color] duration-200",
            "hover:border-line-strong focus:bg-card focus:outline-none",
            icon ? "pl-11" : null,
            isPassword ? "pr-11" : null,
            error
              ? "border-danger-line focus:border-danger focus:shadow-[0_0_0_3px_rgba(190,18,60,0.14)]"
              : "border-line focus:border-royal focus:shadow-[0_0_0_3px_rgba(109,40,217,0.15)]",
          )}
          {...props}
        />

        {/* After the input in source order so `peer-focus` can reach it. */}
        {icon ? (
          <span
            aria-hidden="true"
            className={cn(
              "pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 transition-colors duration-200",
              error
                ? "text-danger"
                : "text-ink/62 peer-focus:text-royal",
            )}
          >
            {icon}
          </span>
        ) : null}

        {isPassword ? (
          <button
            type="button"
            onClick={() => setRevealed((value) => !value)}
            aria-label={revealed ? "Hide password" : "Show password"}
            aria-pressed={revealed}
            // Not a tab stop: keyboard users move label → input → next field,
            // and an extra stop between every password field and the submit
            // button is friction for a control the mouse is there for.
            tabIndex={-1}
            className="absolute right-1.5 top-1/2 inline-flex size-9 -translate-y-1/2 items-center justify-center rounded-lg text-ink/62 transition-colors hover:bg-canvas-sunk hover:text-ink/84"
          >
            {revealed ? (
              <EyeOff size={16} aria-hidden="true" />
            ) : (
              <Eye size={16} aria-hidden="true" />
            )}
          </button>
        ) : null}
      </div>

      {error ? (
        <p id={`${id}-error`} className="text-[12.5px] text-danger">
          {error}
        </p>
      ) : hint ? (
        <div id={`${id}-hint`} className="text-[12.5px] text-ink/64">
          {hint}
        </div>
      ) : null}
    </div>
  );
}
