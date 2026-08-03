import { PLATFORMS, WORKLOADS } from "./catalog";

/**
 * Wire shape and validation for the assessment form.
 *
 * The client sends a plain object rather than FormData: three of the five
 * sections are multi-select and section 4 is a matrix, all of which would have
 * to be flattened into repeated keys and parsed back out. A typed object keeps
 * one definition of the payload for both sides of the boundary.
 *
 * Validation runs on the server regardless of what the client checked. Server
 * Actions are reachable by direct POST, so client-side checks are a courtesy
 * to the user, not a control.
 */

export type PlatformInput = {
  platformKey: string;
  label: string;
  isCustom: boolean;
  currentUsage: string | null;
  interestLevel: string | null;
};

export type AssessmentInput = {
  companyName: string;
  primaryContact: string;
  roleTitle: string;
  dateCompleted: string;
  dataSources: string[];
  dataWarehousing: string[];
  biReporting: string[];
  primaryCloud: string[];
  workloads: string[];
  platforms: PlatformInput[];
  additionalNotes: string;
  /** Submit marks the assessment complete; save leaves it a draft. */
  intent: "save" | "submit";
};

export type FieldErrors = Partial<Record<keyof AssessmentInput, string>>;

export type SaveResult =
  | { ok: true; status: string; savedAt: string }
  | { ok: false; message: string; errors: FieldErrors };

const LIMITS = {
  shortText: 200,
  notes: 4000,
  optionLabel: 120,
  listItems: 40,
  platforms: 24,
} as const;

const USAGE = new Set(["yes", "no"]);
const INTEREST = new Set(["high", "medium", "low"]);
const WORKLOAD_IDS = new Set(WORKLOADS.map((workload) => workload.id));
const CATALOG_PLATFORM_IDS = new Set(PLATFORMS.map((platform) => platform.id));

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/**
 * Normalise a multi-select answer: trim, drop blanks, de-duplicate
 * case-insensitively, and cap the length.
 *
 * De-duplication matters because a client can write in "Tableau" on a field
 * that already offers it as a catalog option — without folding those together
 * the same answer would be counted twice in any later aggregate.
 */
function list(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];

  for (const raw of value) {
    const item = text(raw, LIMITS.optionLabel);
    if (!item) continue;
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= LIMITS.listItems) break;
  }

  return out;
}

function platforms(value: unknown): PlatformInput[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: PlatformInput[] = [];

  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;

    const platformKey = text(entry.platformKey, LIMITS.optionLabel);
    const label = text(entry.label, LIMITS.optionLabel);
    if (!platformKey || !label || seen.has(platformKey)) continue;
    seen.add(platformKey);

    const usage = text(entry.currentUsage, 12).toLowerCase();
    const interest = text(entry.interestLevel, 12).toLowerCase();

    out.push({
      platformKey,
      label,
      // Trust the catalog, not the client, for what counts as custom.
      isCustom: !CATALOG_PLATFORM_IDS.has(platformKey),
      currentUsage: USAGE.has(usage) ? usage : null,
      interestLevel: INTEREST.has(interest) ? interest : null,
    });

    if (out.length >= LIMITS.platforms) break;
  }

  return out;
}

/** Coerce unknown input into a valid assessment, collecting field errors. */
export function parseAssessmentInput(raw: unknown): {
  value: AssessmentInput;
  errors: FieldErrors;
} {
  const input = (raw ?? {}) as Record<string, unknown>;
  const errors: FieldErrors = {};

  const value: AssessmentInput = {
    companyName: text(input.companyName, LIMITS.shortText),
    primaryContact: text(input.primaryContact, LIMITS.shortText),
    roleTitle: text(input.roleTitle, LIMITS.shortText),
    dateCompleted: text(input.dateCompleted, 10),
    dataSources: list(input.dataSources),
    dataWarehousing: list(input.dataWarehousing),
    biReporting: list(input.biReporting),
    primaryCloud: list(input.primaryCloud),
    // Section 3 is a fixed set, so anything unrecognised is dropped rather
    // than stored — these answers are compared across clients.
    workloads: list(input.workloads).filter((id) => WORKLOAD_IDS.has(id)),
    platforms: platforms(input.platforms),
    additionalNotes: text(input.additionalNotes, LIMITS.notes),
    intent: input.intent === "submit" ? "submit" : "save",
  };

  if (value.dateCompleted && !/^\d{4}-\d{2}-\d{2}$/.test(value.dateCompleted)) {
    value.dateCompleted = "";
  }

  // A draft is allowed to be blank — the client is expected to come back to it.
  // Only submission requires the two fields that identify whose stack this is.
  if (value.intent === "submit") {
    if (!value.companyName) errors.companyName = "Add the company name before submitting.";
    if (!value.primaryContact) {
      errors.primaryContact = "Add a primary contact before submitting.";
    }
  }

  return { value, errors };
}

/**
 * Per-section completion, used by the rail on the form and the card on the
 * dashboard. Sections 2–4 count as complete once each of their questions has
 * at least one answer; section 5 is genuinely optional and never blocks.
 */
export type SectionProgress = { id: string; label: string; done: boolean };

export function sectionProgress(input: {
  companyName: string;
  primaryContact: string;
  dataSources: string[];
  dataWarehousing: string[];
  biReporting: string[];
  primaryCloud: string[];
  workloads: string[];
  platforms: { currentUsage: string | null; interestLevel: string | null }[];
}): SectionProgress[] {
  return [
    {
      id: "client",
      label: "Client information",
      done: Boolean(input.companyName && input.primaryContact),
    },
    {
      id: "infrastructure",
      label: "Current data infrastructure",
      done:
        input.dataSources.length > 0 &&
        input.dataWarehousing.length > 0 &&
        input.biReporting.length > 0 &&
        input.primaryCloud.length > 0,
    },
    {
      id: "workloads",
      label: "Workload requirements",
      done: input.workloads.length > 0,
    },
    {
      id: "platforms",
      label: "Platform preferences",
      done: input.platforms.some(
        (platform) => platform.currentUsage || platform.interestLevel,
      ),
    },
  ];
}
