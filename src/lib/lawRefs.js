// Romanian legal references — finding them in a document's text.
//
// Legea nr. 24/2000 (normele de tehnică legislativă) fixes how an act is cited
// in an official, legal or administrative document, and Romanian drafting
// follows it closely. That is what makes a citation findable by SHAPE rather
// than by a list of known laws: it is a category of act, a number, a year and
// (on first mention) the act's title, optionally preceded by the part of it
// being pointed at and followed by a republication / amendment note.
//
// The shapes this recognises, in the order the drafting rules introduce them:
//
//   1. First mention, in full — `[categorie] nr. [număr]/[an] [titlul]`
//        Legea nr. 287/2009 privind Codul civil
//        Ordonanța de urgență a Guvernului nr. 195/2002 privind circulația …
//   2. A structural element of an act — `art. N alin. (N) lit. x) din [act]`
//        Potrivit art. 12 alin. (1) lit. b) din Legea nr. 24/2000 …
//      The element on its own is a reference too (to the act under discussion),
//      so `art. 5 alin. (2)` with no `din …` is still marked.
//   3. Later mentions, short — `Legea nr. 24/2000`, `O.U.G. nr. 195/2002`, a
//      code by name (`Codul fiscal`), or a phrase pointing back at the act just
//      cited (`din legea menționată mai sus`, `actul normativ citat`).
//   4. Republication / amendment notes, which are part of the citation and are
//      taken with it: `, republicată`, `, cu modificările și completările
//      ulterioare`.
//   5. CAEN codes — `cod CAEN 6201`, `clasa CAEN 4711`, `CAEN 6201, 6202`.
//      Not an act, but the same thing to a reader: a pointer into an official
//      nomenclature, and how a company's object of activity is always written.
//      The hit carries `codes` — the numbers on their own.
//
// Pure text in, ranges out — no DOM, no React — so the same detector serves the
// Word preview, an extracted PDF text, or anything added later.

// ── Diacritics ────────────────────────────────────────────────────────────
// Romanian text in the wild carries BOTH the correct comma-below ș/ț and the
// old cedilla ş/ţ (Windows-1250-era documents, and anything typed on a legacy
// layout), so every pattern below is written with the correct letters and
// widened here. Same for â/î, which alternate by spelling reform.
//
// One pass, from a map: chained .replace() calls would rewrite the brackets an
// earlier call had just inserted (â → [âî], then the î inside that → [î[îâ]],
// which is not a regex). A letter written INSIDE a character class is spelled
// with its variants by hand instead — a class can't nest another one.
const DIA_CLASS = {
  ș: '[șş]', Ș: '[ȘŞ]', ț: '[țţ]', Ț: '[ȚŢ]',
  â: '[âî]', Â: '[ÂÎ]', î: '[îâ]', Î: '[ÎÂ]',
};
function dia(src) {
  return src.replace(/[șȘțȚâÂîÎ]/g, (c) => DIA_CLASS[c]);
}

// A word's ending. NOT `\w*`: that is ASCII-only even under the /u flag, so it
// stops dead at the first diacritic — "urgenț|ă", "menționat|ă" — which is
// exactly where a Romanian ending tends to begin.
const TAIL = '\\p{L}*';

// ── The categories of normative act ───────────────────────────────────────
// Written out and abbreviated, both of which the rules allow (the abbreviation
// only after a full first mention, but a detector has no business policing
// that). Declensions are covered by the loose ending — a citation reads "Legea
// nr. …" in the nominative and "Legii nr. …" when governed by another word.
const CATEGORY = dia([
  // Longest first: the alternation is ordered, so "Ordonanța de urgență a
  // Guvernului" must be tried before "Ordonanța" would match its head alone.
  `Ordonanț${TAIL}\\s+de\\s+urgenț${TAIL}(?:\\s+a\\s+Guvernului)?`,
  `Ordonanț${TAIL}(?:\\s+a)?\\s+Guvernului`,
  `Ordonanț${TAIL}`,
  `Hotărâr${TAIL}(?:\\s+a)?\\s+Guvernului`,
  `Hotărâr${TAIL}`,
  'Leg(?:ea|ii|e)',
  'Decret(?:ul|ului)?(?:-lege)?',
  'Ordin(?:ul|ului)?',
  'Deciz(?:ia|iei)',
  'Regulament(?:ul|ului)?',
  'Directiv(?:a|ei)',
  `Instrucțiun${TAIL}`,
  `Norm${TAIL}\\s+metodologic${TAIL}`,
  // Abbreviations, with or without the dots people drop.
  'O\\.?U\\.?G\\.?',
  'O\\.?G\\.?',
  'H\\.?G\\.?',
  'O\\.?M\\.?F\\.?P?\\.?',
].join('|'));

