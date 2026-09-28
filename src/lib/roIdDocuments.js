// ROMANIAN IDENTITY DOCUMENTS — one normalised reading for every kind and era:
//   CEI            the electronic identity card (since 2021; TD1 strip, 3 × 30)
//   CI / CIP       the plastic card (1997–), 2 × 36 strip; the provisional card
//   PASAPORT       ordinary / temporary passport (TD3 strip, 2 × 44)
//   BI_CEAUSESCU   the booklet buletin de identitate (1949–1997; a CNP only
//                  from 1978 on — often handwritten or stamped)
//   BI_INTERBELIC  identity documents before 1949 (paper, no CNP)
// The reading is built from three sources, each checked against the others:
// what the AI read off the document (the autofill prompt asks for `ro_id` in
// this shape — `RO_ID_PROMPT`), what this file reads off the OCR text by its
// own labels (`parseRoIdText`, free, no AI), and what the CNP and the
// machine-readable strip ENCODE (`decodeCnp`, `parseMrz`). A disagreement is
// kept as a warning, never silently resolved.
//
// OCR on Romanian documents drops diacritics (Î Â Ș Ț Ă read as I A S T A,
// cedilla ş ţ for comma ș ț): every label and keyword here is matched through
// `roRx`, which accepts all three spellings of each letter.

// ── Diacritics ─────────────────────────────────────────────────────────
const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
// A pattern written WITHOUT diacritics, made to match any spelling of them.
// `\b` is made letter-aware too (JavaScript's is ASCII-only, so it would not
// see a boundary before "Ș").
const WB = '(?:(?<![\\p{L}\\p{N}])(?=[\\p{L}\\p{N}])|(?<=[\\p{L}\\p{N}])(?![\\p{L}\\p{N}]))';
export function roRx(src, flags = 'iu') {
  const map = { a: '[aăâAĂÂ]', i: '[iîIÎ]', s: '[sșşSȘŞ]', t: '[tțţTȚŢ]' };
  let out = '';
  let inClass = false;
  for (let k = 0; k < src.length; k += 1) {
    const c = src[k];
    if (c === '\\' && src[k + 1] === 'b' && !inClass) { out += WB; k += 1; continue; }
    if (c === '\\') { out += c + (src[k + 1] || ''); k += 1; continue; }
    if (c === '[') inClass = true;
    if (c === ']') inClass = false;
    out += !inClass && map[c.toLowerCase()] ? map[c.toLowerCase()] : c;
  }
  return new RegExp(out, flags);
}
// Cedilla ş ţ → comma ș ț (the correct Romanian letters).
export const commaBelow = (s) => String(s || '').replace(/ş/g, 'ș').replace(/Ş/g, 'Ș').replace(/ţ/g, 'ț').replace(/Ţ/g, 'Ț');

// ── Dates ──────────────────────────────────────────────────────────────
const pad = (n) => String(n).padStart(2, '0');
const validYmd = (y, m, d) => y >= 1800 && y <= 2150 && m >= 1 && m <= 12 && d >= 1 && d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
const MONTHS = {
  ian: 1, ianuarie: 1, jan: 1, january: 1, janvier: 1, feb: 2, februarie: 2, february: 2, fevrier: 2, mar: 3, martie: 3, march: 3, mars: 3,
  apr: 4, aprilie: 4, april: 4, avril: 4, mai: 5, may: 5, iun: 6, iunie: 6, jun: 6, june: 6, juin: 6, iul: 7, iulie: 7, jul: 7, july: 7, juillet: 7,
  aug: 8, august: 8, aout: 8, sep: 9, sept: 9, septembrie: 9, september: 9, septembre: 9, oct: 10, octombrie: 10, october: 10, octobre: 10,
  noi: 11, nov: 11, noiembrie: 11, november: 11, novembre: 11, dec: 12, decembrie: 12, december: 12, decembre: 12,
};
// Any written date → { y, m, d } or null. Two-digit years are read as the
// most recent past century for birth dates (`future: false`) and this
// century for expiry dates (`future: true`).
function dateParts(s, { future = false } = {}) {
  const t = fold(s);
  const year = (y) => {
    if (y >= 100) return y;
    const now = new Date().getFullYear() % 100;
    return future ? 2000 + y : (y > now ? 1900 + y : 2000 + y);
  };
  let m = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(t);
  if (m && validYmd(+m[1], +m[2], +m[3])) return { y: +m[1], m: +m[2], d: +m[3] };
  m = /(?<!\d)(\d{1,2})\s*[./-]\s*(\d{1,2})\s*[./-]\s*(\d{4}|\d{2})(?!\d)/.exec(t);
  if (m) { const y = year(+m[3]); if (validYmd(y, +m[2], +m[1])) return { y, m: +m[2], d: +m[1] }; }
  m = /(?<!\d)(\d{1,2})\s+([a-z]{3,10})\.?\s+(\d{4}|\d{2})(?!\d)/.exec(t);
  if (m && MONTHS[m[2]]) { const y = year(+m[3]); if (validYmd(y, MONTHS[m[2]], +m[1])) return { y, m: MONTHS[m[2]], d: +m[1] }; }
  return null;
}
export const toRoDate = (p) => (p ? `${pad(p.d)}.${pad(p.m)}.${p.y}` : '');
export const toIsoDate = (p) => (p ? `${p.y}-${pad(p.m)}-${pad(p.d)}` : '');
export const normalizeDate = (s, opts) => toRoDate(dateParts(s, opts));
const isoToRo = (iso) => (iso ? iso.split('-').reverse().join('.') : '');

// ── Gender ─────────────────────────────────────────────────────────────
// Every way a document or a model writes it → 'M' | 'F' | ''. A lone digit
// is read as a CNP's first digit.
export function normalizeGender(v) {
  const t = fold(v).trim();
  if (!t) return '';
  if (/^[1357]$/.test(t)) return 'M';
  if (/^[2468]$/.test(t)) return 'F';
  if (/^(m|masc|masculin|barbat|barbatesc|barbateasca|male|man|homme|b)\b/.test(t)) return 'M';
  if (/^(f|fem|feminin|femeie|femeiesc|femeiasca|female|woman|femme)\b/.test(t)) return 'F';
  return '';
}

