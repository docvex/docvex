import { CircleCheck } from "lucide-react";
import { Reveal } from "./Reveal";
import { DemoButton } from "./DemoButton";

type Tier = {
  name: string;
  sub: string;
  highlight: boolean;
  features: string[];
  cta: string;
};

const tiers: Tier[] = [
  {
    name: "Solo.",
    sub: "For independent lawyers.",
    highlight: false,
    features: [
      "AI drafting from your templates.",
      "Smart search across your matters.",
      "Client portal.",
      "Legal updates feed.",
    ],
    cta: "Talk to us",
  },
  {
    name: "Firm.",
    sub: "For boutique and mid-sized firms.",
    highlight: true,
    features: [
      "Everything in Solo.",
      "Workflows. Intake to close.",
      "Branded client portal.",
      "Role-based permissions.",
      "Multi-matter view.",
    ],
    cta: "Request demo",
  },
  {
    name: "Enterprise.",
    sub: "For large firms and legal teams.",
    highlight: false,
    features: [
      "Everything in Firm.",
      "Custom integrations.",
      "On-premise option.",
      "SSO and audit logs.",
      "Dedicated success manager.",
    ],
    cta: "Contact sales",
  },
];

export function Pricing() {
  return (
    <section
      id="pricing"
      className="relative bg-[var(--color-cream)] py-24 lg:py-32"
    >
      <div className="mx-auto max-w-7xl px-6 lg:px-10">
        <Reveal className="mx-auto max-w-3xl text-center">
          <p className="mb-4 text-[11px] font-semibold uppercase tracking-[0.22em] text-[var(--color-wood)]">
            Pricing
          </p>
          <h2 className="font-display text-4xl font-semibold leading-[1.05] tracking-tight text-[var(--color-navy-900)] sm:text-5xl">
            Priced for the work
            <br />
            <span className="text-[var(--color-wood)]">it gives you back.</span>
          </h2>
          <p className="mt-5 text-base leading-7 text-[var(--color-navy-900)]/65 sm:text-lg">
            Three plans. Matched to the size of your firm.
          </p>
        </Reveal>

        <div className="mt-14 grid grid-cols-1 gap-5 lg:grid-cols-3 lg:gap-6">
          {tiers.map((t, i) => (
            <Reveal
              key={t.name}
              delay={i * 0.06}
              className={
                t.highlight
                  ? "relative flex flex-col rounded-3xl border border-[var(--color-beige-300)]/40 bg-[var(--color-navy-900)] p-8 text-[var(--color-cream)] shadow-luxury-lg lg:-mt-4"
                  : "relative flex flex-col rounded-3xl border border-[var(--color-navy-900)]/10 bg-white p-8 text-[var(--color-navy-900)] shadow-luxury"
              }
            >
              {t.highlight && (
                <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-[var(--color-beige-300)] px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--color-navy-900)]">
                  Most popular
                </span>
              )}

              <p className="font-roman text-3xl font-medium tracking-[0.02em]">
                {t.name}
              </p>
              <p
                className={
                  t.highlight
                    ? "mt-1.5 text-sm text-[var(--color-cream)]/70"
                    : "mt-1.5 text-sm text-[var(--color-navy-900)]/55"
                }
              >
                {t.sub}
              </p>

              <div className="mt-6 flex items-baseline gap-2">
                <span className="font-display text-3xl font-semibold tracking-tight">
                  On request.
                </span>
              </div>
              <p
                className={
                  t.highlight
                    ? "mt-1 text-xs text-[var(--color-cream)]/55"
                    : "mt-1 text-xs text-[var(--color-navy-900)]/50"
                }
              >
                Pricing matched to your firm.
              </p>

              <ul
                className={
                  t.highlight
                    ? "mt-7 space-y-2.5 text-sm text-[var(--color-cream)]/80"
                    : "mt-7 space-y-2.5 text-sm text-[var(--color-navy-900)]/75"
                }
              >
                {t.features.map((f) => (
                  <li key={f} className="flex items-start gap-2.5">
                    <CircleCheck
                      size={16}
                      strokeWidth={1.75}
                      className={
                        t.highlight
                          ? "mt-0.5 shrink-0 text-[var(--color-beige-300)]"
                          : "mt-0.5 shrink-0 text-[var(--color-wood)]"
                      }
                    />
                    <span>{f}</span>
                  </li>
                ))}
              </ul>

              <div className="mt-8 flex-1" />
              <DemoButton
                intent="contact"
                variant={t.highlight ? "primary" : "dark"}
                className="w-full justify-center"
              >
                {t.cta}
              </DemoButton>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