// An EU act carries its issuing body in brackets before the number:
// Regulamentul (UE) 2016/679, Directiva (CE) nr. 95/46.
const EU_TAG = '(?:\\s*\\((?:UE|CE|CEE|EU)\\))?';
// `nr.` is optional — EU numbering omits it, and so do plenty of drafters.
const NUMBER = '(?:nr\\.?\\s*)?';
// Romanian numbering is number/year, EU numbering year/number. Both are two
// groups of digits around a slash, so one shape covers them and the caller
// tells them apart by which side holds the four-digit year.
const NUM_YEAR = '(\\d{1,5})\\s*\\/\\s*(\\d{2,4})';
// The title, on a first mention. It opens at `privind` / `pentru` and runs to
// the end of the clause; punctuation closes it here, and `cutTitle` below ends
// it at the first word that can only start a new clause.
const TITLE_OPEN = dia(`(?:privind|pentru|referitor${TAIL}\\s+la|asupra|cu\\s+privire\\s+la)`);
const TITLE = `(?:\\s+${TITLE_OPEN}\\s+[^.,;:()\\n]{2,200})?`;
// Republication / amendment notes. Part of the citation, so they are taken with
// it: "Legea nr. 227/2015 privind Codul fiscal, cu modificările și completările
// ulterioare."
const NOTES = dia('(?:\\s*,\\s*(?:republicat[ăa]|actualizat[ăa]|cu\\s+modificările(?:\\s+și\\s+completările)?\\s+ulterioare|cu\\s+completările\\s+ulterioare))*');

const ACT_RE = new RegExp(
  `(?:${CATEGORY})${EU_TAG}\\s*${NUMBER}${NUM_YEAR}${TITLE}${NOTES}`,
  'giu',
);

// Where a title stops. It is a noun phrase naming the act; the moment the
// sentence starts saying something ABOUT the act ("… privind Codul civil se
// aplică …") the citation is over. Without this the highlight ran from the
// number to the full stop and took half the sentence with it.
const TITLE_OPEN_RE = new RegExp(`\\s${TITLE_OPEN}\\s`, 'iu');
const TITLE_STOP_RE = new RegExp(dia(
  '\\s(?:se|s-a|s-au|este|sunt|era|erau|va|vor|care|nu|urmează|prevede|prevăd'
  + '|stabilește|stabilesc|dispune|reglementează|rămâne|rămân|devine|devin'
  + '|intră|cuprinde|impune|a\\s+fost|au\\s+fost|în\\s+tot|în\\s+cele)\\s',
), 'iu');

function cutTitle(raw) {
  const open = TITLE_OPEN_RE.exec(raw);
  if (!open) return raw;
  const from = open.index + open[0].length;
  const stop = TITLE_STOP_RE.exec(raw.slice(from));
  return stop ? raw.slice(0, from + stop.index) : raw;
}

// ── Structural elements ───────────────────────────────────────────────────
// art. / alin. / lit. / pct. are the official abbreviations. A run starts at
// any of them (a document mid-argument writes "alin. (2) lit. b)" alone) and
// takes every element that follows, so the whole pointer is ONE reference
// rather than three touching ones. `art. 12^1` is how an article inserted by a
// later amendment is numbered.
// The abbreviations Legea nr. 24/2000 prescribes, and the words they stand for:
// a contract pointing at ITSELF writes them out ("clauzei 4.3", "punctul 6.1"),
// and in whatever declension the sentence needs, so the endings are loose.
const ELEMENT = dia('(?:art\\.|alin\\.|lit\\.|pct\\.|paragr\\.|parag\\.|cap\\.'
  + `|articol${TAIL}|alineat${TAIL}|liter${TAIL}|punct${TAIL}|clauz${TAIL}`
  + `|capitol${TAIL}|anex${TAIL}|secțiun${TAIL})`);