// ── CNP ────────────────────────────────────────────────────────────────
// S AA LL ZZ JJ NNN C — sex and century, birth date, county, serial, check.
const CNP_KEY = [2, 7, 9, 1, 4, 6, 3, 5, 8, 2, 7, 9];
const CENTURY = { 1: 1900, 2: 1900, 3: 1800, 4: 1800, 5: 2000, 6: 2000 };
// The county codes (JJ): 01–46 counties and București's sectors 1–6 (41–46),
// 47–48 the former sectors 7–8, 51 Călărași, 52 Giurgiu, 70 the central code
// (a CNP given without a county of registration).
const COUNTY_CODES = {
  '01': 'Alba', '02': 'Arad', '03': 'Argeș', '04': 'Bacău', '05': 'Bihor', '06': 'Bistrița-Năsăud', '07': 'Botoșani', '08': 'Brașov', '09': 'Brăila',
  10: 'Buzău', 11: 'Caraș-Severin', 12: 'Cluj', 13: 'Constanța', 14: 'Covasna', 15: 'Dâmbovița', 16: 'Dolj', 17: 'Galați', 18: 'Gorj', 19: 'Harghita',
  20: 'Hunedoara', 21: 'Ialomița', 22: 'Iași', 23: 'Ilfov', 24: 'Maramureș', 25: 'Mehedinți', 26: 'Mureș', 27: 'Neamț', 28: 'Olt', 29: 'Prahova',
  30: 'Satu Mare', 31: 'Sălaj', 32: 'Sibiu', 33: 'Suceava', 34: 'Teleorman', 35: 'Timiș', 36: 'Tulcea', 37: 'Vaslui', 38: 'Vâlcea', 39: 'Vrancea',
  40: 'București', 41: 'București, Sector 1', 42: 'București, Sector 2', 43: 'București, Sector 3', 44: 'București, Sector 4', 45: 'București, Sector 5',
  46: 'București, Sector 6', 47: 'București, Sector 7 (former)', 48: 'București, Sector 8 (former)', 51: 'Călărași', 52: 'Giurgiu',
  70: 'Central code — no county of registration',
};
// → { cnp, valid, problems, birth_date (YYYY-MM-DD), gender, century,
//     century_inferred, foreign, resident, county_code, county, serial }
export function decodeCnp(value) {
  const cnp = String(value || '').replace(/\D/g, '');
  const out = { cnp, valid: false, problems: [], birth_date: '', gender: '', century: null, century_inferred: false, foreign: false, resident: null, county_code: '', county: '', serial: '' };
  if (cnp.length !== 13) { out.problems.push(`It has ${cnp.length} digits, not 13`); return out; }
  const d = cnp.split('').map(Number);
  const s = d[0];
  if (s === 0) out.problems.push('The first digit (sex and century) cannot be 0');
  out.gender = s ? (s % 2 === 1 ? 'M' : 'F') : '';
  if (s === 9) out.gender = '';                        // 9: a foreign citizen, no sex encoded
  out.foreign = s >= 7;
  out.resident = s === 7 || s === 8 ? true : s === 9 ? false : null;
  const yy = d[1] * 10 + d[2];
  if (CENTURY[s]) out.century = CENTURY[s];
  else if (s >= 7) {
    // A foreigner's CNP encodes no century: the most recent past one.
    out.century = yy > new Date().getFullYear() % 100 ? 1900 : 2000;
    out.century_inferred = true;
  }
  const month = d[3] * 10 + d[4];
  const day = d[5] * 10 + d[6];
  const year = (out.century || 1900) + yy;
  if (validYmd(year, month, day)) {
    out.birth_date = `${year}-${pad(month)}-${pad(day)}`;
    if (out.birth_date > new Date().toISOString().slice(0, 10)) out.problems.push('The birth date it holds is in the future');
  } else out.problems.push(`The birth date it holds (${pad(day)}.${pad(month)}.${pad(yy)}) does not exist`);
  out.county_code = cnp.slice(7, 9);
  out.county = COUNTY_CODES[out.county_code] || COUNTY_CODES[Number(out.county_code)] || '';
  if (!out.county) out.problems.push(`The county code ${out.county_code} is not one Romania uses`);
  out.serial = cnp.slice(9, 12);
  const sum = CNP_KEY.reduce((n, k, i) => n + k * d[i], 0) % 11;
  const control = sum === 10 ? 1 : sum;
  if (control !== d[12]) out.problems.push(`The check digit is wrong (should be ${control}, is ${d[12]})`);
  out.valid = !out.problems.length;
  return out;
}
// CNPs in a text (13 digits after the word — spaced or not — or a bare
// 13-digit run that passes the check).
export function findCnps(text) {
  const out = new Set();
  const t = String(text || '');
  for (const m of t.matchAll(/C\.?\s?N\.?\s?P\.?\s*(?:nr\.?)?\s*[:\-–]?\s*((?:\d\s?){13})(?!\d)/gi)) out.add(m[1].replace(/\s/g, ''));
  for (const m of t.matchAll(/(?<!\d)([1-9]\d{12})(?!\d)/g)) if (decodeCnp(m[1]).valid) out.add(m[1]);
  return [...out];
}

// ── The machine-readable strip (ICAO 9303) ──────────────────────────────
const MRZ_VAL = (c) => (c === '<' ? 0 : /\d/.test(c) ? Number(c) : c.charCodeAt(0) - 55);
const mrzCheck = (field, digit) => /\d/.test(digit || '') && field.split('').reduce((n, c, i) => n + MRZ_VAL(c) * [7, 3, 1][i % 3], 0) % 10 === Number(digit);
const mrzDate = (yymmdd, future) => {
  if (!/^\d{6}$/.test(yymmdd)) return null;
  const p = dateParts(`${yymmdd.slice(4, 6)}.${yymmdd.slice(2, 4)}.${yymmdd.slice(0, 2)}`, { future });
  return p ? toIsoDate(p) : null;
};
const mrzName = (s) => {
  const [sur, giv = ''] = s.replace(/<+$/, '').split('<<');
  return { surname: sur.replace(/</g, ' ').trim(), given: giv.replace(/</g, ' ').trim() };
};
const mrzShape = (l) => l.toUpperCase().replace(/[«‹›»]/g, '<').replace(/\s+/g, '');
// (The older Romanian card's second line may carry a single "<".)
export const isMrzLine = (l) => { const x = mrzShape(l); return /^[A-Z0-9<]{28,48}$/.test(x) && x.includes('<') && ((x.match(/</g) || []).length >= 2 || /\d{6}/.test(x)); };
const fit = (l, n) => (l.length >= n ? l.slice(0, n) : l + '<'.repeat(n - l.length));
// → { format: TD1 | TD2 | TD3, type, country, surname, given, docNumber, docOk,
//     nationality, birth, birthOk, sex, expiry, expiryOk, optional, finalOk, lines }
export function parseMrz(text) {
  const lines = String(text || '').split(/\r?\n/).filter(isMrzLine).map(mrzShape);
  for (let i = 0; i < lines.length; i += 1) {
    const a = lines[i]; const b = lines[i + 1]; const c = lines[i + 2];
    if (b && c && Math.abs(a.length - 30) <= 2 && Math.abs(b.length - 30) <= 2 && Math.abs(c.length - 30) <= 3 && /^[IAC]/.test(a)) {
      const l1 = fit(a, 30); const l2 = fit(b, 30); const l3 = fit(c, 30);
      const doc = l1.slice(5, 14);
      return {
        format: 'TD1', type: l1.slice(0, 2).replace(/</g, ''), country: l1.slice(2, 5),
        docNumber: doc.replace(/</g, ''), docOk: mrzCheck(doc, l1[14]), optional: l1.slice(15, 30).replace(/</g, ''),
        birth: mrzDate(l2.slice(0, 6), false), birthOk: mrzCheck(l2.slice(0, 6), l2[6]), sex: l2[7].replace('<', ''),
        expiry: mrzDate(l2.slice(8, 14), true), expiryOk: mrzCheck(l2.slice(8, 14), l2[14]), nationality: l2.slice(15, 18),
        optional2: l2.slice(18, 29).replace(/</g, ''),
        finalOk: mrzCheck(l1.slice(5, 30) + l2.slice(0, 7) + l2.slice(8, 15) + l2.slice(18, 29), l2[29]),
        ...mrzName(l3), lines: [l1, l2, l3],
      };
    }
    if (!b) continue;
    const len = Math.abs(a.length - 44) <= 3 && Math.abs(b.length - 44) <= 3 ? 44 : Math.abs(a.length - 36) <= 3 && Math.abs(b.length - 36) <= 3 ? 36 : 0;
    if (!len || !/^[PIAC]/.test(a)) continue;
    const l1 = fit(a, len); const l2 = fit(b, len);
    const doc = l2.slice(0, 9);
    const opt = len === 44 ? l2.slice(28, 42) : l2.slice(28, 35);
    const composite = len === 44 ? l2.slice(0, 10) + l2.slice(13, 20) + l2.slice(21, 43) : l2.slice(0, 10) + l2.slice(13, 20) + l2.slice(21, 35);
    return {
      format: len === 44 ? 'TD3' : 'TD2', type: l1.slice(0, 2).replace(/</g, ''), country: l1.slice(2, 5),
      ...mrzName(l1.slice(5)),
      docNumber: doc.replace(/</g, ''), docOk: mrzCheck(doc, l2[9]), nationality: l2.slice(10, 13),
      birth: mrzDate(l2.slice(13, 19), false), birthOk: mrzCheck(l2.slice(13, 19), l2[19]), sex: l2[20].replace('<', ''),
      expiry: mrzDate(l2.slice(21, 27), true), expiryOk: mrzCheck(l2.slice(21, 27), l2[27]),
      optional: opt.replace(/</g, ''), finalOk: mrzCheck(composite, l2[len - 1]),
      lines: [l1, l2],
    };
  }
  return null;
}

