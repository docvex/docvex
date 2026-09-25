#!/usr/bin/env node
// Build the OLD CAEN revisions the app bundles beside Rev. 3 (scripts/build-caen.mjs):
//
//   node scripts/build-caen-old.mjs <CAEN-Rev.2_structura-completa.pdf> <Corespondenta-CAEN-Rev.1-CAEN-Rev.2.pdf> [rev1-act.txt]
//
// Writes src/lib/caenRev2.json and src/lib/caenRev1.json, each the SAME shape
// as caenRev3.json's tree — `{ rev, source, sections, items: { code: { l, n, p } } }`
// — so the page, the tree, the picker and the card read any revision alike.
// caenRev1.json also carries `to2: { rev1 class: [rev2 classes] }`, the INS
// correspondence; Rev. 2 → Rev. 3 already lives in caenRev3.json (`rev2`).
//
// Sources (insse.ro/cms/ro/caen — download by hand, the site's certificate
// chain is incomplete for Node's fetch; `curl -k` works):
//   • CAEN-Rev.2_structura-completa.pdf — the whole Rev. 2 tree, as a table.
//   • Corespondenta-CAEN-Rev.1-CAEN-Rev.2.pdf — two columns of codes.
//   • CAEN Rev. 1 itself the INS site no longer publishes; its official text is
//     the annex of Ordinul INS nr. 601/2002 (M. Of. 908/13.12.2002), which the
//     legislatie.just.ro free service returns whole. With no third argument the
//     script asks the service for it (GetToken + Search); pass a saved copy of
//     the act's text to work offline.
//
// Rev. 1 (NACE Rev. 1.1) also had SUBSECTIONS (AA, DA…); they are dropped and a
// division's parent is its section, so the tree has the four levels the app
// knows. Cedilla ş/ţ are rewritten to comma-below ș/ț everywhere.

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(here, '..', 'src', 'lib');

const [rev2Pdf, mapPdf, actFile] = process.argv.slice(2);
if (!rev2Pdf || !mapPdf) {
  console.error('usage: node scripts/build-caen-old.mjs <CAEN-Rev.2_structura-completa.pdf> <Corespondenta-CAEN-Rev.1-CAEN-Rev.2.pdf> [rev1-act.txt]');
  process.exit(1);
}

const fix = (s) => String(s || '').replace(/ş/g, 'ș').replace(/Ş/g, 'Ș').replace(/ţ/g, 'ț').replace(/Ţ/g, 'Ț').replace(/\s+/g, ' ').trim();

// ── PDF text, as rows ─────────────────────────────────────────────────────
// Every text item of a page grouped by its y (rounded to 2pt), each row's
// cells in x order: `{ page, y, cells: [{ x, s }] }`.
async function pdfRows(file) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(fs.readFileSync(file));
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true, disableFontFace: true }).promise;
  const rows = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    const byY = new Map();
    for (const it of tc.items) {
      if (!it.str || !it.str.trim()) continue;
      const y = Math.round(it.transform[5] / 2) * 2;
      if (!byY.has(y)) byY.set(y, []);
      byY.get(y).push({ x: it.transform[4], s: it.str });
    }
    for (const y of [...byY.keys()].sort((a, b) => b - a)) {
      rows.push({ page: p, y, cells: byY.get(y).sort((a, b) => a.x - b.x) });
    }
  }
  return rows;
}

