import { DemoModalProvider } from "@/components/site/DemoModalProvider";
import { Nav } from "@/components/site/Nav";
import { Hero } from "@/components/site/Hero";
import { Features } from "@/components/site/Features";
import { Security } from "@/components/site/Security";
import { LegalUpdates } from "@/components/site/LegalUpdates";
import { ClientPortal } from "@/components/site/ClientPortal";
import { Pricing } from "@/components/site/Pricing";
import { FAQ } from "@/components/site/FAQ";
import { FinalCTA } from "@/components/site/FinalCTA";
import { Footer } from "@/components/site/Footer";

// Replaces Next's layout.tsx (DemoModalProvider wrapper) + page.tsx (sections).
export default function App() {
  return (
    <DemoModalProvider>
      <div className="flex flex-1 flex-col">
        <div className="relative bg-[var(--color-navy-900)]">
          <Nav />
          <Hero />
        </div>
        <Features />
        <Security />
        <LegalUpdates />
        <ClientPortal />
        <Pricing />
        <FAQ />
        <FinalCTA />
        <Footer />
      </div>
    </DemoModalProvider>
  );
}
