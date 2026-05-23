import { Bell, Sparkles, ArrowRight } from "lucide-react";
import { Reveal } from "./Reveal";

const items = [
  {
    tag: "EU · GDPR",
    title: "New guidance on AI-generated personal data.",
    body: "EDPB clarifies controller obligations for synthetic outputs derived from training data.",
    time: "Today · 09:14",
  },
  {
    tag: "Romania · Civil",
    title: "Amendments to the Civil Procedure Code.",
    body: "Updated deadlines for appeals. Revised electronic filing requirements. In effect Q3.",
    time: "Yesterday",
  },
  {
    tag: "Employment",
    title: "Remote work registration changes.",
    body: "Employers must notify the labour inspectorate within 5 working days.",
    time: "2 days ago",
  },
];

export function LegalUpdates() {
  return (
    <section
      id="updates"
      className="relative bg-[var(--color-cream)] py-24 lg:py-32"
    >
      <div className="mx-auto max-w-7xl px-6 lg:px-10">
        <div className="grid grid-cols-1 gap-12 lg:grid-cols-[1fr_1.4fr] lg:gap-20">
          <Reveal>
            <p className="mb-4 inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-[var(--color-wood)]">
              <Bell size={12} /> Legal AI Updates
            </p>
            <h2 className="font-display text-4xl font-semibold leading-[1.05] tracking-tight text-[var(--color-navy-900)] sm:text-5xl">
              The law moves.
              <br />
              <span className="text-[var(--color-wood)]">
                Your firm moves with it.
              </span>
            </h2>
            <p className="mt-5 max-w-md text-base leading-7 text-[var(--color-navy-900)]/65 sm:text-lg">
              Legislation. Summarized for your practice. Reviewed by humans.
            </p>
            <a
              href="#waitlist"
              className="group mt-6 inline-flex w-fit items-center gap-2 text-sm font-semibold text-[var(--color-navy-900)] hover:text-[var(--color-wood)]"
            >
              See the feed
              <ArrowRight
                size={16}
                className="transition-transform group-hover:translate-x-1"
              />
            </a>
          </Reveal>

          <Reveal
            delay={0.1}
            className="rounded-3xl border border-[var(--color-navy-900)]/10 bg-white p-5 shadow-luxury sm:p-6"
          >
            <div className="mb-3 flex items-center justify-between">
              <p className="font-roman text-base font-medium tracking-[0.02em] text-[var(--color-navy-900)]">
                Intelligence feed
              </p>
              <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--color-cream)] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-wood)]">
                <span className="pulse-dot inline-block h-1.5 w-1.5 rounded-full bg-[var(--color-wood)]" />
                Live
              </span>
            </div>

            <ul className="divide-y divide-[var(--color-navy-900)]/8">
              {items.map((it) => (
                <li
                  key={it.title}
                  className="group flex items-start gap-4 py-4 first:pt-1 last:pb-1"
                >
                  <span className="mt-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--color-cream)] text-[var(--color-wood)]">
                    <Sparkles size={16} strokeWidth={1.75} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded-full bg-[var(--color-navy-900)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-beige-300)]">
                        {it.tag}
                      </span>
                      <span className="text-[10px] text-[var(--color-navy-900)]/40">
                        {it.time}
                      </span>
                    </div>
                    <p className="mt-1.5 font-roman text-sm font-medium tracking-[0.02em] text-[var(--color-navy-900)]">
                      {it.title}
                    </p>
                    <p className="mt-1 text-xs leading-5 text-[var(--color-navy-900)]/60">
                      {it.body}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