// ── Addresses ──────────────────────────────────────────────────────────
// "Jud. Cluj, Mun. Cluj-Napoca, Str. Lalelelor nr. 5 bl. A2 sc. 1 et. 3 ap. 12"
// → { county, city, street, number, building, entrance, floor, apartment, raw }.
// București is written "Mun. București Sec. 3" / "Sectorul 3".
const ADDR = {
  county: roRx('\\b(?:jud(?:etul)?\\.?|judet)\\s*([^,;\\s]+(?:[\\s-][A-Z][^,;\\s]*)*?)(?=\\s*(?:,|;|$|\\b(?:mun|municipiul|or|orasul|oras|com|comuna|sat|satul|loc|localitatea|str|strada|sec|sectorul)\\b))'),
  sector: roRx('\\bsec(?:t(?:or(?:ul)?)?)?\\.?\\s*(\\d)\\b'),
  city: roRx('\\b(?:mun\\.\\s*|municipiul\\s+|or\\.\\s*|orasul\\s+|oras\\s+|com\\.\\s*|comuna\\s+|sat(?:ul)?\\s+|loc\\.\\s*|localitatea\\s+|(?:mun|or|com|loc)\\s+)([^,;]+?)(?=\\s*(?:,|;|$|\\b(?:sec|sectorul|str|strada|bd|b-dul|bulevardul|calea|sos|soseaua|al|aleea|piata|intr|intrarea|spl|splaiul|nr)\\b))'),
  street: roRx('\\b((?:str|strada|bd|b-dul|bdul|bulevardul|calea|cal|sos|soseaua|al|aleea|piata|pta|intr|intrarea|spl|splaiul)(?:\\.\\s*|\\s+)[^,;]+?)(?=\\s*(?:,|;|$|\\b(?:nr|numar|numarul|bl|bloc|blocul|sc|scara|et|etaj|etajul|ap|apartament|apartamentul)\\b))'),
  number: roRx('\\b(?:numar(?:ul)?|nr)\\b\\.?\\s*[:.]?\\s*([0-9]+[A-Za-z]?(?:\\s*[-/]\\s*[0-9A-Za-z]+)?)'),
  building: roRx('\\b(?:bloc(?:ul)?|bl)\\b\\.?\\s*[:.]?\\s*([0-9A-Za-z][0-9A-Za-z-]*)'),
  entrance: roRx('\\b(?:scara|sc)\\b\\.?\\s*[:.]?\\s*([0-9A-Za-z]{1,3})\\b'),
  floor: roRx('\\b(?:etaj(?:ul)?|et)\\b\\.?\\s*[:.]?\\s*(-?\\d{1,2}|p|parter|m|mansarda)\\b'),
  apartment: roRx('\\b(?:apartament(?:ul)?|ap)\\b\\.?\\s*[:.]?\\s*(\\d{1,4}[A-Za-z]?)\\b'),
};
const COUNTY_ABBR = {
  AB: 'Alba', AR: 'Arad', AG: 'Argeș', BC: 'Bacău', BH: 'Bihor', BN: 'Bistrița-Năsăud', BT: 'Botoșani', BV: 'Brașov', BR: 'Brăila', BZ: 'Buzău',
  CS: 'Caraș-Severin', CL: 'Călărași', CJ: 'Cluj', CT: 'Constanța', CV: 'Covasna', DB: 'Dâmbovița', DJ: 'Dolj', GL: 'Galați', GR: 'Giurgiu', GJ: 'Gorj',
  HR: 'Harghita', HD: 'Hunedoara', IL: 'Ialomița', IS: 'Iași', IF: 'Ilfov', MM: 'Maramureș', MH: 'Mehedinți', MS: 'Mureș', NT: 'Neamț', OT: 'Olt',
  PH: 'Prahova', SM: 'Satu Mare', SJ: 'Sălaj', SB: 'Sibiu', SV: 'Suceava', TR: 'Teleorman', TM: 'Timiș', TL: 'Tulcea', VS: 'Vaslui', VL: 'Vâlcea', VN: 'Vrancea', B: 'București',
};
export const countyName = (v) => COUNTY_ABBR[String(v || '').trim().toUpperCase()] || String(v || '').trim();
// Words that only say WHAT a part is — never a place's name.
const PART_WORD = roRx('^(?:str|strada|bd|b-dul|bdul|bulevardul|calea|cal|sos|soseaua|al|aleea|piata|pta|intr|intrarea|spl|splaiul|nr|numar|numarul|bl|bloc|blocul|sc|scara|et|etaj|etajul|ap|apartament|apartamentul|jud|judetul|judet|mun|municipiul|or|oras|orasul|com|comuna|sat|satul|loc|localitatea|sec|sector|sectorul|cod postal|romania)\\b', 'iu');
export function parseAddress(raw) {
  const text = commaBelow(String(raw || '').replace(/\s+/g, ' ').trim());
  const out = { county: '', city: '', street: '', number: '', building: '', entrance: '', floor: '', apartment: '', raw: text };
  if (!text) return out;
  for (const k of ['county', 'city', 'street', 'number', 'building', 'entrance', 'floor', 'apartment']) {
    const m = ADDR[k].exec(text);
    if (m) out[k] = m[1].trim().replace(/[.,;]+$/, '');
  }
  // Places written bare, as a form fills them ("…, ap. -, CONSTANTA,
  // CONSTANTA"): the plain segments at the END — no part word, no digit —
  // are the locality, then the county.
  if (!out.city || !out.county) {
    const segs = text.split(/[,;]/).map((x) => x.trim()).filter(Boolean);
    const tail = [];
    for (let i = segs.length - 1; i >= 0; i -= 1) {
      const seg = segs[i];
      if (/^[-–]+$/.test(seg)) continue;
      if (/\d/.test(seg) || PART_WORD.test(seg) || /\s[-–]$/.test(seg)) break;
      tail.unshift(seg);
    }
    if (tail.length && !out.city) out.city = tail[0];
    if (tail.length > 1 && !out.county) out.county = tail[tail.length - 1];
  }
  // A house number written straight after the street's name ("Str. Lalelelor
  // 5"): only up to three digits — "Răscoalei 1907" is a name, not number 1907.
  if (!out.number && out.street) {
    const m = /^(.*\S)\s+(\d{1,3}[A-Za-z]?)$/.exec(out.street);
    if (m && /\p{L}/u.test(m[1].replace(/^\S+\.?\s*/, ''))) { out.street = m[1]; out.number = m[2]; }
  }
  out.county = countyName(out.county);
  const sec = ADDR.sector.exec(text);
  if (/bucur/i.test(fold(text)) || sec) {
    if (!out.county) out.county = 'București';
    if (sec) out.city = `București, Sector ${sec[1]}`;
    else if (!out.city) out.city = 'București';
  }
  return out;
}

