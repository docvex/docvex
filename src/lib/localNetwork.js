// The neural network WITHOUT AI — how the Files tab's scan understands each
// file, cross-references the files and groups them into Data collections,
// on this computer, with no model and no tokens.
//
// Nothing here guesses: every name, identifier, date and amount is read off
// the file's own text by the app's detectors —
//   lib/pseudonymize/detectorLayer1  CNP, CUI, IBAN, CI series + number,
//                                    phone, e-mail, address (strict shapes,
//                                    check digits)
//   lib/pseudonymize/detectorLayer3  people and companies named by the words
//                                    that introduce them in Romanian prose
//   lib/roIdDocuments                identity documents (labels, MRZ, CNP)
//   lib/lawRefs                      citations of law
// and the links between files are the identifiers, names, document numbers
// and amounts they share. The shapes are the ones the AI used to answer
// (`understanding`, typed links, collections), so everything that reads the
// network — the graph, the collections, Insights, autofill — is unchanged.
import { detectLayer1 } from './pseudonymize/detectorLayer1';
import { detectLayer3 } from './pseudonymize/detectorLayer3';
import { normalizeDate, normalizeRoId } from './roIdDocuments';
import { findLawRefs } from './lawRefs';

const MAX_TEXT = 60000;
const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const clip = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const uniq = (list) => [...new Set(list)];

// A name as it can be compared (same rule as dataCollections' foldName: no
// diacritics, case, punctuation, legal form, titles; words sorted).
const STOP = new Set(['sc', 'srl', 'sa', 'sca', 'snc', 'pfa', 'ii', 'if', 'ong', 'sl', 'd', 'dl', 'dna', 'dra', 'domnul', 'doamna', 'the', 'ltd', 'llc', 'inc', 'gmbh']);
export const nameKey = (name) => fold(name)
  .replace(/s\.\s*r\.\s*l\.?|s\.\s*a\.(?=\s|$)|s\.\s*c\.(?=\s|$)/g, ' ')
  .replace(/[^a-z0-9]+/g, ' ').split(' ').filter((w) => w && !STOP.has(w)).sort().join(' ');

// Title Case for a name found in capitals ("POPESCU ION" → "Popescu Ion").
const tidyName = (s) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  if (t !== t.toUpperCase()) return t;
  return t.split(' ').map((w) => (/^(?:S\.?R\.?L|S\.?A|SC|PFA|II|IF|SNC)\.?-?D?\.?$/i.test(w) ? w : w.toLowerCase().replace(/(^|-)(\p{L})/gu, (m, a, b) => a + b.toUpperCase()))).join(' ');
};

// ── What kind of document ───────────────────────────────────────────────
// First match wins; read against the file name and the start of its text.
const DOC_TYPES = [
  [/carte(a)? (electronica )?de identitate|\bbuletin(ul)? de identitate|romania\s+roumanie|identity card/, 'Carte de identitate'],
  [/pasaport|passport/, 'Pașaport'],
  [/permis(ul)? de conducere|driving licen/, 'Permis de conducere'],
  [/permis(ul)? de sedere|residence permit/, 'Permis de ședere'],
  [/certificat(ul)? de (nastere|casatorie|deces)/, 'Certificat de stare civilă'],
  [/certificat(ul)? de mostenitor/, 'Certificat de moștenitor'],
  [/certificat(ul)? constatator|furnizare (de )?informatii|registrul comertului/, 'Certificat constatator (ONRC)'],
  [/certificat(ul)? de inregistrare/, 'Certificat de înregistrare'],
  [/extras (de )?(de )?carte funciara|extras cf\b|carte(a)? funciara/, 'Extras de carte funciară'],
  [/act(ul)? aditional|addendum/, 'Act adițional'],
  [/contract(ul)? de vanzare|vanzare.?cumparare/, 'Contract de vânzare-cumpărare'],
  [/contract(ul)? de (inchiriere|locatiune)/, 'Contract de închiriere'],
  [/contract(ul)? (individual )?de munca/, 'Contract de muncă'],
  [/contract(ul)? de (imprumut|credit)/, 'Contract de împrumut'],
  [/contract(ul)? de (prestari|servicii)/, 'Contract de prestări servicii'],
  [/contract(ul)? de donatie/, 'Contract de donație'],
  [/contract(ul)? de mandat|procura|imputernicire/, 'Procură / împuternicire'],
  [/\bcontract/, 'Contract'],
  [/factura|invoice/, 'Factură'],
  [/chitanta|receipt/, 'Chitanță'],
  [/ordin de plata|extras de cont|bank statement/, 'Document bancar'],
  [/proces.?verbal/, 'Proces-verbal'],
  [/sentinta|hotararea|decizia (civila|penala)|incheierea/, 'Hotărâre judecătorească'],
  [/cerere de chemare in judecata|cerere de (apel|recurs)|\bcerere\b/, 'Cerere'],
  [/intampinare/, 'Întâmpinare'],
  [/notificare|somatie|punere in intarziere/, 'Notificare'],
  [/declaratie|declaration/, 'Declarație'],
  [/adeverinta/, 'Adeverință'],
  [/testament/, 'Testament'],
  [/statut(ul)?|act(ul)? constitutiv/, 'Act constitutiv'],
  [/^from:|^de la:|\bsubject:|\bsubiect:/m, 'E-mail'],
];
const ID_TYPES = new Set(['Carte de identitate', 'Pașaport', 'Permis de conducere', 'Permis de ședere']);
const MONEY_TYPES = new Set(['Factură', 'Chitanță', 'Document bancar']);

