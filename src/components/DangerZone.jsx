import React from 'react';
import './DangerZone.css';

// Shared "Danger zone" section, replicating the Developer Console (Admin) one
// so every destructive-actions block in the app reads identically: a bordered
// card with a red header (warning glyph + title + subtitle) and a stack of
// rows, each a title + description on the left and a destructive action on the
// right. Use <DangerRow> for the rows and the `dz-btn` class for the buttons.

const WarnIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 9v4M12 17h.01" />
    <path d="M10.3 3.9 2 18a2 2 0 0 0 1.7 3h16.6A2 2 0 0 0 22 18L13.7 3.9a2 2 0 0 0-3.4 0z" />
  </svg>
);

export default function DangerZone({ title = 'Danger zone', subtitle, className = '', children }) {
  return (
    <section className={`dz-danger ${className}`.trim()}>
      <div className="dz-card">
        <div className="dz-hd">
          <div className="dz-hd-icon">{WarnIcon}</div>
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
        </div>
        {children}
      </div>
    </section>
  );
}

// One destructive action: title + description on the left, the action node
// (usually a `dz-btn` button) on the right.
export function DangerRow({ title, desc, children }) {
  return (
    <div className="dz-row">
      <div className="dz-info">
        <div className="dz-title">{title}</div>
        {desc && <div className="dz-desc">{desc}</div>}
      </div>
      {children}
    </div>
  );
}
