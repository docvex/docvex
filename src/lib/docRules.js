// ── Document rules — how the AI is to lay a document out ────────────────────
//
// The Playbook already teaches the AI how this person WRITES (lib/writingStyle,
// learned from their own documents). This is the other half, and it cannot be
// learned: how a document is to be NUMBERED and laid out. A firm's documents
// are consistent because someone decided that clauses are 1.1 and sub-points
// are a), not because a model inferred it — and a model asked twice will
// cheerfully answer "Art. 1" once and "CAPITOLUL I" the next time.
//
// So these are stated, not distilled. Each rule is a fixed set of choices (the
// shapes the app's own parser recognises — see MARKER_RE / headingOf in
// lib/docConstructor, which is why picking one here also means the paragraph
// tools will read the result back correctly), and `docRulesSteer` turns the
// choices into the instructions that ride on every drafting turn.
//
// The defaults are what the drafter was doing before this page existed: the
// Romanian legal conventions the templates in lib/docTemplates are written to.
//
// WHERE THEY LIVE: on the device, per account (localStorage). The writing
// profile beside them is a Supabase row and follows the user between machines;
// these do not yet, because that needs a column adding to `writing_profiles`.
// Everything outside `load`/`save` is written against the returned object, so
// moving the store is those two functions and nothing else.

const KEY = 'docvex.docRules.v1';