// Themes — the file's subject matter, for the collections' "about".
const THEMES = [
  [/imobil|apartament|teren|casa |constructi|carte funciara|cadastr/, 'property'],
  [/autoturism|autovehicul|vehicul|numar de inmatriculare|serie sasiu|\bvin\b/, 'vehicle'],
  [/mostenire|succesiune|mostenitor|defunct/, 'inheritance'],
  [/chirie|inchiriere|locatar|locator/, 'lease'],
  [/salariu|angajat|angajator|contract de munca/, 'employment'],
  [/imprumut|credit|datorie|debit|restanta|executare silita/, 'debt'],
  [/factura|plata|achitat|transfer bancar|pret/, 'payment'],
  [/instanta|tribunal|judecatori|dosar|reclamant|parat/, 'litigation'],
  [/societate|asociat|administrator|registrul comertului|capital social/, 'company'],
  [/carte de identitate|pasaport|cnp/, 'identity'],
];

const DATE_RE = /(?<!\d)(\d{1,2})\s*[./-]\s*(\d{1,2})\s*[./-]\s*(\d{4})(?!\d)|(?<!\d)(\d{1,2})\s+(ianuarie|februarie|martie|aprilie|mai|iunie|iulie|august|septembrie|octombrie|noiembrie|decembrie|ian|feb|mar|apr|iun|iul|aug|sept?|oct|noi|nov|dec)\.?\s+(\d{4})(?!\d)/giu;
const AMOUNT_RE = /(?<![\d.,])\d{1,3}(?:[.\s]\d{3})*(?:,\d{1,2})?\s*(?:lei|ron|eur|euro|usd|\$|€)(?!\p{L})/giu;
const REGNO_RE = /\b([JFC])\s?(\d{1,2})\s?\/\s?(\d{1,7})\s?\/\s?(\d{4})\b/g;
const CAD_RE = /(?:nr\.?\s*cadastral|num[aă]r(?:ul)?\s+cadastral|cadastral\s+nr\.?)\s*:?\s*(\d{3,9}(?:-C\d+(?:-U\d+)?)?)/giu;
const CF_RE = /(?:carte(?:a)?\s+funciar[aă]|\bC\.?F\.?)\s*(?:nr\.?)?\s*:?\s*(\d{3,9})/giu;
const PLATE_RE = /\b(B\s?-?\s?\d{2,3}|(?:AB|AG|AR|BC|BH|BN|BR|BT|BV|BZ|CJ|CL|CS|CT|CV|DB|DJ|GJ|GL|GR|HD|HR|IF|IL|IS|MH|MM|MS|NT|OT|PH|SB|SJ|SM|SV|TL|TM|TR|VL|VN|VS)\s?-?\s?\d{2})\s?-?\s?([A-Z]{3})\b/g;
// "nr. 123/12.03.2020", "nr. 45 din 12.03.2020", "Contract nr. 78" — a
// document's own number, and every number a text cites.
const DOCNO_RE = /\bnr\.?\s*(\d{1,6}(?:\/\d{1,4}(?:[./]\d{1,2}[./]\d{2,4})?)?)(?:\s+din\s+(\d{1,2}[./]\d{1,2}[./]\d{4}))?/giu;

const ROLE_WORDS = 'v[âa]nz[ăa]tor|cump[ăa]r[ăa]tor|locator|locatar|chiria[șs]|proprietar|p[âa]r[âa]t|reclamant|intimat|apelant|recurent|creditor|debitor|mandant|mandatar|donator|donatar|angajator|salariat|beneficiar|prestator|furnizor|client|asociat|administrator|mo[șs]tenitor|defunct|[îi]mprumut[ăa]tor|[îi]mprumutat|garant|martor|petent';
const ROLE_AFTER = new RegExp(`(?:[îi]n\\s+calitate\\s+de|denumit[ăa]?\\s+[îi]n\\s+continuare|numit[ăa]?\\s+[îi]n\\s+continuare)\\s*[„"«]?\\s*(${ROLE_WORDS})`, 'iu');
const ROLE_BEFORE = new RegExp(`(${ROLE_WORDS})(?:ul|a|ului|ei)?\\s*:?\\s*$`, 'iu');

// The sentence (or line) around a position — a date's "event".
function sentenceAt(text, at) {
  let a = at; let b = at;
  while (a > 0 && at - a < 160 && !/[.\n;]/.test(text[a - 1])) a -= 1;
  while (b < text.length && b - at < 200 && !/[\n;]/.test(text[b]) && !(text[b] === '.' && /\s/.test(text[b + 1] || ' ') && !/\d/.test(text[b - 1] || ''))) b += 1;
  return clip(text.slice(a, b), 240);
}

