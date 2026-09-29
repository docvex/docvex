// LAYER 1 — identifiers with a STRICT shape, found in a text as spans.
//
// Each span is `{ start, end, type, value, meta }`: `type` is the token type
// the vault gives it (lib/pseudonymize/vault TOKEN_TYPES), `value` the real
// text to keep, `meta` what the token may say about it without identifying
// anyone (a CNP's sex and birth year, an address's county and locality).
//
// Found: CNPs (a bare 13-digit run only with a valid check digit; after the
// word "CNP" whatever it reads as — an OCR slip in one digit must not leak the
// other twelve), CUIs (keyword + check digit, lib/lawRefs), IBANs (mod-97),
// identity-card series + number and passport numbers, MRZ lines, Romanian
// phone numbers, e-mail addresses, and addresses introduced by the words
// that introduce them (domiciliat în, cu sediul în, adresa…).
//
// Added 2026-09-29 (V8) — identifiers that let anyone find the person on a
// public register even when their name is masked: court FILE numbers ("Dosarul
// nr. 1234/3/2026" — portal.just.ro lists the parties), land-register (CF) and
// cadastral / topo numbers (ANCPI names the owner), number plates, bank-card
// numbers (Luhn) and a birth date stated as such ("născut la 12.03.1985").
//
// NEVER touched: amounts, dates and citations of law. Every span that
// overlaps one is dropped (`protectedSpans`: lib/lawRefs `findLawRefs`, dates,
// amounts), and of two overlapping spans the longer wins.
import { decodeCnp, isMrzLine, parseAddress, countyName } from '../roIdDocuments';
import { findCuiRefs, findLawRefs } from '../lawRefs';

/**
 * @typedef {'CNP'|'CUI'|'IBAN'|'CI'|'MRZ'|'TEL'|'EMAIL'|'ADRESA'|'DOSAR'|'CF'|'CAD'|'AUTO'|'CARD'|'NASTERE'} Layer1Type
 * @typedef {{ start: number, end: number, type: Layer1Type, value: string, meta?: string[] }} Span
 */

// ── What must stay as it is ─────────────────────────────────────────────
const DATE_RE = /(?<!\d)\d{1,2}[./-]\d{1,2}[./-](?:\d{4}|\d{2})(?!\d)/g;
const AMOUNT_RE = /(?<![\d.,])\d{1,3}(?:[.\s]\d{3})*(?:,\d{1,2})?\s*(?:lei|ron|eur|euro|usd|\$|€)(?!\p{L})/giu;

/** Spans of text that no detector may cover. @returns {Array<[number, number]>} */
export function protectedSpans(text) {
  const out = [];
  try { for (const r of findLawRefs(text)) out.push([r.start, r.end]); } catch { /* no citations */ }
  for (const m of text.matchAll(DATE_RE)) out.push([m.index, m.index + m[0].length]);
  for (const m of text.matchAll(AMOUNT_RE)) out.push([m.index, m.index + m[0].length]);
  return out;
}

// ── The detectors ───────────────────────────────────────────────────────
const cnpMeta = (digits) => {
  const d = decodeCnp(digits);
  return [d.gender || '', d.birth_date ? d.birth_date.slice(0, 4) : ''].filter(Boolean);
};

function findCnpSpans(text) {
  const out = [];
  // After the word: masked whatever it reads as.
  for (const m of text.matchAll(/C\.?\s?N\.?\s?P\.?\s*(?:nr\.?)?\s*[:\-–]?\s*((?:\d\s?){12}\d)(?!\d)/giu)) {
    const start = m.index + m[0].length - m[1].length;
    const digits = m[1].replace(/\s/g, '');
    out.push({ start, end: m.index + m[0].length, type: 'CNP', value: digits, meta: cnpMeta(digits) });
  }
  // Bare: only a valid one (13 digits are also invoice and file numbers).
  for (const m of text.matchAll(/(?<!\d)[1-9]\d{12}(?!\d)/g)) {
    if (!decodeCnp(m[0]).valid) continue;
    out.push({ start: m.index, end: m.index + 13, type: 'CNP', value: m[0], meta: cnpMeta(m[0]) });
  }
  return out;
}

