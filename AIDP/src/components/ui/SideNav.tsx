"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Activity,
  BookMarked,
  Building2,
  ClipboardList,
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
 * destinations relate to each other. Down the side there is room for the list
 * to grow and for the links to group under their own headings.
 *
 * It is painted in the `rail` tokens rather than in `deep`, which is what
 * lets it answer the theme switch: navy with white copy in the dark theme,
 * white paper with ink in the light one. Everything in here that is not one
 * of those two grounds is alpha over `rail-ink`, so a rule, a group heading
 * and a hover film all stay in whichever colour the theme put there.
 *
 * Destinations, and one action at the foot: signing out. Who you are and
 * the theme control sit in the TopBar instead — at the foot of a tall rail
 * the account was as far from the eye as the page could put it — but sign
 * out belongs down here, away from the things people press all day.
 *
 * Icons are named rather than passed, so a layout — a Server Component — can
 * describe its navigation as plain data instead of shipping element trees
 * across the boundary.
 */
const ICONS = {
  home: House,
  requests: ClipboardList,
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

export function SideNav({
  brandHref,
  badge,
  groups,
  children,
}: {
  brandHref: string;
  /** A word beside the mark, for a shell that is not the customer's own. */
  badge?: string;
  groups: NavGroup[];
  /** The bottom corner of the rail — sign out, in practice. */
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
        className="fixed left-4 top-4 z-50 grid size-10 place-items-center rounded-lg border border-rail-ink/12 bg-rail text-rail-ink shadow-pop lg:hidden"
      >
        {open ? <X size={18} /> : <Menu size={18} />}
      </button>

      {/* Tap-anywhere-else to close. Hidden from assistive tech, which has the
          toggle above and the links themselves. */}
      {open && (
        <div
          aria-hidden="true"
          onClick={() => setOpen(false)}
          // Above the TopBar's 30, which is otherwise later in the document
          // and would stay lit while the rest of the page dimmed behind it.
          // Still under the rail and its toggle, which are what the dimming is
          // for.
          className="fixed inset-0 z-40 bg-black/55 backdrop-blur-sm lg:hidden"
        />
      )}

      <nav
        className={cn(
          "fixed left-0 top-0 z-40 flex h-svh w-64 shrink-0 flex-col border-r border-rail-ink/10 bg-rail text-rail-ink",
          "transition-transform duration-200 ease-out lg:sticky lg:translate-x-0",
          open ? "translate-x-0 shadow-pop" : "-translate-x-full",
        )}
      >
        {/* h-chrome, not padding: this border and the TopBar's are one line
            across the top of the shell, and only a shared height keeps them
            on it. See --spacing-chrome. */}
        <div className="flex h-chrome items-center gap-2 border-b border-rail-ink/10 px-5">
          <Logo tone="rail" href={brandHref} />
          {badge && (
            <span className="rounded-full border border-rail-marker/40 bg-rail-ink/8 px-2 py-0.5 text-[10.5px] font-medium tracking-wide text-rail-marker">
              {badge}
            </span>
          )}
        </div>

        <div className="flex-1 overflow-y-auto px-3 py-4">
          {groups.map((group) => (
            <div key={group.label} className="mb-4 last:mb-0">
              <p className="px-3 pb-2 pt-2 text-[10.5px] font-medium uppercase tracking-[0.14em] text-rail-ink/58">
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
                            ? "border-rail-marker bg-rail-active text-rail-ink"
                            : "border-transparent text-rail-ink/70 hover:bg-rail-ink/8 hover:text-rail-ink",
                          item.accent && !current && "text-rail-marker",
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

        {children && (
          <div className="border-t border-rail-ink/10 px-4 py-4">{children}</div>
        )}
      </nav>
    </>
  );
}