// ── Kinds of document ──────────────────────────────────────────────────
export const RO_ID_TYPES = ['CEI', 'CI', 'CIP', 'PASAPORT', 'BI_CEAUSESCU', 'BI_INTERBELIC', 'PERMIS_SEDERE', 'OTHER'];
export const RO_ID_TYPE_LABELS = {
  CEI: 'Carte electronică de identitate', CI: 'Carte de identitate', CIP: 'Carte de identitate provizorie', PASAPORT: 'Pașaport',
  BI_CEAUSESCU: 'Buletin de identitate (1949–1997)', BI_INTERBELIC: 'Act de identitate interbelic (înainte de 1949)', PERMIS_SEDERE: 'Permis de ședere', OTHER: 'Alt act de identitate',
};
export function normalizeDocType(v) {
  const t = fold(v).replace(/[^a-z_ ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  const up = t.toUpperCase().replace(/ /g, '_');
  if (RO_ID_TYPES.includes(up)) return up;
  if (/electronic|\bcei\b/.test(t)) return 'CEI';
  if (/provizori|\bcip\b/.test(t)) return 'CIP';
  if (/pasap|passport/.test(t)) return 'PASAPORT';
  if (/permis de sedere|residence/.test(t)) return 'PERMIS_SEDERE';
  if (/interbelic|interwar/.test(t)) return 'BI_INTERBELIC';
  if (/buletin|\bbi\b|carnet|booklet/.test(t)) return 'BI_CEAUSESCU';
  if (/carte de identitate|identity card|\bci\b/.test(t)) return 'CI';
  return '';
}
// The kind, from the text itself (and its strip, if any).
function docTypeFromText(text, mrz) {
  const t = fold(text);
  if (mrz?.format === 'TD3' || /\bp<rou/.test(t) || /pasaport|passeport|passport/.test(t)) return 'PASAPORT';
  if (/permis de sedere|residence permit|titre de sejour/.test(t)) return 'PERMIS_SEDERE';
  if (/provizori/.test(t)) return 'CIP';
  if (/carte electronica de identitate|electronic identity card|carte d.identite electronique/.test(t) || mrz?.format === 'TD1') return 'CEI';
  // Before 1949 ("Regatul României", or every year it gives is earlier), else
  // the 1949–1997 booklet.
  const years = [...t.matchAll(/(?<!\d)(1[89]\d\d|20\d\d)(?!\d)/g)].map((m) => +m[1]);
  // (A modern card with a 1940 birth date and two-digit issue years must not
  // pass: no strip and no CNP are required too — the CNP dates from 1978.)
  const prewar = /regatul romaniei/.test(t) || (!mrz && !findCnps(text).length && years.length > 0 && Math.max(...years) < 1949);
  if (/buletin de identitate|carte de identitate/.test(t) && prewar) return 'BI_INTERBELIC';
  if (/buletin de identitate/.test(t)) return 'BI_CEAUSESCU';
  if (/carte de identitate|carte d.identite|identity card/.test(t) || mrz?.format === 'TD2') return 'CI';
  return '';
}

// ── Reading the OCR text by its labels (local, free) ────────────────────
// A Romanian card prints each label in three languages ("Nume/Nom/Last name")
// with the value on the same line or the next one. Each field lists its
// labels WITHOUT diacritics (roRx adds them back).
const LABELS = {
  last_name: ['nume', 'nom', 'last name', 'surname'],
  first_names: ['prenume', 'prenom', 'first name', 'given names?'],
  nationality: ['cetatenie', 'nationalite', 'nationality'],
  place_of_birth: ['loc(?:ul)? na[sș]terii', 'loc na[sș]tere', 'lieu de naissance', 'place of birth', 'n[aă]scut(?:[aă])? [iî]n'],
  birth_date: ['data na[sș]terii', 'date de naissance', 'date of birth', 'n[aă]scut(?:[aă])? la(?: data)?'],
  gender: ['sex(?:ul)?', 'sexe'],
  address: ['domiciliu(?:l)?', 'adresse', 'address', 'domiciliat(?:[aă])? [iî]n'],
  issuing_authority: ['emis[aă] de', 'eliberat[aă]? de', 'delivree par', 'issued by', 'autoritatea', 'authority'],
  issue_date: ['data emiterii', 'data eliberarii', 'eliberat la', 'date de delivrance', 'date of issue'],
  expiry_date: ['data expirarii', 'valabil(?:[aă])? p[aâ]n[aă] la', 'date d.expiration', 'date of expiry', 'expiry'],
  validity: ['valabilitate', 'validite', 'validity'],
  father_name: ['tat[aă]l', 'numele tat[aă]lui'],
  mother_name: ['mama', 'numele mamei'],
  physical_description: ['semnalmente', 'semne particulare', 'descriere', '[iî]n[aă]l[tț]ime', 'talia'],
};
const LABEL_RX = Object.fromEntries(Object.entries(LABELS).map(([k, list]) => [
  k, roRx(`^\\s*(?:${list.join('|')})\\b\\.?\\s*(?:[/|]\\s*[^:/|]{2,30})*\\s*[:.\\-–]?\\s*(.*)$`),
]));
const ANY_LABEL = (line, except = null) => Object.entries(LABEL_RX).some(([k, rx]) => k !== except && rx.test(line));
function valueOf(lines, key, { multi = 1 } = {}) {
  const rx = LABEL_RX[key];
  for (let i = 0; i < lines.length; i += 1) {
    const m = rx.exec(lines[i]);
    if (!m) continue;
    // What is left on the label's own line (translations stripped), else the
    // next line(s) that are not themselves a label or the strip.
    const own = m[1].replace(/^(?:[/|]\s*[^/|]{2,30})+/, '').trim();
    if (own && !ANY_LABEL(own, key)) return own;
    const out = [];
    for (let j = i + 1; j < lines.length && out.length < multi; j += 1) {
      if (!lines[j].trim()) continue;
      if (ANY_LABEL(lines[j]) || isMrzLine(lines[j])) break;
      out.push(lines[j].trim());
    }
    if (out.length) return out.join(', ');
  }
  return '';
}
export function parseRoIdText(text) {
  const clean = commaBelow(String(text || ''));
  const lines = clean.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const printed = lines.filter((l) => !isMrzLine(l));
  const out = {};
  for (const k of ['last_name', 'first_names', 'nationality', 'place_of_birth', 'birth_date', 'gender', 'issuing_authority', 'issue_date', 'expiry_date', 'father_name', 'mother_name', 'physical_description']) {
    const v = valueOf(printed, k);
    if (v) out[k] = v;
  }
  const addr = valueOf(printed, 'address', { multi: 3 });
  if (addr) out.address = addr;
  // "Valabilitate 01.01.15-01.01.25" — issue, then expiry.
  const validity = valueOf(printed, 'validity');
  if (validity) {
    const ds = [...validity.matchAll(/\d{1,2}\s*[./]\s*\d{1,2}\s*[./]\s*\d{2,4}/g)].map((m) => m[0]);
    if (ds[0] && !out.issue_date) out.issue_date = ds[0];
    if (ds[1] && !out.expiry_date) out.expiry_date = ds[1];
  }
  // "SERIA RX NR 123456" / "Seria: RX Nr.: 123456" / "RX 123456".
  const sn = roRx('\\bseri(?:a|e)\\s*[:.]?\\s*([A-Z]{2}|[IVXLC]+|\\d{1,3})\\s*,?\\s*(?:nr|num[aă]r)\\.?\\s*[:.]?\\s*(\\d{6,7})\\b').exec(clean);
  if (sn) { out.document_series = sn[1].toUpperCase(); out.document_number = sn[2]; }
  const pass = roRx('\\b(?:pa[sș]aport|passport|passeport)[^\\n]{0,40}?\\b(?:nr|no|n°)\\.?\\s*[:.]?\\s*([A-Z0-9]{8,9})\\b').exec(clean);
  if (pass) out.passport_number = pass[1].toUpperCase();
  const cnp = findCnps(clean)[0];
  if (cnp) out.cnp = cnp;
  // Interwar / booklet back pages: "Viză de flotant" / "Viză de reședință".
  const viza = printed.filter((l) => roRx('\\bviz[aă]\\s+(?:de\\s+)?(?:flotant|re[sș]edin[tț][aă])').test(l));
  if (viza.length) out.viza_flotant = viza;
  // "Fiul lui Ion și al Mariei" (booklets).
  const parents = roRx('\\bfi(?:ul|ica)\\s+lui\\s+([A-ZĂÂÎȘȚ][\\p{L}-]+)\\s+[sș]i\\s+al(?:[aă])?\\s+([A-ZĂÂÎȘȚ][\\p{L}-]+)', 'iu').exec(clean);
  if (parents) { out.father_name = out.father_name || parents[1]; out.mother_name = out.mother_name || parents[2]; }
  return out;
}

// ── The normalised reading ─────────────────────────────────────────────
const s = (v, max = 300) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
// Given names, one per entry: split on spaces and commas; a hyphenated name
// ("Ana-Maria") is one name, as the civil register writes it.
const namesOf = (v) => (Array.isArray(v) ? v : s(v).split(/[\s,]+/)).map((x) => s(x)).filter(Boolean);
export const RO_ID_EMPTY = {
  document_type: '', document_series: '', document_number: '', passport_number: '', cnp: '',
  last_name: '', first_names: [], nationality: '', place_of_birth: '', gender: '', birth_date: '',
  issue_date: '', expiry_date: '', issuing_authority: '',
  address: { county: '', city: '', street: '', number: '', building: '', entrance: '', floor: '', apartment: '', raw: '' },
  parents_names: { father_name: '', mother_name: '' }, physical_description: '', viza_flotant: [],
};
// `ai` = the model's `ro_id` answer (or null); `text` = the OCR text.
// → the RO_ID_EMPTY shape, plus `cnp_info` (decodeCnp), `mrz` (checks),
//   `warnings` (every disagreement found) and `sources` (field → where it
//   came from: 'ai' | 'text' | 'cnp' | 'mrz').
export function normalizeRoId(ai, text = '') {
  const a = ai && typeof ai === 'object' ? ai : {};
  const local = parseRoIdText(text);
  // The strip: the local reader's, when its check digits hold; else the
  // AI's parse of it (lib/mrzAi), when given — an OCR that misread a
  // character leaves the local reading wrong or empty.
  const mrzLocal = parseMrz(text);
  const localOk = !!mrzLocal && mrzLocal.docOk && mrzLocal.birthOk && mrzLocal.expiryOk && mrzLocal.finalOk;
  const aiMrz = localOk ? null : normalizeMrzReading(a.mrz);
  const mrz = aiMrz ? null : mrzLocal;
  const out = JSON.parse(JSON.stringify(RO_ID_EMPTY));
  const sources = {};
  const warnings = [];
  const take = (key, ...cands) => {
    for (const [val, src] of cands) { const v = Array.isArray(val) ? val : s(val); if (v && v.length) { out[key] = v; sources[key] = src; return; } }
  };
  take('document_series', [a.document_series, 'ai'], [local.document_series, 'text']);
  take('document_number', [a.document_number, 'ai'], [local.document_number, 'text']);
  take('passport_number', [a.passport_number, 'ai'], [local.passport_number, 'text']);
  take('cnp', [s(a.cnp).replace(/\D/g, ''), 'ai'], [local.cnp, 'text']);
  take('last_name', [a.last_name, 'ai'], [local.last_name, 'text']);
  take('first_names', [namesOf(a.first_names), 'ai'], [namesOf(local.first_names), 'text']);
  take('nationality', [a.nationality, 'ai'], [local.nationality, 'text']);
  if (/\brou\b|roman|roumain/.test(fold(out.nationality))) out.nationality = 'ROU';
  take('place_of_birth', [a.place_of_birth, 'ai'], [local.place_of_birth, 'text']);
  take('issuing_authority', [a.issuing_authority, 'ai'], [local.issuing_authority, 'text']);
  take('physical_description', [a.physical_description, 'ai'], [local.physical_description, 'text']);
  out.gender = normalizeGender(a.gender) || normalizeGender(local.gender);
  if (out.gender) sources.gender = normalizeGender(a.gender) ? 'ai' : 'text';
  out.issue_date = normalizeDate(a.issue_date) || normalizeDate(local.issue_date);
  out.expiry_date = normalizeDate(a.expiry_date, { future: true }) || normalizeDate(local.expiry_date, { future: true });
  const birth = dateParts(a.birth_date) || dateParts(local.birth_date);
  out.birth_date = toIsoDate(birth);
  // The address: the model's parts, else parsed out of the printed line.
  const rawAddr = s(typeof a.address === 'string' ? a.address : a.address?.raw, 400) || s(local.address, 400);
  const parsedAddr = parseAddress(rawAddr);
  const aiAddr = a.address && typeof a.address === 'object' ? a.address : {};
  for (const k of Object.keys(out.address)) out.address[k] = s(aiAddr[k]) || parsedAddr[k] || '';
  out.address.raw = rawAddr;
  out.parents_names.father_name = s(a.parents_names?.father_name || a.father_name) || s(local.father_name);
  out.parents_names.mother_name = s(a.parents_names?.mother_name || a.mother_name) || s(local.mother_name);
  out.viza_flotant = [...new Set([...(Array.isArray(a.viza_flotant) ? a.viza_flotant : []), ...(local.viza_flotant || [])].map((x) => s(typeof x === 'string' ? x : x?.address || JSON.stringify(x), 400)).filter(Boolean))];

  // The machine-readable strip: fills what is missing, contradicts what differs.
  if (mrz) {
    const both = (key, val, label) => {
      if (!val) return;
      if (!out[key]) { out[key] = val; sources[key] = 'mrz'; return; }
      if (fold(out[key]).replace(/[^a-z0-9]/g, '') !== fold(val).replace(/[^a-z0-9]/g, '')) warnings.push(`${label}: the document says “${out[key]}”, its machine-readable strip “${val}”.`);
    };
    if (mrz.format === 'TD3') both('passport_number', mrz.docNumber, 'Passport number');
    else if (/^[A-Z]{2}\d{6}$/.test(mrz.docNumber)) {
      both('document_series', mrz.docNumber.slice(0, 2), 'Series');
      both('document_number', mrz.docNumber.slice(2), 'Number');
    }
    both('last_name', mrz.surname, 'Surname');
    if (!out.first_names.length && mrz.given) { out.first_names = mrz.given.split(' ').filter(Boolean); sources.first_names = 'mrz'; }
    if (mrz.birth) {
      if (!out.birth_date) { out.birth_date = mrz.birth; sources.birth_date = 'mrz'; } else if (out.birth_date !== mrz.birth) warnings.push(`Birth date: the document says ${isoToRo(out.birth_date)}, its strip ${isoToRo(mrz.birth)}.`);
    }
    if (mrz.expiry) {
      const ro = isoToRo(mrz.expiry);
      if (!out.expiry_date) { out.expiry_date = ro; sources.expiry_date = 'mrz'; } else if (out.expiry_date !== ro) warnings.push(`Expiry: the document says ${out.expiry_date}, its strip ${ro}.`);
    }
    const g = normalizeGender(mrz.sex);
    if (g) { if (!out.gender) { out.gender = g; sources.gender = 'mrz'; } else if (out.gender !== g) warnings.push(`Sex: the document says ${out.gender}, its strip ${g}.`); }
    if (!out.nationality && mrz.nationality) { out.nationality = mrz.nationality.replace(/</g, ''); sources.nationality = 'mrz'; }
    if (mrz.nationality && out.nationality && mrz.nationality !== out.nationality) warnings.push(`Nationality: the document says ${out.nationality}, its strip ${mrz.nationality}.`);
    for (const [ok, what] of [[mrz.docOk, 'document number'], [mrz.birthOk, 'birth date'], [mrz.expiryOk, 'expiry date'], [mrz.finalOk, 'overall']]) {
      if (!ok) warnings.push(`The strip's ${what} check digit fails — misread by the OCR, or not a genuine strip.`);
    }
  }

  if (aiMrz) {
    const differs = (x, y) => fold(x).replace(/[^a-z0-9]/g, '') !== fold(y).replace(/[^a-z0-9]/g, '');
    if (aiMrz.last_name) { if (!out.last_name) { out.last_name = aiMrz.last_name; sources.last_name = 'mrz-ai'; } else if (differs(out.last_name, aiMrz.last_name)) warnings.push(`Surname: the document says “${out.last_name}”, its machine-readable strip “${aiMrz.last_name}”.`); }
    if (!out.first_names.length && aiMrz.first_names.length) { out.first_names = aiMrz.first_names; sources.first_names = 'mrz-ai'; }
    if (aiMrz.birth) { if (!out.birth_date) { out.birth_date = aiMrz.birth; sources.birth_date = 'mrz-ai'; } else if (out.birth_date !== aiMrz.birth) warnings.push(`Birth date: the document says ${isoToRo(out.birth_date)}, its strip ${isoToRo(aiMrz.birth)}.`); }
    if (aiMrz.expiry) { const ro = isoToRo(aiMrz.expiry); if (!out.expiry_date) { out.expiry_date = ro; sources.expiry_date = 'mrz-ai'; } else if (out.expiry_date !== ro) warnings.push(`Expiry: the document says ${out.expiry_date}, its strip ${ro}.`); }
    if (aiMrz.sex) { if (!out.gender) { out.gender = aiMrz.sex; sources.gender = 'mrz-ai'; } else if (out.gender !== aiMrz.sex) warnings.push(`Sex: the document says ${out.gender}, its strip ${aiMrz.sex}.`); }
    if (!out.nationality && aiMrz.nationality) { out.nationality = aiMrz.nationality; sources.nationality = 'mrz-ai'; }
    warnings.push('The machine-readable strip was read by the AI — its check digits could not be verified (the OCR misread part of it).');
  }

  // The CNP: fills the birth date and the sex, and contradicts them when they differ.
  const info = out.cnp ? decodeCnp(out.cnp) : null;
  if (info) {
    info.problems.forEach((p) => warnings.push(`CNP: ${p}.`));
    if (info.birth_date) {
      if (!out.birth_date) { out.birth_date = info.birth_date; sources.birth_date = 'cnp'; } else if (out.birth_date !== info.birth_date && !info.century_inferred) warnings.push(`Birth date: the document says ${isoToRo(out.birth_date)}, the CNP ${isoToRo(info.birth_date)}.`);
    }
    if (info.gender) {
      if (!out.gender) { out.gender = info.gender; sources.gender = 'cnp'; } else if (out.gender !== info.gender) warnings.push(`Sex: the document says ${out.gender}, the CNP ${info.gender}.`);
    }
    // The older card carries the CNP's first digit and last six in its strip.
    if (mrz?.format === 'TD2' && /^\d{7}$/.test(mrz.optional || '') && mrz.optional !== out.cnp[0] + out.cnp.slice(7)) warnings.push('CNP: the digits in the strip are not the printed CNP’s.');
  }

  // The kind of document: the model's word, else the text's.
  out.document_type = normalizeDocType(a.document_type) || docTypeFromText(text, mrzLocal) || (out.passport_number ? 'PASAPORT' : out.document_series ? 'CI' : '');
  if (out.document_type === 'PASAPORT' && !out.passport_number && out.document_number) { out.passport_number = out.document_number; out.document_number = ''; }
  if (out.passport_number && !/^[A-Z0-9]{8,9}$/.test(out.passport_number)) warnings.push(`Passport number “${out.passport_number}” is not 8–9 letters and digits.`);
  if ((out.document_type === 'CI' || out.document_type === 'CEI' || out.document_type === 'CIP') && out.document_series && !/^[A-Z]{2}$/.test(out.document_series)) warnings.push(`Series “${out.document_series}” is not two letters.`);
  if (out.document_number && !/^\d{6,7}$/.test(out.document_number)) warnings.push(`Number “${out.document_number}” is not 6–7 digits.`);
  if (out.document_type === 'BI_CEAUSESCU' && !out.cnp) {
    const issued = dateParts(out.issue_date);
    if (!issued || issued.y >= 1978) warnings.push('No CNP read — a buletin issued from 1978 on carries one (often handwritten or stamped).');
  }
  if (['CI', 'CEI', 'CIP', 'PASAPORT'].includes(out.document_type) && !out.cnp && out.document_type !== 'PASAPORT') warnings.push('No CNP read on the card.');
  if (out.document_type === 'CEI' && !out.address.raw) sources.address = 'absent-on-front';
  const exp = dateParts(out.expiry_date, { future: true });
  const expired = exp ? toIsoDate(exp) < new Date().toISOString().slice(0, 10) : null;
  return { ...out, cnp_info: info, mrz: mrz ? { format: mrz.format, lines: mrz.lines, ok: mrz.docOk && mrz.birthOk && mrz.expiryOk && mrz.finalOk } : aiMrz ? { format: 'ai', lines: [], ok: null, reading: aiMrz } : null, expired, warnings, sources };
}

// The reading as an identity record's keys (lib/identities) — for autofill
// and the scan's person collections.
export function roIdToRecordFields(r) {
  if (!r) return {};
  const idType = { CEI: 'CEI', CI: 'CI', CIP: 'CIP', PASAPORT: 'pașaport simplu', PERMIS_SEDERE: 'permis de ședere' }[r.document_type] || '';
  const first = r.first_names.join(' ');
  const fields = {
    lastName: r.last_name, firstName: first, legalName: [r.last_name, first].filter(Boolean).join(' '),
    nationalId: r.cnp, dateOfBirth: isoToRo(r.birth_date), placeOfBirth: r.place_of_birth,
    nationality: r.nationality, gender: r.gender === 'M' ? 'male' : r.gender === 'F' ? 'female' : '',
    idType, idSeries: r.document_type === 'PASAPORT' ? '' : r.document_series,
    idNumber: r.document_type === 'PASAPORT' ? r.passport_number : r.document_number,
    idIssuer: r.issuing_authority, idIssuedAt: r.issue_date,
    address: r.address.raw, city: r.address.city, county: r.address.county,
    country: r.nationality === 'ROU' ? 'România' : '',
  };
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v));
}

