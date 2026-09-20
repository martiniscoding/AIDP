/**
 * Whether the technologies a design names are still supported, as the analyse
 * worker looked them up on endoflife.date (Workers/aidp/lifecycle.py).
 *
 * Facts with a source and a date, not a verdict: they say what the vendor
 * supports, not what the customer's standards require. Stored as JSON, so read
 * defensively — an entry without a name or a known status is dropped, dates are
 * accepted only as dates, and the link to the product's page is built here from
 * a checked id rather than taken from storage.
 *
 * Pure and dependency-free, so the report's client component can import it.
 */

export const LIFECYCLE_STATUSES = [
  "ended",
  "ending",
  "unchecked",
  "unknownVersion",
  "unversioned",
  "supported",
  "untracked",
] as const;
export type LifecycleStatus = (typeof LIFECYCLE_STATUSES)[number];

export type Technology = {
  /** As the design names it. */
  name: string;
  /** endoflife.date's product id, or null for a technology it does not track. */
  product: string | null;
  label: string;
  /** The version the design states, in its own words. */
  version: string | null;
  /** The release line that version belongs to. */
  cycle: string | null;
  status: LifecycleStatus;
  /** End of support, YYYY-MM-DD. */
  eol: string | null;
  /** Support has ended, with no date published. */
  eolNoDate: boolean;
  /** End of active support, YYYY-MM-DD; after it, security fixes only. */
  support: string | null;
  securityOnly: boolean;
  /** Paid extended support: until a date, or available with no date. */
  extendedSupport: string | true | null;
  lts: boolean;
  /** The newest release in this line. */
  latest: string | null;
  /** The product's newest release line. */
  current: string | null;
  /** The line to move to, when this one has ended or is ending. */
  upgradeTo: string | null;
  /** Release lines a less specific version could mean. */
  ambiguous: string[];
  section: number | null;
  sectionTitle: string;
  headingPath: string;
  /** The design's own words naming it, checked against the document. */
  quote: string | null;
  page: number | null;
  /** endoflife.date's page for the product. */
  link: string | null;
};

export type LifecycleView = {
  state: "complete" | "failed" | "skipped";
  /** "skipped" and "failed" say why there is nothing to show. */
  note: string | null;
  /** When the dates were looked up. The report states it, since they change. */
  checkedAt: string | null;
  source: string;
  /** Support ending within this many days counts as ending soon. */
  soonDays: number;
  technologies: Technology[];
  /** Technologies the model named that the design's own words did not bear out. */
  setAside: number;
};

const STATES = ["complete", "failed", "skipped"] as const;
const SLUG = /^[a-z0-9][a-z0-9._+-]*$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const REFUSALS = ["empty", "unknownSection", "missingQuote", "unverified", "outsideSection"];

function text(value: unknown, limit: number): string {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

function integer(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function count(value: unknown): number {
  return typeof value === "number" && value > 0 ? Math.floor(value) : 0;
}

function day(value: unknown): string | null {
  return typeof value === "string" && DAY.test(value) && !Number.isNaN(Date.parse(value))
    ? value
    : null;
}

function instant(value: unknown): string | null {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : null;
}

export function readLifecycle(value: unknown): LifecycleView | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const state = STATES.find((candidate) => candidate === raw.state);
  if (!state) return null;

  const technologies = (Array.isArray(raw.technologies) ? raw.technologies : []).flatMap(
    (item): Technology[] => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const entry = item as Record<string, unknown>;
      const name = text(entry.name, 120);
      const status = LIFECYCLE_STATUSES.find((candidate) => candidate === entry.status);
      if (!name || !status) return [];

      const productText = text(entry.product, 100);
      const product = productText && SLUG.test(productText) ? productText : null;
      const extended = entry.extendedSupport === true ? true : day(entry.extendedSupport);
      return [
        {
          name,
          product,
          label: text(entry.label, 120) || name,
          version: text(entry.version, 60) || null,
          cycle: text(entry.cycle, 40) || null,
          // A technology with no product id was never looked up, whatever is stored.
          status: product ? status : "untracked",
          eol: day(entry.eol),
          eolNoDate: entry.eolNoDate === true,
          support: day(entry.support),
          securityOnly: entry.securityOnly === true,
          extendedSupport: extended,
          lts: entry.lts === true,
          latest: text(entry.latest, 60) || null,
          current: text(entry.current, 40) || null,
          upgradeTo: text(entry.upgradeTo, 40) || null,
          ambiguous: (Array.isArray(entry.ambiguous) ? entry.ambiguous : [])
            .map((cycle) => text(cycle, 40))
            .filter(Boolean)
            .slice(0, 8),
          section: integer(entry.section),
          sectionTitle: text(entry.sectionTitle, 300),
          headingPath: text(entry.headingPath, 1000),
          quote: text(entry.quote, 1000) || null,
          page: integer(entry.page),
          link: product ? `https://endoflife.date/${product}` : null,
        },
      ];
    },
  );
  // What needs acting on first; the stored order is not trusted.
  technologies.sort(
    (a, b) =>
      LIFECYCLE_STATUSES.indexOf(a.status) - LIFECYCLE_STATUSES.indexOf(b.status) ||
      a.label.localeCompare(b.label),
  );

  const dropped =
    raw.dropped && typeof raw.dropped === "object" && !Array.isArray(raw.dropped)
      ? (raw.dropped as Record<string, unknown>)
      : {};

  return {
    state,
    note: text(raw.note, 1000) || null,
    checkedAt: instant(raw.checkedAt),
    source: text(raw.source, 100) || "endoflife.date",
    soonDays: count(raw.soonDays) || 365,
    technologies,
    setAside: REFUSALS.reduce((sum, reason) => sum + count(dropped[reason]), 0),
  };
}

/** A day, the same on the server and in the browser — no locale or zone to disagree over. */
export function formatDay(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** One plain sentence or two on what a technology's support status means. */
export function describe(technology: Technology): string {
  const t = technology;
  const move = t.upgradeTo ? ` Move to the ${t.upgradeTo} line.` : "";
  const extended =
    t.extendedSupport === true
      ? " Paid extended support is available."
      : t.extendedSupport
        ? ` Paid extended support runs until ${formatDay(t.extendedSupport)}.`
        : "";
  const last = t.latest && t.cycle ? ` The last release in the ${t.cycle} line is ${t.latest}.` : "";
  const security =
    t.securityOnly && t.support ? ` Security fixes only since ${formatDay(t.support)}.` : "";

  switch (t.status) {
    case "ended":
      return (
        (t.eol ? `Support ended ${formatDay(t.eol)}.` : "Support has ended.") +
        extended +
        last +
        move
      );
    case "ending":
      return `Support ends ${t.eol ? formatDay(t.eol) : "soon"}.${security}${extended}${move}`;
    case "supported":
      return (
        (t.eol ? `Supported until ${formatDay(t.eol)}.` : "Supported, with no end date announced.") +
        security +
        (t.latest ? ` Latest release in this line: ${t.latest}.` : "")
      );
    case "unversioned":
      return `The design does not say which version.${t.current ? ` The current release line is ${t.current};` : ""} confirm the version in use.`;
    case "unknownVersion":
      return t.ambiguous.length > 0
        ? `The design says ${t.version}, which could be any of ${t.ambiguous.join(", ")}. State the exact version.`
        : `Version ${t.version ?? "stated"} is not among the published release lines. Confirm it.`;
    case "unchecked":
      return "Its support dates could not be fetched on this run.";
    case "untracked":
      return "No public support data; confirm with the vendor.";
  }
}
