// CAEN — Clasificarea Activităților din Economia Națională, in the app.
//
// The nomenclature a Romanian company's object of activity is written in. It
// ships WITH the app (caenRev3.json, built by scripts/build-caen.mjs from the
// National Institute of Statistics' own files) rather than being fetched: it is
// a few hundred entries, it changes by whole revisions years apart (Rev. 2 in
// 2008, Rev. 3 in 2025), and a lookup that needs a network is a lookup that
// fails in a courtroom. A new revision is a re-run of the script and a release.
//
// TWO REVISIONS ARE LIVE AT ONCE, and that is the one subtle thing here. Rev. 3
// is in force since 1 January 2025, but every articles of association, trade-
// register extract and contract written before then cites Rev. 2 — and a
// number can mean different things in the two ("6201" was custom software in
// Rev. 2; in Rev. 3 it does not exist and the activity is 6210). So a code is
// never looked up blind: a citation that names its revision is read in that
// revision, and one that doesn't is shown in Rev. 3 WITH what it meant in
// Rev. 2 whenever the two disagree. The reader decides which one the document
// meant; the app never silently picks.
//
// Both JSON files are lazy-imported: the structure (~150 KB) when a code is
// first looked up, the explanatory notes (~780 KB) only when one is opened.

let dataPromise = null;
let notesPromise = null;
const oldPromise = { 1: null, 2: null };

/** The structure: `{ rev: 3, sections, items: { code: { l, n, p } }, rev2: { code: { n, to } } }`. */
export function loadCaen() {
  if (!dataPromise) {
    dataPromise = import('./caenRev3.json')
      .then((m) => ({ rev: 3, ...(m.default || m) }))
      .catch((err) => { dataPromise = null; throw err; });
  }
  return dataPromise;
}

/**
 * THREE REVISIONS are bundled, one tree each of the same shape — Rev. 3
 * (caenRev3.json), Rev. 2 (caenRev2.json) and Rev. 1 (caenRev1.json, with
 * `to2`, the INS correspondence into Rev. 2; built by scripts/build-caen-old.mjs)
 * — so the page, the tree, the picker and the card read any of them alike.
 * `loadCaenRev(rev)` → that tree (`rev` 1, 2 or 3).
 */
export function loadCaenRev(rev) {
  const r = Number(rev);
  if (r === 3 || !REV_INFO[r]) return loadCaen();
  if (!oldPromise[r]) {
    oldPromise[r] = (r === 2 ? import('./caenRev2.json') : import('./caenRev1.json'))
      .then((m) => m.default || m)
      .catch((err) => { oldPromise[r] = null; throw err; });
  }
  return oldPromise[r];
}

/** What each revision is: when it was in force and the act that gave it. */
export const REV_INFO = {
  1: { years: '2003 – 2007', from: '1 January 2003', to: '31 December 2007', act: 'Ordinul INS nr. 601/2002' },
  2: { years: '2008 – 2024', from: '1 January 2008', to: '31 December 2024', act: 'Ordinul INS nr. 337/2007' },
  3: { years: 'since 2025', from: '1 January 2025', to: '', act: 'Ordinul INS nr. 377/2024' },
};
export const REVS_ALL = [1, 2, 3];

/**
 * Where a class WENT in the next revision — `[{ code, name, rev }]` — and
 * where it CAME FROM in the one before, read across the trees the caller has
 * loaded (`trees`: `{ 1?, 2?, 3? }`). Rev. 1 → 2 is caenRev1.json's `to2`,
 * Rev. 2 → 3 is caenRev3.json's `rev2`. Empty when the trees needed are not
 * loaded, or the class is not in the mapping.
 */
export function caenNext(trees, rev, code) {
  const c = normCode(code);
  if (rev === 1) {
    const to = trees[1]?.to2?.[c] || [];
    return to.map((t) => ({ code: t, name: trees[2]?.items?.[t]?.n || '', rev: 2 }));
  }
  if (rev === 2) {
    const to = trees[3]?.rev2?.[c]?.to || [];
    return to.map((t) => ({ code: t, name: trees[3]?.items?.[t]?.n || '', rev: 3 }));
  }
  return [];
}
export function caenPrev(trees, rev, code) {
  const c = normCode(code);
  if (rev === 2) {
    const out = [];
    for (const [k, to] of Object.entries(trees[1]?.to2 || {})) if (to.includes(c)) out.push({ code: k, name: trees[1]?.items?.[k]?.n || '', rev: 1 });
    return out;
  }
  if (rev === 3) return caenFromRev2(trees[3], c).map((f) => ({ ...f, rev: 2 }));
  return [];
}

/** The explanatory notes: `{ code: { i: includes, a: also includes, e: excludes } }`. */
export function loadCaenNotes() {
  if (!notesPromise) {
    notesPromise = import('./caenRev3Notes.json')
      .then((m) => m.default || m)
      .catch((err) => { notesPromise = null; throw err; });
  }
  return notesPromise;
}

export const LEVEL_LABEL = { s: 'Section', d: 'Division', g: 'Group', c: 'Class' };

/**
 * A name as a sentence — the INS writes sections in capitals ("INDUSTRIA
 * PRELUCRĂTOARE"); in a pill or a tooltip they read as shouting. Romanian
 * lower-casing, so the diacritics fold right.
 */
export const sentenceCase = (s) => {
  const t = String(s || '').toLocaleLowerCase('ro');
  return t ? t.charAt(0).toLocaleUpperCase('ro') + t.slice(1) : '';
};
export const LEVEL_LABEL_RO = { s: 'Secțiunea', d: 'Diviziunea', g: 'Grupa', c: 'Clasa' };

