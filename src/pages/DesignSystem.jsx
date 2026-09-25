import React, { useCallback, useEffect, useMemo, useState } from 'react';
import './DesignSystem.css';
// The real recipes the gallery stands still: the Legislation tab bar and its
// controls, the Legislation page's rows, tags, menu and sections, the CAEN
// callouts and trail pills, the placeholder's empty state.
import '../components/LegalTabs.css';
import '../components/LegalBar.css';
import './Legislation.css';
import './Caen.css';
import './LegalSourceStub.css';
import PageMasthead from '../components/PageMasthead';
import FilterTabs from '../components/FilterTabs';
import Tooltip from '../components/Tooltip';
import {
  DS_TOKENS, DS_FAMILIES, tokenKey, currentValue, loadOverrides, saveOverrides, onDesignChange,
  overridesToCss, askDesign,
} from '../lib/designSystem';

// The Design system tab — every element the app's chrome is built from,
// constructed here from the SAME tokens the real tabs read, so what is
// changed here changes everywhere at once. Three sections: the families and
// their rules; the AI composer and the token table (the two ways to change
// a token); the gallery, stamped with the family being looked at.
//
// The rules the elements follow are the user's: PERSONAL tabs follow the
// Legislation tab (legislatie.just.ro) and the Newsletter, PROJECT tabs the
// Files tab, the DOC VIEWER the Word document open in it — every section of
// the sidebar built from the same base elements, differing only in the
// family tokens. See styles/designSystem.css and lib/designSystem.js.

const SparkIcon = (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" /><path d="M19 17l.8 2.2L22 20l-2.2.8L19 23l-.8-2.2L16 20l2.2-.8z" />
  </svg>
);
const UndoIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M9 14L4 9l5-5" /><path d="M4 9h11a5 5 0 0 1 0 10h-3" />
  </svg>
);
const CopyIcon = (
  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a1 1 0 0 1 1-1h10" />
  </svg>
);
const SearchGlyph = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <circle cx="11" cy="11" r="7" /><path d="M20 20l-3.6-3.6" />
  </svg>
);
const BinIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 7h16" /><path d="M10 11v6M14 11v6" /><path d="M6 7l1 13h10l1-13" /><path d="M9 7V4h6v3" />
  </svg>
);

const FAMILY_IDS = ['personal', 'project', 'viewer'];
const GROUPS = ['Bars', 'Controls', 'Type', 'Pills and tags', 'Surfaces', 'Families'];

