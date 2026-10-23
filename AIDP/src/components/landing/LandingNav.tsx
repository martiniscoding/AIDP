"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "framer-motion";
import { Menu, User, X } from "lucide-react";
import { LogoMark } from "@/components/ui/Logo";

const LINKS = [
  { label: "Home", href: "#top" },
  { label: "Product", href: "#product" },
  { label: "Solution", href: "#solution" },
  { label: "Pricing", href: "#pricing" },
  { label: "About us", href: "#about" },
  { label: "Contact", href: "#contact" },
];

/**
 * The landing header: a transparent bar riding on the hero's violet band
 * rather than a bonded or floating one. It is in normal flow as the hero's
 * first child, so the band's height is what pushes the badge and headline
 * down — nothing here is positioned, and the copy below never has to guess
 * how much room to leave for it.
 *
 * Everything is white-on-violet, which only holds while the bar sits in the
 * top ~90px of the hero where the gradient is still at full strength. The
 * mobile sheet drops to ink-on-paper because it covers the page, violet band
 * included.
 */
export function LandingNav() {
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setIsOpen(false);
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [isOpen]);

  return (
    <header className="relative z-30">
      <div className="mx-auto flex h-[72px] w-full max-w-[1060px] items-center justify-between gap-6 px-5 sm:px-6">
        <Link
          href="/"
          aria-label="Dexter home"
          className="group flex shrink-0 items-center gap-2.5"
        >
          <LogoMark tone="light" className="h-8 w-8 transition-transform duration-500 ease-out group-hover:rotate-[8deg]" />
          <span className="font-display text-[20px] font-semibold tracking-[-0.02em] text-white">
            Dexter
          </span>
        </Link>

        {/* The link row is centred on the bar, not on the gap between logo and
            button — absolute rather than a flex child, so an asymmetric logo
            or a longer button label cannot drag it off the page's axis. */}
        <nav
          aria-label="Main"
          className="absolute left-1/2 hidden -translate-x-1/2 items-center gap-1 lg:flex"
        >
          {LINKS.map((link) => (
            <a
              key={link.label}
              href={link.href}
              className="rounded-full px-3.5 py-2 text-[14px] font-normal text-white/90 transition-colors duration-200 hover:bg-white/15 hover:text-white"
            >
              {link.label}
            </a>
          ))}
        </nav>

        <div className="flex shrink-0 items-center gap-2">
          <Link
            href="/sign-up"
            className="hidden h-[46px] items-center gap-2 rounded-full border border-white/45 px-5 text-[14px] font-medium text-white transition-colors duration-300 hover:bg-white/15 sm:inline-flex"
          >
            <User size={17} strokeWidth={1.8} className="opacity-90" />
            Sign up
          </Link>

          <button
            type="button"
            onClick={() => setIsOpen(true)}
            aria-expanded={isOpen}
            aria-controls="landing-menu"
            aria-label="Open menu"
            className="grid size-11 place-items-center rounded-full border border-white/40 text-white transition-colors hover:bg-white/15 lg:hidden"
          >
            <Menu className="h-5 w-5" />
          </button>
        </div>
      </div>

      <AnimatePresence>
        {isOpen ? (
          <motion.div
            id="landing-menu"
            className="fixed inset-0 z-50 bg-white px-6 pt-24 lg:hidden"
            initial={{ opacity: 0, x: "100%" }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: "100%" }}
            transition={{ type: "spring", damping: 28, stiffness: 300 }}
          >
            <button
              type="button"
              onClick={() => setIsOpen(false)}
              aria-label="Close menu"
              className="absolute top-6 right-6 grid size-11 place-items-center rounded-full border border-line text-ink/80 transition-colors hover:bg-canvas-sunk hover:text-ink"
            >
              <X className="h-5 w-5" />
            </button>

            <div className="flex flex-col gap-5">
              {LINKS.map((link) => (
                <a
                  key={link.label}
                  href={link.href}
                  onClick={() => setIsOpen(false)}
                  className="text-[18px] font-medium text-ink/84 transition-colors hover:text-ink"
                >
                  {link.label}
                </a>
              ))}
              <Link
                href="/sign-up"
                onClick={() => setIsOpen(false)}
                className="mt-3 inline-flex h-13 items-center justify-center rounded-[11px] bg-[linear-gradient(180deg,#8b5cf6_0%,#6d28d9_100%)] px-7 text-[15px] font-medium text-white"
              >
                Sign up
              </Link>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </header>
  );
}
