import { lawRefDetails } from '../lib/lawRefs';
import { peekCaenRev, loadCaen, resolveCaen } from '../lib/caen';
import './RefPill.css';

// The Doc Viewer's HIGHLIGHT PILL (`refPill` in pages/DocViewer.jsx, styles in
// RefPill.css) for a reference found in TEXT — a lib/lawRefs hit rather than a
// marked span — so the Legislation tab's references show the same tooltip and
// the same card. `full` = the card: everything known, the citation as written,
// and what Search does.
export function refHitPill(h, { full = false, onLoaded } = {}) {
  let tone = 'var(--cat-update)';
  let kind = 'legislatie.just.ro · Act';
  let head = h.raw || '';
  const lines = [];
  let action = '';
  if (h.kind === 'cui') {
    tone = 'var(--success)';
    kind = 'anaf.ro · Fiscal code';
    head = `CUI ${h.cui}`;
    if (full) lines.push('A valid fiscal code — its check digit is correct');
    action = full ? 'Search looks the company up at ANAF' : 'Click for more — and to search it';
  } else if (h.kind === 'case') {
    tone = 'var(--info)';
    kind = 'portal.just.ro · Court file';
    head = `Dosar ${h.number}`;
    action = full ? 'Search opens the file in Court files' : 'Click for more — and to search it';
  } else if (h.kind === 'caen') {
    tone = 'var(--warning)';
    const codes = h.codes || [];
    kind = `insse.ro · CAEN code${h.rev ? ` · Rev. ${h.rev}` : ''}`;
    head = codes.map((c) => `CAEN ${c}`).join(', ') || head;
    const data = peekCaenRev(3);
    if (data) {
      for (const c of (full ? codes : codes.slice(0, 3))) {
        const r = resolveCaen(data, c, h.rev || undefined);
        const old = r.rev === 2 && r.rev2;
        const name = old ? r.rev2.name : r.entry?.name;
        lines.push(name ? `${c} — ${name}` : `${c} — not in the CAEN nomenclature`);
        if (old && full) lines.push(`Rev. 2 — now ${r.rev2.to.map((t) => t.code).join(', ') || 'no direct successor'}`);
        if (!old && r.changed) lines.push(`Before 2025 (Rev. 2): ${r.rev2.name}`);
      }
    } else {
      lines.push('Reading the nomenclature…');
      loadCaen().then(() => onLoaded?.()).catch(() => {});
    }
    action = full ? 'Search opens it in CAEN codes' : 'Click for more — and to search it';
  } else {
    const d = lawRefDetails(h);
    if (h.kind === 'code') kind = 'legislatie.just.ro · Code';
    head = d.heading || d.raw || head;
    if (d.element) lines.push(d.element);
    if (d.title) lines.push(d.title);
    if (d.notes?.length) lines.push(d.notes.join(' · '));
    action = full ? 'Search opens the act here' : 'Click for more — and to search it';
  }
  const cited = full ? String(h.raw || '').replace(/\s+/g, ' ').trim() : '';
  return (
    <span className={`dv-refpill${full ? ' is-full' : ''}`} style={{ '--refpill-tone': tone }}>
      <span className="dv-refpill-kind">{kind}</span>
      <span className="dv-refpill-head">{head}</span>
      {lines.map((l) => <span key={l} className="dv-refpill-line">{l}</span>)}
      {cited && cited !== head && <span className="dv-refpill-quote">“{cited}”</span>}
      <span className="dv-refpill-act">{action}</span>
    </span>
  );
}
