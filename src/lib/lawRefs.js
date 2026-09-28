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
// An older EU act carries its body AFTER the number instead: Directiva
// 2007/43/CE, Regulamentul (CEE) nr. 2913/92, Directiva 96/29/Euratom. Part
// of the number, so part of the reference — without it "Directiva 2007/43"
// was marked and "/CE" left hanging.
// Longest first: the alternation is ordered, and "Euratom" would otherwise
// be cut to "Eu" (the match is case-insensitive).
const EU_SUFFIX = '(?:\\/(?:Euratom|CECO|CEEA|PESC|JAI|CEE|CE|UE|EU))?';
const EU_MARK_RE = /\((?:UE|CE|CEE|EU)\)|\/(?:Euratom|CECO|CEEA|PESC|JAI|CEE|CE|UE|EU)\b/iu;
const YEAR_NOW = new Date().getFullYear();
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
  `(?:${CATEGORY})${EU_TAG}\\s*${NUMBER}${NUM_YEAR}${EU_SUFFIX}${TITLE}${NOTES}`,
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

// Which side of the slash is the year. A four-digit year is its own
// evidence; a two-digit one ("Legea nr. 31/90", "Directiva 96/29/CE") is
// the side with two digits; with both sides two digits an EU act reads
// year/number and a Romanian one number/year. A two-digit year is given its
// century, since it is what the Legislation tab searches by.
const plausibleYear = (x) => x.length === 4 && Number(x) >= 1800 && Number(x) <= YEAR_NOW + 1;
function readNumberYear(a, b, raw) {
  const eu = EU_MARK_RE.test(raw);
  let year; let number;
  if (plausibleYear(b) && !plausibleYear(a)) { year = b; number = a; }
  else if (plausibleYear(a) && !plausibleYear(b)) { year = a; number = b; }
  else if (b.length === 2 && a.length !== 2) { year = b; number = a; }
  else if (a.length === 2 && b.length !== 2) { year = a; number = b; }
  else if (eu) { year = a; number = b; }
  else { year = b; number = a; }
  if (year.length === 2) year = `${Number(year) > YEAR_NOW % 100 ? '19' : '20'}${year}`;
  return { number, year };
}

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
  + `|capitol${TAIL}|anex${TAIL}|secțiun${TAIL}|tez${TAIL})`);
// A bracketed number, a number, or a letter. The number may be DOTTED — "6.1",
// "4.3.2" — which is how a contract numbers its own clauses and what an
// internal cross-reference points at. Its trailing dot is taken WITH it
// ("pct. 6.1. lit. d)"): Romanian numbering closes a clause number with one,
// and leaving it outside split the run in two, so the pointer and the item it
// points at came out as two references. `trimEnd` drops it again where it
// really was a full stop.
// Already a character class, so the letters are written with both diacritic
// spellings by hand rather than run through dia().
// A number may carry the Latin insertion words an older amendment used
// ("art. 4 bis"), and a value may be a ROMAN numeral — "Cap. III", "teza I",
// "teza a II-a" (the agreed article and the "-a" belong to it). The letter-
// paren alternative stays AHEAD of the roman one: "lit. i)" is the letter i
// with its paren, and the roman branch would take the bare "i" and leave the
// paren hanging. `(?!\p{L})` closes the roman so "teza in..." never reads
// "in" as a numeral.
const ELEMENT_VALUE = '(?:\\(\\d+\\)|\\d+(?:\\.\\d+)*(?:\\^\\d+)?(?:\\s+(?:bis|ter|quater))?\\.?'
  + '|[a-zșşțţăâî]\\)|(?:a\\s+)?[IVX]{1,5}(?:-a)?(?!\\p{L}))';
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
// The dotted abbreviations are how a pleading cites a code mid-sentence —
// "art. 1349 C.civ.", "art. 453 C.proc.pen." — with or without the inner
// spaces ("C. pr. civ."). The procedure forms come first in the alternation:
// both start with "C." and the plain form would cut "C.proc.civ." at "C.".
const CODE_RE = new RegExp(dia(
  '\\bCod(?:ul|ului)?\\s+(?:de\\s+procedură\\s+(?:civilă|penală|fiscală)'
  + '|civil|penal|fiscal|muncii|rutier|vamal|silvic|aerian|comercial|administrativ)'
  + '|\\bC\\.\\s?(?:proc\\.|pr\\.)\\s?(?:civ|pen|fisc)\\.?'
  + '|\\bC\\.\\s?(?:civ|pen|fisc)\\.?'
  + '|\\bConstituți(?:a|ei)(?:\\s+României)?',
), 'giu');
// The bare siglas — CPC, CPP, and the "noul …" forms from the 2011–2014
// transition. CASE-SENSITIVE on purpose: under /i they would match ordinary
// syllables, and nobody writes a code's sigla in lowercase.
const CODE_SIGLA_RE = /\b(?:NCPC|NCPP|CPC|CPP)\b/gu;

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

