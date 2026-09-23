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
  legislationArchiveGet, legislationArchiveRemove, legislationArchiveClear,
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
const tidy = (s) => String(s || '').replace(/^﻿/, '').replace(/\s+/g, ' ').trim();

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
    text: typeof raw?.text === 'string' ? raw.text : '',
    savedAt: raw?.savedAt || '',
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
    const res = await legislationSearch(q);
    if (res?.ok) {
      const records = (res.records || []).map(normalizeRecord).filter((r) => typeMatches(r.tipAct, q.tip));
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
    // The year may be the act's own or the one its version came into force —
    // offline, being generous beats saying "nothing".
    if (an && !(r.year === an || (r.dataVigoare || '').startsWith(an))) return false;
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
// The copy on disk first — it is identical to what the portal would send and
// costs nothing — then the portal. An act read this way is kept whole, so the
// second reading of anything is always offline.
export async function loadAct(rec) {
  if (rec?.text) return { ok: true, act: normalizeRecord(rec), source: 'memory' };
  if (rec?.id) {
    const kept = await legislationArchiveGet(rec.id);
    if (kept?.ok && kept.act?.text) return { ok: true, act: normalizeRecord(kept.act), source: 'archive' };
  }
  if (!isElectron) return { ok: false, error: 'unsupported' };
  // Asked for as narrowly as the service allows, then matched by id: there is
  // no "get by id" method, only Search.
  const res = await legislationSearch({
    numar: rec?.numar || '', an: rec?.year || (rec?.dataVigoare || '').slice(0, 4),
    titlu: rec?.title ? rec.title.split(/\s+/).slice(0, 6).join(' ') : '',
    page: 1, perPage: 50,
  });
  if (!res?.ok) return { ok: false, error: res?.error || 'unreachable' };
  const found = (res.records || []).map(normalizeRecord).find((r) => r.id === rec?.id && r.text);
  if (!found) return { ok: false, error: 'not_found' };
  await legislationArchivePut({ records: [found], withText: true });
  return { ok: true, act: found, source: 'live' };
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

export function parseActText(text) {
  const out = [];
  const lines = String(text || '').split('\n');
  for (const line of lines) {
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
