import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import FilterTabs from './FilterTabs';
import MiniHeaderFade from './MiniHeaderFade';
import Tooltip from './Tooltip';
import './LegalTabs.css';

// The Legislation tab's own tab bar — the Activity tab's mini header, to the
// letter: a 40px bar under the masthead that pins at the top once the
// masthead scrolls away, holding a FilterTabs strip (one underline sliding
// between the tabs). Three sources sit behind one sidebar entry — the
// Newsletter, the legislative portal and the CAEN nomenclature — and each
// keeps its own route (the Doc Viewer and the Newsletter deep-link into
// `/caen?code=…` and `/legislation?tip=…`), so a tab is a navigation, not a
// state. A tab is named after where its data comes from.
// Labels say what each tab IS, set as the Activity tab's ("All", "Files"…);
// where the data comes from is on each page's masthead ("source: …").
export const LEGAL_TABS = [
  // Each tab is named for the SOURCE it reads (the site), as the user asked;
  // what each one is for is on its masthead. (The Newsletter was the first
  // tab; it is a sidebar entry of its own now and draws this bar with
  // `standalone` — its second line only.)
  // `short`: the name on an open item's small-caps line in the rail; `about`:
  // what the platform is, for the header's "i"; `tries`: what to type to reach
  // it through the one search (lib/legalOmni).
  { id: 'legislation', to: '/legislation', label: 'legislatie.just.ro', short: 'Legislație', about: 'Romanian legislation from the Ministry of Justice’s portal — every act, read here as a document and kept on this machine.', tries: ['Legea 287/2009', 'OUG 195/2002', 'protecția consumatorului'] },
  { id: 'caen', to: '/caen', label: 'insse.ro', short: 'CAEN', about: 'The CAEN nomenclature of economic activities, all three revisions, from the National Institute of Statistics.', tries: ['caen 6210', 'caen software'] },
  { id: 'portal-just', to: '/portal-just', label: 'portal.just.ro', short: 'Dosar', about: 'Court files from the courts’ portal — parties, hearings and solutions, by file number or by a party’s name.', tries: ['1234/3/2026', 'dosare Popescu Ion'] },
  { id: 'anaf', to: '/anaf', label: 'anaf.ro', short: 'ANAF', about: 'A company’s fiscal record from ANAF — VAT, inactive or struck-off status, e-Factura — by its CUI.', tries: ['RO1590082'] },
  // Sources not yet connected — each opens a placeholder (pages/LegalSourceStub)
  // that says what it is for. Same order as the sources table they came from.
  { id: 'firme', to: '/firme', label: 'termene.ro - listafirme.ro', stub: true, about: 'Financial data and risk on companies from the private aggregators.' },
  { id: 'bpi', to: '/bpi', label: 'bpi.ro', stub: true, about: 'The Insolvency Proceedings Bulletin — openings, reorganisations and bankruptcies.' },
  { id: 'ancpi', to: '/ancpi', label: 'ancpi.ro', stub: true, about: 'The cadastre and land register — owners, mortgages and encumbrances.' },
  { id: 'rejust', to: '/rejust', label: 'rejust.ro', stub: true, about: 'The courts’ published decisions, from the Superior Council of Magistracy.' },
  { id: 'unbr', to: '/unbr', label: 'unbr.ro', stub: true, about: 'The national bar’s register of lawyers.' },
  { id: 'eurlex', to: '/eurlex', label: 'eur-lex.europa.eu', stub: true, about: 'European Union law — regulations, directives and the Court of Justice’s case law.' },
];

// The dice — "a random one": every source with a dice draws an entry that
// exists and opens it. Drawn as the Legislation bar's dice (accent), on its
// own with both corners rounded (`.lgt-dice`).
export const DiceGlyph = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3.5" y="3.5" width="17" height="17" rx="3.5" />
    <circle cx="8.2" cy="8.2" r="1.1" fill="currentColor" /><circle cx="15.8" cy="8.2" r="1.1" fill="currentColor" />
    <circle cx="12" cy="12" r="1.1" fill="currentColor" />
    <circle cx="8.2" cy="15.8" r="1.1" fill="currentColor" /><circle cx="15.8" cy="15.8" r="1.1" fill="currentColor" />
  </svg>
);