// A bracketed number, a number, or a letter. The number may be DOTTED — "6.1",
// "4.3.2" — which is how a contract numbers its own clauses and what an
// internal cross-reference points at. Its trailing dot is taken WITH it
// ("pct. 6.1. lit. d)"): Romanian numbering closes a clause number with one,
// and leaving it outside split the run in two, so the pointer and the item it
// points at came out as two references. `trimEnd` drops it again where it
// really was a full stop.
// Already a character class, so the letters are written with both diacritic
// spellings by hand rather than run through dia().
const ELEMENT_VALUE = '(?:\\(\\d+\\)|\\d+(?:\\.\\d+)*(?:\\^\\d+)?\\.?|[a-zșşțţăâî]\\))';
const ELEMENT_JOIN = `(?:\\s*(?:,|${dia('și')}|-|–)\\s*|\\s+)`;
const STRUCT_RE = new RegExp(
  `\\b${ELEMENT}\\s*${ELEMENT_VALUE}(?:${ELEMENT_JOIN}(?:${ELEMENT}\\s*)?${ELEMENT_VALUE})*`,
  'giu',
);
// What joins an element to the act it belongs to: "art. 12 … din Legea nr. …".
const FROM_ACT_RE = /^\s*(?:din|ale|al|ai|a)\s+/iu;

// ── Codes and the Constitution ────────────────────────────────────────────
// Cited by name, never by number — "Codul civil", not "Legea nr. 287/2009",
// once the full form has been given.
const CODE_RE = new RegExp(dia(
  '\\bCod(?:ul|ului)?\\s+(?:de\\s+procedură\\s+(?:civilă|penală|fiscală)'
  + '|civil|penal|fiscal|muncii|rutier|vamal|silvic|aerian|comercial)'
  + '|\\bConstituți(?:a|ei)(?:\\s+României)?',
), 'giu');

// ── CAEN codes ────────────────────────────────────────────────────────────
// Not a citation of an act but the same kind of thing to a reader: a pointer
// into an official nomenclature (Clasificarea Activităților din Economia
// Națională), and the way a Romanian company's object of activity is always
// written — in the articles of association, the trade-register extract, the
// contract's recitals. Marked so it is as findable as the laws around it.
//
// The shapes: `CAEN 6201`, `cod CAEN: 6201`, `codul CAEN principal 6920`,
// `clasa CAEN 4711`, `CAEN Rev. 2 – 6201`, and lists (`CAEN 6201, 6202 și
// 6209`). The keyword is REQUIRED — a bare four-digit number in a legal
// document is far more often a year, an article or an amount.
const CAEN_RE = new RegExp(dia(
  '(?:(?:clas[ăa]|grup[ăa]|diviziune[ai]?|secțiune[ai]?)\\s+)?'
  + '(?:cod(?:ul|uri|urile)?\\s+)?'
  + 'C\\.?A\\.?E\\.?N\\.?'
  + '(?:\\s*Rev\\.?\\s*\\d)?'                       // CAEN Rev. 2 / Rev. 3
  + '(?:\\s+(?:principal|secundar)\\w*)?'
  + '(?:\\s*[:\\-–—]\\s*|\\s+)'
  + '\\d{2,4}'                                      // the class / group / division
  + '(?:\\s*(?:,|și|\\/)\\s*\\d{2,4})*',            // …and any others listed with it
), 'giu');   // the whole pattern goes through dia() once — never dia() a part of it too

// ── Pointing back at the act already cited ────────────────────────────────
// The short form the rules allow once the act has been named in full.
const BACKREF_RE = new RegExp(dia(
  `(?:leg(?:ea|ii)|act(?:ul|ului)\\s+normativ|ordonanț${TAIL}|hotărâr${TAIL}`
  + `|deciz${TAIL}|ordin${TAIL}|regulament${TAIL}|directiv${TAIL})`
  + `\\s+(?:sus-)?(?:menționat${TAIL}|citat${TAIL}|indicat${TAIL}|amintit${TAIL}|invocat${TAIL})`
  + '(?:\\s+mai\\s+sus)?',
), 'giu');

// Overlapping ranges are one reference seen twice (a code named inside an act's
// title, an element run already folded into its act). The longer one — and, at
// equal length, the earlier — is the reference; the other is dropped.
function dropOverlaps(hits) {
  const sorted = hits.slice().sort((a, b) => (a.start - b.start) || ((b.end - b.start) - (a.end - a.start)));
  const out = [];
  for (const hit of sorted) {
    const last = out[out.length - 1];
    if (last && hit.start < last.end) {
      if (hit.end > last.end) out[out.length - 1] = hit;
      continue;
    }
    out.push(hit);
  }
  return out;
}

