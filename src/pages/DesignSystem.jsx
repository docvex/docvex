import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './DesignSystem.css';
// The real recipes the gallery stands still: the Legislation tab bar and its
// controls, the Legislation page's rows, tags, menu and sections, the CAEN
// callouts and trail pills, the placeholder's empty state.
import '../components/LegalTabs.css';
import '../components/LegalBar.css';
import './Legislation.css';
import './Caen.css';
import './LegalSourceStub.css';
// The Doc Viewer's Quick actions tiles (components/DocRibbon), for the viewer sample.
import '../components/DocRibbon.css';
import PageMasthead from '../components/PageMasthead';
import FilterTabs from '../components/FilterTabs';
import Tooltip from '../components/Tooltip';
import HistoryButton from '../components/HistoryMenu';
import { WorkspaceSearchTab, WorkspaceRail } from '../components/LegalWorkspace';
import { BarDatePicker, BarDateRange, isoOf } from '../components/BarCalendar';
import { BarPicker } from '../components/LegalBar';
import { useOneOpen } from '../lib/oneOpen';
import DropZone from '../components/DropZone';
import Toggle from '../components/Toggle';
import SideDrawer from '../components/SideDrawer';
import RuleOptions from '../components/RuleOptions';
import AiChoices from '../components/AiChoices';
import '../components/AiChoices.css';
import { ICONS as AI_ICONS } from './Projects/aiHub';
import './Projects/ProjectAIChat.css';
import { ExtGlyph } from '../components/fileGlyph';
import { ENTITY_KINDS } from '../lib/docConstructor';
import DangerZone, { DangerRow } from '../components/DangerZone';
import { PLATFORMS, PLATFORM_ORDER } from '../lib/legalBrowser';
import { FACETS } from '../lib/legalSearch';
import '../components/LegalBrowser.css';
import '../components/DocConstructor.css';
import '../components/RefPill.css';
import '../components/useMorphPill.css';
import NotificationToast from '../components/NotificationToast';
import '../components/NotificationCenter.css';
import { TEST_NOTIFICATIONS } from '../notifications/testNotifications';
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

const GROUPS = ['Bars', 'Controls', 'Type', 'Pills and tags', 'Surfaces', 'Scrollbar', 'Page layout', 'Doc Viewer', 'Families'];