// ── The rules, as the page shows them ───────────────────────────────────────
// `example` is what the choice looks like in a document — the preview is built
// from these, and a rule nobody can picture is a rule nobody will set.
export const RULE_GROUPS = [
  {
    id: 'structure',
    title: 'Structure and numbering',
    note: 'How sections, clauses and sub-points are marked. The app reads these shapes back, so a document written to these rules keeps its paragraph numbering when you edit it.',
    fields: [
      {
        key: 'sectionHeading',
        label: 'Sections',
        hint: 'How the top level of the document is titled.',
        options: [
          { id: 'art', label: 'Art. 1', example: 'Art. 1 Obiectul contractului', rule: 'Title each section "Art. 1", "Art. 2", … followed by the section name.' },
          { id: 'capitol', label: 'CAPITOLUL I', example: 'CAPITOLUL I — OBIECTUL CONTRACTULUI', rule: 'Title each section "CAPITOLUL I", "CAPITOLUL II", … (Roman numerals) followed by the section name.' },
          { id: 'sectiunea', label: 'Secțiunea 1', example: 'Secțiunea 1. Obiectul contractului', rule: 'Title each section "Secțiunea 1", "Secțiunea 2", … followed by the section name.' },
          { id: 'number', label: '1.', example: '1. OBIECTUL CONTRACTULUI', rule: 'Title each section with its number and a full stop — "1.", "2." — followed by the section name.' },
          { id: 'roman', label: 'I.', example: 'I. OBIECTUL CONTRACTULUI', rule: 'Title each section with a Roman numeral and a full stop — "I.", "II." — followed by the section name.' },
          { id: 'plain', label: 'No number', example: 'OBIECTUL CONTRACTULUI', rule: 'Give sections a name only, with no number in front of it.' },
        ],
      },
      {
        key: 'headingCase',
        label: 'Section titles',
        hint: 'The capitalisation of a section’s name.',
        options: [
          { id: 'upper', label: 'CAPITALS', example: 'OBIECTUL CONTRACTULUI', rule: 'Write section names in CAPITALS.' },
          { id: 'title', label: 'Title Case', example: 'Obiectul Contractului', rule: 'Write section names in Title Case.' },
          { id: 'sentence', label: 'Sentence case', example: 'Obiectul contractului', rule: 'Write section names in sentence case — only the first word and proper nouns capitalised.' },
        ],
      },
      {
        key: 'clauseNumber',
        label: 'Clauses',
        hint: 'The numbered paragraphs inside a section.',
        options: [
          { id: 'dotted', label: '1.1.', example: '1.1. Prestatorul se obligă să…', rule: 'Number the clauses inside a section "1.1.", "1.2." — the section number, the clause number, and a closing full stop.' },
          { id: 'dottedBare', label: '1.1', example: '1.1 Prestatorul se obligă să…', rule: 'Number the clauses inside a section "1.1", "1.2" — the section number and the clause number, with no closing full stop.' },
          { id: 'paren', label: '(1)', example: '(1) Prestatorul se obligă să…', rule: 'Number the clauses inside a section "(1)", "(2)", restarting in each section.' },
          { id: 'number', label: '1.', example: '1. Prestatorul se obligă să…', rule: 'Number the clauses inside a section "1.", "2.", restarting in each section.' },
          { id: 'none', label: 'Unnumbered', example: 'Prestatorul se obligă să…', rule: 'Leave the paragraphs inside a section unnumbered.' },
        ],
      },
      {
        key: 'subPoint',
        label: 'Sub-points',
        hint: 'The level below a clause — an enumeration inside it.',
        options: [
          { id: 'letterParen', label: 'a)', example: 'a) să predea documentele;', rule: 'Mark sub-points "a)", "b)", "c)".' },
          { id: 'letterDot', label: 'a.', example: 'a. să predea documentele;', rule: 'Mark sub-points "a.", "b.", "c.".' },
          { id: 'letterBoth', label: '(a)', example: '(a) să predea documentele;', rule: 'Mark sub-points "(a)", "(b)", "(c)".' },
          { id: 'romanLower', label: 'i)', example: 'i) să predea documentele;', rule: 'Mark sub-points "i)", "ii)", "iii)".' },
          { id: 'dash', label: '-', example: '- să predea documentele;', rule: 'Mark sub-points with a dash "-".' },
          { id: 'bullet', label: '•', example: '• să predea documentele;', rule: 'Mark sub-points with a bullet "•".' },
        ],
      },
      {
        key: 'deepPoint',
        label: 'Deeper level',
        hint: 'An enumeration inside a sub-point. Rare — most documents never reach it.',
        options: [
          { id: 'romanLower', label: 'i)', example: 'i) în termen de 5 zile;', rule: 'Mark the level below a sub-point "i)", "ii)", "iii)".' },
          { id: 'dash', label: '-', example: '- în termen de 5 zile;', rule: 'Mark the level below a sub-point with a dash "-".' },
          { id: 'bullet', label: '•', example: '• în termen de 5 zile;', rule: 'Mark the level below a sub-point with a bullet "•".' },
          { id: 'none', label: 'Don’t go deeper', example: '', rule: 'Never go deeper than sub-points: rewrite anything that would need a fourth level as prose or as further sub-points.' },
        ],
      },
      {
        key: 'blanks',
        label: 'Empty fields',
        hint: 'What a fact the AI wasn’t given looks like, so it leaves a gap instead of inventing a value. A BRACKETED gap is the surest: nothing else in a legal document is written that way, so it needs no judging — a bare rule of dots or lines has to be told apart from a hand-drawn line or a table of contents.',
        options: [
          { id: 'underscores', label: '_____', example: 'Subsemnatul _____, domiciliat în _____', rule: 'Where a fact has not been given, never invent one — leave a blank, written as five low lines: "_____".' },
          { id: 'dots', label: '.........', example: 'Subsemnatul ........., domiciliat în .........', rule: 'Where a fact has not been given, never invent one — leave a blank, written as a run of at least nine full stops: ".........".' },
          { id: 'bracket', label: '[_____]', example: 'Subsemnatul [_____], domiciliat în [_____]', rule: 'Where a fact has not been given, never invent one — leave a blank, written as five low lines inside square brackets: "[_____]".' },
          { id: 'bracketDots', label: '[.........]', example: 'Subsemnatul [.........], domiciliat în [.........]', rule: 'Where a fact has not been given, never invent one — leave a blank, written as a run of full stops inside square brackets: "[.........]".' },
        ],
      },
      {
        key: 'bullet',
        label: 'Plain lists',
        hint: 'A list that is not an enumeration of obligations — where order and lettering carry no meaning.',
        options: [
          { id: 'dash', label: '-', example: '- copie a actului de identitate', rule: 'Write unordered lists with "-".' },
          { id: 'bullet', label: '•', example: '• copie a actului de identitate', rule: 'Write unordered lists with "•".' },
          { id: 'star', label: '*', example: '* copie a actului de identitate', rule: 'Write unordered lists with "*".' },
        ],
      },
      {
        key: 'restart',
        label: 'Numbering runs',
        hint: 'Whether clause numbers start again under each section.',
        options: [
          { id: 'perSection', label: 'Restart each section', example: 'Art. 2 → 2.1, 2.2', rule: 'Clause numbers restart in every section and carry the section’s own number.' },
          { id: 'continuous', label: 'Run continuously', example: 'Art. 2 → 5, 6, 7', rule: 'Clause numbers run continuously through the whole document rather than restarting in each section.' },
        ],
      },
      {
        key: 'clauseNames',
        label: 'Clause names',
        hint: 'Whether a clause opens with a short name for what it does.',
        options: [
          { id: 'off', label: 'No names', example: '1.1. Prestatorul se obligă să…', rule: 'Do not put a name in front of a clause — begin it with its text.' },
          { id: 'on', label: 'Name each clause', example: '1.1. Obligațiile prestatorului. Prestatorul se obligă să…', rule: 'Open each clause with a short name for what it governs, in bold, followed by a full stop, then the clause text.' },
        ],
      },
    ],
  },
  {
    id: 'conventions',
    title: 'Conventions',
    note: 'How recurring facts are written. These are the details a reader notices when they are inconsistent between two documents from the same office.',
    fields: [
      {
        key: 'dates',
        label: 'Dates',
        options: [
          { id: 'numeric', label: '01.02.2026', example: 'încheiat astăzi, 01.02.2026', rule: 'Write dates as DD.MM.YYYY (01.02.2026).' },
          { id: 'long', label: '1 februarie 2026', example: 'încheiat astăzi, 1 februarie 2026', rule: 'Write dates in words — "1 februarie 2026".' },
        ],
      },
      {
        key: 'amounts',
        label: 'Amounts',
        options: [
          { id: 'figuresWords', label: 'Figures and words', example: '1.000 lei (una mie lei)', rule: 'Write amounts as figures followed by the same amount in words in brackets — 1.000 lei (una mie lei).' },
          { id: 'figures', label: 'Figures only', example: '1.000 lei', rule: 'Write amounts as figures only.' },
        ],
      },
      {
        key: 'parties',
        label: 'Parties',
        options: [
          { id: 'shortForm', label: 'Name, then short form', example: '…, denumit în continuare „Prestatorul”', rule: 'Name each party in full once, give it a short form in quotation marks, and use the short form everywhere after that.' },
          { id: 'full', label: 'Full name throughout', example: 'SC EXEMPLU SRL se obligă…', rule: 'Refer to each party by its full name throughout, without introducing a short form.' },
        ],
      },
      {
        key: 'definedTerms',
        label: 'Defined terms',
        options: [
          { id: 'on', label: 'Capitalised', example: 'Informații Confidențiale', rule: 'Capitalise defined terms wherever they appear, and define each one on its first use.' },
          { id: 'off', label: 'Plain', example: 'informații confidențiale', rule: 'Do not capitalise defined terms.' },
        ],
      },
      {
        key: 'language',
        label: 'Language',
        options: [
          { id: 'ro', label: 'Romanian', example: 'Contract de prestări servicii', rule: 'Write every document in Romanian, with correct diacritics (ș, ț, ă, î, â).' },
          { id: 'en', label: 'English', example: 'Services Agreement', rule: 'Write every document in English.' },
          { id: 'auto', label: 'Match the request', example: '', rule: 'Write in whichever language the request is written in.' },
        ],
      },
    ],
  },
];

