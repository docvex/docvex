import Link from "next/link";
import { Wordmark } from "./Wordmark";
import { DemoButton } from "./DemoButton";

const links = [
  { label: "Product", href: "#features" },
  { label: "Security", href: "#security" },
  { label: "Pricing", href: "#pricing" },
  { label: "FAQ", href: "#faq" },
];

export function Nav() {
  return (
    <header className="relative z-20 w-full">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-6 pt-6 lg:px-10 lg:pt-8">
        <Link href="/" aria-label="DOCVEX home" className="flex items-center">
          <Wordmark size="sm" tone="light" />
        </Link>

        <nav className="hidden items-center gap-8 lg:flex">
          {links.map((l) => (
            <Link
              key={l.label}
              href={l.href}
              className="text-sm font-medium text-[var(--color-cream)]/80 transition-colors hover:text-[var(--color-beige-300)]"
            >
              {l.label}
            </Link>
          ))}
        </nav>

        <DemoButton
          intent="demo"
          variant="primary"
          className="!h-10 !px-5 !text-sm"
        >
          Request Demo
        </DemoButton>
      </div>
    </header>
  );
}
