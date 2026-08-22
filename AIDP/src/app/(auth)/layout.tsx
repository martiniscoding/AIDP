import Link from "next/link";
import { ArrowLeft, ShieldCheck } from "lucide-react";
import { AuthAside } from "@/components/auth/AuthAside";
import { Logo } from "@/components/ui/Logo";
import { MeshGradient } from "@/components/visuals/MeshGradient";

/**
 * Shared shell for every auth screen: artwork on the left, the form on the
 * right. The aside is sticky and hidden below `lg` — on a narrow viewport the
 * form is the whole job, and a stacked photo above a six-field sign-up form
 * only pushes the first input off screen.
 *
 * The gradient here is ambient rather than cursor-tracked: these pages should
 * feel calm, not playful.
 */
export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="relative isolate grid min-h-svh lg:grid-cols-[1.05fr_1fr] xl:grid-cols-[1.15fr_1fr]">
      <AuthAside />

      <div className="relative isolate flex min-h-svh flex-col overflow-hidden">
        {/* Held well back on the form side — the aside carries the colour, and
            a second full-strength gradient behind the card competes with it. */}
        <MeshGradient
          mode="ambient"
          fadeBottom={false}
          className="opacity-90 lg:opacity-45"
        />

        <header className="relative z-10 flex items-center justify-between gap-4 px-5 py-6 sm:px-8 lg:px-10">
          <Logo className="lg:invisible" />
          <Link
            href="/"
            className="inline-flex items-center gap-1.5 rounded-full border border-line bg-card px-3.5 py-1.5 text-[13px] text-ink/70 backdrop-blur-md transition-colors hover:border-line-strong hover:bg-canvas-sunk hover:text-ink"
          >
            <ArrowLeft size={15} aria-hidden="true" />
            Back to site
          </Link>
        </header>

        <main className="relative z-10 flex flex-1 items-center justify-center px-5 py-8 sm:px-8 sm:py-10 lg:px-10">
          {children}
        </main>

        <footer className="relative z-10 flex items-center justify-center gap-2 px-5 pb-8 text-center sm:px-8">
          <ShieldCheck
            size={14}
            aria-hidden="true"
            className="shrink-0 text-ink/58"
          />
          <p className="text-[12.5px] text-ink/62">
            Every action on your account is logged for audit.
          </p>
        </footer>
      </div>
    </div>
  );
}
