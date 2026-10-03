// The BRIEF — what the user tells the drafter before a document is written.
// Picking a template (or "Something else") on "What do you want to make?"
// opens it: a STAGED questionnaire, one step at a time so nobody is handed
// forty questions at once, following the anatomy EVERY Romanian legal document
// shares — from an NDA to a divorce petition to a lease:
//
//   1. Tipul și scopul            (Ce?)             — the object of the act
//   2. Părțile                    (Cine cu cine?)   — identification & capacity
//   3. Temeiul juridic și contextul (De ce?)        — preamble, the law invoked
//   4. Regulile jocului și sancțiunile (Dinamica)   — obligations, terms, money,
//                                                     the penalty clause
//   5. Validarea și jurisdicția   (Unde și cum?)    — applicable law, court,
//                                                     copies, signatures
//
// The structure is UNIVERSAL: every document gets every step. A template only
// ADDS the questions that are its own (an NDA asks what is secret and for how
// long; a pleading asks for the court and the claims). Every question can be
// handed to the AI ("Let the AI decide"), so the list can always be finished
// without inventing an answer. Generate is offered once every question on
// every step is answered.
//
// Ties: a party can be filled from a Data collection (the AI scan's record) or,
// for a company, from ANAF by its CUI; the Playbook preset decides the layout;
// the Data collections picked are handed over as the facts to draw on.
//
// Pure data + prompt building; the screen is components/DocBrief.

import { templatePrompt, customPrompt } from './docTemplates';
import { buildDocRulesSteer } from './docRules';
import { fieldsFor } from './identities';

// ── Family ──────────────────────────────────────────────────────────────────
export function briefFamily(template) {
  if (!template) return 'other';
  const outline = (template.outline || []).join(' | ');
  if (template.category === 'litigii' || /Instanța|Probe|Cheltuieli de judecată/.test(outline)) return 'pleading';
  if (/Părțile contractante|Răspunderea contractuală|Forța majoră/.test(outline) || /^Contract|Antecontract|Act adițional/i.test(template.label)) return 'contract';
  return 'other';
}

// The parties a document of this kind names, in the roles its clauses use. A
// guess from the label; every role stays editable, parties can be added/removed.
const ROLE_PAIRS = [
  [/vânzare|vanzare|antecontract|promisiune/i, ['Vânzător', 'Cumpărător']],
  [/închiriere|inchiriere|locațiune|locatiune/i, ['Locator', 'Locatar']],
  [/comodat/i, ['Comodant', 'Comodatar']],
  [/mandat/i, ['Mandant', 'Mandatar']],
  [/agenție|agentie/i, ['Comitent', 'Agent']],
  [/comision/i, ['Comitent', 'Comisionar']],
  [/intermediere/i, ['Client', 'Intermediar']],
  [/împrumut|imprumut/i, ['Împrumutător', 'Împrumutat']],
  [/cesiune/i, ['Cedent', 'Cesionar']],
  [/preluare de datorie/i, ['Debitor inițial', 'Noul debitor']],
  [/fideiusiune/i, ['Creditor', 'Fideiusor']],
  [/prestări|prestari|servicii/i, ['Prestator', 'Beneficiar']],
  [/antrepriză|antrepriza/i, ['Antreprenor', 'Beneficiar']],
  [/furnizare/i, ['Furnizor', 'Beneficiar']],
  [/asistență juridică|asistenta juridica/i, ['Avocat', 'Client']],
  [/NDA|confidențialitate|confidentialitate/i, ['Partea care divulgă', 'Partea care primește']],
  [/muncă|munca|individual/i, ['Angajator', 'Salariat']],
  [/donație|donatie/i, ['Donator', 'Donatar']],
];
export function defaultRoles(template) {
  const family = briefFamily(template);
  const label = String(template?.label || '');
  if (family === 'pleading') {
    if (/întâmpinare|intampinare/i.test(label)) return ['Pârât', 'Reclamant'];
    if (/apel/i.test(label)) return ['Apelant', 'Intimat'];
    if (/recurs/i.test(label)) return ['Recurent', 'Intimat'];
    return ['Reclamant', 'Pârât'];
  }
  for (const [re, pair] of ROLE_PAIRS) if (re.test(label)) return pair;
  if (family === 'contract' || !template) return ['Partea 1', 'Partea 2'];
  return ['Emitent'];
}

