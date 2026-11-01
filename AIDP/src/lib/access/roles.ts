/**
 * Who may do what.
 *
 * Four tiers, and they answer different questions:
 *
 *   platform admin — operates the product. Sees every organisation's people and
 *                    spend, and none of their documents.
 *   owner          — the customer's own administrator ("sub-admin"). Admits and
 *                    removes their colleagues, sees their organisation's spend.
 *   architect      — decides what happens to a submission once it has been
 *                    reviewed. The brief routes reports to "an assigned
 *                    architect", which means nothing unless some people are
 *                    architects and others are not.
 *   member         — an employee. Submits work and reviews findings on it.
 *
 * The point of this file is that role strings are compared in exactly one
 * place. Scattering `role === "owner"` through pages is how an authorisation
 * bug gets written: the check drifts in one branch and nothing fails loudly.
 */

export const OWNER = "owner";
export const ARCHITECT = "architect";
export const MEMBER = "member";

export type OrgRole = typeof OWNER | typeof ARCHITECT | typeof MEMBER;

/** Most authority first. Used wherever roles are offered or compared. */
export const ROLES = [OWNER, ARCHITECT, MEMBER] as const;

/**
 * Normalise a stored role.
 *
 * "consultant" and "viewer" predate this model and exist in live rows. They
 * were never owner-equivalent, so they land on member — the safe direction. A
 * role nobody recognises lands there too: an unknown string must never be read
 * as an escalation.
 */
export function toRole(stored: string | null | undefined): OrgRole {
  if (stored === OWNER) return OWNER;
  if (stored === ARCHITECT) return ARCHITECT;
  return MEMBER;
}

export function isOwner(stored: string | null | undefined): boolean {
  return toRole(stored) === OWNER;
}

export const ROLE_LABEL: Record<OrgRole, string> = {
  [OWNER]: "Administrator",
  [ARCHITECT]: "Architect",
  [MEMBER]: "Member",
};

export const ROLE_BLURB: Record<OrgRole, string> = {
  [OWNER]:
    "Can admit and remove colleagues, curate the standards, and see what the organisation is spending.",
  [ARCHITECT]:
    "Everything a member can do, and decides what happens to a submission once it has been reviewed — approve it, send it back, or take it to the board.",
  [MEMBER]:
    "Can submit designs for assessment and review findings. Cannot change the standards, and cannot decide what happens to a submission.",
};

/**
 * May this role resolve a submission — approve it, reject it, send it back, or
 * escalate it to the board?
 *
 * The architect's whole reason for existing. The brief routes a finished report
 * to "an assigned architect", and an assignment means nothing while anyone in
 * the workspace can record the outcome themselves; a submission that may reach
 * a review board is not something any employee should be able to wave through.
 *
 * An administrator can too. They are the customer's own authority over the
 * workspace, and a company whose only architect is on leave must not be unable
 * to close anything — the alternative is work piling up behind one person with
 * no way in.
 *
 * Note what this is *not*: it is not permission to rule on your own submission.
 * Nobody has that, an administrator least of all, and the check lives beside
 * the work rather than beside the permission — see `ownSubmission` in
 * src/lib/ingest/outcomes.ts.
 */
export function canDecideSubmissions(stored: string | null | undefined): boolean {
  const role = toRole(stored);
  return role === OWNER || role === ARCHITECT;
}

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

/**
 * May this role install the organisation's own model key?
 *
 * Owner only, and a separate question from the two above even though it has the
 * same answer today. A model key is the company's money and the company's
 * contract with a provider: whoever sets it decides what every assessment costs
 * and which vendor sees the documents. An employee submitting a design must not
 * be able to point the engine at a model of their choosing — or at their
 * personal account — on the way to being judged by it.
 *
 * Named after the policy for the same reason `canManageStandards` is: a future
 * "billing contact" who may set the key but not curate the standards would
 * change this line and nothing else.
 */
export function canManageCredentials(stored: string | null | undefined): boolean {
  return isOwner(stored);
}