export const DEFAULT_RULES = {
  sectionHeading: 'art',
  headingCase: 'upper',
  clauseNumber: 'dotted',
  subPoint: 'letterParen',
  deepPoint: 'romanLower',
  blanks: 'underscores',
  bullet: 'dash',
  restart: 'perSection',
  clauseNames: 'off',
  dates: 'numeric',
  amounts: 'figuresWords',
  parties: 'shortForm',
  definedTerms: 'on',
  language: 'ro',
  extra: '',
  enabled: true,
};

const FIELDS = RULE_GROUPS.flatMap((g) => g.fields);

export function fieldFor(key) {
  return FIELDS.find((f) => f.key === key) || null;
}
export function optionFor(key, id) {
  const f = fieldFor(key);
  return f ? f.options.find((o) => o.id === id) || f.options[0] : null;
}

// Anything unrecognised — an older stored object, a hand-edited one — falls
// back to the default for that rule rather than being dropped or trusted.
export function normalizeRules(raw) {
  const out = { ...DEFAULT_RULES };
  if (!raw || typeof raw !== 'object') return out;
  for (const f of FIELDS) {
    const v = raw[f.key];
    if (f.options.some((o) => o.id === v)) out[f.key] = v;
  }
  out.extra = String(raw.extra || '').slice(0, 2000);
  out.enabled = raw.enabled !== false;
  return out;
}