// Romanian is typed with ș/ț, with ş/ţ, or with neither — search in folded form.
export const fold = (s) => String(s || '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase();

/** A code as a citation writes it, normalised: digits only, or a section letter. */
export function normCode(code) {
  const s = String(code || '').trim();
  if (/^[A-Va-v]$/.test(s)) return s.toUpperCase();
  return s.replace(/\D/g, '');
}

/** One Rev. 3 entry with its chain of parents, top first. */
export function caenEntry(data, code) {
  const c = normCode(code);
  const it = data?.items?.[c];
  if (!it) return null;
  const path = [];
  for (let p = it.p; p && data.items[p]; p = data.items[p].p) {
    path.unshift({ code: p, level: data.items[p].l, name: data.items[p].n });
  }
  return { code: c, level: it.l, name: it.n, path };
}

/** The direct children of a Rev. 3 entry (a section's divisions, and so on). */
export function caenChildren(data, code) {
  const c = normCode(code);
  const out = [];
  for (const [k, it] of Object.entries(data?.items || {})) {
    if (it.p === c) out.push({ code: k, level: it.l, name: it.n });
  }
  return out;
}

/** The Rev. 2 classes that became this Rev. 3 class. */
export function caenFromRev2(data, code) {
  const c = normCode(code);
  const out = [];
  for (const [k, e] of Object.entries(data?.rev2 || {})) {
    if (e.to.includes(c)) out.push({ code: k, name: e.n });
  }
  return out;
}

/** A Rev. 2 class and the Rev. 3 classes it went to. */
export function caenRev2Entry(data, code) {
  const c = normCode(code);
  const e = data?.rev2?.[c];
  if (!e) return null;
  return { code: c, name: e.n, to: e.to.map((t) => caenEntry(data, t)).filter(Boolean) };
}

/**
 * What a cited code means. `rev` is the revision the citation names (2, 3, or
 * nothing). Returns
 *   { code, rev, entry, rev2, changed }
 * where `entry` is the Rev. 3 reading, `rev2` the Rev. 2 one, `rev` the one the
 * citation should be read in, and `changed` true when both exist and disagree —
 * the case where the document's date decides what it meant. "Disagree" means
 * the Rev. 2 class went somewhere OTHER than the same number — a reworded name
 * (most of the list was lightly reworded) is the same activity, not a change.
 */
export function resolveCaen(data, code, rev) {
  const c = normCode(code);
  const entry = caenEntry(data, c);
  const r2 = c.length === 4 ? caenRev2Entry(data, c) : null;
  let as = rev === 2 || rev === 3 ? rev : 0;
  if (!as) as = entry ? 3 : r2 ? 2 : 3;
  const changed = !!(entry && r2 && (r2.to.length !== 1 || r2.to[0].code !== c));
  return { code: c, rev: as, entry, rev2: r2, changed };
}

/**
 * Search ONE revision's tree by code or by words. Codes match by prefix, words
 * must all appear in the name. Ordered: exact code, then classes before groups
 * before divisions, then by code. Every hit carries the tree's `rev`; a page
 * searching "all revisions" runs this over each tree and joins the answers.
 */
export function searchCaen(data, query, { limit = 80 } = {}) {
  const q = String(query || '').trim();
  if (!q || !data) return [];
  const digits = /^d{1,4}$/.test(q.replace(/[s.]/g, '')) ? q.replace(/[s.]/g, '') : '';
  const words = digits ? [] : fold(q).split(/s+/).filter(Boolean);
  const matches = (code, name) => (digits
    ? code.startsWith(digits)
    : (words.every((w) => fold(name).includes(w)) || (words.length === 1 && fold(code) === words[0])));
  const rank = { c: 0, g: 1, d: 2, s: 3 };
  const rev = data.rev || 3;
  const hits = [];
  for (const [code, it] of Object.entries(data.items)) {
    if (!matches(code, it.n)) continue;
    hits.push({ code, level: it.l, name: it.n, rev });
  }
  hits.sort((a, b) => ((b.code === digits) - (a.code === digits))
    || (rank[a.level] - rank[b.level]) || a.code.localeCompare(b.code));
  return hits.slice(0, limit);
}

/** The in-app route for a code — `/caen?code=4100` (`&rev=2` / `&rev=1` for an old one). */
export function caenHref(code, rev) {
  const c = normCode(code);
  return `/caen?code=${encodeURIComponent(c)}${rev === 2 || rev === 1 ? `&rev=${rev}` : ''}`;
}

/** The revision a citation names — "CAEN Rev. 2 – 6201" → 2; none → 0. */
export function revisionOf(raw) {
  const m = /Rev\.?\s*(\d)/i.exec(String(raw || ''));
  return m ? Number(m[1]) : 0;
}

/**
 * Splits a note into lines and, in each line, marks the codes it points at
 * ("…vezi 0163, 1200") so they can be made into links. Only numbers AFTER a
 * "vezi" / "a se vedea" count: a note also carries quantities and years.
 * Returns `[[{ text } | { code }]]`, one array per line.
 */
export function noteLines(text, data) {
  return String(text || '').split('\n').map((line) => {
    const at = line.search(/\b(?:vezi|a\s+se\s+vedea)\b/i);
    if (at < 0) return [{ text: line }];
    const parts = [{ text: line.slice(0, at) }];
    const rest = line.slice(at);
    let last = 0;
    for (const m of rest.matchAll(/\b\d{2,4}\b/g)) {
      if (!data?.items?.[m[0]]) continue;
      parts.push({ text: rest.slice(last, m.index) }, { code: m[0] });
      last = m.index + m[0].length;
    }
    parts.push({ text: rest.slice(last) });
    return parts.filter((p) => p.code || p.text);
  });
}
