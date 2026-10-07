"use client";

import { cn } from "@/lib/cn";
import { SEVERITY_META, type Severity } from "@/lib/ingest/verdicts";

/**
 * How serious a finding is, on the collapsed row.
 *
 * Deliberately quieter than the verdict badge beside it. The badge is a
 * bordered, tinted chip; a second one would have two chips competing on every
 * row and nothing to show for it. A dot and a word is enough to scan a column
 * of eighty, and it leaves the badge as the loud thing.
 *
 * Only "Critical" takes a full-strength colour. If everything is emphasised
 * then the column reads as noise and the reviewer is back to reading every row
 * in order, which is the problem the tag exists to solve.
 */
export function SeverityTag({ severity }: { severity: Severity }) {
  const meta = SEVERITY_META[severity];
  return (
    <span
      title={meta.blurb}
      className={cn(
        "inline-flex items-center gap-1.5 font-medium",
        severity === "critical" && "text-danger",
        severity === "moderate" && "text-warn",
        severity === "check" && "text-ink/58 font-normal",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "size-1.5 rounded-full",
          severity === "critical" && "bg-danger",
          severity === "moderate" && "bg-warn",
          // Hollow, so "nobody has decided this yet" does not read as a third
          // severity sitting below moderate.
          severity === "check" && "border border-ink/35",
        )}
      />
      {meta.label}
    </span>
  );
}
