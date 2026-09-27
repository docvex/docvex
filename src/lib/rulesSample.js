// A SAMPLE DOCUMENT written to the Playbook's document rules — a whole
// contract, laid out the way the rules say (section headings, clause
// numbering, sub-points, lists, blanks, dates, amounts, parties, defined
// terms, language), built as a real Word file so it can be looked at the way
// the AI's own drafts will be: the Playbook shows it through docx-preview, and
// it can be downloaded.
//
// Pure data → blocks (`sampleBlocks`), blocks → .docx (`sampleDocx`). The
// blocks are also what a test or another preview would read.

import {
  normalizeRules, sectionLabel, clauseLabel, markerFor, blankFor,
} from './docRules';

/** The documents on offer. */
export const SAMPLE_DOCS = [
  { id: 'services', label: 'Services contract' },
  { id: 'nda', label: 'Confidentiality agreement' },
];

// ── The contracts, in both languages ────────────────────────────────────────
// A clause's text may carry tokens the rules settle:
//   {P1} {P2}      a party after its introduction (short form or full name)
//   {date}         a date                 {amount}  the price
//   {blank:word}   a fact nobody has given yet
//   {term} {term:g} {term:a}   the defined term — plain, genitive, articulated
//   {P2bare}       the party after a preposition ("aprobat de Beneficiar")
const TEXT = {
  services: {
    ro: {
      title: 'Contract de prestări servicii',
      p1: { full: 'SC EXEMPLU SRL', desc: 'cu sediul în București, str. Exemplului nr. 1, înregistrată la Registrul Comerțului sub nr. J40/1234/2020, CUI 12345678, reprezentată legal prin Andrei Ionescu, administrator', short: 'Prestatorul', fem: true },
      p2: { full: 'ION POPESCU', desc: 'domiciliat în Cluj-Napoca, str. Florilor nr. 2, identificat cu CI seria CJ nr. 123456, CNP {blank:CNP}', short: 'Beneficiarul', bare: 'Beneficiar', fem: false },
      term: { on: { n: 'Servicii', g: 'Serviciilor', a: 'Serviciile' }, off: { n: 'servicii', g: 'serviciilor', a: 'serviciile' } },
      opening: 'Prezentul contract a fost încheiat astăzi, {date}, între:',
      and: 'și',
      agreed: 'Părțile au convenit încheierea prezentului contract, cu respectarea următoarelor clauze:',
      sections: [
        { name: 'Obiectul contractului', clauses: [
          { name: 'Obiectul', text: '{P1} se obligă să presteze în favoarea {P2dat} {term} de consultanță descrise în Anexa 1.' },
          { name: 'Obligațiile prestatorului', text: '{P1} se obligă:', subs: ['să presteze {term:a} cu diligența unui profesionist', 'să comunice {P2dat} orice împrejurare care ar putea afecta executarea'], deep: 'în termen de 5 zile lucrătoare de la data la care a luat cunoștință de ea' },
        ] },
        { name: 'Prețul și modalitatea de plată', clauses: [
          { name: 'Prețul', text: 'Prețul {term:g} este de {amount}, fără TVA.' },
          { name: 'Plata', text: 'Plata se face în termen de 15 zile de la primirea următoarelor documente:', list: ['factura fiscală', 'raportul de activitate aprobat de {P2bare}'] },
        ] },
        { name: 'Durata contractului', clauses: [
          { name: 'Durata', text: 'Prezentul contract se încheie pe o durată de {blank:durată} luni, începând cu data de {blank:dată}.' },
          { name: 'Încetarea', text: 'Oricare dintre părți poate denunța contractul printr-o notificare scrisă transmisă cu cel puțin 30 de zile înainte.' },
        ] },
      ],
      closing: 'Prezentul contract a fost încheiat în două exemplare originale, câte unul pentru fiecare parte.',
      sign: ['PRESTATOR', 'BENEFICIAR'],
    },
    en: {
      title: 'Services agreement',
      p1: { full: 'EXEMPLU SRL', desc: 'with its registered office in Bucharest, 1 Exemplului Street, registered with the Trade Register under no. J40/1234/2020, tax code 12345678, represented by Andrei Ionescu, director', short: 'Provider' },
      p2: { full: 'ION POPESCU', desc: 'residing in Cluj-Napoca, 2 Florilor Street, holder of ID card series CJ no. 123456, personal number {blank:personal number}', short: 'Client' },
      term: { on: { n: 'Services', g: 'Services', a: 'Services' }, off: { n: 'services', g: 'services', a: 'services' } },
      opening: 'This agreement is made on {date} between:',
      and: 'and',
      agreed: 'The parties have agreed as follows:',
      sections: [
        { name: 'Subject of the agreement', clauses: [
          { name: 'Subject', text: '{P1} shall provide to {P2} the consulting {term} described in Schedule 1.' },
          { name: 'Provider’s obligations', text: '{P1} shall:', subs: ['perform the {term} with the diligence of a professional', 'inform {P2} of any circumstance that may affect performance'], deep: 'within 5 working days of becoming aware of it' },
        ] },
        { name: 'Price and payment', clauses: [
          { name: 'Price', text: 'The price for the {term} is {amount}, excluding VAT.' },
          { name: 'Payment', text: 'Payment is due within 15 days of receipt of the following documents:', list: ['the invoice', 'the activity report approved by {P2bare}'] },
        ] },
        { name: 'Term', clauses: [
          { name: 'Duration', text: 'This agreement is made for a term of {blank:term} months, beginning on {blank:date}.' },
          { name: 'Termination', text: 'Either party may terminate this agreement by written notice given at least 30 days in advance.' },
        ] },
      ],
      closing: 'This agreement is made in two original copies, one for each party.',
      sign: ['PROVIDER', 'CLIENT'],
    },
  },
  nda: {
    ro: {
      title: 'Acord de confidențialitate',
      p1: { full: 'SC EXEMPLU SRL', desc: 'cu sediul în București, str. Exemplului nr. 1, CUI 12345678, reprezentată legal prin Andrei Ionescu, administrator', short: 'Partea Divulgatoare', fem: true },
      p2: { full: 'SC MODEL CONSTRUCT SA', desc: 'cu sediul în Iași, bd. Independenței nr. 3, CUI 87654321, reprezentată legal prin {blank:reprezentant}', short: 'Partea Receptoare', bare: 'Partea Receptoare', fem: true },
      term: { on: { n: 'Informații Confidențiale', g: 'Informațiilor Confidențiale', a: 'Informațiile Confidențiale' }, off: { n: 'informații confidențiale', g: 'informațiilor confidențiale', a: 'informațiile confidențiale' } },
      opening: 'Prezentul acord a fost încheiat astăzi, {date}, între:',
      and: 'și',
      agreed: 'Părțile au convenit următoarele:',
      sections: [
        { name: 'Obiectul acordului', clauses: [
          { name: 'Obiectul', text: '{P2} se obligă să păstreze confidențialitatea {term:g} primite de la {P1} în legătură cu proiectul comun.' },
          { name: 'Ce nu este confidențial', text: 'Nu sunt considerate {term} informațiile care:', subs: ['sunt publice la data comunicării', 'au fost obținute legal de la un terț'], deep: 'fără obligație de confidențialitate' },
        ] },
        { name: 'Răspunderea', clauses: [
          { name: 'Penalități', text: 'Pentru fiecare încălcare, {P2} datorează penalități de {amount}.' },
          { name: 'Restituirea', text: 'La încetarea acordului, {P2} restituie:', list: ['documentele primite', 'orice copie a acestora'] },
        ] },
        { name: 'Durata acordului', clauses: [
          { name: 'Durata', text: 'Obligația de confidențialitate se menține {blank:durată} ani de la data încetării acordului.' },
        ] },
      ],
      closing: 'Prezentul acord a fost încheiat în două exemplare originale, câte unul pentru fiecare parte.',
      sign: ['PARTEA DIVULGATOARE', 'PARTEA RECEPTOARE'],
    },
    en: {
      title: 'Confidentiality agreement',
      p1: { full: 'EXEMPLU SRL', desc: 'with its registered office in Bucharest, 1 Exemplului Street, tax code 12345678, represented by Andrei Ionescu, director', short: 'Disclosing Party' },
      p2: { full: 'MODEL CONSTRUCT SA', desc: 'with its registered office in Iași, 3 Independenței Boulevard, tax code 87654321, represented by {blank:representative}', short: 'Receiving Party' },
      term: { on: { n: 'Confidential Information', g: 'Confidential Information', a: 'Confidential Information' }, off: { n: 'confidential information', g: 'confidential information', a: 'confidential information' } },
      opening: 'This agreement is made on {date} between:',
      and: 'and',
      agreed: 'The parties have agreed as follows:',
      sections: [
        { name: 'Subject of the agreement', clauses: [
          { name: 'Subject', text: '{P2} shall keep confidential the {term} received from {P1} in connection with the joint project.' },
          { name: 'Exclusions', text: 'The following are not {term}:', subs: ['information that is public when disclosed', 'information lawfully obtained from a third party'], deep: 'without any duty of confidentiality' },
        ] },
        { name: 'Liability', clauses: [
          { name: 'Penalties', text: 'For each breach, {P2} shall pay penalties of {amount}.' },
          { name: 'Return', text: 'When this agreement ends, {P2} shall return:', list: ['the documents received', 'any copy of them'] },
        ] },
        { name: 'Term', clauses: [
          { name: 'Duration', text: 'The duty of confidentiality continues for {blank:term} years after this agreement ends.' },
        ] },
      ],
      closing: 'This agreement is made in two original copies, one for each party.',
      sign: ['DISCLOSING PARTY', 'RECEIVING PARTY'],
    },
  },
};

