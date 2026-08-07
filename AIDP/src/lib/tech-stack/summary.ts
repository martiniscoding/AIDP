import {
  BI_REPORTING,
  DATA_SOURCES,
  DATA_WAREHOUSING,
  PRIMARY_CLOUD,
  WORKLOADS,
  resolveOption,
  type Option,
} from "./catalog";
import type { AssessmentInput } from "./schema";

/**
 * The technology reference, rendered for the assessment prompt.
 *
 * Written to `TechAssessment.summary` on every save so the Python worker can
 * read one string instead of resolving catalog ids it has no copy of — see the
 * note on that column.
 *
 * Two constraints shape this. It goes into the prompt once per clause, across a
 * hundred-odd clauses per run, so it is capped hard and carries no prose. And
 * it is *context, never a rule*: the model is told it may sharpen a rationale
 * but may not decide a verdict on it, so this lists what the organisation runs
 * and nothing about what that ought to imply.
 */

const MAX_CHARS = 1200;

function labels(options: readonly Option[], ids: string[]): string[] {
  // A write-in is stored as the plain string the client typed and has no
  // catalog entry; `resolveOption` hands it back with its own label.
  return ids.map((id) => resolveOption(options, id).label);
}

function line(label: string, values: string[]): string | null {
  const kept = values.filter((v) => v && v.trim());
  return kept.length > 0 ? `${label}: ${kept.join(", ")}` : null;
}

export function renderTechSummary(input: AssessmentInput): string {
  const inUse = input.platforms
    .filter((p) => p.currentUsage === "yes")
    .map((p) => p.label);

  // High interest but not yet adopted — the distinction a reviewer cares about,
  // because a design proposing one is following a direction already set.
  const evaluating = input.platforms
    .filter((p) => p.currentUsage !== "yes" && p.interestLevel === "high")
    .map((p) => p.label);

  const parts = [
    line("Primary cloud", labels(PRIMARY_CLOUD, input.primaryCloud)),
    line("Data warehousing", labels(DATA_WAREHOUSING, input.dataWarehousing)),
    line("BI and reporting", labels(BI_REPORTING, input.biReporting)),
    line("Source systems", labels(DATA_SOURCES, input.dataSources)),
    line("Workload priorities", labels(WORKLOADS, input.workloads)),
    line("Platforms in use", inUse),
    line("Actively evaluating", evaluating),
  ].filter((p): p is string => p !== null);

  if (parts.length === 0) return "";

  const notes = input.additionalNotes.trim();
  if (notes) {
    // Free text, so it is the one part that can run long. Truncated rather than
    // dropped: the first sentence or two is usually the constraint that matters.
    parts.push(`Notes: ${notes.length > 300 ? `${notes.slice(0, 300)}…` : notes}`);
  }

  const rendered = parts.join("\n");
  return rendered.length > MAX_CHARS ? `${rendered.slice(0, MAX_CHARS)}…` : rendered;
}