// ── CAEN codes as a LIST, one per line ───────────────────────────────────
// A trade-register extract (ONRC's "Certificat constatator", the "Obiecte de
// activitate" of a registration) names the nomenclature ONCE — "…conform
// codificării (Ordin 377/2024) Rev. Caen (3)" — and then lists the classes one
// per line as `6210 - Activități de realizare a soft-ului …`. No keyword stands
// beside each code, so CAEN_RE cannot see them. They are recognised by their
// SHAPE — a line that is a four-digit number, a dash, and a capitalised name —
// and only in a text that mentions CAEN at all (`caenContext`), since a bare
// "2024 - Anul …" elsewhere is no activity.
const CAEN_LINE_RE = /(^|\n)([ \t]*)(\d{4})([ \t]*[-–—][ \t]+)(?=\p{Lu})/gu;
const CAEN_WORD_RE = /\bC\.?A\.?E\.?N\b/i;
// The revision the document names: "CAEN Rev. 2", "Rev. Caen (3)", "Rev.3".
const CAEN_REV_RE = /(?:C\.?A\.?E\.?N\.?\s*Rev\.?\s*\(?\s*(\d)|Rev\.?\s*C\.?A\.?E\.?N\.?\s*\(?\s*(\d))/i;
/** Does a text speak of CAEN, and in which revision? → { on, rev } */
export function caenContextOf(text) {
  const s = String(text || '');
  const m = CAEN_REV_RE.exec(s);
  return { on: CAEN_WORD_RE.test(s), rev: m ? Number(m[1] || m[2]) || 0 : 0 };
}

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
export function dropOverlaps(hits) {
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
 *             number?:string, year?:string, codes?:string[], rev?:number, target?:string, letter?:string }[]}
 *          in document order, never overlapping. An `element` with a `target` is
 *          an INTERNAL cross-reference — a clause of this same document.
 */
export function findLawRefs(text, { caenContext = null } = {}) {
  const s = String(text || '');
  if (s.length < 6) return [];
  const hits = [];
  // Whether this text is in a CAEN setting — handed in by a caller that scans
  // a document a paragraph at a time (the Word preview), else read here.
  const caen = caenContext || caenContextOf(s);

  // 1. Acts with a number — the anchor everything else hangs off.
  const acts = [];
  ACT_RE.lastIndex = 0;
  for (let m = ACT_RE.exec(s); m; m = ACT_RE.exec(s)) {
    const raw = cutTitle(m[0]);
    const { number, year } = readNumberYear(m[1], m[2], raw);
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
  CODE_SIGLA_RE.lastIndex = 0;
  for (let m = CODE_SIGLA_RE.exec(s); m; m = CODE_SIGLA_RE.exec(s)) {
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
    // …and kept on its own: "6201" means one thing in Rev. 2 and another in
    // Rev. 3, so the revision a citation names decides how it is read (lib/caen).
    const rev = Number((/Rev\.?\s*(\d)/i.exec(m[0]) || [])[1]) || 0;
    hits.push({ start: m.index, end: m.index + m[0].length, raw: m[0], kind: 'caen', codes, rev });
  }
  // 5b. …and the one-per-line list of an extract ("6210 - Activități de …").
  if (caen.on) {
    CAEN_LINE_RE.lastIndex = 0;
    for (let m = CAEN_LINE_RE.exec(s); m; m = CAEN_LINE_RE.exec(s)) {
      const start = m.index + m[1].length + m[2].length;
      hits.push({ start, end: start + 4, raw: m[3], kind: 'caen', codes: [m[3]], rev: caen.rev || 0 });
    }
  }

  return dropOverlaps(hits).map((h) => trimEnd(h, s)).filter((h) => h.end > h.start);
}

// ── Court file numbers ────────────────────────────────────────────────────
// "Dosarul nr. 1.234/1/2023" — a file at a court, by the number the courts'
// portal knows it by (number / court code / year), which is how a published
// decision names the case it was given in. The word is REQUIRED: three
// numbers with slashes between them are otherwise a date. Thousands dots are
// dropped from the number ("1.234" → "1234"), which is how the portal wants it.
const CASE_RE = new RegExp(dia(
  '\\bdosar(?:ul|ului|e|ele|elor)?\\s+(?:nr\\.?\\s*|num[ăa]r(?:ul)?\\s+)?'
  + '(\\d{1,3}(?:\\.\\d{3})+|\\d{1,7})\\s*\\/\\s*(\\d{1,4}(?:\\.\\d{3})?)\\s*\\/\\s*(\\d{4})',
), 'giu');

/**
 * Every court file number in `text` — `{ start, end, raw, kind: 'case', number }`,
 * `number` as the courts' portal takes it ("1234/1/2023").
 */
export function findCaseRefs(text) {
  const s = String(text || '');
  if (s.length < 10) return [];
  const hits = [];
  CASE_RE.lastIndex = 0;
  for (let m = CASE_RE.exec(s); m; m = CASE_RE.exec(s)) {
    const number = `${m[1].replace(/\./g, '')}/${m[2].replace(/\./g, '')}/${m[3]}`;
    hits.push({ start: m.index, end: m.index + m[0].length, raw: m[0], kind: 'case', number });
  }
  return hits;
}

/**
 * The references a READER can follow out of a passage, for a page that turns
 * them into controls: acts and codes (→ the Legislation tab), CAEN codes (→ the
 * CAEN nomenclature), court file numbers (→ Court files). Internal
 * cross-references and short back-references are left out — they point at the
 * document itself. In document order, never overlapping.
 */
export function findFollowableRefs(text) {
  const law = findLawRefs(text).filter((h) => h.kind === 'act' || h.kind === 'code' || h.kind === 'caen');
  const extra = [...findCaseRefs(text), ...findCuiRefs(text)];
  if (!extra.length) return law;
  return dropOverlaps([...law, ...extra]);
}

// ── A company's fiscal code (CUI / CIF) ──────────────────────────────
// "Cod unic de înregistrare : 54912561", "CUI RO 14399840", "C.I.F. 4204020",
// "cod fiscal RO54912561", "Codul de identificare fiscală: …" — the KEYWORD is
// required (bare digits are anything: a sum, a phone number, a file number),
// the acronyms are matched in capitals ("cui" is a Romanian word), and the
// number must pass the CUI check digit, which is what keeps a registration
// number or an amount that happens to follow the word out. A hit carries
// `cui` (digits only) — ANAF answers it (the ANAF tab, `/anaf?cui=`).
const CUI_KEYWORD = String.raw`(?:C\.?\s?U\.?\s?I\.?|C\.?\s?I\.?\s?F\.?|[Cc]od(?:ul)?\s+[Uu]nic\s+de\s+[ÎîÂâIi]nregistrare(?:\s+[Ff]iscal[ăa])?|[Cc]od(?:ul)?\s+de\s+[ÎîIi]nregistrare\s+[Ff]iscal[ăa]|[Cc]od(?:ul)?\s+de\s+[Ii]dentificare\s+[Ff]iscal[ăa]|[Cc]od(?:ul)?\s+[Ff]iscal)`;
const CUI_RE = new RegExp(`${CUI_KEYWORD}\\s*(?:nr\\.?\\s*)?[:\\-–]?\\s*((?:RO\\s?)?(\\d{2,10}))(?!\\d)`, 'gu');
const CUI_KEY = [7, 5, 3, 2, 1, 7, 5, 3, 2];
export function cuiValid(digits) {
  const s = String(digits || '');
  if (!/^\d{2,10}$/.test(s)) return false;
  const body = s.slice(0, -1).padStart(9, '0').split('').map(Number);
  const c = (body.reduce((n, d, i) => n + d * CUI_KEY[i], 0) * 10) % 11;
  return (c === 10 ? 0 : c) === Number(s.slice(-1));
}
export function findCuiRefs(text) {
  const out = [];
  const s = String(text || '');
  CUI_RE.lastIndex = 0;
  for (let m = CUI_RE.exec(s); m; m = CUI_RE.exec(s)) {
    if (!cuiValid(m[2])) continue;
    // A letter glued before the keyword ("ACUI…") is not the keyword.
    if (m.index > 0 && /\p{L}/u.test(s[m.index - 1])) continue;
    out.push({ kind: 'cui', start: m.index, end: m.index + m[0].length, raw: m[0], cui: m[2] });
  }
  return out;
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

// ═══ The wider catalogue — every legal identifier the app recognises ═══════
//
// A Romanian legal document is full of identifiers that are not citations of
// acts but are the same kind of thing to a reader: registry numbers, fiscal
// codes, court files, land-registry entries, the phrases that announce a legal
// basis. This catalogue is the ONE list of them — what each is, the regex that
// finds it, the phrases it rides on, and what the AI side does with it — and
// it is what the Debug tab's "Legal references" section renders, so every way
// the app recognises these can be READ in one place.
//
// Each entry: `id` (the hit's `kind`), `group` (REF_GROUPS), `name`, `what`
// (one line, for a reader), `via` — 'shape' (the pattern alone is evidence
// enough), 'keyword' (the digits mean nothing without their keyword) or
// 'context' (not an identifier but a cue that one follows — what the AI is
// steered by) — `res` (the regexes, in the order they are tried), `phrases`
// (the wording it answers to), `examples` (real-shaped text the Debug tab runs
// the entry's own regexes over), `ai` (what the AI layer does with it, when it
// does anything), and `live: true` on the kinds `findLawRefs` / `findCaseRefs`
// already find — those are NOT run again by `findEntityRefs`.
//
// Boundary note: JS `\b` is ASCII-only, so it is useless next to a diacritic
// (`\bîn` never matches — space→î is no boundary to \b). Patterns here lean on
// `scanRefPatterns`' own letter-boundary check instead, and only use `\b`
// against ASCII letters and digits.

export const REF_GROUPS = [
  { id: 'I', name: 'Economic and fiscal identifiers' },
  { id: 'II', name: 'Legal forms of organisation' },
  { id: 'III', name: 'Classifications and nomenclatures' },
  { id: 'IV', name: 'Normative acts (Legea nr. 24/2000)' },
  { id: 'V', name: 'Case law, courts and files' },
  { id: 'VI', name: 'Land registry and property' },
  { id: 'VII', name: 'Natural persons' },
  { id: 'VIII', name: 'Enforcement and notarial acts' },
  { id: 'IX', name: 'EU and international law' },
  { id: 'X', name: 'Legal connectors (context cues)' },
  { id: 'XI', name: 'Fiscal bodies (ANAF)' },
];

const IDENTITY_AI = 'The identity reader (Fill from documents / Create identity) asks the model for this and writes it into the record.';

export const REF_CATALOGUE = [
  // ── I. Economic and fiscal identifiers ────────────────────────────────
  {
    id: 'euid',
    group: 'I',
    name: 'EUID — European unique identifier',
    what: 'The European form of the trade-register number: ROONRC. + the ONRC number. Tried before ONRC — it contains one.',
    via: 'shape',
    res: [new RegExp('ROONRC\\.?\\s?[JFC]\\d{1,2}\\s*\\/\\s*\\d{1,7}\\s*\\/\\s*(?:19|20)\\d{2}', 'gu')],
    phrases: ['ROONRC.J40/123/2026'],
    examples: ['identificată prin EUID ROONRC.J40/123/2026'],
    ai: '',
  },
  {
    id: 'onrc',
    group: 'I',
    name: 'ONRC — trade-register number',
    what: 'J/F/C + county code + entry + year — J companies, F sole traders (PFA/II/IF), C cooperatives. The shape alone is distinctive.',
    via: 'shape',
    res: [
      new RegExp('\\b[JFC]\\s?\\d{1,2}\\s*\\/\\s*\\d{1,7}\\s*\\/\\s*(?:19|20)\\d{2}\\b', 'gu'),
      new RegExp('(?:nr\\.?|num[ăa]r(?:ul)?)\\s+de\\s+ordine\\s+(?:[îâ]n|la)\\s+registrul\\s+comer[țţ]ului', 'giu'),
    ],
    phrases: ['J40/123/2026', 'F12/456/2024', 'C23/789/2025', 'nr. de ordine în Registrul Comerțului'],
    examples: ['înmatriculată la ORC sub nr. J40/123/2026', 'numărul de ordine în registrul comerțului F12/456/2024'],
    ai: IDENTITY_AI + ' Record key: regNo.',
  },
  {
    id: 'cui',
    group: 'I',
    name: 'CUI / CIF — fiscal code',
    what: '2–10 digits, optionally RO-prefixed. The keyword is REQUIRED — bare digits are anything — and the acronyms are matched case-sensitively (“cui” is a Romanian word).',
    via: 'keyword',
    res: [new RegExp(
      '(?:C\\.?U\\.?I\\.?|C\\.?I\\.?F\\.?|[Cc]od(?:ul)?\\s+[Uu]nic\\s+de\\s+[ÎîÂâ]nregistrare(?:\\s+[Ff]iscal[ăa])?|[Cc]od(?:ul)?\\s+de\\s+[ÎîIi]nregistrare\\s+[Ff]iscal[ăa]|[Cc]od(?:ul)?\\s+de\\s+[Ii]dentificare\\s+[Ff]iscal[ăa]|[Cc]od(?:ul)?\\s+[Ff]iscal)\\s*(?:nr\\.?\\s*)?[:\\-–]?\\s*(?:RO\\s?)?\\d{2,10}\\b',
      'gu',
    )],
    phrases: ['CUI', 'C.U.I.', 'CIF', 'C.I.F.', 'Cod Unic de Înregistrare', 'Cod de Identificare Fiscală'],
    examples: ['CUI RO12345678', 'cod unic de înregistrare 987654', 'C.I.F. RO 4204020'],
    ai: IDENTITY_AI + ' Record key: taxId.',
  },
  {
    id: 'ong',
    group: 'I',
    name: 'NGO registry — Registrul Asociațiilor și Fundațiilor',
    what: 'nr/A/year (associations), nr/B/year (federations), nr/PJ/year — the register kept at each court’s clerk’s office. The /A/ / /B/ / /PJ/ middle is what makes the bare shape safe.',
    via: 'shape',
    res: [
      new RegExp('\\b\\d{1,5}\\s*\\/\\s*(?:A|B|PJ)\\s*\\/\\s*(?:19|20)\\d{2}\\b', 'gu'),
      new RegExp('registrul\\s+(?:special\\s+al\\s+)?asocia[țţ]iilor\\s+[șş]i\\s+funda[țţ]iilor', 'giu'),
    ],
    phrases: ['înscrisă în Registrul Asociațiilor și Fundațiilor sub nr.', 'aflat la grefa Judecătoriei'],
    examples: ['înscrisă în Registrul Asociațiilor și Fundațiilor sub nr. 12/A/2020'],
    ai: '',
  },
  {
    id: 'iban',
    group: 'I',
    name: 'IBAN — Romanian bank account',
    what: 'RO + 2 check digits + 4-letter bank code + 16 alphanumerics = 24 characters, written solid or in groups of four.',
    via: 'shape',
    res: [new RegExp('\\bRO\\d{2}(?:\\s?[A-Z0-9]{4}){5}\\b', 'gu')],
    phrases: ['contul IBAN', 'cont curent'],
    examples: ['în contul IBAN RO49AAAA1B31007593840000', 'cont RO49 AAAA 1B31 0075 9384 0000'],
    ai: IDENTITY_AI + ' Record keys: iban, bank.',
  },
  {
    id: 'fiscal-doc',
    group: 'I',
    name: 'Fiscal documents — e-Factura, invoices, receipts',
    what: 'An invoice or receipt by its series and number, a payment order, and the e-Factura system’s own ids (id descărcare, index încărcare).',
    via: 'keyword',
    res: [new RegExp(
      'factur\\p{L}*(?:\\s+fiscal\\p{L}*)?\\s+(?:seria\\s+[A-Z0-9-]{1,8}\\s*,?\\s*)?nr\\.?\\s*[0-9][0-9A-Za-z.\\/-]*'
      + '|chitan[țţ]\\p{L}*\\s+(?:seria\\s+[A-Z0-9-]{1,8}\\s*,?\\s*)?nr\\.?\\s*\\d+'
      + '|ordin(?:ul|e|ele)?\\s+de\\s+plat[ăa]\\s+nr\\.?\\s*\\d+|\\bOP\\s+nr\\.?\\s*\\d+'
      + '|id(?:-ul)?\\s+(?:de\\s+)?desc[ăa]rcare(?:\\s+e-?factura)?\\s*:?\\s*\\d+'
      + '|index(?:ul)?\\s+(?:de\\s+)?[îâ]nc[ăa]rcare\\s*:?\\s*\\d+',
      'giu',
    )],
    phrases: ['Factura seria X nr. Y', 'Chitanța nr.', 'Ordin de plată / OP nr.', 'id descărcare e-Factura', 'index încărcare'],
    examples: ['Factura seria ABC nr. 1042 din 03.02.2026', 'achitat cu OP nr. 55', 'index încărcare: 5312024'],
    ai: '',
  },
  {
    id: 'eori',
    group: 'I',
    name: 'EORI — customs operator number',
    what: 'RO followed directly by the CUI. Indistinguishable from a plain RO-prefixed CUI, so the EORI keyword is required.',
    via: 'keyword',
    res: [new RegExp('\\bEORI\\b(?:\\s*(?:nr\\.?|:)?\\s*RO\\s?\\d{2,10})?', 'gu')],
    phrases: ['numărul EORI', 'cod EORI'],
    examples: ['operator cu numărul EORI RO12345678'],
    ai: '',
  },
  {
    id: 'lei-code',
    group: 'I',
    name: 'LEI — legal entity identifier',
    what: '20 alphanumerics. Matched only against the LEI keyword and only in capitals — otherwise every amount “în lei” would light up.',
    via: 'keyword',
    res: [new RegExp('(?:[Cc]od(?:ul)?\\s+)?LEI\\s*:?\\s*[A-Z0-9]{20}\\b', 'gu')],
    phrases: ['cod LEI'],
    examples: ['cod LEI 549300GFX6WN7JDUSN34'],
    ai: '',
  },

  // ── II. Legal forms ───────────────────────────────────────────────────
  {
    id: 'legalform',
    group: 'II',
    name: 'Legal form — SRL, SA, PFA, BNP, BEJ…',
    what: 'The form a firm or a regulated practice trades under. Case-sensitive; the bare undotted SA, II, IF and CA are left out — in capitals they are also “să”, initials and Curtea de Apel — and C.A. (Cabinet de Avocat) is skipped for the same collision.',
    via: 'shape',
    res: [new RegExp(
      '(?<![\\p{L}.])(?:S\\.C\\.P\\.E\\.J\\.?|SCPEJ|S\\.P\\.R\\.L\\.?|SPRL|S\\.R\\.L\\.?|SRL|S\\.N\\.C\\.?|SNC'
      + '|S\\.C\\.A\\.?|P\\.F\\.A\\.?|PFA|B\\.N\\.P\\.?|BNP|S\\.P\\.N\\.?|B\\.I\\.N\\.?|B\\.E\\.J\\.?|BEJ'
      + '|C\\.M\\.I\\.?|B\\.I\\.A\\.?|S\\.A\\.?|Î\\.I\\.?|I\\.I\\.?|Î\\.F\\.?|I\\.F\\.?)(?!\\p{L})',
      'gu',
    )],
    phrases: ['S.R.L. / SRL', 'S.A.', 'P.F.A. / PFA', 'I.I. / Î.I.', 'I.F.', 'S.N.C.', 'S.C.A.', 'S.P.R.L.', 'B.N.P.', 'S.P.N.', 'B.I.N.', 'B.E.J. / BEJ', 'S.C.P.E.J.', 'C.M.I.', 'B.I.A.'],
    examples: ['EXEMPLU CONS S.R.L.', 'B.E.J. Ionescu Radu', 'PFA Popescu Ana', 'BANCA EXEMPLU S.A.'],
    ai: IDENTITY_AI + ' Record key: legalForm.',
  },

  // ── III. Classifications ──────────────────────────────────────────────
  {
    id: 'caen',
    group: 'III',
    name: 'CAEN — economic activities',
    what: 'The nomenclature a company’s object of activity is written in. Keyword required — a bare four-digit number is a year or an amount. Live: marked amber in the Word preview, opens the CAEN tab / modal.',
    via: 'keyword',
    live: true,
    res: [CAEN_RE],
    phrases: ['cod CAEN', 'clasa CAEN', 'CAEN Rev. 2 –', 'obiect de activitate conform CAEN'],
    examples: ['cod CAEN 6201', 'clasa CAEN 4711', 'CAEN 6201, 6202 și 6209'],
    ai: 'The Doc Viewer’s paragraph dock lists each code with its official name (ParaCaenCodes); the advisor sees them in context.',
  },
  {
    id: 'cor',
    group: 'III',
    name: 'COR — occupations',
    what: 'Six digits after the COR keyword (capitals only).',
    via: 'keyword',
    res: [new RegExp('(?:[Cc]od(?:ul|uri|urile)?\\s+)?COR\\s*:?[\\s-]*\\d{6}(?!\\d)', 'gu')],
    phrases: ['cod COR', 'funcția ocupată conform COR'],
    examples: ['funcția de consilier juridic, cod COR 261103'],
    ai: '',
  },
  {
    id: 'cpv',
    group: 'III',
    name: 'CPV — public procurement vocabulary',
    what: '8 digits, a dash and a check digit — distinctive enough on its own; the keyword form is tried first.',
    via: 'shape',
    res: [
      new RegExp('(?:[Cc]od(?:ul|uri|urile)?\\s+)?CPV\\s*:?\\s*\\d{8}\\s*-\\s*\\d\\b', 'gu'),
      new RegExp('\\b\\d{8}-\\d\\b(?!-)', 'gu'),
    ],
    phrases: ['cod CPV', 'achiziție publică având codul CPV'],
    examples: ['cod CPV 79110000-8', 'servicii juridice 79100000-5'],
    ai: '',
  },
  {
    id: 'nc',
    group: 'III',
    name: 'NC — combined (customs) nomenclature',
    what: 'Eight digits, often spaced 4-2-2. Keyword required — eight bare digits are a phone number or an amount.',
    via: 'keyword',
    res: [new RegExp('(?:cod(?:ul)?\\s+(?:vamal|NC)|pozi[țţ]i\\p{L}*\\s+tarifar[ăa](?:\\s+NC)?)\\s*:?\\s*\\d{4}(?:[ .]?\\d{2}){0,2}', 'giu')],
    phrases: ['cod vamal', 'poziția tarifară NC'],
    examples: ['încadrate la poziția tarifară NC 8471 30 00'],
    ai: '',
  },
  {
    id: 'siruta',
    group: 'III',
    name: 'SIRUTA — administrative units',
    what: '5–6 digits after the SIRUTA keyword.',
    via: 'keyword',
    res: [new RegExp('(?:cod(?:ul)?\\s+)?SIRUTA\\s*:?\\s*\\d{4,6}\\b', 'giu')],
    phrases: ['cod SIRUTA', 'localitatea X (SIRUTA: …)'],
    examples: ['localitatea Voluntari (cod SIRUTA 179587)'],
    ai: '',
  },

  // ── IV. Normative acts ────────────────────────────────────────────────
  {
    id: 'act',
    group: 'IV',
    name: 'Normative act — Legea / O.U.G. / H.G. / Ordinul / EU acts',
    what: 'Category + nr. + number/year (+ title on first mention, + republicată / cu modificările… notes, which are part of the citation). EU acts carry their body in brackets or after the number. Live: the AI-gradient mark in the Word preview; “Read here” opens it in the Legislation tab.',
    via: 'shape',
    live: true,
    res: [ACT_RE],
    phrases: ['Legea nr. 287/2009 privind Codul civil', 'O.U.G. nr. 195/2002', 'H.G. 1/2016', 'Regulamentul (UE) 2016/679', 'Directiva 96/29/Euratom', ', republicată', ', cu modificările și completările ulterioare'],
    examples: ['Legea nr. 24/2000 privind normele de tehnică legislativă, republicată', 'Ordonanța de urgență a Guvernului nr. 195/2002'],
    ai: 'lawRefDetails reads the citation apart (category, number, year, title, notes); the Legislation tab’s words search asks the AI what an act is called when the form is empty.',
  },
  {
    id: 'element',
    group: 'IV',
    name: 'Structural element / internal cross-reference',
    what: 'art. / alin. / lit. / pct. / teza / cap. / anexa runs — with ^-indices (art. 155^1), bis/ter/quater, and roman values (teza a II-a, Cap. III). Followed by “din <act>” it folds into that citation; alone it is an INTERNAL pointer and (with a dotted target) becomes a go-to control. Live in the Word preview.',
    via: 'shape',
    live: true,
    res: [STRUCT_RE],
    phrases: ['art. 12 alin. (1) lit. b)', 'articolul', 'alineatul', 'litera', 'punctul', 'teza I / teza a II-a', 'art. 155^1', 'art. 4 bis'],
    examples: ['potrivit art. 12 alin. (1) lit. b) din Legea nr. 24/2000', 'sancțiunea prevăzută la pct. 6.1. lit. d)', 'art. 6 teza a II-a'],
    ai: 'The AI is told a picked paragraph’s references; internal pointers are resolved to the clause they name, no AI involved.',
  },
  {
    id: 'code',
    group: 'IV',
    name: 'National code, by name or sigla',
    what: 'Codul civil / penal / fiscal / muncii / administrativ…, the Constitution, the dotted abbreviations (C.civ., C.proc.pen., C. pr. civ.) and — case-sensitively — the bare siglas CPC / CPP / NCPC / NCPP. Live in the Word preview.',
    via: 'shape',
    live: true,
    res: [CODE_RE, CODE_SIGLA_RE],
    phrases: ['Codul civil / C.civ.', 'Codul de procedură civilă / C.proc.civ. / C. pr. civ. / CPC', 'Codul penal / C.pen.', 'Codul de procedură penală / CPP', 'Codul muncii', 'Codul fiscal', 'Codul administrativ', 'Codul silvic', 'Constituția României'],
    examples: ['art. 1349 C.civ.', 'în condițiile Codului administrativ', 'art. 453 CPC'],
    ai: '',
  },
  {
    id: 'back',
    group: 'IV',
    name: 'Back-reference to the act just cited',
    what: '“legea menționată mai sus”, “actul normativ citat” — the short form the drafting rules allow once the act has been named in full. Live in the Word preview.',
    via: 'shape',
    live: true,
    res: [BACKREF_RE],
    phrases: ['legea menționată mai sus', 'actul normativ citat', 'ordonanța sus-menționată'],
    examples: ['în sensul legii menționate mai sus'],
    ai: 'Only the AI can say WHICH act it points back to — the regex only marks that it points.',
  },

  // ── V. Case law, courts and files ─────────────────────────────────────
  {
    id: 'case',
    group: 'V',
    name: 'Court file (ECRIS)',
    what: 'number / court code / year, the word “dosar” required — three slashed numbers are otherwise a date. Thousands dots dropped. Live: opens the Court files tab.',
    via: 'keyword',
    live: true,
    res: [CASE_RE],
    phrases: ['dosar nr.', 'dosarul penal nr.', 'dosar asociat nr.'],
    examples: ['în dosarul nr. 1.234/3/2023 al Tribunalului București'],
    ai: '',
  },
  {
    id: 'pcase',
    group: 'V',
    name: 'Prosecution file (parchet)',
    what: 'number /P/ year — the /P/ middle marks the criminal-investigation phase and makes the bare shape safe; “dosar penal nr.” is taken with it.',
    via: 'shape',
    res: [new RegExp('(?:[Dd]osar(?:ul|ului)?\\s+(?:penal\\s+)?(?:nr\\.?\\s*|num[ăa]r(?:ul)?\\s+)?)?\\b\\d{1,6}\\s*\\/\\s*P\\s*\\/\\s*(?:19|20)\\d{2}\\b', 'gu')],
    phrases: ['dosar nr. X/P/An al Parchetului de pe lângă…'],
    examples: ['dosarul penal nr. 123/P/2024 al Parchetului de pe lângă Judecătoria Sectorului 1'],
    ai: '',
  },
  {
    id: 'pv',
    group: 'V',
    name: 'Proces-verbal (contravention report)',
    what: 'The report by its series and number — “proces-verbal … seria X nr. Y”, or the bare “seria XX nr. NNN” pair.',
    via: 'keyword',
    res: [new RegExp(
      'proces(?:ul|ului)?[-\\s]verbal(?:\\s+de\\s+constatare[^,;.\\n]{0,60}?|\\s+de\\s+contraven[țţ]ie)?\\s*,?\\s*(?:seria\\s+[A-Z0-9]{1,5}\\s*,?\\s*)?nr\\.?\\s*\\d+'
      + '|\\bseria\\s+[A-Z]{2,4}\\s*,?\\s*nr\\.?\\s*\\d{3,}\\b',
      'giu',
    )],
    phrases: ['Proces-verbal de constatare și sancționare a contravenției seria X nr. Y'],
    examples: ['procesul-verbal de constatare a contravenției seria PCA nr. 1234567'],
    ai: '',
  },
  {
    id: 'decision',
    group: 'V',
    name: 'Court decision — sentință, decizie, încheiere',
    what: 'Sentința / Încheierea / Ordonanța președințială nr. …, and Decizia only with its civilă / penală qualifier — plain “Decizia nr. X/Y” already reads as a normative act.',
    via: 'shape',
    res: [new RegExp(
      '(?:sentin[țţ](?:a|ei)|[îâ]ncheier(?:ea|ii|e)(?:\\s+de\\s+[șş]edin[țţ][ăa])?|ordonan[țţ](?:a|ei)\\s+pre[șş]edin[țţ]ial[ăa])'
      + '(?:\\s+(?:civil[ăae]|penal[ăae]|comercial[ăae]))?\\s+nr\\.?\\s*\\d+(?:\\s*\\/\\s*\\d{2,4}|\\s+din\\s+\\d{1,2}[./]\\d{1,2}[./]\\d{4}|\\s+din\\s+\\d{1,2}\\s+\\p{L}+\\s+\\d{4})?'
      + '|decizi(?:a|ei)\\s+(?:civil[ăae]|penal[ăae]|comercial[ăae])\\s+nr\\.?\\s*\\d+(?:\\s*\\/\\s*\\d{2,4}|\\s+din\\s+[^,;.\\n]{4,30})?',
      'giu',
    )],
    phrases: ['Sentința civilă nr.', 'Decizia penală nr.', 'Încheierea de ședință', 'Ordonanța președințială nr.'],
    examples: ['prin Sentința civilă nr. 4521/2023', 'Decizia civilă nr. 100 din 12.03.2024'],
    ai: '',
  },
  {
    id: 'court',
    group: 'V',
    name: 'Court name',
    what: 'Judecătoria / Tribunalul / Curtea de Apel + a capitalised name, and ÎCCJ in full or as sigla. A bare “Curtea de Apel” with no name is left alone.',
    via: 'shape',
    res: [new RegExp(
      '(?:Judec[ăa]tori(?:a|ei)|Tribunalul(?:ui)?(?:\\s+(?:Specializat|Militar|pentru\\s+[Mm]inori\\s+[șş]i\\s+[Ff]amilie))?|Cur(?:tea|[țţ]ii)\\s+(?:Militar[ăa]\\s+|Militare\\s+)?de\\s+Apel)'
      + '\\s+(?:[A-ZĂÂÎȘŞȚŢ][\\p{L}-]*|\\d+)(?:[\\s-]+(?:[A-ZĂÂÎȘŞȚŢ][\\p{L}-]*|\\d+)){0,3}'
      + '|[ÎI]nalt(?:a|ei)\\s+Cur(?:te|[țţ]i)\\s+de\\s+Casa[țţ]ie\\s+[șş]i\\s+Justi[țţ]ie'
      + '|[ÎI]\\.?C\\.?C\\.?J\\.?(?!\\p{L})',
      'gu',
    )],
    phrases: ['Judecătoria Sectorului 4', 'Tribunalul București', 'Curtea de Apel Cluj', 'Înalta Curte de Casație și Justiție / ÎCCJ'],
    examples: ['pe rolul Judecătoriei Sectorului 4 București', 'Tribunalul pentru Minori și Familie Brașov', 'decizia ÎCCJ'],
    ai: 'The Court files tab’s own list (lib/courts.json) is the closed nomenclature; this regex only marks the words.',
  },
  {
    id: 'ccr',
    group: 'V',
    name: 'Constitutional Court decision',
    what: 'Decizia Curții Constituționale / CCR nr. X/an or “din <date>”.',
    via: 'shape',
    res: [new RegExp('decizi(?:a|ei)\\s+(?:cur[țţ]ii\\s+constitu[țţ]ionale(?:\\s+a\\s+rom[âî]niei)?|C\\.?C\\.?R\\.?)\\s*,?\\s*nr\\.?\\s*\\d+(?:\\s*\\/\\s*\\d{4}|\\s+din\\s+[^,;.\\n]{4,40})?', 'giu')],
    phrases: ['Decizia Curții Constituționale nr. X din …', 'Decizia CCR nr. X/An'],
    examples: ['Decizia CCR nr. 458/2020', 'Decizia Curții Constituționale nr. 405 din 15 iunie 2016'],
    ai: '',
  },
  {
    id: 'ril',
    group: 'V',
    name: 'RIL — appeal in the interest of the law',
    what: 'Decizia RIL nr. X/an, or Decizia nr. X/an + the “pronunțată în recursul în interesul legii” phrase — without either it is a plain act citation.',
    via: 'keyword',
    res: [new RegExp('decizi(?:a|ei)\\s+(?:RIL\\s+nr\\.?\\s*\\d+\\s*\\/\\s*\\d{4}|nr\\.?\\s*\\d+\\s*\\/\\s*\\d{4}\\s*,?\\s*pronun[țţ]at[ăa]\\s+[îâ]n\\s+recurs(?:ul)?\\s+[îâ]n\\s+interesul\\s+legii)', 'giu')],
    phrases: ['Decizia RIL nr. X/An', 'Decizia nr. X/An pronunțată în recursul în interesul legii'],
    examples: ['Decizia RIL nr. 19/2019', 'Decizia nr. 3/2020 pronunțată în recursul în interesul legii'],
    ai: '',
  },
  {
    id: 'hp',
    group: 'V',
    name: 'HP — preliminary ruling on questions of law',
    what: 'Decizia HP nr. X/an, or Decizia nr. X/an + “pentru dezlegarea unor chestiuni de drept”.',
    via: 'keyword',
    res: [new RegExp('decizi(?:a|ei)\\s+(?:HP\\s+nr\\.?\\s*\\d+\\s*\\/\\s*\\d{4}|nr\\.?\\s*\\d+\\s*\\/\\s*\\d{4}\\s*,?\\s*(?:pentru|privind)\\s+dezlegarea\\s+unor\\s+chestiuni\\s+de\\s+drept)', 'giu')],
    phrases: ['Decizia HP nr. X/An', 'Decizia nr. X/An pentru dezlegarea unor chestiuni de drept'],
    examples: ['Decizia HP nr. 52/2018', 'Decizia nr. 9/2016 pentru dezlegarea unor chestiuni de drept'],
    ai: '',
  },

  // ── VI. Land registry ─────────────────────────────────────────────────
  {
    id: 'cf',
    group: 'VI',
    name: 'Carte Funciară — land book',
    what: 'The land-book number, written out or as CF / C.F. The sigla is capitals-only: lowercase “cf.” is “confer”.',
    via: 'keyword',
    res: [new RegExp('(?:[Cc]arte(?:a|ii)?\\s+[Ff]unciar[ăa]|C\\.?\\s?F\\.?)\\s+(?:nr\\.?\\s*)?\\d+', 'gu')],
    phrases: ['Carte Funciară nr.', 'CF nr.', 'C.F. nr.'],
    examples: ['imobil înscris în Cartea Funciară nr. 54321 Cluj-Napoca', 'CF nr. 12345'],
    ai: '',
  },
  {
    id: 'cadastral',
    group: 'VI',
    name: 'Cadastral number',
    what: '“nr. cadastral X” / “nr. cad. X”.',
    via: 'keyword',
    res: [new RegExp('(?:nr|num[ăa]r(?:ul)?)\\.?\\s*(?:cadastral|cad\\.?)\\s*:?\\s*\\d+', 'giu')],
    phrases: ['nr. cadastral', 'nr. cad.'],
    examples: ['identificat cu nr. cadastral 123', 'nr. cad. 4567'],
    ai: '',
  },
  {
    id: 'topo',
    group: 'VI',
    name: 'Topographic number',
    what: '“nr. topografic X” / “nr. top. X” — the older Transylvanian land-book numbering.',
    via: 'keyword',
    res: [new RegExp('(?:nr|num[ăa]r(?:ul)?)\\.?\\s*top(?:ografic)?\\.?\\s*:?\\s*\\d+', 'giu')],
    phrases: ['nr. topografic', 'nr. top.'],
    examples: ['nr. top. 1024/2'],
    ai: '',
  },
  {
    id: 'tarla',
    group: 'VI',
    name: 'Tarla / parcelă',
    what: '“Tarlaua X, Parcela Y” written out, or the bare “T X, P Y” pair — the pair, because a bare T or P is a letter.',
    via: 'shape',
    res: [new RegExp('Tarla(?:ua)?\\s+[0-9A-Z\\/]+(?:\\s*,?\\s*[Pp]arcel(?:a|ele)?\\s+[0-9A-Z\\/]+)?|\\bT\\s?\\d+\\s*,?\\s*P\\s?\\d+(?!\\d)', 'gu')],
    phrases: ['Tarla X', 'Parcela Y', 'T X, P Y'],
    examples: ['teren situat în Tarlaua 24, Parcela 102/3', 'amplasat în T 24, P 102'],
    ai: '',
  },

  // ── VII. Natural persons ──────────────────────────────────────────────
  {
    id: 'cnp',
    group: 'VII',
    name: 'CNP — personal numeric code',
    what: '13 digits: sex/century digit 1–8, then a REAL date (month 01–12, day 01–31) — the date check is what keeps random 13-digit numbers out.',
    via: 'shape',
    res: [new RegExp('(?:C\\.?N\\.?P\\.?\\s*:?\\s*)?\\b[1-8]\\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\\d|3[01])\\d{6}\\b', 'gu')],
    phrases: ['CNP'],
    examples: ['CNP 1850101123456', 'domiciliat în …, 2921231123456'],
    ai: IDENTITY_AI + ' Record key: nationalId.',
  },
  {
    id: 'idcard',
    group: 'VII',
    name: 'Identity documents — C.I. / B.I. / passport',
    what: 'C.I. seria XX nr. NNNNNN (series 1–2 letters, number 6 digits), the old B.I., and “Pașaport nr.”.',
    via: 'keyword',
    res: [new RegExp(
      '(?:C\\.?I\\.?|B\\.?I\\.?|[Cc]arte(?:a)?\\s+de\\s+identitate|[Bb]uletin(?:ul)?(?:\\s+de\\s+identitate)?)\\s+seri[ae]\\s+[A-Z]{1,2}\\s*,?\\s*nr\\.?\\s*\\d{6}\\b'
      + '|[Pp]a[șş]aport(?:ul)?\\s+nr\\.?\\s*\\d{6,9}\\b',
      'gu',
    )],
    phrases: ['C.I. seria XX nr. NNNNNN', 'B.I. seria', 'Pașaport nr.'],
    examples: ['identificat cu C.I. seria RX nr. 456789', 'pașaport nr. 05512345'],
    ai: IDENTITY_AI + ' Record keys: idType, idSeries, idNumber.',
  },

  // ── VIII. Enforcement and notarial acts ───────────────────────────────
  {
    id: 'exec',
    group: 'VIII',
    name: 'Enforcement file',
    what: '“Dosar de executare (silită) nr. X/an”, with the executing BEJ taken when named.',
    via: 'keyword',
    res: [new RegExp('dosar(?:ul|ului)?\\s+(?:de\\s+)?executare(?:\\s+silit[ăa])?\\s+nr\\.?\\s*\\d+(?:\\s*\\/\\s*(?:19|20)?\\d{2,4})?(?:\\s+al\\s+(?:B\\.?E\\.?J\\.?|S\\.?C\\.?P\\.?E\\.?J\\.?)[^,;.\\n]{0,40})?', 'giu')],
    phrases: ['Dosar de executare silită nr. X/An'],
    examples: ['în dosarul de executare silită nr. 210/2024 al B.E.J. Ionescu'],
    ai: '',
  },
  {
    id: 'notarial',
    group: 'VIII',
    name: 'Notarial acts',
    what: '“Încheiere de autentificare nr.” and “Certificat de moștenitor nr.”.',
    via: 'keyword',
    res: [new RegExp(
      '[îâ]ncheier(?:ea|ii|e)\\s+de\\s+autentificare\\s+nr\\.?\\s*\\d+(?:\\s*\\/\\s*[\\d.]+)?(?:\\s+din\\s+[^,;.\\n]{4,30})?'
      + '|certificat(?:ul)?\\s+de\\s+mo[șş]tenitor\\s+nr\\.?\\s*\\d+(?:\\s*\\/\\s*\\d{4}|\\s+din\\s+[^,;.\\n]{4,30})?',
      'giu',
    )],
    phrases: ['Încheiere de autentificare nr.', 'Certificat de moștenitor nr.'],
    examples: ['autentificat prin Încheierea de autentificare nr. 1502 din 12 mai 2025', 'certificat de moștenitor nr. 44/2023'],
    ai: '',
  },

  // ── IX. EU and international ──────────────────────────────────────────
  {
    id: 'cjue',
    group: 'IX',
    name: 'CJEU case',
    what: '“Cauza C-131/12”, optionally with the party name; “Hotărârea CJUE în cauza …”. (EU regulations and directives are already acts.)',
    via: 'shape',
    res: [new RegExp('[Cc]auz(?:a|ei)\\s+C[-‑–]\\s?\\d+\\/\\d{2}(?:\\s+[A-Z][\\p{L}-]+)?|Hot[ăa]r[âî]r(?:ea|ii)\\s+CJUE(?:\\s+[îâ]n\\s+cauza\\s+[^,;.\\n]{3,60})?', 'gu')],
    phrases: ['Cauza C-131/12', 'Hotărârea CJUE în cauza'],
    examples: ['principiul stabilit în Cauza C-131/12 Google Spain'],
    ai: '',
  },
  {
    id: 'gdpr',
    group: 'IX',
    name: 'GDPR',
    what: 'The sigla, or the regulation by its Romanian description. The numbered form — Regulamentul (UE) 2016/679 — is already an act.',
    via: 'shape',
    res: [new RegExp('\\bGDPR\\b|[Rr]egulamentul\\s+general\\s+privind\\s+protec[țţ]ia\\s+datelor', 'gu')],
    phrases: ['GDPR', 'Regulamentul general privind protecția datelor'],
    examples: ['cu respectarea GDPR'],
    ai: '',
  },
  {
    id: 'cedo',
    group: 'IX',
    name: 'ECHR case law',
    what: '“Hotărârea CEDO în cauza …”, the “X contra României” case-name shape, and “art. N din Convenție”.',
    via: 'shape',
    res: [new RegExp(
      'Hot[ăa]r[âî]r(?:ea|ii)\\s+(?:CEDO|Cur[țţ]ii\\s+Europene\\s+a\\s+Drepturilor\\s+Omului)(?:\\s+[îâ]n\\s+cauza\\s+[^,;.\\n]{3,60})?'
      + '|[A-Z][\\p{L}-]+(?:\\s+[șş]i\\s+al[țţ]ii)?\\s+(?:contra|[îâ]mpotriva|c\\.)\\s+Rom[âî]niei\\b'
      + '|art\\.?\\s*\\d+\\s+din\\s+Conven[țţ]i(?:e|a)(?!\\p{L})',
      'gu',
    )],
    phrases: ['Hotărârea CEDO în cauza X contra României', 'art. 6 din Convenție'],
    examples: ['Hotărârea CEDO în cauza Popescu contra României', 'garanțiile art. 6 din Convenție'],
    ai: '',
  },

  // ── X. Connectors ─────────────────────────────────────────────────────
  {
    id: 'connector',
    group: 'X',
    name: 'Legal connectors',
    what: 'Not identifiers — the phrases that announce one: a legal basis (“în temeiul”, “potrivit dispozițiilor”), a correlation (“coroborat cu”), an interpretive stance (“per a contrario”). Found by regex here, but their JOB is context: they tell the AI a citation follows.',
    via: 'context',
    res: [new RegExp(
      '(?:[îâ]n\\s+temeiul|[îâ]n\\s+drept\\b|potrivit\\s+dispozi[țţ]iilor|prin\\s+raportare\\s+la'
      + '|av[âî]nd\\s+[îâ]n\\s+vedere\\s+(?:prevederile|dispozi[țţ]iile)|coroborat\\p{L}*\\s+cu|prin\\s+coroborare\\s+cu'
      + '|[îâ]n\\s+conexiune\\s+cu|[îâ]n\\s+subsidiar|[îâ]n\\s+principal\\b|per\\s+a\\s+contrario|ad\\s+litteram)',
      'giu',
    )],
    phrases: ['în temeiul', 'în drept', 'potrivit dispozițiilor', 'prin raportare la', 'având în vedere prevederile', 'coroborat cu', 'în subsidiar', 'per a contrario', 'ad litteram'],
    examples: ['În temeiul art. 194 CPC, coroborat cu art. 148…', 'în subsidiar, per a contrario'],
    ai: 'These are the cues the AI reads a legal argument by — where one appears, an entity from this catalogue is imminent.',
  },

  // ── XI. Fiscal bodies ─────────────────────────────────────────────────
  {
    id: 'fiscal-body',
    group: 'XI',
    name: 'Fiscal bodies — ANAF and its directorates',
    what: 'The issuers in the letterhead of a contested administrative act: ANAF, D.G.R.F.P., A.J.F.P., D.G.A.M.C., D.G.A.F. — siglas in capitals, names written out.',
    via: 'shape',
    res: [new RegExp(
      '\\bANAF\\b|Agen[țţ]i(?:a|ei)\\s+Na[țţ]ional[ăae]\\s+de\\s+Administrare\\s+Fiscal[ăa]'
      + '|D\\.?G\\.?R\\.?F\\.?P\\.?(?!\\p{L})|Direc[țţ]i(?:a|ei)\\s+Generale?\\s+Regional[ăae]\\s+a\\s+Finan[țţ]elor\\s+Publice'
      + '|A\\.?J\\.?F\\.?P\\.?(?!\\p{L})|Administra[țţ]i(?:a|ei)\\s+Jude[țţ]en[ăae]\\s+a\\s+Finan[țţ]elor\\s+Publice'
      + '|D\\.?G\\.?A\\.?M\\.?C\\.?(?!\\p{L})|Direc[țţ]i(?:a|ei)\\s+Generale?\\s+de\\s+Administrare\\s+a\\s+Marilor\\s+Contribuabili'
      + '|D\\.?G\\.?A\\.?F\\.?(?!\\p{L})|Direc[țţ]i(?:a|ei)\\s+Generale?\\s+Antifraud[ăa]\\s+Fiscal[ăa]',
      'gu',
    )],
    phrases: ['ANAF', 'D.G.R.F.P.', 'A.J.F.P.', 'D.G.A.M.C.', 'D.G.A.F.'],
    examples: ['decizia de impunere emisă de A.J.F.P. Cluj', 'inspecția fiscală ANAF — D.G.A.F.'],
    ai: '',
  },
];

/** The display name of a hit's kind, from the catalogue. */
const KIND_NAME = new Map(REF_CATALOGUE.map((e) => [e.id, e.name]));
export const refKindName = (kind) => KIND_NAME.get(kind) || kind || '';

/**
 * Run a set of the catalogue's patterns over `text` — the shared scan the
 * Debug tab's per-entry previews use too. Enforces the letter boundary JS's
 * ASCII-only `\b` cannot (a match may not start or end mid-word), trims
 * trailing space/commas but KEEPS a trailing dot (it belongs to "S.R.L.").
 */
export function scanRefPatterns(text, res, kind = '') {
  const s = String(text || '');
  if (!s) return [];
  const letter = (c) => !!c && /\p{L}/u.test(c);
  const hits = [];
  for (const re of res || []) {
    re.lastIndex = 0;
    for (let m = re.exec(s); m; m = re.exec(s)) {
      if (!m[0]) { re.lastIndex += 1; continue; }
      const a = m.index; let b = a + m[0].length;
      if ((a > 0 && letter(s[a - 1]) && letter(s[a]))
        || (b < s.length && letter(s[b]) && letter(s[b - 1]))) continue;
      while (b > a && /[\s,;:]/.test(s[b - 1])) b -= 1;
      if (b > a) hits.push({ start: a, end: b, raw: s.slice(a, b), kind });
    }
  }
  return dropOverlaps(hits);
}

/**
 * Every identifier from the wider catalogue — everything `findLawRefs` /
 * `findCaseRefs` do NOT already find. `{ start, end, raw, kind }`, the kind
 * being the catalogue entry's id; in document order, never overlapping.
 */
export function findEntityRefs(text) {
  const s = String(text || '');
  if (s.length < 3) return [];
  const hits = [];
  for (const e of REF_CATALOGUE) {
    if (e.live) continue;
    hits.push(...scanRefPatterns(s, e.res, e.id));
  }
  return dropOverlaps(hits);
}

/**
 * The whole picture in one pass: acts, elements, codes, CAEN, court files AND
 * the wider catalogue, overlaps resolved (the law detectors win at equal
 * length — they are pushed first). What the Debug tab's tester runs.
 */
export function findAllLegalRefs(text) {
  return dropOverlaps([...findLawRefs(text), ...findCaseRefs(text), ...findEntityRefs(text)]);
}

/**
 * The CORE detectors' patterns, named — what `findLawRefs` / `findCaseRefs` /
 * `findCuiRefs` / the CAEN readers run. Read by the Debug tab's legislation
 * archive (pages/Debug `LegalDetectionArchive`), which shows them live beside
 * the frozen copy kept in lib/legalDetectionArchive. The wider catalogue's
 * own patterns are on each `REF_CATALOGUE` entry (`res`).
 */
export const LAW_REF_REGEXES = [
  { name: 'ACT_RE', what: 'A normative act: category, number/year (either order, EU suffix), title from "privind…", republication / amendment notes.', re: ACT_RE },
  { name: 'STRUCT_RE', what: 'A structural pointer: art. / alin. / lit. / pct. / teza with values, joined runs, bis/ter/quater, ^indices, roman numerals.', re: STRUCT_RE },
  { name: 'FROM_ACT_RE', what: 'What joins a pointer to its act ("din", "al", "ale"…).', re: FROM_ACT_RE },
  { name: 'CODE_RE', what: 'A code by name (Codul civil, de procedură…), the dotted abbreviations (C.civ., C.proc.pen.), the Constitution.', re: CODE_RE },
  { name: 'CODE_SIGLA_RE', what: 'Code siglas CPC / CPP / NCPC / NCPP — case-sensitive on purpose.', re: CODE_SIGLA_RE },
  { name: 'CAEN_RE', what: 'CAEN codes with the keyword required: cod CAEN 6201, clasa CAEN, CAEN Rev. 2 – 6201, lists.', re: CAEN_RE },
  { name: 'CAEN_LINE_RE', what: 'A trade-register extract’s one-per-line list: "6210 - Activități…" (only in a text that mentions CAEN).', re: CAEN_LINE_RE },
  { name: 'CAEN_WORD_RE', what: 'Does the text mention CAEN at all (the context for CAEN_LINE_RE).', re: CAEN_WORD_RE },
  { name: 'CAEN_REV_RE', what: 'The revision a document names: "CAEN Rev. 2", "Rev. Caen (3)".', re: CAEN_REV_RE },
  { name: 'BACKREF_RE', what: 'Pointing back at an act already cited: "legea menționată mai sus", "actul normativ citat".', re: BACKREF_RE },
  { name: 'CASE_RE', what: 'A court file number with the word required: "Dosarul nr. 1.234/1/2023".', re: CASE_RE },
  { name: 'CUI_RE', what: 'A fiscal code (CUI / CIF) after its keyword; the check digit is verified separately (weights 7 5 3 2 1 7 5 3 2).', re: CUI_RE },
  { name: 'EU_MARK_RE', what: 'An EU act’s body mark: (UE), (CE), /Euratom…', re: EU_MARK_RE },
  { name: 'TITLE_OPEN_RE', what: 'Where a title opens: privind / pentru / referitor la / asupra / cu privire la.', re: TITLE_OPEN_RE },
  { name: 'TITLE_STOP_RE', what: 'Where a title ends: the first word that starts saying something ABOUT the act (se, este, prevede…).', re: TITLE_STOP_RE },
  { name: 'NOTE_ONE_RE', what: 'One republication / amendment note, read back apart.', re: NOTE_ONE_RE },
  { name: 'CAT_HEAD_RE', what: 'A citation that opens with an act category.', re: CAT_HEAD_RE },
];