const RO_MONTHS = ['ianuarie', 'februarie', 'martie', 'aprilie', 'mai', 'iunie', 'iulie', 'august', 'septembrie', 'octombrie', 'noiembrie', 'decembrie'];
const EN_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/**
 * The sample as BLOCKS: `{ type: 'title' | 'para' | 'party' | 'heading' |
 * 'clause' | 'item' | 'sign', ... }`, every label and convention settled by
 * the rules.
 */
export function sampleBlocks(rules, kind = 'services') {
  const r = normalizeRules(rules);
  const lang = r.language === 'en' ? 'en' : 'ro';
  const T = (TEXT[kind] || TEXT.services)[lang];
  const ro = lang === 'ro';
  const short = r.parties === 'shortForm';
  const d = new Date(2026, 1, 1);
  const date = r.dates === 'long'
    ? (ro ? `${d.getDate()} ${RO_MONTHS[d.getMonth()]} ${d.getFullYear()}` : `${d.getDate()} ${EN_MONTHS[d.getMonth()]} ${d.getFullYear()}`)
    : '01.02.2026';
  const amount = ro
    ? (r.amounts === 'figures' ? '5.000 lei' : '5.000 lei (cinci mii lei)')
    : (r.amounts === 'figures' ? '5,000 lei' : '5,000 lei (five thousand lei)');
  const term = r.definedTerms === 'on' ? T.term.on : T.term.off;
  const partyRef = (p, dat = false) => {
    if (!short) return p.full;
    if (!ro) return `the ${p.short}`;
    // Romanian: the short form is already articulated ("Prestatorul"); the
    // dative ("Prestatorului / Beneficiarului / Părții …") for "în favoarea".
    if (!dat) return p.short;
    return p.short.replace(/ul$/, 'ului').replace(/^Partea /, 'Părții ').replace(/a$/, 'ei');
  };
  const bare = (p) => (!short ? p.full : (ro ? (p.bare || p.short) : `the ${p.short}`));
  const fill = (s) => {
    const out = String(s)
      .replace(/\{P1\}/g, partyRef(T.p1))
      .replace(/\{P2\}/g, partyRef(T.p2))
      .replace(/\{P2dat\}/g, partyRef(T.p2, true))
      .replace(/\{P2bare\}/g, bare(T.p2))
      .replace(/\{date\}/g, date)
      .replace(/\{amount\}/g, amount)
      .replace(/\{term:g\}/g, term.g)
      .replace(/\{term:a\}/g, term.a)
      .replace(/\{term\}/g, term.n)
      .replace(/\{blank:[^}]*\}/g, () => blankFor(r.blanks));
    // A sentence OPENING on a party ("the Provider shall…") gets its capital;
    // nothing else is touched.
    return /^\{P/.test(String(s)) ? out.replace(/^(\p{Ll})/u, (c) => c.toUpperCase()) : out;
  };
  const introduce = (p) => {
    const tail = short
      ? (ro ? `, denumit${p.fem ? 'ă' : ''} în continuare „${p.short}”` : ` (the “${p.short}”)`)
      : '';
    return `${p.full}, ${fill(p.desc)}${tail}`;
  };

  const out = [];
  // Flags saying which conventions a block SHOWS (read off its template, so
  // they hold whatever the rules make of it) — `sampleKeyed` uses them.
  const has = (tpl) => ({
    date: /\{date\}/.test(tpl), amount: /\{amount\}/.test(tpl),
    term: /\{term/.test(tpl), blank: /\{blank/.test(tpl),
    party: /\{P/.test(tpl),
  });
  out.push({ type: 'title', text: T.title.toUpperCase() });
  out.push({ type: 'para', text: fill(T.opening), ...has(T.opening) });
  out.push({ type: 'party', text: `${introduce(T.p1)},`, ...has(T.p1.desc) });
  out.push({ type: 'para', text: T.and, center: true });
  out.push({ type: 'party', text: `${introduce(T.p2)}.`, ...has(T.p2.desc) });
  out.push({ type: 'para', text: T.agreed });
  let running = 0;
  T.sections.forEach((sec, si) => {
    out.push({ type: 'heading', text: sectionLabel(r, si + 1, sec.name) });
    sec.clauses.forEach((c, ci) => {
      running += 1;
      out.push({
        type: 'clause',
        label: clauseLabel(r, si + 1, ci + 1, running),
        name: r.clauseNames === 'on' ? c.name : '',
        text: fill(c.text),
        section: si,
        ...has(c.text),
      });
      (c.subs || []).forEach((t, i) => {
        const last = i === c.subs.length - 1 && !c.deep;
        out.push({
          type: 'item', level: 1, role: 'sub', marker: markerFor(r.subPoint, i), text: `${fill(t)}${last ? '.' : ';'}`,
          // The deeper level switched off: its choice rides on the last sub-point.
          deepOff: i === c.subs.length - 1 && !!c.deep && r.deepPoint === 'none',
          ...has(t),
        });
      });
      if (c.deep && r.deepPoint !== 'none') {
        out.push({ type: 'item', level: 2, role: 'deep', marker: markerFor(r.deepPoint, 0), text: `${fill(c.deep)}.` });
      }
      (c.list || []).forEach((t, i) => {
        out.push({ type: 'item', level: 1, role: 'list', marker: markerFor(r.bullet, i), text: `${fill(t)}${i === c.list.length - 1 ? '.' : ';'}`, ...has(t) });
      });
    });
  });
  out.push({ type: 'para', text: T.closing });
  out.push({ type: 'sign', left: T.sign[0], right: T.sign[1], leftName: T.p1.full, rightName: T.p2.full });
  // The user's own extra rules are for the AI, not for a document — but a
  // sample that ignored them would be telling half the story.
  const extra = String(r.extra || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (extra.length) out.push({ type: 'note', lines: extra });
  return out;
}

/** The sample as a real .docx (Times New Roman 12, justified, A4). */
// The DocVex house style (lib/docThemes, 'docvex'): ink and cognac, Georgia
// headings over Calibri, a cognac rule under the title. `sampleDocx(…,
// { theme: 'docvex' })` writes it INTO the file (the sample's formatting is
// direct, so the preview's theme classes would have nothing to hold on to).
const HOUSE = {
  head: 'Georgia', body: 'Calibri',
  title: '0F172A', heading: '8B5E3C', text: '1E293B', rule: '8B5E3C',
};
export async function sampleDocx(rules, kind = 'services', { theme = null } = {}) {
  const {
    Document, Packer, Paragraph, TextRun, AlignmentType, Table, TableRow, TableCell,
    WidthType, BorderStyle,
  } = await import('docx');
  const blocks = sampleBlocks(rules, kind);
  const r = normalizeRules(rules);
  const house = theme === 'docvex' ? HOUSE : null;
  const FONT = house ? house.body : 'Times New Roman';
  const HEAD = house ? house.head : FONT;
  const tint = (c) => (house ? { color: house[c] } : {});
  const run = (text, o = {}) => new TextRun({ text, font: FONT, size: house ? 22 : 24, ...tint('text'), ...o });
  const headRun = (text, o = {}) => run(text, { font: HEAD, ...o });
  const J = AlignmentType.JUSTIFIED;
  const children = [];
  const none = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
  for (const b of blocks) {
    if (b.type === 'title') {
      children.push(new Paragraph({
        alignment: AlignmentType.CENTER, spacing: { after: 360 },
        ...(house ? { border: { bottom: { style: BorderStyle.SINGLE, size: 8, color: house.rule, space: 6 } } } : {}),
        children: [headRun(b.text, { bold: true, size: house ? 32 : 28, ...tint('title') })],
      }));
    } else if (b.type === 'para') {
      children.push(new Paragraph({ alignment: b.center ? AlignmentType.CENTER : J, spacing: { after: 160, line: 300 }, children: [run(b.text)] }));
    } else if (b.type === 'party') {
      // The party's name in bold, the rest as written.
      const cut = b.text.indexOf(',');
      children.push(new Paragraph({
        alignment: J, spacing: { after: 160, line: 300 },
        children: cut > 0 ? [run(b.text.slice(0, cut), { bold: true }), run(b.text.slice(cut))] : [run(b.text)],
      }));
    } else if (b.type === 'heading') {
      children.push(new Paragraph({
        keepNext: true, spacing: { before: 280, after: 160 },
        alignment: r.sectionHeading === 'capitol' ? AlignmentType.CENTER : AlignmentType.LEFT,
        children: [headRun(b.text, { bold: true, ...(house ? { size: 24 } : {}), ...tint('heading') })],
      }));
    } else if (b.type === 'clause') {
      const parts = [];
      if (b.label) parts.push(run(`${b.label} `, { bold: true }));
      if (b.name) parts.push(run(`${b.name}. `, { bold: true }));
      parts.push(run(b.text));
      children.push(new Paragraph({ alignment: J, spacing: { after: 120, line: 300 }, children: parts }));
    } else if (b.type === 'item') {
      const left = b.level === 2 ? 1080 : 540;
      children.push(new Paragraph({
        alignment: J, spacing: { after: 80, line: 300 },
        indent: { left, hanging: b.marker ? 360 : 0 },
        children: [run(b.marker ? `${b.marker}\t${b.text}` : b.text)],
        tabStops: [{ type: 'left', position: left }],
      }));
    } else if (b.type === 'sign') {
      const cell = (role, name) => new TableCell({
        width: { size: 50, type: WidthType.PERCENTAGE },
        borders: { top: none, bottom: none, left: none, right: none },
        children: [
          new Paragraph({ alignment: AlignmentType.CENTER, children: [headRun(role, { bold: true, ...tint('heading') })] }),
          new Paragraph({ alignment: AlignmentType.CENTER, children: [run(name)] }),
          new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 480 }, children: [run('_______________')] }),
        ],
      });
      children.push(new Paragraph({ spacing: { before: 360 }, children: [] }));
      children.push(new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        borders: { top: none, bottom: none, left: none, right: none, insideHorizontal: none, insideVertical: none },
        rows: [new TableRow({ children: [cell(b.left, b.leftName), cell(b.right, b.rightName)] })],
      }));
    } else if (b.type === 'note') {
      children.push(new Paragraph({ spacing: { before: 480, after: 80 }, children: [run('Other rules the AI also follows:', { italics: true, size: 20, color: '777777' })] }));
      b.lines.forEach((l) => children.push(new Paragraph({ indent: { left: 360 }, children: [run(`– ${l}`, { italics: true, size: 20, color: '777777' })] })));
    }
  }
  const doc = new Document({
    styles: { default: { document: { run: { font: FONT, size: 24 } } } },
    sections: [{
      properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1418, bottom: 1418, left: 1418, right: 1134 } } },
      children,
    }],
  });
  return Packer.toBlob(doc);
}