export function loadDocRules() {
  try {
    return normalizeRules(JSON.parse(localStorage.getItem(KEY) || 'null'));
  } catch {
    return { ...DEFAULT_RULES };
  }
}

export function saveDocRules(rules) {
  const next = normalizeRules(rules);
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* full or blocked */ }
  invalidateDocRules();
  return next;
}

// ── The example document the page draws ─────────────────────────────────────
// Rules about numbering are unreadable as prose and obvious as a skeleton, so
// the page shows the settings applied to one.
const ROMAN = ['I', 'II', 'III', 'IV', 'V'];
const sectionLabel = (rules, n, name) => {
  const title = rules.headingCase === 'upper' ? name.toUpperCase()
    : rules.headingCase === 'title' ? name.replace(/\b\p{Ll}/gu, (c) => c.toUpperCase())
      : name;
  switch (rules.sectionHeading) {
    case 'capitol': return `CAPITOLUL ${ROMAN[n - 1] || n} — ${title.toUpperCase()}`;
    case 'sectiunea': return `Secțiunea ${n}. ${title}`;
    case 'number': return `${n}. ${title}`;
    case 'roman': return `${ROMAN[n - 1] || n}. ${title}`;
    case 'plain': return title;
    default: return `Art. ${n} ${title}`;
  }
};
const clauseLabel = (rules, sec, i, running) => {
  const n = rules.restart === 'continuous' ? running : i;
  switch (rules.clauseNumber) {
    case 'dottedBare': return rules.restart === 'continuous' ? `${n}` : `${sec}.${i}`;
    case 'paren': return `(${n})`;
    case 'number': return `${n}.`;
    case 'none': return '';
    default: return rules.restart === 'continuous' ? `${n}.` : `${sec}.${i}.`;
  }
};
const LETTERS = ['a', 'b', 'c', 'd'];
const ROMANS = ['i', 'ii', 'iii', 'iv'];
// How an unfilled fact is written. The point of the choice is that the shape is
// UNMISTAKABLE in the text — see the note on fonts at the foot of this file.
export const blankFor = (id) => {
  switch (id) {
    case 'dots': return '.........';
    case 'bracket': return '[_____]';
    case 'bracketDots': return '[.........]';
    default: return '_____';
  }
};