// ── The fields a party is identified by ─────────────────────────────────────
// The identification block Romanian practice requires — keyed by the record
// keys the document's blanks are named by, so a typed value, a Data collection
// and ANAF all land in the same place.
export const PARTY_FIELDS = {
  org: [
    { key: 'legalName', label: 'Denumire', required: true },
    { key: 'legalForm', label: 'Formă juridică', hint: 'S.R.L., S.A.…' },
    { key: 'taxId', label: 'CUI', anaf: true },
    { key: 'regNo', label: 'Nr. Registrul Comerțului', hint: 'J40/1234/2020' },
    { key: 'address', label: 'Sediu', wide: true },
    { key: 'iban', label: 'IBAN' },
    { key: 'bank', label: 'Banca' },
    { key: 'representative', label: 'Reprezentant legal' },
    { key: 'repCapacity', label: 'În calitate de', hint: 'administrator' },
  ],
  person: [
    { key: 'lastName', label: 'Nume', required: true },
    { key: 'firstName', label: 'Prenume' },
    { key: 'nationalId', label: 'CNP' },
    { key: 'idSeries', label: 'Serie CI' },
    { key: 'idNumber', label: 'Număr CI' },
    { key: 'address', label: 'Domiciliu', wide: true },
  ],
};

// ── Steps and questions ─────────────────────────────────────────────────────
export const BRIEF_STEPS = [
  { id: 'what', n: 1, title: 'Tipul și scopul', ask: 'Ce?', sub: 'What the document is and what it is for.' },
  { id: 'who', n: 2, title: 'Părțile', ask: 'Cine cu cine?', sub: 'How many parties, individuals or companies, and their details.' },
  { id: 'why', n: 3, title: 'Temeiul juridic și contextul', ask: 'De ce?', sub: 'The preamble and the law it rests on.' },
  { id: 'rules', n: 4, title: 'Regulile jocului și sancțiunile', ask: 'Dinamica, bani și sancțiuni', sub: 'Obligations, deadlines, price and what a breach costs.' },
  { id: 'where', n: 5, title: 'Validarea și jurisdicția', ask: 'Unde și cum?', sub: 'Applicable law, the court, copies and signatures.' },
];

const ALL = () => true;
const IS = (...families) => (ctx) => families.includes(ctx.family);
const TPL = (re) => (ctx) => re.test(`${ctx.template?.id || ''} ${ctx.template?.label || ''}`);

