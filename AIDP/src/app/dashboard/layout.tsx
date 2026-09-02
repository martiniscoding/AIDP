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

  // Destinations only — starting a project belongs on the projects page, next
  // to the list it adds to. Profile is not in this list either: it lives on
  // the account block at the right, which is where people look for it.
  const links = [
    { href: "/dashboard", label: "Home" },
    { href: "/dashboard/documents", label: "Reference Library" },
    { href: "/dashboard/projects", label: "My Projects" },
    { href: "/dashboard/decisions", label: "Decisions" },
    ...(isOwner
      ? [
          { href: "/dashboard/activity", label: "Activity" },
          { href: "/dashboard/people", label: "People" },
        ]
      : []),
  ];

  return (
    <div className="app-dark min-h-svh">
      <header className="sticky top-0 z-50 border-b border-deep bg-deep backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-7xl items-center gap-4 px-6">
          <Logo tone="light" href="/dashboard" />

          <nav className="hidden items-center gap-0.5 lg:flex">
            {links.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="whitespace-nowrap rounded-full px-2.5 py-1.5 text-[13px] text-white/70 transition-colors hover:bg-white/10 hover:text-white"
              >
                {link.label}
              </Link>
            ))}
            {user.isPlatformAdmin && (
              <Link
                href="/admin"
                className="ml-1 whitespace-nowrap rounded-full border border-royal-light/40 bg-white/10 px-2.5 py-1.5 text-[13px] text-royal-light transition-colors hover:bg-white/20"
              >
                Admin
              </Link>
            )}
          </nav>

          <div className="ml-auto flex shrink-0 items-center gap-2">
            <Link
              href="/dashboard/profile"
              className="flex shrink-0 items-center gap-2.5 rounded-full py-1 pl-3 pr-1 transition-colors hover:bg-white/10"
            >
              <span className="hidden text-right xl:block">
                <span className="block whitespace-nowrap text-[13px] leading-tight text-white/88">
                  {user.name || user.email}
                </span>
                <span className="block whitespace-nowrap text-[11.5px] leading-tight text-white/55">
                  {organisation.name}
                  {isOwner ? " · Administrator" : ""}
                </span>
              </span>
              <span
                aria-hidden="true"
                className="grid size-9 shrink-0 place-items-center rounded-full bg-royal-light text-[12px] font-semibold text-deep"
              >
                {initials}
              </span>
            </Link>
            <SignOutButton />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-10">{children}</main>
    </div>
  );
}

