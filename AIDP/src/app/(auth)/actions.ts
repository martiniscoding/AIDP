"use server";

import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { NoAccess, currentUser, requireAccess } from "@/lib/access/gate";
import { companyMatches } from "@/lib/access/company-name";

/**
 * The check that runs immediately after a password is accepted.
 *
 * Better Auth's job ends at "this password matches this account". Two questions
 * remain, and both belong here rather than in the credential check:
 *
 *   1. Is this person still admitted? A revoked employee's password is still
 *      correct — nothing about revocation invalidates it — so authentication
 *      succeeds and admission has to be asked separately.
 *
 *   2. Did they name the right company? Employees sign in with their
 *      workspace's name alongside their credentials, so a person who has been
 *      handed the wrong details finds out here rather than after landing in a
 *      workspace they did not expect.
 *
 * Running *after* sign-in rather than before is deliberate. A pre-flight check
 * on an email address is an account-enumeration oracle: anyone could ask
 * whether a given person works at a given company and get a truthful answer
 * without any credentials at all. Here, the caller has already proved they hold
 * the password, so nothing is disclosed that they did not already know.
 *
 * A failed check signs them out, so a rejected attempt leaves no usable session
 * behind.
 */

/** `redirectTo` is where this account belongs once it is through — a customer
 *  goes to their dashboard, an operator to the console. */
export type WorkspaceCheck = { ok: boolean; message?: string; redirectTo?: string };

async function signOut(): Promise<void> {
  try {
    await auth.api.signOut({ headers: await headers() });
  } catch {
    // The session may already be gone. Nothing to undo.
  }
}

export async function verifyWorkspace(company: string): Promise<WorkspaceCheck> {
  const user = await currentUser();
  if (!user) {
    await signOut();
    return { ok: false, message: "Could not sign you in." };
  }

  // An operator signs in to their console, full stop.
  //
  // Decided here, before any workspace is looked up, because the answer must
  // not depend on what memberships happen to exist. It did once: a stray
  // membership on the operator's account made `requireAccess` succeed, which
  // sent the sign-in down the customer path and demanded a company name the
  // account does not have — locking the operator out with an error about a
  // field that could never be right for them.
  //
  // An operator who also runs a workspace reaches it from the console's own
  // navigation, which is a click, rather than through a rule that has to guess
  // which of their two roles they meant.
  if (user.isPlatformAdmin) return { ok: true, redirectTo: "/admin" };

  let access;
  try {
    access = await requireAccess();
  } catch (error) {
    await signOut();
    if (error instanceof NoAccess) return { ok: false, message: error.message };
    return { ok: false, message: "Could not sign you in." };
  }

  // Required here rather than in the form, because the form cannot know which
  // kind of account is signing in until the password has been checked. An
  // operator legitimately leaves it blank; anyone with a workspace must name it.
  const typed = company.trim();
  if (!typed) {
    await signOut();
    return { ok: false, message: "Enter your company name." };
  }

  if (!companyMatches(typed, access.organisation.name, access.organisation.slug)) {
    await signOut();
    // Deliberately does not name the workspace they *are* in. Confirming that
    // would hand an attacker who has a working password the org's real name.
    return {
      ok: false,
      message: "That company name does not match this account. Check it and try again.",
    };
  }

  return { ok: true, redirectTo: "/dashboard" };
}
