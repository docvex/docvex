// COLLECTIONS OF FILES (2026-09-28) — the Files tab's own grouping: a
// collection is a CUSTOM FOLDER that holds no files of its own — it POINTS at
// files wherever they are in the project (paths inside the project, forward
// slashes), wears its own icon in the listing, and opening it shows its files.
// Not to be confused with the AI scan's DATA collections (`.dvc`, lib/
// dataCollections), which are what the AI gathered about a subject; those are
// one of the sources used here to NAME a collection.
//
// Collections are MADE two ways (the Files footer's Collect button,
// ProjectFiles `fxCollect`): from the files selected — one collection of them;
// with nothing selected, by DocVex, ONLY where files are one thing: EXACT
// DUPLICATES, the SAME CONTENT in another file or format, or parts of the SAME
// DOCUMENT (see findSamePairs below). Inside a collection its files stand in
// one section per such kind, each group on its own ground (`clustersOf`).
//
// Stored in the project's settings store `collections`
// (`.docvex/settings/collections.json`, lib/projectIndexClient — travels with
// the case folder and account sync), with a localStorage mirror per folder for
// the first paint and machines without the index.
import {
  SETTINGS_STORES, peekSetting, putSetting, projectIdForDir, projectDirSpellings, subscribeIndex,
} from './projectIndexClient';

const KEY = 'docvex:collections:v1:';
const EVENT = 'docvex:collections-changed';
const STORE = SETTINGS_STORES.fileGroups;

// ── Storage ──────────────────────────────────────────────────────────────
const clean = (list) => (Array.isArray(list) ? list : [])
  .filter((c) => c && c.id && Array.isArray(c.rels))
  .map((c) => ({
    id: String(c.id), name: String(c.name || 'Collection'), rels: [...new Set(c.rels.map(String))], at: Number(c.at) || 0, source: c.source === 'ai' ? 'ai' : 'manual', kind: c.kind || '',
    // The pairs that made it (findSamePairs), kept so an opened collection
    // shows its sections at once; re-checked in the background.
    pairs: Array.isArray(c.pairs) ? c.pairs.filter((x) => x && x.a && x.b && SAME_KIND_IDS.includes(x.kind)).map((x) => ({ a: String(x.a), b: String(x.b), kind: x.kind, why: String(x.why || '') })) : [],
  }));
const SAME_KIND_IDS = ['exact', 'content', 'document'];

export function loadFileGroups(projectDir) {
  if (!projectDir) return [];
  const projectId = projectIdForDir(projectDir);
  const value = projectId ? peekSetting(projectId, STORE) : undefined;
  if (Array.isArray(value)) return clean(value);
  try { return clean(JSON.parse(localStorage.getItem(KEY + projectDir) || '[]')); } catch { return []; }
}

function save(projectDir, list) {
  const out = clean(list);
  try { localStorage.setItem(KEY + projectDir, JSON.stringify(out)); } catch { /* full */ }
  const projectId = projectIdForDir(projectDir);
  if (projectId) void putSetting(projectId, STORE, out);
  try { window.dispatchEvent(new CustomEvent(EVENT, { detail: { projectDir } })); } catch { /* no window */ }
  return out;
}