function roleNear(text, start, end) {
  const before = text.slice(Math.max(0, start - 40), start);
  const rb = ROLE_BEFORE.exec(before);
  if (rb) return rb[1].toLowerCase();
  const ra = ROLE_AFTER.exec(text.slice(end, end + 320));
  return ra ? ra[1].toLowerCase() : '';
}

/**
 * Understand one file from its text — locally.
 * → the `understanding` shape (text, subject, documentType, facts, entities,
 *   parties, dates, themes, idDocument) + `numbers` (the document numbers it
 *   states or cites) and `amounts`.
 */
export function understandLocally(rawText, { name = '', method = 'text' } = {}) {
  const text = String(rawText || '').slice(0, MAX_TEXT);
  const head = fold(`${name}\n${text.slice(0, 900)}`);
  const whole = fold(text);
  const documentType = (DOC_TYPES.find(([re]) => re.test(head)) || DOC_TYPES.find(([re]) => re.test(whole.slice(0, 4000))) || [null, ''])[1]
    || (method === 'captions' ? 'Înregistrare' : method === 'image-text' ? 'Imagine' : 'Document');

  let l1 = []; let l3 = [];
  try { l1 = detectLayer1(text); } catch { /* none */ }
  try { l3 = detectLayer3(text); } catch { /* none */ }

  // People and companies, each with the identifiers that follow its name.
  const parties = [];
  const byKey = new Map();
  const partyFor = (value, kind, span) => {
    const key = nameKey(value);
    if (key.length < 3) return null;
    let p = byKey.get(key);
    if (!p) {
      p = { name: tidyName(value), kind, role: '', identifiers: [], _at: span.start, _details: {} };
      byKey.set(key, p);
      parties.push(p);
    }
    if (!p.role) p.role = roleNear(text, span.start, span.end);
    return p;
  };
  const named = l3.map((s) => ({ s, p: partyFor(s.value, s.type === 'FIRMA' ? 'company' : 'person', s) })).filter((x) => x.p);

  // An identity document: its holder, read by the ID reader.
  let idDocument = null;
  let roId = null;
  if (ID_TYPES.has(documentType)) {
    try { roId = normalizeRoId(null, text); } catch { roId = null; }
    const holder = [roId?.last_name, ...(roId?.first_names || [])].filter(Boolean).join(' ');
    if (holder) {
      idDocument = { holder: tidyName(holder), type: documentType };
      const p = partyFor(holder, 'person', { start: 0, end: 0 });
      if (p) {
        p.role = p.role || 'titular';
        if (roId.cnp) p.identifiers.push(`CNP ${roId.cnp}`);
        if (roId.document_series && roId.document_number) p.identifiers.push(`CI ${roId.document_series} ${roId.document_number}`);
      }
    }
  }

  // Each identifier goes to the nearest name before it (≤ 400 characters),
  // people taking CNP / CI / phone / e-mail, companies CUI / IBAN / reg. no.
  const owner = (at, kinds) => {
    let best = null;
    for (const { s, p } of named) {
      if (!kinds.includes(p.kind) || s.start > at || at - s.end > 400) continue;
      if (!best || s.start > best.s.start) best = { s, p };
    }
    return best?.p || null;
  };
  const facts = [];
  const fact = (label, value) => { const v = clip(value, 400); if (v && !facts.some((f) => f.label === label && f.value === v)) facts.push({ label, value: v }); };
  const LABEL = { CNP: 'CNP', CUI: 'CUI', IBAN: 'IBAN', CI: 'Act de identitate', TEL: 'Telefon', EMAIL: 'E-mail', ADRESA: 'Adresă' };
  for (const s of l1) {
    if (s.type === 'MRZ') continue;
    const personal = ['CNP', 'CI', 'TEL', 'EMAIL'].includes(s.type);
    const p = owner(s.start, s.type === 'ADRESA' ? ['person', 'company'] : personal ? ['person'] : ['company']);
    const id = s.type === 'ADRESA' ? '' : `${s.type === 'CI' ? 'CI' : s.type} ${s.value}`;
    if (p) {
      if (id && !p.identifiers.includes(id)) p.identifiers.push(id);
      if (!p._details[s.type]) p._details[s.type] = s.value;
      fact(`${LABEL[s.type]} — ${p.name}`, s.value);
    } else fact(LABEL[s.type], s.value);
  }
  for (const m of text.matchAll(REGNO_RE)) {
    const v = `${m[1]}${m[2]}/${m[3]}/${m[4]}`;
    const p = owner(m.index, ['company']);
    if (p) { if (!p.identifiers.includes(`ORC ${v}`)) p.identifiers.push(`ORC ${v}`); p._details.REGNO = v; }
    fact(p ? `Nr. ORC — ${p.name}` : 'Nr. ORC', v);
  }

  // Property and vehicles.
  const cadastral = uniq([...text.matchAll(CAD_RE)].map((m) => m[1]));
  const cf = uniq([...text.matchAll(CF_RE)].map((m) => m[1]));
  const plates = uniq([...text.matchAll(PLATE_RE)].map((m) => `${m[1].replace(/[\s-]/g, '')}${m[2]}`));
  cadastral.forEach((v) => fact('Nr. cadastral', v));
  cf.forEach((v) => fact('Carte funciară nr.', v));
  plates.forEach((v) => fact('Număr de înmatriculare', v));

  // Amounts, document numbers, law.
  const amounts = uniq([...text.matchAll(AMOUNT_RE)].map((m) => m[0].replace(/\s+/g, ' ').trim())).slice(0, 12);
  amounts.forEach((v) => fact('Sumă', v));
  const numbers = [];
  let ownNumber = '';
  for (const m of text.matchAll(DOCNO_RE)) {
    const n = m[1] + (m[2] ? ` din ${m[2]}` : '');
    if (!numbers.includes(n)) numbers.push(n);
    if (!ownNumber && m.index < 600) ownNumber = n;
    if (numbers.length >= 30) break;
  }
  if (ownNumber) fact('Număr document', ownNumber);
  try {
    const laws = uniq(findLawRefs(text).filter((r) => r.kind === 'act' || r.kind === 'code').map((r) => clip(text.slice(r.start, r.end), 120))).slice(0, 8);
    laws.forEach((v) => fact('Temei legal', v));
  } catch { /* no citations */ }

  // Dates, each with the sentence it sits in.
  const dates = [];
  for (const m of text.matchAll(DATE_RE)) {
    const d = normalizeDate(m[0]);
    if (!d) continue;
    const event = sentenceAt(text, m.index);
    if (!dates.some((x) => x.date === d && x.event === event)) dates.push({ date: d, event });
    if (dates.length >= 24) break;
  }

  const themes = THEMES.filter(([re]) => re.test(whole)).map(([, t]) => t).slice(0, 8);
  const people = parties.filter((p) => p.kind === 'person');
  const companies = parties.filter((p) => p.kind === 'company');
  const subject = idDocument?.holder
    || (parties.find((p) => p.role) || parties[0])?.name
    || (cadastral[0] ? `Imobil nr. cadastral ${cadastral[0]}` : '')
    || (plates[0] ? `Vehicul ${plates[0]}` : '')
    || documentType;

  // The summary, written from what was found.
  const who = parties.slice(0, 4).map((p) => (p.role ? `${p.name} (${p.role})` : p.name));
  const lines = [
    `${documentType}${ownNumber ? ` nr. ${ownNumber}` : ''}${who.length ? ` — ${who.join(', ')}` : ''}${dates[0] ? `, ${dates[0].date}` : ''}.`,
    amounts.length ? `Sume: ${amounts.slice(0, 3).join(', ')}.` : '',
    cadastral.length ? `Imobil: nr. cadastral ${cadastral.join(', ')}.` : '',
    plates.length ? `Vehicul: ${plates.join(', ')}.` : '',
    `Citit pe acest computer (fără AI): ${people.length} persoan${people.length === 1 ? 'ă' : 'e'}, ${companies.length} firm${companies.length === 1 ? 'ă' : 'e'}, ${dates.length} dat${dates.length === 1 ? 'ă' : 'e'}.`,
  ].filter(Boolean);

  const cleanParties = parties.slice(0, 30).map(({ _at, _details, ...p }) => ({ ...p, details: _details })); // eslint-disable-line no-unused-vars
  return {
    text: clip(lines.join(' '), 1600),
    subject: clip(subject, 200),
    documentType,
    facts: facts.slice(0, 40),
    entities: uniq(cleanParties.map((p) => p.name)).slice(0, 30),
    parties: cleanParties,
    dates: dates.slice(0, 30),
    themes,
    idDocument,
    numbers,
    amounts,
    property: cadastral,
    vehicles: plates,
    ...(roId && (roId.cnp || roId.document_number || roId.mrz) ? { roId } : {}),
    local: true,
  };
}

