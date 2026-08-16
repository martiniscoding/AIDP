import Link from "next/link";
import { redirect } from "next/navigation";
import { EyeOff } from "lucide-react";
import { Logo } from "@/components/ui/Logo";
import { prisma } from "@/lib/prisma";
import { currentUser } from "@/lib/access/gate";
import { SignOutButton } from "../dashboard/SignOutButton";

/**
 * The operator's console.
 *
 * Separate from /dashboard because it is a different product for a different
 * person: the operator has no organisation of their own to work in, and the
 * customer-facing navigation would be meaningless to them here.
 *
 * The guard is a redirect rather than a refusal message. Someone who is not an
 * operator has no business knowing this route exists, and a "you are not
 * allowed" page confirms that it does.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  if (!user) redirect("/sign-in");
  if (!user.isPlatformAdmin) redirect("/dashboard");

  // A dedicated operator account belongs to no company, so offering them "My
  // workspace" would be a link to a refusal. An operator who also runs a
  // customer workspace has a membership, and keeps the link.
  const hasWorkspace = (await prisma.membership.count({ where: { userId: user.id } })) > 0;

  return (
    <div className="min-h-svh">
      <header className="sticky top-0 z-50 border-b border-white/[0.08] bg-ink-900/80 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-6 px-6">
          <Logo href="/admin" />
          <span className="rounded-full border border-royal-mid/35 bg-royal/[0.12] px-2.5 py-1 text-[11px] font-medium tracking-wide text-royal-soft">
            Operator
          </span>

          <nav className="hidden items-center gap-1 sm:flex">
            <Link
              href="/admin"
              className="rounded-full px-3 py-1.5 text-[13.5px] text-white/55 transition-colors hover:bg-white/[0.06] hover:text-white"
            >
              Companies
            </Link>
            {hasWorkspace && (
              <Link
                href="/dashboard"
                className="rounded-full px-3 py-1.5 text-[13.5px] text-white/55 transition-colors hover:bg-white/[0.06] hover:text-white"
              >
                My workspace
              </Link>
            )}
          </nav>

          <div className="ml-auto flex items-center gap-3">
            <p className="hidden text-[12.5px] text-white/45 sm:block">{user.email}</p>
            <SignOutButton />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-10">
        {/* Stated once, at the top of every page here. The boundary is enforced
            in src/lib/access/platform.ts — no query in this console selects a
            document title, let alone its contents. */}
        <p className="mb-8 flex items-center gap-2 rounded-xl border border-white/[0.08] bg-white/[0.02] px-3.5 py-2.5 text-[12.5px] text-white/40">
          <EyeOff size={14} className="shrink-0 text-white/30" />
          You can see companies, their people, and their usage. Customer
          documents and assessment results are not visible from here.
        </p>
        {children}
      </main>
    </div>
  );
}