// Trailing space or punctuation a pattern swept up is not part of the
// reference — it would be underlined for nothing.
function trimEnd(hit, text) {
  let end = hit.end;
  while (end > hit.start && /[\s,;:.]/.test(text[end - 1])) end -= 1;
  return { ...hit, end, raw: text.slice(hit.start, end) };
}

/**
 * Every reference to a normative act in `text`.
 *
 * @returns {{ start:number, end:number, raw:string, kind:'act'|'element'|'code'|'back'|'caen',
 *             number?:string, year?:string, codes?:string[], target?:string, letter?:string }[]}
 *          in document order, never overlapping. An `element` with a `target` is
 *          an INTERNAL cross-reference — a clause of this same document.
 */
export function findLawRefs(text) {
  const s = String(text || '');
  if (s.length < 6) return [];
  const hits = [];

  // 1. Acts with a number — the anchor everything else hangs off.
  const acts = [];
  ACT_RE.lastIndex = 0;
  for (let m = ACT_RE.exec(s); m; m = ACT_RE.exec(s)) {
    const raw = cutTitle(m[0]);
    const [a, b] = [m[1], m[2]];
    const year = b && b.length === 4 && Number(b) > 1200 ? b : a;
    const number = year === b ? a : b;
    const hit = { start: m.index, end: m.index + raw.length, raw, kind: 'act', number, year };
    acts.push(hit);
    hits.push(hit);
  }

  // 2. Structural elements. One immediately followed by `din <act>` belongs to
  //    that citation, so the two are marked as ONE reference — "art. 12 alin.
  //    (1) lit. b) din Legea nr. 24/2000" is a single thing a reader looks up.
  STRUCT_RE.lastIndex = 0;
  for (let m = STRUCT_RE.exec(s); m; m = STRUCT_RE.exec(s)) {
    const end = m.index + m[0].length;
    const join = FROM_ACT_RE.exec(s.slice(end, end + 8));
    const act = join ? acts.find((h) => h.start === end + join[0].length) : null;
    if (act) { act.start = m.index; act.raw = s.slice(m.index, act.end); continue; }
    // No act after it: the pointer is INTERNAL — it means a clause of the
    // document being read ("…indicată la pct. 6.1. lit. d)"). `target` is the
    // clause number it points at and `letter` the item within it, which is what
    // lets a reader be taken there.
    const target = (/\d+(?:\.\d+)*/.exec(m[0]) || [''])[0];
    const letter = (/lit\.\s*([a-zșşțţăâî])\)/i.exec(m[0]) || ['', ''])[1];
    hits.push({ start: m.index, end, raw: m[0], kind: 'element', target, letter });
  }

  // 3. Codes / the Constitution, and 4. the short forms pointing back.
  CODE_RE.lastIndex = 0;
  for (let m = CODE_RE.exec(s); m; m = CODE_RE.exec(s)) {
    hits.push({ start: m.index, end: m.index + m[0].length, raw: m[0], kind: 'code' });
  }
  BACKREF_RE.lastIndex = 0;
  for (let m = BACKREF_RE.exec(s); m; m = BACKREF_RE.exec(s)) {
    hits.push({ start: m.index, end: m.index + m[0].length, raw: m[0], kind: 'back' });
  }
  // 5. CAEN codes — the company's object of activity, by nomenclature number.
  CAEN_RE.lastIndex = 0;
  for (let m = CAEN_RE.exec(s); m; m = CAEN_RE.exec(s)) {
    // The revision is dropped before the numbers are read, or "CAEN Rev. 2 –
    // 6201" would report the revision as a code.
    const codes = m[0].replace(/Rev\.?\s*\d+/i, '').match(/\d{2,4}/g) || [];
    hits.push({ start: m.index, end: m.index + m[0].length, raw: m[0], kind: 'caen', codes });
  }

  return dropOverlaps(hits).map((h) => trimEnd(h, s)).filter((h) => h.end > h.start);
}