// ── The sample, with its rules marked ───────────────────────────────────────
// The Playbook's "In Word" view draws each rule's choices above the FIRST
// block of the sample that shows it. `keys` on a block = the rule keys to
// draw above it. A rule the sample cannot show (nothing matched) goes on the
// first block, so every choice is always reachable.
const KEY_FIRST = [
  ['dates', (b) => b.date],
  ['parties', (b) => b.type === 'party'],
  ['blanks', (b) => b.blank],
  ['sectionHeading', (b) => b.type === 'heading'],
  ['headingCase', (b) => b.type === 'heading'],
  ['clauseNumber', (b) => b.type === 'clause'],
  ['clauseNames', (b) => b.type === 'clause'],
  ['definedTerms', (b) => b.term],
  ['subPoint', (b) => b.role === 'sub'],
  ['deepPoint', (b) => b.role === 'deep' || b.deepOff],
  ['restart', (b) => b.type === 'clause' && b.section === 1],
  ['amounts', (b) => b.amount],
  ['bullet', (b) => b.role === 'list'],
];
// EVERY block a rule changes (`affects` on a block = the rule keys that
// shape it) — what the Playbook lights up while a rule's choices are hovered.
const AFFECTS = {
  sectionHeading: (b) => b.type === 'heading',
  headingCase: (b) => b.type === 'heading',
  clauseNumber: (b) => b.type === 'clause',
  clauseNames: (b) => b.type === 'clause',
  restart: (b) => b.type === 'clause' && b.section > 0,
  subPoint: (b) => b.role === 'sub',
  deepPoint: (b) => b.role === 'deep' || b.deepOff,
  bullet: (b) => b.role === 'list',
  blanks: (b) => b.blank,
  dates: (b) => b.date,
  amounts: (b) => b.amount,
  parties: (b) => b.type === 'party' || b.party,
  definedTerms: (b) => b.term,
};
export function sampleKeyed(rules, kind = 'services') {
  const out = sampleBlocks(rules, kind).map((b) => ({
    ...b,
    keys: [],
    affects: Object.keys(AFFECTS).filter((k) => AFFECTS[k](b)),
  }));
  for (const [key, test] of KEY_FIRST) {
    const b = out.find(test) || out[0];
    b.keys.push(key);
  }
  return out;
}

/** The sample as a .docx AND its blocks with their rules marked. */
export async function sampleWord(rules, kind = 'services') {
  return { blob: await sampleDocx(rules, kind), blocks: sampleKeyed(rules, kind) };
}
