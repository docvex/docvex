import { Wordmark } from "./Wordmark";
import { Reveal } from "./Reveal";
import { DemoButton } from "./DemoButton";

export function FinalCTA() {
  return (
    <section id="demo" className="relative bg-[var(--color-cream)] pb-24 lg:pb-32">
      <div className="mx-auto max-w-7xl px-6 lg:px-10">
        <Reveal className="relative">
          {/* Wood ledge peeking out under the navy CTA card */}
          <div
            aria-hidden
            className="wood-texture absolute inset-x-6 -bottom-3 h-6 rounded-b-2xl opacity-95 sm:inset-x-10"
            style={{
              boxShadow:
                "inset 0 1px 0 rgba(255,255,255,0.10), inset 0 -1px 0 rgba(0,0,0,0.30), 0 18px 40px -18px rgba(15,23,42,0.35)",
            }}
          />

          <div className="relative overflow-hidden rounded-3xl border border-[var(--color-navy-900)]/10 bg-[var(--color-navy-900)] px-8 py-16 text-center text-[var(--color-cream)] shadow-luxury-lg sm:px-12 sm:py-20 lg:px-16 lg:py-24">
            <div
              aria-hidden
              className="pointer-events-none absolute -top-32 left-1/2 h-[420px] w-[820px] -translate-x-1/2 rounded-full opacity-50 blur-3xl"
              style={{
                background:
                  "radial-gradient(closest-side, rgba(220,201,163,0.22), transparent 70%)",
              }}
            />

            <div className="relative mx-auto max-w-3xl">
              <div className="mb-8 flex justify-center">
                <Wordmark size="lg" tone="light" />
              </div>
              <p className="mb-4 text-[11px] font-semibold uppercase tracking-[0.32em] text-[var(--color-beige-300)]">
                docvex.ro
              </p>
              <h2 className="font-display text-4xl font-semibold leading-[1.05] tracking-tight sm:text-5xl">
                Modernize
                <br />
                <span className="text-[var(--color-beige-300)]">
                  your legal workflow.
                </span>
              </h2>
              <p className="mx-auto mt-5 max-w-xl text-base leading-7 text-[var(--color-cream)]/70 sm:text-lg">
                Cut the busywork. Get your evenings back.
              </p>

              <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
                <DemoButton intent="demo" variant="primary">
                  Request Demo
                </DemoButton>
                <DemoButton intent="early-access" variant="outline">
                  Join Early Access
                </DemoButton>
              </div>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
