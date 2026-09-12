/**
 * The words for what a model can set aside when it reads a standard's rules.
 *
 * Kept apart from `rules.ts` so client components can import it without pulling
 * in the database client. The keys are the labels the worker writes — see
 * `LABELS` in Workers/aidp/parsing/rules.py — and must stay in step with it.
 */

export const LABEL_ORDER = [
  "process_rule",
  "reference",
  "guidance",
  "scope",
  "other",
  "furniture",
] as const;

export const LABEL_WORDS: Record<string, string> = {
  furniture: "Document furniture",
  scope: "Scope and introduction",
  reference: "Reference material",
  process_rule: "Rules about running the standard",
  guidance: "Guidance",
  other: "Other material",
};

export const LABEL_HINT: Record<string, string> = {
  furniture: "Cover, contents, revision history, approvals.",
  scope: "Purpose, scope, audience, how the document is organised.",
  reference: "Definitions, glossaries, classification tables and catalogues that rules point to.",
  process_rule:
    "Obligations on the people running the standard — exceptions, reviews, enforcement — rather than on a design.",
  guidance: "Advice and examples not attached to any one rule.",
  other: "Anything else, in the model's own words.",
};

/** A line that reads like an obligation. Mirrors `_OBLIGATION` in rules.py. */
export const OBLIGATION = /\b(?:must|shall|required|requires|prohibited|mandatory|may\s+not|never)\b/i;