export default function DesignSystem() {
  const [over, setOver] = useState(loadOverrides);
  // One family for the whole app (lib/designSystem) — Project and Viewer were folded into it.
  const family = 'personal';
  const [sampleView, setSampleView] = useState('list');   // the Mini header sample's View dropdown
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
            <h2 className="dsg-h">One language</h2>
            <p className="dsg-sub">
              Every section of the sidebar and the Doc Viewer builds from the same elements, under the same rules:
              one family, rendered the same everywhere.
            </p>
          </div>
        </div>
        {/* The family's rule. */}
        <div className="dsg-families">
          <div className="dsg-family is-on" data-ds={family}>
            <p className="dsg-family-follows">Follows {DS_FAMILIES[family].follows}</p>
            <p className="dsg-family-name">{DS_FAMILIES[family].label}</p>
            <p className="dsg-family-rule">{DS_FAMILIES[family].rule}</p>
            <p className="dsg-family-tabs">{DS_FAMILIES[family].tabs}.</p>
          </div>
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
            <h2 className="dsg-h">The elements</h2>
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
                {/* The view — a dropdown (the bar's picker, on its own), as the
                    CAEN tab chooses List / Outline / Atlas. */}
                <BarPicker
                  solo
                  label="View"
                  options={[{ id: 'list', label: 'List' }, { id: 'picker', label: 'Picker' }]}
                  value={sampleView}
                  onChange={setSampleView}
                />
                <button type="button" className="lgt-tool-btn is-danger"><span className="lgt-tool-ico">{BinIcon}</span><span>Clear</span></button>
                <div className="lgt-search">
                  <span className="lgt-search-glyph">{SearchGlyph}</span>
                  <input placeholder="Any words" readOnly aria-label="Sample search" />
                  <span className="lgt-search-kbd"><kbd>Ctrl</kbd><kbd>F</kbd></span>
                </div>
              </div>
            </div>
          </Sample>

          <WorkspaceSample />

          <Sample name="Bottom bar" of="mirrors .fx-bottombar (Files), .cn-bottombar (CAEN picker) and the Advisor's composer — keys and actions" wide>
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

          <CalendarSamples />

          <DropdownSample />

          <ToggleSample />
          <ScrollbarSample />
          <SegmentedSample />
          <SideDrawerSample />

          <Sample name="Danger zone" of="components/DangerZone — DangerZone + DangerRow + .dz-btn (Account, Admin)" wide>
            <DangerZone subtitle="Irreversible actions. Proceed with care." className="dsg-dz">
              <DangerRow title="Erase data" desc="Clear the locally cached data on this machine.">
                <button type="button" className="dz-btn">Erase data</button>
              </DangerRow>
              <DangerRow title="Delete account" desc="Permanently remove the account. This cannot be undone.">
                <button type="button" className="dz-btn">Delete account</button>
              </DangerRow>
            </DangerZone>
          </Sample>

          <Sample name="Buttons" of=".dsg-btn · .lg-go · .lgt-tool-btn — plain, primary, danger, tool" row>
            <button type="button" className="dsg-btn">Plain</button>
            <button type="button" className="dsg-btn is-primary">Primary</button>
            <button type="button" className="dsg-btn is-danger">Danger</button>
            <button type="button" className="lgt-tool-btn"><span className="lgt-tool-ico">{BinIcon}</span><span>Tool button</span></button>
            <Tooltip content="A live tooltip — the cursor-following pill every hint uses"><button type="button" className="dsg-btn">Hover me</button></Tooltip>
          </Sample>

          <Sample name="Portal buttons" of="lib/phoneUploadPage .btn — the phone upload page: primary, and FROSTED (Take a photo) over the spotlight background" wide>
            <div className="dsg-portal">
              <span className="dsg-portal-spot" aria-hidden="true" />
              <button type="button" className="dsg-pbtn is-primary">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 16V4" /><path d="m7 9 5-5 5 5" /><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" /></svg>
                Choose files
              </button>
              <button type="button" className="dsg-pbtn">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z" /><circle cx="12" cy="13" r="3.5" /></svg>
                Take a photo
              </button>
            </div>
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

          <LegalHighlightsSample />

          <PlatformColoursSample />

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

          <Sample name="Callouts" of="pages/Caen .cn-callout — on the page ground with a hairline, no fill; a tone dot says a note (accent) or a warning (.is-old)" stretch>
            <section className="cn-callout">
              <p className="cn-callout-title">In a document from before 2025, 6201 meant something else</p>
              <p className="cn-callout-body">In CAEN Rev. 2, 6201 was “Activități de realizare a soft-ului la comandă”.</p>
            </section>
            <section className="cn-callout is-old">
              <p className="cn-callout-title">No longer in force</p>
              <p className="cn-callout-body">CAEN Rev. 2 was replaced by Rev. 3 on 1 January 2025.</p>
            </section>
          </Sample>

          <DropZoneSample />

          {/* The Advisor's FILE PILLS (pages/Projects/ProjectAI.jsx,
              ProjectAIChat.css — the real classes): a file attached in the
              composer, with × to take it off, and the files a SENT message
              carries (`.is-static`, the accent tint) — the name as it was
              attached, a folder path included, cut with "…" at the pill's
              width, the whole of it on hover. */}
          <Sample name="File pills" of="pages/Projects/ProjectAI .aichat-attach-chip — attached in the composer (×), and on a sent message (.is-static)" wide>
            <div className="dsg-filepills">
              <p className="dsg-refs-label">In the composer · before sending</p>
              <div className="aichat-attachments dsg-filepills-row">
                {['WhatsApp Image 2026-09-20 at 20.44.jpg', 'WhatsApp Image 2026-09-20 at 20.44 (1).jpg', 'proprietara - unzipped/00000939-contract inchiriat Carmen Sylva 2025.docx'].map((n) => (
                  <span className="aichat-attach-chip" key={n}>
                    {AI_ICONS.file({ width: 13, height: 13 })}
                    <Tooltip content={n}><span className="aichat-attach-name">{n}</span></Tooltip>
                    <button type="button" className="aichat-attach-x" aria-label={`Remove ${n}`}>{AI_ICONS.x({ width: 12, height: 12 })}</button>
                  </span>
                ))}
              </div>
              <p className="dsg-refs-label">On a sent message</p>
              <div className="dsg-filepills-row">
                {['proprietara - unzipped/00000939-contract inchiriat Carmen Sylva 2025.docx', 'WhatsApp Image 2026-09-20 at 20.44.jpg'].map((n) => (
                  <span className="aichat-attach-chip is-static" key={n}>
                    {AI_ICONS.file({ width: 12, height: 12 })}
                    <Tooltip content={n}><span className="aichat-attach-name">{n}</span></Tooltip>
                  </span>
                ))}
              </div>
            </div>
          </Sample>

          {/* The CLICKABLE ANSWERS under an AI reply (components/AiChoices,
              lib/aiChoices — live): the options the reply offers, taken out
              of its text; pressing one sends it as the answer. Only the
              latest reply shows them, and they rest disabled while the AI is
              answering. */}
          <Sample name="Reply choices" of="components/AiChoices .ai-choice — an AI reply's options as buttons; a press sends it (disabled while answering)" wide>
            <div className="dsg-filepills">
              <p className="dsg-reply-text">Bună! Te ajut cu asta — iată niște exemple de opțiuni:</p>
              <AiChoices
                choices={['Redactează o somație de plată către Razvan Toma', 'Analizează contractul de închiriere – Apartament 21', 'Listează celelalte CNP-uri din dosar', 'Nu, mulțumesc']}
                onPick={() => {}}
              />
              <p className="dsg-refs-label">While the AI is answering</p>
              <AiChoices choices={['Da, fă asta', 'Nu']} disabled onPick={() => {}} />
            </div>
          </Sample>

          {/* What an AI reply CHANGED in the project's files (components/
              AiEdits, lib/aiFileEdits) — its classes held still: edited (with
              Undo, while the session holds the file's previous bytes), undone,
              and not changed (why). */}
          <Sample name="AI edit card" of="components/AiEdits .ai-edit — a change an AI reply proposes: proposed · Apply / Discard (nothing written before Apply), edited · Undo, undone, not changed" wide>
            <div className="ai-edits">
              <div className="ai-edit">
                <div className="ai-edit-head">
                  <span className="ai-edit-file">Contract vânzare.docx</span>
                  <span className="ai-edit-state">Proposed</span>
                  <button type="button" className="ai-edit-undo">Apply</button>
                  <button type="button" className="ai-edit-undo">Discard</button>
                </div>
                <div className="ai-edit-line">1 paragraph rewritten</div>
              </div>
              <div className="ai-edit">
                <div className="ai-edit-head">
                  <span className="ai-edit-file">PETRE LUCA-ANDREI.dvc</span>
                  <span className="ai-edit-state">Edited</span>
                  <button type="button" className="ai-edit-undo">Undo</button>
                </div>
                <div className="ai-edit-line">phone: 0745181520 → 0756711515</div>
                <div className="ai-edit-line">Telefon: 0745181520 → 0756711515</div>
              </div>
              <div className="ai-edit is-undone">
                <div className="ai-edit-head">
                  <span className="ai-edit-file">00000939-contract inchiriat Carmen Sylva 2025.docx</span>
                  <span className="ai-edit-state">Undone</span>
                </div>
                <div className="ai-edit-line">1 paragraph rewritten</div>
              </div>
              <div className="ai-edit is-error">
                <div className="ai-edit-head">
                  <span className="ai-edit-file">notes.txt</span>
                  <span className="ai-edit-state">Not changed</span>
                </div>
                <div className="ai-edit-line">The text to change was not found in the file.</div>
              </div>
            </div>
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

      {/* ── Page layout ───────────────────────────────────────────────────
          How a page stands beside the app sidebar — read off the Playbook and
          the Legislation tab, drawn from the Page layout tokens. */}
      <section className="dsg-section" data-ds={family}>
        <div className="dsg-section-head">
          <div>
            <h2 className="dsg-h">Page layout</h2>
            <p className="dsg-sub">
              How a page stands beside the app sidebar — its gaps, the header’s divider that the mini header
              takes over, a side list and the content — read off the Playbook and the Legislation tab and drawn
              here from the Page layout tokens, so a change to one moves the drawing and both tabs at once.
            </p>
          </div>
        </div>
        <div className="dsg-gallery">
          <PageLayoutSample />
        </div>
      </section>

      {/* ── The Doc Viewer ────────────────────────────────────────────────
          The viewer window's chrome, read off the Word document's layout and
          drawn from the Doc Viewer tokens — the layout every kind of file now
          renders by. */}
      <section className="dsg-section" data-ds={family}>
        <div className="dsg-section-head">
          <div>
            <h2 className="dsg-h">DocVex file viewer</h2>
            <p className="dsg-sub">
              The viewer window as a Word document draws it — the floating side panel under its Quick actions card,
              the page list, the pills over the document, the counters at its foot — read off that layout into
              the Doc Viewer tokens, which every kind of file now renders by: the same cards, the same clearance,
              the find bar in the same corner, whatever is open.
            </p>
          </div>
        </div>
        <div className="dsg-gallery">
          <DocViewerSample over={over} />
        </div>
      </section>

      {/* ── Tooltips ─────────────────────────────────────────────────────
          Every way the custom tooltip renders — the Tooltip component and the
          morph pill (components/useMorphPill), stood still with their real
          classes: hover, the menu a right-click morphs it into, the confirm
          and prompt it morphs into after that, and the Doc Viewer's highlight
          tooltip and the CARD a click on a highlight expands it into. */}
      <section className="dsg-section" data-ds={family}>
        <div className="dsg-section-head">
          <div>
            <h2 className="dsg-h">Tooltips</h2>
            <p className="dsg-sub">
              The custom tooltip in every shape it takes. A pill one line tall has fully rounded ends; two lines or
              more, half the corner radius (measured). The morph pill grows out of the tooltip — into a menu on a
              right-click, then a confirmation or a prompt — and over a highlight in a Word document it describes the
              mark; clicking the mark expands it into its card.
            </p>
          </div>
        </div>
        <div className="dsg-gallery dsg-tips">
          <TooltipsSamples />
        </div>
      </section>

      {/* ── Notifications ────────────────────────────────────────────────
          The toast cards (components/NotificationToast — the real component)
          for every sample notification the app has (notifications/
          testNotifications: one per real notify() call site, every category
          and variant), held open (persistent) and stood in a grid. */}
      <section className="dsg-section" data-ds={family}>
        <div className="dsg-section-head">
          <div>
            <h2 className="dsg-h">Notifications</h2>
            <p className="dsg-sub">
              The notification cards that stack at the bottom right — on the tooltip's ground, a category-coloured
              left edge, the category's icon (or the file's thumbnail), the title, a line of detail and its actions.
              Every sample the app has, one per place that sends one; they stay put here instead of timing out.
            </p>
          </div>
        </div>
        <div className="dsg-gallery">
          <NotificationsSample />
        </div>
      </section>

      {/* ── Empty fields ─────────────────────────────────────────────────
          Every way a blank in a Word document is drawn: in the preview, once
          answered, and as the inputs of a picked paragraph. */}
      <section className="dsg-section" data-ds={family}>
        <div className="dsg-section-head">
          <div>
            <h2 className="dsg-h">Empty fields</h2>
            <p className="dsg-sub">
              How a blank in a Word document is drawn in the DocVex file viewer — an empty slot on the page (never a
              word in it, and never wider than the document measured), the states it goes through as it is answered,
              and the inputs it becomes when its paragraph is picked. The page is white in both themes, so these use
              the brand constants.
            </p>
          </div>
        </div>
        <div className="dsg-gallery">
          <EmptyFieldsSample />
        </div>
      </section>

      {/* ── Pills ────────────────────────────────────────────────────────
          Every pill in the app, in one place. They share ONE recipe — the
          same height, corners, type and weight — and differ only in tone:
          every one SOFT: a tinted ground, a ring in its tone, the text at
          full strength. */}
      <section className="dsg-section" data-ds={family}>
        <div className="dsg-section-head">
          <div>
            <h2 className="dsg-h">Pills</h2>
            <p className="dsg-sub">
              One shape for every pill: the same height, fully rounded, the tag size and weight. Every pill is
              soft — a tinted ground with a ring in its tone — so it reads on any row, and one that can be pressed
              deepens on hover. Tone is the only thing that changes.
            </p>
          </div>
        </div>
        <div className="dsg-gallery">
          <Sample name="Tags" of=".lg-tag (a note on an act) · .cn-tag (a revision) · .cn-tag.is-old (an old one) — soft" row>
            <span className="lg-tag">republicată</span>
            <span className="lg-tag">cu modificările ulterioare</span>
            <span className="cn-tag">Rev. 3</span>
            <span className="cn-tag is-old">Rev. 2</span>
          </Sample>
          <Sample name="Status" of=".dsg-status (a state) — soft, with its dot" row>
            <span className="dsg-status">Up to date</span>
          </Sample>
          <Sample name="Source status" of="components/LegalWorkspace SourceStatus .lgt-status-pill — soft, like the tags, and a button: live · from this machine · differs" row>
            <button type="button" className="lgt-status-pill is-live"><span>Live from legislatie.just.ro</span></button>
            <button type="button" className="lgt-status-pill is-archive"><span>From your copy on this machine</span></button>
            <button type="button" className="lgt-status-pill is-differs"><span>Differs from the portal - click to sync</span></button>
          </Sample>
          <Sample name="Tooltip pill" of="components/Tooltip — one line: fully rounded ends; TWO LINES OR MORE: half the corner radius. Every way it renders: the Tooltips section" row>
            <span className="dsg-pill-still">A tooltip</span>
            <span className="dsg-pill-still is-multiline">Sent 27.09.2026, 12:04{'\n'}Edited 27.09.2026, 12:10</span>
          </Sample>
          <Sample name="Choice pill — the two-line rule" of="components/AiChoices .ai-choice (Research's starters, reply choices) — ONE line: fully rounded ends; TWO LINES OR MORE: half the corner radius (a quarter of the one-line pill's height), measured (useMultilinePills → .is-multiline); every pill keeps its own height">
            <div style={{ maxWidth: 360 }}>
              <AiChoices
                choices={['Legea 31/1990', 'OUG 195/2002', 'Cum se face o notificare de reziliere a unui contract de închiriere?', 'Ce riscuri are clauza penală într-un contract comercial?']}
                onPick={() => {}}
                label="Sample pills"
              />
            </div>
          </Sample>
          <Sample name="Trail pill" of="pages/Caen .cn-pill — an ancestor in the CAEN trail, two lines" row>
            <button type="button" className="cn-pill"><span className="cn-pill-kind">Section</span><span className="cn-pill-code">C</span><span className="cn-pill-name">Industria prelucrătoare</span></button>
            <button type="button" className="cn-pill is-live"><span className="cn-pill-kind">Division</span><span className="cn-pill-code">10</span><span className="cn-pill-name">Industria alimentară</span></button>
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