// ── The machine-readable zone, read by the AI ───────────────────────────
// parseMrz reads the strip locally and checks every digit — but an OCR that
// misread one "<" or one letter leaves it with nothing. Then the AI parses
// the strip, by these rules (a parser prompt, JSON out only). What it reads
// is used to FILL gaps and compared with the printed side; it is never
// trusted over a strip that passed its check digits.
const YY_NOW = new Date().getFullYear() % 100;
const MRZ_SCHEMA = '{ "last_name": "STRING", "first_names": "STRING", "date_of_birth": "YYYY-MM-DD", "gender": "M" | "F", "expiration_date": "YYYY-MM-DD", "nationality": "ROU" }';
const MRZ_RULES = [
  '1. Last name & first names: the name field is SURNAME<<GIVEN<NAMES — the last name before "<<", then the first names separated by "<" (written with spaces).',
  '2. Gender: the M (male) or F (female) character immediately after the date of birth and its check digit.',
  `3. Date of birth: YYMMDD (the 6 digits before the gender character, its check digit between), as YYYY-MM-DD; YY from 00 to ${String(YY_NOW).padStart(2, '0')} is 20YY, otherwise 19YY.`,
  '4. Expiration date: YYMMDD (the 6 digits after the gender character), as YYYY-MM-DD, always 20YY.',
  '5. Nationality & issuing state: "ROU" stands for Romania.',
];
export const MRZ_PROMPT = [
  'You are a specialized parser component designed to process Machine Readable Zone (MRZ) strings from Romanian identity documents.',
  'Your task is to extract raw data from the provided MRZ text and return it EXCLUSIVELY as a valid JSON object. Do not include any conversational text, markdown formatting blocks (like ```json), or explanations.',
  '### Parsing Rules:',
  ...MRZ_RULES,
  '### Required JSON Schema:',
  MRZ_SCHEMA,
  'If the input holds no machine-readable zone, output null. Analyze the input string and output only the completed JSON object.',
].join('\n');