// ── Keys a file shares with others ──────────────────────────────────────
// `id:` an identifier (certain), `nm:` a name (likely), `pr:` a property,
// `vh:` a vehicle.
function keysOfEntry(e) {
  const u = e.understanding || {};
  const out = new Map();   // key -> label for the evidence
  const add = (k, label) => { if (!out.has(k)) out.set(k, label); };
  for (const p of u.parties || []) {
    const nk = nameKey(p.name);
    if (nk.split(' ').length >= 2 || (p.kind === 'company' && nk.length >= 4)) add(`nm:${nk}`, p.name);
    for (const id of p.identifiers || []) {
      const [type, ...rest] = String(id).split(' ');
      const v = rest.join('').replace(/\W+/g, '').toUpperCase();
      if (v.length >= 5) add(`id:${type}:${v}`, `${type} ${rest.join(' ')}`);
    }
  }
  for (const n of u.entities || []) { const nk = nameKey(n); if (nk.split(' ').length >= 2) add(`nm:${nk}`, n); }
  if (u.idDocument?.holder) add(`nm:${nameKey(u.idDocument.holder)}`, u.idDocument.holder);
  if (u.roId?.cnp) add(`id:CNP:${u.roId.cnp}`, `CNP ${u.roId.cnp}`);
  for (const f of u.facts || []) {
    if (/^(CNP|CUI|IBAN)\b/.test(f.label)) { const t = f.label.split(' ')[0]; add(`id:${t}:${String(f.value).replace(/\W+/g, '').toUpperCase()}`, `${t} ${f.value}`); }
    if (f.label === 'Nr. cadastral') add(`pr:${f.value}`, `nr. cadastral ${f.value}`);
    if (f.label === 'Carte funciară nr.') add(`pr:cf${f.value}`, `CF ${f.value}`);
    if (f.label === 'Număr de înmatriculare') add(`vh:${f.value}`, f.value);
  }
  for (const v of u.property || []) add(`pr:${v}`, `nr. cadastral ${v}`);
  for (const v of u.vehicles || []) add(`vh:${v}`, v);
  return out;
}