// The CALENDAR (components/BarCalendar) — designed here, used by no tab yet:
// the single-date picker and the from–to picker drawn open, and the
// Legislation tab's bar as it would stand with a period in it (the dice,
// Kind, Number, Year, the period, Search), live — press the fields.
function CalendarSamples() {
  const [day, setDay] = useState(() => isoOf(new Date()));
  const [span, setSpan] = useState(() => {
    const t = new Date();
    return { from: isoOf(new Date(t.getFullYear(), t.getMonth(), 3)), to: isoOf(new Date(t.getFullYear(), t.getMonth(), 12)) };
  });
  const [barSpan, setBarSpan] = useState({ from: '', to: '' });
  const [barDay, setBarDay] = useState('');
  return (
    <>
      <Sample name="Date picker" of="components/BarCalendar BarDatePicker — the bar’s field, zz.ll.aaaa, the calendar hung under it (Monday first, today ringed, the day chosen filled)">
        <BarDatePicker value={day} onChange={setDay} inline />
      </Sample>
      <Sample name="Date range" of="components/BarCalendar BarDateRange — in steps: FROM alone, then TO alone, then the span — one calendar shaded when both ends share a month, two (FROM left, TO right, just the two days) when they don’t; Clear starts over" wide>
        <BarDateRange from={span.from} to={span.to} onChange={setSpan} inline />
      </Sample>
      <Sample name="Legislation bar, with dates" of="the Legislation bar (components/LegalBar) with a period and a day — press the fields; not yet on the tab" wide>
        <div className="lg-bar">
          <button type="button" className="lg-random" aria-label="Random"><span className="lg-ico">{SearchGlyph}</span></button>
          <button type="button" className="lg-input is-kind lg-kind"><span className="lg-kind-label">Any kind</span><span className="lg-kind-chev" aria-hidden="true" /></button>
          <input className="lg-input is-num" placeholder="Number" readOnly aria-label="Number" />
          <input className="lg-input is-num" placeholder="Year" readOnly aria-label="Year" />
          <BarDateRange from={barSpan.from} to={barSpan.to} onChange={setBarSpan} label="In force between" />
          <BarDatePicker value={barDay} onChange={setBarDay} label="Published on" placeholder="Published on" />
          <button type="button" className="lg-go"><span className="lg-ico">{SearchGlyph}</span><span>Search</span></button>
        </div>
      </Sample>
    </>
  );
}

// The WORKSPACE (components/LegalWorkspace) — the frame every Legislation
// source tab stands in, the Newsletter aside: Search and History heading the
// mini header's second line, the rail of what the tab has opened, the main
// column. Live: press an item, close one, press Search.
const WS_SAMPLE = [
  { id: 'a', kind: 'Lege', title: 'nr. 24/2000', tip: 'LEGE nr. 24/2000 — privind normele de tehnică legislativă' },
  { id: 'b', kind: 'Ordonanță de urgență', title: 'nr. 195/2002', tip: 'O.U.G. nr. 195/2002 — privind circulația pe drumurile publice' },
  { id: 'c', kind: 'Tribunalul Cluj', title: '1234/117/2026', tip: 'Dosarul 1234/117/2026' },
];
function WorkspaceSample() {
  const [items, setItems] = useState(WS_SAMPLE);
  const [active, setActive] = useState('a');
  const current = items.find((t) => t.id === active);
  return (
    <Sample name="Workspace" of="components/LegalWorkspace — Search + History, the rail of what is open, the main column (every Legislation tab but the Newsletter)" wide stretch>
      <div className="dsg-ws" style={{ '--lg-rail-w': '236px' }}>
        <div className="lgt-bar is-pinned">
          <div className="lgt-line2">
            <WorkspaceSearchTab active={active == null} onClick={() => setActive(null)} />
            <HistoryButton iconOnly className="lg-searchtab-hist" tab="design-system" tip="The tab's history" emptyText="Nothing here — this is a sample." onPick={() => {}} />
            <div className="lgt-search">
              <span className="lgt-search-glyph">{SearchGlyph}</span>
              <input placeholder={current ? 'Find in this act' : 'Any words'} readOnly aria-label="Sample search" />
            </div>
          </div>
        </div>
        <div className="lg-shell has-rail dsg-ws-shell">
          {items.length ? (
            <WorkspaceRail
              still
              pinned
              items={items}
              activeId={active}
              onSelect={setActive}
              onClose={(id) => { setItems((l) => l.filter((t) => t.id !== id)); if (id === active) setActive(null); }}
              label="Sample items"
            />
          ) : null}
          <div className="dsg-ws-main">
            {current ? (
              <>
                <p className="dsg-ws-kind">{current.kind} {current.title}</p>
                <p className="dsg-sample-note">{current.tip}. The item open fills the main column; Search puts it away and shows the search again.</p>
              </>
            ) : (
              <>
                <p className="dsg-ws-kind">The search</p>
                <p className="dsg-sample-note">
                  Search is lit: the search and its answers fill the main column. Everything opened stands in the rail,
                  which is not drawn while nothing is open.
                  {items.length < WS_SAMPLE.length ? <> <button type="button" className="dsg-btn" onClick={() => { setItems(WS_SAMPLE); setActive('a'); }}>Put the items back</button></> : null}
                </p>
              </>
            )}
          </div>
        </div>
      </div>
    </Sample>
  );
}

