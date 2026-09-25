// Romanian national legislation — the portal's data, and this machine's copy.
//
// legislatie.just.ro (Portalul legislativ, Ministerul Justiției) publishes a
// free web service, and it is the only lawful complete source of Romanian
// legislation a program can read. Everything that talks to it lives in the main
// process (`legislation:*` in main.js) because the service is a 2015-era WCF
// endpoint that sends no CORS headers; this module is the model in front of it:
// what a search MEANS, what a record is, how an act's text is structured, and —
// the point of the whole tab — what happens when the portal is not there.
//
// THE PORTAL IS NOT A DEPENDENCY, IT IS A SOURCE. A case is worked on when it
// is worked on, not when a ministry's server happens to be up, so every answer
// is kept: the metadata of every result is folded into an on-disk index, and an
// act that is opened has its full text saved beside it. With the portal
// unreachable the same search runs against that index instead, and the tab says
// which of the two answered. Legislative texts carry no copyright (Legea nr.
// 8/1996 art. 9) and the portal's terms allow their reuse, so the copy is the
// user's to keep — with the caveat the portal itself states and the tab
// repeats: only the text printed in Monitorul Oficial is authentic, and a
// consolidated version is not.
import {
  legislationSearch, legislationArchivePut, legislationArchiveList,
  legislationArchiveGet, legislationArchiveRemove, legislationArchiveClear, legislationPage,
  isElectron,
} from './platform';

// ── Matching, the way Romanian is actually typed ──────────────────────────
// Documents in the wild carry both the correct comma-below ș/ț and the old
// cedilla ş/ţ, and people search without diacritics at all. So everything is
// compared folded down to ASCII — the same trick `lib/lawRefs` plays with its
// character classes, done here on the values instead of the pattern.
const FOLD = {
  ș: 's', ş: 's', ț: 't', ţ: 't', ă: 'a', â: 'a', î: 'i',
  Ș: 's', Ş: 's', Ț: 't', Ţ: 't', Ă: 'a', Â: 'a', Î: 'i',
};
export function fold(s) {
  return String(s || '').replace(/[șşțţăâîȘŞȚŢĂÂÎ]/g, (c) => FOLD[c]).toLowerCase();
}

// The portal hands back a title with a byte-order mark, tabs and runs of
// spaces where the printed page had a line break.
// ROMANIAN DIACRITICS the portal cannot carry. Its database predates the
// comma-below letters: Ș/Ț come through as "?" ("Pre?edintele României",
// "Na?ională", "Sănătă?ii"), while the cedilla ş/ţ of older texts survive.
// The letter is put back by where it stands: before an "i" it is ț (nați-,
// sănătății, munți) except at the start of a word (și); elsewhere ș
// (Președinte, știință, oraș). Upper-case in a word set in capitals or
// opening the text or a sentence. Only a "?" glued to a letter is read this
// way; a question mark after a word stays one.
export function fixDiacritics(s) {
  const str = String(s || '');
  if (!str.includes('?')) return str;
  const isLetter = (c) => /[A-Za-zĂÂÎȘȚŞŢăâîșțşţ]/.test(c || '');
  return str.replace(/\?/g, (m, off) => {
    const prev = str[off - 1] || '';
    const next = str[off + 1] || '';
    if (!isLetter(next)) return m;
    const wordStart = !isLetter(prev);
    let ch = /^[iI]$/.test(next) && !wordStart ? 'ț' : 'ș';
    const capsWord = next === next.toUpperCase() && next !== next.toLowerCase();
    const sentenceStart = wordStart && (off === 0 || /[.!?]\s*$/.test(str.slice(0, off)));
    if (capsWord || sentenceStart) ch = ch.toUpperCase();
    return ch;
  });
}