const newId = () => `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Add collections ({ name, rels, source, kind }); returns the new list. */
export function addFileGroups(projectDir, groups) {
  const list = loadFileGroups(projectDir);
  for (const g of groups) list.push({ id: newId(), at: Date.now(), ...g });
  return save(projectDir, list);
}
export function renameFileGroup(projectDir, id, name) {
  const n = String(name || '').trim();
  if (!n) return loadFileGroups(projectDir);
  return save(projectDir, loadFileGroups(projectDir).map((c) => (c.id === id ? { ...c, name: n } : c)));
}
export function removeFileGroup(projectDir, id) {
  return save(projectDir, loadFileGroups(projectDir).filter((c) => c.id !== id));
}
export function addToFileGroup(projectDir, id, rels) {
  return save(projectDir, loadFileGroups(projectDir).map((c) => (c.id === id ? { ...c, rels: [...c.rels, ...rels] } : c)));
}
export function removeFromFileGroup(projectDir, id, rels) {
  const drop = new Set(rels);
  return save(projectDir, loadFileGroups(projectDir).map((c) => (c.id === id ? { ...c, rels: c.rels.filter((r) => !drop.has(r)) } : c)));
}

export function subscribeFileGroups(fn) {
  const onLocal = (e) => fn(e.detail?.projectDir || '');
  const onStorage = (e) => { if (e.key && e.key.startsWith(KEY)) fn(e.key.slice(KEY.length)); };
  window.addEventListener(EVENT, onLocal);
  window.addEventListener('storage', onStorage);
  const off = subscribeIndex((ev) => {
    if (ev.type !== 'settings' || ev.store !== STORE) return;
    for (const dir of projectDirSpellings(ev.projectId)) fn(dir);
  });
  return () => { window.removeEventListener(EVENT, onLocal); window.removeEventListener('storage', onStorage); off(); };
}

// ── Duplicates ───────────────────────────────────────────────────────────
// A name with its copy marks taken off: "Contract (2).pdf", "Contract - Copy.pdf",
// "Contract (edited).pdf", "Contract copy.pdf" → "contract.pdf".
export function copyStem(name) {
  const n = String(name || '').toLowerCase();
  const dot = n.lastIndexOf('.');
  const ext = dot > 0 ? n.slice(dot) : '';
  let base = dot > 0 ? n.slice(0, dot) : n;
  for (let i = 0; i < 3; i += 1) {
    base = base
      .replace(/\s*\((?:\d+|copy|copie|edited|scan|frame|pages|editat)\)\s*$/i, '')
      .replace(/\s*[-_ ]\s*(?:copy|copie)(?:\s*\(\d+\))?\s*$/i, '')
      .replace(/\s+(?:copy|copie)\s*$/i, '')
      .trim();
  }
  return base + ext;
}

// ── WHAT GROUPS FILES (2026-09-28, the user's rule) ──────────────────────
// A collection is made ONLY of files that are one thing, in three ways:
//   • EXACT DUPLICATE — the same bytes (same size, then the same SHA-256);
//   • SAME CONTENT — one content in another file or format: a Word file and
//     the PDF made from it (the viewer's Convert / To Word / To images), a
//     photo and its scan or edited copy, a picture re-saved in another format.
//     Judged by the TEXT read out of both (extracted text, OCR, the document's
//     own text: 5-word shingles, Jaccard ≥ CONTENT_MIN) or, for pictures, by
//     their look (the difference hash of the OS thumbnail, Hamming ≤ 6);
//   • SAME DOCUMENT — different parts of ONE document: the front and back of
//     an identity card (the same CNP, the same series and number — printed or
//     in the MRZ — or the same holder born the same day), the pages of one
//     document wherever and however they are kept ("Pagina 2 din 5" beside
//     "Pagina 4 din 5" of the same kind and parties, "contract p1.jpg" beside
//     "contract p2.jpg", a PDF's "(pages)" folder beside the PDF, photos of the
//     same kind of document naming the same people taken minutes apart).
// Links between merely RELATED files (a contract and its invoice) no longer
// group anything. Every signal is local: bytes, names, folders, modified
// times, the saved extracted text (lib/aiData), what the AI scan understood
// (the `understanding` facet: document type, parties and their identifiers,
// the identity document read), and text read now from a Word / PDF / text
// file that has none saved.
export const CONTENT_MIN = 0.72;
const TEXT_MIN = 120;
const DHASH_MAX = 6;
const MINUTE = 60 * 1000;
export const SAME_KINDS = {
  exact: { label: 'Exact duplicates', tie: 'Exact copy', icon: 'copy', tone: 'var(--warning)' },
  content: { label: 'Same content, other format', tie: 'Same content', icon: 'file-doc', tone: 'var(--info)' },
  document: { label: 'Same document', tie: 'Same document', icon: 'categories', tone: 'var(--success)' },
};
const RANK = { exact: 3, content: 2, document: 1 };

const foldText = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const extOf = (name) => { const m = /\.([^.]+)$/.exec(String(name || '')); return m ? m[1].toLowerCase() : ''; };
const IMG = /^(jpe?g|png|webp|gif|bmp|tiff?|heic|heif)$/;
// A person's name as a key: its words folded and sorted ("Ion Popescu" = "POPESCU ION").
const nameKey = (s) => foldText(s).replace(/[^a-z]+/g, ' ').trim().split(' ').filter(Boolean).sort().join(' ');

// A name with its SIDE / PAGE words taken off ("CI fata.jpg", "CI verso.jpg",
// "contract p2.jpg", "contract - page 3.png", "scan pagina 1.pdf" → the stem
// they share) and the part they name. Bare numbers are left alone —
// IMG_1234 and IMG_1235 are not one document.
export function partOfName(name) {
  let base = foldText(name).replace(/\.[^.]+$/, '');
  let part = '';
  const m = /[\s._-]*\(?\b(fata|faţa|front|recto|verso|spate|back|p|pg|pag|pagina|page|partea|part)\s*\.?\s*(\d{0,3})\)?\s*$/.exec(base);
  if (m && (m[2] || /^(fata|faţa|front|recto|verso|spate|back)$/.test(m[1]))) {
    part = `${m[1]}${m[2] || ''}`;
    base = base.slice(0, m.index);
  }
  base = base.replace(/\s*\((?:\d+|copy|copie|edited|scan|frame|editat)\)\s*$/, '').replace(/[\s._-]+$/, '').trim();
  return { stem: base, part };
}
// "Pagina 2 din 5", "Page 2 of 5", "pag. 2/5" → { page, total }.
export function pageMarkerOf(text) {
  const m = /\bpag(?:ina|e)?\.?\s*(\d{1,3})\s*(?:din|of|\/)\s*(\d{1,3})\b/i.exec(foldText(text));
  if (!m) return null;
  const page = Number(m[1]); const total = Number(m[2]);
  return page >= 1 && total >= 2 && page <= total ? { page, total } : null;
}

// Identity keys a file carries: its CNPs (valid), document series + number
// (printed or in the MRZ), and its holder + birth date.
export function identityKeysOf(text, u, { decodeCnp, parseMrz } = {}) {
  const keys = new Set();
  const t = String(text || '');
  for (const m of t.matchAll(/\b([1-9]\d{12})\b/g)) {
    const d = decodeCnp ? decodeCnp(m[1]) : { valid: true };
    if (d?.valid) keys.add(`cnp:${m[1]}`);
    // The holder + birth date: counted even when one digit was misread (the
    // check digit fails) — it only matters together with the same NAME.
    const holder = nameKey(u?.idDocument?.holder || '');
    if (holder && d?.birth_date) keys.add(`hb:${holder}|${d.birth_date}`);
  }
  for (const m of foldText(t).matchAll(/seria\s*([a-z]{2})\s*(?:nr\.?|numar|n°)?\s*(\d{6,7})/g)) keys.add(`doc:${m[1]}${m[2]}`);
  if (parseMrz) {
    let z = null;
    try { z = parseMrz(t); } catch { z = null; }
    // Its document number — kept even when its check digit fails: it only
    // matters when it equals the number PRINTED on the other side.
    if (z?.docNumber) {
      const n = foldText(z.docNumber).replace(/[^a-z0-9]/g, '');
      keys.add(`doc:${n}`);
      if (/^[a-z]{2}\d{7}$/.test(n)) keys.add(`doc:${n.slice(0, 8)}`); // a check digit run in
    }
    const name = nameKey([z?.surname, z?.given].filter(Boolean).join(' '));
    if (name && z?.birth) keys.add(`hb:${name}|${z.birth}`);
  }
  for (const p of u?.parties || []) for (const id of p.identifiers || []) {
    const cnp = String(id).replace(/\D/g, '');
    if (cnp.length === 13 && (!decodeCnp || decodeCnp(cnp)?.valid)) keys.add(`cnp:${cnp}`);
  }
  return keys;
}
const isIdDocument = (text, u) => !!u?.idDocument
  || /carte (electronica )?de identitate|identity card|buletin de identitate|pasaport|passport|permis de conducere|i<rou|idrou/i.test(foldText(String(text || '').slice(0, 4000)));

/**
 * The pairs of files that are one thing — [{ a, b, kind: 'exact' | 'content'
 * | 'document', why }] — among `files` ({ rel, path, name, size, mtime }).
 * `deps`: { hash(path), dhash(path), textOf(file), understandingOf(file),
 * decodeCnp, parseMrz, hamming, shingles, likeness, signal }.
 */
export async function findSamePairs(files, deps = {}) {
  const { hash, dhash, textOf, understandingOf, hamming, shingles, likeness, signal } = deps;
  const pairs = new Map();
  const add = (a, b, kind, why) => {
    if (a === b) return;
    const k = a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
    const prev = pairs.get(k);
    if (!prev || RANK[kind] > RANK[prev.kind]) pairs.set(k, { a: a < b ? a : b, b: a < b ? b : a, kind, why });
  };
  const has = (a, b) => pairs.has(a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);

  // 1. EXACT — same size, then the same bytes.
  const bySize = new Map();
  for (const f of files) if (f.size > 0) { if (!bySize.has(f.size)) bySize.set(f.size, []); bySize.get(f.size).push(f); }
  if (hash) {
    let spent = 0;
    for (const list of bySize.values()) {
      if (list.length < 2 || spent + list[0].size * list.length > 600 * 1024 * 1024) continue;
      spent += list[0].size * list.length;
      const byHash = new Map();
      for (const f of list) {
        if (signal?.aborted) return [];
        let h = null;
        try { h = await hash(f.path); } catch { h = null; }
        if (!h) continue;
        if (byHash.has(h)) add(byHash.get(h), f.rel, 'exact', 'The same bytes');
        else byHash.set(h, f.rel);
      }
    }
  }

  // What is known of each file: its text, what the scan understood, its name.
  const info = new Map();
  for (const f of files) {
    if (signal?.aborted) return [];
    let text = '';
    try { text = textOf ? String((await textOf(f)) || '') : ''; } catch { text = ''; }
    let u = null;
    try { u = understandingOf ? understandingOf(f) : null; } catch { u = null; }
    info.set(f.rel, {
      f, text, u,
      sh: text.length >= TEXT_MIN && shingles ? shingles(text) : null,
      name: partOfName(f.name),
      marker: pageMarkerOf(text),
      ids: identityKeysOf(text, u, deps),
      idDoc: isIdDocument(text, u),
      type: foldText(u?.documentType || '').trim(),
      dir: f.rel.split('/').slice(0, -1).join('/'),
      ext: extOf(f.name),
    });
  }
  const list = [...info.values()];

  // 2. SAME CONTENT — by text…
  if (likeness) {
    const withText = list.filter((x) => x.sh && x.sh.size >= 8);
    for (let i = 0; i < withText.length; i += 1) {
      for (let j = i + 1; j < withText.length; j += 1) {
        const A = withText[i]; const B = withText[j];
        const small = Math.min(A.sh.size, B.sh.size); const big = Math.max(A.sh.size, B.sh.size);
        if (small / big < CONTENT_MIN) continue; // lengths too far apart to be one text
        if (has(A.f.rel, B.f.rel)) continue;
        const l = likeness(A.sh, B.sh);
        if (l >= CONTENT_MIN) add(A.f.rel, B.f.rel, 'content', A.ext !== B.ext ? `The same text as .${A.ext} and .${B.ext} (${Math.round(l * 100)}% alike)` : `The same text (${Math.round(l * 100)}% alike)`);
      }
    }
  }
  // …and, for pictures, by their look.
  if (dhash && hamming) {
    const pics = list.filter((x) => IMG.test(x.ext) || x.ext === 'pdf').slice(0, 300);
    const dh = new Map();
    for (const x of pics) {
      if (signal?.aborted) return [];
      try { const v = await dhash(x.f.path); if (v != null) dh.set(x.f.rel, v); } catch { /* no thumbnail */ }
    }
    const keys = [...dh.keys()];
    for (let i = 0; i < keys.length; i += 1) {
      for (let j = i + 1; j < keys.length; j += 1) {
        if (has(keys[i], keys[j])) continue;
        const A = info.get(keys[i]); const B = info.get(keys[j]);
        // Two pages of one form look alike: a picture pair whose TEXTS say
        // different pages is not the same content.
        if (A.marker && B.marker && A.marker.page !== B.marker.page) continue;
        if (A.sh && B.sh && likeness && likeness(A.sh, B.sh) < 0.35) continue;
        if (hamming(dh.get(keys[i]), dh.get(keys[j])) <= DHASH_MAX) add(keys[i], keys[j], 'content', 'The same picture');
      }
    }
  }

  // 3. SAME DOCUMENT.
  const near = (A, B, mins) => Math.abs((A.f.mtime || 0) - (B.f.mtime || 0)) <= mins * MINUTE;
  const sharedIds = (A, B) => [...A.ids].filter((k) => B.ids.has(k));
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      const A = list[i]; const B = list[j];
      if (has(A.f.rel, B.f.rel)) continue;
      // An identity document's two sides.
      if (A.idDoc && B.idDoc) {
        const shared = sharedIds(A, B);
        if (shared.length) { add(A.f.rel, B.f.rel, 'document', shared.some((k) => k.startsWith('doc:')) ? 'One identity document (the same series and number)' : shared.some((k) => k.startsWith('cnp:')) ? 'One identity document (the same CNP)' : 'One identity document (the same holder and birth date)'); continue; }
      }
      // A name that differs only by the side or the page.
      if (A.name.stem && A.name.stem.length >= 3 && A.name.stem === B.name.stem && (A.name.part || B.name.part) && A.name.part !== B.name.part) {
        add(A.f.rel, B.f.rel, 'document', 'Parts of one document (by name)'); continue;
      }
      // A PDF's "(pages)" folder beside the PDF.
      const pagesOf = (X, Y) => X.dir && /\(pages\)$/.test(foldText(X.dir)) && foldText(X.dir.split('/').pop()).replace(/\s*\(pages\)$/, '') === Y.name.stem && Y.ext === 'pdf';
      if (pagesOf(A, B) || pagesOf(B, A)) { add(A.f.rel, B.f.rel, 'document', 'A page of the PDF, as a picture'); continue; }
      // Pages that say so: one total, different pages, and the same kind of
      // document, people, name or moment.
      if (A.marker && B.marker && A.marker.total === B.marker.total && A.marker.page !== B.marker.page
        && ((A.type && A.type === B.type) || sharedIds(A, B).length || (A.name.stem && A.name.stem === B.name.stem) || near(A, B, 60))) {
        add(A.f.rel, B.f.rel, 'document', `Pages ${A.marker.page} and ${B.marker.page} of ${A.marker.total}`); continue;
      }
      // Photos of one document taken minutes apart: the same kind of document
      // naming the same people.
      if (IMG.test(A.ext) && IMG.test(B.ext) && A.type && A.type === B.type && sharedIds(A, B).length && near(A, B, 20)) {
        add(A.f.rel, B.f.rel, 'document', 'Photos of one document, taken minutes apart');
      }
    }
  }
  return [...pairs.values()];
}

/** Connected groups of the pairs → [{ rels, kinds: Set }]. */
export function groupsOfPairs(pairs) {
  const parent = new Map();
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const add = (x) => { if (!parent.has(x)) parent.set(x, x); };
  for (const p of pairs) { add(p.a); add(p.b); const ra = find(p.a); const rb = find(p.b); if (ra !== rb) parent.set(ra, rb); }
  const out = new Map();
  for (const x of parent.keys()) { const r = find(x); if (!out.has(r)) out.set(r, { rels: [], kinds: new Set() }); out.get(r).rels.push(x); }
  for (const p of pairs) out.get(find(p.a)).kinds.add(p.kind);
  return [...out.values()].filter((g) => g.rels.length > 1);
}

/**
 * The collections proposed from the pairs (findSamePairs): each connected
 * group becomes one. `named(rels)` may name it (the Data collection covering
 * it); `titleOf(rel)` gives a file's document type + subject when the scan
 * read it. `exists`: rels already collected — a group made only of those is
 * not proposed again. → [{ name, rels, kind }]
 */
export function proposeGroups({ pairs = [], exists = new Set(), titleOf = () => '' }) {
  const out = [];
  for (const g of groupsOfPairs(pairs)) {
    if (g.rels.every((r) => exists.has(r))) continue;
    const rels = g.rels.sort();
    const kind = g.kinds.has('document') ? 'document' : g.kinds.has('content') ? 'content' : 'exact';
    const stem = partOfName(String(rels[0]).split('/').pop()).stem || String(rels[0]).split('/').pop();
    const title = rels.map(titleOf).find(Boolean) || '';
    const name = kind === 'exact' ? `Copies of ${stem}`
      : kind === 'content' ? `${title || stem} (all formats)`
        : (title || stem);
    const mine = new Set(rels);
    out.push({ name, rels, kind, pairs: pairs.filter((p) => mine.has(p.a) && mine.has(p.b)) });
  }
  return out.sort((a, b) => b.rels.length - a.rels.length);
}

/**
 * How a collection's files are LAID OUT — one SECTION per way files are one
 * thing (Exact duplicates · Same content, other format · Same document), each
 * of its groups on its own ground, then the files tied to nothing else. A
 * file in two kinds stands in both.
 * → { sections: [{ kind, groups: [[rel]] }], loose: [rel], why: Map(rel → reason) }
 */
export function clustersOf(rels, { pairs = [] } = {}) {
  const inside = new Set(rels);
  const order = new Map(rels.map((r, i) => [r, i]));
  const mine = pairs.filter((p) => inside.has(p.a) && inside.has(p.b));
  const sections = [];
  for (const kind of ['exact', 'content', 'document']) {
    const groups = groupsOfPairs(mine.filter((p) => p.kind === kind))
      .map((g) => g.rels.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0)))
      .sort((a, b) => b.length - a.length);
    if (groups.length) sections.push({ kind, groups });
  }
  const placed = new Set(sections.flatMap((s) => s.groups.flat()));
  const why = new Map();
  for (const p of mine) { if (!why.has(`${p.kind}|${p.a}`)) why.set(`${p.kind}|${p.a}`, p.why); if (!why.has(`${p.kind}|${p.b}`)) why.set(`${p.kind}|${p.b}`, p.why); }
  return { sections, loose: rels.filter((r) => !placed.has(r)), why };
}
