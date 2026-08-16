/**
 * Does the company someone typed at sign-in match the workspace they belong to?
 *
 * This sits between a legitimate user and a lockout, so it errs towards letting
 * people in. Someone who works at "Northwind Traders Ltd" will type "Northwind"
 * and should not be turned away for it; the check exists to catch a person
 * signing in against the wrong workspace entirely, not to test their spelling.
 *
 * Its own module rather than living in the Server Action that uses it, because
 * a `"use server"` file may only export async functions — and because a rule
 * this easy to get subtly wrong should be testable on its own.
 */

/** Legal-form suffixes carry no distinguishing information and are dropped. */
const SUFFIXES = /\b(ltd|limited|inc|incorporated|llc|plc|gmbh|pty|corp|corporation|co)\b/g;

export function normaliseCompany(value: string): string {
  return value.toLowerCase().replace(SUFFIXES, "").replace(/[^a-z0-9]/g, "");
}

/**
 * Compare what was typed against the workspace's real name and its slug.
 *
 * The prefix rule is what makes "Acme" match "Acme Corporation". Three
 * characters is the floor: below that a prefix stops being evidence, since "AB"
 * would match "Abbott", "ABN Amro" and "Abacus" alike.
 *
 * It is matched in both directions, which knowingly accepts a false positive:
 * "Acme Rivals" typed against a workspace called "Acme" passes, because nothing
 * here can tell a meaningful extra word from a legal suffix. That is the right
 * way to be wrong. This check runs *after* the password has been verified, so
 * it is a second opinion rather than a credential — the cost of accepting a
 * near-miss is nil, and the cost of rejecting one is a user who cannot sign in
 * to their own account and does not know why.
 */
export function companyMatches(typed: string, name: string, slug: string): boolean {
  const a = normaliseCompany(typed);
  const b = normaliseCompany(name);
  if (!a || !b) return false;
  if (a === b || a === normaliseCompany(slug)) return true;
  return (a.length >= 3 && b.startsWith(a)) || (b.length >= 3 && a.startsWith(b));
}