// `type`: choice (one) · multi (any) · text · parties · collections · preset.
// `other`: a free-text answer beside the options. `recommend`: an option id.
export const BRIEF_QUESTIONS = [
  // ── 1. Ce? ──
  { id: 'title', step: 'what', type: 'text', title: 'Titlul documentului', hint: 'Clear and concise — „Contract de vânzare-cumpărare”, „Cerere de chemare în judecată”.', when: ALL },
  { id: 'object', step: 'what', type: 'text', multiline: true, title: 'Scopul, pe scurt', hint: 'Ce se transferă, ce se prestează, ce se protejează — e.g. “an NDA to protect an app idea”.', when: ALL },
  { id: 'preset', step: 'what', type: 'preset', title: 'Playbook preset', hint: 'The numbering and layout rules the document follows.', when: ALL, noAi: true },

  // ── 2. Cine cu cine? ──
  { id: 'parties', step: 'who', type: 'parties', title: 'Părțile implicate', hint: 'For each party: an individual (persoană fizică) or a company (persoană juridică), then its details — from a Data collection, from ANAF by CUI, typed, or left blank to fill later.', when: ALL, noAi: true },

  // ── 3. De ce? ──
  { id: 'recitals', step: 'why', type: 'choice', other: true, title: 'Preambulul („Având în vedere că…”)', hint: 'The context that led to the document.', when: ALL, options: [
    { id: 'none', label: 'Fără preambul', say: 'Nu include preambul.' },
    { id: 'context', label: 'Din datele proiectului', say: 'Redactează preambulul („Având în vedere că…”) din datele colectate.' },
  ] },
  { id: 'legalBasis', step: 'why', type: 'multi', other: true, title: 'Temeiul juridic', hint: 'The law invoked — „În temeiul art. 1170 din Codul civil…”.', when: ALL, options: [
    { id: 'cc', label: 'Codul civil', say: 'Codul civil (Legea nr. 287/2009)' },
    { id: 'cpc', label: 'Codul de procedură civilă', say: 'Codul de procedură civilă (Legea nr. 134/2010)' },
    { id: 'cm', label: 'Codul muncii', say: 'Codul muncii (Legea nr. 53/2003)' },
    { id: 'ls', label: 'Legea nr. 31/1990', say: 'Legea societăților nr. 31/1990' },
    { id: 'gdpr', label: 'GDPR', say: 'Regulamentul (UE) 2016/679 (GDPR)' },
    { id: 'cf', label: 'Codul fiscal', say: 'Codul fiscal (Legea nr. 227/2015)' },
  ] },
  { id: 'court', step: 'why', type: 'text', title: 'Instanța și dosarul', hint: 'The court it is filed with, and the case number if there is one.', when: IS('pleading') },

  // ── 4. Regulile jocului ──
  // What is this document's own: asked only where it applies.
  { id: 'confInfo', step: 'rules', type: 'text', multiline: true, title: 'Ce informații sunt strict secrete?', when: TPL(/nda|confiden/i) },
  { id: 'confPeriod', step: 'rules', type: 'choice', other: true, title: 'Pe ce perioadă?', when: TPL(/nda|confiden/i), options: [
    { id: '2', label: '2 ani', say: 'Obligația de confidențialitate durează 2 ani de la încetarea contractului.' },
    { id: '3', label: '3 ani', say: 'Obligația de confidențialitate durează 3 ani de la încetarea contractului.' },
    { id: '5', label: '5 ani', say: 'Obligația de confidențialitate durează 5 ani de la încetarea contractului.' },
    { id: 'open', label: 'Nedeterminată', say: 'Obligația de confidențialitate durează pe perioadă nedeterminată.' },
  ] },
  { id: 'goods', step: 'rules', type: 'text', multiline: true, title: 'Bunul', hint: 'What is sold, let or lent — and how it is identified (CF number, VIN…).', when: TPL(/sale|vanzare|antecontract|inchiriere|comodat|donatie/i) },
  { id: 'services', step: 'rules', type: 'text', multiline: true, title: 'Serviciile / lucrarea', hint: 'What is performed or delivered.', when: TPL(/prestari|antrepriza|furnizare|asistenta/i) },
  { id: 'job', step: 'rules', type: 'text', title: 'Postul și salariul', hint: 'Position (COR code), gross salary, working time.', when: TPL(/^cim\b|individual de munc/i) },
  { id: 'claims', step: 'rules', type: 'text', multiline: true, title: 'Situația de fapt și solicitările', hint: 'What happened and what the court is asked for.', when: IS('pleading') },
  { id: 'value', step: 'rules', type: 'text', title: 'Valoarea obiectului cererii', hint: 'Needed for the stamp duty.', when: IS('pleading') },
  // The universal ones.
  { id: 'obligations', step: 'rules', type: 'text', multiline: true, title: 'Obligațiile principale', hint: 'What each party has to do.', when: ALL },
  { id: 'terms', step: 'rules', type: 'multi', other: true, title: 'Termenele', hint: 'Duration, payment and performance deadlines.', when: ALL, options: [
    { id: 'fixed', label: 'Durată determinată', say: 'Actul se încheie pe durată determinată.' },
    { id: 'open', label: 'Durată nedeterminată', say: 'Actul se încheie pe durată nedeterminată.' },
    { id: 'pay30', label: 'Plata în 30 de zile', say: 'Plata se face în 30 de zile de la emiterea facturii.' },
    { id: 'payadv', label: 'Plata în avans', say: 'Plata se face în avans.' },
    { id: 'tranches', label: 'Plata în tranșe', say: 'Plata se face în tranșe, după un grafic.' },
  ] },
  { id: 'price', step: 'rules', type: 'choice', other: true, title: 'Prețul', hint: 'If there is one — type the amount under “Other”.', when: ALL, options: [
    { id: 'none', label: 'Fără preț', say: 'Actul nu presupune un preț.' },
    { id: 'blank', label: 'Lasă de completat', say: 'Prețul rămâne un spațiu de completat.' },
  ] },
  { id: 'penalty', step: 'rules', type: 'choice', other: true, recommend: 'fixed', title: 'Dacă una dintre părți încalcă actul?', hint: 'A fixed penalty clause spares proving the exact damage in court.', when: ALL, options: [
    { id: 'fixed', label: 'Sumă fixă — clauză penală', say: 'Include o clauză penală cu o sumă fixă pentru încălcare (se lasă suma de completat dacă nu e dată).' },
    { id: 'daily', label: 'Penalități pe zi de întârziere', say: 'Include penalități de întârziere pentru fiecare zi de întârziere.' },
    { id: 'damages', label: 'Daune-interese dovedite', say: 'Partea în culpă datorează daune-interese pentru prejudiciul dovedit.' },
    { id: 'pact', label: 'Pact comisoriu', say: 'Include un pact comisoriu (rezoluțiune de plin drept, fără intervenția instanței).' },
  ] },
  { id: 'forceMajeure', step: 'rules', type: 'choice', other: true, title: 'Forța majoră și cazul fortuit', when: ALL, options: [
    { id: 'standard', label: 'Clauza standard', say: 'Include clauza standard de forță majoră și caz fortuit (art. 1351 C. civ.).' },
    { id: 'notice', label: 'Cu notificare în 5 zile', say: 'Include forța majoră și cazul fortuit, cu notificare în 5 zile și certificat CCIR.' },
    { id: 'omit', label: 'Fără', say: 'Nu include o clauză de forță majoră.' },
  ] },
  { id: 'evidence', step: 'rules', type: 'multi', other: true, title: 'Probe', when: IS('pleading'), options: [
    { id: 'docs', label: 'Înscrisuri', say: 'înscrisuri' },
    { id: 'wit', label: 'Martori', say: 'proba testimonială (martori)' },
    { id: 'int', label: 'Interogatoriu', say: 'interogatoriul pârâtului' },
    { id: 'exp', label: 'Expertiză', say: 'expertiză de specialitate' },
  ] },

  // ── 5. Unde și cum? ──
  { id: 'law', step: 'where', type: 'choice', other: true, title: 'Legea aplicabilă', when: ALL, options: [
    { id: 'ro', label: 'Legea română', say: 'Legea aplicabilă este legea română.' },
  ] },
  { id: 'disputes', step: 'where', type: 'choice', other: true, title: 'Dacă apar neînțelegeri, unde vă judecați?', hint: 'Name a court under “Other” — e.g. Judecătoria Sectorului 1.', when: ALL, options: [
    { id: 'mine', label: 'Instanțele de la sediul meu', say: 'Litigiile se soluționează de instanțele competente de la sediul/domiciliul părții care redactează actul.' },
    { id: 'defendant', label: 'Instanțele de la sediul pârâtului', say: 'Litigiile se soluționează de instanțele competente de la sediul/domiciliul pârâtului.' },
    { id: 'med', label: 'Mediere, apoi instanța', say: 'Părțile încearcă mai întâi medierea, apoi se adresează instanțelor competente.' },
    { id: 'arb', label: 'Arbitraj CCIR', say: 'Litigiile se soluționează prin arbitraj, de Curtea de Arbitraj Comercial Internațional de pe lângă CCIR.' },
  ] },
  { id: 'costs', step: 'where', type: 'choice', title: 'Cheltuieli de judecată', when: IS('pleading'), options: [
    { id: 'ask', label: 'Se solicită', say: 'Se solicită obligarea la plata cheltuielilor de judecată.' },
    { id: 'no', label: 'Nu se solicită', say: 'Nu se solicită cheltuieli de judecată.' },
  ] },
  { id: 'copies', step: 'where', type: 'choice', other: true, title: 'Numărul de exemplare', when: ALL, options: [
    { id: '1', label: '1', say: 'Redactat într-un exemplar.' },
    { id: '2', label: '2', say: 'Redactat în 2 exemplare originale, câte unul pentru fiecare parte.' },
    { id: '3', label: '3', say: 'Redactat în 3 exemplare originale.' },
  ] },
  { id: 'language', step: 'where', type: 'choice', other: true, title: 'Limba', when: ALL, options: [
    { id: 'ro', label: 'Română', say: 'Documentul se redactează în limba română.' },
    { id: 'roen', label: 'Română și engleză', say: 'Documentul se redactează bilingv, română și engleză, versiunea română prevalând.' },
    { id: 'en', label: 'Engleză', say: 'Documentul se redactează în limba engleză.' },
  ] },
  { id: 'signatures', step: 'where', type: 'choice', other: true, title: 'Semnăturile', when: ALL, options: [
    { id: 'wet', label: 'Olografe', say: 'Semnături olografe.' },
    { id: 'stamp', label: 'Olografe și ștampilă', say: 'Semnături olografe și ștampila persoanelor juridice.' },
    { id: 'qes', label: 'Electronice calificate', say: 'Semnături electronice calificate.' },
  ] },
  { id: 'attest', step: 'where', type: 'choice', title: 'Atestare de către avocat', hint: 'Identity, date and content certified by the lawyer (Legea nr. 51/1995).', when: ALL, options: [
    { id: 'yes', label: 'Da', say: 'Include mențiunea de atestare a identității părților, a conținutului și a datei actului de către avocat, conform Legii nr. 51/1995.' },
    { id: 'no', label: 'Nu', say: '' },
  ] },
  { id: 'placeDate', step: 'where', type: 'text', title: 'Locul și data', hint: 'Where and when it is signed.', when: ALL },
];

