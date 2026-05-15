import React from 'react';
import { useTheme } from '../context/ThemeContext';
import Tooltip from './Tooltip';
import './ThemePicker.css';

// Brand palette swatches — same order in every theme card per the spec:
// Ink · Slate · Sand · Cream · Cognac, left-to-right. The colors are pulled
// directly from the brand-constant tokens in src/styles/tokens.css so a
// future palette tweak (e.g. shifting cream toward warmer) lands in one
// place and everything follows.
const BRAND_SWATCHES = Object.freeze([
  { id: 'ink',    cssVar: '--color-ink',    label: 'Ink' },
  { id: 'slate',  cssVar: '--color-slate',  label: 'Slate' },
  { id: 'sand',   cssVar: '--color-sand',   label: 'Sand' },
  { id: 'cream',  cssVar: '--color-cream',  label: 'Cream' },
  { id: 'cognac', cssVar: '--color-cognac', label: 'Cognac' },
]);

// Small check glyph for the active card. Inline SVG to keep this component
// dependency-free — same convention as the rest of the codebase's icons.
const CheckIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" width="14" height="14" aria-hidden="true">
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

// Theme picker — a section sized to sit between two .account-card siblings.
// Each theme is a button card with:
//   1. A mini preview surface rendered IN that theme via `data-theme={id}`,
//      so the tokens.css selectors apply locally inside the card. This is
//      how the Cream card shows cream + ink + cognac WHILE the app itself
//      might be in Ink (or vice versa).
//   2. The 5-swatch brand-palette strip — identical on every card; it's the
//      palette identity, not theme-specific. Order matches the user spec.
//   3. The theme name + a "Selected" pill for the active card.
//
// Clicking a card calls setTheme(id) from ThemeContext, which writes to
// localStorage and updates the data-theme attribute on <html>. The whole
// app repaints in one frame from the CSS variable swap; no React re-render
// cascade required.
export default function ThemePicker() {
  const { theme, setTheme, themes } = useTheme();
  return (
    <section className="account-card theme-picker">
      <h2 className="account-card-title">Theme</h2>
      <p className="theme-picker-desc">
        Pick a color theme for this device. Your choice is saved locally — other
        devices keep their own preference.
      </p>
      <div className="theme-picker-grid">
        {themes.map((t) => {
          const isActive = t.id === theme;
          return (
            <button
              key={t.id}
              type="button"
              // `data-theme` is on the OUTER card (not just the inner mock)
              // so the entire card — background, border, text, the active
              // pill — paints in its own theme. Walking past two cards
              // side-by-side, the contrast between Cream's light surface
              // and Ink's slate surface immediately reads as "these are
              // different themes", without having to compare the inner
              // mock previews to notice.
              data-theme={t.id}
              className={`theme-picker-card${isActive ? ' is-active' : ''}`}
              aria-pressed={isActive}
              onClick={() => setTheme(t.id)}
            >
              {/* Mini preview surface — inherits the card's data-theme via
                  CSS custom-property inheritance, so this nested mock
                  shows the card's bg-page + bg-card + accent contrast in
                  miniature. */}
              <div className="theme-picker-mock">
                <div className="theme-picker-mock-surface">
                  <span className="theme-picker-mock-title">Aa</span>
                  <span className="theme-picker-mock-cta" />
                </div>
              </div>
              {/* Palette strip — fixed Ink·Slate·Sand·Cream·Cognac order. */}
              <div className="theme-picker-swatches" aria-hidden="true">
                {BRAND_SWATCHES.map((sw) => (
                  <Tooltip key={sw.id} content={sw.label}>
                    <span
                      className="theme-picker-swatch"
                      style={{ background: `var(${sw.cssVar})` }}
                    />
                  </Tooltip>
                ))}
              </div>
              <div className="theme-picker-row">
                <span className="theme-picker-name">{t.label}</span>
                {isActive && (
                  <span className="theme-picker-active-pill">
                    {CheckIcon}
                    <span>Selected</span>
                  </span>
                )}
              </div>
              <p className="theme-picker-card-desc">{t.description}</p>
            </button>
          );
        })}
      </div>
    </section>
  );
}