// The DROPDOWN, working: its field (the bar's Kind picker) expands and
// collapses the list under it, drawn in place rather than portalled so it
// stays in the gallery; a pick marks the entry and folds the list, the
// narrowing box narrows, Escape folds it.
const SAMPLE_KINDS = ['Any kind', 'Lege', 'Ordonanță de urgență', 'Hotărâre', 'Ordin', 'Decizie'];
function DropdownSample() {
  const [open, setOpen] = useState(false);   // closed when the tab opens
  const boxRef = useRef(null);
  // One open at a time, and a press outside the field and its list closes it.
  useOneOpen(open, () => setOpen(false), [boxRef]);
  const [value, setValue] = useState('Lege');
  const [q, setQ] = useState('');
  const shown = SAMPLE_KINDS.filter((k) => k.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <Sample name="Dropdown" of="components/LegalBar BarPicker — the field expands and collapses the app’s own list; the chosen entry marked; a long list gets a narrowing box and headings">
      <div className="dsg-dropdown" ref={boxRef} onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false); }}>
        <button
          type="button"
          className={`lg-input is-kind lg-kind is-solo${open ? ' is-open' : ''}`}
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          <span className="lg-kind-label">{value}</span>
          <span className="lg-kind-chev" aria-hidden="true" />
        </button>
        {open ? (
          <div className="lg-menu is-long is-solo is-placed dsg-dropdown-menu">
            <input className="lg-menu-find" placeholder="Type to narrow" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Narrow the sample list" />
            <ul className="lg-menu-list" role="listbox" aria-label="Sample kinds">
              <li className="lg-menu-head" role="presentation">Kinds</li>
              {shown.map((k) => (
                <li key={k}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={k === value}
                    className={`lg-menu-item${k === value ? ' is-on' : ''}`}
                    onClick={() => { setValue(k); setQ(''); setOpen(false); }}
                  >
                    <span className="lg-menu-item-label">{k}</span>
                    {k === value ? <span className="lg-menu-mark" aria-hidden="true" /> : null}
                  </button>
                </li>
              ))}
              {!shown.length ? <li className="lg-menu-head" role="presentation">Nothing matches</li> : null}
            </ul>
          </div>
        ) : null}
      </div>
    </Sample>
  );
}

// The DOC VIEWER (pages/DocViewer) — its chrome as a Word document draws it,
// stood still and built from the Doc Viewer tokens (the real rules are bound
// to the viewer window, whose stylesheet reads the same tokens with the same
// fallbacks): the Quick actions card and the side panel floating at the left,
// the page list, the zoom and find pills, a sheet, the counters. Under it,
// the values read off that layout.
const DV_TILES = [
  { id: 'pages', label: 'Pages', live: true },
  { id: 'fit', label: 'Fit', live: true },
  { id: 'counters', label: 'Counters', live: true },
  { id: 'focus', label: 'Focus', live: true },
  { id: 'laws', label: 'Laws', live: true },
  { id: 'edit', label: 'Edit photo' },
  { id: 'extract', label: 'Extract text' },
  { id: 'word', label: 'To Word' },
];
const DV_TABS = [
  { id: 'advisor', label: 'Advisor', live: true, on: true },
  { id: 'metadata', label: 'Data', live: true },
  { id: 'theme', label: 'Theme', live: true },
  { id: 'add', label: 'Structure', live: true },
  { id: 'extract', label: 'Extract' },
  { id: 'extracted', label: 'Pieces' },
  { id: 'captions', label: 'Captions' },
  { id: 'sources', label: 'Sources' },
];
const TileGlyph = (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="4" y="4" width="16" height="16" rx="3" /><path d="M8 12h8M12 8v8" />
  </svg>
);
function DocViewerSample({ over }) {
  const tokens = DS_TOKENS.filter((t) => t.group === 'Doc Viewer');
  return (
    <>
      <Sample name="Viewer window" of="pages/DocViewer — the Word document's layout: .dv-quick-card · .dv-advisor-card · .dv-pagerail-card · .dv-find · .dv-zoom-controls · .dv-doc-counter, from the --ds-dv-* tokens" wide>
        <div className="dsg-dv" role="img" aria-label="The Doc Viewer window as a Word document draws it">
          <div className="dsg-dv-side">
            <aside className="dsg-dv-card dsg-dv-quick">
              <h3 className="drb-quick-title">Quick actions</h3>
              <div className="drb-actions">
                {DV_TILES.map((t) => (
                  <span key={t.id} className={`drb-action${t.live ? '' : ' is-unavailable'}`}>
                    <span className="drb-action-icon">{TileGlyph}</span>
                    <span className="drb-action-label">{t.label}</span>
                  </span>
                ))}
              </div>
            </aside>
            <aside className="dsg-dv-card dsg-dv-panel">
              <div className="dsg-dv-tabs">
                {DV_TABS.map((t) => (
                  <span key={t.id} className={`dsg-dv-tab${t.on ? ' is-on' : ''}${t.live ? '' : ' is-unavailable'}`}>{t.label}</span>
                ))}
              </div>
              <div className="dsg-dv-panel-body">
                <span className="dsg-dv-line" style={{ width: '70%' }} />
                <span className="dsg-dv-line" style={{ width: '52%' }} />
                <span className="dsg-dv-line" style={{ width: '61%' }} />
              </div>
              <div className="dsg-dv-composer"><span>Ask about this document</span></div>
            </aside>
          </div>
          <div className="dsg-dv-doc">
            <aside className="dsg-dv-card dsg-dv-rail">
              <h3 className="drb-quick-title">Pages</h3>
              <div className="dsg-dv-thumbs">
                <span className="is-current" /><span /><span />
              </div>
            </aside>
            <div className="dsg-dv-pill dsg-dv-zoom"><span className="dsg-dv-zoom-btn">−</span><span className="dsg-dv-pct">100%</span><span className="dsg-dv-zoom-btn">+</span></div>
            <div className="dsg-dv-pill dsg-dv-find">{SearchGlyph}<span>Find in the document</span></div>
            <div className="dsg-dv-sheet">
              <span className="dsg-dv-line is-title" style={{ width: '46%' }} />
              <span className="dsg-dv-line" style={{ width: '92%' }} />
              <span className="dsg-dv-line" style={{ width: '88%' }} />
              <span className="dsg-dv-line" style={{ width: '95%' }} />
              <span className="dsg-dv-line" style={{ width: '60%' }} />
            </div>
            <div className="dsg-dv-pill dsg-dv-counter">Page 1 of 3</div>
            <div className="dsg-dv-pill dsg-dv-words">412 words</div>
          </div>
        </div>
        <dl className="dsg-dv-values" aria-label="The values read off the Word layout">
          {tokens.map((t) => (
            <div key={t.name} className={`dsg-dv-value${over?.[tokenKey(t)] ? ' is-set' : ''}`}>
              <dt>{t.label}</dt>
              <dd>{currentValue(t, over)}</dd>
            </div>
          ))}
        </dl>
        <p className="dsg-sample-note">
          Read off the Word document’s viewer: the panel’s width, the cards’ inset, corner, frost and blur, the
          document’s clearance, the page list, the pills’ button, glass and blur, the open find bar, the counters’
          type. Every kind of file — PDF, picture, video, audio, text, slides, sheets, records — now draws its
          chrome from these; edit them in the table below.
        </p>
      </Sample>
    </>
  );
}

// The DROP ZONE (components/DropZone) — the file import surface the Timeline,
// the Playbook and an identity record's Sources tab share: the full panel
// and, once there is something under it, the compact row. Live: drop files
// on it or press Import — they are only named here, never read or kept.
function DropZoneSample() {
  const [picked, setPicked] = useState([]);
  const take = (files) => {
    const names = Array.from(files || []).map((f) => f.name).filter(Boolean);
    if (names.length) setPicked((l) => [...l, ...names].slice(-6));
  };
  return (
    <Sample name="Drop zone" of="components/DropZone .cto-dropzone — file import: drop or Import; compact once something is listed under it (Timeline, Playbook, record sources)" wide stretch>
      <DropZone
        title="Drop files here"
        sub="Any file — here they are only named, never read or kept."
        onFiles={take}
      />
      <DropZone
        compact
        title="Drop more files here"
        sub="The compact row a zone collapses into once it has something to show."
        onFiles={take}
      >
        {picked.length ? (
          <p className="dsg-sample-note">Dropped: {picked.join(', ')}{' '}
            <button type="button" className="dsg-btn" onClick={() => setPicked([])}>Clear</button>
          </p>
        ) : null}
      </DropZone>
    </Sample>
  );
}