const isoOk = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !Number.isNaN(Date.parse(v)) ? String(v) : '');
// The AI's answer made safe: { last_name, first_names: [], birth, sex, expiry, nationality } or null.
export function normalizeMrzReading(m) {
  if (!m || typeof m !== 'object') return null;
  const up = (v) => s(v).replace(/</g, ' ').replace(/\s+/g, ' ').trim().toUpperCase();
  const out = {
    last_name: up(m.last_name),
    first_names: up(Array.isArray(m.first_names) ? m.first_names.join(' ') : m.first_names).split(' ').filter(Boolean),
    birth: isoOk(m.date_of_birth),
    sex: /^[MF]$/i.test(s(m.gender)) ? s(m.gender).toUpperCase() : '',
    expiry: isoOk(m.expiration_date),
    nationality: /^[A-Z]{3}$/i.test(s(m.nationality)) ? s(m.nationality).toUpperCase() : '',
  };
  return out.last_name || out.birth || out.expiry ? out : null;
}
// Does the text carry strip-like lines (two or more)?
export function hasMrzLines(text) {
  return String(text || '').split(/\r?\n/).filter(isMrzLine).length >= 2;
}

// The part of an autofill prompt that asks for this reading.
export const RO_ID_PROMPT = [
  '- ro_id: the SAME document read into this normalised shape (all keys, "" / [] when not stated):',
  '    { "document_type": "CEI | CI | CIP | PASAPORT | BI_CEAUSESCU | BI_INTERBELIC | PERMIS_SEDERE | OTHER",',
  '      "document_series": "", "document_number": "", "passport_number": "", "cnp": "", "last_name": "", "first_names": [],',
  '      "nationality": "", "place_of_birth": "", "gender": "M | F", "birth_date": "", "issue_date": "", "expiry_date": "",',
  '      "issuing_authority": "", "address": { "county": "", "city": "", "street": "", "number": "", "building": "", "entrance": "", "floor": "", "apartment": "", "raw": "" },',
  '      "parents_names": { "father_name": "", "mother_name": "" }, "physical_description": "", "viza_flotant": [] }',
  '    document_type: CEI = the electronic card (Carte electronică de identitate, 3-line strip); CI = the plastic card (1997 on, 2-line strip); CIP = provisional;',
  '    PASAPORT = passport; BI_CEAUSESCU = the buletin de identitate booklet (1949–1997; a CNP only from 1978, often handwritten or stamped); BI_INTERBELIC = any identity paper before 1949.',
  '    document_series is the 2 letters (older booklets: digits or Roman numerals), document_number the 6–7 digits; passport_number the passport\'s own number (8–9 characters).',
  '    first_names: one entry per given name; a hyphenated name ("Ana-Maria") is ONE entry. gender from Sex / M / F / Bărbătesc / Femeiesc.',
  '    Dates as DD.MM.YYYY. "Valabilitate 01.01.15-01.01.25" is issue_date 01.01.2015 and expiry_date 01.01.2025.',
  '    The newer CEI prints no address and sometimes no place of birth on its front: leave them "" — never guess them.',
  '    parents_names, physical_description (height, eyes, marks — interwar papers) and viza_flotant (each temporary address stamped on the back pages) only for booklets and old papers.',
  '    Also add "mrz": the MACHINE-READABLE ZONE (the lines of capitals and "<" at the foot of the card / passport page) parsed on its own, or null when there is none:',
  `    ${MRZ_SCHEMA}`,
  ...MRZ_RULES.map((r) => `    ${r}`),
].join('\n');

