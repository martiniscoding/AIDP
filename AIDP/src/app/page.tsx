import { Navbar1 } from "@/components/ui/navbar-1";
import { Hero } from "@/components/landing/Hero";
import { ScrollPath } from "@/components/landing/ScrollPath";
import { WorkflowSection } from "@/components/landing/WorkflowSection";
import { FeatureGrid } from "@/components/landing/FeatureGrid";
import { KnowledgeSection } from "@/components/landing/KnowledgeSection";
import { PlatformStrip } from "@/components/landing/PlatformStrip";
import { StatsStrip } from "@/components/landing/StatsStrip";
import { FinalCTA } from "@/components/landing/FinalCTA";
import { Footer } from "@/components/landing/Footer";

export default function LandingPage() {
  return (
    <>
      <Navbar1 />
      <main>
        <Hero />

        {/* Everything inside ScrollPath is threaded by the connecting line.
            Sections mark their attachment points with `data-path-anchor`; the
            hero marks where the line starts with `data-path-origin`. */}
        <ScrollPath>
          <WorkflowSection />
          <FeatureGrid />
          <KnowledgeSection />
          <PlatformStrip />
          <StatsStrip />
          <FinalCTA />
        </ScrollPath>
      </main>
      <Footer />
    </>
  );
}
