"use server";

import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { NoAccess, currentUser, requireAccess } from "@/lib/access/gate";

/**
 * The check that runs immediately after a password is accepted.
 *
 * Better Auth's job ends at "this password matches this account". Two things
 * are still unanswered, and both belong here rather than in the credential
 * check:
 *
 *   1. Is this person still admitted? A revoked employee's password is still
 *      correct — nothing about revocation invalidates it — so authentication
 *      succeeds and admission has to be asked separately.
 *
 *   2. Where do they belong? An operator has a console and no workspace;
 *      everybody else has a workspace, resolved from their email through the
 *      roster their administrator controls.
 *
 * Nobody is asked to name their company. Which company an address belongs to is
 * decided by an administrator admitting it, not by the person typing — asking
 * them to state it too added a field they could get wrong about a fact they do
 * not control.
 *
 * Running *after* sign-in rather than before is deliberate. A pre-flight check
 * on an email address is an account-enumeration oracle: anyone could ask
 * whether a given address is admitted anywhere and get a truthful answer with
 * no credentials at all. Here the caller has already proved they hold the
 * password, so nothing is disclosed that they did not already know.
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

export async function verifyWorkspace(): Promise<WorkspaceCheck> {
  const user = await currentUser();
  if (!user) {
    await signOut();
    return { ok: false, message: "Could not sign you in." };
  }

  // An operator signs in to their console, full stop.
  //
  // Decided before any workspace is looked up, so the answer cannot depend on
  // what memberships happen to exist. It did once: a stray membership on the
  // operator's account made `requireAccess` succeed and sent the sign-in down
  // the customer path instead.
  //
  // An operator who also runs a workspace reaches it from the console's own
  // navigation, which is a click, rather than through a rule that has to guess
  // which of their two roles they meant.
  if (user.isPlatformAdmin) return { ok: true, redirectTo: "/admin" };

  // Called for its refusal, not its return value: this is where a revoked or
  // never-admitted account is turned away, and where an admitted one gets
  // attached to the workspace that claimed its email.
  try {
    await requireAccess();
  } catch (error) {
    await signOut();
    if (error instanceof NoAccess) return { ok: false, message: error.message };
    return { ok: false, message: "Could not sign you in." };
  }

  return { ok: true, redirectTo: "/dashboard" };
}