// ── Rev. 2: the structure table ───────────────────────────────────────────
// Codes stand left of x=190 (division ~74, group ~112, class ~156), names
// from x≈196. A name may run onto the next row (a row of name only, when the
// last entry already has one) or come on the row after its division's code.
async function buildRev2(file) {
  const raw = await pdfRows(file);
  // Page numbers: a row of numbers only, out at the right.
  const isPageNo = (r) => r.cells.every((c) => c.x > 240 && /^\d+$/.test(c.s.trim()));
  const isCodeOnly = (r) => r.cells.length && r.cells.every((c) => c.x < 190 && /^\d{2,4}$/.test(c.s.trim()));
  const isNameOnly = (r) => r.cells.length && r.cells.every((c) => c.x >= 190);
  // A code and its name printed a point or two apart land in two rows (the
  // rounding): a code-only row next to a name-only row within 4pt, in either
  // order, is one row.
  const rows = [];
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i];
    if (isPageNo(r)) continue;
    const n = raw[i + 1];
    if (n && r.page === n.page && Math.abs(r.y - n.y) <= 4
      && ((isCodeOnly(r) && isNameOnly(n)) || (isNameOnly(r) && isCodeOnly(n)))) {
      rows.push({ page: r.page, y: Math.max(r.y, n.y), cells: [...r.cells, ...n.cells].sort((a, b) => a.x - b.x) });
      i += 1;
      continue;
    }
    rows.push(r);
  }
  const sections = [];
  const items = {};
  let section = null;
  let last = null;      // the entry a name-only row would continue
  let pendingDiv = null; // a division code waiting for its name on the next row
  for (const r of rows) {
    const text = r.cells.map((c) => c.s).join(' ');
    if (/^SEC[ŢȚ]IUNEA\b/.test(text)) {
      const m = /^SEC[ŢȚ]IUNEA\s+([A-Z])\s*-?\s*(.+)$/.exec(fix(text));
      if (!m) throw new Error(`section row not read: ${text}`);
      section = m[1];
      sections.push(section);
      items[section] = { l: 's', n: m[2], p: null };
      last = null; pendingDiv = null;
      continue;
    }
    const codeCells = r.cells.filter((c) => c.x < 190 && /^\d{2,4}$/.test(c.s.trim()));
    const nameCells = r.cells.filter((c) => c.x >= 190);
    const name = fix(nameCells.map((c) => c.s).join(' '));
    // Headers, the title, page numbers.
    if (!codeCells.length && (!name || /^(Diviziune|Grupă|Grupa|Clasă|Clasa|CAEN Rev|Clasificarea|n\.c\.a\.)/.test(name))) {
      if (!codeCells.length && /^\d+$/.test(text.trim())) continue; // page number
      if (!name) continue;
      if (/^(Diviziune|Grupă|Grupa|Clasă|Clasa|CAEN Rev|Clasificarea|n\.c\.a\.)/.test(name)) continue;
    }
    if (codeCells.length) {
      const code = codeCells[0].s.trim();
      if (!section) throw new Error(`code ${code} before any section`);
      const l = code.length === 2 ? 'd' : code.length === 3 ? 'g' : 'c';
      const p = l === 'd' ? section : l === 'g' ? code.slice(0, 2) : code.slice(0, 3);
      if (!items[p]) throw new Error(`${code}: parent ${p} unknown`);
      items[code] = { l, n: name, p };
      last = code;
      pendingDiv = l === 'd' && !name ? code : null;
      continue;
    }
    if (name) {
      if (pendingDiv) { items[pendingDiv].n = name; pendingDiv = null; continue; }
      if (last) items[last].n = fix(`${items[last].n} ${name}`);
    }
  }
  return { sections, items };
}

// ── Rev. 1 → Rev. 2: the correspondence ───────────────────────────────────
// A row with a code in the LEFT column opens a Rev. 1 class; every row's
// right-column code is one Rev. 2 class it went to.
async function buildMap(file) {
  const rows = await pdfRows(file);
  const to2 = {};
  let cur = null;
  for (const r of rows) {
    const left = r.cells.find((c) => c.x < 100 && /^\d{4}$/.test(c.s.trim()));
    const right = r.cells.find((c) => c.x >= 100 && c.x < 200 && /^\d{4}$/.test(c.s.trim()));
    if (left) { cur = left.s.trim(); to2[cur] = to2[cur] || []; }
    if (right && cur) { if (!to2[cur].includes(right.s.trim())) to2[cur].push(right.s.trim()); }
  }
  return to2;
}

