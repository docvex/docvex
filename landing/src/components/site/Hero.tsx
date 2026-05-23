import { LuxuryCabinet } from "./LuxuryCabinet";
import { DemoButton } from "./DemoButton";
import { Reveal } from "./Reveal";

const pillars = [
  { title: "Drafting.", sub: "From your firm's templates." },
  { title: "Privacy.", sub: "GDPR by design." },
  { title: "Workflows.", sub: "Intake to close." },
  { title: "Insight.", sub: "Across every matter." },
];

export function Hero() {
  return (
    <section className="relative overflow-hidden bg-[var(--color-navy-900)]">
      <div
        aria-hidden
        className="pointer-events-none absolute -top-40 left-1/2 h-[520px] w-[920px] -translate-x-1/2 rounded-full opacity-50 blur-3xl"
        style={{
          background:
            "radial-gradient(closest-side, rgb(220 201 163 / 0.18), transparent 70%)",
        }}
      />

      <div className="relative mx-auto grid max-w-7xl grid-cols-1 gap-12 px-6 pb-24 pt-14 lg:grid-cols-[1.05fr_0.95fr] lg:gap-16 lg:px-10 lg:pb-32 lg:pt-20">
        <Reveal className="flex flex-col justify-center">
          <span className="mb-6 inline-flex w-fit items-center gap-2 rounded-full border border-[var(--color-beige-300)]/20 bg-[var(--color-navy-800)]/60 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.22em] text-[var(--color-beige-300)]">
            <span className="pulse-dot inline-block h-1.5 w-1.5 rounded-full bg-[var(--color-beige-300)]" />
            Intelligent Legal Workflows
          </span>

          <h1 className="font-display text-5xl font-semibold leading-[1.02] tracking-tight text-[var(--color-cream)] sm:text-6xl lg:text-7xl">
            Documents.
            <br />
            <span className="text-[var(--color-beige-300)]">Solved.</span>
          </h1>

          <p className="mt-6 max-w-xl text-base leading-7 text-[var(--color-cream)]/70 sm:text-lg">
            Draft. Review. Sign. Without the busywork in between.
          </p>

          <div className="mt-8 flex flex-wrap items-center gap-3">
            <DemoButton intent="demo" variant="primary">
              Request Demo
            </DemoButton>
            <DemoButton intent="waitlist" variant="outline">
              Join Waitlist
            </DemoButton>
          </div>

          <div className="mt-12 grid grid-cols-2 gap-x-6 gap-y-6 sm:grid-cols-4">
            {pillars.map((p) => (
              <div key={p.title} className="min-w-0">
                <p className="font-roman text-base font-medium tracking-[0.04em] text-[var(--color-cream)]">
                  {p.title}
                </p>
                <p className="mt-1 text-xs text-[var(--color-cream)]/55">
                  {p.sub}
                </p>
              </div>
            ))}
          </div>
        </Reveal>

        <Reveal className="relative flex items-center justify-center" delay={0.1}>
          {/* Warm backlight glow — gently pulses */}
          <div
            aria-hidden
            className="pulse-glow pointer-events-none absolute left-1/2 top-1/2 h-[520px] w-[520px] -translate-x-1/2 -translate-y-1/2 rounded-full opacity-80 blur-3xl"
            style={{
              background:
                "radial-gradient(closest-side, rgba(220,201,163,0.20), rgba(139,94,60,0.08) 45%, transparent 75%)",
            }}
          />
          <LuxuryCabinet className="relative" />
        </Reveal>
      </div>

      {/* Wood shelf: hero "sits" on a thin walnut ledge before the cream sections */}
      <div
        aria-hidden
        className="wood-texture wood-shelf relative w-full"
      />
    </section>
  );
}