// ── Are two addresses the same? ─────────────────────────────────────────
// Every file, firm and person writes an address its own way: "Strada STR.
// RASCOALEI 1907, nr. 59, bloc -, scara -, etaj -, ap. -, CONSTANTA,
// CONSTANTA" and "Jud.CT Mun.Constanța, Str.1907 nr.59" are one address. So
// they are compared by their PARTS (parseAddress), each part only when BOTH
// give it (a blank "-" is no value): the number, block, entrance, floor and
// apartment must be equal; the county and the locality must name the same
// place (a county's code is its name — CT is Constanța —, "Mun." and the like
// dropped, one may be the fuller form of the other); the street must share
// its name (the shorter one's words inside the longer: "1907" in "Răscoalei
// 1907" — street types and markers left out). What neither side structures
// is compared word for word, leniently.
const plainFold = (v) => fold(v).replace(/[^a-z0-9]+/g, ' ').trim();
const noValue = (v) => { const t = String(v || '').trim(); return !t || /^[-–.\s]+$/.test(t); };
const STREET_TYPES = new Set(['str', 'strada', 'bd', 'bdul', 'b', 'dul', 'bulevardul', 'calea', 'cal', 'sos', 'soseaua', 'al', 'aleea', 'piata', 'pta', 'intr', 'intrarea', 'spl', 'splaiul']);
const PLACE_WORDS = /\b(municipiul|mun|orasul|oras|or|comuna|com|satul|sat|localitatea|loc|judetul|judet|jud)\b/g;
const place = (v) => plainFold(countyName(v)).replace(PLACE_WORDS, ' ').replace(/\s+/g, ' ').trim();
const samePlace = (a, b) => !!a && !!b && (a === b || a.includes(b) || b.includes(a));
export function sameAddress(a, b) {
  const x = parseAddress(a); const y = parseAddress(b);
  for (const k of ['number', 'building', 'entrance', 'floor', 'apartment']) {
    if (noValue(x[k]) || noValue(y[k])) continue;
    if (plainFold(x[k]).replace(/\s/g, '') !== plainFold(y[k]).replace(/\s/g, '')) return false;
  }
  for (const k of ['county', 'city']) {
    const p = place(x[k]); const q = place(y[k]);
    if (p && q && !samePlace(p, q)) {
      // One file's locality may be the other's county ("Constanța, Constanța").
      const other = k === 'city' ? 'county' : 'city';
      if (!samePlace(p, place(y[other])) && !samePlace(q, place(x[other]))) return false;
    }
  }
  const words = (v) => new Set(plainFold(v).split(' ').filter((w) => w && !STREET_TYPES.has(w)));
  const s1 = words(x.street); const s2 = words(y.street);
  if (s1.size && s2.size) {
    const [small, big] = s1.size <= s2.size ? [s1, s2] : [s2, s1];
    let common = 0;
    for (const w of small) if (big.has(w)) common += 1;
    if (common / small.size < 0.5) return false;
  }
  const structured = (v) => !!(v.street || v.number);
  if (structured(x) && structured(y)) return true;
  // Little to go on: the words, leniently.
  const bag = (v) => new Set(plainFold(countyName(v)).split(' ').filter((w) => w.length > 1 && !STREET_TYPES.has(w) && !/^(nr|numar|bl|bloc|sc|scara|et|etaj|ap|jud|judet|mun|municipiul|oras|com|comuna|sat|loc|sector|sectorul|romania)$/.test(w)));
  const A = bag(a); const B = bag(b);
  if (!A.size || !B.size) return true;
  let common = 0;
  for (const w of A) if (B.has(w)) common += 1;
  return common / Math.min(A.size, B.size) >= 0.6;
}

