import { Wordmark } from "./Wordmark";

const groups = [
  {
    title: "Product",
    links: [
      { label: "Features", href: "#features" },
      { label: "Security", href: "#security" },
      { label: "Updates", href: "#updates" },
      { label: "Client Portal", href: "#clients" },
      { label: "Pricing", href: "#pricing" },
      { label: "FAQ", href: "#faq" },
    ],
  },
  {
    title: "Company",
    links: [
      { label: "About", href: "#about" },
      { label: "Customers", href: "#customers" },
      { label: "Careers", href: "#careers" },
      { label: "Contact", href: "mailto:docvexteam@docvex.ro" },
    ],
  },
  {
    title: "Legal",
    links: [
      { label: "Terms & Conditions", href: "#terms" },
      { label: "Privacy Policy", href: "#privacy" },
      { label: "Cookie Policy", href: "#cookies" },
      { label: "GDPR Compliance", href: "#gdpr" },
      { label: "Security & Confidentiality", href: "#confidentiality" },
    ],
  },
];

export function Footer() {
  return (
    <footer className="bg-[var(--color-navy-900)] text-[var(--color-cream)]">
      <div className="mx-auto max-w-7xl px-6 py-16 lg:px-10">
        <div className="grid grid-cols-1 gap-10 sm:grid-cols-2 lg:grid-cols-[1.4fr_1fr_1fr_1.1fr]">
          <div>
            <Wordmark size="md" tone="light" />
            <p className="mt-4 max-w-sm text-sm leading-6 text-[var(--color-cream)]/55">
              Intelligent legal workflows for modern law firms.
            </p>
            <div className="mt-6 space-y-1 text-xs text-[var(--color-cream)]/55">
              <p>
                <a
                  href="mailto:docvexteam@docvex.ro"
                  className="hover:text-[var(--color-beige-300)]"
                >
                  docvexteam@docvex.ro
                </a>
              </p>
              <p>
                <a
                  href="https://docvex.ro"
                  className="hover:text-[var(--color-beige-300)]"
                >
                  docvex.ro
                </a>
              </p>
            </div>
          </div>

          {groups.map((g) => (
            <div key={g.title}>
              <p className="font-display text-xs font-semibold uppercase tracking-[0.22em] text-[var(--color-beige-300)]">
                {g.title}
              </p>
              <ul className="mt-4 space-y-2.5">
                {g.links.map((l) => (
                  <li key={l.label}>
                    <a
                      href={l.href}
                      className="text-sm text-[var(--color-cream)]/60 transition-colors hover:text-[var(--color-beige-300)]"
                    >
                      {l.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-12 flex flex-col items-start justify-between gap-3 border-t border-[var(--color-cream)]/10 pt-6 text-xs text-[var(--color-cream)]/45 sm:flex-row sm:items-center">
          <p>© {new Date().getFullYear()} DOCVEX. All rights reserved.</p>
          <p className="tracking-[0.22em] uppercase">
            Intelligent Legal Workflows
          </p>
        </div>
      </div>
    </footer>
  );
}
