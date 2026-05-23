import {
  Sparkles,
  Search,
  GitBranch,
  Zap,
  Users,
  Bell,
} from "lucide-react";
import type { ComponentType, SVGProps } from "react";
import { Reveal } from "./Reveal";

type Feature = {
  icon: ComponentType<SVGProps<SVGSVGElement> & { size?: number; strokeWidth?: number }>;
  title: string;
  body: string;
};

const features: Feature[] = [
  {
    icon: Sparkles,
    title: "AI summaries.",
    body: "Hundreds of pages. The clauses, dates, and risks that matter.",
  },
  {
    icon: Search,
    title: "Smart search.",
    body: "Find precedent across every matter your firm has handled.",
  },
  {
    icon: GitBranch,
    title: "Workflows.",
    body: "Intake. Draft. Review. Close. No handoffs.",
  },
  {
    icon: Zap,
    title: "Drafting.",
    body: "Engagement letters and contracts in your firm's voice.",
  },
  {
    icon: Users,
    title: "Client portal.",
    body: "A private workspace for every client.",
  },
  {
    icon: Bell,
    title: "Legal updates.",
    body: "Legislation, summarized for your practice.",
  },
];

export function Features() {
  return (
    <section
      id="features"
      className="relative bg-[var(--color-cream)] py-24 lg:py-32"
    >
      <div className="mx-auto max-w-7xl px-6 lg:px-10">
        <Reveal className="max-w-3xl">
          <p className="mb-4 text-[11px] font-semibold uppercase tracking-[0.22em] text-[var(--color-wood)]">
            The platform
          </p>
          <h2 className="font-display text-4xl font-semibold leading-[1.05] tracking-tight text-[var(--color-navy-900)] sm:text-5xl">
            Everything a modern firm needs.
            <br />
            <span className="text-[var(--color-wood)]">In one quiet workspace.</span>
          </h2>
          <p className="mt-5 max-w-2xl text-base leading-7 text-[var(--color-navy-900)]/65 sm:text-lg">
            Drafting. Organizing. Tracking. Done — so your lawyers can focus on
            the rest.
          </p>
        </Reveal>

        <div className="mt-14 grid grid-cols-1 gap-px overflow-hidden rounded-3xl border border-[var(--color-navy-900)]/10 bg-[var(--color-navy-900)]/10 sm:grid-cols-2 lg:grid-cols-3">
          {features.map(({ icon: Icon, title, body }, i) => (
            <Reveal
              key={title}
              delay={(i % 3) * 0.05}
              className="group relative flex flex-col gap-4 bg-[var(--color-cream)] p-8 transition-colors hover:bg-white"
            >
              <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-[var(--color-navy-900)] text-[var(--color-beige-300)] shadow-[0_8px_22px_-10px_rgb(15_23_42/0.5)]">
                <Icon size={20} strokeWidth={1.75} />
              </span>
              <h3 className="font-roman text-xl font-medium tracking-[0.02em] text-[var(--color-navy-900)]">
                {title}
              </h3>
              <p className="text-sm leading-6 text-[var(--color-navy-900)]/65">
                {body}
              </p>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