// ── One fuller address out of several spellings of it ──────────────────
// Files that write the SAME address differently each carry part of it — one
// the street's full name, another the county, a third the apartment. Merged,
// every part is taken from whichever file gives it best: a value over a blank,
// the fuller street name ("Răscoalei 1907" over "1907"), the spelling WITH
// diacritics ("Constanța" over "CONSTANTA"), a county's name over its code;
// ALL-CAPS words are written in ordinary case. Written the Romanian way:
// "Str. Răscoalei 1907 nr. 59, bl. A2, sc. 1, et. 3, ap. 12, Constanța, Jud. Constanța".
const STREET_LABEL = {
  str: 'Str.', strada: 'Str.', bd: 'Bd.', bdul: 'Bd.', 'b-dul': 'Bd.', bulevardul: 'Bd.', calea: 'Calea', cal: 'Calea',
  sos: 'Șos.', soseaua: 'Șos.', al: 'Al.', aleea: 'Al.', piata: 'Piața', pta: 'Piața', intr: 'Intr.', intrarea: 'Intr.', spl: 'Spl.', splaiul: 'Spl.',
};
const hasMarks = (v) => /[ăâîșțşţ]/i.test(String(v || ''));
const niceCase = (v) => String(v || '').split(/(\s+|-)/).map((w) => (/^[A-ZĂÂÎȘȚŞŢ]{2,}$/.test(w) ? w.charAt(0) + w.slice(1).toLowerCase() : w)).join('');
// The better of two spellings of one thing: more words, then diacritics.
function better(a, b) {
  if (noValue(a)) return b;
  if (noValue(b)) return a;
  const wa = plainFold(a).split(' ').filter(Boolean).length;
  const wb = plainFold(b).split(' ').filter(Boolean).length;
  if (wa !== wb) return wa > wb ? a : b;
  if (hasMarks(a) !== hasMarks(b)) return hasMarks(a) ? a : b;
  return String(a).length >= String(b).length ? a : b;
}
// A street as { type label, name } — "Strada STR. RASCOALEI 1907" → Str. / RASCOALEI 1907.
function splitStreet(v) {
  // The type word(s) at the front, however glued on ("Strada STR. X",
  // "Str.1907", "B-dul.Unirii").
  let rest = String(v || '').trim();
  let label = '';
  for (let i = 0; i < 4; i += 1) {
    const m = /^([\p{L}-]+)\.?\s*/u.exec(rest);
    const w = m ? fold(m[1]) : '';
    if (!m || !STREET_LABEL[w] || !rest.slice(m[0].length).trim()) break;
    label = label || STREET_LABEL[w];
    rest = rest.slice(m[0].length);
  }
  return { label: label || 'Str.', name: rest.trim() };
}
// `values` = strings, or { value, authority } (lib/docAuthority's score): the
// MORE OFFICIAL source wins where two sources really disagree on a part (a
// different block, another spelling of the locality); a fuller form of the
// SAME part ("Răscoalei 1907" for "1907") still completes it from any source.
export function mergeAddresses(values) {
  const items = (values || []).map((v) => (typeof v === 'string' ? { value: v, authority: 0 } : { value: v?.value, authority: Number(v?.authority) || 0 }))
    .filter((v) => !noValue(v.value))
    .sort((a, b) => b.authority - a.authority);
  const list = items.map((v) => v.value);
  if (list.length <= 1) return list[0] || '';
  const parts = list.map(parseAddress);
  // Most official first: the first value stands unless a later one is the
  // same thing written more fully (its words include all of the first's).
  const within = (a, b) => { const A = plainFold(a).split(' ').filter(Boolean); const B = new Set(plainFold(b).split(' ')); return A.length > 0 && A.every((w) => B.has(w)); };
  const pick = (k) => parts.map((x) => x[k]).reduce((a, b) => {
    if (noValue(a)) return b;
    if (noValue(b)) return a;
    return within(a, b) ? better(a, b) : a;
  }, '');
  const streets = parts.map((x) => splitStreet(x.street)).filter((x) => x.name);
  const street = streets.reduce((a, b) => {
    if (!a.name) return b;
    return within(a.name, b.name) ? (better(a.name, b.name) === a.name ? a : b) : a;
  }, { label: 'Str.', name: '' });
  const number = pick('number'); const building = pick('building'); const entrance = pick('entrance');
  const floor = pick('floor'); const apartment = pick('apartment');
  // A county written as its code gives way to its name.
  const county = parts.map((x) => countyName(x.county)).reduce((a, b) => (noValue(a) ? b : noValue(b) ? a : samePlace(place(a), place(b)) ? better(a, b) : a), '');
  const city = pick('city');
  const line = [
    street.name ? `${street.label} ${niceCase(street.name)}${noValue(number) ? '' : ` nr. ${number}`}` : (noValue(number) ? '' : `nr. ${number}`),
    noValue(building) ? '' : `bl. ${niceCase(building)}`,
    noValue(entrance) ? '' : `sc. ${niceCase(entrance)}`,
    noValue(floor) ? '' : `et. ${floor}`,
    noValue(apartment) ? '' : `ap. ${apartment}`,
    city ? niceCase(city) : '',
    county && !/^bucure/i.test(fold(county)) ? `Jud. ${niceCase(county)}` : '',
  ].filter(Boolean);
  // Nothing the parser could place: the fullest spelling as written.
  return line.length >= 2 ? line.join(', ') : list.reduce((a, b) => better(a, b));
}