const SearchGlyph = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <circle cx="11" cy="11" r="7" /><path d="M20 20l-3.6-3.6" />
  </svg>
);
const CloseGlyph = (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);
const UpGlyph = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m18 15-6-6-6 6" />
  </svg>
);
const DownGlyph = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m6 9 6 6 6-6" />
  </svg>
);
const isMacPlatform = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '');

// The tab the bar was on last — each tab is a route, so the bar mounts afresh
// with every switch; this is how the new one knows where the underline was
// (to slide from it) and which way the content should enter.
let lastActive = null;

export const LEGAL_TAB_PATHS = LEGAL_TABS.map((t) => t.to);
/** The placeholder tabs — AppRoutes gives each a route to the stub page. */
export const LEGAL_STUB_TABS = LEGAL_TABS.filter((t) => t.stub);

/**
 * `search` — `{ value, onChange(text), placeholder, onSubmit?, onPaste?, onKeyDown? }` — puts the
 * page's search in the bar, left of the tabs, drawn exactly as the Files
 * tab's search (Ctrl/⌘+F focuses it, Escape clears it, Enter submits when
 * the page gives `onSubmit`). A page with nothing to search leaves it out
 * and the field shows disabled, so the tabs keep their place.
 */
// `tools`: a page's own controls (the CAEN view switch, the courts' mode
// switch), drawn at the left of the bar's second line, before the search.
// `status`: a page's own state pill (Legislation's "Live from the portal"),
// drawn at the RIGHT END of the tabs row, above the hairline.
// `trailing`: a page's control at the FAR RIGHT of the second line, past
// the search (Legislation's History dropdown).
/**
 * The search box itself — the Files tab's search to the letter (glyph, the
 * field, a clear button while there is text, the Ctrl/⌘+F hint while there
 * is none). Drawn in the tab bar by LegalTabs, and on its own by a page that
 * puts its search elsewhere (the Legislation tab's Search item). Ctrl/⌘+F
 * focuses it while it is mounted and enabled.
 */
// `search.find` — `{ current, total, prev(), next() }` — makes the box a FIND
// (the Legislation act's "Find in this act"): the count and the arrows sit
// inside it, and the keys work as Windows' find does.
// `hotkey`: false leaves out Ctrl/⌘+F — the key and its hint (the
// Legislation start screen's words box, where the key belongs to the act's find).
// THE RAIL TOGGLE — shows or hides a page's list down the left (the
// Legislation tabs, the Advisor's chats): the mini header's tool button
// (`.lgt-tool-btn`, the Design system's), a panel glyph, PRESSED while the
// list is shown. It stands first on the bar's second line.
const PanelGlyph = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="4" width="18" height="16" rx="2.5" /><path d="M9 4v16" />
  </svg>
);
export function RailToggle({ shown, onToggle, what = 'list' }) {
  return (
    <Tooltip content={shown ? `Hide the ${what}` : `Show the ${what}`}>
      <button
        type="button"
        className={`lgt-tool-btn lgt-railtoggle${shown ? ' is-on' : ''}`}
        aria-pressed={shown}
        aria-label={shown ? `Hide the ${what}` : `Show the ${what}`}
        onClick={onToggle}
      >
        <span className="lgt-tool-ico">{PanelGlyph}</span>
      </button>
    </Tooltip>
  );
}

