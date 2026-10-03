import React from 'react';
import { useLocation } from 'react-router-dom';
import './LegalSourceStub.css';
import LegalWorkspace from '../components/LegalWorkspace';
import { PLANNED_SOURCES as SOURCES } from '../lib/legalSources';

// The Legislation tab's sources that are not connected yet. One page for all
// of them: the masthead names the source, the card says how it would be
// reached and what it is for. Nothing is fetched — these exist so the tab
// shows every source the app is meant to read, not only the three it does.
// Connecting one = a real page on its route + dropping its `stub` flag in
// components/LegalTabs.

// The planned sources' facts live in lib/legalSources (Research's "i" reads
// them too).

const LEVEL = { critical: 'Critical', high: 'High', medium: 'Medium' };

export default function LegalSourceStub() {
  const { pathname } = useLocation();
  const src = SOURCES[pathname];
  if (!src) return null;
  return (
    // The Legislation tabs' workspace, as every connected source has it: Search
    // (lit — the search is all there would be to show) and History head the
    // bar's second line; nothing can be opened yet, so there is no rail.
    <LegalWorkspace
      className="lss-page"
      searchActive
    >
      {/* Drawn as the Doc Viewer advisor's empty state ("Ask about this
          document"): a bare thin-stroke mark, the sentence under it, nothing
          framed — centred across the page under the bar. */}
      <section className="lss-card">
        <span className="lss-mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="64" height="64" fill="none" stroke="currentColor" strokeWidth="1.15" strokeLinecap="round" strokeLinejoin="round">
            <path d="m19 5 3-3" />
            <path d="m2 22 3-3" />
            <path d="M6.3 20.3a2.4 2.4 0 0 0 3.4 0L12 18l-6-6-2.3 2.3a2.4 2.4 0 0 0 0 3.4Z" />
            <path d="M7.5 13.5 10 11" />
            <path d="M10.5 16.5 13 14" />
            <path d="m12 6 6 6 2.3-2.3a2.4 2.4 0 0 0 0-3.4l-2.6-2.6a2.4 2.4 0 0 0-3.4 0Z" />
          </svg>
        </span>
        {/* First: in plain words — that the page is not available, and what
            it will do. */}
        <p className="lss-title">Unavailable at the moment</p>
        <p className="lss-plain">{src.plain}</p>

        {/* Second: the technical part, folded away — how the source would be
            reached — and the uses as a row of pills. */}
        <div className="lss-tech">
          <details className="lss-more">
            <summary className="lss-more-head">
              <span>How it would connect</span>
              <svg className="lss-chev" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M6 9l6 6 6-6" />
              </svg>
            </summary>
            <p className="lss-access">{src.access}</p>
          </details>
          <ul className="lss-uses">
            {src.uses.map((u) => (
              <li key={u.text} className="lss-use">
                <span className={`lss-level is-${u.level}`}>{LEVEL[u.level]}</span>
                <span>{u.text}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>
    </LegalWorkspace>
  );
}
