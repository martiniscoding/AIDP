"use client";

import { useId } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/cn";

type SelectProps = {
  label: string;
  error?: string;
  placeholder?: string;
  options: readonly string[];
  /** Leading glyph inside the control, matching Field. */
  icon?: React.ReactNode;
  className?: string;
} & React.SelectHTMLAttributes<HTMLSelectElement>;

/**
 * Native <select> deliberately — it gets keyboard behaviour, type-ahead, and
 * the platform picker on mobile for free, which a custom listbox would have to
 * rebuild. Only the chrome is restyled to match Field.
 */
export function Select({
  label,
  error,
  placeholder,
  options,
  icon,
  className,
  value,
  ...props
}: SelectProps) {
  const autoId = useId();
  const id = props.id ?? autoId;

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label htmlFor={id} className="text-[13px] font-medium text-ink/78">
        {label}
      </label>

      <div className="relative">
        <select
          id={id}
          value={value}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          className={cn(
            "peer h-12 w-full appearance-none rounded-xl border bg-canvas-sunk/60 px-3.5 pr-10 text-[15px]",
            "transition-[border-color,box-shadow,background-color] duration-200 hover:border-line-strong focus:outline-none",
            icon ? "pl-11" : null,
            value ? "text-ink" : "text-ink/62",
            error
              ? "border-danger-line focus:border-danger focus:shadow-[0_0_0_3px_rgba(190,18,60,0.14)]"
              : "border-line focus:border-royal focus:shadow-[0_0_0_3px_rgba(109,40,217,0.15)]",
          )}
          {...props}
        >
          {placeholder ? (
            <option value="" disabled>
              {placeholder}
            </option>
          ) : null}
          {options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>

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

        <ChevronDown
          size={16}
          aria-hidden="true"
          className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-ink/64"
        />
      </div>

      {error ? (
        <p id={`${id}-error`} className="text-[12.5px] text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
