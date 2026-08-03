"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Menu, X } from "lucide-react";
import { LogoMark } from "@/components/ui/Logo";
import { ButtonLink } from "@/components/ui/Button";
import { cn } from "@/lib/cn";

const LINKS = [
  { label: "Product", href: "#features" },
  { label: "How it works", href: "#how-it-works" },
  { label: "Security", href: "#platform" },
  { label: "Docs", href: "#knowledge" },
];

/**
 * Floating pill navigation: the bar is a self-contained capsule hovering over
 * the page rather than a full-width header bonded to the top edge.
 *
 * It stays `fixed` so it survives scrolling, but the outer wrapper is
 * `pointer-events-none` — only the capsule itself takes clicks, so the strip
 * of hero either side of it stays interactive.
 */
const Navbar1 = () => {
  const [isOpen, setIsOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  const toggleMenu = () => setIsOpen((v) => !v);
  const closeMenu = () => setIsOpen(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Lock body scroll while the mobile sheet covers the page, and let Escape
  // dismiss it — the sheet is the only thing on screen, so it should behave
  // like a dialog.
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
    <div className="pointer-events-none fixed inset-x-0 top-0 z-50 flex w-full justify-center px-4 py-4 sm:py-5">
      <motion.div
        initial={{ opacity: 0, y: -16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
        className={cn(
          "pointer-events-auto relative z-10 flex h-14 w-full max-w-3xl items-center justify-between gap-4 rounded-full border py-2 pr-2 pl-5",
          "backdrop-blur-xl transition-[background-color,border-color,box-shadow] duration-500",
          scrolled
            ? "border-white/[0.12] bg-ink-900/80 shadow-[0_18px_50px_-24px_rgba(0,0,0,0.95)]"
            : "border-white/[0.08] bg-ink-900/55 shadow-[0_12px_40px_-28px_rgba(0,0,0,0.9)]",
        )}
      >
        <a
          href="#top"
          aria-label="Dexter home"
          className="flex items-center gap-2.5"
        >
          <motion.span
            className="flex"
            initial={{ scale: 0.85 }}
            animate={{ scale: 1 }}
            whileHover={{ rotate: 8 }}
            transition={{ duration: 0.3 }}
          >
            <LogoMark className="h-7 w-7" />
          </motion.span>
          <span className="font-display text-[16px] font-semibold tracking-tight text-white">
            Dexter
          </span>
        </a>

        {/* Desktop navigation */}
        <nav aria-label="Main" className="hidden items-center gap-1 md:flex">
          {LINKS.map((link, i) => (
            <motion.a
              key={link.href}
              href={link.href}
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, delay: 0.1 + i * 0.05 }}
              className="rounded-full px-3 py-2 text-[13.5px] text-white/60 transition-colors duration-200 hover:bg-white/[0.06] hover:text-white"
            >
              {link.label}
            </motion.a>
          ))}
        </nav>

        {/* Desktop actions */}
        <motion.div
          className="hidden items-center gap-2 md:flex"
          initial={{ opacity: 0, x: 12 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.3, delay: 0.25 }}
        >
          <ButtonLink href="/sign-in" variant="ghost" size="sm">
            Sign in
          </ButtonLink>
          <ButtonLink href="/sign-up" size="sm">
            Get started
          </ButtonLink>
        </motion.div>

        {/* Mobile trigger */}
        <motion.button
          type="button"
          onClick={toggleMenu}
          whileTap={{ scale: 0.9 }}
          aria-expanded={isOpen}
          aria-controls="mobile-menu"
          aria-label="Open menu"
          className="grid size-10 place-items-center rounded-full border border-white/10 text-white/75 transition-colors hover:bg-white/[0.06] hover:text-white md:hidden"
        >
          <Menu className="h-5 w-5" />
        </motion.button>
      </motion.div>

      {/* Mobile sheet */}
      <AnimatePresence>
        {isOpen ? (
          <motion.div
            id="mobile-menu"
            className="pointer-events-auto fixed inset-0 z-50 bg-ink-950/95 px-6 pt-24 backdrop-blur-xl md:hidden"
            initial={{ opacity: 0, x: "100%" }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: "100%" }}
            transition={{ type: "spring", damping: 28, stiffness: 300 }}
          >
            <motion.button
              type="button"
              onClick={closeMenu}
              whileTap={{ scale: 0.9 }}
              aria-label="Close menu"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.15 }}
              className="absolute top-7 right-6 grid size-10 place-items-center rounded-full border border-white/10 text-white/75 transition-colors hover:bg-white/[0.06] hover:text-white"
            >
              <X className="h-5 w-5" />
            </motion.button>

            <div className="flex flex-col gap-5">
              {LINKS.map((link, i) => (
                <motion.a
                  key={link.href}
                  href={link.href}
                  onClick={closeMenu}
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 20 }}
                  transition={{ delay: 0.1 + i * 0.07 }}
                  className="text-[17px] font-medium text-white/80 transition-colors hover:text-white"
                >
                  {link.label}
                </motion.a>
              ))}

              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 20 }}
                transition={{ delay: 0.45 }}
                className="flex flex-col gap-2.5 pt-5"
              >
                <ButtonLink href="/sign-in" variant="secondary" onClick={closeMenu}>
                  Sign in
                </ButtonLink>
                <ButtonLink href="/sign-up" onClick={closeMenu}>
                  Get started
                </ButtonLink>
              </motion.div>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
};

export { Navbar1 };