// The portal's text carries HTML entities of its own ("tatea &lt; 1,6
// kg/cap" — a level of escaping the SOAP envelope's decoding never reaches,
// and the page's too): decoded here, before anything measures the text —
// a "&lt;" left in is four characters where the drawing counted one, and
// every row of a box-drawn table after it fell out of line.
const ENTITY = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", nbsp: ' ' };
export const unentity = (s) => String(s || '')
  .replace(/&#(x?)([0-9a-fA-F]+);/g, (m, hex, num) => { try { return String.fromCodePoint(parseInt(num, hex ? 16 : 10)); } catch { return m; } })
  .replace(/&(lt|gt|amp|quot|apos|nbsp);/g, (m, name) => ENTITY[name]);
const tidy = (s) => fixDiacritics(unentity(s)).replace(/^﻿/, '').replace(/\s+/g, ' ').trim();

// ── The kinds of act ──────────────────────────────────────────────────────
// The service has NO act-type parameter — a search for "24 / 2000" answers with
// every act numbered 24 in force that year, whoever issued it — so the type is
// filtered here, on the way out. These are the values the portal's own TipAct
// field uses.
export const LEGIS_TYPES = [
  { id: '', label: 'Any kind' },
  { id: 'LEGE', label: 'Lege' },
  { id: 'ORDONANȚĂ DE URGENȚĂ', label: 'Ordonanță de urgență' },
  { id: 'ORDONANȚĂ', label: 'Ordonanță' },
  { id: 'HOTĂRÂRE', label: 'Hotărâre' },
  { id: 'ORDIN', label: 'Ordin' },
  { id: 'DECIZIE', label: 'Decizie' },
  { id: 'DECRET', label: 'Decret' },
  { id: 'NORMĂ', label: 'Normă' },
  { id: 'REGULAMENT', label: 'Regulament' },
  { id: 'INSTRUCȚIUNI', label: 'Instrucțiuni' },
  { id: 'CIRCULARĂ', label: 'Circulară' },
  { id: 'ANEXĂ', label: 'Anexă' },
];

const typeMatches = (recType, wanted) => !wanted || fold(recType).startsWith(fold(wanted));

// ── One record ────────────────────────────────────────────────────────────
// `titlu` arrives as the whole masthead of the printed act — its kind, number,
// date, title, issuing body and where it was published, run together. The parts
// worth showing separately are pulled out of it; whatever is left is the title.
const DATE_IN_TITLE = /\bdin\s+(\d{1,2}\s+\p{L}+\s+\d{4})/u;
const REPUBLISHED = /\(\s*\*?\s*republicat[ăa]\s*\*?\s*\)/iu;

export function normalizeRecord(raw) {
  const titlu = tidy(raw?.titlu);
  const tipAct = tidy(raw?.tipAct);
  const numar = tidy(raw?.numar);
  // The act's OWN date, which is not the same as `dataVigoare` (the portal
  // answers the date a version came into force, and for an old act
  // republished later those are years apart).
  const issued = (DATE_IN_TITLE.exec(titlu) || [])[1] || '';
  const year = (/(\d{4})\s*$/.exec(issued) || [])[1] || '';
  // Where the title proper starts: after the kind, number and date, at the word
  // that opens it. Falls back to the whole line, which is never wrong, only long.
  const opener = /\b(privind|pentru|asupra|referitor\s+la|cu\s+privire\s+la)\b/iu.exec(titlu);
  return {
    id: String(raw?.id || ''),
    tipAct,
    numar,
    titlu,
    title: cutTrailer(opener ? titlu.slice(opener.index) : titlu),
    issued,
    year,
    republished: REPUBLISHED.test(titlu),
    emitent: tidy(raw?.emitent),
    publicatie: tidy(raw?.publicatie),
    dataVigoare: tidy(raw?.dataVigoare),
    link: raw?.link || '',
    text: typeof raw?.text === 'string' ? fixDiacritics(unentity(raw.text)) : '',
    savedAt: raw?.savedAt || '',
    openedAt: raw?.openedAt || '',
    hasText: !!raw?.hasText || !!raw?.text,
    chars: raw?.chars || (raw?.text ? raw.text.length : 0),
  };
}

// Where a title STOPS. The portal's `Titlu` is the printed act's whole
// masthead run together, so the title proper is followed by the issuing body
// and the gazette reference in capitals — both of which have fields of their
// own here, and would otherwise be read twice, the second time as title.
const TITLE_TRAILER = /\s(?:EMITENT|PUBLICAT(?:\s+[ÎI]N)?|MONITORUL\s+OFICIAL|Not[ăa]\b)/u;
const cutTrailer = (t) => {
  const m = TITLE_TRAILER.exec(t);
  return (m ? t.slice(0, m.index) : t).replace(/[\s.,;:]+$/, '').trim();
};

// A short, unmistakable name for a record — "LEGE nr. 24/2000".
export function actLabel(rec) {
  const parts = [rec.tipAct || 'Act'];
  if (rec.numar) parts.push(`nr. ${rec.numar}${rec.year ? `/${rec.year}` : ''}`);
  return parts.join(' ');
}

// ── Searching ─────────────────────────────────────────────────────────────
// The live service first; the archive when it cannot be reached. The two are
// NEVER silently mixed: the answer says which one it came from, because "no
// results" means something very different offline.
export async function searchLegislation(query) {
  const q = {
    numar: (query?.numar || '').trim(),
    an: (query?.an || '').trim(),
    titlu: (query?.titlu || '').trim(),
    text: (query?.text || '').trim(),
    tip: (query?.tip || '').trim(),
    page: query?.page || 1,
    perPage: query?.perPage || 25,
  };
  if (isElectron && !query?.offlineOnly) {
    // ROMANIAN DIACRITICS. The portal matches words as written, and its
    // titles are written three ways — comma-below ș/ț (the correct letters),
    // the cedilla ş/ţ of older texts, and none at all — so "tehnică" typed
    // right can miss an act filed as "tehnica" or "tehnicã". The words are
    // sent as typed first; an empty answer is asked again with the cedilla
    // spelling, then with no diacritics, before it counts as nothing. Words
    // typed without diacritics have one spelling and cost one call.
    const spellings = (s) => {
      const t = String(s || '').trim();
      if (!t) return [''];
      const cedilla = t.replace(/ș/g, 'ş').replace(/ț/g, 'ţ').replace(/Ș/g, 'Ş').replace(/Ț/g, 'Ţ');
      return [...new Set([t, cedilla, fold(t)])];
    };
    const titles = spellings(q.titlu);
    const texts = spellings(q.text);
    const rounds = Math.max(titles.length, texts.length);
    let res = null;
    for (let i = 0; i < rounds; i++) {
      const attempt = { ...q, titlu: titles[Math.min(i, titles.length - 1)], text: texts[Math.min(i, texts.length - 1)] };
      res = await legislationSearch(attempt);
      if (!res?.ok || (res.records || []).length) break;
    }
    if (res?.ok) {
      // The portal's year is "in force that year", so a number and a year
      // answer with every act of that number in force then — a 2024 act
      // beside the 2022 one asked for. The year typed means the act's OWN
      // year: an act whose year is known and differs is dropped (one whose
      // year could not be read is kept — being generous beats losing it).
      const an = String(q.an || '').trim();
      const records = (res.records || []).map(normalizeRecord)
        .filter((r) => typeMatches(r.tipAct, q.tip))
        .filter((r) => !an || !r.year || r.year === an);
      // Kept the moment they are seen, metadata only: a search that has been
      // run once can be run again with the portal down, and an act can be
      // recognised in the list without paying for its text.
      if (records.length) {
        legislationArchivePut({ records: records.map(stripText), withText: false }).catch(() => {});
      }
      return { ok: true, source: 'live', records, total: records.length };
    }
    const fallback = await searchArchive(q);
    return { ...fallback, source: 'archive', portalError: res?.error || 'unreachable' };
  }
  return { ...(await searchArchive(q)), source: 'archive' };
}

const stripText = ({ text, ...rest }) => rest;

// ── Plain-text search ─────────────────────────────────────────────────────
// ONE box, any words (`q.words`): the portal is asked for them in the TITLE
// first (the answer most people mean), then anywhere in the TEXT, and — with
// both empty and `ai` given — an AI is asked what a Romanian act about that
// would be called (up to three short phrases, the portal's own vocabulary:
// "contract de mandat" for "mandate agreement") and each is tried the same
// two ways. The answer says which way found it (`mode`: 'title' | 'text' |
// 'ai', and `terms`, the phrases the AI tried), so the page can say so.
// Kind / number / year in `q` apply throughout. `ai(query) → string[]` is
// the caller's — the page hands in the project AI; a signed-out user has
// none and the search simply stops at the text pass.
export async function searchLegislationPlain(q, { ai = null } = {}) {
  const words = String(q?.words || '').trim();
  const base = { tip: q?.tip || '', numar: q?.numar || '', an: q?.an || '', perPage: q?.perPage || 30 };
  const tryBoth = async (phrase) => {
    const byTitle = await searchLegislation({ ...base, titlu: phrase, text: '' });
    if (!byTitle?.ok) return byTitle;
    if (byTitle.records.length) return { ...byTitle, mode: 'title' };
    const byText = await searchLegislation({ ...base, titlu: '', text: phrase });
    if (!byText?.ok) return byText;
    return { ...byText, mode: 'text' };
  };
  if (!words) return searchLegislation({ ...base, titlu: '', text: '' });
  let res = await tryBoth(words);
  if (!res?.ok || res.records.length || !ai) return res;
  let terms = [];
  try { terms = (await ai(words)) || []; } catch { terms = []; }
  terms = [...new Set(terms.map((t) => String(t || '').trim()).filter((t) => t && fold(t) !== fold(words)))].slice(0, 3);
  const tried = [];
  for (const t of terms) {
    tried.push(t);
    const r = await tryBoth(t);
    if (!r?.ok) return r;
    if (r.records.length) return { ...r, mode: 'ai', terms: tried };
  }
  return { ...res, mode: 'none', terms: tried };
}

// The same question, asked of what this machine already has.
export async function searchArchive(q) {
  const res = await legislationArchiveList();
  if (!res?.ok) return { ok: false, records: [], total: 0, error: res?.error || 'unavailable' };
  const numar = (q.numar || '').trim();
  const an = (q.an || '').trim();
  const titlu = fold(q.titlu);
  const text = fold(q.text);
  const hits = res.acts.map(normalizeRecord).filter((r) => {
    if (numar && r.numar !== numar) return false;
    // The year is the act's own — as the live search reads it. Only an act
    // whose year could not be read falls back to the year it came into force.
    if (an && !(r.year ? r.year === an : (r.dataVigoare || '').startsWith(an))) return false;
    if (!typeMatches(r.tipAct, q.tip)) return false;
    if (titlu && !fold(r.titlu).includes(titlu)) return false;
    // Full-text search can only reach what was saved whole.
    if (text && !(fold(r.titlu).includes(text) || r.hasText)) return false;
    return true;
  });
  hits.sort((a, b) => (b.year || '').localeCompare(a.year || '') || a.titlu.localeCompare(b.titlu));
  return { ok: true, records: hits, total: hits.length };
}

// ── Reading one act ───────────────────────────────────────────────────────
// The PORTAL first — what is opened is what the law is today — and the copy
// on disk only when the portal cannot answer: this machine offline, the
// portal down, or the act no longer where it was. A record that already
// carries its text came from a live search a moment ago and is the portal's.
// What the portal sends is kept whole, so the fallback is always there for
// the next time.
export async function loadAct(rec) {
  if (rec?.text) return { ok: true, act: normalizeRecord(rec), source: 'live' };
  const live = await fetchActLive(rec);
  if (live.ok) {
    await legislationArchivePut({ records: [live.act], withText: true });
    return { ok: true, act: live.act, source: 'live' };
  }
  if (rec?.id) {
    const kept = await legislationArchiveGet(rec.id);
    if (kept?.ok && kept.act?.text) return { ok: true, act: normalizeRecord(kept.act), source: 'archive', portalError: live.error || '' };
  }
  return live;
}

// The act as the PORTAL has it now, whatever this machine keeps — asked for
// as narrowly as the service allows, then matched by id: there is no "get
// by id" method, only Search. Nothing is written; `loadAct` keeps it, and
// the page's "matches the portal" check only compares.
export async function fetchActLive(rec) {
  if (!isElectron) return { ok: false, error: 'unsupported' };
  const res = await legislationSearch({
    numar: rec?.numar || '', an: rec?.year || (rec?.dataVigoare || '').slice(0, 4),
    titlu: rec?.title ? rec.title.split(/\s+/).slice(0, 6).join(' ') : '',
    page: 1, perPage: 50,
  });
  if (!res?.ok) return { ok: false, error: res?.error || 'unreachable' };
  const found = (res.records || []).map(normalizeRecord).find((r) => r.id === rec?.id && r.text);
  if (!found) return { ok: false, error: 'not_found' };
  return { ok: true, act: found };
}

/** Whether a kept act's text is the portal's — the text itself and the in-force date. */
export const sameAct = (a, b) => !!a && !!b && a.text === b.text && (a.dataVigoare || '') === (b.dataVigoare || '');

// ── The act as the portal LAYS IT OUT ─────────────────────────────────────
// The service's `Text` is the act flattened; the portal's own page marks the
// act's structure up with `S_*` classes, and that is what the tab follows —
// "the same rules as the source". `loadActPage(rec, { fresh })` gets the
// page (this machine's copy unless `fresh`, else the portal; main keeps it
// beside the act) and `parseActHtml(html)` reads it into a TREE:
//
//   { kind: 'art' | 'aln' | 'lit' | 'pct' | 'anx' | 'cap' | …,  a unit with
//     title, den, text, children }            S_X > S_X_TTL / S_X_DEN / S_X_BDY
//   { kind: 'par', text, children }           S_PAR — a paragraph (its own
//                                             block children after its text)
//   { kind: 'cit', children }                 S_CIT — text quoted by an amendment
//   { kind: 'nta', title, text }              S_NTA — a note
//   { kind: 'smn', lines }                    S_SMN — the signatures
//   { kind: 'pre', lines, tables }            S_PRE — a preformatted block:
//                                             its rows as drawn, and each
//                                             box-drawn table in it read as
//                                             a grid (`parseBoxTable`)
//
// Inline `S_LGI` (a reference) and the portal's own `<A>` links are read as
// their text; `TAG_COLLAPSED` (the +/− toggles) and `S_*_SHORT` (the
// collapsed previews) are skipped; `S_DEN` / `S_HDR` / the `S_EMT` and
// `S_PUB` tables are the masthead the page already draws from the record,
// and come back under `head` for whoever wants them. Parsed with the
// browser's DOMParser — this is renderer code.
// The portal's page first, this machine's copy of it when the portal cannot
// answer (main falls back itself; the second call here covers an app whose
// main process predates that and only knows `fresh` as "never the copy").
export async function loadActPage(rec, { fresh = true } = {}) {
  if (!rec?.id || !isElectron) return { ok: false, error: 'unsupported' };
  const res = await legislationPage({ id: rec.id, fresh });
  if (res?.ok || !fresh) return res;
  const kept = await legislationPage({ id: rec.id, fresh: false });
  return kept?.ok ? kept : res;
}

// A LIST the portal writes as plain paragraphs. Not every list in an act is
// marked up as one (S_LIT / S_PCT): an annex, a form's instructions or an
// older act writes its items as ordinary S_PAR paragraphs, either OPENING
// with their marker — "a) …", "1. …", "(ii) …", "- …" — or pushed in with
// leading spaces to look nested. Such a paragraph becomes a list item: the
// marker taken off into `title` (drawn in the number column, and visited
// before the text by `actTreeStrings`, as a unit's title is), `list` saying
// which kind ('num' · 'letter' · 'roman' · 'bullet' · 'indent') and
// `indent` how far the portal pushed it in (0–4 steps of four spaces).
const LIST_MARK = /^(\(?[a-zăâîșşțţ]\)|\d{1,3}[.)]|\([ivx]{1,5}\)|[ivx]{2,5}\)|[-–—•●▪■○])\s+(?=\S)/u;
function asListItem(node, el) {
  // The portal's amendment notes ("(la 16-11-2022, … a fost modificat …)")
  // are asides, never items.
  if (/^\(la \d/.test(node.text || '')) return node;
  // Indentation is what the TEXT carries: non-breaking spaces, or plain
  // spaces on the text's own line. Whitespace that includes a line break or
  // a tab is the page's source formatting, which the portal never shows —
  // only its non-breaking spaces count then.
  const ws = /^\s*/u.exec(String(el?.textContent || ''))?.[0] || '';
  const lead = /[\r\n\t]/.test(ws) ? (ws.match(/ /g) || []).length : ws.length;
  const m = LIST_MARK.exec(node.text || '');
  if (!m && lead < 2) return node;
  const mark = m ? m[1] : '';
  const letters = mark.replace(/[()]/g, '');
  const list = !m ? 'indent'
    : /^\d/.test(mark) ? 'num'
      : /^[-–—•●▪■○]$/.test(mark) ? 'bullet'
        : letters.length > 1 ? 'roman' : 'letter';
  return {
    ...node,
    title: mark,
    text: m ? node.text.slice(m[0].length) : node.text,
    list,
    indent: Math.min(4, Math.round(lead / 4)),
  };
}

const UNIT_KINDS = new Set(['art', 'aln', 'lit', 'pct', 'anx', 'cap', 'ttl', 'sec', 'prt', 'crt', 'sbs', 'nta', 'par']);
export function parseActHtml(html) {
  if (typeof DOMParser === 'undefined') return null;
  const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
  const root = doc.querySelector('#div_Formaconsolidata, .content_forma_act[data-state="loaded"], .content_forma_act');
  if (!root) return null;
  let tableSeq = 0;
  const cls = (el) => (el.getAttribute?.('class') || '').split(/\s+/);
  const sKind = (el) => { const c = cls(el).find((x) => /^S_[A-Z]+$/.test(x)); return c ? c.slice(2).toLowerCase() : ''; };
  const text = (node) => tidy(node?.textContent || '');
  // A direct child carrying a class (no `:scope` — not every DOM has it).
  const child = (el, name) => [...(el?.children || [])].find((n) => cls(n).includes(name)) || null;
  // A body: its leading inline text, then its block children.
  const body = (el) => {
    const out = { text: '', children: [] };
    if (!el) return out;
    let inline = '';
    for (const n of el.childNodes) {
      if (n.nodeType === 3) { inline += n.textContent; continue; }
      if (n.nodeType !== 1) continue;
      const c = cls(n);
      if (c.includes('TAG_COLLAPSED') || c.some((x) => /_SHORT$/.test(x))) continue;
      const k = sKind(n);
      if (n.tagName === 'A' || n.tagName === 'B' || n.tagName === 'I' || n.tagName === 'SUP' || n.tagName === 'SUB' || k === 'lgi' || (!k && n.tagName === 'SPAN' && !n.querySelector('[class^="S_"]'))) {
        inline += n.textContent; continue;
      }
      if (n.tagName === 'BR') { inline += ' '; continue; }
      const blocks = walk(n);
      if (blocks.length) {
        // Text so far is the paragraph before these blocks.
        if (tidy(inline)) { out.children.push({ kind: 'par', text: tidy(inline), children: [] }); inline = ''; }
        out.children.push(...blocks);
      }
    }
    out.text = tidy(inline);
    // A body with only its text and a first child paragraph is that paragraph.
    if (!out.text && out.children.length && out.children[0].kind === 'par' && !out.children[0].list && !out.children[0].children.length) {
      out.text = out.children[0].text; out.children.shift();
    }
    return out;
  };
  // An element → the blocks it is or holds.
  const walk = (el) => {
    const c = cls(el);
    if (c.includes('TAG_COLLAPSED') || c.some((x) => /_SHORT$/.test(x))) return [];
    const k = sKind(el);
    if (k === 'den' || k === 'hdr') return [{ kind: k, text: text(el) }];
    if (k === 'emt' || k === 'pub') {
      return [{ kind: 'meta', label: text(el.querySelector(`.S_${k.toUpperCase()}_TTL`)), text: text(el.querySelector(`.S_${k.toUpperCase()}_BDY`)) }];
    }
    if (k === 'smn') return [{ kind: 'smn', lines: [...el.querySelectorAll('.S_SMN_PAR')].map(text).filter(Boolean) }];
    if (k === 'cit') return [{ kind: 'cit', children: [...el.children].flatMap(walk) }];
    if (k === 'pre') {
      const rows = [...el.children].filter((n) => sKind(n) === 'par').map((n) => fixDiacritics(unentity(n.textContent || '').replace(/ /g, ' ').replace(/[\r\n]+/g, '')));
      const lines = rows.length ? rows : (el.textContent || '').split('\n');
      // Runs of box rows are tables (read as grids) or DIAGRAMS (read as
      // boxes and lines — tried first, since a chart's lines make a grid
      // reader answer with nonsense); the rest stays as rows.
      const segs = [];
      let run = [];
      const isBox = (r) => /^\s*[┌├└│]/u.test(r) && /[┐┤┘│]\s*$/u.test(r);
      const flush = () => {
        if (!run.length) return;
        const diagram = parseBoxDiagram(run);
        segs.push({ type: 'table', id: tableSeq++, rows: run, grid: diagram ? null : parseBoxTable(run), diagram });
        run = [];
      };
      for (const r of lines) {
        if (isBox(r)) { run.push(r); continue; }
        flush();
        if (segs.length && segs[segs.length - 1].type === 'text') segs[segs.length - 1].rows.push(r);
        else segs.push({ type: 'text', rows: [r] });
      }
      flush();
      for (const s of segs) if (s.type === 'text') { while (s.rows.length && !s.rows[0].trim()) s.rows.shift(); while (s.rows.length && !s.rows[s.rows.length - 1].trim()) s.rows.pop(); }
      return [{ kind: 'pre', segs: segs.filter((s) => s.type === 'table' || s.rows.length) }];
    }
    if (k === 'par') {
      const b = body(el);
      return [asListItem({ kind: 'par', text: b.text, children: b.children }, el)];
    }
    const K = k.toUpperCase();
    if (k && (child(el, `S_${K}_TTL`) || child(el, `S_${K}_BDY`))) {
      const b = body(child(el, `S_${K}_BDY`));
      const short = child(el, `S_${K}_SHORT`);
      return [{
        kind: UNIT_KINDS.has(k) ? k : 'unit',
        tag: k,
        title: text(child(el, `S_${K}_TTL`)),
        den: text(child(el, `S_${K}_DEN`)),
        text: b.text || (short && !b.children.length ? text(short) : ''),
        children: b.children,
      }];
    }
    // Anything else (a div, a table, an unknown span): what it holds.
    if (k) { const b = body(el); return b.text || b.children.length ? [{ kind: 'par', text: b.text, children: b.children }] : []; }
    return [...el.children].flatMap(walk);
  };
  const blocks = [...root.children].flatMap(walk);
  const head = { den: '', hdr: '', meta: [] };
  const bodyBlocks = [];
  for (const b of blocks) {
    if (b.kind === 'den') head.den = b.text;
    else if (b.kind === 'hdr') head.hdr = b.text;
    else if (b.kind === 'meta') head.meta.push(b);
    // An older page writes the act's title as a plain paragraph right after
    // its name instead of an S_HDR — it is the masthead's, not the body's.
    else if (!head.hdr && !bodyBlocks.length && b.kind === 'par' && !b.children.length && head.den) head.hdr = b.text;
    else bodyBlocks.push(b);
  }
  return { head, blocks: bodyBlocks, tables: tableSeq };
}

/** Every string in a tree, in reading order (the find counts these). `drawn(id)` says whether a table shows as drawn. */
export function actTreeStrings(tree, drawn = () => false) {
  const out = [];
  const visit = (b) => {
    if (!b) return;
    if (b.title) out.push(b.title);
    if (b.den) out.push(b.den);
    if (b.text) out.push(b.text);
    if (b.lines) out.push(...b.lines);
    if (b.segs) {
      for (const s of b.segs) {
        if (s.type !== 'table' || drawn(s.id) || (!s.grid && !s.diagram)) out.push(...s.rows);
        else if (s.diagram) out.push(...diagramStrings(s.diagram));
        else out.push(...s.grid.rows.flat().flatMap((c) => c.lines || [c.text]));
      }
    }
    (b.children || []).forEach(visit);
  };
  (tree?.blocks || []).forEach(visit);
  return out;
}

export async function keepAct(act) {
  if (!act?.id || !act?.text) return { ok: false, error: 'nothing_to_keep' };
  return legislationArchivePut({ records: [act], withText: true });
}
export const listArchive = () => legislationArchiveList();
export const forgetAct = (id) => legislationArchiveRemove(id);
export const clearArchive = () => legislationArchiveClear();

// ── From a citation in a document to this tab ──────────────────────────
// The Word preview finds citations in a paragraph (`lib/lawRefs`) and lists
// them under it; pressing one has to arrive HERE, at the act itself. These two
// are the join, and they live in this module so the page and the button can
// never disagree about what a citation asks for.
//
// The category a document writes is not the word the portal files an act
// under: a clause says "Legii nr. 24/2000" in the genitive, or "O.U.G.", and
// TipAct says LEGE and ORDONANȚĂ DE URGENȚĂ. Longest-first, because an
// ordonanță de urgență is also an ordonanță.
const PORTAL_TYPE = [
  [/^ordonant.*urgent/, 'ORDONANȚĂ DE URGENȚĂ'],
  [/^o\.?u\.?g/, 'ORDONANȚĂ DE URGENȚĂ'],
  [/^ordonant/, 'ORDONANȚĂ'],
  [/^o\.?g/, 'ORDONANȚĂ'],
  [/^hotarar/, 'HOTĂRÂRE'],
  [/^h\.?g/, 'HOTĂRÂRE'],
  [/^leg/, 'LEGE'],
  [/^decret/, 'DECRET'],
  [/^ordin/, 'ORDIN'],
  [/^deciz/, 'DECIZIE'],
  [/^regulament/, 'REGULAMENT'],
  [/^instructiun/, 'INSTRUCȚIUNI'],
  [/^norm/, 'NORMĂ'],
];
export function portalTypeFor(category) {
  const c = fold(category).replace(/\s+/g, ' ').trim();
  if (!c) return '';
  for (const [re, tip] of PORTAL_TYPE) if (re.test(c)) return tip;
  return '';
}

// What to ask the portal for, given what a citation says. A first mention
// carries a title, and the title is what turns a useless search into an exact
// one — "24 / 2000" alone answers with every act numbered 24 in force that
// year — so the first few words of it are sent along. A code named without a
// number ("Codul civil") has only its name to go on.
export function legislationQueryFor(d) {
  if (!d) return null;
  const tip = portalTypeFor(d.category);
  const titleWords = String(d.title || '')
    .replace(/^(privind|pentru|asupra|referitor\s+la|cu\s+privire\s+la)\s+/iu, '')
    .split(/\s+/).filter(Boolean).slice(0, 7).join(' ');
  if (d.number && d.year) return { tip, numar: d.number, an: d.year, titlu: titleWords };
  const name = (d.heading || d.raw || '').trim();
  return name ? { tip, numar: '', an: '', titlu: name } : null;
}

// …and that query as a route into the Legislation tab. `open=1` asks the page to
// go straight into the act when the answer is unambiguous, which is what a
// reader pressing a citation meant.
export function legislationHref(d, { open = true } = {}) {
  const q = legislationQueryFor(d);
  if (!q) return '';
  const p = new URLSearchParams();
  if (q.tip) p.set('tip', q.tip);
  if (q.numar) p.set('nr', q.numar);
  if (q.an) p.set('an', q.an);
  if (q.titlu) p.set('titlu', q.titlu);
  if (open) p.set('open', '1');
  return `/legislation?${p.toString()}`;
}

// ── An act's own shape ────────────────────────────────────────────────────
// The service answers PLAIN TEXT — no markup of any kind — but it is not
// shapeless: the portal's own consolidation puts each structural unit on a line
// of its own, separated by a bare "+". So the shape can be read back off it,
// which is what lets the act be laid out as a document here instead of dumped
// as a wall of characters.
//
// Only the units the drafting rules define are recognised (Legea nr. 24/2000
// names them, which is a pleasing circularity): the divisions, the article, and
// inside an article the numbered paragraphs and lettered points.
const UNIT_RE = /^(partea|cartea|titlul|capitolul|sec[țţ]iunea|subsec[țţ]iunea|anexa|anex[ăa])\b[^]{0,120}?$/iu;
const ART_RE = /^(articolul\s+\S+|art\.\s*\d+\S*)\s*/iu;
const NOTE_RE = /^(not[ăa]|\*\)|__+)/iu;
const PARA_SPLIT = /(?=\s\(\d+\)\s)/u;