const ownNumberOf = (u) => (u.facts || []).find((f) => f.label === 'Număr document')?.value || '';
const numStem = (n) => String(n || '').split(' din ')[0].replace(/\s+/g, '');
const typeOf = (u) => String(u.documentType || '');
const isContract = (u) => /contract|procur/i.test(typeOf(u));
const dateOf = (u) => {
  const d = (u.dates || [])[0]?.date;
  const m = /(\d{2})\.(\d{2})\.(\d{4})/.exec(d || '');
  return m ? `${m[3]}-${m[2]}-${m[1]}` : '';
};
const versionStem = (name) => fold(String(name || '').replace(/\.[^.]+$/, ''))
  .replace(/\((?:\d+|edited|scan|copy|copie)\)|\b(?:v\d+|final|draft|ciorna|copy|copie|rev\d*)\b|[-_ ]+\d+$/g, ' ')
  .replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Typed links between files, from what they share — locally.
 * `entries` = [{ rel, file, stamp, understanding }]
 * → { links: [{ from, to, type, why, evidence, confidence }], timeline, facts }
 */
export function crossReferenceLocally(entries) {
  const keys = entries.map(keysOfEntry);
  const holders = new Map();   // key -> [entry index]
  keys.forEach((ks, i) => { for (const k of ks.keys()) holders.set(k, [...(holders.get(k) || []), i]); });

  // Pairs sharing something, with what they share. A key named by very many
  // files (the firm's own name on every page) says little about any pair.
  const pairs = new Map();
  const pairOf = (a, b) => {
    const k = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (!pairs.has(k)) pairs.set(k, { a: Math.min(a, b), b: Math.max(a, b), ids: [], names: [], property: [], vehicles: [] });
    return pairs.get(k);
  };
  for (const [k, idx] of holders) {
    if (idx.length < 2 || idx.length > 40) continue;
    for (let x = 0; x < idx.length; x += 1) {
      for (let y = x + 1; y < idx.length; y += 1) {
        const p = pairOf(idx[x], idx[y]);
        const label = keys[idx[x]].get(k);
        if (k.startsWith('id:')) p.ids.push(label);
        else if (k.startsWith('nm:')) p.names.push(label);
        else if (k.startsWith('pr:')) p.property.push(label);
        else p.vehicles.push(label);
      }
    }
  }

  // Document numbers one file cites and another states as its own.
  const byNumber = new Map();
  entries.forEach((e, i) => { const n = numStem(ownNumberOf(e.understanding)); if (n && /\d/.test(n) && n.length >= 2) byNumber.set(n, [...(byNumber.get(n) || []), i]); });
  const cites = new Map();   // 'a|b' -> number (a cites b)
  entries.forEach((e, a) => {
    const own = numStem(ownNumberOf(e.understanding));
    for (const n of e.understanding.numbers || []) {
      const stem = numStem(n);
      if (!stem || stem === own || !/\//.test(stem)) continue;   // "nr. 5" alone is too common
      for (const b of byNumber.get(stem) || []) if (b !== a) cites.set(`${a}|${b}`, n);
    }
  });

  // The same amount in a payment document and another file.
  const amountKey = (s) => String(s).replace(/[\s.]/g, '').toLowerCase().replace(/euro$/, 'eur').replace(/ron$/, 'lei');
  const byAmount = new Map();
  entries.forEach((e, i) => { for (const v of e.understanding.amounts || []) { const k = amountKey(v); byAmount.set(k, [...(byAmount.get(k) || []), i]); } });

  const links = [];
  const push = (a, b, type, why, evidence, confidence) => links.push({
    from: entries[a].rel, to: entries[b].rel, type, why, evidence: uniq(evidence).slice(0, 6), confidence,
  });
  const nameOf = (i) => entries[i].file?.name || entries[i].rel.split('/').pop();

  for (const p of pairs.values()) {
    const ua = entries[p.a].understanding; const ub = entries[p.b].understanding;
    const shared = [...p.ids, ...p.names];
    const idA = !!ua.idDocument; const idB = !!ub.idDocument;
    if (shared.length) {
      if (idA !== idB && (p.ids.length || p.names.length)) {
        const [doc, other] = idA ? [p.a, p.b] : [p.b, p.a];
        push(doc, other, 'evidence_for', `${nameOf(doc)} is the identity document of ${entries[doc].understanding.idDocument.holder}, who is named in ${nameOf(other)}.`, shared, p.ids.length ? 0.9 : 0.7);
      } else {
        push(p.a, p.b, 'same_party', `Both files name ${shared.slice(0, 2).join(' and ')}.`, shared, p.ids.length ? 0.95 : 0.7);
      }
    }
    if (p.property.length || p.vehicles.length) {
      const what = [...p.property, ...p.vehicles];
      push(p.a, p.b, 'same_subject', `Both files are about ${what.slice(0, 2).join(' and ')}.`, what, 0.9);
    }
    // An addendum amends the contract it shares a party with.
    const addA = /act adi/i.test(typeOf(ua)); const addB = /act adi/i.test(typeOf(ub));
    if (shared.length && addA !== addB && isContract(addA ? ub : ua)) {
      const [add, base] = addA ? [p.a, p.b] : [p.b, p.a];
      push(add, base, 'amends', `${nameOf(add)} is an addendum between the same parties as ${nameOf(base)}.`, shared, 0.75);
    }
    // A payment document between the same parties.
    const payA = MONEY_TYPES.has(typeOf(ua)); const payB = MONEY_TYPES.has(typeOf(ub));
    if (shared.length && payA !== payB) {
      const [pay, other] = payA ? [p.a, p.b] : [p.b, p.a];
      push(pay, other, 'financial_link', `${nameOf(pay)} is a payment document naming the same party as ${nameOf(other)}.`, shared, p.ids.length ? 0.8 : 0.6);
    }
    // A newer version of the same document.
    if (typeOf(ua) === typeOf(ub) && versionStem(nameOf(p.a)) && versionStem(nameOf(p.a)) === versionStem(nameOf(p.b)) && shared.length) {
      const ta = String(entries[p.a].stamp?.mtime || ''); const tb = String(entries[p.b].stamp?.mtime || '');
      const [newer, older] = ta >= tb ? [p.a, p.b] : [p.b, p.a];
      push(newer, older, 'supersedes', `${nameOf(newer)} looks like a later version of ${nameOf(older)} (same kind of document, same name, same parties).`, shared, 0.55);
    }
  }
  for (const [k, n] of cites) {
    const [a, b] = k.split('|').map(Number);
    const amend = /act adi/i.test(typeOf(entries[a].understanding)) && isContract(entries[b].understanding);
    push(a, b, amend ? 'amends' : 'references', `${nameOf(a)} cites nr. ${n}, the number of ${nameOf(b)}.`, [`nr. ${n}`], 0.85);
  }
  for (const [amount, idx] of byAmount) {
    if (idx.length < 2 || idx.length > 6) continue;
    for (let x = 0; x < idx.length; x += 1) {
      for (let y = x + 1; y < idx.length; y += 1) {
        const [a, b] = [idx[x], idx[y]];
        if (!MONEY_TYPES.has(typeOf(entries[a].understanding)) && !MONEY_TYPES.has(typeOf(entries[b].understanding))) continue;
        const shown = entries[a].understanding.amounts.find((v) => amountKey(v) === amount) || amount;
        push(a, b, 'financial_link', `Both files state the amount ${shown}.`, [shown], 0.6);
      }
    }
  }
  // Contradictions: one person given two different CNPs.
  const cnpsByName = new Map();
  entries.forEach((e, i) => {
    for (const p of e.understanding.parties || []) {
      if (p.kind !== 'person') continue;
      const cnp = (p.identifiers || []).find((x) => x.startsWith('CNP '));
      const nk = nameKey(p.name);
      if (!cnp || nk.split(' ').length < 2) continue;
      cnpsByName.set(nk, [...(cnpsByName.get(nk) || []), { i, cnp, name: p.name }]);
    }
  });
  for (const list of cnpsByName.values()) {
    for (let x = 0; x < list.length; x += 1) {
      for (let y = x + 1; y < list.length; y += 1) {
        if (list[x].i === list[y].i || list[x].cnp === list[y].cnp) continue;
        push(list[x].i, list[y].i, 'contradicts', `${list[x].name} is given ${list[x].cnp} in one file and ${list[y].cnp} in the other.`, [list[x].cnp, list[y].cnp], 0.8);
      }
    }
  }
  // Next step: documents of the same parties, in date order.
  const dated = entries.map((e, i) => ({ i, d: dateOf(e.understanding) })).filter((x) => x.d);
  for (const p of pairs.values()) {
    if (!p.ids.length && p.names.length < 2) continue;
    if (entries[p.a].understanding.idDocument || entries[p.b].understanding.idDocument) continue;   // a card's dates aren't events of the case
    const da = dated.find((x) => x.i === p.a)?.d; const db = dated.find((x) => x.i === p.b)?.d;
    if (!da || !db || da === db) continue;
    if (links.some((l) => ['amends', 'supersedes', 'references'].includes(l.type) && [l.from, l.to].includes(entries[p.a].rel) && [l.from, l.to].includes(entries[p.b].rel))) continue;
    const [first, then] = da < db ? [p.a, p.b] : [p.b, p.a];
    push(first, then, 'chronological', `Same parties; ${nameOf(then)} is dated after ${nameOf(first)}.`, [...p.ids, ...p.names], 0.5);
  }

  // Merged: one link per pair and type, strongest first.
  const seen = new Set();
  const out = [];
  for (const l of links.sort((x, y) => y.confidence - x.confidence)) {
    const sym = ['contradicts', 'same_party', 'same_subject'].includes(l.type);
    const key = `${sym ? [l.from, l.to].sort().join('|') : `${l.from}>${l.to}`}|${l.type}`;
    if (seen.has(key) || l.from === l.to) continue;
    seen.add(key);
    out.push(l);
  }

  // The timeline and the facts, project-wide.
  const tl = new Map();
  for (const e of entries) {
    for (const d of e.understanding.dates || []) {
      const k = `${d.date}|${fold(d.event)}`;
      const cur = tl.get(k) || { date: d.date, event: d.event, sources: [] };
      if (!cur.sources.includes(e.rel)) cur.sources.push(e.rel);
      tl.set(k, cur);
    }
  }
  const iso = (d) => String(d).split('.').reverse().join('-');
  const timeline = [...tl.values()].sort((a, b) => iso(a.date).localeCompare(iso(b.date)));
  const fx = new Map();
  for (const e of entries) {
    for (const f of e.understanding.facts || []) {
      const [label, subject = ''] = f.label.split(' — ');
      const k = `${fold(subject)}|${label}|${fold(f.value)}`;
      const cur = fx.get(k) || { subject, label, value: f.value, sources: [] };
      if (!cur.sources.includes(e.rel)) cur.sources.push(e.rel);
      fx.set(k, cur);
    }
  }
  return { links: out, timeline, facts: [...fx.values()] };
}

// ── Data collections, locally ───────────────────────────────────────────
// One collection per real-world subject the files name: a person (joined by
// CNP, else by name), a company (by CUI / trade register no., else by name), a
// property (cadastral no.) or a vehicle (plate). A subject becomes a
// collection when two files name it, or one names it with an identifier, or
// it is the holder of an identity document.
function subjectsOf(entries) {
  const nodes = [];   // { key, kind, name, rel, entry, party }
  entries.forEach((e) => {
    const u = e.understanding || {};
    for (const p of u.parties || []) {
      const kind = p.kind === 'company' ? 'company' : 'person';
      const ids = (p.identifiers || []).filter((x) => /^(CNP|CUI|ORC|CI|IBAN)\b/.test(x)).map((x) => `id:${x.replace(/\s+/g, '').toUpperCase()}`);
      nodes.push({ kind, name: p.name, keys: [`nm:${kind}:${nameKey(p.name)}`, ...ids], e, party: p, strong: ids.length > 0 || !!(u.idDocument && nameKey(u.idDocument.holder) === nameKey(p.name)) });
    }
    for (const v of u.property || []) nodes.push({ kind: 'property', name: `Imobil nr. cadastral ${v}`, keys: [`pr:${v}`], e, strong: true });
    for (const v of u.vehicles || []) nodes.push({ kind: 'vehicle', name: `Vehicul ${v}`, keys: [`vh:${v}`], e, strong: true });
  });
  const parent = nodes.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const owner = new Map();
  nodes.forEach((n, i) => { for (const k of n.keys) { if (k.endsWith(':')) continue; if (owner.has(k)) parent[find(i)] = find(owner.get(k)); else owner.set(k, i); } });
  const groups = new Map();
  nodes.forEach((n, i) => { const r = find(i); groups.set(r, [...(groups.get(r) || []), n]); });
  return [...groups.values()].map((list) => {
    const rels = uniq(list.map((n) => n.e.rel));
    const counts = new Map();
    for (const n of list) counts.set(n.name, (counts.get(n.name) || 0) + 1);
    const name = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)[0][0];
    return { kind: list[0].kind, name, nodes: list, rels, strong: list.some((n) => n.strong) };
  }).filter((g) => g.rels.length >= 2 || g.strong);
}

