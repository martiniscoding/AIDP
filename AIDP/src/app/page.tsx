import { Hero } from "@/components/landing/Hero";
import { PartnerStrip } from "@/components/landing/PartnerStrip";

// Hero only, for now. The rest of the marketing page — the workflow walk,
// the feature grid, the knowledge section, the stats and the closing CTA —
// still lives in `src/components/landing/`, unmounted rather than deleted,
// so putting any of it back is a line in this file.
export default function LandingPage() {
  return (
    <main className="min-h-dvh bg-white">
      <Hero />
      <PartnerStrip />
    </main>
  );
}
