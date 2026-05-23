type Tone = "light" | "dark";
type Size = "sm" | "md" | "lg";

const sizes: Record<Size, {
  icon: number;
  wordmark: string;
  tagline: string;
  divider: string;
  gap: string;
  showTagline: boolean;
}> = {
  sm: {
    icon: 36,
    wordmark: "text-2xl",
    tagline: "text-[8px]",
    divider: "h-7",
    gap: "gap-3",
    showTagline: false,
  },
  md: {
    icon: 48,
    wordmark: "text-3xl",
    tagline: "text-[9px]",
    divider: "h-9",
    gap: "gap-4",
    showTagline: true,
  },
  lg: {
    icon: 72,
    wordmark: "text-5xl sm:text-6xl",
    tagline: "text-[11px] sm:text-xs",
    divider: "h-14 sm:h-16",
    gap: "gap-5 sm:gap-6",
    showTagline: true,
  },
};

export function Wordmark({
  size = "md",
  tone = "light",
  className = "",
}: {
  size?: Size;
  tone?: Tone;
  className?: string;
}) {
  const s = sizes[size];
  const cream = tone === "light" ? "text-[var(--color-cream)]" : "text-[var(--color-navy-900)]";
  const muted =
    tone === "light"
      ? "text-[var(--color-beige-300)]/85"
      : "text-[var(--color-wood)]/85";
  const dividerColor =
    tone === "light"
      ? "bg-[var(--color-beige-300)]/35"
      : "bg-[var(--color-navy-900)]/25";

  return (
    <div className={`inline-flex items-center ${s.gap} ${className}`}>
      <img
        src="/logo.png"
        alt="DOCVEX"
        width={s.icon}
        height={s.icon}
        className="shrink-0 object-contain"
        style={{ width: s.icon, height: s.icon }}
      />
      <span className={`w-px ${s.divider} ${dividerColor}`} aria-hidden />
      <div className="flex flex-col leading-none">
        <span
          className={`font-roman font-semibold tracking-[0.04em] ${s.wordmark} ${cream}`}
        >
          Doc<span className="wood-text">V</span>ex
        </span>
        {s.showTagline && (
          <span
            className={`mt-2 inline-flex items-center gap-2 font-display font-medium uppercase tracking-[0.32em] ${s.tagline} ${muted}`}
          >
            <span className="inline-block h-px w-3 bg-current opacity-60" />
            Intelligent Legal Workflows
            <span className="inline-block h-px w-3 bg-current opacity-60" />
          </span>
        )}
      </div>
    </div>
  );
}
