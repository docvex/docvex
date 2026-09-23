// Document Constructor — the model behind the Doc Viewer's "Constructor" view.
//
// A generated document is stored as the markdown-ish SOURCE the builder turns
// into a file (see lib/documentGen): one paragraph per line, `#` headings, and
// `[[role.field]]` blanks. That shape is already a list of sections made of
// pieces, so the Constructor doesn't invent a second format — it reads the
// source into sections/pieces, lets each piece be reworded or filled, and
// writes the same source back. Everything here is pure: no React, no IO.
//
// Lines are the unit on purpose. Every line the parser doesn't claim (blank
// lines, rules) is carried through untouched, so a document that goes in and
// comes out unedited is byte-for-byte the same.

import {
  parseFieldToken, identityValueForField, addressIsApartment, addressHasSectors,
  applyGenderToText, applyLocalityToText, APARTMENT_ONLY_FIELDS,
} from './identities';

// ── What a blank looks like ─────────────────────────────────────────────────
// ONE list of shapes, and one judgement about them, for EVERYTHING in the app
// that has to find a gap in a document: this model (which fills blanks in and
// writes them back) and the Word preview's chips (pages/DocViewer). They used
// to keep separate lists and disagreed — the preview drew a chip on
// "[Client name]", "{{x}}" and a dotted rule that the panel could not fill, so
// a blank you could see was not always a blank you could answer.
//
// Single brackets are ambiguous — "[3]" is a footnote, "[sic]" an editorial
// note — so a delimited shape is judged by what is inside it (looksLikeBlank).
// "[[…]]" needs no judgement: nothing else in a legal document is written that
// way, which is why it is what DocVex writes and what the drafter is told to
// use. A rule of underscores or dots is always a blank.
export const BLANK_PATTERNS = [
  /\[\[[^\]\n]{1,120}\]\]/g,              // [[the seller's full name]]
  /\[[^\][\n]{0,80}\]/g,                   // [Client name] — and the bare "[...]" rule
  /\{\{[^{}\n]{1,80}\}\}/g,                // {{client_name}}
  /\{[^{}\n]{1,80}\}/g,                    // {client_name}
  /<[^<>\n]{1,80}>/g,                      // <client name>
  /\u27E8[^\u27E8\u27E9\n]{1,80}\u27E9/g,   // ⟨client name⟩
  /_{3,}/g,                                // ________ (signature / fill-in rule)
  /\.{4,}/g,                               // ......... (dotted rule, NOT an ellipsis)
  /\u2026{2,}/g,                            // …… (repeated ellipsis characters)
];

const OPENERS = /^[[{<\u27E8]+/;
const CLOSERS = /[\]}>\u27E9]+$/;