// The page's layout, drawn from the Page layout tokens: the window edge, the
// app sidebar, the header with its divider pulled out toward the sidebar,
// a side list and the content under it — each measure labelled with its
// token, then the rules in words.
const PAGE_RULES = [
  ['Window edge', '--ds-page-inset', 'The app sidebar keeps this gap from the window’s top, left and bottom. The same gap is where a sticky header or side list sticks under the top of the page, and how far above the window’s bottom a side list ends.'],
  ['Content', '--ds-content-gap', 'A page’s content — its text, headings and fields — starts this far from the sidebar, and keeps the same on its right. On a wide window it stops at the content width (--ds-content-max — the old 3/4 rule), left-aligned; controls standing beside a document may run past it.'],
  ['Header divider', '--ds-divider-pull', 'The hairline under a page’s header is pulled out toward the sidebar by the content gap less the gap from the sidebar, so it starts one --ds-rail-gap from the sidebar while the header’s text stays on the content edge. The mini header that takes over when the page scrolls stands in the same place: --ds-rail-gap from the sidebar, --ds-page-inset under the top, --ds-bar-h tall, its hairline on this line, frosted only while it is stuck.'],
  ['Under the header', '--ds-head-gap', 'Whatever stands under the divider — the side list and the content — starts this far below it.'],
  ['Side list', '--ds-list-w · --ds-list-gap', 'A side list is --ds-list-w wide, its left edge on the divider’s left end (its items padded back onto the content edge), --ds-list-gap from the content beside it. It is sticky: it holds --ds-page-inset under the top once the header has scrolled away, and ends --ds-page-inset above the window’s bottom, as the sidebar does; its items scroll inside it.'],
  ['Content column', '--ds-list-gap · --ds-page-foot', 'Beside a side list the content keeps --ds-list-gap on its right too, so both its sides match. The air at the end of the page (--ds-page-foot) is inside the content’s last section — nothing stands below it, so a sticky side list is never pushed up at the end of the scroll.'],
];
function PageLayoutSample() {
  return (
    <Sample name="A page" of="the Playbook · the Legislation tabs — the Page layout tokens, to scale" wide>
      <div className="dsg-pl" aria-hidden="true">
        <div className="dsg-pl-sidebar"><span className="dsg-pl-tag">App sidebar</span></div>
        <div className="dsg-pl-page">
          <div className="dsg-pl-head">
            <span className="dsg-pl-eyebrow" />
            <span className="dsg-pl-title" />
            <span className="dsg-pl-line" />
            <span className="dsg-pl-tag is-divider">Header divider · pulled by --ds-divider-pull</span>
          </div>
          <div className="dsg-pl-body">
            <div className="dsg-pl-list">
              <span className="dsg-pl-tag">Side list · --ds-list-w</span>
              <span className="dsg-pl-item is-on" />
              <span className="dsg-pl-item" />
              <span className="dsg-pl-item" />
            </div>
            <div className="dsg-pl-content">
              <span className="dsg-pl-tag">Content</span>
              <span className="dsg-pl-line is-wide" />
              <span className="dsg-pl-line" />
              <span className="dsg-pl-line is-wide" />
              <span className="dsg-pl-line is-short" />
            </div>
          </div>
          <span className="dsg-pl-measure is-gap">--ds-content-gap</span>
          <span className="dsg-pl-measure is-head">--ds-head-gap</span>
          <span className="dsg-pl-measure is-listgap">--ds-list-gap</span>
        </div>
      </div>
      <ol className="dsg-pl-rules">
        {PAGE_RULES.map(([name, token, text]) => (
          <li key={name}>
            <span className="dsg-pl-rule-name">{name}</span>
            <code>{token}</code>
            <p>{text}</p>
          </li>
        ))}
      </ol>
    </Sample>
  );
}

// The Toggle (components/Toggle — the Playbook's Preview switch), live.
function ToggleSample() {
  const [on, setOn] = useState(true);
  const [off, setOff] = useState(false);
  return (
    <Sample name="Toggle" of="components/Toggle .tgl — on / off with its label (the Playbook's Preview)" row>
      <Toggle on={on} onChange={setOn} label="Preview" />
      <Toggle on={off} onChange={setOff} label="Preview" />
    </Sample>
  );
}

// THE SCROLLBAR — every scrollbar in the app is ONE recipe (index.css's
// ::-webkit-scrollbar rules + the overlay thumbs of the chat thread and the
// Doc Viewer), built from the Scrollbar tokens (--ds-scrollbar-*): change one
// in the token table and every scrollbar follows. Drawn live: a list that
// scrolls down and a strip that scrolls sideways.
function ScrollbarSample() {
  const rows = Array.from({ length: 24 }, (_, i) => `Row ${i + 1} — scroll to see the thumb`);
  return (
    <Sample name="Scrollbar" of="index.css ::-webkit-scrollbar + the overlay thumbs — tokens --ds-scrollbar-size / -radius / -min / -thumb / -thumb-hover / -thumb-active / -track" row>
      <div className="dsg-scroll-box" tabIndex={0} aria-label="A list that scrolls">
        {rows.map((r) => <div key={r} className="dsg-scroll-row">{r}</div>)}
      </div>
      <div className="dsg-scroll-box is-x" tabIndex={0} aria-label="A strip that scrolls sideways">
        <div className="dsg-scroll-strip">{rows.slice(0, 12).map((r) => <span key={r} className="dsg-scroll-chip">{r.split(' —')[0]}</span>)}</div>
      </div>
    </Sample>
  );
}

// The SIDE DRAWER (components/SideDrawer — Research's drawer, the Playbook
// preview's recipe), live: it slides in from the right over the page; a press
// on this gallery leaves it open (keepOpenWithin), a row inside goes one view
// deeper and Back returns — the stack is the caller's, as in Research.
const DRAWER_SAMPLE_ROWS = [
  { id: 'a', kind: 'Lege', title: 'nr. 31/1990 — privind societățile comerciale' },
  { id: 'b', kind: 'Ordonanță de urgență', title: 'nr. 195/2002 — privind circulația pe drumurile publice' },
  { id: 'c', kind: 'Hotărâre', title: 'nr. 1383/2022 — pentru aprobarea normelor metodologice' },
];
function SideDrawerSample() {
  const [stack, setStack] = useState([]);
  const view = stack[stack.length - 1] || null;
  return (
    <Sample name="Side drawer" of="components/SideDrawer .sd-drawer — slides in from the right over the page; resizable by its left edge; Back, ×, Escape, a press outside (Research's drawer)" row>
      <button type="button" className="dsg-btn is-primary" onClick={() => setStack([{ id: 'list' }])}>Open the drawer</button>
      <button type="button" className="dsg-btn" onClick={() => setStack([{ id: 'list' }, DRAWER_SAMPLE_ROWS[0]])}>Open two views deep</button>
      <SideDrawer
        open={stack.length > 0}
        onClose={() => setStack([])}
        onBack={stack.length > 1 ? () => setStack((st) => st.slice(0, -1)) : null}
        title={view?.id === 'list' || !view ? 'Sample list' : view.kind}
        subtitle={view && view.id !== 'list' ? view.title.split(' — ')[0] : ''}
        widthKey="docvex:design:drawer-w"
        keepOpenWithin=".dsg-page"
        contentKey={view}
      >
        {!view || view.id === 'list' ? (
          <ul className="lgb-rows">
            {DRAWER_SAMPLE_ROWS.map((r) => (
              <li key={r.id} className="lgb-row">
                <button type="button" className="lgb-row-main" onClick={() => setStack((st) => [...st, r])}>
                  <span className="lgb-row-kind">{r.kind}</span>
                  <span className="lgb-row-title">{r.title}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <div>
            <p className="dsg-sample-name">{view.kind} {view.title}</p>
            <p className="dsg-sample-of">Anything can stand here — the component only draws the panel, its head (title, Back, ×) and the resize handle. Drag the left edge to resize it; double-click it for the default width.</p>
          </div>
        )}
      </SideDrawer>
    </Sample>
  );
}

// The segmented control (components/RuleOptions — the Playbook's Word
// settings, the Import window's route switch), live.
const ROUTE_SAMPLE = {
  label: 'How the phone sends',
  options: [
    { id: 'local', label: 'Local network', example: 'Same Wi-Fi — straight from the phone to this computer' },
    { id: 'cloud', label: 'DocVex cloud', example: 'Any connection — for a phone on mobile data or another network' },
  ],
};
function SegmentedSample() {
  const [route, setRoute] = useState('local');
  return (
    <Sample name="Segmented choice" of="components/RuleOptions .pbk-rule-opts — the Playbook's Word settings, the Import window's route switch" row>
      <RuleOptions field={ROUTE_SAMPLE} value={route} onPick={setRoute} />
    </Sample>
  );
}

// Every way text read as Romanian law is highlighted, stood side by side:
// the Word preview's marks (pages/DocViewer — act, CAEN, CUI, the internal
// cross-reference and where it lands), the same marks on a picture's
// extracted text, and the Legislation tab's pressable references + its find.
// The Doc Viewer's stylesheet is bound to its window, so its marks are
// mirrored in DesignSystem.css (.dsg-refdoc / .dsg-refs-photo) — keep them in
// step with DocViewer.css. The Legislation ones are the live .lg-ref / .lg-hit.
const REF_DOC_ROWS = [
  {
    name: 'Act or code',
    of: '.dv-lawref — AI gradient wash + rule, shimmering; toggled by the Laws action',
    body: <>potrivit <span className="dv-ref dv-lawref is-head is-tail">Legii nr. 31/1990 privind societățile</span>, republicată</>,
  },
  {
    name: 'Act split across Word runs',
    of: '.dv-ref.is-head / .is-tail — only the outer ends rounded',
    body: <>conform <span className="dv-ref dv-lawref is-head">art. 5 din </span><span className="dv-ref dv-lawref"><b>O.U.G.</b></span><span className="dv-ref dv-lawref is-tail"> nr. 195/2002</span></>,
  },
  {
    name: 'CAEN code',
    of: '.dv-caenref — flat amber stamp, solid rule, no motion; always on',
    body: <>având ca obiect principal <span className="dv-ref dv-caenref is-head is-tail">cod CAEN 6210</span></>,
  },
  {
    name: 'Fiscal code (CUI)',
    of: '.dv-cuiref — info colour, rule, hand cursor; opens ANAF',
    body: <>înregistrată sub <span className="dv-ref dv-cuiref is-head is-tail">CUI RO 14399840</span></>,
  },
  {
    name: 'Cross-reference · rest / hover / pressed',
    of: '.dv-xref · .is-hot · .is-press — a teal button, ringed edge by edge',
    body: (
      <>
        indicată la <span className="dv-ref dv-xref is-head is-tail">pct. 6.1. lit. d)</span>
        {' · '}<span className="dv-ref dv-xref is-head is-tail is-hot">clauza 4.3</span>
        {' · '}<span className="dv-ref dv-xref is-head is-tail is-press">art. 7</span>
      </>
    ),
  },
  {
    name: 'Where a cross-reference lands',
    of: '.has-xref-focus — everything but .is-xref-target (the clause and the item named) fades back',
    body: (
      <span className="dsg-refdoc-land has-xref-focus">
        <span>5.2. Plata se face în termen de 30 de zile de la emiterea facturii.</span>
        <span className="is-xref-target">6.1. Datele de contact ale părților sunt următoarele:</span>
        <span>c) telefon: 0722 000 000;</span>
        <span className="is-xref-target is-xref-exact">d) adresa de e-mail pentru notificări.</span>
        <span>6.2. Orice modificare se comunică în scris.</span>
      </span>
    ),
  },
];

