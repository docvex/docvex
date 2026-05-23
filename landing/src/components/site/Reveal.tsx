import { useRef } from "react";
import { motion, useInView, useReducedMotion } from "motion/react";

type RevealProps = {
  children: React.ReactNode;
  delay?: number;
  className?: string;
  as?: "div" | "section" | "li" | "article" | "header";
};

/**
 * Fades + lifts children once they enter the viewport.
 * Honors prefers-reduced-motion.
 */
export function Reveal({
  children,
  delay = 0,
  className,
  as = "div",
}: RevealProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const inView = useInView(ref, { once: true, margin: "-12% 0px -12% 0px" });
  const prefersReduced = useReducedMotion();

  const Component = motion[as] as typeof motion.div;

  if (prefersReduced) {
    return <Component ref={ref} className={className}>{children}</Component>;
  }

  return (
    <Component
      ref={ref}
      className={className}
      initial={{ opacity: 0, y: 22 }}
      animate={inView ? { opacity: 1, y: 0 } : { opacity: 0, y: 22 }}
      transition={{ duration: 0.7, ease: [0.22, 0.61, 0.36, 1], delay }}
    >
      {children}
    </Component>
  );
}
