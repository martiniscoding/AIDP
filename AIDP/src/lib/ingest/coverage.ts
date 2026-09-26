/**
 * The parts of a design no standard covers, as the analyse worker recorded them
 * on a run (Workers/aidp/coverage.py).
 *
 * Every other section of a report answers "what does the design do about this
 * rule?". This answers the reverse — "what does the design do that no rule
 * speaks to?" — and names the standards that would. It is stored as JSON, so
 * it is read defensively here: a malformed entry is dropped, never guessed at.
 *
 * Pure and dependency-free, so the report's client component can import it.
 */

export type CoverageGap = {
  /** The design section's ordinal — the number the model was shown. */
  section: number;
  headingPath: string;
  title: string;
  pageStart: number | null;
  pageEnd: number | null;
  /** What the design does there, in the model's words. */
  what: string;
  /** The design's own words, checked against the document before it was kept. */
  quote: string;
  page: number | null;
};

export type StandardSuggestion = {
  title: string;
  /** What the standard should govern. */
  covers: string;
  /** Why this design shows it is needed. */
  why: string;
  /** The gap sections it would govern. */
  sections: number[];
};

export type CoverageView = {
  /** "skipped" and "failed" carry a note saying why there is nothing to show. */
  state: "complete" | "failed" | "skipped";
  note: string | null;
  model: string | null;
  /** How many sections of the design were read. */
  sectionsRead: number;
  /** Long sections were shortened to fit one reading. */
  truncated: boolean;
  gaps: CoverageGap[];
  suggestions: StandardSuggestion[];
  /**
   * Gaps and standards the model proposed that the checks refused: a quote not
   * in the section, a section already judged, or wording too generic to act on.
   * Every counter the worker records is summed, so a new refusal reason is
   * counted here the day it is added.
   */
  setAside: number;
};

const STATES = ["complete", "failed", "skipped"] as const;

function text(value: unknown, limit: number): string {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

function integer(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

export function readCoverage(value: unknown): CoverageView | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const state = STATES.find((candidate) => candidate === raw.state);
  if (!state) return null;

  const seen = new Set<number>();
  const gaps = (Array.isArray(raw.gaps) ? raw.gaps : []).flatMap((item): CoverageGap[] => {
    if (!item || typeof item !== "object") return [];
    const entry = item as Record<string, unknown>;
    const section = integer(entry.section);
    const quote = text(entry.quote, 1500);
    // A gap is only ever shown with the design's own words beside it.
    if (section === null || !quote || seen.has(section)) return [];
    seen.add(section);
    return [
      {
        section,
        headingPath: text(entry.headingPath, 1000),
        title: text(entry.title, 300),
        pageStart: integer(entry.pageStart),
        pageEnd: integer(entry.pageEnd),
        what: text(entry.what, 220),
        quote,
        page: integer(entry.page),
      },
    ];
  });

  const suggestions = (Array.isArray(raw.suggestions) ? raw.suggestions : []).flatMap(
    (item): StandardSuggestion[] => {
      if (!item || typeof item !== "object") return [];
      const entry = item as Record<string, unknown>;
      const title = text(entry.title, 200);
      const sections = [
        ...new Set(
          (Array.isArray(entry.sections) ? entry.sections : [])
            .map(integer)
            .filter((section): section is number => section !== null && seen.has(section)),
        ),
      ];
      // A suggestion that covers no reported gap has nothing on this page to
      // justify it.
      if (!title || sections.length === 0) return [];
      // Caps match Workers/aidp/coverage.py, which already cut these at a
      // sentence. A longer value means an older run, from before the caps.
      return [{ title, covers: text(entry.covers, 300), why: text(entry.why, 220), sections }];
    },
  );

  const dropped =
    raw.dropped && typeof raw.dropped === "object" && !Array.isArray(raw.dropped)
      ? (raw.dropped as Record<string, unknown>)
      : {};
  const setAside = Object.values(dropped).reduce<number>(
    (sum, count) => sum + (typeof count === "number" && count > 0 ? Math.floor(count) : 0),
    0,
  );

  return {
    state,
    note: text(raw.note, 1000) || null,
    model: text(raw.model, 200) || null,
    sectionsRead: integer(raw.sections) ?? 0,
    truncated: raw.truncated === true,
    gaps,
    suggestions,
    setAside,
  };
}
