import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { CONNECTED_SOURCES, PLANNED_SOURCES, AI_SOURCE, costOf } from '../lib/legalSources';
import './ConfirmModal.css';
import './SourcesModal.css';

// WHAT RESEARCH READS — every platform connected, in its own colour, with what
// it holds and HOW it is reached (the kind of access and what it costs); then
// the ones not connected yet and how each would be. Data: lib/legalSources.
const COST = { free: 'Free', paid: 'Paid', bundled: 'Bundled' };
const CostPill = ({ cost }) => (cost ? <span className={`srcm-cost is-${cost}`}>{COST[cost]}</span> : null);

function Row({ s, planned = false }) {
  return (
    <li className={`srcm-row${planned ? ' is-planned' : ''}`} style={{ '--src-tone': s.tone || 'var(--text-muted)' }}>
      <span className="srcm-dot" aria-hidden="true" />
      <div className="srcm-body">
        <div className="srcm-head">
          <span className="srcm-site">{s.site}</span>
          {s.name ? <span className="srcm-name">{s.name}</span> : null}
          <CostPill cost={s.cost} />
        </div>
        <p className="srcm-what">{s.what}</p>
        <p className="srcm-how"><b>{planned ? 'How it would connect' : 'How'}</b> {s.how}</p>
      </div>
    </li>
  );
}

export default function SourcesModal({ open, onClose }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  const planned = Object.values(PLANNED_SOURCES).map((p) => ({
    site: p.site, name: p.title, what: p.plain, how: p.access, cost: costOf(p.access),
  }));
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
      <div className="modal-card srcm" role="dialog" aria-modal="true" aria-labelledby="srcm-title">
        <div className="srcm-top">
          <h3 id="srcm-title" className="modal-title">Connected platforms</h3>
          <button type="button" className="srcm-x" onClick={onClose} aria-label="Close">×</button>
        </div>
        <p className="modal-message">What Research reads to answer — each in its own colour, as its results appear.</p>
        <ul className="srcm-list">
          {CONNECTED_SOURCES.map((s) => <Row key={s.id} s={s} />)}
          <Row s={AI_SOURCE} />
        </ul>
        <h4 className="srcm-h">Not connected yet</h4>
        <ul className="srcm-list">
          {planned.map((s) => <Row key={s.site} s={s} planned />)}
        </ul>
      </div>
    </div>,
    document.body,
  );
}