export function questionsFor(ctx) {
  return BRIEF_QUESTIONS.filter((q) => q.when(ctx));
}

// ── Answers ─────────────────────────────────────────────────────────────────
// One per question: { ai, choice: [ids], text }. The parties question holds
// `parties`: [{ id, role, kind: 'person'|'org'|null,
//               source: 'collection'|'typed'|'blank'|null, path, fields }].
export const emptyAnswer = () => ({ ai: false, choice: [], text: '' });

let partySeq = 0;
export function newParty(role = '') {
  partySeq += 1;
  return { id: `p${Date.now().toString(36)}${partySeq}`, role, kind: null, source: null, path: null, fields: {} };
}

export function initialAnswers(template, { presetId, custom } = {}) {
  const ctx = { family: briefFamily(template), template };
  const out = {};
  for (const q of questionsFor(ctx)) out[q.id] = emptyAnswer();
  out.title.text = template?.label || '';
  if (custom) out.object.text = custom;
  out.preset.choice = presetId ? [presetId] : [];
  out.parties = { ...emptyAnswer(), parties: defaultRoles(template).map((r) => newParty(r)) };
  out.language.choice = ['ro'];
  out.law.choice = ['ro'];
  return out;
}

export function partyDone(p) {
  if (!String(p.role || '').trim()) return false;
  if (p.source === 'collection') return !!p.path;
  if (!p.kind) return false;
  if (p.source === 'blank') return true;
  if (p.source === 'typed') {
    const req = PARTY_FIELDS[p.kind].find((f) => f.required);
    return !!String(p.fields?.[req.key] || '').trim();
  }
  return false;
}