// ── Rev. 1: the 2002 order's annex ────────────────────────────────────────
// The service's `Text` of the act, its annex being the nomenclature with its
// notes: every unit opens a segment (segments are separated by two or more
// spaces) as "CODE Name" — a letter for a section (two letters for a
// subsection, dropped), then two, three, four digits. Notes and lists follow
// as their own segments. A class is kept only if the correspondence knows it
// (the notes mention numbers too), and codes must come in order.
async function fetchAct() {
  const EP = 'https://legislatie.just.ro/apiws/FreeWebService.svc/SOAP';
  const NS = 'http://tempuri.org/IFreeWebService';
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
  const post = async (action, body) => {
    const r = await fetch(EP, { method: 'POST', headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: `"${NS}/${action}"`, 'User-Agent': UA },
      body: `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>${body}</s:Body></s:Envelope>` });
    if (!r.ok) throw new Error(`legislatie.just.ro answered ${r.status}`);
    return r.text();
  };
  const field = (block, tag) => { const m = new RegExp(`<(?:\\w+:)?${tag}[^>]*>([\\s\\S]*?)</(?:\\w+:)?${tag}>`).exec(block); return m ? m[1] : ''; };
  const unxml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(x?)([0-9a-fA-F]+);/g, (m, h, n) => String.fromCodePoint(parseInt(n, h ? 16 : 10))).replace(/&amp;/g, '&');
  const token = field(await post('GetToken', '<GetToken xmlns="http://tempuri.org/"/>'), 'GetTokenResult');
  if (!token) throw new Error('no token from legislatie.just.ro');
  const xml = await post('Search', '<Search xmlns="http://tempuri.org/"><SearchModel xmlns:d="http://schemas.datacontract.org/2004/07/FreeWebService">'
    + '<d:NumarPagina>1</d:NumarPagina><d:RezultatePagina>20</d:RezultatePagina><d:SearchAn>2002</d:SearchAn><d:SearchNumar>601</d:SearchNumar><d:SearchTitlu>CAEN</d:SearchTitlu>'
    + `</SearchModel><tokenKey>${token}</tokenKey></Search>`);
  const re = /<(?:\w+:)?Legi>([\s\S]*?)<\/(?:\w+:)?Legi>/g;
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    const titlu = unxml(field(m[1], 'Titlu'));
    if (/601/.test(field(m[1], 'Numar')) && /CAEN/i.test(titlu)) return unxml(field(m[1], 'Text'));
  }
  throw new Error('Ordinul 601/2002 not found on the portal');
}

function buildRev1(actText, to2) {
  const known = new Set(Object.keys(to2));
  const start = actText.indexOf('Anexa');
  const body = fix(actText.slice(start < 0 ? 0 : start).replace(/\s{2,}/g, '\u0000')).split('\u0000').map((s) => s.trim()).filter(Boolean);
  // `fix` collapsed the double spaces; they were turned into NUL first.
  const segs = actText.slice(start < 0 ? 0 : start).split(/\s{2,}/).map((s) => fix(s)).filter(Boolean);
  void body;
  const sections = [];
  const items = {};
  let section = null;
  let lastCode = '';
  const later = (a, b) => (a.length !== b.length ? true : a > b);
  for (const seg of segs) {
    let m;
    if ((m = /^([A-Z])\s+([A-ZĂÂÎȘȚ][A-ZĂÂÎȘȚ ,;:()\-./]+)$/.exec(seg)) && (!section || m[1] > section)) {
      section = m[1];
      sections.push(section);
      items[section] = { l: 's', n: m[2].trim(), p: null };
      lastCode = '';
      continue;
    }
    if (/^[A-Z]{2}\s+[A-ZĂÂÎȘȚ]/.test(seg)) continue; // a subsection (AA, DA…): dropped
    if ((m = /^(\d{4})\s+(.+)$/.exec(seg))) {
      const [, code, name] = m;
      if (!known.has(code) || !section || items[code]) continue;
      const g = code.slice(0, 3);
      if (!items[g]) continue; // a number in a note, not a class
      if (lastCode && !later(code, lastCode) && lastCode.length === 4 && code <= lastCode) continue;
      items[code] = { l: 'c', n: name, p: g };
      lastCode = code;
      continue;
    }
    if ((m = /^(\d{3})\s+([^\d].+)$/.exec(seg))) {
      // A group whose note follows in the same segment ("… în clasele acestei
      // grupe se încadrează …"): the name ends where the note begins.
      const code = m[1];
      const name = m[2].replace(/\s+(în clasele acestei grupe|Aceast[ăa]\s).*$/i, '');
      const d = code.slice(0, 2);
      if (!items[d] || items[code]) continue;
      items[code] = { l: 'g', n: name, p: d };
      lastCode = code;
      continue;
    }
    if ((m = /^(\d{2})\s+([^\d].+)$/.exec(seg))) {
      const [, code, name] = m;
      if (!section || items[code]) continue;
      // A division's classes are in the correspondence: keep only such codes.
      if (![...known].some((k) => k.startsWith(code))) continue;
      items[code] = { l: 'd', n: name, p: section };
      lastCode = code;
    }
  }
  return { sections, items };
}