function findCuiSpans(text) {
  const out = [];
  for (const r of findCuiRefs(text)) {
    // The number only ("CUI: RO 1234567" keeps its keyword).
    const m = /(?:RO\s?)?\d+$/i.exec(r.raw);
    if (!m) continue;
    const start = r.start + m.index;
    out.push({ start, end: r.end, type: 'CUI', value: r.cui, meta: [] });
  }
  return out;
}

/** ISO 13616 mod-97 check. */
export function ibanValid(raw) {
  const s = String(raw || '').replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s)) return false;
  const moved = s.slice(4) + s.slice(0, 4);
  let rest = 0;
  for (const ch of moved) {
    const v = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
    for (const digit of v) rest = (rest * 10 + Number(digit)) % 97;
  }
  return rest === 1;
}
function findIbanSpans(text) {
  const out = [];
  for (const m of text.matchAll(/(?<![A-Z0-9])[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?(?![A-Z0-9])/gi)) {
    // Trim a trailing group that pushed it past a valid length.
    let raw = m[0];
    while (raw.length > 15 && !ibanValid(raw)) raw = raw.replace(/ ?[A-Z0-9]{1,4}$/i, '');
    if (!ibanValid(raw)) continue;
    out.push({ start: m.index, end: m.index + raw.length, type: 'IBAN', value: raw.replace(/\s+/g, '').toUpperCase(), meta: [] });
  }
  return out;
}

function findIdDocSpans(text) {
  const out = [];
  // "seria RX nr. 123456", "seria: RX, numărul 123456", "CI seria XT 654321".
  for (const m of text.matchAll(/\bseria\s*:?\s*([A-Z]{2})\s*,?\s*(?:(?:nr|num[aă]r(?:ul)?)\.?\s*:?\s*)?(\d{6,7})(?!\d)/giu)) {
    const start = m.index + m[0].indexOf(m[1], 5);
    out.push({ start, end: m.index + m[0].length, type: 'CI', value: `${m[1].toUpperCase()} ${m[2]}`, meta: [] });
  }
  // Passports: the number after the word.
  for (const m of text.matchAll(/\bpa[sș]aport(?:ul|ului)?\s*(?:nr\.?|num[aă]r(?:ul)?)?\s*:?\s*([A-Z0-9]{8,9})(?![A-Z0-9])/giu)) {
    if (!/\d{6}/.test(m[1])) continue;
    out.push({ start: m.index + m[0].length - m[1].length, end: m.index + m[0].length, type: 'CI', value: m[1].toUpperCase(), meta: [] });
  }
  return out;
}

function findMrzSpans(text) {
  const out = [];
  let at = 0;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && isMrzLine(trimmed)) {
      const start = at + line.indexOf(trimmed);
      out.push({ start, end: start + trimmed.length, type: 'MRZ', value: trimmed, meta: [] });
    }
    at += line.length + 1;
  }
  return out;
}

function findPhoneSpans(text) {
  const out = [];
  for (const m of text.matchAll(/(?<![\d.,/])(?:\+40|0040|0)[ .-]?(?:\(0\))?[ .-]?[237]\d{1,2}(?:[ .-]?\d{2,3}){2,3}(?!\d|,\d)/g)) {
    const digits = m[0].replace(/\D/g, '').replace(/^(?:0040|40)/, '0');
    if (digits.length !== 10 || !/^0[237]/.test(digits)) continue;
    out.push({ start: m.index, end: m.index + m[0].length, type: 'TEL', value: digits, meta: [] });
  }
  return out;
}

function findEmailSpans(text) {
  const out = [];
  for (const m of text.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)) {
    out.push({ start: m.index, end: m.index + m[0].length, type: 'EMAIL', value: m[0].toLowerCase(), meta: [] });
  }
  return out;
}