const RECORD_FROM = {
  person: { CNP: 'nationalId', TEL: 'phone', EMAIL: 'email', ADRESA: 'address' },
  company: { CUI: 'taxId', IBAN: 'iban', TEL: 'phone', EMAIL: 'email', ADRESA: 'address', REGNO: 'regNo' },
};

// A subject group → a collection (the shape dataCollections writes).
function collectionOfGroup(g, byRel, sourceOf) {
  const subject = g.kind;
  const sources = g.rels.map((rel) => {
    const e = byRel.get(rel);
    const roles = uniq(g.nodes.filter((n) => n.e.rel === rel && n.party?.role).map((n) => n.party.role));
    const type = e.understanding.documentType || 'Document';
    return sourceOf(e, `${type}${roles.length ? ` — names ${g.name} as ${roles.join(', ')}` : ` — names ${g.name}`}.`);
  });
  const facts = [];
  const fields = {};
  for (const n of g.nodes) {
    for (const [type, v] of Object.entries(n.party?.details || {})) {
      const label = { CNP: 'CNP', CUI: 'CUI', IBAN: 'IBAN', CI: 'Act de identitate', TEL: 'Telefon', EMAIL: 'E-mail', ADRESA: 'Adresă', REGNO: 'Nr. ORC' }[type] || type;
      const f = facts.find((x) => x.label === label && fold(x.value) === fold(v));
      if (f) { if (!f.sources.includes(n.e.rel)) f.sources.push(n.e.rel); } else facts.push({ label, value: v, sources: [n.e.rel] });
      const key = RECORD_FROM[subject]?.[type];
      if (key && !fields[key]) fields[key] = v;
    }
    if (n.party?.role) {
      const label = 'Calitate';
      const f = facts.find((x) => x.label === label && x.value === n.party.role);
      if (f) { if (!f.sources.includes(n.e.rel)) f.sources.push(n.e.rel); } else facts.push({ label, value: n.party.role, sources: [n.e.rel] });
    }
  }
  const timeline = [];
  for (const rel of g.rels) {
    for (const d of byRel.get(rel).understanding.dates || []) {
      if (!timeline.some((t) => t.date === d.date && t.event === d.event)) timeline.push({ date: d.date, event: d.event, sources: [rel] });
    }
  }
  const types = uniq(g.rels.map((rel) => byRel.get(rel).understanding.documentType).filter(Boolean));
  const summary = `${g.name} is named in ${g.rels.length} file${g.rels.length === 1 ? '' : 's'}${types.length ? ` (${types.slice(0, 5).join(', ')})` : ''}. Grouped on this computer from the names and identifiers the files share — no AI.`;
  let recordIn = null;
  if (subject === 'person' || subject === 'company') {
    if (subject === 'company') fields.legalName = g.name;
    else {
      const words = g.name.split(' ');
      if (words.length >= 2) { fields.lastName = words[0]; fields.firstName = words.slice(1).join(' '); }
    }
    recordIn = { kind: subject === 'company' ? 'org' : 'person', fields };
  }
  return {
    title: clip(g.name, 120), subject, summary, sources,
    facts: facts.slice(0, 60), timeline: timeline.slice(0, 60), connections: [],
    recordIn, _keys: new Set(g.nodes.flatMap((n) => n.keys)),
  };
}