export function isAnswered(q, a) {
  if (!a) return false;
  if (q.type === 'parties') return (a.parties || []).length > 0 && a.parties.every(partyDone);
  if (q.type === 'collections') return a.choice.length > 0 || a.text === 'none';
  if (q.type === 'preset') return a.choice.length > 0;
  if (a.ai) return true;
  if (q.type === 'text') return !!String(a.text || '').trim();
  return a.choice.length > 0 || (q.other && !!String(a.text || '').trim());
}

// ANAF's answer (lib/anaf normalizeCompany) as a party's fields.
export function fieldsFromAnaf(c) {
  if (!c) return {};
  const out = {
    legalName: c.name || '',
    taxId: c.cui ? String(c.cui) : '',
    regNo: c.regCom || '',
    address: c.address || '',
    iban: c.iban || '',
  };
  const form = /\b(S\.?R\.?L\.?(-D)?|S\.?A\.?|S\.?N\.?C\.?|S\.?C\.?S\.?|P\.?F\.?A\.?)\s*$/i.exec(c.name || '');
  if (form) out.legalForm = form[1].toUpperCase();
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v));
}

// ── The prompt ──────────────────────────────────────────────────────────────
// A party's details as the record keys the blanks are named by — the drafter
// writes a value where it knows one and `[[role.key]]` where it does not (the
// Doc Viewer fills those from a record afterwards).
function partyLines(p, records) {
  const role = String(p.role || '').trim();
  const unknown = [`- ${role}: ${p.kind === 'org' ? 'persoană juridică' : p.kind === 'person' ? 'persoană fizică' : ''} — date necunoscute, lasă spații de completat`];
  let kind = p.kind;
  let values = {};
  if (p.source === 'collection') {
    const rec = records.find((r) => r._path === p.path);
    if (!rec) return unknown;
    kind = rec.kind;
    values = { legalName: rec.legalName || rec.name };
    for (const f of fieldsFor(rec.kind)) if (typeof rec[f.key] === 'string') values[f.key] = rec[f.key];
  } else if (p.source === 'typed') {
    values = { ...p.fields };
    if (kind === 'person' && (values.lastName || values.firstName)) values.legalName = [values.lastName, values.firstName].filter(Boolean).join(' ');
  } else {
    return unknown;
  }
  const lines = [`- ${role} (${kind === 'org' ? 'persoană juridică' : 'persoană fizică'}):`];
  for (const [k, v] of Object.entries(values)) if (String(v || '').trim()) lines.push(`    ${k}: ${String(v).trim()}`);
  return lines;
}

