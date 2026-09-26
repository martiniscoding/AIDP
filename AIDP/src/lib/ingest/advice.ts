/**
 * Improvements to a design, as the analyse worker suggested them on a run
 * (Workers/aidp/advice.py).
 *
 * The findings say whether a design meets the standards; this says what an
 * experienced reviewer would still ask of it. It is advice, not a verdict, and
 * it is stored as JSON — so it is read defensively here: a malformed entry is
 * dropped, never guessed at, and a suggestion to change what the design says is
 * only ever shown beside the design's own words.
 *
 * Pure and dependency-free, so the report's client component can import it.
 */

export const ADVICE_PRIORITIES = ["high", "medium", "low"] as const;
export type AdvicePriority = (typeof ADVICE_PRIORITIES)[number];

export const ADVICE_CATEGORIES = [
  "security",
  "resilience",
  "data",
  "integration",
  "operations",
  "performance",
  "cost",
  "maintainability",
  "documentation",
  "other",
] as const;
export type AdviceCategory = (typeof ADVICE_CATEGORIES)[number];

export const CATEGORY_LABEL: Record<AdviceCategory, string> = {
  security: "Security",
  resilience: "Resilience",
  data: "Data",
  integration: "Integration",
  operations: "Operations",
  performance: "Performance",
  cost: "Cost",
  maintainability: "Maintainability",
  documentation: "Documentation",
  other: "Other",
};

export type Suggestion = {
  title: string;
  /** "improve" changes something the design states; "add" supplies something missing. */
  kind: "improve" | "add";
  category: AdviceCategory;
  priority: AdvicePriority;
  /** The design section's ordinal — the number the model was shown. */
  section: number;
  /** The component, technology or flow it concerns, as the design names it. Null on older runs. */
  component: string | null;
  sectionTitle: string;
  headingPath: string;
  pageStart: number | null;
  pageEnd: number | null;
  /** The design's own words, checked against the document before they were kept. */
  quote: string | null;
  page: number | null;
  recommendation: string;
  why: string;
  /** Clause references of failing findings this would help resolve. */
  clauses: string[];
};

export type AdviceView = {
  /** "skipped" and "failed" carry a note saying why there is nothing to show. */
  state: "complete" | "failed" | "skipped";
  note: string | null;
  model: string | null;
  sectionsRead: number;
  /** Long sections were shortened to fit one reading. */
  truncated: boolean;
  suggestions: Suggestion[];
  /** Suggestions the checks refused: no section, no named component, words the design
   * does not contain, generic filler, or a repeat of one already kept. */
  setAside: number;
  /** Suggestions beyond the number kept. */
  overLimit: number;
  /**
   * "cache" when this run reused the suggestions worked out earlier for the same
   * design against the same standards; "model" when they were asked for on it.
   */
  source: "model" | "cache";
  /** When the model wrote these suggestions (ISO). Null on runs from before it was recorded. */
  generatedAt: string | null;
  /** A fresh set has been asked for and is being worked out; these stay until it lands. */
  refreshing: boolean;
  /** Why the last request for a fresh set failed. The suggestions shown are the earlier ones. */
  refreshError: string | null;
};

const STATES = ["complete", "failed", "skipped"] as const;

/** Dropped counts that mean "could not be tied to the design", as opposed to "too many". */
const REFUSALS = [
  "empty",
  "unknownSection",
  "unanchored",
  "missingQuote",
  "unverified",
  "outsideSection",
  // Said nothing a reviewer could act on, and repeats of a suggestion already
  // kept. Both were refusals the worker counted and the report did not, so the
  // number it showed as set aside was short by however many it dropped here.
  "generic",
  "duplicate",
];

function text(value: unknown, limit: number): string {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

function integer(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function count(value: unknown): number {
  return typeof value === "number" && value > 0 ? Math.floor(value) : 0;
}

function isoDate(value: unknown): string | null {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : null;
}

export function readAdvice(value: unknown): AdviceView | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const state = STATES.find((candidate) => candidate === raw.state);
  if (!state) return null;

  const seen = new Set<string>();
  const suggestions = (Array.isArray(raw.suggestions) ? raw.suggestions : []).flatMap(
    (item): Suggestion[] => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const entry = item as Record<string, unknown>;
      const title = text(entry.title, 200);
      const recommendation = text(entry.recommendation, 1500);
      const section = integer(entry.section);
      if (!title || !recommendation || section === null) return [];

      const kind = entry.kind === "add" ? "add" : "improve";
      const quote = text(entry.quote, 1500) || null;
      // A change to what the design says is only shown beside where it says it.
      if (kind === "improve" && !quote) return [];

      const key = title.toLowerCase();
      if (seen.has(key)) return [];
      seen.add(key);

      return [
        {
          title,
          kind,
          category: ADVICE_CATEGORIES.find((c) => c === entry.category) ?? "other",
          priority: ADVICE_PRIORITIES.find((p) => p === entry.priority) ?? "medium",
          section,
          component: text(entry.component, 200) || null,
          sectionTitle: text(entry.sectionTitle, 300),
          headingPath: text(entry.headingPath, 1000),
          pageStart: integer(entry.pageStart),
          pageEnd: integer(entry.pageEnd),
          quote,
          page: integer(entry.page),
          recommendation,
          why: text(entry.why, 1000),
          clauses: [
            ...new Set(
              (Array.isArray(entry.clauses) ? entry.clauses : [])
                .map((clause) => text(clause, 300))
                .filter(Boolean),
            ),
          ],
        },
      ];
    },
  );
  // Highest priority first; Array.prototype.sort is stable, so the worker's order
  // holds within a priority.
  suggestions.sort(
    (a, b) => ADVICE_PRIORITIES.indexOf(a.priority) - ADVICE_PRIORITIES.indexOf(b.priority),
  );

  const dropped =
    raw.dropped && typeof raw.dropped === "object" && !Array.isArray(raw.dropped)
      ? (raw.dropped as Record<string, unknown>)
      : {};

  return {
    state,
    note: text(raw.note, 1000) || null,
    model: text(raw.model, 200) || null,
    sectionsRead: integer(raw.sections) ?? 0,
    truncated: raw.truncated === true,
    suggestions,
    setAside: REFUSALS.reduce((sum, reason) => sum + count(dropped[reason]), 0),
    overLimit: count(dropped.overLimit),
    source: raw.source === "cache" ? "cache" : "model",
    generatedAt: isoDate(raw.generatedAt),
    refreshing: raw.refreshing === true,
    refreshError: text(raw.refreshError, 1000) || null,
  };
}
