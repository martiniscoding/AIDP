import Link from "next/link";
import { ThemeToggle } from "@/components/ui/ThemeToggle";

/**
 * The bar across the top of a page in the product.
 *
 * Who you are and how the app looks, in the top right — which is where
 * people reach for both, and where every other tool they have open keeps
 * them. They used to sit at the foot of the navigation rail, which put the
 * account furthest from the eye on a tall screen and buried the theme
 * control under it.
 *
 * It carries no navigation, and not sign out either — that sits in the
 * rail's bottom corner, where a destructive-ish action is out of the path of
 * the things people press all day.
 *
 * Sticky, because on a long assessment page the sign-out and the theme
 * switch should not be a scroll away. Translucent over the canvas so the
 * page reads as passing *under* it rather than stopping at a second header
 * — the pages below already open with their own title block.
 */
export type TopBarAccount = {
  name: string;
  /** The line under the name: which workspace, and in what capacity. */
  meta?: string;
  initials: string;
  /** Where the block goes when it is a link. Omitted leaves it inert. */
  href?: string;
};

export function TopBar({ account }: { account: TopBarAccount }) {
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-canvas/85 backdrop-blur-md">
      {/* Matched to the page container below it, so the account block lines
          up with the right edge of the content rather than the viewport. */}
      <div className="mx-auto flex h-chrome w-full max-w-[1180px] items-center justify-end gap-2.5 px-5 sm:px-7 lg:px-10">
        <ThemeToggle />
        <span aria-hidden="true" className="h-5 w-px shrink-0 bg-line" />
        <AccountBlock account={account} />
      </div>
    </header>
  );
}

function AccountBlock({ account }: { account: TopBarAccount }) {
  const body = (
    <>
      <span
        aria-hidden="true"
        className="grid size-8 shrink-0 place-items-center rounded-full bg-royal text-[11.5px] font-semibold text-white"
      >
        {account.initials}
      </span>
      {/* The name and workspace drop below `sm`, where the bar has room for
          about one of the three controls. The initials still identify the
          account, and the profile link still works. */}
      <span className="hidden min-w-0 pr-1 sm:block">
        <span className="block truncate text-[12.5px] font-semibold leading-tight text-ink">
          {account.name}
        </span>
        {account.meta && (
          <span className="block truncate text-[11px] leading-tight text-ink/58">
            {account.meta}
          </span>
        )}
      </span>
    </>
  );

  const shell = "flex max-w-[260px] items-center gap-2.5 rounded-full p-1";

  if (!account.href) {
    return <div className={shell}>{body}</div>;
  }

  return (
    <Link
      href={account.href}
      className={`${shell} border border-transparent transition-colors hover:border-line hover:bg-card`}
    >
      {body}
    </Link>
  );
}