const markerFor = (id, i) => {
  switch (id) {
    case 'letterDot': return `${LETTERS[i]}.`;
    case 'letterBoth': return `(${LETTERS[i]})`;
    case 'romanLower': return `${ROMANS[i]})`;
    case 'dash': return '-';
    case 'bullet': return '•';
    case 'star': return '*';
    case 'none': return '';
    default: return `${LETTERS[i]})`;
  }
};

// [{ level, text }] — the preview's lines, ready to render.
export function rulesOutline(rules) {
  const r = normalizeRules(rules);
  const ro = r.language !== 'en';
  const T = ro ? {
    s1: 'Obiectul contractului', s2: 'Prețul și modalitatea de plată',
    c11: 'Prestatorul se obligă să presteze serviciile descrise în Anexa 1',
    c12: 'Beneficiarul se obligă să pună la dispoziție documentele necesare',
    c21: 'Prețul serviciilor este de 1.000 lei (una mie lei)',
    subs: ['să predea documentele în original', 'să comunice orice modificare'],
    deep: 'în termen de 5 zile lucrătoare de la solicitare',
    name1: 'Obligațiile prestatorului', name2: 'Obligațiile beneficiarului', name3: 'Prețul',
    name4: 'Durata', blankWords: ['durată', 'dată'],
    listLead: 'Plata se face pe baza următoarelor documente',
    docs: ['factura fiscală', 'raportul de activitate'],
    c31: (a, b) => `Prezentul contract se încheie pe o durată de ${a} luni, începând cu data de ${b}`,
    s3: 'Durata contractului',
  } : {
    s1: 'Subject of the agreement', s2: 'Price and payment',
    c11: 'The provider shall supply the services described in Schedule 1',
    c12: 'The client shall make the necessary documents available',
    c21: 'The price for the services is 1,000 lei (one thousand lei)',
    subs: ['deliver the original documents', 'notify any change'],
    deep: 'within 5 working days of the request',
    name1: 'Provider’s obligations', name2: 'Client’s obligations', name3: 'Price',
    name4: 'Term', blankWords: ['term', 'date'],
    listLead: 'Payment is made against the following documents',
    docs: ['the invoice', 'the activity report'],
    c31: (a, b) => `This agreement is made for a term of ${a} months, beginning on ${b}`,
    s3: 'Term',
  };
  const named = (label, name, text) => {
    const lead = r.clauseNames === 'on' ? `${name}. ` : '';
    // A clause that already ends on its own punctuation — a colon opening a
    // list — is not given a second full stop.
    const stop = /[.:;]$/.test(text) ? '' : '.';
    return `${label ? `${label} ` : ''}${lead}${text}${stop}`;
  };
  const out = [
    { level: 0, text: sectionLabel(r, 1, T.s1) },
    { level: 1, text: named(clauseLabel(r, 1, 1, 1), T.name1, T.c11) },
  ];
  if (r.subPoint) {
    T.subs.forEach((t, i) => out.push({ level: 2, text: `${markerFor(r.subPoint, i)} ${t};` }));
    if (r.deepPoint !== 'none') {
      out.push({ level: 3, text: `${markerFor(r.deepPoint, 0)} ${T.deep}.` });
    }
  }
  out.push({ level: 1, text: named(clauseLabel(r, 1, 2, 2), T.name2, T.c12) });
  out.push({ level: 0, text: sectionLabel(r, 2, T.s2) });
  out.push({ level: 1, text: named(clauseLabel(r, 2, 1, 3), T.name3, T.c21) });
  // A plain list — one whose order and lettering carry no meaning — so that
  // choice is on screen too rather than being set blind.
  out.push({ level: 1, text: named(clauseLabel(r, 2, 2, 4), T.name3, `${T.listLead}:`) });
  T.docs.forEach((t, i) => out.push({ level: 2, text: `${markerFor(r.bullet, i)} ${t};` }));
  // A clause with facts nobody has given yet, so the shape of a blank is on
  // screen beside the numbering it will be written among.
  out.push({ level: 0, text: sectionLabel(r, 3, T.s3) });
  out.push({
    level: 1,
    text: named(clauseLabel(r, 3, 1, 5), T.name4,
      T.c31(blankFor(r.blanks, T.blankWords[0]), blankFor(r.blanks, T.blankWords[1]))),
  });
  return out;
}

