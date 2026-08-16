/**
 * The four states a person can be in on a customer's roster.
 *
 * Split into its own module with no imports so a Client Component can render
 * the labels without pulling Prisma into the browser bundle.
 */

export const ROSTER_STATUSES = ["imported", "allowed", "active", "revoked"] as const;

export type RosterStatus = (typeof ROSTER_STATUSES)[number];

export function isRosterStatus(value: string): value is RosterStatus {
  return (ROSTER_STATUSES as readonly string[]).includes(value);
}

/**
 * Whether this state lets someone through the door.
 *
 * "imported" is the state that matters here. A spreadsheet of two hundred
 * employees is a list of people who *exist*, not a list of people who have been
 * admitted, and reading it as the latter would hand the product to everyone on
 * the payroll the moment the file was parsed.
 */
export function grantsAccess(status: string): boolean {
  return status === "allowed" || status === "active";
}

export const STATUS_META: Record<
  RosterStatus,
  { label: string; blurb: string; tone: "neutral" | "good" | "warn" | "off" }
> = {
  imported: {
    label: "Not admitted",
    blurb: "On the list, with no access. Loaded from a file or typed in.",
    tone: "neutral",
  },
  allowed: {
    label: "Invited",
    blurb: "Admitted, and has not signed in yet.",
    tone: "warn",
  },
  active: {
    label: "Active",
    blurb: "Admitted, with an account.",
    tone: "good",
  },
  revoked: {
    label: "Revoked",
    blurb: "Access withdrawn. Kept on the list for the record.",
    tone: "off",
  },
};
