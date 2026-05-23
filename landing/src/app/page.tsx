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

export default function Home() {
  return (
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
  );
}
