import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Logo } from "@/components/ui/Logo";
import { auth } from "@/lib/auth";
import { SignOutButton } from "./SignOutButton";

/**
 * Authenticated shell.
 *
 * The session check lives here rather than in each page so a new route under
 * /dashboard is private by default — the failure mode of the opposite
 * arrangement is a page that silently ships without a guard.
 */
export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth.api.getSession({ headers: await headers() });

  if (!session) {
    redirect("/sign-in");
  }

  const user = session.user;
  const initials =
    (user.name || user.email)
      .split(/[\s@.]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]!.toUpperCase())
      .join("") || "?";

  return (
    <div className="min-h-svh">
      <header className="sticky top-0 z-50 border-b border-white/[0.08] bg-ink-900/80 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-6 px-6">
          <Logo href="/dashboard" />

          <nav className="hidden items-center gap-1 sm:flex">
            <Link
              href="/dashboard"
              className="rounded-full px-3 py-1.5 text-[13.5px] text-white/55 transition-colors hover:bg-white/[0.06] hover:text-white"
            >
              Overview
            </Link>
            <Link
              href="/dashboard/tech-stack"
              className="rounded-full px-3 py-1.5 text-[13.5px] text-white/55 transition-colors hover:bg-white/[0.06] hover:text-white"
            >
              Technology reference
            </Link>
            <Link
              href="/dashboard/documents"
              className="rounded-full px-3 py-1.5 text-[13.5px] text-white/55 transition-colors hover:bg-white/[0.06] hover:text-white"
            >
              Standards library
            </Link>
          </nav>

          <div className="ml-auto flex items-center gap-3">
            <div className="hidden text-right sm:block">
              <p className="text-[13px] leading-tight text-white/85">
                {user.name || user.email}
              </p>
              <p className="text-[11.5px] leading-tight text-white/35">
                {(user as { company?: string }).company ?? "Client"}
              </p>
            </div>
            <span
              aria-hidden="true"
              className="grid size-9 place-items-center rounded-full border border-white/15 bg-white/[0.06] text-[12px] font-semibold text-white/80"
            >
              {initials}
            </span>
            <SignOutButton />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-10">{children}</main>
    </div>
  );
}
