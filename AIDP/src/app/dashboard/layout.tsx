import Link from "next/link";
import { Logo } from "@/components/ui/Logo";
import { requireWorkspace } from "@/lib/access/gate";
import { SignOutButton } from "./SignOutButton";

/**
 * Authenticated shell.
 *
 * The access check lives here rather than in each page so a new route under
 * /dashboard is private by default — the failure mode of the opposite
 * arrangement is a page that silently ships without a guard.
 *
 * It checks admission, not just authentication. A revoked employee can still be
 * holding a valid session cookie, so "is there a session?" is the wrong
 * question; `requireAccess` asks whether they are still on the roster. Server
 * Actions and Route Handlers repeat the check for themselves, because a layout
 * does not run in front of a direct POST.
 */
export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Redirects rather than throws — see requireWorkspace. Nothing on the render
  // path raises any more, so a layout and its page cannot disagree about what
  // happens to a caller who is not admitted.
  const access = await requireWorkspace();

  const { user, organisation, isOwner } = access;
  const initials =
    (user.name || user.email)
      .split(/[\s@.]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]!.toUpperCase())
      .join("") || "?";

  const links = [
    { href: "/dashboard", label: "Overview" },
    { href: "/dashboard/tech-stack", label: "Technology reference" },
    { href: "/dashboard/documents", label: "Standards library" },
    { href: "/dashboard/decisions", label: "Decisions" },
    ...(isOwner ? [{ href: "/dashboard/people", label: "People" }] : []),
  ];

  return (
    <div className="min-h-svh">
      <header className="sticky top-0 z-50 border-b border-white/[0.08] bg-ink-900/80 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-6 px-6">
          <Logo href="/dashboard" />

          <nav className="hidden items-center gap-1 sm:flex">
            {links.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="rounded-full px-3 py-1.5 text-[13.5px] text-white/55 transition-colors hover:bg-white/[0.06] hover:text-white"
              >
                {link.label}
              </Link>
            ))}
            {user.isPlatformAdmin && (
              <Link
                href="/admin"
                className="ml-1 rounded-full border border-royal-mid/35 bg-royal/[0.12] px-3 py-1.5 text-[13.5px] text-royal-soft transition-colors hover:bg-royal/20"
              >
                Admin
              </Link>
            )}
          </nav>

          <div className="ml-auto flex items-center gap-3">
            <div className="hidden text-right sm:block">
              <p className="text-[13px] leading-tight text-white/85">
                {user.name || user.email}
              </p>
              <p className="text-[11.5px] leading-tight text-white/35">
                {organisation.name}
                {isOwner ? " · Administrator" : ""}
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

