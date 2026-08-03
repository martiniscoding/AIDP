import Link from "next/link";
import { Logo } from "@/components/ui/Logo";

const COLUMNS = [
  {
    title: "Product",
    links: [
      { label: "How it works", href: "#how-it-works" },
      { label: "Capabilities", href: "#features" },
      { label: "Knowledge repository", href: "#knowledge" },
      { label: "Security", href: "#platform" },
    ],
  },
  {
    title: "Company",
    links: [
      { label: "About", href: "#" },
      { label: "Careers", href: "#" },
      { label: "Contact", href: "#" },
    ],
  },
  {
    title: "Legal",
    links: [
      { label: "Privacy", href: "#" },
      { label: "Terms", href: "#" },
      { label: "Data processing", href: "#" },
    ],
  },
];

export function Footer() {
  return (
    <footer className="relative border-t border-white/[0.07]">
      <div className="mx-auto max-w-[1280px] px-5 py-16 sm:px-8 sm:py-20">
        <div className="grid gap-12 lg:grid-cols-12">
          <div className="lg:col-span-5">
            <Logo />
            <p className="mt-5 max-w-xs text-[14px] leading-relaxed text-white/45 text-pretty">
              AI-native enterprise architecture governance. Automated
              assessment, grounded in your own principles and prior decisions.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-8 sm:grid-cols-3 lg:col-span-6 lg:col-start-7">
            {COLUMNS.map((column) => (
              <nav key={column.title} aria-label={column.title}>
                <h2 className="text-[12px] font-medium uppercase tracking-[0.16em] text-white/35">
                  {column.title}
                </h2>
                <ul className="mt-4 flex flex-col gap-2.5">
                  {column.links.map((link) => (
                    <li key={link.label}>
                      {link.href.startsWith("#") ? (
                        <a
                          href={link.href}
                          className="text-[14px] text-white/55 transition-colors hover:text-white"
                        >
                          {link.label}
                        </a>
                      ) : (
                        <Link
                          href={link.href}
                          className="text-[14px] text-white/55 transition-colors hover:text-white"
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

        <div className="mt-14 flex flex-col gap-3 border-t border-white/[0.07] pt-7 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[13px] text-white/35">
            © {new Date().getFullYear()} Dexter. All rights reserved.
          </p>
          <p className="text-[13px] text-white/35">
            Architecture reviews in days, not weeks.
          </p>
        </div>
      </div>
    </footer>
  );
}
