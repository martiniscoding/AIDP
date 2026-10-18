"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Activity,
  BookMarked,
  Building2,
  Gavel,
  House,
  Menu,
  Shield,
  UsersRound,
  X,
} from "lucide-react";
import { Logo } from "@/components/ui/Logo";
import { cn } from "@/lib/cn";

/**
 * The app's navigation rail.
 *
 * Destinations used to sit in a strip across the top, which capped the list at
 * whatever fitted beside the account block and left no room to say how the
 * destinations relate to each other. Down the side there is room for both: the
 * links group under their own headings, and the account sits at the foot where
 * people look for it rather than competing with the links for the same row.
 *
 * It is one deep violet column against light pages. That is the same
 * arrangement the rest of the product uses — a few full-strength anchors with
 * everything between them bright — scaled up to the shell, so a page opens on
 * paper and the chrome is the dark part.
 *
 * Icons are named rather than passed, so a layout — a Server Component — can
 * describe its navigation as plain data instead of shipping element trees
 * across the boundary.
 */
const ICONS = {
  home: House,
  library: BookMarked,
  decisions: Gavel,
  activity: Activity,
  people: UsersRound,
  operator: Shield,
  companies: Building2,
} as const;

export type NavIcon = keyof typeof ICONS;

export type NavItem = {
  href: string;
  label: string;
  icon: NavIcon;
  /** Marks a link out of the ordinary run — the operator console, say. */
  accent?: boolean;
};

export type NavGroup = {
  label: string;
  items: NavItem[];
};

export type NavAccount = {
  name: string;
  /** The line under the name: which workspace, and in what capacity. */
  meta?: string;
  initials: string;
  /** Where the block goes when it is a link. Omitted leaves it inert. */
  href?: string;
};

export function SideNav({
  brandHref,
  badge,
  groups,
  account,
  children,
}: {
  brandHref: string;
  /** A word beside the mark, for a shell that is not the customer's own. */
  badge?: string;
  groups: NavGroup[];
  account: NavAccount;
  /** The foot of the rail, under the account block — sign out, in practice. */
  children?: React.ReactNode;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  // A link is current for its own page and for anything beneath it, which is
  // what keeps "Reference Library" lit while a document from it is open. The
  // root is matched exactly, or it would own every route in the shell.
  const isCurrent = (href: string) =>
    pathname === href || (href !== brandHref && pathname.startsWith(`${href}/`));

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((was) => !was)}
        aria-label="Toggle navigation"
        aria-expanded={open}
        className="fixed left-4 top-4 z-50 grid size-10 place-items-center rounded-lg bg-deep text-white shadow-pop lg:hidden"
      >
        {open ? <X size={18} /> : <Menu size={18} />}
      </button>

      {/* Tap-anywhere-else to close. Hidden from assistive tech, which has the
          toggle above and the links themselves. */}
      {open && (
        <div
          aria-hidden="true"
          onClick={() => setOpen(false)}
          className="fixed inset-0 z-30 bg-ink/45 backdrop-blur-sm lg:hidden"
        />
      )}

      <nav
        className={cn(
          "fixed left-0 top-0 z-40 flex h-svh w-64 shrink-0 flex-col bg-deep text-white",
          "transition-transform duration-200 ease-out lg:sticky lg:translate-x-0",
          open ? "translate-x-0 shadow-pop" : "-translate-x-full",
        )}
      >
        <div className="flex items-center gap-2 border-b border-white/10 px-5 py-5">
          <Logo tone="light" href={brandHref} />
          {badge && (
            <span className="rounded-full border border-royal-light/40 bg-white/10 px-2 py-0.5 text-[10.5px] font-medium tracking-wide text-royal-light">
              {badge}
            </span>
          )}
        </div>

        <div className="flex-1 overflow-y-auto px-3 py-4">
          {groups.map((group) => (
            <div key={group.label} className="mb-4 last:mb-0">
              <p className="px-3 pb-2 pt-2 text-[10.5px] font-medium uppercase tracking-[0.14em] text-white/45">
                {group.label}
              </p>
              <ul>
                {group.items.map((item) => {
                  const Icon = ICONS[item.icon];
                  const current = isCurrent(item.href);
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        onClick={() => setOpen(false)}
                        aria-current={current ? "page" : undefined}
                        className={cn(
                          "mb-0.5 flex items-center gap-2.5 rounded-lg border-l-[3px] px-3 py-2 text-[13.5px] font-medium transition-colors",
                          current
                            ? "border-royal-light bg-royal-mid/35 text-white"
                            : "border-transparent text-white/70 hover:bg-white/8 hover:text-white",
                          item.accent && !current && "text-royal-light",
                        )}
                      >
                        <Icon size={17} strokeWidth={1.8} className="shrink-0 opacity-85" />
                        {item.label}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>

        <div className="border-t border-white/10 px-4 py-4">
          <AccountBlock account={account} onNavigate={() => setOpen(false)} />
          {children && <div className="mt-3">{children}</div>}
        </div>
      </nav>
    </>
  );
}

function AccountBlock({
  account,
  onNavigate,
}: {
  account: NavAccount;
  onNavigate: () => void;
}) {
  const body = (
    <>
      <span
        aria-hidden="true"
        className="grid size-9 shrink-0 place-items-center rounded-full bg-royal-light text-[12px] font-semibold text-deep"
      >
        {account.initials}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[12.5px] font-semibold leading-tight text-white">
          {account.name}
        </span>
        {account.meta && (
          <span className="block truncate text-[11px] leading-tight text-white/55">
            {account.meta}
          </span>
        )}
      </span>
    </>
  );

  if (!account.href) {
    return <div className="flex items-center gap-2.5 px-1">{body}</div>;
  }

  return (
    <Link
      href={account.href}
      onClick={onNavigate}
      className="flex items-center gap-2.5 rounded-lg px-1 py-1 transition-colors hover:bg-white/10"
    >
      {body}
    </Link>
  );
}