function LegalHighlightsSample() {
  return (
    <Sample name="Legal highlights" of="lib/lawRefs — every mark drawn on text read as Romanian law" wide>
      <div className="dsg-refs">
        <p className="dsg-refs-label">Word preview · pages/DocViewer (mirrored)</p>
        <div className="dsg-refdoc">
          {REF_DOC_ROWS.map((r) => (
            <div key={r.name} className="dsg-refs-row">
              <div className="dsg-refs-meta"><span className="dsg-refs-name">{r.name}</span><code>{r.of}</code></div>
              <p className="dsg-refs-text">{r.body}</p>
            </div>
          ))}
        </div>

        <p className="dsg-refs-label">A picture's extracted text · TextRegionsLayer .dv-textword, over the photograph</p>
        <div className="dsg-refs-photo">
          <span className="dv-textword dv-lawref">Legea 31/1990</span>{' '}
          <span className="dv-textword dv-caenref">CAEN 4711</span>{' '}
          <span className="dv-textword dv-cuiref">CUI 2408422</span>
        </div>

        <p className="dsg-refs-label">Legislation tab · pages/Legislation .lg-ref and the find .lg-hit (live)</p>
        <div className="dsg-refs-row">
          <div className="dsg-refs-meta"><span className="dsg-refs-name">Act · rest / hover</span><code>.lg-ref — accent; opens the act here</code></div>
          <p className="dsg-refs-text">
            modificată prin <button type="button" className="lg-ref">Legea nr. 287/2009</button>
            {' · '}<button type="button" className="lg-ref dsg-ref-hover">O.U.G. nr. 195/2002</button>
          </p>
        </div>
        <div className="dsg-refs-row">
          <div className="dsg-refs-meta"><span className="dsg-refs-name">CAEN · court file · CUI</span><code>.lg-ref.is-caen · .is-case · .is-cui</code></div>
          <p className="dsg-refs-text">
            <button type="button" className="lg-ref is-caen">cod CAEN 6201</button>
            {' · '}<button type="button" className="lg-ref is-case">Dosarul nr. 1234/3/2022</button>
            {' · '}<button type="button" className="lg-ref is-cui">CUI 14399840</button>
          </p>
        </div>
        <div className="dsg-refs-row">
          <div className="dsg-refs-meta"><span className="dsg-refs-name">Find · match / current / inside a reference</span><code>.lg-hit · .is-current · .lg-ref .lg-hit</code></div>
          <p className="dsg-refs-text">
            <mark className="lg-hit">societate</mark> comercială, <mark className="lg-hit is-current">societate</mark> pe acțiuni,{' '}
            <button type="button" className="lg-ref">Legea <mark className="lg-hit">societăților</mark> nr. 31/1990</button>
          </p>
        </div>
      </div>
    </Sample>
  );
}

// ── The Notifications section ──────────────────────────────────────────────
// Every sample notification as the real toast, held open. A file notification
// with its thumbnail's glyph is added (the phone upload's arrival).
function NotificationsSample() {
  const list = React.useMemo(() => [
    ...TEST_NOTIFICATIONS.map((n, i) => ({ ...n, id: `dsg-toast-${i}`, persistent: true, createdAt: new Date().toISOString() })),
    { id: 'dsg-toast-file', category: 'file', variant: 'info', title: 'File arrived from your phone', body: 'scan-contract.pdf · 1.2 MB · waits in Documents', persistent: true, createdAt: new Date().toISOString(), payload: { thumbExt: 'pdf' } },
  ], []);
  return (
    <Sample name="Toast cards" of="components/NotificationToast — every sample in notifications/testNotifications, one per notify() call site" wide>
      <div className="dsg-toasts">
        {list.map((n) => <NotificationToast key={n.id} notification={n} />)}
      </div>
    </Sample>
  );
}

