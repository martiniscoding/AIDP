import { requireWorkspace } from "@/lib/access/gate";
import { SideNav, type NavGroup } from "@/components/ui/SideNav";
import { TopBar } from "@/components/ui/TopBar";
import { SignOutButton } from "./SignOutButton";
import { SessionTimeout } from "@/components/auth/SessionTimeout";

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
 *
 * The chrome is a navigation rail down the left rather than a strip along the
 * top: see SideNav. All this layout owns is which destinations exist for this
 * person, and the one column of page the rail leaves.
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
  // to the list it adds to. Profile is not in this list either: it is the
  // account block in the top right, which is where people look for it.
  //
  // Grouped by who they are for. An administrator's two screens are about
  // other people's work rather than their own, and a member never sees them at
  // all, so they read as a section instead of as four peers in one run.
  const groups: NavGroup[] = [
    {
      label: "Workspace",
      items: [
        // Home *is* the project list, so a "My Projects" entry beside it
        // pointed at the same screen and only raised the question of how the
        // two differed.
        { href: "/dashboard", label: "Home", icon: "home" },
        // Second, and above the library: filing one is the thing most people
        // come here to do, and the library is an administrator's shelf.
        { href: "/dashboard/requests", label: "Requests", icon: "requests" },
        { href: "/dashboard/documents", label: "Reference Library", icon: "library" },
        { href: "/dashboard/decisions", label: "Decisions", icon: "decisions" },
      ],
    },
  ];

  const adminItems: NavGroup["items"] = [
    ...(isOwner
      ? [
          { href: "/dashboard/activity", label: "Activity", icon: "activity" as const },
          { href: "/dashboard/people", label: "People", icon: "people" as const },
        ]
      : []),
    ...(user.isPlatformAdmin
      ? [{ href: "/admin", label: "Admin", icon: "operator" as const, accent: true }]
      : []),
  ];

  if (adminItems.length > 0) {
    groups.push({ label: "Admin Tools", items: adminItems });
  }

  return (
    <div className="app-shell flex min-h-svh">
      <SessionTimeout />

      <SideNav brandHref="/dashboard" groups={groups}>
        <SignOutButton />
      </SideNav>

      <main className="min-w-0 flex-1">
        <TopBar
          account={{
            name: user.name || user.email,
            meta: `${organisation.name}${isOwner ? " · Administrator" : ""}`,
            initials,
            href: "/dashboard/profile",
          }}
        />

        <div className="mx-auto w-full max-w-[1180px] px-5 pb-20 pt-7 sm:px-7 lg:px-10 lg:pt-8">
          {children}
        </div>
      </main>
    </div>
  );
}