// An address runs from the words introducing it to the next clause.
const ADDRESS_LEAD = /(?:domiciliat[ăa]?|cu\s+domiciliul|av[aâ]nd\s+domiciliul|locuie[sș]te|re[sș]edin[tț]a|cu\s+sediul(?:\s+social)?|sediul(?:\s+social)?|adresa|adres[aă]\s+de\s+coresponden[tț][aă])\s*(?:[îi]n|la)?\s*:?\s*/giu;
const ADDRESS_ABBR = /(?:^|[\s,])(?:str|nr|bl|sc|et|ap|jud|mun|sect|sat|com|or|loc|bd|bdul|b-dul|cal|[sș]os|al|intr|p-?[tț]a|cod|c\.p)$/i;
const ADDRESS_STOP = /^,\s*(?:CNP|C\.N\.P|posesor|posesoare|identificat|identificat[ăa]|av[aâ]nd|[îi]nmatriculat|[îi]nregistrat|CUI|C\.U\.I|cod\s+(?:unic|fiscal)|telefon|tel\.?|e-?mail|reprezentat|[îi]n\s+calitate|denumit|numit|n[aă]scut|cet[aă][tț]ean)/iu;
function findAddressSpans(text) {
  const out = [];
  ADDRESS_LEAD.lastIndex = 0;
  for (let m = ADDRESS_LEAD.exec(text); m; m = ADDRESS_LEAD.exec(text)) {
    const start = m.index + m[0].length;
    const limit = Math.min(text.length, start + 220);
    let end = limit;
    for (let i = start; i < limit; i += 1) {
      const ch = text[i];
      if (ch === '\n' || ch === ';' || ch === ')') { end = i; break; }
      if (ch === ',' && ADDRESS_STOP.test(text.slice(i, i + 40))) { end = i; break; }
      // A full stop ends it unless it closes an abbreviation (Str., Nr., Jud.).
      if (ch === '.' && /\s/.test(text[i + 1] || ' ') && !ADDRESS_ABBR.test(text.slice(Math.max(start, i - 8), i))) { end = i; break; }
    }
    const raw = text.slice(start, end).replace(/[\s,]+$/, '');
    if (raw.length < 6 || !/\d|\b(?:str|jud|mun|sat|com|sector|bd)\b/i.test(raw)) continue;
    const a = parseAddress(raw);
    const meta = [countyName(a.county), a.city].filter(Boolean);
    out.push({ start, end: start + raw.length, type: 'ADRESA', value: raw, meta });
  }
  return out;
}

// Court file numbers: "Dosar(ul) nr. 1234/3/2026", "dosar 567/299/2025/a1".
function findCaseFileSpans(text) {
  const out = [];
  for (const m of text.matchAll(/\bdos(?:ar(?:ul|ului)?|\.)\s*(?:nr\.?|num[aă]r(?:ul)?)?\s*:?\s*(\d{1,6}\/\d{1,4}\/\d{4}(?:\/a\d{1,3}(?:\.\d{1,3})?)?\**)(?![\d/])/giu)) {
    const start = m.index + m[0].length - m[1].length;
    out.push({ start, end: m.index + m[0].length, type: 'DOSAR', value: m[1], meta: [m[1].split('/')[2] || ''].filter(Boolean) });
  }
  return out;
}

// Land register: "cartea funciară nr. 123456", "CF nr. 12345-C1-U3".
// Cadastral / topographic: "număr cadastral 123456", "nr. cad. 1234", "nr. topo 567/2/1".
function findLandSpans(text) {
  const out = [];
  for (const m of text.matchAll(/(?:\bcart(?:e|ea|ii)\s+funciar[eăa]|\bC\.?\s?F\.?)\s*(?:nr\.?|num[aă]r(?:ul)?)\s*:?\s*(\d{2,8}(?:\s*[-/]\s*[A-Z]{0,2}\d{1,5})*)(?![\d])/gu)) {
    out.push({ start: m.index + m[0].length - m[1].length, end: m.index + m[0].length, type: 'CF', value: m[1], meta: [] });
  }
  for (const m of text.matchAll(/(?:\bnum[aă]r(?:ul)?\s+(?:cadastral|topo(?:grafic)?)|\bnr\.?\s*(?:cad(?:astral)?|topo(?:grafic)?)\.?|\bcadastral(?:ă|a)?|\btopo)\s*(?:nr\.?)?\s*:?\s*(\d{2,8}(?:\s*[/-]\s*[A-Z]?\d{1,5})*)(?![\d])/giu)) {
    out.push({ start: m.index + m[0].length - m[1].length, end: m.index + m[0].length, type: 'CAD', value: m[1], meta: [] });
  }
  return out;
}

