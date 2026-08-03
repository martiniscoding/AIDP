"use client";

import {
  BarChart3,
  Database,
  FileCheck2,
  GitBranch,
  Sparkles,
  Users,
} from "lucide-react";
import { Reveal } from "@/components/ui/Reveal";

const SIGNALS = [
  {
    icon: Sparkles,
    title: "Frontier models",
    body: "Assessment agents run on Claude and GPT-4o.",
  },
  {
    icon: Database,
    title: "RAG over pgvector",
    body: "Retrieval grounded in your own corpus, not model memory.",
  },
  {
    icon: GitBranch,
    title: "Versioned knowledge base",
    body: "Each run records the KB version it assessed against.",
  },
  {
    icon: FileCheck2,
    title: "SOC 2-style audit trail",
    body: "Every agent step logged and retrievable for compliance.",
  },
  {
    icon: Users,
    title: "Role-based workflow",
    body: "Requestor → Architect → ARB, with each decision recorded.",
  },
  {
    icon: BarChart3,
    title: "Org-wide analytics",
    body: "Turnaround time, outcome mix, most-violated principles.",
  },
];

export function PlatformStrip() {
  return (
    <section id="platform" className="relative py-20 sm:py-28">
      <div className="mx-auto max-w-[1280px] px-5 sm:px-8">
        <Reveal>
          <div className="flex flex-col gap-2 border-b border-white/[0.07] pb-8">
            <h2 className="font-display text-lg font-semibold tracking-[-0.01em] text-white">
              Built for scale, and for the audit afterwards
            </h2>
            <p className="max-w-2xl text-[14.5px] leading-relaxed text-white/50">
              The parts of the platform that matter to a CISO more than to a
              demo.
            </p>
          </div>
        </Reveal>

        <div
          data-path-anchor
          className="grid gap-x-10 gap-y-9 pt-10 sm:grid-cols-2 lg:grid-cols-3"
        >
          {SIGNALS.map((signal, i) => (
            <Reveal key={signal.title} delay={(i % 3) * 0.07}>
              <div className="flex gap-3.5">
                <signal.icon
                  size={17}
                  aria-hidden="true"
                  className="mt-0.5 shrink-0 text-white/35"
                />
                <div>
                  <h3 className="text-[14.5px] font-medium text-white/85">
                    {signal.title}
                  </h3>
                  <p className="mt-1 text-[13.5px] leading-relaxed text-white/45 text-pretty">
                    {signal.body}
                  </p>
                </div>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
