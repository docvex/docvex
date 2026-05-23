import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Reveal } from "./Reveal";

const items = [
  {
    q: "Does DOCVEX replace lawyers?",
    a: "No. DOCVEX removes the administrative work. The judgment, the advocacy, the counsel — that stays with you.",
  },
  {
    q: "Is my firm's data used to train AI?",
    a: "Never. Your documents stay yours.",
  },
  {
    q: "Is DOCVEX GDPR compliant?",
    a: "Yes. EU infrastructure. EU data residency. Processing agreements designed for European firms.",
  },
  {
    q: "What about hallucinations?",
    a: "Every output is grounded in your firm's templates and prior matters. Humans review before anything leaves the firm.",
  },
  {
    q: "How long does a rollout take?",
    a: "Most firms are live in under a week.",
  },
  {
    q: "What does it cost?",
    a: "Pricing is matched to the size of your firm. Talk to us.",
  },
];

export function FAQ() {
  return (
    <section
      id="faq"
      className="relative bg-[var(--color-cream)] py-24 lg:py-32"
    >
      <div className="mx-auto max-w-7xl px-6 lg:px-10">
        <div className="grid grid-cols-1 gap-12 lg:grid-cols-[1fr_1.4fr] lg:gap-20">
          <Reveal>
            <p className="mb-4 text-[11px] font-semibold uppercase tracking-[0.22em] text-[var(--color-wood)]">
              FAQ
            </p>
            <h2 className="font-display text-4xl font-semibold leading-[1.05] tracking-tight text-[var(--color-navy-900)] sm:text-5xl">
              Answers.
              <br />
              <span className="text-[var(--color-wood)]">
                Without the marketing.
              </span>
            </h2>
            <p className="mt-5 max-w-md text-base leading-7 text-[var(--color-navy-900)]/65 sm:text-lg">
              Plain language for the cautious. Because lawyers ask better
              questions than most.
            </p>
          </Reveal>

          <Reveal delay={0.08}>
            <ul className="divide-y divide-[var(--color-navy-900)]/10 border-y border-[var(--color-navy-900)]/10">
              {items.map((item, i) => (
                <FaqRow key={item.q} {...item} index={i} />
              ))}
            </ul>
          </Reveal>
        </div>
      </div>
    </section>
  );
}

function FaqRow({ q, a, index }: { q: string; a: string; index: number }) {
  const [open, setOpen] = useState(index === 0);
  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-start justify-between gap-6 py-5 text-left"
      >
        <span className="font-roman text-lg font-medium tracking-[0.02em] text-[var(--color-navy-900)]">
          {q}
        </span>
        <span
          className={`mt-1.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-[var(--color-navy-900)]/15 text-[var(--color-navy-900)]/65 transition-transform ${
            open ? "rotate-45" : "rotate-0"
          }`}
          aria-hidden
        >
          <svg
            viewBox="0 0 24 24"
            width="12"
            height="12"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <path d="M12 5v14M5 12h14" />
          </svg>
        </span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.28, ease: [0.22, 0.61, 0.36, 1] }}
            className="overflow-hidden"
          >
            <p className="pb-6 pr-12 text-sm leading-6 text-[var(--color-navy-900)]/65 sm:text-base">
              {a}
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </li>
  );
}