export default function DesignSystem() {
  const [over, setOver] = useState(loadOverrides);
  const [family, setFamily] = useState('personal');
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [proposal, setProposal] = useState(null); // { changes, note } | { error }
  const [copied, setCopied] = useState(false);

  useEffect(() => onDesignChange((o) => setOver(o)), []);

  const setToken = useCallback((t, value) => {
    const next = { ...loadOverrides() };
    const k = tokenKey(t);
    if (!value || value === t.value) delete next[k]; else next[k] = value;
    setOver(saveOverrides(next));
  }, []);
  const resetAll = useCallback(() => setOver(saveOverrides({})), []);

  const ask = useCallback(async () => {
    const p = prompt.trim();
    if (!p || busy) return;
    setBusy(true); setProposal(null);
    const res = await askDesign(p, loadOverrides());
    setBusy(false);
    setProposal(res);
  }, [prompt, busy]);

  const applyProposal = useCallback(() => {
    if (!proposal?.changes) return;
    const next = { ...loadOverrides() };
    for (const [k, v] of Object.entries(proposal.changes)) {
      const t = DS_TOKENS.find((x) => tokenKey(x) === k);
      if (!t) continue;
      if (v === t.value) delete next[k]; else next[k] = v;
    }
    setOver(saveOverrides(next));
    setProposal(null);
    setPrompt('');
  }, [proposal]);

  const css = useMemo(() => overridesToCss(over), [over]);
  const copyCss = async () => {
    try { await navigator.clipboard.writeText(css); setCopied(true); setTimeout(() => setCopied(false), 1600); } catch { /* refused */ }
  };
  const changed = Object.keys(over).length;

  return (
    <div className="dsg-page">
      <PageMasthead
        eyebrow="System"
        eyebrowMuted="On this device"
        title="Design system."
        actions={(
          <div className="dsg-actions">
            <Tooltip content="Copy the overrides as CSS, to carry them into styles/designSystem.css">
              <button type="button" className="dsg-btn" onClick={copyCss}>{CopyIcon}<span>{copied ? 'Copied' : 'Export CSS'}</span></button>
            </Tooltip>
            <Tooltip content={changed ? `Put every token back to the app’s default (${changed} changed)` : 'Every token is at its default'}>
              <button type="button" className="dsg-btn is-danger" onClick={resetAll} disabled={!changed}><span className="lgt-tool-ico">{UndoIcon}</span><span>Reset all</span></button>
            </Tooltip>
          </div>
        )}
      >
        Every element the app is built from — its bars, controls, pills, cards and mastheads — under one set of
        tokens. Change a token here, by hand or by asking, and every tab follows at once.
      </PageMasthead>

      {/* ── The families ─────────────────────────────────────────────── */}
      <section className="dsg-section">
        <div className="dsg-section-head">
          <div>
            <h2 className="dsg-h">One language, three families</h2>
            <p className="dsg-sub">
              Every section of the sidebar builds from the same elements. What differs is the family: the shape,
              density and treatment a section’s tabs share. Pick one to see the gallery in it.
            </p>
          </div>
          <div className="lgt-toggle" role="tablist" aria-label="Family">
            {FAMILY_IDS.map((f) => (
              <button key={f} type="button" role="tab" aria-selected={family === f} className={`lgt-toggle-btn${family === f ? ' is-on' : ''}`} onClick={() => setFamily(f)}>
                {DS_FAMILIES[f].label}
              </button>
            ))}
          </div>
        </div>
        <div className="dsg-families">
          {FAMILY_IDS.map((f) => (
            <div key={f} className={`dsg-family${family === f ? ' is-on' : ''}`} data-ds={f}>
              <p className="dsg-family-follows">Follows {DS_FAMILIES[f].follows}</p>
              <p className="dsg-family-name">{DS_FAMILIES[f].label}</p>
              <p className="dsg-family-rule">{DS_FAMILIES[f].rule}</p>
              <p className="dsg-family-tabs">{DS_FAMILIES[f].tabs}.</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── Ask the AI ───────────────────────────────────────────────── */}
      <section className="dsg-section">
        <div className="dsg-section-head">
          <div>
            <h2 className="dsg-h">Ask for a change</h2>
            <p className="dsg-sub">
              Say what should change, in plain words — “make the mini headers a little taller and rounder”, “tighten
              the project lists”, “the search box is too narrow”. The AI answers with the tokens it would change;
              nothing moves until you apply it.
            </p>
          </div>
        </div>
        <div className="dsg-ask">
          <div className="dsg-ask-row">
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="What should change across the app?"
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) ask(); }}
            />
            <button type="button" className="dsg-go" onClick={ask} disabled={busy || !prompt.trim()}>
              {SparkIcon}<span>{busy ? 'Thinking…' : 'Ask'}</span>
            </button>
          </div>
          {proposal?.error ? (
            <p className="dsg-err">
              {proposal.error === 'no_json' || proposal.error === 'bad_json'
                ? 'The AI did not answer with a change it could apply — try saying it another way.'
                : 'The AI could not be reached — sign in, and check the connection.'}
            </p>
          ) : null}
          {proposal?.changes ? (
            <div className="dsg-proposal">
              <p className="dsg-proposal-note">{proposal.note || 'Proposed changes:'}</p>
              {Object.keys(proposal.changes).length ? (
                <ul className="dsg-proposal-list">
                  {Object.entries(proposal.changes).map(([k, v]) => {
                    const t = DS_TOKENS.find((x) => tokenKey(x) === k);
                    return (
                      <li key={k}>
                        <code>{t ? t.label : k}{t?.family ? ` · ${DS_FAMILIES[t.family].label}` : ''}</code>
                        <span className="dsg-from">{t ? currentValue(t, over) : ''}</span>
                        <span className="dsg-to">{v}</span>
                      </li>
                    );
                  })}
                </ul>
              ) : <p className="dsg-sub">It found nothing to change for that.</p>}
              <div className="dsg-proposal-acts">
                <button type="button" className="dsg-btn is-primary" onClick={applyProposal} disabled={!Object.keys(proposal.changes).length}>Apply</button>
                <button type="button" className="dsg-btn" onClick={() => setProposal(null)}>Discard</button>
              </div>
            </div>
          ) : null}
        </div>
      </section>

      {/* ── The gallery ──────────────────────────────────────────────── */}
      <section className="dsg-section" data-ds={family}>
        <div className="dsg-section-head">
          <div>
            <h2 className="dsg-h">The elements — {DS_FAMILIES[family].label} family</h2>
            <p className="dsg-sub">
              Each one is the real recipe the tabs use, stood still, under the token that drives it. Where the real
              rules are bound to a page, the sample is built from the same tokens and says which recipe it mirrors.
            </p>
          </div>
        </div>
        <div className="dsg-gallery">
          <Sample name="Masthead" of="components/PageMasthead — eyebrow · title · kicker · actions" wide>
            <PageMasthead eyebrow="Eyebrow" eyebrowMuted="source: example.ro" title="A page title." compact={false} actions={<span className="dsg-status">Up to date</span>}>
              The sentence under the title: what the page is for, in one breath, at the kicker size.
            </PageMasthead>
          </Sample>

          <Sample name="Mini header" of="components/LegalTabs .lgt-bar (pinned) — the tab strip, then controls and search" wide>
            <div className="lgt-bar is-pinned">
              <div className="lgt-row">
                <FilterTabs tabs={[{ id: 'a', label: 'One' }, { id: 'b', label: 'Two' }, { id: 'c', label: 'Three' }]} active="a" onSelect={() => {}} ariaLabel="Sample tabs" />
              </div>
              <div className="lgt-line2">
                <div className="lgt-toggle" role="tablist" aria-label="Sample view">
                  <button type="button" role="tab" aria-selected className="lgt-toggle-btn is-on">List</button>
                  <button type="button" role="tab" className="lgt-toggle-btn">Picker</button>
                </div>
                <button type="button" className="lgt-tool-btn is-danger"><span className="lgt-tool-ico">{BinIcon}</span><span>Clear</span></button>
                <div className="lgt-search">
                  <span className="lgt-search-glyph">{SearchGlyph}</span>
                  <input placeholder="Any words" readOnly aria-label="Sample search" />
                  <span className="lgt-search-kbd"><kbd>Ctrl</kbd><kbd>F</kbd></span>
                </div>
              </div>
            </div>
          </Sample>

          <Sample name="Bottom bar" of="mirrors .fx-bottombar (Files) and .cn-bottombar (CAEN picker) — keys and actions" wide>
            <div className="dsg-bottombar">
              <span><kbd>↑↓</kbd> Select</span><span className="dsg-sep" />
              <span><kbd>→</kbd> <kbd>Enter</kbd> Forward</span><span className="dsg-sep" />
              <span><kbd>←</kbd> <kbd>Backspace</kbd> Back</span>
            </div>
          </Sample>

          <Sample name="Field row" of="components/LegalBar .lg-bar — dice · switch · picker · fields · note · go, joined (Legislation, Court files, ANAF)" wide>
            <div className="lg-bar">
              <button type="button" className="lg-random" aria-label="Random"><span className="lg-ico">{SearchGlyph}</span></button>
              <div className="lg-switch" role="tablist" aria-label="Sample switch">
                <button type="button" role="tab" aria-selected className="lg-input lg-seg is-on">Case files</button>
                <button type="button" role="tab" className="lg-input lg-seg">A court’s day</button>
              </div>
              <button type="button" className="lg-input is-kind lg-kind"><span className="lg-kind-label">Any kind</span><span className="lg-kind-chev" aria-hidden="true" /></button>
              <input className="lg-input is-num" placeholder="Number" readOnly aria-label="Number" />
              <input className="lg-input is-num" placeholder="Year" readOnly aria-label="Year" />
              <input className="lg-input is-date" type="date" readOnly aria-label="A day" />
              <span className="lg-input lg-note">3 CUIs · one request</span>
              <button type="button" className="lg-go"><span className="lg-ico">{SearchGlyph}</span><span>Search</span></button>
            </div>
          </Sample>

          <Sample name="Dropdown" of="components/LegalBar .lg-menu — the app’s own list, the chosen entry faded; a long list gets a narrowing box and headings">
            <div className="lg-menu is-long" style={{ position: 'static', width: 240 }}>
              <input className="lg-menu-find" placeholder="Type to narrow" readOnly aria-label="Narrow the sample list" />
              <ul className="lg-menu-list" role="listbox" aria-label="Sample kinds">
                <li className="lg-menu-head" role="presentation">Kinds</li>
                {['Any kind', 'Lege', 'Ordonanță de urgență', 'Hotărâre'].map((k, i) => (
                  <li key={k}><button type="button" role="option" aria-selected={i === 1} className={`lg-menu-item${i === 1 ? ' is-on' : ''}`}><span className="lg-menu-item-label">{k}</span>{i === 1 ? <span className="lg-menu-mark" aria-hidden="true" /> : null}</button></li>
                ))}
              </ul>
            </div>
          </Sample>

          <Sample name="Pills and tags" of=".lg-tag · .cn-tag · .cn-pill (trail) · tooltip pill · status pill" row>
            <span className="lg-tag">republicată</span>
            <span className="cn-tag is-old">Rev. 2</span>
            <span className="dsg-pill-still">A tooltip</span>
            <span className="dsg-status">Up to date</span>
            <button type="button" className="cn-pill is-live"><span className="cn-pill-kind">Section</span><span className="cn-pill-code">C</span><span className="cn-pill-name">Industria prelucrătoare</span></button>
          </Sample>

          <Sample name="Buttons" of=".dsg-btn · .lg-go · .lgt-tool-btn — plain, primary, danger, tool" row>
            <button type="button" className="dsg-btn">Plain</button>
            <button type="button" className="dsg-btn is-primary">Primary</button>
            <button type="button" className="dsg-btn is-danger">Danger</button>
            <button type="button" className="lgt-tool-btn"><span className="lgt-tool-ico">{BinIcon}</span><span>Tool button</span></button>
            <Tooltip content="A live tooltip — the cursor-following pill every hint uses"><button type="button" className="dsg-btn">Hover me</button></Tooltip>
          </Sample>

          <Sample name="List row" of="pages/Legislation .lg-row — kind · title · meta" wide>
            <ul className="lg-results" style={{ width: '100%', margin: 0, padding: 0 }}>
              <li className="lg-row">
                <button type="button" className="lg-row-main">
                  <span className="lg-row-kind">LEGE nr. 24/2000</span>
                  <span className="lg-row-title">privind normele de tehnică legislativă pentru elaborarea actelor normative</span>
                  <span className="lg-row-meta"><span>Parlamentul</span><span>Monitorul Oficial</span><span>în vigoare 2010-04-21</span><span className="lg-tag">republicată</span></span>
                </button>
              </li>
            </ul>
          </Sample>

          <Sample name="Section" of="pages/Legislation .lg-lib — a titled section with its sub-line and a control at the right">
            <section className="lg-lib">
              <header className="lg-lib-head">
                <div>
                  <p className="lg-lib-title">Recently viewed · 3</p>
                  <p className="lg-lib-sub">Every act you have opened, kept whole on this machine.</p>
                </div>
                <button type="button" className="lgt-tool-btn is-danger"><span className="lgt-tool-ico">{BinIcon}</span><span>Clear</span></button>
              </header>
              <p className="lg-note">Three acts kept.</p>
            </section>
          </Sample>

          <Sample name="Callouts" of="pages/Caen .cn-callout — a note; .is-old — a warning" stretch>
            <section className="cn-callout">
              <p className="cn-callout-title">In a document from before 2025, 6201 meant something else</p>
              <p className="cn-callout-body">In CAEN Rev. 2, 6201 was “Activități de realizare a soft-ului la comandă”.</p>
            </section>
            <section className="cn-callout is-old">
              <p className="cn-callout-title">No longer in force</p>
              <p className="cn-callout-body">CAEN Rev. 2 was replaced by Rev. 3 on 1 January 2025.</p>
            </section>
          </Sample>

          <Sample name="Empty state" of="pages/LegalSourceStub .lss-card — the Doc Viewer advisor’s empty state">
            <section className="lss-card">
              <span className="lss-mark" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="64" height="64" fill="none" stroke="currentColor" strokeWidth="1.15" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H14l6 6v8.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5z" /><path d="M14 4v6h6" /><path d="M8 13.5h7M8 16.5h4.5" />
                </svg>
              </span>
              <p className="lss-title">Nothing here yet</p>
              <p className="lss-plain">The sentence that says what will be here, and how to get it.</p>
            </section>
          </Sample>
        </div>
      </section>

      {/* ── The tokens ───────────────────────────────────────────────── */}
      <section className="dsg-section">
        <div className="dsg-section-head">
          <div>
            <h2 className="dsg-h">The tokens</h2>
            <p className="dsg-sub">
              Each one drives every instance of what it names. Type a value to change it app-wide, at once; the
              arrow puts it back. Family tokens are the only ones that differ between sections.
            </p>
          </div>
        </div>
        <div className="dsg-tokens">
          {GROUPS.map((g) => (
            <div key={g} className="dsg-group">
              <p className="dsg-group-name">{g}</p>
              {DS_TOKENS.filter((t) => t.group === g).map((t) => {
                const k = tokenKey(t);
                const v = over[k] || '';
                return (
                  <div key={k} className={`dsg-token${v ? ' is-set' : ''}`}>
                    <div className="dsg-token-label">
                      <strong>{t.label}{t.family ? <> <span className="dsg-token-fam">{DS_FAMILIES[t.family].label}</span></> : null}</strong>
                      <code>{t.name}</code>
                    </div>
                    <div className="dsg-token-drives">{t.drives}</div>
                    <input
                      className="dsg-token-input"
                      value={v}
                      placeholder={t.value}
                      aria-label={`${t.label}${t.family ? `, ${DS_FAMILIES[t.family].label}` : ''}`}
                      onChange={(e) => setToken(t, e.target.value)}
                      spellCheck={false}
                    />
                    <Tooltip content={v ? `Back to ${t.value}` : 'At its default'}>
                      <button type="button" className="dsg-token-reset" aria-label={`Reset ${t.label}`} disabled={!v} onClick={() => setToken(t, '')}>{UndoIcon}</button>
                    </Tooltip>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </section>

      {/* ── Export ───────────────────────────────────────────────────── */}
      <section className="dsg-section">
        <div className="dsg-section-head">
          <div>
            <h2 className="dsg-h">As CSS</h2>
            <p className="dsg-sub">
              What this device keeps, as the stylesheet a release would carry: paste it over the values in
              styles/designSystem.css to make it the app’s.
            </p>
          </div>
          <button type="button" className="dsg-btn" onClick={copyCss}>{CopyIcon}<span>{copied ? 'Copied' : 'Copy'}</span></button>
        </div>
        <pre className="dsg-css">{css}</pre>
      </section>
    </div>
  );
}

function Sample({ name, of, wide, row, stretch, children }) {
  return (
    <div className={`dsg-sample${wide ? ' is-wide' : ''}`}>
      <div className="dsg-sample-head">
        <p className="dsg-sample-name">{name}</p>
        <p className="dsg-sample-of">{of}</p>
      </div>
      <div className={`dsg-sample-frame${row ? ' is-row' : ''}${stretch ? ' is-stretch' : ''}`}>{children}</div>
    </div>
  );
}
