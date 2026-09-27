// What the official sources said about a version the AI wrote (lib/sourceChecks
// checkText), drawn in the advisor's thread under the version card. One row per
// thing checked — the act, the company, the CAEN code, the court file — with
// its verdict and, folded, what the source says; then the platforms not yet
// connected and what they would have checked.

import { useState } from 'react';
import './SourcesCheckCard.css';

const STALE_MS = 3 * 60 * 1000;
const WORD = { ok: 'Confirmed', warn: 'Check', error: 'Wrong', unknown: 'Not reached' };

function Row({ it }) {
  const [open, setOpen] = useState(false);
  const r = it.result || {};
  const more = (r.facts || []).length || (r.excerpts || []).length;
  return (
    <li className={`scc-row is-${r.status || 'unknown'}`}>
      <button type="button" className="scc-row-head" onClick={() => more && setOpen((o) => !o)} aria-expanded={more ? open : undefined} disabled={!more}>
        <span className="scc-dot" aria-hidden="true" />
        <span className="scc-row-main">
          <span className="scc-row-title">{r.title || it.ref.raw}</span>
          <span className="scc-row-detail">{r.detail}</span>
        </span>
        <span className="scc-row-side">
          <span className="scc-verdict">{WORD[r.status] || WORD.unknown}</span>
          <span className="scc-src">{it.label}{r.source === 'archive' ? ' · copy' : ''}</span>
        </span>
      </button>
      {open && (
        <div className="scc-more">
          {(r.facts || []).map((f, i) => <p key={i} className="scc-fact">{f}</p>)}
          {(r.excerpts || []).map((e) => (
            <blockquote key={e.art} className="scc-quote"><strong>Art. {e.art}</strong> {e.text}</blockquote>
          ))}
        </div>
      )}
    </li>
  );
}

export default function SourcesCheckCard({ report, pending, at }) {
  if (pending) {
    const stale = at && Date.now() - at > STALE_MS;
    return (
      <div className="scc is-pending">
        <div className="scc-head">
          <span className={`scc-spin${stale ? ' is-still' : ''}`} aria-hidden="true" />
          <span className="scc-title">{stale ? 'The check against the sources was interrupted' : 'Checking against the official sources…'}</span>
        </div>
      </div>
    );
  }
  if (!report) {
    return (
      <div className="scc">
        <div className="scc-head"><span className="scc-title">The sources couldn’t be checked.</span></div>
      </div>
    );
  }
  const { items = [], waiting = [], counts = {} } = report;
  const bad = (counts.warn || 0) + (counts.error || 0);
  const title = !items.length
    ? 'Nothing in this version for the sources to check'
    : bad
      ? `${bad} thing${bad === 1 ? '' : 's'} the sources disagree with`
      : `Checked against the sources — ${items.length} confirmed`;
  return (
    <div className={`scc${bad ? ' has-issues' : ''}`}>
      <div className="scc-head">
        <span className="scc-badge" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            {bad ? <><path d="M12 8v5" /><path d="M12 16.5h.01" /><circle cx="12" cy="12" r="9" /></> : <path d="M5 12.5l4.5 4.5L19 7.5" />}
          </svg>
        </span>
        <span className="scc-title">{title}</span>
      </div>
      {items.length > 0 && <ul className="scc-list">{items.map((it, i) => <Row key={`${it.source}:${it.ref.key}:${i}`} it={it} />)}</ul>}
      {waiting.length > 0 && (
        <div className="scc-waiting">
          <p className="scc-waiting-head">Waiting for platforms not connected yet</p>
          {waiting.map((w) => (
            <p key={w.source} className="scc-waiting-row">
              <strong>{w.label}</strong> — {w.refs.slice(0, 4).join(', ')}{w.refs.length > 4 ? ` +${w.refs.length - 4}` : ''}
              {w.plan ? <span className="scc-plan"> · {w.plan}</span> : null}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
