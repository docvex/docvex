import {
  Users,
  FileText,
  CircleCheck,
  Lock,
  FileCheck,
} from "lucide-react";
import { Reveal } from "./Reveal";
import { DemoButton } from "./DemoButton";

export function ClientPortal() {
  return (
    <section
      id="clients"
      className="relative overflow-hidden bg-[var(--color-cream)] pb-24 pt-6 lg:pb-32"
    >
      <div className="mx-auto max-w-7xl px-6 lg:px-10">
        <Reveal className="overflow-hidden rounded-3xl border border-[var(--color-navy-900)]/10 bg-[var(--color-navy-900)] text-[var(--color-cream)] shadow-luxury-lg">
          <div className="grid grid-cols-1 lg:grid-cols-[1fr_1fr]">
            <div className="flex flex-col justify-center px-8 py-12 sm:px-12 sm:py-16 lg:px-16">
              <p className="mb-4 inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-[var(--color-beige-300)]">
                <Users size={12} /> Client Portal
              </p>
              <h2 className="font-display text-4xl font-semibold leading-[1.05] tracking-tight sm:text-5xl">
                A private workspace
                <br />
                <span className="text-[var(--color-beige-300)]">
                  for every client.
                </span>
              </h2>
              <p className="mt-5 max-w-md text-base leading-7 text-[var(--color-cream)]/65 sm:text-lg">
                Share. Sign. Move forward. Without an inbox in sight.
              </p>

              <ul className="mt-7 space-y-3 text-sm text-[var(--color-cream)]/80">
                {[
                  "Secure file requests and uploads.",
                  "Per-matter visibility controls.",
                  "E-signature and approval tracking.",
                  "Branded in your firm's identity.",
                ].map((l) => (
                  <li key={l} className="flex items-start gap-2.5">
                    <CircleCheck
                      size={16}
                      className="mt-0.5 shrink-0 text-[var(--color-beige-300)]"
                      strokeWidth={1.75}
                    />
                    <span>{l}</span>
                  </li>
                ))}
              </ul>

              <div className="mt-8">
                <DemoButton intent="demo" variant="primary">
                  See the client experience
                </DemoButton>
              </div>
            </div>

            <PortalMock />
          </div>
        </Reveal>
      </div>
    </section>
  );
}

function PortalMock() {
  return (
    <div className="relative border-t border-white/8 bg-[var(--color-navy-800)]/50 p-6 sm:p-10 lg:border-l lg:border-t-0">
      <div
        aria-hidden
        className="pointer-events-none absolute -right-10 top-10 h-72 w-72 rounded-full opacity-50 blur-3xl"
        style={{
          background:
            "radial-gradient(closest-side, rgba(220,201,163,0.22), transparent 75%)",
        }}
      />

      <div className="relative rounded-2xl border border-white/8 bg-[var(--color-navy-900)]/85 p-5 backdrop-blur-md">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-md bg-[var(--color-beige-300)]/15 text-[var(--color-beige-300)]">
              <Lock size={14} strokeWidth={1.75} />
            </span>
            <div>
              <p className="text-xs font-semibold text-[var(--color-cream)]">
                Vasilescu & Partners
              </p>
              <p className="text-[10px] text-[var(--color-cream)]/50">
                Private workspace · Acme Holdings
              </p>
            </div>
          </div>
          <span className="rounded-full bg-[var(--color-beige-300)]/15 px-2 py-0.5 text-[10px] font-semibold text-[var(--color-beige-300)]">
            Confidential
          </span>
        </div>

        <div className="mt-5 space-y-2.5">
          {[
            {
              icon: FileCheck,
              name: "Shareholder Agreement v3",
              meta: "Awaiting signature · You",
              cta: "Sign",
              status: "primary",
            },
            {
              icon: FileText,
              name: "Diligence Checklist.xlsx",
              meta: "Requested by your lawyer",
              cta: "Upload",
              status: "outline",
            },
            {
              icon: FileText,
              name: "Minutes — Board call 14 Oct",
              meta: "Shared 2 days ago",
              cta: "Open",
              status: "ghost",
            },
          ].map((row) => (
            <div
              key={row.name}
              className="flex items-center justify-between rounded-xl border border-white/8 bg-[var(--color-navy-900)]/70 px-3 py-2.5"
            >
              <div className="flex items-center gap-2.5">
                <span className="flex h-7 w-7 items-center justify-center rounded-md bg-white/5 text-[var(--color-beige-300)]">
                  <row.icon size={13} strokeWidth={1.75} />
                </span>
                <div className="min-w-0">
                  <p className="truncate text-xs text-[var(--color-cream)]/90">
                    {row.name}
                  </p>
                  <p className="text-[10px] text-[var(--color-cream)]/45">
                    {row.meta}
                  </p>
                </div>
              </div>
              <button
                type="button"
                className={
                  row.status === "primary"
                    ? "rounded-full bg-[var(--color-beige-300)] px-3 py-1 text-[10px] font-semibold text-[var(--color-navy-900)]"
                    : row.status === "outline"
                    ? "rounded-full border border-[var(--color-beige-300)]/30 px-3 py-1 text-[10px] font-semibold text-[var(--color-beige-300)]"
                    : "rounded-full bg-white/5 px-3 py-1 text-[10px] font-semibold text-[var(--color-cream)]/65"
                }
              >
                {row.cta}
              </button>
            </div>
          ))}
        </div>

        <div className="mt-5 rounded-xl border border-white/8 bg-[var(--color-navy-900)]/70 p-3.5">
          <p className="text-[10px] uppercase tracking-wider text-[var(--color-cream)]/45">
            Matter timeline
          </p>
          <div className="mt-2 flex items-center gap-2">
            <span className="h-1.5 flex-1 rounded-full bg-[var(--color-beige-300)]" />
            <span className="h-1.5 flex-1 rounded-full bg-[var(--color-beige-300)]" />
            <span className="h-1.5 flex-1 rounded-full bg-[var(--color-beige-300)]/40" />
            <span className="h-1.5 flex-1 rounded-full bg-white/10" />
          </div>
          <div className="mt-2 flex justify-between text-[10px] text-[var(--color-cream)]/50">
            <span>Intake</span>
            <span>Draft</span>
            <span className="text-[var(--color-beige-300)]">Review</span>
            <span>Close</span>
          </div>
        </div>
      </div>
    </div>
  );
}