function collectionBlock(col) {
  const lines = [`## ${col.title}`];
  if (col.summary) lines.push(col.summary.slice(0, 1200));
  for (const f of (col.facts || []).slice(0, 30)) lines.push(`- ${f.label}: ${f.value}`);
  for (const t of (col.timeline || []).slice(0, 15)) lines.push(`- ${t.date ? `${t.date}: ` : ''}${t.event}`);
  return lines.join('\n');
}

function answerText(q, a) {
  if (a.ai) return 'la alegerea ta, potrivit tipului de document';
  if (q.type === 'text') return String(a.text || '').trim();
  const said = (q.options || []).filter((o) => a.choice.includes(o.id)).map((o) => o.say).filter(Boolean);
  const other = String(a.text || '').trim();
  if (other) said.push(other);
  return said.join(q.type === 'multi' ? '; ' : ' ');
}

// `shown` is the line the advisor's thread shows; `prompt` is what the model reads.
export function buildBriefPrompt({ template, custom, answers, records = [], collections = [], presets = [], activePresetId }) {
  const ctx = { family: briefFamily(template), template };
  const title = String(answers.title?.text || '').trim() || template?.label || custom || '';
  const base = template ? templatePrompt(template) : customPrompt(title || custom);
  const out = [base, '', '# Detaliile documentului, date de utilizator', ''];
  if (title) out.push(`Titlul documentului: ${title}`, '');

  const parties = answers.parties?.parties || [];
  if (parties.length) {
    out.push('Părțile — blocul de identificare (folosește datele de mai jos acolo unde sunt date; pentru persoane juridice: denumire, formă, sediu, nr. ORC, CUI, IBAN, bancă, reprezentant legal; pentru persoane fizice: nume, prenume, domiciliu, CNP, serie și număr CI; orice lipsește rămâne spațiu de completat numit după rolul părții):');
    for (const p of parties) out.push(...partyLines(p, records));
    out.push('');
  }

  for (const step of BRIEF_STEPS) {
    const lines = [];
    for (const q of questionsFor(ctx).filter((x) => x.step === step.id)) {
      if (['preset', 'collections', 'parties', 'title'].includes(q.id)) continue;
      const said = answers[q.id] ? answerText(q, answers[q.id]) : '';
      if (said) lines.push(`- ${q.title}: ${said}`);
    }
    if (lines.length) out.push(`${step.n}. ${step.title} (${step.ask})`, ...lines, '');
  }

  const picked = collections.filter((c) => answers.collections?.choice?.includes(c.path));
  if (picked.length) {
    out.push('# Date colectate din proiect (Data collections)',
      'Folosește aceste fapte acolo unde documentul are nevoie de ele. Nu inventa altele.', '');
    for (const c of picked) out.push(collectionBlock(c), '');
  }

  // A preset other than the one in use: its rules ride in the REQUEST, which
  // the Playbook's own block says outranks it.
  const presetId = answers.preset?.choice?.[0];
  const preset = presets.find((p) => p.id === presetId);
  if (preset && preset.id !== activePresetId) {
    const steer = buildDocRulesSteer({ ...preset.rules, enabled: true });
    if (steer) out.push(`Pentru acest document folosește presetul Playbook „${preset.name}” — aceste reguli au prioritate față de orice alt bloc de reguli:`, steer);
  }

  return {
    shown: `Make: ${title}.${picked.length ? ` Drawing on ${picked.length} data collection${picked.length === 1 ? '' : 's'}.` : ''}${preset ? ` Preset: ${preset.name}.` : ''}`,
    prompt: out.join('\n').trim(),
  };
}
