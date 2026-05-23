import { Lock, Shield, FileCheck, ShieldCheck, Settings } from "lucide-react";
import { Reveal } from "./Reveal";

const pillars = [
  {
    icon: Lock,
    title: "Encrypted storage.",
    body: "Encryption at rest. Encryption in transit. Industry-standard keys.",
  },
  {
    icon: ShieldCheck,
    title: "GDPR-compliant.",
    body: "EU infrastructure. EU data residency.",
  },
  {
    icon: Settings,
    title: "Private workspaces.",
    body: "Per-firm tenancy. Matter-level permissions.",
  },
  {
    icon: FileCheck,
    title: "No AI training.",
    body: "Your documents never train our models.",
  },
];

export function Security() {
  return (
    <section
      id="security"
      className="relative overflow-hidden bg-[var(--color-navy-900)] py-24 text-[var(--color-cream)] lg:py-32"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute -left-32 top-20 h-80 w-80 rounded-full opacity-40 blur-3xl"
        style={{
          background:
            "radial-gradient(closest-side, rgba(220,201,163,0.18), transparent 75%)",
        }}
      />

      <div className="relative mx-auto max-w-7xl px-6 lg:px-10">
        <div className="grid grid-cols-1 gap-12 lg:grid-cols-[1fr_1.2fr] lg:gap-20">
          <Reveal>
            <p className="mb-4 inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-[var(--color-beige-300)]">
              <Shield size={12} /> Security
            </p>
            <h2 className="font-display text-4xl font-semibold leading-[1.05] tracking-tight sm:text-5xl">
              Built with
              <br />
              <span className="text-[var(--color-beige-300)]">
                legal-grade confidentiality.
              </span>
            </h2>
            <p className="mt-5 max-w-md text-base leading-7 text-[var(--color-cream)]/65 sm:text-lg">
              Engineered around client privilege. From the first line of code.
            </p>
          </Reveal>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {pillars.map(({ icon: Icon, title, body }, i) => (
              <Reveal
                key={title}
                delay={(i % 2) * 0.06}
                className="rounded-2xl border border-[var(--color-beige-300)]/12 bg-[var(--color-navy-800)]/55 p-6 transition-colors hover:border-[var(--color-beige-300)]/25 hover:bg-[var(--color-navy-800)]/80"
              >
                <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-[var(--color-beige-300)]/10 text-[var(--color-beige-300)]">
                  <Icon size={18} strokeWidth={1.75} />
                </span>
                <h3 className="mt-4 font-roman text-base font-medium tracking-[0.02em] text-[var(--color-cream)]">
                  {title}
                </h3>
                <p className="mt-1.5 text-sm leading-6 text-[var(--color-cream)]/60">
                  {body}
                </p>
              </Reveal>
            ))}
          </div>
        </div>

        <p className="mt-14 max-w-3xl text-xs leading-6 text-[var(--color-cream)]/45">
          DOCVEX is a workflow platform. It does not provide legal advice or
          replace lawyers.
        </p>
      </div>
    </section>
  );
}
