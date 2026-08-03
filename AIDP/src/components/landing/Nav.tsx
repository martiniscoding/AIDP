"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Menu, X } from "lucide-react";
import { Logo } from "@/components/ui/Logo";
import { ButtonLink } from "@/components/ui/Button";
import { cn } from "@/lib/cn";

const LINKS = [
  { label: "Product", href: "#features" },
  { label: "How it works", href: "#how-it-works" },
  { label: "Security", href: "#platform" },
  { label: "Docs", href: "#knowledge" },
];

export function Nav() {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Lock body scroll while the mobile sheet is open.
  useEffect(() => {
    document.body.style.overflow = open ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  return (
    <header
      className={cn(
        "fixed inset-x-0 top-0 z-50 transition-[background-color,border-color,backdrop-filter] duration-500",
        scrolled || open
          ? "border-b border-white/[0.07] bg-ink-900/70 backdrop-blur-xl"
          : "border-b border-transparent bg-transparent",
      )}
    >
      <nav
        aria-label="Main"
        className="mx-auto flex h-16 max-w-[1280px] items-center justify-between gap-6 px-5 sm:px-8"
      >
        <Logo />

        <ul className="hidden items-center gap-1 md:flex">
          {LINKS.map((link) => (
            <li key={link.href}>
              <a
                href={link.href}
                className="rounded-full px-3.5 py-2 text-[13.5px] text-white/60 transition-colors duration-200 hover:bg-white/[0.06] hover:text-white"
              >
                {link.label}
              </a>
            </li>
          ))}
        </ul>

        <div className="hidden items-center gap-2 md:flex">
          <ButtonLink href="/sign-in" variant="ghost" size="sm">
            Sign in
          </ButtonLink>
          <ButtonLink href="/sign-up" size="sm">
            Get started
          </ButtonLink>
        </div>

        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls="mobile-menu"
          aria-label={open ? "Close menu" : "Open menu"}
          className="grid size-10 place-items-center rounded-full border border-white/10 text-white/75 transition-colors hover:bg-white/[0.06] hover:text-white md:hidden"
        >
          {open ? <X size={18} /> : <Menu size={18} />}
        </button>
      </nav>

      <AnimatePresence>
        {open ? (
          <motion.div
            id="mobile-menu"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.32, ease: [0.16, 1, 0.3, 1] }}
            className="overflow-hidden border-t border-white/[0.07] md:hidden"
          >
            <ul className="flex flex-col gap-1 px-5 py-4">
              {LINKS.map((link) => (
                <li key={link.href}>
                  <a
                    href={link.href}
                    onClick={() => setOpen(false)}
                    className="block rounded-xl px-3 py-2.5 text-[15px] text-white/70 transition-colors hover:bg-white/[0.06] hover:text-white"
                  >
                    {link.label}
                  </a>
                </li>
              ))}
            </ul>
            <div className="flex flex-col gap-2.5 px-5 pb-6">
              <ButtonLink
                href="/sign-in"
                variant="secondary"
                onClick={() => setOpen(false)}
              >
                Sign in
              </ButtonLink>
              <ButtonLink href="/sign-up" onClick={() => setOpen(false)}>
                Get started
              </ButtonLink>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </header>
  );
}
