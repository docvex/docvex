import React, { useEffect, useRef, useState } from 'react';
import './PageMasthead.css';

// Editorial page header, ported from the Versions ("Updates") page so every
// personal destination opened from the top app-nav bar shares one header
// language: an accent eyebrow + muted kicker on one line, a big display title,
// an optional summary paragraph, and an optional right-aligned actions slot.
//
// Behavior (also from Versions): an optional compact bar fixed to the content
// area that fades/slides in once the big title has scrolled away, with a
// click-to-top affordance. Pages with their own pinned-header + inner-scroll
// layout (e.g. Activity) pass `compact={false}` and just adopt the style.
export default function PageMasthead({
  eyebrow,
  eyebrowMuted,
  title,
  children,            // kicker paragraph content (optional)
  actions,             // right-aligned masthead content — buttons / stats (optional)
  compact = true,      // render the on-scroll compact bar
  compactRight = null, // optional node pinned to the right of the compact bar
  scrollerSelector = '.sv-single-scroll, .main-content',
}) {
  const ref = useRef(null);
  const [scrolled, setScrolled] = useState(false);

  // Toggle the compact bar once the masthead's scroller passes a threshold.
  // Hysteresis (show past 32px, hide under 8px) prevents flicker at the edge.
  useEffect(() => {
    if (!compact) return undefined;
    const scroller = ref.current?.closest(scrollerSelector);
    if (!scroller) return undefined;
    const onScroll = () => {
      const top = scroller.scrollTop;
      setScrolled((s) => (s ? top > 8 : top > 32));
    };
    onScroll();
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => scroller.removeEventListener('scroll', onScroll);
  }, [compact, scrollerSelector]);

  const scrollToTop = () => {
    ref.current?.closest(scrollerSelector)?.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <div className="pmh" ref={ref}>
      {compact && (
        <div className={`pmh-compact${scrolled ? ' is-visible' : ''}`} aria-hidden={!scrolled}>
          <button type="button" className="pmh-compact-titlebtn" onClick={scrollToTop} title="Back to top">
            <span className="pmh-compact-title">{title}</span>
          </button>
          {eyebrow && (
            <>
              <span className="pmh-compact-sep" aria-hidden="true">·</span>
              <span className="pmh-compact-eyebrow">{eyebrow}</span>
            </>
          )}
          {compactRight && <span className="pmh-compact-right">{compactRight}</span>}
        </div>
      )}
      <header className="pmh-masthead">
        <div className="pmh-mh-left">
          {eyebrow && (
            <div className="pmh-mh-eyebrow">
              <span>{eyebrow}</span>
              {eyebrowMuted && <span className="pmh-mh-muted">· {eyebrowMuted}</span>}
            </div>
          )}
          <h1 className="pmh-mh-title">{title}</h1>
          {children && <p className="pmh-mh-kicker">{children}</p>}
        </div>
        {actions && <div className="pmh-mh-actions">{actions}</div>}
      </header>
    </div>
  );
}