const count = (items) => {
  const c = { s: 0, d: 0, g: 0, c: 0 };
  for (const it of Object.values(items)) c[it.l] += 1;
  return c;
};

const rev2 = await buildRev2(rev2Pdf);
const c2 = count(rev2.items);
console.log(`Rev. 2: ${c2.s} sections, ${c2.d} divisions, ${c2.g} groups, ${c2.c} classes`);
if (c2.s !== 21 || c2.c !== 615) console.warn('  (expected 21 sections and 615 classes — check the PDF)');
const unnamed2 = Object.entries(rev2.items).filter(([, it]) => !it.n).map(([k]) => k);
if (unnamed2.length) console.warn('  unnamed:', unnamed2.join(' '));

const to2 = await buildMap(mapPdf);
console.log(`Rev. 1 → Rev. 2: ${Object.keys(to2).length} Rev. 1 classes, ${Object.values(to2).reduce((n, a) => n + a.length, 0)} correspondences`);
// The INS table names a few Rev. 2 codes that Rev. 2 never had (its own
// typos — 1341, 1343, 1345, 6321, 7920 in the 2008 edition); they are dropped
// rather than guessed at, and said here.
const missing2 = new Set();
for (const [k, list] of Object.entries(to2)) {
  to2[k] = list.filter((t) => { if (rev2.items[t]) return true; missing2.add(`${k}→${t}`); return false; });
}
if (missing2.size) console.warn('  dropped, not in Rev. 2 (the table\x27s own errata):', [...missing2].join(' '));

const actText = actFile ? fs.readFileSync(actFile, 'utf8') : await fetchAct();
const rev1 = buildRev1(actText, to2);
const c1 = count(rev1.items);
console.log(`Rev. 1: ${c1.s} sections, ${c1.d} divisions, ${c1.g} groups, ${c1.c} classes`);
const lost = Object.keys(to2).filter((k) => !rev1.items[k]);
if (lost.length) console.warn(`  ${lost.length} classes of the correspondence not found in the act:`, lost.join(' '));

const SOURCE = 'Institutul Național de Statistică — insse.ro/cms/ro/caen';
fs.writeFileSync(path.join(OUT_DIR, 'caenRev2.json'), JSON.stringify({
  rev: 2, source: SOURCE, files: [path.basename(rev2Pdf)], sections: rev2.sections, items: rev2.items,
}));
fs.writeFileSync(path.join(OUT_DIR, 'caenRev1.json'), JSON.stringify({
  rev: 1, source: `${SOURCE}; Ordinul INS nr. 601/2002 (M. Of. 908/2002) via legislatie.just.ro`, files: [path.basename(mapPdf), 'Ordinul 601/2002'],
  sections: rev1.sections, items: rev1.items, to2,
}));
console.log('written src/lib/caenRev2.json and src/lib/caenRev1.json');
