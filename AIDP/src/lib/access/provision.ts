import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { MIN_PASSWORD } from "./password-policy";

// Re-exported so server-side callers have one place to import from.
export { MIN_PASSWORD };

/**
 * Creating an employee's account on their behalf.
 *
 * The self-service path is that an admitted person registers themselves and
 * chooses their own password. This is the other path, and enterprises ask for
 * it constantly: the administrator issues credentials and hands them over,
 * because their staff are not going to be sent to a sign-up form.
 *
 * Why not `auth.api.signUpEmail`
 * ------------------------------
 * Because it signs the new user *in*. The `nextCookies` plugin turns the
 * resulting Set-Cookie into a real cookie on the response, so an administrator
 * creating five accounts would end up logged in as the fifth. Going through
 * `auth.$context` instead uses the same password hashing and the same tables
 * without ever minting a session.
 *
 * The hash is Better Auth's own (`ctx.password.hash`), not a hand-rolled one,
 * so an account created here is indistinguishable from a self-registered one
 * and verifies through exactly the same code path at sign-in.
 */

export class ProvisionRefused extends Error {}


function assertUsable(password: string): void {
  if (password.length < MIN_PASSWORD) {
    throw new ProvisionRefused(`A password needs at least ${MIN_PASSWORD} characters.`);
  }
  if (password.length > 200) {
    throw new ProvisionRefused("That password is too long.");
  }
}

/**
 * Create an account, or set the password on one that already exists.
 *
 * Returns the user id either way, so the caller can link it to a roster row.
 * Idempotent by design: an administrator who presses the button twice, or who
 * issues credentials to somebody who had already signed up, resets the password
 * rather than failing — which is what they meant both times.
 */
export async function provisionAccount(input: {
  email: string;
  name: string;
  company: string;
  password: string;
}): Promise<{ userId: string; created: boolean }> {
  assertUsable(input.password);

  const email = input.email.trim().toLowerCase();
  const ctx = await auth.$context;
  const hash = await ctx.password.hash(input.password);

  const existing = await prisma.user.findUnique({
    where: { email },
    select: { id: true },
  });

  if (existing) {
    // `updatePassword` writes to the credential account row, creating it if the
    // person somehow has a user with no password (a state only reachable if a
    // social provider is added later).
    await ctx.internalAdapter.updatePassword(existing.id, hash);
    return { userId: existing.id, created: false };
  }

  // `company`, `country` and `phone` are NOT NULL on the user table because the
  // sign-up form collects them. An account created from the People page has
  // none of that, so the organisation's own name stands in for the company and
  // the rest are left blank for the person to fill in.
  const user = await ctx.internalAdapter.createUser({
    email,
    name: input.name.trim() || email.split("@")[0]!,
    emailVerified: false,
    company: input.company,
    country: "",
    phone: "",
  });

  await ctx.internalAdapter.linkAccount({
    userId: user.id,
    providerId: "credential",
    accountId: user.id,
    password: hash,
  });

  return { userId: user.id, created: true };
}