const UNIT_LEVEL = {
  partea: 1, cartea: 1, titlul: 2, capitolul: 3, sectiunea: 4, subsectiunea: 5, anexa: 1,
};

// ── Box-drawn tables ──
// Older acts carry their forms and tables DRAWN, in box-drawing characters
// (┌──┬──┐ │ │ ├──┼──┤ └──┴──┘), one row per printed line — and the portal
// hands the act over with those line breaks flattened to runs of spaces,
// so a table arrives as one long line in which every row is exactly as
// wide as the first. `splitTables` cuts a line into its text and its
// tables: from a `┌` the first row runs to its `┐` and sets the width, and
// each following run of spaces is skipped and the next WIDTH characters
// taken as a row for as long as they look like one (a box character at
// both ends). The rows are kept as they are, spaces and all — the page
// draws them in a monospace block, where the boxes line up again.
const BOX_START = /[┌├└│]/u;
const BOX_END = /[┐┤┘│]/u;
export function splitTables(line) {
  const chars = Array.from(String(line || ''));
  const parts = [];
  let text = [];
  let i = 0;
  while (i < chars.length) {
    if (chars[i] !== '┌') { text.push(chars[i]); i++; continue; }
    const end = chars.indexOf('┐', i);
    if (end < 0) { text.push(chars[i]); i++; continue; }
    const width = end - i + 1;
    const rows = [chars.slice(i, end + 1).join('')];
    let j = end + 1;
    for (;;) {
      let k = j;
      while (k < chars.length && chars[k] === ' ') k++;
      const row = chars.slice(k, k + width);
      if (row.length !== width || !BOX_START.test(row[0]) || !BOX_END.test(row[width - 1])) break;
      rows.push(row.join(''));
      j = k + width;
    }
    if (rows.length < 2) { text.push(chars[i]); i++; continue; }
    if (text.length) { parts.push({ type: 'text', s: text.join('') }); text = []; }
    parts.push({ type: 'table', rows: rows.map((r) => fixDiacritics(unentity(r))) });
    i = j;
  }
  if (text.length) parts.push({ type: 'text', s: text.join('') });
  return parts;
}

