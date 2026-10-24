import Link from "next/link";
import { ArrowUp } from "lucide-react";
import { LogoMark } from "@/components/ui/Logo";

/**
 * Link set, kept in step with `LandingNav`. Several of these anchors are
 * still placeholders there too (`#product`, `#pricing`, `#about`,
 * `#contact`) — the footer repeats the nav's own targets rather than
 * inventing a second vocabulary for the same page, so when a section
 * lands its anchor starts working in both places at once.
 */
const COLUMNS = [
  {
    title: "Product",
    links: [
      { label: "How it works", href: "#how-it-works" },
      { label: "Inside the platform", href: "#product" },
      { label: "Pricing", href: "#pricing" },
    ],
  },
  {
    title: "Company",
    links: [
      { label: "About us", href: "#about" },
      { label: "Contact", href: "#contact" },
    ],
  },
  {
    title: "Account",
    links: [
      { label: "Sign in", href: "/sign-in" },
      { label: "Create an account", href: "/sign-up" },
    ],
  },
];

/**
 * The footer, and the page's one deep anchor.
 *
 * The tokens file reserves full-strength navy for the few blocks that carry
 * white copy, on the argument that the page's contrast comes from range
 * between bright and deep rather than from mid-greys. The hero gave that up
 * when it went to a blue-to-paper band, and the sections under it are all
 * white — so by the bottom of the page nothing dark has happened yet. This
 * is where it happens.
 *
 * The shape is the hero's, turned over. Up there a fixed band of navy is
 * pinned to the top of the section and ramps down into paper, which is what
 * lets the headline be ink. Here a ramp of the same colours is pinned to the
 * top of the footer and runs the other way, paper back down into navy, and
 * the light shafts that fall down the hero's band rise up this one. The
 * landing page opens out of the brand colour and closes back into it.
 *
 * Everything below the ramp sits on flat `#042a41`, so there is one ground
 * for the whole of the content and one set of contrast decisions rather than
 * type trying to stay legible over a moving gradient.
 *
 * A server component, and no entrance motion: this is the last thing on the
 * page and the reader arrives having already been shown four cards dealt in
 * sequence. Hover and focus are the only things that move.
 */
