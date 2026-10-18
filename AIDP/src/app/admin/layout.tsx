import { redirect } from "next/navigation";
import { EyeOff } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { currentUser } from "@/lib/access/gate";
import { SideNav, type NavGroup } from "@/components/ui/SideNav";
import { SignOutButton } from "../dashboard/SignOutButton";
import { SessionTimeout } from "@/components/auth/SessionTimeout";

/**
 * The operator's console.
 *
 * Separate from /dashboard because it is a different product for a different
 * person: the operator has no organisation of their own to work in, and the
 * customer-facing navigation would be meaningless to them here. It wears the
 * same navigation rail, so moving between the two consoles is not also a change
 * of shell.
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

  const initials =
    (user.name || user.email)
      .split(/[\s@.]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]!.toUpperCase())
      .join("") || "?";

  const groups: NavGroup[] = [
    {
      label: "Operator",
      items: [
        { href: "/admin", label: "Companies", icon: "companies" },
        ...(hasWorkspace
          ? [{ href: "/dashboard", label: "My workspace", icon: "home" as const }]
          : []),
      ],
    },
  ];

  return (
    <div className="flex min-h-svh">
      <SessionTimeout />

      <SideNav
        brandHref="/admin"
        badge="Operator"
        groups={groups}
        account={{
          name: user.name || user.email,
          // Only when it adds something: with no name on the account the block
          // already *is* the email address.
          meta: user.name ? user.email : undefined,
          initials,
        }}
      >
        <SignOutButton />
      </SideNav>

      <main className="min-w-0 flex-1">
        <div className="mx-auto w-full max-w-[1180px] px-5 pb-20 pt-[76px] sm:px-7 lg:px-10 lg:pt-9">
          {/* Stated once, at the top of every page here. The boundary is enforced
              in src/lib/access/platform.ts — no query in this console selects a
              document title, let alone its contents. */}
          <p className="mb-6 flex items-center gap-2 rounded-xl border border-line bg-card px-3.5 py-2.5 text-[12.5px] text-ink/64">
            <EyeOff size={14} className="shrink-0 text-ink/62" />
            You can see companies, their people, and their usage. Customer
            documents and assessment results are not visible from here.
          </p>
          {children}
        </div>
      </main>
    </div>
  );
}