// ── The Tooltips section ───────────────────────────────────────────────────
// A pill, stood still: the real `.tooltip` / morph-pill classes, placed in the
// flow (.dsg-tips unpins them).
const Pill = ({ menu = false, multi = false, mod = '', children }) => (
  <div className={`tooltip project-files-morph-pill${menu ? ' is-menu' : ''}${multi ? ' is-multiline' : ''}${mod ? ` ${mod}` : ''}`} role="presentation">{children}</div>
);
// The Doc Viewer's highlight tooltip content (refPill), for a sample mark.
function RefPillSample({ tone, kind, head, lines = [], quote = '', action, full = false }) {
  return (
    <span className={`dv-refpill${full ? ' is-full' : ''}`} style={{ '--refpill-tone': tone }}>
      <span className="dv-refpill-kind">{kind}</span>
      <span className="dv-refpill-head">{head}</span>
      {lines.map((l) => <span key={l} className="dv-refpill-line">{l}</span>)}
      {quote ? <span className="dv-refpill-quote">“{quote}”</span> : null}
      <span className="dv-refpill-act">{action}</span>
    </span>
  );
}
const REF_HOVERS = [
  { name: 'Act', tone: 'var(--cat-update)', kind: 'legislatie.just.ro · Act', head: 'Legea nr. 31/1990', lines: ['privind societățile', 'republicată · cu modificările și completările ulterioare'] },
  { name: 'Article of an act', tone: 'var(--cat-update)', kind: 'legislatie.just.ro · Act', head: 'Legea nr. 287/2009', lines: ['art. 1.166 alin. (1)', 'privind Codul civil'] },
  { name: 'Code', tone: 'var(--cat-update)', kind: 'legislatie.just.ro · Code', head: 'Codul muncii', lines: [] },
  { name: 'CAEN code', tone: 'var(--warning)', kind: 'insse.ro · CAEN code', head: 'CAEN 6201', lines: ['6201 — Activități de realizare a soft-ului la comandă (software orientat client)'] },
  { name: 'CUI', tone: 'var(--success)', kind: 'anaf.ro · Fiscal code', head: 'CUI 14399840', lines: [] },
];
function TooltipsSamples() {
  return (
    <>
      <Sample name="Tooltip · one line" of="components/Tooltip — fully rounded ends" row>
        <Pill><span className="project-files-morph-text">Open in a new window</span></Pill>
        <Pill><span className="project-files-morph-text">Paragraph 6.1</span></Pill>
      </Sample>
      <Sample name="Tooltip · two lines or more" of=".tooltip.is-multiline — half the corner radius (measured)" row>
        <Pill multi><span className="project-files-morph-text">{'Sent 27.09.2026, 12:04\nEdited 27.09.2026, 12:10'}</span></Pill>
        <Pill multi><span className="project-files-morph-text">{'contract-vanzare.docx\nDiffers from the copy on your account'}</span></Pill>
      </Sample>
      <Sample name="Menu · a right-click" of="useMorphPill .is-menu — the tooltip morphs into it (FLIP)" row>
        <Pill menu>
          <ul className="project-files-morph-list">
            <li><button type="button" className="project-files-morph-item">Open</button></li>
            <li><button type="button" className="project-files-morph-item">Collapse</button></li>
            <li><button type="button" className="project-files-morph-item project-files-morph-item-parent">Move to<span className="project-files-morph-caret" aria-hidden="true" /></button></li>
            <li><button type="button" className="project-files-morph-item" disabled>Pop out</button></li>
            <li><button type="button" className="project-files-morph-item project-files-morph-item-danger">Delete</button></li>
          </ul>
        </Pill>
      </Sample>
      <Sample name="Confirm · danger" of=".is-menu.is-confirm.is-danger — a danger item asks first" row>
        <Pill menu mod="is-confirm is-danger">
          <div className="project-files-morph-confirm">
            <div className="project-files-morph-confirm-header">
              <span className="project-files-morph-confirm-header-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg>
              </span>
              <span className="project-files-morph-confirm-header-text">
                <span className="project-files-morph-confirm-header-title">Delete this file?</span>
                <span className="project-files-morph-confirm-header-subtitle">contract-vanzare.docx</span>
              </span>
            </div>
            <p className="project-files-morph-confirm-message">It goes to the Trash for 30 days.</p>
            <div className="project-files-morph-confirm-actions">
              <button type="button" className="project-files-morph-confirm-btn project-files-morph-confirm-btn-cancel">Cancel</button>
              <button type="button" className="project-files-morph-confirm-btn project-files-morph-confirm-btn-danger">Delete</button>
            </div>
          </div>
        </Pill>
      </Sample>
      <Sample name="Prompt" of=".is-menu.is-confirm.is-prompt — asks for a line of text" row>
        <Pill menu mod="is-confirm is-prompt">
          <div className="project-files-morph-confirm project-files-morph-prompt">
            <div className="project-files-morph-confirm-title">Reject this file?</div>
            <p className="project-files-morph-confirm-message">Say why — the phone shows it.</p>
            <textarea className="project-files-morph-prompt-input" rows={3} placeholder="Reason (optional)" readOnly />
            <div className="project-files-morph-confirm-actions">
              <button type="button" className="project-files-morph-confirm-btn project-files-morph-confirm-btn-cancel">Cancel</button>
              <button type="button" className="project-files-morph-confirm-btn project-files-morph-confirm-btn-primary">Reject</button>
            </div>
          </div>
        </Pill>
      </Sample>
      <Sample name="Over a highlight · hover" of="pages/DocViewer refPill — the platform in its colour, what is cited, what a click does (components/RefPill.css)" wide>
        <div className="dsg-tips-row">
          {REF_HOVERS.map((r) => (
            <Pill key={r.name} multi>
              <span className="project-files-morph-text"><RefPillSample {...r} action="Click for more — and to search it" /></span>
            </Pill>
          ))}
          <Pill><span className="project-files-morph-text">Go to 6.1 lit. d)</span></Pill>
        </div>
      </Sample>
      <Sample name="A highlight clicked · its card" of="DocParaPill card — the tooltip expanded (sticky): all that is known, the citation as written, Search (a new Legislation tab, or the one showing it) and Close" wide>
        <div className="dsg-tips-row">
          <Pill menu>
            <div className="dv-refcard">
              <RefPillSample full tone="var(--cat-update)" kind="legislatie.just.ro · Act" head="Legea nr. 31/1990"
                lines={['privind societățile', 'republicată · cu modificările și completările ulterioare']}
                quote="Legii nr. 31/1990 privind societățile, republicată, cu modificările și completările ulterioare"
                action="Search finds it on legislatie.just.ro, in a new tab" />
            </div>
            <ul className="project-files-morph-list">
              <li><button type="button" className="project-files-morph-item dv-refcard-search">Search</button></li>
              <li><button type="button" className="project-files-morph-item">Close</button></li>
            </ul>
          </Pill>
          <Pill menu>
            <div className="dv-refcard">
              <RefPillSample full tone="var(--warning)" kind="insse.ro · CAEN code" head="CAEN 6202, CAEN 6209"
                lines={['6202 — Activități de consultanță în tehnologia informației', '6209 — Alte activități de servicii privind tehnologia informației']}
                quote="CAEN 6202, 6209"
                action="Search opens it in CAEN codes, in a new tab" />
            </div>
            <ul className="project-files-morph-list">
              <li><button type="button" className="project-files-morph-item dv-refcard-search">Search</button></li>
              <li><button type="button" className="project-files-morph-item">Close</button></li>
            </ul>
          </Pill>
          <Pill menu>
            <div className="dv-refcard">
              <RefPillSample full tone="var(--success)" kind="anaf.ro · Fiscal code" head="CUI 14399840"
                lines={['A valid fiscal code — its check digit is correct']}
                action="Search looks the company up at ANAF, in a new tab" />
            </div>
            <ul className="project-files-morph-list">
              <li><button type="button" className="project-files-morph-item dv-refcard-search">Search</button></li>
              <li><button type="button" className="project-files-morph-item">Close</button></li>
            </ul>
          </Pill>
        </div>
      </Sample>
    </>
  );
}

