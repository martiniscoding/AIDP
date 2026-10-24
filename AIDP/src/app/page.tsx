import { Footer } from "@/components/landing/Footer";
import { Hero } from "@/components/landing/Hero";
import { HowItWorks } from "@/components/landing/HowItWorks";
import { InsideShot } from "@/components/landing/InsideShot";

// Hero, the product shot, the four-stage walk, the footer. The rest of the
// marketing page — the feature grid, the knowledge section, the stats and the
// closing CTA — still lives in `src/components/landing/`, unmounted rather
// than deleted, so putting any of it back is a line in this file. The logo
// wall is the exception: its marks were placeholders, so it went rather than
// sat waiting, and the footer now carries the closing ask it used to end on.
export default function LandingPage() {
  return (
    <main className="min-h-dvh bg-white">
      <Hero />
      <InsideShot />
      <HowItWorks />
      <Footer />
    </main>
  );
}