// A box-drawn table READ AS A GRID, so the page can draw it as a real
// table (DocVex's own rules) instead of the portal's character drawing.
// The drawing is a grid of characters: every column in which some row has
// a vertical or junction character is a column line, every row holding a
// `─` is a row line. A cell starts at a crossing not already inside
// another cell and grows RIGHT while the column line through its rows is
// not drawn (no `│` there — a merged cell), then DOWN while the row line
// under it is not drawn across its width (no `─` there). Its text is what
// stands inside — every row of it, border rows included, since a merged
// cell's words can sit on a row that is a border for its neighbours
// ("(euro)" beside "├───┼───┤") — trimmed and joined with spaces.
// `{ cols, rows: [[{ text, colSpan, rowSpan }]] }`, or null for a drawing
// that is not a grid.
const V_CHARS = /[│┌┐└┘├┤┬┴┼]/u;
export function parseBoxTable(drawn) {
  const grid = (drawn || []).map((r) => Array.from(r));
  if (grid.length < 3) return null;
  const width = Math.max(...grid.map((r) => r.length));
  const at = (y, x) => grid[y]?.[x] ?? ' ';
  const colLines = [];
  for (let x = 0; x < width; x++) if (grid.some((r) => V_CHARS.test(r[x] || ''))) colLines.push(x);
  const rowLines = [];
  for (let y = 0; y < grid.length; y++) if (grid[y].includes('─')) rowLines.push(y);
  if (colLines.length < 2 || rowLines.length < 2) return null;
  const nc = colLines.length - 1;
  const nr = rowLines.length - 1;
  const taken = Array.from({ length: nr }, () => Array(nc).fill(false));
  const rows = Array.from({ length: nr }, () => []);
  let cells = 0;
  for (let j = 0; j < nr; j++) {
    for (let i = 0; i < nc; i++) {
      if (taken[j][i]) continue;
      // Right: the column line at colLines[i + cs] is absent through this band?
      let cs = 1;
      const bandOpen = (x, y0, y1) => { for (let y = y0 + 1; y < y1; y++) if (V_CHARS.test(at(y, x))) return false; return true; };
      while (i + cs < nc && !taken[j][i + cs] && bandOpen(colLines[i + cs], rowLines[j], rowLines[j + 1])) cs++;
      // Down: the row line at rowLines[j + rs] is absent across this width?
      let rs = 1;
      const lineOpen = (y, x0, x1) => { for (let x = x0 + 1; x < x1; x++) if (at(y, x) === '─') return false; return true; };
      while (j + rs < nr && lineOpen(rowLines[j + rs], colLines[i], colLines[i + cs])) rs++;
      for (let dj = 0; dj < rs; dj++) for (let di = 0; di < cs; di++) if (taken[j + dj]) taken[j + dj][i + di] = true;
      // The cell's rows become its LINES: a row that opens a new item — a
      // bullet (●, •, -, –), a number ("1."), a letter ("a)") — starts a
      // line, a blank row ends one, and the rest is the previous line's
      // continuation (a word the drawing broke at a row's end, "repro-" /
      // "ducţie", made whole again). `text` is the lines run together, for
      // the search.
      const cellLines = [];
      let open = false; // whether the last line may be continued
      for (let y = rowLines[j] + 1; y < rowLines[j + rs]; y++) {
        const s = grid[y] ? grid[y].slice(colLines[i] + 1, colLines[i + cs]).join('').trim() : '';
        if (!s) { open = false; continue; }
        const starts = /^(?:[●•▪■○\-–—]\s|\d{1,3}[.)]\s|[a-zA-Z][.)]\s|\(\d{1,3}\)\s|\(?[ivx]{1,5}\)\s)/u.test(s);
        if (!open || starts) { cellLines.push(s); open = true; continue; }
        const last = cellLines[cellLines.length - 1];
        cellLines[cellLines.length - 1] = /\p{L}-$/u.test(last) && /^\p{Ll}/u.test(s) ? last.slice(0, -1) + s : `${last} ${s}`;
      }
      rows[j].push({ c: i, text: cellLines.join(' ').replace(/\s+/g, ' '), lines: cellLines, colSpan: cs, rowSpan: rs });
      cells++;
    }
  }
  if (!cells) return null;
  return { cols: nc, rows };
}