// Romanian number plates: county code (or B) + 2–3 digits + 3 letters.
const COUNTIES = 'AB|AR|AG|BC|BH|BN|BT|BV|BR|BZ|CS|CL|CJ|CT|CV|DB|DJ|GL|GR|GJ|HR|HD|IL|IS|IF|MM|MH|MS|NT|OT|PH|SM|SJ|SB|SV|TR|TM|TL|VS|VL|VN|B';
const PLATE_RE = new RegExp(`(?<![A-Z0-9])(${COUNTIES})[ -]?(\\d{2,3})[ -]?([A-Z]{3})(?![A-Za-z0-9])`, 'g');
function findPlateSpans(text) {
  const out = [];
  for (const m of text.matchAll(PLATE_RE)) {
    if (m[1] !== 'B' && m[2].length === 3) continue; // three digits only in Bucharest
    out.push({ start: m.index, end: m.index + m[0].length, type: 'AUTO', value: `${m[1]}${m[2]}${m[3]}`, meta: [m[1]] });
  }
  return out;
}

function luhn(digits) {
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}
function findCardSpans(text) {
  const out = [];
  for (const m of text.matchAll(/(?<![\d])[2-6]\d{3}(?:[ -]?\d{4}){2}[ -]?\d{3,4}(?:[ -]?\d{1,3})?(?![\d])/g)) {
    const digits = m[0].replace(/\D/g, '');
    if (digits.length < 15 || digits.length > 19 || !luhn(digits)) continue;
    out.push({ start: m.index, end: m.index + m[0].length, type: 'CARD', value: digits, meta: [] });
  }
  return out;
}

// A birth date stated as one (dates in general stay — they carry the case).
const MONTHS = 'ianuarie|februarie|martie|aprilie|mai|iunie|iulie|august|septembrie|octombrie|noiembrie|decembrie';
const BIRTH_RE = new RegExp(`(?:n[aă]scut(?:[ăa])?|data\\s+na[sș]terii)\\s*(?:la|pe|[îi]n)?\\s*(?:data\\s+de)?\\s*:?\\s*(\\d{1,2}[./-]\\d{1,2}[./-]\\d{4}|\\d{1,2}\\s+(?:${MONTHS})\\s+\\d{4})`, 'giu');
function findBirthSpans(text) {
  const out = [];
  for (const m of text.matchAll(BIRTH_RE)) {
    const year = (m[1].match(/\d{4}/) || [''])[0];
    out.push({ start: m.index + m[0].length - m[1].length, end: m.index + m[0].length, type: 'NASTERE', value: m[1], meta: [year].filter(Boolean) });
  }
  return out;
}

const DETECTORS = [findMrzSpans, findCnpSpans, findCuiSpans, findIbanSpans, findIdDocSpans, findPhoneSpans, findEmailSpans, findAddressSpans, findCaseFileSpans, findLandSpans, findPlateSpans, findCardSpans, findBirthSpans];

/**
 * Non-overlapping spans, longest first on overlap, in text order — none
 * touching a date, an amount or a citation of law.
 * @param {string} text
 * @param {{ protect?: Array<[number, number]> }} [opts]
 * @returns {Span[]}
 */
export function detectLayer1(text, { protect } = {}) {
  const t = String(text || '');
  if (!t) return [];
  const guard = protect || protectedSpans(t);
  const all = DETECTORS.flatMap((fn) => fn(t)).filter((s) => s.end > s.start);
  // A span overlapping a protected one is dropped — except an ADDRESS, whose
  // house and flat numbers can look like a date or an amount ("nr. 12/3"); an
  // address is dropped only when it overlaps a citation of law.
  const clear = all.filter((s) => !guard.some(([a, b]) => s.start < b && a < s.end
    && (!DATE_SHAPED.has(s.type) || isCitation(t, a, b))));
  return pickSpans(clear);
}
// Types whose numbers can look like a date or an amount ("nr. 12/3", a court
// file "12/3/2026", a birth date): dropped only over a citation of law.
const DATE_SHAPED = new Set(['ADRESA', 'DOSAR', 'CF', 'CAD', 'NASTERE']);
const isCitation = (t, a, b) => /\b(?:art|lege|legea|ordonan|hot[aă]r|cod)/i.test(t.slice(a, b));

/** Longest wins on overlap; ties keep the earlier. @param {Span[]} spans */
export function pickSpans(spans) {
  const sorted = [...spans].sort((x, y) => (y.end - y.start) - (x.end - x.start) || x.start - y.start);
  const kept = [];
  for (const s of sorted) if (!kept.some((k) => s.start < k.end && k.start < s.end)) kept.push(s);
  return kept.sort((x, y) => x.start - y.start);
}
