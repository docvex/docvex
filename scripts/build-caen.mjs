// Builds the CAEN nomenclature the app ships with, from the National Institute
// of Statistics' own files (insse.ro/cms/ro/caen):
//
//   node scripts/build-caen.mjs <Note-explicative-CAEN-Rev.3-….xlsx> <Tabel-Corespondenta-CAEN-Rev.2-CAEN-Rev.3_….xlsx>
//
// Download both from https://insse.ro/cms/ro/caen first (the institute's
// server sends an incomplete certificate chain, so Node's fetch refuses it —
// a browser or `curl -k` gets them fine). Writes:
//
//   src/lib/caenRev3.json        — every section, division, group and class
//                                  of CAEN Rev. 3 with its official name, plus
//                                  each Rev. 2 class and where it went (small:
//                                  it is what a lookup needs)
//   src/lib/caenRev3Notes.json   — the explanatory notes (what a class
//                                  includes, also includes, excludes) — large,
//                                  so loaded only when a note is opened
//
// CAEN is an official nomenclature (Ordinul INS nr. 377/2024), which carries no
// copyright under Legea nr. 8/1996 art. 9. It changes by whole revisions, years
// apart; when INS publishes a new file, re-run this and ship a release.

import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const XLSX = require('xlsx');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const [notesFile, corrFile] = process.argv.slice(2);
if (!notesFile || !corrFile) {
  console.error('usage: node scripts/build-caen.mjs <notes.xlsx> <correspondence.xlsx>');
  process.exit(1);
}

const rowsOf = (file) => {
  const wb = XLSX.readFile(file);
  return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' });
};
// Excel stores most codes as numbers, which loses the leading zero ("0111" → 111).
const pad = (v, n) => String(v).trim().replace(/\*$/, '').padStart(n, '0');
// The files mix cedilla ş/ţ with comma-below ș/ț; the app writes comma-below.
const clean = (s) => String(s || '')
  .replace(/ş/g, 'ș').replace(/Ş/g, 'Ș').replace(/ţ/g, 'ț').replace(/Ţ/g, 'Ț')
  .replace(/[ \t]+\n/g, '\n').replace(/[ \t]{2,}/g, ' ').trim();
const oneLine = (s) => clean(s).replace(/\s*\n\s*/g, ' ');

// ── Rev. 3: structure + notes ──────────────────────────────────────────────
// Columns: Secțiune | Diviziune | Grupă | Clasă | name | Include | Include, de asemenea | Exclude
const notesRows = rowsOf(notesFile);
const headerAt = notesRows.findIndex((r) => String(r[0]).trim() === 'Secțiune');
if (headerAt < 0) throw new Error('notes file: header row not found');

const sections = [];
const items = {};  // code → { l: level, n: name, p: parent code }
const notes = {};  // code → { i, a, e }
let sec = null; let div = null; let grp = null;
for (const r of notesRows.slice(headerAt + 1)) {
  const name = oneLine(r[4]);
  if (!name) continue;
  let code; let level; let parent;
  if (String(r[0]).trim()) { code = String(r[0]).trim(); level = 's'; sec = code; sections.push(code); }
  else if (String(r[1]).trim()) { code = pad(r[1], 2); level = 'd'; parent = sec; div = code; }
  else if (String(r[2]).trim()) { code = pad(r[2], 3); level = 'g'; parent = div; grp = code; }
  else if (String(r[3]).trim()) { code = pad(r[3], 4); level = 'c'; parent = grp; }
  else continue;
  items[code] = parent ? { l: level, n: name, p: parent } : { l: level, n: name };
  const note = { i: clean(r[5]), a: clean(r[6]), e: clean(r[7]) };
  for (const k of Object.keys(note)) if (!note[k]) delete note[k];
  if (Object.keys(note).length) notes[code] = note;
}

// ── Rev. 2 → Rev. 3 correspondence ─────────────────────────────────────────
// Columns: Clasă Rev.2 | name | Clasă Rev.3 | name | OBS. A blank Rev. 2 cell
// continues the class above (one Rev. 2 class split over several Rev. 3 ones).
// A blank Rev. 3 cell beside a Rev. 2 class is the other way round: a MERGED
// cell (several Rev. 2 classes folded into one Rev. 3 class — 3101, 3102,
// 3103, 3109 → 3100), whose value SheetJS reports on its first row only.
const corrRows = rowsOf(corrFile);
const corrAt = corrRows.findIndex((r) => /Clas[ăa]\s+CAEN\s+Rev\.?2/i.test(String(r[0])));
if (corrAt < 0) throw new Error('correspondence file: header row not found');

const rev2 = {}; // code → { n: name, to: [rev3 codes] }
let cur = null;
let lastC3 = '';
for (const r of corrRows.slice(corrAt + 1)) {
  const c2 = String(r[0]).trim();
  let c3 = String(r[2]).trim();
  if (c2 && c2 !== '0') {
    const code = pad(c2, 4);
    cur = rev2[code] || (rev2[code] = { n: oneLine(r[1]), to: [] });
    if (!c3) c3 = lastC3;
  } else if (c2 === '0') {
    cur = null; // a Rev. 3 class that came from no Rev. 2 one
  }
  if (c3) lastC3 = c3;
  if (cur && c3 && c3 !== '0') {
    const to = pad(c3, 4);
    if (!cur.to.includes(to)) cur.to.push(to);
  }
}

const missing = Object.values(rev2).flatMap((e) => e.to).filter((c) => !items[c]);
if (missing.length) console.warn('Rev. 3 targets not in the structure:', [...new Set(missing)].join(', '));

const counts = Object.values(items).reduce((m, it) => ({ ...m, [it.l]: (m[it.l] || 0) + 1 }), {});
const data = {
  source: 'Institutul Național de Statistică — insse.ro/cms/ro/caen',
  files: [path.basename(notesFile), path.basename(corrFile)],
  sections,
  items,
  rev2,
};
writeFileSync(path.join(root, 'src/lib/caenRev3.json'), JSON.stringify(data));
writeFileSync(path.join(root, 'src/lib/caenRev3Notes.json'), JSON.stringify(notes));
console.log('CAEN Rev. 3:', counts, '· notes for', Object.keys(notes).length, '· Rev. 2 classes:', Object.keys(rev2).length);