export function LegalSearchBox({ search, className = '', hotkey = true }) {
  const searchRef = useRef(null);
  const find = search?.find || null;
  useEffect(() => {
    if (!search || !hotkey) return undefined;
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [!!search]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className={`lgt-search${search?.value ? ' is-active' : ''}${search ? '' : ' is-off'}${className ? ` ${className}` : ''}`}>
      <span className="lgt-search-glyph">{SearchGlyph}</span>
      <input
        ref={searchRef}
        placeholder={search?.placeholder || 'Search'}
        value={search?.value || ''}
        disabled={!search}
        aria-label={search?.placeholder || 'Search'}
        onChange={(e) => search?.onChange?.(e.target.value)}
        onPaste={search?.onPaste}
        onKeyDown={(e) => {
          // A page may take a key first (the Legislation act's find:
          // Tab / Shift+Enter step between matches).
          search?.onKeyDown?.(e);
          if (e.defaultPrevented) return;
          if (find) {
            // A FIND, Windows-style (the Doc Viewer's DocFindBar): Enter the
            // next match, Shift+Enter the one before, Escape clears the
            // words and leaves the field.
            if (e.key === 'Enter') { e.preventDefault(); if (e.shiftKey) find.prev(); else find.next(); return; }
            if (e.key === 'Escape') { e.stopPropagation(); search.onChange?.(''); e.currentTarget.blur(); return; }
          }
          if (e.key === 'Escape' && search?.value) { e.stopPropagation(); search.onChange?.(''); }
          if (e.key === 'Enter') search?.onSubmit?.();
        }}
      />
      {find && search?.value ? (
        // A find with words in it: where you are ("3/17", or "No results"),
        // the previous / next match and clear — all INSIDE the field, as the
        // Doc Viewer's find (and Windows') has them.
        <>
          <span className={`lgt-find-count${find.total ? '' : ' is-empty'}`} aria-live="polite">
            {find.total ? `${find.current}/${find.total}` : 'No results'}
          </span>
          <button type="button" className="lgt-find-btn" aria-label="Previous match (Shift+Enter)" disabled={!find.total} onClick={find.prev}>{UpGlyph}</button>
          <button type="button" className="lgt-find-btn" aria-label="Next match (Enter)" disabled={!find.total} onClick={find.next}>{DownGlyph}</button>
          <button type="button" className="lgt-find-btn" aria-label="Clear" onClick={() => { search.onChange?.(''); searchRef.current?.focus(); }}>{CloseGlyph}</button>
        </>
      ) : search?.value ? (
        <button
          type="button"
          className="lgt-search-clear"
          aria-label="Clear search"
          onClick={() => { search.onChange?.(''); searchRef.current?.focus(); }}
        >
          {CloseGlyph}
        </button>
      ) : (
        <span className="lgt-search-kbd">
          <kbd>{isMacPlatform ? '⌘' : 'Ctrl'}</kbd>
          <kbd>F</kbd>
        </span>
      )}
    </div>
  );
}

// `noSearch`: the page draws its search elsewhere — the bar leaves its box
// out altogether rather than showing it disabled.
// `onPinnedChange(pinned)`: told whenever the bar gains or loses its pinned
// (frosted) state — for page chrome that must frost with it.
// `standalone`: a page that is not one of the tabs (the Newsletter) — the bar
// is drawn without its tabs row: just the second line, as a mini header.
// `dropSearch`: with `noSearch`, leave the box out altogether (the Legislation
// workspace, whose line holds the one search instead).
// `ownTabs` — `{ tabs: [{ id, label }], active, onSelect }`: the tabs row shows
// these instead of the platforms (the Legislation workspace's Search / History).
// `rows`: nodes of the page's own, each drawn as one of the bar's rows (the
// tabs row's height, its hairline under it) in place of the tabs — the
// Legislation tab's browser tabs strip and its address row. The bar keeps
// everything else a mini header does: pinning, the frost, the gap-strip fade
// and its hairline taking over as the masthead's divider.
// `line2`: false leaves the second line out altogether — a bar whose page
// has nothing to put under the hairline is its rows alone.
export default function LegalTabs({ search = null, tools = null, status = null, trailing = null, noSearch = false, dropSearch = false, onPinnedChange = null, standalone = false, ownTabs = null, rows = null, line2 = true, className = '' }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const active = LEGAL_TABS.find((t) => t.to === pathname)?.id ?? LEGAL_TABS[0].id;

  // Where the bar came from (captured once, at mount): the underline slides
  // from that tab, and the content under the bar enters from the side the
  // underline travelled toward — the Activity tab's feed slide. Nothing
  // moves on a first arrival.
  const [from] = useState(() => lastActive);
  useEffect(() => { if (!standalone) lastActive = active; }, [active, standalone]);
  const idx = (id) => LEGAL_TABS.findIndex((t) => t.id === id);
  const dir = from && from !== active ? Math.sign(idx(active) - idx(from)) : 0;

  // Pinned = actually stuck at the scroller's top (rect-based, like every
  // other mini header) — paints the frosted surface.
  const [pinned, setPinned] = useState(false);
  const barRef = useRef(null);
  // A page whose own chrome must frost WITH the bar (the Legislation tab's
  // rail) hears the same state the bar paints from, at the same render.
  useLayoutEffect(() => { onPinnedChange?.(pinned); }, [pinned]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const el = barRef.current?.closest('.sv-single-scroll, .main-content');
    if (!el) return undefined;
    // Measured at most once a frame: a scroll can fire several events a frame,
    // and each used to force two rect reads. A frame requested from a scroll
    // event runs in that same frame's rendering step, so the bar still pins
    // on the frame it reaches the top.
    let raf = 0;
    const measure = () => {
      raf = 0;
      const bar = barRef.current;
      setPinned(!!bar && (bar.getBoundingClientRect().top - el.getBoundingClientRect().top) <= 8);
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(measure); };
    measure();
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => { el.removeEventListener('scroll', onScroll); if (raf) cancelAnimationFrame(raf); };
  }, []);

  const tabs = LEGAL_TABS.map((t) => ({ id: t.id, label: t.label }));

  return (
    <>
      <MiniHeaderFade visible={pinned} />
      <div ref={barRef} className={`lgt-bar${pinned ? ' is-pinned' : ''}${standalone && !ownTabs && !rows ? ' is-standalone' : ''}${!standalone && dir > 0 ? ' is-enter-right' : !standalone && dir < 0 ? ' is-enter-left' : ''}${className ? ` ${className}` : ''}`}>
      {rows ? rows.filter(Boolean).map((r, i) => <div key={i} className="lgt-row lgt-row-own">{r}</div>) : null}
      {ownTabs ? <div className="lgt-row">
        <FilterTabs tabs={ownTabs.tabs} active={ownTabs.active} onSelect={ownTabs.onSelect} ariaLabel="Views" />
      </div> : null}
      {!standalone && !ownTabs && <div className="lgt-row">
        <FilterTabs
          tabs={tabs}
          active={active}
          fromId={from}
          onSelect={(id) => {
            const t = LEGAL_TABS.find((x) => x.id === id);
            if (t && t.to !== pathname) navigate(t.to);
          }}
          ariaLabel="Legislation sources"
        />
        {status ? <div className="lgt-status">{status}</div> : null}
      </div>}
      {/* The mini header's SECOND LINE, under the hairline: a page's own
          controls at the left (the CAEN view switch, the courts' mode
          switch — when the page has one) and the search at the right, as
          the Files search stands. It pins and frosts with the bar. */}
      {line2 ? <div className="lgt-line2">
        {tools}
        {/* `noSearch`: the box is still LAID OUT, hidden and inert, so the
            line keeps its height and nothing moves when the page brings
            its search back (the Legislation tab's find, on opening an act). */}
        {noSearch && dropSearch ? null : <LegalSearchBox search={noSearch ? null : search} className={noSearch ? 'is-hidden' : ''} />}
        {/* With no tabs row, the page's status pill stands on this line. */}
        {(standalone || ownTabs) && !rows && status ? <div className="lgt-status">{status}</div> : null}
        {trailing}
      </div> : null}
      </div>
    </>
  );
}