// ── Box-drawn DIAGRAMS ──
// An organisation chart, a flow of bodies and arrows — boxes joined by
// lines, drawn in the same characters as a table but not a grid: several
// boxes, side by side or one inside another, with lines running between
// them. Read as BOXES and LINES: a box is a `┌` whose top edge runs along
// `─` (junctions allowed) to a `┐`, whose left edge runs down `│` to a
// `└`, with a `┘` under the `┐` and the other two edges drawn; its text is
// the rows inside it. A box holding another box is a FRAME (the outer
// border of a department). Every other line character is part of a
// CONNECTOR: each character says which of its four sides it joins
// (`─` left+right, `┌` right+down, `├` up+down+right …), and the segment
// from the cell's centre to each joined side is drawn; a junction on a
// box's border draws only the side pointing AWAY from the box, so a line
// meets the box edge cleanly. Segments are then merged into runs.
// `{ w, h, boxes: [{ x, y, w, h, lines, frame }], hseg: [{ y, x1, x2 }],
// vseg: [{ x, y1, y2 }] }` in character units, or null when the drawing is
// not a diagram (fewer than two boxes, or boxes merely stacked — a table).
const DIR_OF = {
  '─': 'LR', '│': 'UD', '┌': 'RD', '┐': 'LD', '└': 'RU', '┘': 'LU',
  '├': 'UDR', '┤': 'UDL', '┬': 'LRD', '┴': 'LRU', '┼': 'UDLR',
};
export function parseBoxDiagram(drawn) {
  const grid = (drawn || []).map((r) => Array.from(r));
  const h = grid.length;
  if (h < 3) return null;
  const w = Math.max(...grid.map((r) => r.length));
  const at = (x, y) => grid[y]?.[x] ?? ' ';
  const H = '─┬┴┼';
  const V = '│├┤┼';
  // The boxes.
  const boxes = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (at(x, y) !== '┌') continue;
      let x2 = x + 1;
      while (x2 < w && H.includes(at(x2, y))) x2++;
      if (at(x2, y) !== '┐') continue;
      let y2 = y + 1;
      while (y2 < h && V.includes(at(x, y2))) y2++;
      if (at(x, y2) !== '└' || at(x2, y2) !== '┘') continue;
      let ok = true;
      for (let xx = x + 1; xx < x2 && ok; xx++) if (!H.includes(at(xx, y2))) ok = false;
      for (let yy = y + 1; yy < y2 && ok; yy++) if (!V.includes(at(x2, yy))) ok = false;
      if (!ok) continue;
      boxes.push({ x, y, x2, y2 });
    }
  }
  if (boxes.length < 2) return null;
  const inside = (a, b) => b.x > a.x && b.x2 < a.x2 && b.y > a.y && b.y2 < a.y2;
  const beside = (a, b) => (a.x2 < b.x || b.x2 < a.x) && a.y <= b.y2 && b.y <= a.y2;
  let diagram = false;
  for (const a of boxes) for (const b of boxes) if (a !== b && (inside(a, b) || beside(a, b))) diagram = true;
  if (!diagram) return null;
  for (const b of boxes) {
    b.frame = boxes.some((o) => o !== b && inside(b, o));
    b.w = b.x2 - b.x + 1; b.h = b.y2 - b.y + 1;
    // Its text: the rows inside it — a frame's holds other boxes and their
    // lines, which are not its words, so a frame keeps only rows that
    // carry no line character at all (a title over its contents, say).
    b.lines = [];
    for (let yy = b.y + 1; yy < b.y2; yy++) {
      const s = (grid[yy] || []).slice(b.x + 1, b.x2).join('').trim();
      if (!s || (b.frame && /[─│┌┐└┘├┤┬┴┼]/u.test(s))) continue;
      b.lines.push(s);
    }
  }
  // Which box borders each cell lies on, and which way is out of the box there.
  const border = new Map();
  for (const b of boxes) {
    for (let xx = b.x; xx <= b.x2; xx++) {
      if (xx > b.x && xx < b.x2) { border.set(`${xx},${b.y}`, (border.get(`${xx},${b.y}`) || '') + 'U'); border.set(`${xx},${b.y2}`, (border.get(`${xx},${b.y2}`) || '') + 'D'); }
    }
    for (let yy = b.y; yy <= b.y2; yy++) {
      if (yy > b.y && yy < b.y2) { border.set(`${b.x},${yy}`, (border.get(`${b.x},${yy}`) || '') + 'L'); border.set(`${b.x2},${yy}`, (border.get(`${b.x2},${yy}`) || '') + 'R'); }
    }
    for (const [cx, cy] of [[b.x, b.y], [b.x2, b.y], [b.x, b.y2], [b.x2, b.y2]]) border.set(`${cx},${cy}`, border.get(`${cx},${cy}`) || '');
  }
  // The connectors, as half-segments from each cell's centre, then merged.
  const hs = []; const vs = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dirs = DIR_OF[at(x, y)];
      if (!dirs) continue;
      const out = border.get(`${x},${y}`);
      const use = out === undefined ? dirs : [...dirs].filter((d) => out.includes(d)).join('');
      if (use.includes('L')) hs.push({ y, x1: x, x2: x + 0.5 });
      if (use.includes('R')) hs.push({ y, x1: x + 0.5, x2: x + 1 });
      if (use.includes('U')) vs.push({ x, y1: y, y2: y + 0.5 });
      if (use.includes('D')) vs.push({ x, y1: y + 0.5, y2: y + 1 });
    }
  }
  const merge = (list, key, a, b) => {
    list.sort((p, q) => (p[key] - q[key]) || (p[a] - q[a]));
    const out = [];
    for (const s of list) {
      const last = out[out.length - 1];
      if (last && last[key] === s[key] && s[a] <= last[b] + 1e-6) last[b] = Math.max(last[b], s[b]);
      else out.push({ ...s });
    }
    return out;
  };
  return { w, h, boxes, hseg: merge(hs, 'y', 'x1', 'x2'), vseg: merge(vs, 'x', 'y1', 'y2') };
}