export function Footer() {
  const year = new Date().getFullYear();

  return (
    <footer className="deep-surface relative isolate overflow-hidden bg-deep">
      {/* The ramp. Shorter than the hero's 620px band because it has one job
          — getting the white of the section above into navy — where the
          hero's band had to hold full-strength blue behind a nav bar first.
          The stops are the hero's own, read bottom-up. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[88px]"
        style={{
          backgroundImage:
            "linear-gradient(180deg,#ffffff 0%,#eef9ff 8%,#c8e8fa 20%,#7fbcdf 34%,#3e92c0 48%,#0c6d9d 62%,#015884 76%,#004671 88%,#042a41 100%)",
        }}
      />

      {/* Shafts rising off the bottom edge. Same period and the same 7% white
          as the hero's, and faint for the same reason: at this width they are
          texture on the navy, and anything stronger turns into stripes the
          eye starts counting. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-0 -z-10 h-72"
        style={{
          backgroundImage:
            "repeating-linear-gradient(90deg, rgba(255,255,255,0) 0 68px, rgba(255,255,255,0.07) 68px 84px, rgba(255,255,255,0) 84px 152px)",
          maskImage: "linear-gradient(0deg,#000 0%,transparent 100%)",
          WebkitMaskImage: "linear-gradient(0deg,#000 0%,transparent 100%)",
        }}
      />

      {/* One bloom, behind the closing ask. Flat navy under a translucent
          panel reads as a slightly lighter navy rectangle; something with a
          gradient under it is what makes the panel read as glass. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -z-10 left-1/2 top-[70px] size-[620px] -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,rgba(10,110,168,0.45),rgba(10,110,168,0))]"
      />

      <div className="mx-auto w-full max-w-[1120px] px-5 pt-[96px] sm:px-6">
        {/* The closing ask.
            
            The logo wall used to sit here, and whatever else it was doing it
            was the last thing on the page — so taking it out left the reader
            at the end of the four stages with nothing to do. This is the ask
            that should always have been in that spot, and the buttons are the
            hero's, inverted for navy: same height, same 11px corners, so the
            page's first and last pair of buttons are recognisably the pair. */}
        <div className="relative overflow-hidden rounded-[22px] bg-white/[0.07] px-6 py-6 text-center ring-1 ring-white/15 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.18)] backdrop-blur-[18px] sm:px-12 sm:py-7">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-10 top-0 h-px bg-[linear-gradient(90deg,transparent,rgba(255,255,255,0.55),transparent)]"
          />

          <h2 className="mx-auto max-w-[620px] font-display text-[clamp(1.6rem,3.8vw,2.6rem)] leading-[1.12] font-semibold tracking-[-0.038em] text-white">
            Put your next submission through it.
          </h2>

          <p className="mx-auto mt-3.5 max-w-[460px] text-[15px] leading-[1.6] text-royal-light/80 text-pretty">
            Load your principles and standards once. Every review after that
            comes back assessed and cited.
          </p>

          <div className="mt-5 flex flex-col items-center gap-3 sm:flex-row sm:justify-center">
            <Link
              href="/sign-up"
              className="inline-flex h-14 w-full min-w-[150px] items-center justify-center rounded-[11px] bg-white px-7 text-[15px] font-medium text-royal-deep shadow-[0_14px_34px_-14px_rgba(0,0,0,0.6)] transition-[transform,box-shadow] duration-300 hover:-translate-y-px hover:shadow-[0_20px_44px_-16px_rgba(0,0,0,0.7)] active:translate-y-0 sm:w-auto"
            >
              Get started
            </Link>
            <Link
              href="/sign-in"
              className="inline-flex h-14 w-full min-w-[150px] items-center justify-center rounded-[11px] border-[1.5px] border-white/35 px-7 text-[15px] font-medium text-white transition-colors duration-300 hover:border-white/60 hover:bg-white/10 sm:w-auto"
            >
              Sign in
            </Link>
          </div>
        </div>

        {/* Brand and links. The blurb is held to roughly 60 characters a line
            so it stays a paragraph rather than a banner across the column. */}
        <div className="mt-10 grid gap-8 lg:grid-cols-12 lg:gap-8">
          <div className="lg:col-span-5">
            <Link
              href="/"
              aria-label="AIDP home"
              className="group inline-flex items-center gap-2.5"
            >
              <LogoMark
                tone="light"
                className="h-8 w-8 transition-transform duration-500 ease-out group-hover:rotate-[8deg]"
              />
              <span className="font-display text-[20px] font-semibold tracking-[-0.02em] text-white">
                AIDP
              </span>
            </Link>

            <p className="mt-4 max-w-[34ch] text-[14.5px] leading-[1.65] text-white/70 text-pretty">
              Architecture Intelligence and Decision Platform. Assessment
              grounded in your own principles, standards and prior decisions —
              never a generic rulebook.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-x-8 gap-y-8 sm:grid-cols-3 lg:col-span-6 lg:col-start-7">
            {COLUMNS.map((column) => (
              <nav key={column.title} aria-label={column.title}>
                <h3 className="text-[11.5px] font-medium tracking-[0.16em] text-royal-light/70 uppercase">
                  {column.title}
                </h3>
                <ul className="mt-3.5 flex flex-col gap-2.5">
                  {column.links.map((link) => (
                    <li key={link.label}>
                      {link.href.startsWith("#") ? (
                        <a
                          href={link.href}
                          className="text-[14.5px] text-white/72 transition-colors duration-200 hover:text-white"
                        >
                          {link.label}
                        </a>
                      ) : (
                        <Link
                          href={link.href}
                          className="text-[14.5px] text-white/72 transition-colors duration-200 hover:text-white"
                        >
                          {link.label}
                        </Link>
                      )}
                    </li>
                  ))}
                </ul>
              </nav>
            ))}
          </div>
        </div>

        {/* The bottom edge.
            
            The wordmark set oversized and cropped by the page is the one
            place on this page where type is the picture rather than the
            caption, and it is the last thing under the reader's thumb. It is
            held at 5% white: legible as a shape, nowhere near legible enough
            to compete with the live wordmark eight rems above it, and with
            the shafts rising through the same band it reads as the brand
            going out with the light rather than as a watermark.
            
            The crop is the overflow clip on the footer plus `bottom` in `em`,
            and the unit is the whole trick: the size is a clamp, so a fixed
            pixel offset that takes a fifth off the capitals at 248px takes
            half of them at the 96px floor. In `em` it resolves against the
            element's own font-size, so the same slice comes off at every
            width. `leading-[0.78]` is what lets the box be that short — the
            capitals have no descenders to lose. */}
        <div className="relative mt-14 pb-6 sm:mt-20">
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-[-0.16em] select-none text-center font-display text-[clamp(6rem,21vw,15.5rem)] leading-[0.78] font-semibold tracking-[-0.06em] text-white/[0.055]"
          >
            AIDP
          </span>

          <div className="relative flex flex-col gap-4 border-t border-white/12 pt-5 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-[13px] text-white/55">
              © {year} AIDP. Architecture reviews in days, not weeks.
            </p>

            <a
              href="#top"
              className="inline-flex items-center gap-2 self-start text-[13px] text-white/55 transition-colors duration-200 hover:text-white sm:self-auto"
            >
              <ArrowUp size={14} strokeWidth={2} aria-hidden="true" />
              Back to top
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}
