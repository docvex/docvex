"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { AnimatePresence, motion } from "motion/react";

type Intent = "demo" | "waitlist" | "early-access" | "contact";

type Ctx = {
  open: (intent?: Intent) => void;
  close: () => void;
};

const DemoCtx = createContext<Ctx>({ open: () => {}, close: () => {} });

export function useDemoModal() {
  return useContext(DemoCtx);
}

const COPY: Record<
  Intent,
  { title: string; sub: string; subjectPrefix: string; cta: string }
> = {
  demo: {
    title: "Request a demo.",
    sub: "Tell us a little about your firm. We'll be in touch within one business day.",
    subjectPrefix: "Demo request",
    cta: "Send request",
  },
  waitlist: {
    title: "Join the waitlist.",
    sub: "We're rolling out DOCVEX to firms one cohort at a time. Tell us where to reach you.",
    subjectPrefix: "Waitlist",
    cta: "Join waitlist",
  },
  "early-access": {
    title: "Join early access.",
    sub: "First in line for new features and pricing. Tell us about your firm.",
    subjectPrefix: "Early access",
    cta: "Request access",
  },
  contact: {
    title: "Get in touch.",
    sub: "Questions, partnerships, press — write to us.",
    subjectPrefix: "Contact",
    cta: "Send",
  },
};

export function DemoModalProvider({ children }: { children: React.ReactNode }) {
  const [intent, setIntent] = useState<Intent | null>(null);

  const open = useCallback((i: Intent = "demo") => setIntent(i), []);
  const close = useCallback(() => setIntent(null), []);

  // ESC to close
  useEffect(() => {
    if (!intent) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    // Lock scroll
    const original = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = original;
    };
  }, [intent, close]);

  const value = useMemo<Ctx>(() => ({ open, close }), [open, close]);

  return (
    <DemoCtx.Provider value={value}>
      {children}
      <AnimatePresence>
        {intent && <DemoDialog intent={intent} onClose={close} />}
      </AnimatePresence>
    </DemoCtx.Provider>
  );
}

function DemoDialog({
  intent,
  onClose,
}: {
  intent: Intent;
  onClose: () => void;
}) {
  const copy = COPY[intent];

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    const name = String(data.get("name") || "").trim();
    const firm = String(data.get("firm") || "").trim();
    const email = String(data.get("email") || "").trim();
    const message = String(data.get("message") || "").trim();

    const subject = encodeURIComponent(
      `${copy.subjectPrefix} — ${firm || name || "DOCVEX"}`
    );
    const body = encodeURIComponent(
      [
        `Name: ${name}`,
        `Firm: ${firm}`,
        `Email: ${email}`,
        "",
        message,
      ].join("\n")
    );

    window.location.href = `mailto:docvexteam@docvex.ro?subject=${subject}&body=${body}`;
    onClose();
  }

  return (
    <motion.div
      role="dialog"
      aria-modal="true"
      aria-labelledby="demo-dialog-title"
      className="fixed inset-0 z-[60] flex items-center justify-center px-4 py-8"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
    >
      {/* Backdrop */}
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-[var(--color-navy-900)]/70 backdrop-blur-sm"
      />

      {/* Panel */}
      <motion.div
        initial={{ opacity: 0, y: 18, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 10, scale: 0.98 }}
        transition={{ duration: 0.28, ease: [0.22, 0.61, 0.36, 1] }}
        className="relative z-10 w-full max-w-lg overflow-hidden rounded-2xl border border-[var(--color-navy-900)]/10 bg-[var(--color-cream)] p-7 shadow-luxury-lg sm:p-9"
      >
        {/* Close X */}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute right-4 top-4 flex h-8 w-8 items-center justify-center rounded-full text-[var(--color-navy-900)]/55 transition-colors hover:bg-[var(--color-navy-900)]/8 hover:text-[var(--color-navy-900)]"
        >
          <svg
            viewBox="0 0 24 24"
            width="14"
            height="14"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M6 6l12 12M6 18L18 6" />
          </svg>
        </button>

        <p className="text-[10px] font-semibold uppercase tracking-[0.32em] text-[var(--color-wood)]">
          docvex.ro
        </p>
        <h2
          id="demo-dialog-title"
          className="mt-2 font-roman text-3xl font-medium leading-[1.05] tracking-tight text-[var(--color-navy-900)] sm:text-4xl"
        >
          {copy.title}
        </h2>
        <p className="mt-3 text-sm leading-6 text-[var(--color-navy-900)]/65">
          {copy.sub}
        </p>

        <form onSubmit={handleSubmit} className="mt-7 space-y-3.5">
          <Field name="name" label="Your name" autoComplete="name" required />
          <Field name="firm" label="Firm" autoComplete="organization" required />
          <Field
            name="email"
            label="Email"
            type="email"
            autoComplete="email"
            required
          />
          <Field name="message" label="A short note (optional)" textarea />

          <div className="flex items-center justify-between pt-2">
            <p className="text-[10px] text-[var(--color-navy-900)]/45">
              Opens your email client.
            </p>
            <button
              type="submit"
              className="inline-flex h-11 items-center gap-2 rounded-full bg-[var(--color-navy-900)] px-6 text-sm font-semibold text-[var(--color-cream)] transition-transform hover:-translate-y-0.5"
            >
              {copy.cta}
            </button>
          </div>
        </form>
      </motion.div>
    </motion.div>
  );
}

function Field({
  name,
  label,
  type = "text",
  textarea = false,
  required = false,
  autoComplete,
}: {
  name: string;
  label: string;
  type?: string;
  textarea?: boolean;
  required?: boolean;
  autoComplete?: string;
}) {
  const base =
    "w-full rounded-lg border border-[var(--color-navy-900)]/15 bg-white/70 px-3.5 py-2.5 text-sm text-[var(--color-navy-900)] placeholder-[var(--color-navy-900)]/40 outline-none transition-colors focus:border-[var(--color-wood)] focus:bg-white";
  return (
    <label className="block">
      <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--color-navy-900)]/55">
        {label}
        {required && <span className="text-[var(--color-wood)]"> *</span>}
      </span>
      {textarea ? (
        <textarea
          name={name}
          required={required}
          rows={3}
          className={base}
        />
      ) : (
        <input
          name={name}
          type={type}
          required={required}
          autoComplete={autoComplete}
          className={base}
        />
      )}
    </label>
  );
}
