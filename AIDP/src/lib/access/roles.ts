/**
 * Who may do what.
 *
 * Three tiers, and they answer different questions:
 *
 *   platform admin — operates the product. Sees every organisation's people and
 *                    spend, and none of their documents.
 *   owner          — the customer's own administrator ("sub-admin"). Admits and
 *                    removes their colleagues, sees their organisation's spend.
 *   member         — an employee. Works in the product.
 *
 * The point of this file is that role strings are compared in exactly one
 * place. Scattering `role === "owner"` through pages is how an authorisation
 * bug gets written: the check drifts in one branch and nothing fails loudly.
 */

export const OWNER = "owner";
export const MEMBER = "member";

export type OrgRole = typeof OWNER | typeof MEMBER;

/**
 * Normalise a stored role.
 *
 * "consultant" and "viewer" predate this model and exist in live rows. They
 * were never owner-equivalent, so they land on member — the safe direction. A
 * role nobody recognises lands there too: an unknown string must never be read
 * as an escalation.
 */
export function toRole(stored: string | null | undefined): OrgRole {
  return stored === OWNER ? OWNER : MEMBER;
}

export function isOwner(stored: string | null | undefined): boolean {
  return toRole(stored) === OWNER;
}

export const ROLE_LABEL: Record<OrgRole, string> = {
  [OWNER]: "Administrator",
  [MEMBER]: "Member",
};

export const ROLE_BLURB: Record<OrgRole, string> = {
  [OWNER]:
    "Can admit and remove colleagues, and see what the organisation is spending.",
  [MEMBER]: "Can upload documents, run assessments, and record decisions.",
};
