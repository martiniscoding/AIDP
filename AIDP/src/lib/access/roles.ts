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
    "Can admit and remove colleagues, curate the standards, and see what the organisation is spending.",
  [MEMBER]:
    "Can submit designs for assessment, review findings, and record decisions. Cannot change the standards.",
};

/**
 * May this role add, replace or retire the organisation's standards?
 *
 * Reference documents are not ordinary uploads. They are the rules every
 * assessment is measured against, so whoever controls them controls every
 * verdict the product will ever produce for this customer. An employee
 * submitting a design must not be able to quietly widen — or delete — the
 * standard they are about to be judged by.
 *
 * Submitted designs are the opposite case and stay open to every member: that
 * is the work they are here to do.
 *
 * Named after the policy rather than written as `role === OWNER` at each call
 * site, because it is a different question from "may they manage people" and
 * the two should be free to diverge — a future "standards editor" role would
 * change this line and nothing else.
 */
export function canManageStandards(stored: string | null | undefined): boolean {
  return isOwner(stored);
}