// ── What the model is told ──────────────────────────────────────────────────
// One block, in the same shape as the writing-style block it travels beside:
// bracketed, addressed to the model, and explicit that the request outranks it.
export function buildDocRulesSteer(rules) {
  const r = normalizeRules(rules);
  if (!r.enabled) return '';
  const say = (key) => optionFor(key, r[key])?.rule || '';
  const structure = ['sectionHeading', 'headingCase', 'clauseNumber', 'subPoint', 'deepPoint', 'blanks', 'bullet', 'restart', 'clauseNames']
    .map(say).filter(Boolean);
  const conventions = ['dates', 'amounts', 'parties', 'definedTerms', 'language']
    .map(say).filter(Boolean);
  const extra = String(r.extra || '').trim();
  if (!structure.length && !conventions.length && !extra) return '';
  const lines = [
    '[Document rules — set by this user. Every document you write or revise for them must follow these exactly, so that two documents from this office are laid out the same way. They govern LAYOUT AND WORDING CONVENTIONS only, never legal substance. An explicit instruction in the request wins over any rule here.',
    '',
  ];
  if (structure.length) lines.push('Structure and numbering', ...structure.map((l) => `- ${l}`), '');
  if (conventions.length) lines.push('Conventions', ...conventions.map((l) => `- ${l}`), '');
  if (extra) lines.push('Also', extra, '');
  lines.push('Apply the numbering rules to the document you produce, not to your reply about it.]');
  return lines.join('\n');
}

// Cached like the style block: it is read on every drafting turn and only ever
// changes when the user edits the page.
let cached = null;
export function invalidateDocRules() { cached = null; }
export function docRulesSteer() {
  if (cached == null) cached = buildDocRulesSteer(loadDocRules());
  return cached;
}

// ── Why this is a character, and not a font ────────────────────────────────
// The obvious idea is a custom font whose blank glyph is unmistakable. It does
// not work, for two separate reasons.
//
// The model never sees the font. What reaches it is TEXT — a sequence of
// codepoints — and the font is a rendering instruction that is stripped long
// before that. Two documents, one in Times and one in a bespoke face, are the
// same characters and read identically to it.
//
// And a font would not survive the document either. Word renders a font only
// if it is installed on the reader's machine or embedded in the file, and even
// an embedded one falls back to Word's substitution when it cannot be used —
// so a blank drawn in a bespoke face reaches the other side as a substituted
// glyph. A document that has to open on a court's computer cannot depend on it.
//
// The instinct behind the idea is right, though, and is used where it belongs:
// a Word template's blanks are usually not characters at all but an underlined
// run of spaces, which no text pattern can see — `drawnBlanks` in the Doc
// Viewer reads that FORMATTING out of the rendered document. And the right
// structural marker, if DocVex's own documents ever need one, is a character
// style or a content control: same idea as a font, but it carries a NAME and
// survives a round trip through Word.
//
// WHAT THE OPTIONS ARE, AND WHY THEY ARE UNNAMED. A named token ("[[nume]]")
// is the only shape that is not merely found but UNDERSTOOD — `parseFieldToken`
// reads "[[vanzator.legalName]]" as a party's field and an identity record
// fills it. It is no longer offered here: the rule is for what the AI WRITES,
// and the design settled on is an unmistakable gap plus a second pass that
// works out what belongs in it (`ensureFieldSuggestions`). Every shape below is
// still RECOGNISED wherever it appears — see BLANK_PATTERNS in docConstructor, which reads named
// tokens, angle brackets, braces and dot leaders whoever wrote them.
