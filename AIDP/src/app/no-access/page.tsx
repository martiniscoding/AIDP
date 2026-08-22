import type { Metadata } from "next";
import { ShieldAlert } from "lucide-react";
import { SignOutButton } from "../dashboard/SignOutButton";

export const metadata: Metadata = { title: "No access" };

/**
 * Signed in, not admitted.
 *
 * A page rather than something the dashboard layout renders, because the
 * layout renders *concurrently with its page* — so a refusal drawn there races
 * whatever the page is doing, and the same request could redirect or throw
 * depending on which settled first. Redirecting here instead makes the outcome
 * the same every time.
 *
 * Deliberately a dead end with a sign-out button and no navigation: there is
 * nothing here for them until an administrator acts, and offering links they
 * cannot follow reads as a broken product rather than a closed door.
 */
export default async function NoAccessPage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string }>;
}) {
  const { reason } = await searchParams;

  const message =
    reason === "revoked"
      ? "Your access to this workspace has been withdrawn. Contact your administrator if you think that is a mistake."
      : reason === "no-organisation"
        ? "This account does not belong to a company workspace."
        : "Your administrator has not admitted you to this workspace yet. They can do that from the People page.";

  return (
    <div className="grid min-h-svh place-items-center px-6">
      <div className="w-full max-w-md rounded-2xl border border-line bg-card shadow-card p-8 text-center">
        <span className="mx-auto mb-5 grid size-12 place-items-center rounded-xl border border-warn-line bg-warn-tint text-warn">
          <ShieldAlert size={22} strokeWidth={1.8} />
        </span>
        <h1 className="font-display text-[20px] font-semibold tracking-tight text-ink">
          No access to this workspace
        </h1>
        <p className="mt-2.5 text-[13.5px] leading-relaxed text-ink/68">{message}</p>
        <div className="mt-6 flex items-center justify-center gap-3">
          <SignOutButton />
        </div>
      </div>
    </div>
  );
}