/** The strings of a diagram in reading order (its boxes' lines, frames included). */
export const diagramStrings = (d) => (d?.boxes || []).flatMap((b) => b.lines);

export function parseActText(text) {
  const out = [];
  const lines = String(text || '').split('\n').flatMap((line) => (
    /[┌]/u.test(line) ? splitTables(line) : [{ type: 'text', s: line }]
  ));
  for (const part of lines) {
    if (part.type === 'table') { out.push({ kind: 'table', rows: part.rows }); continue; }
    const line = part.s;
    const t = tidy(line);
    // "+" is the portal's own separator between units, and a rule of
    // underscores is the printed page's. Neither is content.
    if (!t || t === '+' || /^[_\-–—]{2,}$/.test(t)) continue;
    const unit = UNIT_RE.exec(t);
    if (unit) {
      const word = fold(unit[1]);
      out.push({ kind: 'unit', level: UNIT_LEVEL[word] || 3, text: t });
      continue;
    }
    const art = ART_RE.exec(t);
    if (art) {
      out.push({ kind: 'article', label: tidy(art[1]), body: splitParagraphs(t.slice(art[0].length)) });
      continue;
    }
    if (NOTE_RE.test(t)) { out.push({ kind: 'note', text: t }); continue; }
    out.push({ kind: 'text', body: splitParagraphs(t) });
  }
  return out;
}

// An article's body: its numbered paragraphs, each with its lettered points.
function splitParagraphs(body) {
  const whole = tidy(body);
  if (!whole) return [];
  return whole.split(PARA_SPLIT).map((chunk) => {
    const s = tidy(chunk);
    const m = /^\((\d+)\)\s*/.exec(s);
    return {
      num: m ? m[1] : '',
      text: m ? s.slice(m[0].length) : s,
    };
  }).filter((p) => p.text || p.num);
}

// What the act's masthead says, for the reader's header: everything before the
// title proper, which `normalizeRecord` already separated.
export function actHeading(act) {
  return {
    label: actLabel(act),
    title: act.title || act.titlu,
    issued: act.issued,
    emitent: act.emitent,
    publicatie: act.publicatie,
    republished: act.republished,
    inForce: act.dataVigoare,
  };
}

export function formatBytes(n) {
  if (!n) return '0 KB';
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