/** A short label for one reference — what a tooltip or a list calls it. */
// ── Reading a citation back out ─────────────────────────────────────
// The detector's job is to find WHERE a citation is; this takes the text it
// found and says WHAT it is — the pointer into the act, the category, the
// number and year, the title and the republication notes, each on its own, so
// a reader can be shown the parts of a citation rather than the string.
//
// It reads the same `raw` the mark covers, with the same patterns that matched
// it, so the two can never disagree about what a citation contains.
const CAT_HEAD_RE = new RegExp(`^(?:${CATEGORY})`, 'iu');
// The pointer and the act are joined by "din": "art. 12 alin. (1) lit. b) din
// Legea nr. 24/2000". Only when a CATEGORY follows — "din" is an ordinary word
// and a title is full of them.
const JOINED_BY_DIN_RE = /\s+din\s+/iu;
const NOTE_ONE_RE = new RegExp(dia(
  '\\s*,\\s*(republicat[ăa]|actualizat[ăa]'
  + '|cu\\s+modificările(?:\\s+și\\s+completările)?\\s+ulterioare'
  + '|cu\\s+completările\\s+ulterioare)',
), 'giu');
const TITLE_FROM_RE = new RegExp(`\\s${TITLE_OPEN}\\s+([\\s\\S]+)$`, 'iu');

/**
 * The parts of one reference, for showing it to a reader.
 * @param {object} hit one entry from `findLawRefs`
 * @returns {{ kind:string, raw:string, element:string, category:string,
 *             number:string, year:string, title:string, notes:string[],
 *             codes:string[], heading:string }}
 *          `heading` is the shortest thing that names the act ("Legea nr.
 *          24/2000"), for when the citation itself is a paragraph long.
 */
export function lawRefDetails(hit) {
  const out = {
    kind: hit?.kind || '',
    raw: (hit?.raw || '').trim(),
    element: '',
    category: '',
    number: hit?.number || '',
    year: hit?.year || '',
    title: '',
    notes: [],
    codes: hit?.codes || [],
    heading: '',
  };
  let raw = out.raw;
  const din = JOINED_BY_DIN_RE.exec(raw);
  if (din) {
    const after = raw.slice(din.index + din[0].length);
    if (CAT_HEAD_RE.test(after)) {
      out.element = raw.slice(0, din.index).trim();
      raw = after;
    }
  }
  NOTE_ONE_RE.lastIndex = 0;
  raw = raw.replace(NOTE_ONE_RE, (_m, note) => { out.notes.push(note.trim()); return ''; });
  const cat = CAT_HEAD_RE.exec(raw);
  if (cat) out.category = cat[0].trim();
  const title = TITLE_FROM_RE.exec(raw);
  // The opening word belongs to the title as it is read aloud ("privind Codul
  // civil"), so it is kept: without it the line reads as a bare noun phrase
  // hanging off nothing.
  if (title) out.title = raw.slice(title.index).trim().replace(/[.,;:]+$/, '');
  out.heading = out.title ? raw.slice(0, title.index).trim() : raw.trim();
  if (!out.heading) out.heading = out.raw;
  return out;
}

// Where to send a reader who wants the act itself.
//
// The official source is the Ministry of Justice's legislative portal, and it
// has NO addressable page for an act by number and year: a document there is
// reached by an internal id, and its search is a form POST. So this is a
// search of that site rather than a link into it, which is the honest version
// — a made-up /Public/DetaliiDocument/<guess> is a 404 with a straight face.
const LAW_PORTAL = 'legislatie.just.ro';
export function lawRefLookupUrl(hit) {
  if (!hit) return '';
  if (hit.kind === 'caen') {
    const codes = (hit.codes || []).join(' ');
    return `https://www.google.com/search?q=${encodeURIComponent(`cod CAEN ${codes}`.trim())}`;
  }
  const d = lawRefDetails(hit);
  // The heading alone, not the whole citation: a title of two hundred
  // characters is a worse query than "Legea nr. 24/2000", and the number and
  // year are what identify an act.
  const q = d.number && d.year
    ? `${d.category || ''} ${d.number}/${d.year}`.trim()
    : d.heading || hit.raw;
  return `https://www.google.com/search?q=${encodeURIComponent(`${q} site:${LAW_PORTAL}`)}`;
}

export function lawRefLabel(hit) {
  if (!hit) return '';
  if (hit.kind === 'element') return hit.target ? `Go to ${hit.target}` : 'Part of an act';
  if (hit.kind === 'code') return 'Code';
  if (hit.kind === 'back') return 'The act cited above';
  if (hit.kind === 'caen') {
    const codes = hit.codes || [];
    return codes.length > 1 ? `CAEN codes ${codes.join(', ')}` : `CAEN code ${codes[0] || ''}`.trim();
  }
  return hit.number && hit.year ? `Act no. ${hit.number}/${hit.year}` : 'Normative act';
}