// A rule (underscores / dots) always counts. A delimited placeholder counts
// only when what is inside it reads like a label — at least one letter, so
// citation and footnote markers such as "[3]" or "[2020]" are left alone.
export function looksLikeBlank(raw) {
  if (/^\[\[[\s\S]*\]\]$/.test(raw)) return true;   // ours by construction
  if (/^[_.\u2026]+$/.test(raw)) return true;
  // A bracketed rule — "[...]", "[…]", "[___]", "[ ]". Romanian formulas write
  // whole identification clauses this way, labelling each gap in the prose
  // BEFORE it ("str. [...], nr. [...]") rather than inside it.
  if (/^[[{<\u27E8][\s._\u2026-]*[\]}>\u27E9]$/.test(raw)) return true;
  const inner = raw.replace(OPENERS, '').replace(CLOSERS, '').trim();
  if (!inner || inner.length > 80) return false;
  // A brace group holding declarations is a CSS rule, not a blank — no
  // placeholder a person writes contains a semicolon or a property colon.
  if (/^[{<\u27E8]/.test(raw) && /[;:]/.test(inner)) return false;
  return /[A-Za-z\u00C0-\u024F]/.test(inner);
}

// Every blank in one string, left to right, without overlaps. The patterns are
// run independently and merged, so the longest match wins where two shapes
// start at the same spot ("{{x}}" beats the inner "{x}").
// Each hit: { start, end, raw, id } — `id` is what the blank is CALLED, which
// is its inner text where it has one and its position where it has not (a rule
// of underscores says nothing about itself).
export function scanBlanks(text) {
  const src = String(text || '');
  const hits = [];
  for (const re of BLANK_PATTERNS) {
    re.lastIndex = 0;
    let m = re.exec(src);
    while (m) {
      if (looksLikeBlank(m[0])) hits.push({ start: m.index, raw: m[0] });
      m = re.exec(src);
    }
  }
  hits.sort((a, b) => a.start - b.start || b.raw.length - a.raw.length);
  const out = [];
  let end = -1;
  for (const h of hits) {
    if (h.start < end) continue;
    const inner = h.raw.replace(OPENERS, '').replace(CLOSERS, '').trim();
    out.push({
      start: h.start,
      end: h.start + h.raw.length,
      raw: h.raw,
      id: /[A-Za-z\u00C0-\u024F]/.test(inner) ? inner : `blank${out.length + 1}`,
    });
    end = h.start + h.raw.length;
  }
  return out;
}

// `fn({ all, id, offset })` per blank; what it returns replaces the blank.
export function replaceFields(text, fn) {
  const src = String(text || '');
  const hits = scanBlanks(src);
  if (!hits.length) return src;
  let out = '';
  let at = 0;
  for (const h of hits) {
    out += src.slice(at, h.start) + fn({ all: h.raw, id: h.id, offset: h.start });
    at = h.end;
  }
  return out + src.slice(at);
}

// The text with its blanks taken out — for reading a piece's words rather than
// its gaps (a label, the likeness test that tracks a paragraph across versions).
export function stripBlanks(text, to = ' ') {
  return replaceFields(text, () => to);
}

// What a canonical field key reads as on a chip or above an input.
const FIELD_LABELS = {
  legalName: 'Name', lastName: 'Last name', firstName: 'First name', aka: 'Also known as', nationalId: 'CNP', dateOfBirth: 'Date of birth',
  placeOfBirth: 'Place of birth', nationality: 'Nationality', idType: 'ID type',
  idDocument: 'ID document', idSeries: 'ID series', idNumber: 'ID number', idIssuer: 'Issued by',
  idIssuedAt: 'Issued on', taxId: 'CUI', regNo: 'Trade Register no.', legalForm: 'Legal form',
  representative: 'Representative', repCapacity: 'Representative’s capacity', iban: 'IBAN', bank: 'Bank',
  address: 'Address', addressStreet: 'Street', addressNumber: 'Number', addressBlock: 'Block',
  addressStair: 'Stair', addressFloor: 'Floor', addressApartment: 'Apartment',
  addressLocality: 'Locality', addressCounty: 'County', addressSector: 'Sector',
  addressCountyOrSector: 'County / sector', addressPostalCode: 'Postal code',
  city: 'City', county: 'County', country: 'Country', email: 'Email', phone: 'Phone',
};

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

// "vanzator" → "Vanzator", "parteaDezvaluitoare" → "Partea dezvaluitoare".
export function roleLabel(role) {
  if (!role) return 'Party';
  return cap(String(role).replace(/[._-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase());
}

// One blank, described: which party it belongs to, which record field answers
// it, and what to call it. A free-text blank ([[prețul convenit în lei]]) has
// no key — its own words are the label.
export function fieldInfo(id) {
  const token = parseFieldToken(id);
  if (token) return { id, role: token.role || '', key: token.key, label: FIELD_LABELS[token.key] || token.key };
  return { id, role: '', key: null, label: cap(String(id).trim()) };
}

// A piece's text as alternating prose and blanks.
export function parseSegs(text) {
  const out = [];
  let last = 0;
  const src = String(text || '');
  for (const h of scanBlanks(src)) {
    if (h.start > last) out.push({ text: src.slice(last, h.start) });
    out.push({ field: h.id });
    last = h.end;
  }
  if (last < src.length) out.push({ text: src.slice(last) });
  return out;
}

export function fieldsOf(text) {
  const seen = new Set();
  const out = [];
  for (const seg of parseSegs(text)) {
    if (!seg.field || seen.has(seg.field)) continue;
    seen.add(seg.field);
    out.push(fieldInfo(seg.field));
  }
  return out;
}

// Put values into a text's blanks. A blank with no value keeps its brackets
// (`keep`) or reads as its label in brackets, which is how a plain-text read-out
// shows what is still missing.
export function fillText(text, values, { keep = true } = {}) {
  return replaceFields(text, ({ all, id }) => {
    const v = String(values?.[id] ?? '').trim();
    if (v) return v;
    // `keep` hands back the blank EXACTLY as the document writes it — which is
    // what lets a foreign file still be found by its own text when it is saved.
    return keep ? all : `[${fieldInfo(id).label.toLowerCase()}]`;
  });
}

const stripInline = (s) => String(s || '').replace(/\*\*|__|`/g, '').trim();

// The marker that opens a line — heading hashes, a bullet, and the clause's own
// numbering — is kept apart from the body, so an edited list item stays a list
// item and a reworded clause keeps the number it has in the document.
//
// The numbering is the document's, read as written, never invented here: the
// file prints "1.1.", "(2)" and "a)" as literal text, so those are the only
// numbers that can match what the Word preview shows. Recognised shapes:
//   1.1  1.1.  2.3.4.      dotted clause numbers
//   1.  1)  (1)            a single number — always with its punctuation, so a
//                          sentence that merely opens with a year is left alone
//   a)  a.  (a)            lettered sub-points (lower-case only: "A. Popescu"
//                          is a name, not a list)
//   i)  (ii)  iv)          lower-case roman sub-points
// and any of them wrapped in bold, which is how the drafter often writes them.
// The headings a document gives its sections are markers too — "Art. 1",
// "CAPITOLUL I", "Secțiunea 1", "I." — so that a line keeps its number even
// where headings are NOT being read as headings: a document DocVex did not
// write is parsed flat (every line a piece), and without these its articles
// arrived numberless. Capitalised on purpose: "conform art. 1270 Cod civil" is
// a citation in the middle of a sentence, not a heading.
const HEAD_SRC = '(?:Art(?:icolul|\\.)?\\s*\\d{1,3}|CAP(?:ITOLUL|\\.)?\\s*[IVXLC]{1,5}|Capitolul\\s*[IVXLC]{1,5}|Sec[țt]iunea\\s*\\d{1,3}\\.?|[IVXLC]{1,5}\\.)';
const NUM_SRC = `(?:${HEAD_SRC}|\\d{1,3}(?:\\.\\d{1,3}){1,4}\\.?|\\d{1,3}[.)]|\\(\\d{1,3}\\)|\\([a-z]\\)|[a-z][.)]|\\((?:[ivx]{1,5})\\)|(?:[ivx]{1,5})\\))`;
const MARKER_RE = new RegExp(
  `^(\\s*(?:#{1,6}\\s+|[-*•]\\s+)?(?:(?:\\*\\*|__)${NUM_SRC}(?:\\*\\*|__)\\s+|${NUM_SRC}\\s+)?)([\\s\\S]*)$`,
);

// What a marker reads as beside the piece, and how deep it sits. Depth is only
// for indenting the Constructor's rows — "1.1.1" under "1.1", "a)" under the
// clause it belongs to — and changes nothing in the document.
function numberingOf(marker, prevDepth) {
  const raw = String(marker || '').replace(/^\s*#{1,6}\s+/, '').replace(/\*\*|__/g, '').trim();
  if (!raw) return { num: '', depth: 0, numeric: false };
  // A section heading sits at the top and reads as its own number.
  const head = /^(?:art(?:icolul|\.)?\s*(\d{1,3})|cap(?:itolul|\.)?\s*([IVXLC]{1,5})|sec[țt]iunea\s*(\d{1,3}))\.?$/i.exec(raw);
  if (head) return { num: head[1] || head[2] || head[3], depth: 0, numeric: true };
  if (/^[IVXLC]{1,5}\.$/.test(raw)) return { num: raw.replace(/\.$/, ''), depth: 0, numeric: true };
  if (/^[-*•]$/.test(raw)) return { num: '•', depth: prevDepth + 1, numeric: false };
  const bullet = /^[-*•]\s+(.*)$/.exec(raw);
  const num = bullet ? bullet[1] : raw;
  const dotted = /^\d+(?:\.\d+)+\.?$/.test(num);
  if (dotted) return { num, depth: Math.max(0, num.replace(/\.$/, '').split('.').length - 2), numeric: true };
  if (/^\(?\d+[.)]?\)?$/.test(num)) return { num, depth: 0, numeric: true };
  // A letter or a roman numeral: one step under whatever numbered clause came
  // before it.
  return { num, depth: prevDepth + 1, numeric: false };
}

// Is this line a section heading? Markdown headings always; otherwise a short,
// unpunctuated numbered or "Art." line — the way a contract titles its articles
// when the model didn't use `##`.
function headingOf(line) {
  const h = /^(#{1,6})\s+(.*)$/.exec(line);
  if (h) return { level: h[1].length, title: stripInline(h[2]) };
  const bare = stripInline(line);
  if (bare.length > 90 || /[.;:,]$/.test(bare) || /\[\[/.test(bare)) return null;
  if (/^(?:art(?:icolul|\.)?|cap(?:itolul|\.)?|secțiunea|sectiunea)\s*[\divxlc]+\b/i.test(bare)) return { level: 2, title: bare };
  // "1. PĂRȚILE CONTRACTANTE" / "III. Obiectul contractului" — but not "1.1. …",
  // which is a numbered clause, i.e. a piece.
  if (/^(?:\d{1,2}|[IVXLC]{1,5})[.)]\s+\S/.test(bare) && !/^\d+\.\d/.test(bare)) {
    const words = bare.split(/\s+/).length;
    const shouty = bare === bare.toUpperCase();
    if (words <= 10 && (shouty || /^\*\*.*\*\*$/.test(line.trim()))) return { level: 2, title: bare };
  }
  // A section named but NOT numbered — "OBIECTUL CONTRACTULUI" standing alone.
  // Documents written that way (the Playbook's "No number" rule) had no
  // sections at all before this: every heading fell in with the prose under it.
  // Short, shouty, unpunctuated and carrying a letter is the whole test — the
  // FIRST such line is still the document's title, which is settled by the
  // caller, not here.
  if (bare.length <= 60 && /\p{Lu}/u.test(bare) && bare === bare.toUpperCase()
    && bare.split(/\s+/).length <= 6 && !/\d/.test(bare)) {
    // `bare`: the caller needs to tell this from a numbered heading, because
    // the FIRST such line in a document is its title, not its first section.
    return { level: 2, title: bare, bare: true };
  }
  return null;
}

// A heading's own number — "1", "IV", the 3 of "Art. 3" — which is what the
// document prints, and so what the section's badge shows.
const headingNumber = (t) => {
  const m = /^(?:art(?:icolul|\.)?\s*|cap(?:itolul|\.)?\s*|sec[țt]iunea\s*)?(\d{1,2}|[IVXLC]{1,5})(?=[.):\-–\s])/i.exec(String(t || '').trim());
  return m ? m[1].toUpperCase() : '';
};

// Strip a heading's own numbering from its title — the badge carries it.
const unNumber = (t) => String(t || '')
  .replace(/^(?:art(?:icolul|\.)?\s*|cap(?:itolul|\.)?\s*|sec[țt]iunea\s*)?(?:\d{1,2}|[IVXLC]{1,5})(?=[\s.):\-–])[\s.):\-–]*/i, '')
  // …including the dash a heading puts between its number and its name.
  .replace(/^[—–-]\s*/, '')
  .trim() || String(t || '').trim();

// A short name for a piece, from whatever it has: the party it identifies, or
// its opening words.
// Returns `{ label, whole }`. `whole` is true when the label is the clause
// itself rather than a name for it (a party's role, the words before the first
// blank) — the Constructor then prints the live clause in full, values and all,
// and this static copy is only its fallback.
function pieceLabel(body, fields) {
  const roles = [...new Set(fields.filter((f) => f.role).map((f) => f.role))];
  const identityFields = fields.filter((f) => f.key);
  if (roles.length === 1 && identityFields.length >= 3) return { label: roleLabel(roles[0]), whole: false };
  // Blanks say nothing in a name. When the sentence opens with a couple of real
  // words, stop at its first blank ("Încheiat astăzi"); otherwise read around
  // them.
  const bare = stripInline(body);
  const lead = bare.split('[[')[0].replace(/[\s,;:.(]+$/, '');
  const useLead = bare.includes('[[') && lead.split(/\s+/).filter(Boolean).length >= 2;
  const plain = (useLead ? lead : stripBlanks(bare))
    .replace(/\s+([,;:.])/g, '$1')
    .replace(/([,;:.])(?:\s*[,;:.])+/g, '$1');
  const words = plain.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
  // The whole sentence, never cut: the row grows downwards to fit it.
  return { label: cap(words.join(' ').replace(/[,;:.]+$/, '')) || 'Paragraph', whole: !useLead };
}

// Which party a piece identifies, if it is an identification clause: most of
// its record-backed blanks belong to one role (or to none, for a document with
// a single party).
function partyOf(fields) {
  const idf = fields.filter((f) => f.key);
  if (idf.length < 3) return null;
  const counts = new Map();
  for (const f of idf) counts.set(f.role, (counts.get(f.role) || 0) + 1);
  let best = null;
  for (const [role, n] of counts) if (!best || n > best.n) best = { role, n };
  return best && best.n >= Math.max(3, Math.ceil(idf.length * 0.6)) ? best.role : null;
}

// Read a document source into { title, sections, lines }.
// `flat`: every non-blank line is a piece — no line is read as a heading or as
// the document's title. That is how a file DocVex did NOT write is parsed: its
// source is its own paragraphs, read out of the .docx, and the structure lives
// in Word's styles, not in the text. Reading "Art. 1 Obiectul contractului" as
// a section heading there would leave that paragraph belonging to no piece, so
// clicking it would open nothing — and every paragraph has to be pickable.
export function parseSource(source, { flat = false } = {}) {
  const lines = String(source || '').replace(/\r\n?/g, '\n').split('\n');
  let title = '';
  const sections = [];
  let current = null;
  let seenContent = false;

  const open = (heading, lineIndex) => {
    current = {
      id: `s${sections.length}`,
      title: heading ? unNumber(heading.title) : 'Preamble',
      num: heading ? headingNumber(heading.title) : '',
      preamble: !heading,
      lineIndex,
      pieces: [],
    };
    sections.push(current);
  };

  lines.forEach((raw, i) => {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim() || /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) return;
    const h = flat ? null : headingOf(line);
    // The first `#` line is the document's title, not a section.
    if (h && h.level === 1 && !title && !sections.length) { title = h.title; seenContent = true; return; }
    // …and so is a bare name standing at the very top, which is what a document
    // whose sections are unnumbered opens with.
    if (h?.bare && !seenContent && !title && !sections.length) { title = h.title; seenContent = true; return; }
    if (!flat && !seenContent && !h && !title && stripInline(line).length <= 90 && !/\[\[/.test(line)
      && stripInline(line) === stripInline(line).toUpperCase() && /\p{L}/u.test(line)) {
      title = stripInline(line); seenContent = true; return;
    }
    seenContent = true;
    if (h) { open(h, i); return; }
    if (!current) open(null, -1);
    const m = MARKER_RE.exec(line);
    const marker = m ? m[1] : '';
    const body = m ? m[2] : line;
    const fields = fieldsOf(body);
    // Depth is relative to the last NUMBERED clause in this section, so a run
    // of a) b) c) all sit at the same level under it.
    const named = pieceLabel(body, fields);
    const numbering = numberingOf(marker, current.numDepth ?? (current.pieces.length ? 0 : -1));
    if (numbering.numeric) current.numDepth = numbering.depth;
    current.pieces.push({
      id: `p${i}`,
      lineIndex: i,
      marker,
      num: numbering.num,
      depth: Math.max(0, numbering.depth),
      text: body,
      fields,
      party: partyOf(fields),
      label: named.label,
      wholeLabel: named.whole,
    });
  });

  // Number the real sections 1…n; a preamble carries no number.
  let n = 0;
  for (const sec of sections) sec.n = sec.preamble ? 0 : ++n;
  return { title, sections: sections.filter((s) => s.pieces.length || !s.preamble), lines };
}

// Write the Constructor's state back to a source. `edits` is pieceId → text.
// Returns the TEMPLATE (blanks kept, so the Constructor can reopen it with its
// chips intact) and the TEXT (values in place — what becomes the file).
export function composeSource(model, edits, values) {
  const lines = model.lines.slice();
  for (const sec of model.sections) {
    for (const pc of sec.pieces) {
      const edited = edits?.[pc.id];
      if (edited === undefined) continue;
      // A piece edited into several paragraphs becomes several lines; only the
      // first keeps the marker.
      const parts = String(edited).split('\n').map((s) => s.trim()).filter(Boolean);
      lines[pc.lineIndex] = parts.length
        ? parts.map((p, k) => (k === 0 ? `${pc.marker}${p}` : p)).join('\n\n')
        : '';
    }
  }
  const template = lines.join('\n');
  return { template, text: fillText(template, values) };
}

// ── From a rendered paragraph back to its piece ─────────────────────────
// The Word preview shows the FILE; the Constructor works on the SOURCE. A
// picked paragraph is tied to its piece by what it says: the piece's text with
// the saved values in its blanks is what the builder wrote into the file, give
// or take the decoration — heading hashes and bullets become Word formatting,
// `**` becomes bold, and the clause's own number may or may not be in the run.
const LEAD_RE = new RegExp(`^\\s*(?:#{1,6}\\s+|[-*•]\\s+)?(?:${NUM_SRC}\\s+)?`);
const matchNorm = (t) => String(t || '')
  .replace(/[*_`~]/g, '')
  .replace(LEAD_RE, '')
  .replace(/\s+/g, ' ')
  .trim()
  .toLowerCase();

// What a piece reads as in the document: its number (as the document prints
// it), then its text. Heading hashes and bullets are formatting, not text.
export function pieceDisplayText(piece, text) {
  const lead = String(piece?.marker || '').replace(/^\s*(?:#{1,6}\s+|[-*•]\s+)?/, '');
  return `${lead}${text ?? piece?.text ?? ''}`;
}

// The piece a rendered paragraph came from — `{ section, piece }` or null.
// Exact text first; failing that, containment either way (a paragraph the
// renderer split, or one that carries a little extra), but only for text long
// enough that a partial match can't land on the wrong clause.
// How alike a paragraph and a piece must be to match on containment alone.
const LOOSE_MATCH_MIN = 0.6;

export function findPieceForText(model, values, paraText) {
  const target = matchNorm(paraText);
  if (!target) return null;
  let loose = null;
  for (const section of model?.sections || []) {
    for (const piece of section.pieces) {
      const cand = matchNorm(fillText(piece.text, values));
      if (!cand) continue;
      if (cand === target) return { section, piece };
      if (target.length > 24 && cand.length > 24 && (cand.includes(target) || target.includes(cand))) {
        // One containing the other is not enough on its own: a piece far longer
        // than the paragraph contains it the way a chapter contains a sentence,
        // and answering with that piece opens the whole of it. A loose match is
        // for the small differences between what the file says and what the
        // page shows — a list number the renderer adds, a trailing space — so
        // the two have to be nearly the same length to count.
        const score = Math.min(cand.length, target.length) / Math.max(cand.length, target.length);
        if (score >= LOOSE_MATCH_MIN && (!loose || score > loose.score)) loose = { section, piece, score };
      }
    }
  }
  return loose ? { section: loose.section, piece: loose.piece } : null;
}

// ── A paragraph's own history ───────────────────────────────────────────
// Versions are saved per DOCUMENT, but what a person wants back is usually one
// paragraph as it was. This reads a paragraph's history out of the document's
// versions: the piece is found again in each version's source (same line, and
// recognisably the same clause — an AI revision can restructure a document, and
// a different clause that happens to land on the same line is not history), and
// consecutive versions in which it reads the same are one entry.
//
// `versions` is [{ n, text, template?, values?, instructions?, manual? }];
// `parse` lets the caller cache the parsed sources. Each entry carries what is
// needed to put the paragraph back: its template text and the values of its
// blanks at the time.
export const normaliseParagraphText = (t) => matchNorm(t);

const wordsOf = (t) => new Set(matchNorm(stripBlanks(String(t || ''))).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2));
function samePiece(a, b) {
  if (!a || !b) return false;
  if ((a.party ?? null) !== (b.party ?? null)) return false;
  const wa = wordsOf(a.text);
  const wb = wordsOf(b.text);
  if (!wa.size || !wb.size) return a.num === b.num;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared += 1;
  return shared / Math.min(wa.size, wb.size) >= 0.4;
}

export function paragraphHistory(versions, piece, parse = parseSource) {
  const out = [];
  for (const v of versions || []) {
    const model = parse(v);
    let found = null;
    for (const sec of model?.sections || []) {
      found = sec.pieces.find((pc) => pc.id === piece.id) || null;
      if (found) break;
    }
    if (!samePiece(found, piece)) continue;
    const values = {};
    for (const f of found.fields) values[f.id] = String(v.values?.[f.id] ?? '');
    const shown = pieceDisplayText(found, fillText(found.text, v.values || {}));
    const last = out[out.length - 1];
    if (last && matchNorm(last.shown) === matchNorm(shown)) continue;
    // A QUIET version — one saved from nothing but a suggested answer being
    // picked (an identity filling a party) — is not a step in the paragraph's
    // history: it brings the latest entry up to date instead of adding one.
    if (v.quiet && last) { Object.assign(last, { text: found.text, values, shown }); continue; }
    out.push({ n: v.n, text: found.text, values, shown, label: v.instructions || '', manual: !!v.manual });
  }
  return out;
}

// Does this piece have anything the Constructor can do for it — a party to
// identify or a blank to fill?
export function pieceHasData(model, section, piece) {
  if (!piece) return false;
  return piece.party != null || piece.fields.length > 0;
}

// ── Assigning a party ───────────────────────────────────────────────────
// What a record puts into a role's blanks, document-wide.
export function valuesFromRecord(model, role, record) {
  const out = {};
  for (const sec of model.sections) {
    for (const pc of sec.pieces) {
      for (const f of pc.fields) {
        if (!f.key || (f.role || '') !== (role || '')) continue;
        const v = identityValueForField(record, f.key);
        if (v) out[f.id] = v;
      }
    }
  }
  return out;
}

const addressKnown = (rec) => !!String(
  rec?.address || rec?.addressStreet || rec?.addressNumber || rec?.addressBlock || '',
).trim();
const locationKnown = (rec) => !!String(
  rec?.city || rec?.county || rec?.address || rec?.addressStreet || rec?.addressLocality || '',
).trim();

// Settle what the formula left open once the party is known: the gendered
// forms, county-vs-sector, and — for a house — the block/stair/flat clauses,
// which are not blanks left empty but lines the clause should not carry.
export function settleClauseFor(text, role, record) {
  let out = String(text || '');
  if (addressKnown(record) && !addressIsApartment(record)) {
    out = replaceFields(out, ({ all, id, offset }) => {
      const f = fieldInfo(id);
      if ((f.role || '') !== (role || '') || !APARTMENT_ONLY_FIELDS.includes(f.key)) return all;
      return `\u0000DROP${offset}\u0000`;
    });
    // Cut each dropped blank together with the label that introduces it — back
    // to the separator before it.
    // eslint-disable-next-line no-control-regex
    out = out.replace(/[,;]?[^,;\u0000]*\u0000DROP\d+\u0000/g, '');
  }
  if (record?.gender) out = applyGenderToText(out, record.gender);
  if (locationKnown(record)) out = applyLocalityToText(out, addressHasSectors(record));
  return out;
}

// ── Parties ─────────────────────────────────────────────────────────────
// A contract names its parties once; a party is filled from an identity record.
// (The signature section is ordinary text: nothing rewrites it from the parties.)

// What the DOCUMENT calls a party — the „Prestator” of "denumită în continuare
// „Prestator”" — which is the name to sign under. The role token is ASCII
// ("vanzator"), so it is only the fallback.
export function partyDisplayName(text, role) {
  const m = /denumit(?:ă|a|\(ă\)|\/ă)?\s+(?:în\s+continuare\s+|in\s+continuare\s+|mai\s+jos\s+)?[„"“«‚']\s*([^”"»“'’,;.()]{2,40}?)\s*[”"»“'’]/i
    .exec(String(text || '').replace(/\*\*|__/g, ''));
  return (m && m[1].trim()) || roleLabel(role);
}

// The parties a document identifies, in order: one per role, from the first
// clause that identifies it.
export function partiesOf(model) {
  const out = [];
  const seen = new Set();
  for (const sec of model?.sections || []) {
    for (const pc of sec.pieces) {
      if (pc.party == null || !pc.fields.some((f) => f.key)) continue;
      const roleKey = pc.party || '_';
      if (seen.has(roleKey)) continue;
      seen.add(roleKey);
      out.push({
        role: pc.party,
        roleKey,
        name: partyDisplayName(pc.text, pc.party),
        pieceId: pc.id,
        sectionId: sec.id,
        fields: pc.fields.filter((f) => f.key && (f.role || '') === (pc.party || '')),
      });
    }
  }
  return out;
}

// The reverse of filling a party from a record: a record made from what was
// typed into a party. Returns the properties to lay over an empty identity.
const ORG_KEYS = ['taxId', 'regNo', 'legalForm', 'representative', 'repCapacity'];
export function identityFromValues(party, values) {
  const out = {};
  for (const f of party?.fields || []) {
    const v = String(values?.[f.id] ?? '').trim();
    if (!v) continue;
    if (f.key === 'addressCountyOrSector' || f.key === 'addressCounty') out.county = out.county || v;
    else if (f.key === 'addressLocality') { out.city = out.city || v; out.addressLocality = v; }
    else out[f.key] = v;
  }
  if (!Object.keys(out).length) return null;
  const kind = ORG_KEYS.some((k) => out[k]) ? 'org' : 'person';
  return { ...out, kind, name: out.legalName || '' };
}

// ── The party clause: who it is written for, and what it mentions ───────
// An identification clause is a formula, and the formula depends on WHO it
// identifies. A person has a domicile, a CNP and an identity card; a company
// has a registered office, a CUI, a trade-register number and someone who signs
// for it. A clause drafted for one reads wrongly for the other, so when the
// record picked for a party is of the other kind the clause is rewritten in the
// right formula — keeping the document's own ending („denumit(ă) în continuare
// …") and its numbering.

const PERSON_KEYS = ['nationalId', 'idSeries', 'idNumber', 'idDocument', 'idType', 'dateOfBirth', 'placeOfBirth'];
const ORG_ONLY_KEYS = ['taxId', 'regNo', 'legalForm', 'representative', 'repCapacity'];

// 'person' | 'org' | null (the clause doesn't say).
export function clauseKind(fields) {
  const keys = new Set((fields || []).map((f) => f.key).filter(Boolean));
  const person = PERSON_KEYS.filter((k) => keys.has(k)).length;
  const org = ORG_ONLY_KEYS.filter((k) => keys.has(k)).length;
  if (!person && !org) return null;
  return org > person ? 'org' : 'person';
}

const ADDRESS_RO = (b) => `${b('addressLocality')}, str. ${b('addressStreet')}, nr. ${b('addressNumber')}, `
  + `bl. ${b('addressBlock')}, sc. ${b('addressStair')}, et. ${b('addressFloor')}, ap. ${b('addressApartment')}, `
  + `județul/sectorul ${b('addressCountyOrSector')}`;

const FORMULA = {
  person: (b) => `Domnul/Doamna ${b('legalName')}, domiciliat(ă) în ${ADDRESS_RO(b)}, `
    + `identificat(ă) cu ${b('idType')} seria ${b('idSeries')} nr. ${b('idNumber')}, CNP ${b('nationalId')}`,
  org: (b) => `${b('legalName')}, cu sediul în ${ADDRESS_RO(b)}, `
    + `înregistrată la Oficiul Registrului Comerțului sub nr. ${b('regNo')}, cod unic de înregistrare ${b('taxId')}, `
    + `reprezentată legal prin ${b('representative')}, în calitate de ${b('repCapacity')}`,
};

const blankFor = (role) => (key) => `[[${role ? `${role}.${key}` : key}]]`;

// Where the clause stops identifying and starts naming: ", denumit(ă) în
// continuare „Prestator”;" — kept word for word. Failing that, its closing
// punctuation.
function clauseTail(text) {
  const src = String(text || '');
  const m = /,?\s*(?:denumit|numit)[ăa(]/i.exec(src);
  if (m) return src.slice(m.index);
  const end = /[.;,:]\s*$/.exec(src);
  return end ? end[0] : '';
}

// The clause rewritten for `kind`, same role, same ending.
export function partyClauseFor(kind, role, originalText) {
  const make = FORMULA[kind === 'org' ? 'org' : 'person'];
  let tail = clauseTail(originalText);
  if (tail && !/^[,.;:]/.test(tail.trim())) tail = `, ${tail.trim()}`;
  // A company is "societatea": feminine, whatever the draft left open.
  if (kind === 'org') tail = applyGenderToText(tail, 'female');
  return `${make(blankFor(role))}${tail}`;
}

// ── Optional details ────────────────────────────────────────────────────
// What a party clause MAY mention. Each is a pill in the Constructor: on, the
// clause carries the phrase (and its blank fills from the record like any
// other); off, the phrase is cut out of the sentence, label and all.
export const OPTIONAL_PARTS = [
  { id: 'email', label: 'Email', keys: ['email'], phrase: (b) => `e-mail ${b('email')}` },
  { id: 'phone', label: 'Phone', keys: ['phone'], phrase: (b) => `telefon ${b('phone')}` },
  { id: 'bank', label: 'Bank account', keys: ['iban', 'bank'], phrase: (b) => `cont bancar IBAN ${b('iban')}, deschis la ${b('bank')}` },
  { id: 'postal', label: 'Postal code', keys: ['addressPostalCode'], phrase: (b) => `cod poștal ${b('addressPostalCode')}` },
  { id: 'birth', label: 'Date of birth', kind: 'person', keys: ['dateOfBirth'], phrase: (b) => `născut(ă) la data de ${b('dateOfBirth')}` },
  { id: 'birthplace', label: 'Place of birth', kind: 'person', keys: ['placeOfBirth'], phrase: (b) => `născut(ă) în ${b('placeOfBirth')}` },
  { id: 'nationality', label: 'Nationality', kind: 'person', keys: ['nationality'], phrase: (b) => `cetățenie ${b('nationality')}` },
  { id: 'issuer', label: 'ID issuer and date', kind: 'person', keys: ['idIssuer', 'idIssuedAt'], phrase: (b) => `act eliberat de ${b('idIssuer')} la data de ${b('idIssuedAt')}` },
  { id: 'regNo', label: 'Trade Register no.', kind: 'org', keys: ['regNo'], phrase: (b) => `înregistrată la Oficiul Registrului Comerțului sub nr. ${b('regNo')}` },
  { id: 'legalForm', label: 'Legal form', kind: 'org', keys: ['legalForm'], phrase: (b) => `formă juridică ${b('legalForm')}` },
  { id: 'representative', label: 'Representative', kind: 'org', keys: ['representative', 'repCapacity'], phrase: (b) => `reprezentată legal prin ${b('representative')}, în calitate de ${b('repCapacity')}` },
];

// The pills for one clause: which parts apply to this kind of party, and which
// the clause currently carries.
export function optionalPartsFor(text, role, kind) {
  const have = new Set(fieldsOf(text).filter((f) => f.key && (f.role || '') === (role || '')).map((f) => f.key));
  return OPTIONAL_PARTS
    .filter((part) => !part.kind || !kind || part.kind === kind)
    .map((part) => ({ id: part.id, label: part.label, on: part.keys.some((k) => have.has(k)) }));
}

// Cut blanks out of a sentence together with the words that introduce them —
// back to the separator before each. (The same cut settleClauseFor makes for a
// house address.)
function dropBlanks(text, shouldDrop) {
  const marked = replaceFields(text, ({ all, id, offset }) => (
    shouldDrop(fieldInfo(id)) ? `\u0000DROP${offset}\u0000` : all
  ));
  // eslint-disable-next-line no-control-regex
  return marked.replace(/[,;]?[^,;\u0000]*\u0000DROP\d+\u0000/g, '');
}

// Turn one optional part on or off in a clause.
export function setOptionalPart(text, role, partId, on) {
  const part = OPTIONAL_PARTS.find((p) => p.id === partId);
  if (!part) return text;
  const src = String(text || '');
  const mine = (f) => f.key && (f.role || '') === (role || '') && part.keys.includes(f.key);
  const has = fieldsOf(src).some(mine);
  if (on === has) return src;
  if (!on) return dropBlanks(src, mine);
  // Added just before the clause stops identifying the party, so it reads as
  // one more detail rather than an afterthought behind „denumit(ă) …".
  const tail = clauseTail(src);
  const head = tail ? src.slice(0, src.length - tail.length) : src;
  return `${head.replace(/[\s,;]+$/, '')}, ${part.phrase(blankFor(role))}${tail && !/^[,.;:]/.test(tail.trim()) ? ', ' : ''}${tail}`;
}

// A model as it stands WITH the draft's edits: texts replaced, blanks and
// parties re-read from them. Parties and record values are worked
// out from this — a clause rewritten for a company has a representative the
// original never mentioned.
export function withEdits(model, edits) {
  if (!model || !edits || !Object.keys(edits).length) return model;
  return {
    ...model,
    sections: model.sections.map((sec) => ({
      ...sec,
      pieces: sec.pieces.map((pc) => {
        const text = edits[pc.id];
        if (text === undefined) return pc;
        const fields = fieldsOf(text);
        const party = partyOf(fields);
        return { ...pc, text, fields, party: party == null ? pc.party : party };
      }),
    })),
  };
}

// The text a party's clause should have for `record`: the right formula for
// the record's kind, the optional parts as the user currently has them, then
// the settle pass (gender, county-vs-sector, house-vs-flat). Always built from
// the clause AS DRAFTED, so choosing a different record starts clean.
export function partyTextFor(piece, currentText, role, record) {
  const drafted = piece.text;
  const draftedKind = clauseKind(piece.fields);
  const kind = record?.kind === 'org' ? 'org' : 'person';
  let base = (draftedKind && draftedKind !== kind) ? partyClauseFor(kind, role, drafted) : drafted;
  // Carry the pills across. A detail that applies to any party (email, phone,
  // bank account) stays as the user has it. One that belongs to a kind of party
  // (a representative, a date of birth) stays too — unless the party has just
  // changed kind, in which case the new formula's own defaults stand.
  const currentKind = clauseKind(fieldsOf(currentText ?? drafted));
  const fresh = optionalPartsFor(base, role, null);
  for (const part of optionalPartsFor(currentText ?? drafted, role, null)) {
    const def = OPTIONAL_PARTS.find((p) => p.id === part.id);
    if (def.kind && (def.kind !== kind || currentKind !== kind)) continue;
    if (fresh.find((p) => p.id === part.id)?.on !== part.on) base = setOptionalPart(base, role, part.id, part.on);
  }
  return settleClauseFor(base, role, record);
}

// Record values that could answer ONE blank — the dashed chips under an input.
export function suggestionsFor(field, records, current) {
  if (!field?.key) return [];
  const seen = new Set();
  const out = [];
  for (const rec of records || []) {
    const v = identityValueForField(rec, field.key);
    if (!v || v === current || seen.has(v)) continue;
    seen.add(v);
    out.push({ value: v, file: rec._fileName || rec.name || '' });
  }
  return out.slice(0, 4);
}

// Alternative wordings the app ships for well-known clauses. Matched on the
// SECTION title, so they apply to any document that has such a section — not
// only to one started from the template.
export const CLAUSE_VARIANTS = [
  {
    match: /defini[țt]i[ae].*confiden[țt]ial/i,
    label: 'Scope',
    options: [
      {
        label: 'Broad',
        text: 'Prin „Informații Confidențiale” se înțelege orice informație, date, documente, know-how, planuri de afaceri, informații financiare, tehnice sau comerciale, indiferent de forma în care sunt comunicate — scris, verbal, electronic sau prin observare directă — și indiferent dacă sunt sau nu marcate ca fiind confidențiale.',
      },
      {
        label: 'Marked only',
        text: 'Prin „Informații Confidențiale” se înțelege exclusiv informațiile comunicate în scris și marcate vizibil ca „Confidențial”, precum și informațiile comunicate verbal care sunt confirmate în scris ca fiind confidențiale în termen de 10 zile de la comunicare.',
      },
    ],
  },
];

export function variantsFor(section, pieceIndex) {
  if (pieceIndex !== 0) return null;
  return CLAUSE_VARIANTS.find((v) => v.match.test(section.title)) || null;
}

// ── The paragraphs an edit actually changes ────────────────────────────────
// For a file DocVex did NOT write, saving cannot rebuild the document (that
// would throw its Word formatting away — see lib/docxRewrite): the file is
// edited in place, paragraph by paragraph. This says which paragraphs those
// are, as `{ before, after }` — the wording the file has now, and the wording
// it should have — for every piece whose text was edited or whose blanks were
// filled differently from what the document already said.
export function changedParagraphs(model, edits, values, baseValues) {
  const out = [];
  for (const sec of model?.sections || []) {
    for (const pc of sec.pieces) {
      const editedText = edits?.[pc.id];
      const nextText = editedText === undefined ? pc.text : editedText;
      const before = pieceDisplayText(pc, fillText(pc.text, baseValues));
      const after = pieceDisplayText(pc, fillText(nextText, values));
      if (before !== after) out.push({ before, after, pieceId: pc.id });
    }
  }
  return out;
}
