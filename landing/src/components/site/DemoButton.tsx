"use client";

import { useDemoModal } from "./DemoModalProvider";

type Variant = "primary" | "outline" | "dark" | "linkArrow";
type Intent = "demo" | "waitlist" | "early-access" | "contact";

const STYLES: Record<Variant, string> = {
  primary:
    "inline-flex h-12 items-center gap-2 rounded-full bg-[var(--color-beige-300)] px-6 text-sm font-semibold text-[var(--color-navy-900)] shadow-[0_12px_30px_-10px_rgb(220_201_163/0.55)] transition-transform hover:-translate-y-0.5 hover:bg-[var(--color-beige-200)]",
  outline:
    "inline-flex h-12 items-center gap-2 rounded-full border border-[var(--color-beige-300)]/25 bg-transparent px-6 text-sm font-semibold text-[var(--color-cream)] transition-colors hover:bg-[var(--color-navy-800)]",
  dark:
    "inline-flex h-12 items-center gap-2 rounded-full bg-[var(--color-navy-900)] px-6 text-sm font-semibold text-[var(--color-cream)] shadow-[0_12px_30px_-10px_rgb(15_23_42/0.4)] transition-transform hover:-translate-y-0.5",
  linkArrow:
    "group inline-flex items-center gap-2 text-sm font-semibold text-[var(--color-wood)] hover:text-[var(--color-wood-dark)]",
};

export function DemoButton({
  intent = "demo",
  variant = "primary",
  className,
  children,
}: {
  intent?: Intent;
  variant?: Variant;
  className?: string;
  children: React.ReactNode;
}) {
  const { open } = useDemoModal();
  return (
    <button
      type="button"
      onClick={() => open(intent)}
      className={`${STYLES[variant]} ${className ?? ""}`.trim()}
    >
      {children}
    </button>
  );
}