// Does an existing collection hold this subject? By record identifier, by its
// names, or by its title.
function matches(col, g) {
  const keys = new Set(g.nodes.flatMap((n) => n.keys));
  const r = col.record || {};
  if (r.nationalId && keys.has(`id:CNP${String(r.nationalId).toUpperCase()}`)) return true;
  if (r.taxId && keys.has(`id:CUI${String(r.taxId).replace(/\s+/g, '').toUpperCase()}`)) return true;
  const kind = g.kind === 'company' ? 'company' : 'person';
  if (['person', 'company'].includes(g.kind)) {
    if (keys.has(`nm:${kind}:${nameKey(col.title)}`)) return true;
    if ((col.entities || []).some((e) => keys.has(`nm:${kind}:${nameKey(e.name)}`) && nameKey(e.name) === nameKey(g.name))) return true;
  }
  return nameKey(col.title) === nameKey(g.name);
}

/**
 * Fit `entries` into the collections — locally.
 * `cols` the existing collections (changed in place when a subject joins one),
 * `allEntries` every file the scan knows (a subject named once in a new file
 * and once in an old one still makes a collection), `sourceOf(entry, role)`.
 * → { created, touched }
 */
export function connectLocally(entries, cols, { allEntries = entries, sourceOf }) {
  const byRel = new Map(allEntries.map((e) => [e.rel, e]));
  const fresh = new Set(entries.map((e) => e.rel));
  const touched = new Set();
  const created = [];
  for (const g of subjectsOf(allEntries)) {
    // Only subjects the new files are part of are (re)worked.
    if (!g.rels.some((rel) => fresh.has(rel))) continue;
    const built = collectionOfGroup(g, byRel, sourceOf);
    const home = cols.find((c) => matches(c, g));
    if (!home) { delete built._keys; created.push(built); continue; }
    for (const s of built.sources) if (!home.sources.some((x) => x.rel === s.rel)) home.sources.push(s);
    for (const f of built.facts) {
      const cur = home.facts.find((x) => x.label === f.label && fold(x.value) === fold(f.value));
      if (cur) cur.sources = uniq([...(cur.sources || []), ...f.sources]); else home.facts.push(f);
    }
    for (const t of built.timeline) if (!home.timeline.some((x) => x.date === t.date && x.event === t.event)) home.timeline.push(t);
    home.summary = built.summary;
    home.recordIn = built.recordIn;
    touched.add(home);
  }
  return { created, touched };
}