// The blanks of a Word document, as the viewer draws them. The page rules are
// MIRRORED from pages/DocViewer.css under .dsg-fieldsdoc (that stylesheet is
// bound to the viewer window); the picked paragraph's inputs are
// DocConstructor.css's own .dcx-inline, live.
const CHIP = (w) => '_'.repeat(w);
const FIELD_ROWS = [
  {
    name: 'Empty blank',
    of: '.dv-field.is-chip — the slot, as long as what goes there',
    body: <>Vânzătorul, <span className="dv-field is-chip" data-label={CHIP(22)} data-hint="Nume / denumire">[[vanzator.legalName]]</span>, cu sediul în <span className="dv-field is-chip" data-label={CHIP(16)} data-hint="Adresă">[[vanzator.address]]</span>.</>,
  },
  {
    name: '… in a paragraph under the pointer',
    of: '.dv-docx-para:hover .dv-field.is-chip — the slot deepens',
    body: <span className="dv-docx-para is-hover">Cumpărătorul, <span className="dv-field is-chip" data-label={CHIP(22)} data-hint="Nume / denumire">[[cumparator.legalName]]</span>, CUI <span className="dv-field is-chip" data-label={CHIP(10)} data-hint="CUI">[[cumparator.cui]]</span>.</span>,
  },
  {
    name: 'Word’s own blank',
    of: '.dv-field.is-drawn — underlined spaces the template drew; a tint, never a second rule',
    body: <>Încheiat astăzi, <span className="dv-field is-drawn dsg-drawn">{' '.repeat(18)}</span>, la <span className="dv-docx-para is-hover"><span className="dv-field is-drawn dsg-drawn">{' '.repeat(14)}</span></span> (hover).</>,
  },
  {
    name: 'A blank shown as its text',
    of: '.dv-field — lighter text on a dotted cognac rule',
    body: <>Prețul este de <span className="dv-field">_______</span> lei, plătibil la data de <span className="dv-field">…………</span>.</>,
  },
  {
    name: 'Filled',
    of: '.dv-field.is-filled — an answer keeps its mark down the page',
    body: <>Vânzătorul, <span className="dv-field is-filled">SC ALFA DISTRIBUȚIE SRL</span>, cu sediul în <span className="dv-field is-filled">Cluj-Napoca</span>.</>,
  },
  {
    name: 'Previewing a party',
    of: '.dv-field.is-preview — borrowed text under a dashed accent rule',
    body: <>Cumpărătorul, <span className="dv-field is-preview">Ion Popescu</span>, domiciliat în <span className="dv-field is-preview">București, Sectorul 4</span>.</>,
  },
  {
    name: 'In the picked paragraph',
    of: '.dv-docx-para.is-selected — filled restated; .is-active the blank being worked on',
    body: <span className="dv-docx-para is-selected">Termenul este de <span className="dv-field is-filled">30 de zile</span>, penalitatea de <span className="dv-field is-active">________</span>, dobânda <span className="dv-field is-active is-filled">0,1% pe zi</span>.</span>,
  },
];
// The picked paragraph's AUTOFILL (components/DocConstructor, docked under the
// paragraph): per person, the kind switch and the data collections as files.
const SAMPLE_COLLECTIONS = [
  { kind: 'org', file: 'SC ALFA DISTRIBUTIE SRL.dvc', meta: 'Persoană juridică · RO 14399840' },
  { kind: 'org', file: 'BETA IMPEX SA.dvc', meta: 'Persoană juridică · RO 6859662' },
  { kind: 'pfa', file: 'Popescu Ion PFA.dvc', meta: 'PFA / II · 38912577' },
  { kind: 'person', file: 'Ion Popescu.dvc', meta: 'Persoană fizică · 1780512123456' },
  { kind: 'person', file: 'Maria Ionescu.dvc', meta: 'Persoană fizică · 2850304125789' },
];
const DSG_PEN = (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </svg>
);
const DSG_CHECK = (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <polyline points="20 6 9 17 4 12" />
  </svg>
);
function AutofillSample() {
  const [chosen, setChosen] = useState(0);
  // ONE choice per party: every data collection, as its file. The one picked
  // decides how the party's part is written (a company's also says who signs
  // for it and in what capacity).
  return (
    <div className="dsg-autofill">
      <div className="dcx-people">
        <div className="dcx-party-group">
          <section className="dcx-person">
            <header className="dcx-person-head"><span className="dcx-person-name">Parte1</span></header>
            <ul className="dcx-person-list">
              <li>
                <button type="button" className={`dcx-person-opt is-custom${chosen === -1 ? ' is-on' : ''}`} onClick={() => setChosen(-1)}>
                  <span className="dcx-person-av">{DSG_PEN}</span>
                  <span className="dcx-person-text">Custom</span>
                  <span className="dcx-person-mark">{DSG_CHECK}</span>
                </button>
              </li>
              {SAMPLE_COLLECTIONS.map((c, i) => (
                <li key={c.file}>
                  <button type="button" className={`dcx-person-opt${chosen === i ? ' is-on' : ''}`} onClick={() => setChosen(i)}>
                    <span className="dcx-person-file"><ExtGlyph ext="dvc" /></span>
                    <span className="dcx-person-text">
                      <span className="dcx-person-rec">{c.file}</span>
                      <span className="dcx-person-meta">{c.meta}</span>
                    </span>
                    <span className="dcx-person-mark">{DSG_CHECK}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}

function EmptyFieldsSample() {
  const crimson = '#9F1239';
  const blue = '#0369A1';
  return (
    <Sample name="Blanks" of="pages/DocViewer (mirrored) · components/DocConstructor .dcx-inline (live)" wide>
      <div className="dsg-refs">
        <p className="dsg-refs-label">On the page · the Word preview</p>
        <div className="dsg-fieldsdoc">
          {FIELD_ROWS.map((r) => (
            <div key={r.name} className="dsg-refs-row">
              <div className="dsg-refs-meta"><span className="dsg-refs-name">{r.name}</span><code>{r.of}</code></div>
              <p className="dsg-refs-text">{r.body}</p>
            </div>
          ))}
        </div>

        <p className="dsg-refs-label">A picked paragraph · its blanks become inputs in the sentence</p>
        <div className="dsg-fieldsdoc">
          <div className="dsg-refs-row">
            <div className="dsg-refs-meta"><span className="dsg-refs-name">Empty · filled</span><code>.dcx-inline — the placeholder says what goes there, in the document’s language</code></div>
            <p className="dsg-refs-text">
              Vânzătorul, <input className="dcx-inline" style={{ width: '22ch' }} placeholder="denumirea vânzătorului" readOnly />,
              {' '}cu sediul în <input className="dcx-inline is-filled" style={{ width: '12ch' }} defaultValue="Cluj-Napoca" readOnly />.
            </p>
          </div>
          <div className="dsg-refs-row">
            <div className="dsg-refs-meta"><span className="dsg-refs-name">Two people in one clause</span><code>.dcx-inline.is-party — each person’s blanks in their colour</code></div>
            <p className="dsg-refs-text">
              <input className="dcx-inline is-party is-filled" style={{ width: '16ch', '--dcx-party': crimson }} defaultValue="SC ALFA SRL" readOnly />,
              {' '}reprezentată prin <input className="dcx-inline is-party" style={{ width: '18ch', '--dcx-party': blue }} placeholder="numele reprezentantului" readOnly />,
              {' '}în calitate de <input className="dcx-inline is-party" style={{ width: '14ch', '--dcx-party': blue }} placeholder="calitatea" readOnly />.
            </p>
          </div>
        </div>

        <p className="dsg-refs-label">Highlights off · the eye quick action — every blank reads as the document wrote it</p>
        <div className="dsg-fieldsdoc is-plain">
          <div className="dsg-refs-row">
            <div className="dsg-refs-meta"><span className="dsg-refs-name">Empty · as text · filled</span><code>.dv-docx.is-plain .dv-field — no ground, no rule; a slot shows its underscores (fades with the marks, 280ms)</code></div>
            <p className="dsg-refs-text">
              Vânzătorul, <span className="dv-field is-chip" data-label={CHIP(22)} data-hint="Nume / denumire">[[vanzator.legalName]]</span>, prețul de <span className="dv-field">_______</span> lei,
              {' '}cu sediul în <span className="dv-field is-filled">Cluj-Napoca</span>.
            </p>
          </div>
        </div>

        <p className="dsg-refs-label">The picked paragraph’s autofill · docked under it — per party, the data collections that fill it (the one picked decides how the part is written)</p>
        <AutofillSample />

        <p className="dsg-refs-label">What is read as a blank · lib/docConstructor BLANK_PATTERNS — each is drawn as the slot above</p>
        <div className="dsg-fields-src">
          {['_____', '.........', '[_____]', '[.........]', '[[vanzator.legalName]]', '[Client name]', '{{nume}}', '……'].map((s) => <code key={s}>{s}</code>)}
          <span>and Word’s underlined spaces</span>
        </div>
      </div>
    </Sample>
  );
}

// Each platform's colour and the colours of its filters, read off the same
// data the Legislation tab uses (lib/legalBrowser PLATFORMS, lib/legalSearch
// FACETS) and drawn with its own recipes (.lgb-dot, .lgb-pill), so the sample
// cannot drift from what the tabs, results and scopes wear.
const toneName = (tone) => (tone || '').replace(/^var\((--[\w-]+)\)$/, '$1');
function PlatformColoursSample() {
  const rows = [
    { key: 'all', site: 'All platforms', name: 'Every connected platform at once', tone: 'var(--accent)' },
    ...PLATFORM_ORDER.map((k) => ({ key: k, site: PLATFORMS[k].site, name: PLATFORMS[k].name, tone: PLATFORMS[k].tone })),
  ];
  return (
    <Sample name="Platform colours" of="lib/legalBrowser PLATFORMS · lib/legalSearch FACETS — each platform's colour, then its filters as the result pills wear them" wide>
      <div className="dsg-refs">
        {rows.map((r) => (
          <div key={r.key} className="dsg-refs-row">
            <div className="dsg-refs-meta">
              <span className="dsg-plat-site" style={{ color: r.tone }}>
                <span className="lgb-dot" style={{ '--tone': r.tone }} />{r.site}
              </span>
              <span className="dsg-plat-name">{r.name}</span>
              <code>{toneName(r.tone)}</code>
            </div>
            <div className="dsg-plat-pills">
              {(FACETS[r.key] || []).filter((f) => f.id !== 'all').map((f) => (
                <Tooltip key={f.id} content={`${f.tip} · ${toneName(f.tone)}`}>
                  <span className="lgb-pill" style={{ '--pill-tone': f.tone }}>{f.label}</span>
                </Tooltip>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Sample>
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
