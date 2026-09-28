// LAYER 3 — names the project does NOT know yet, found by the words that
// introduce them in Romanian legal prose. No lists of names, no model: a cue
// ("Subsemnatul", "domnul", "reprezentată prin", "Vânzător:"…) followed by 2–4
// capitalised (or ALL-CAPS) words is a person; a run of 1–5 capitalised words
// with "SC" before it or a legal form after it is a company. The name ends at
// the first word that isn't one (lower case, a comma, a cue, a word that is
// never part of a name — a month, a court, a county, a street type…).
//
// It runs AFTER Layer 2 (known names): a span the project knows wins over a
// guess of the same length. Its spans carry no link — linking a guessed name
// to an identifier is the vault's business once a record says so (`link`
// merges the two entities).
//
// A guess can miss (a name with no cue) and can over-reach (a capitalised
// title after "domnul"); it is a safety net under Layers 1 and 2, not a
// replacement for them.

const UP = 'A-ZĂÂÎȘȚŞŢ';
const LOW = 'a-zăâîșțşţ';
// One word of a name: "Popescu", "POPESCU", "Ana-Maria", "ANA-MARIA".
const WORD = `(?:[${UP}][${LOW}]+|[${UP}]{2,})(?:-(?:[${UP}][${LOW}]+|[${UP}]{2,}))?`;
const WORD_RE = new RegExp(`^${WORD}$`, 'u');

const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const set = (words) => new Set(words.split(/\s+/).filter(Boolean).map(fold));

// Words that are never part of a person's or a company's name.
const NEVER = set(`
  ianuarie februarie martie aprilie mai iunie iulie august septembrie octombrie noiembrie decembrie
  luni marti miercuri joi vineri sambata duminica
  legea legii codul codului tribunalul tribunalului judecatoria judecatoriei curtea curtii parchetul
  ministerul primaria prefectura politia agentia oficiul registrul consiliul guvernul romania romaniei
  republica uniunea europeana monitorul oficial contract contractul act actul anexa articolul art
  strada str aleea bulevardul bd bdul calea soseaua piata intrarea splaiul drumul fundatura sector sectorul
  judetul jud municipiul mun orasul comuna satul
  alba arad arges bacau bihor bistrita nasaud botosani braila brasov bucuresti buzau calarasi caras severin
  cluj constanta covasna dambovita dolj galati giurgiu gorj harghita hunedoara ialomita iasi ilfov
  maramures mehedinti mures neamt olt prahova salaj satu mare sibiu suceava teleorman timis tulcea
  valcea vaslui vrancea napoca timisoara craiova oradea ploiesti pitesti deva resita
  vanzator vanzatorul cumparator cumparatorul parat paratul parata reclamant reclamantul reclamanta
  client clientul beneficiar beneficiarul prestator prestatorul furnizor furnizorul locator locatar
  imprumutator imprumutat mandant mandatar debitor creditor subsemnatul subsemnata domnul doamna
  dl dna numitul numita societatea firma intre si sau cu prin catre pentru
  sc srl sa snc pfa ii if scs sca ong
`);

// Cues after which a PERSON's name follows.
const PERSON_AFTER = new RegExp(String.raw`(?:^|[^${LOW}${UP}])(subsemnat(?:ul|a)|domnul|doamna|dl\.|dna\.|d-l|d-na|numit(?:ul|a)|reprezentat[ăa]?\s+(?:legal\s+)?(?:prin|de\s+c[ăa]tre)|n[ăa]scut[ăa]?|fiul\s+lui|fiica\s+lui|mo[șş]tenitor(?:ul|oarea)|(?:v[âa]nz[ăa]tor|cump[ăa]r[ăa]tor|p[âa]r[âa]t|reclamant|client|beneficiar|locator|locatar|debitor|creditor)(?:ul|a)?\s*:)\s*`, 'giu');
// "…Maria Ionescu, în calitate de administrator": the name BEFORE the cue.
const PERSON_BEFORE = new RegExp(String.raw`((?:${WORD}\s+){1,3}${WORD})\s*,?\s+[îi]n\s+calitate\s+de`, 'gu');

const LEGAL_FORM = String.raw`(?:S\.?\s?R\.?\s?L\.?(?:\s?-?\s?D\.?)?|S\.?\s?A\.?|S\.?\s?N\.?\s?C\.?|S\.?\s?C\.?\s?S\.?|S\.?\s?C\.?\s?A\.?|P\.?\s?F\.?\s?A\.?|I\.?\s?I\.?|I\.?\s?F\.?)`;
const CO_WORD = `(?:[${UP}0-9][${LOW}${UP}0-9&.'-]*)`;
const COMPANY_FORM_AFTER = new RegExp(String.raw`((?:${CO_WORD}\s+){0,4}${CO_WORD})\s*,?\s*(${LEGAL_FORM})(?![${LOW}${UP}0-9])`, 'gu');
const COMPANY_SC_BEFORE = new RegExp(String.raw`(?:^|[^${LOW}${UP}])(S\.?\s?C\.?\s+)((?:${CO_WORD}\s+){0,4}${CO_WORD})`, 'gu');

// The name's words from `at`, while they are name words (2–4 of them).
function personAt(text, at) {
  const out = [];
  const re = /\S+/gu;
  re.lastIndex = at;
  let end = at;
  for (let m = re.exec(text); m && out.length < 4; m = re.exec(text)) {
    // Only single spaces between the words of one name.
    if (out.length && !/^ $/.test(text.slice(end, m.index))) break;
    const raw = m[0];
    const word = raw.replace(/[,;:.)]+$/, '');
    if (!WORD_RE.test(word) || NEVER.has(fold(word))) break;
    out.push(word);
    end = m.index + word.length;
    if (word !== raw) break;   // a comma / full stop after it ends the name
  }
  return out.length >= 2 ? { start: at, end, value: out.join(' ') } : null;
}

// Drop leading words that are never a name ("Furnizor Alfa" → "Alfa").
function trimCompany(text, start, end) {
  let s = start;
  for (;;) {
    const m = /^(\S+)\s+/u.exec(text.slice(s, end));
    if (!m || !NEVER.has(fold(m[1]))) break;
    s += m[0].length;
  }
  return s;
}

/**
 * Guessed names in a text.
 * @param {string} text
 * @returns {Array<{ start: number, end: number, type: 'PERSOANA'|'FIRMA', value: string, meta: string[] }>}
 */
export function detectLayer3(text) {
  const t = String(text || '');
  if (!t) return [];
  const out = [];
  PERSON_AFTER.lastIndex = 0;
  for (let m = PERSON_AFTER.exec(t); m; m = PERSON_AFTER.exec(t)) {
    const hit = personAt(t, m.index + m[0].length);
    if (hit) out.push({ ...hit, type: 'PERSOANA', meta: [] });
  }
  PERSON_BEFORE.lastIndex = 0;
  for (let m = PERSON_BEFORE.exec(t); m; m = PERSON_BEFORE.exec(t)) {
    // Re-read from the name's start so the NEVER words are honoured.
    const words = m[1].split(/\s+/);
    let start = m.index;
    while (words.length > 2 && NEVER.has(fold(words[0]))) start += words.shift().length + 1;
    const hit = personAt(t, start);
    if (hit) out.push({ ...hit, type: 'PERSOANA', meta: [] });
  }
  COMPANY_FORM_AFTER.lastIndex = 0;
  for (let m = COMPANY_FORM_AFTER.exec(t); m; m = COMPANY_FORM_AFTER.exec(t)) {
    const nameStart = trimCompany(t, m.index, m.index + m[1].length);
    if (nameStart >= m.index + m[1].length) continue;
    // "SC" before it belongs to the span too.
    const sc = /(S\.?\s?C\.?\s+)$/u.exec(t.slice(Math.max(0, nameStart - 6), nameStart));
    const start = sc ? nameStart - sc[1].length : nameStart;
    const end = m.index + m[0].length;
    const name = t.slice(nameStart, m.index + m[1].length).trim();
    if (!name || NEVER.has(fold(name))) continue;
    out.push({ start, end, type: 'FIRMA', value: `${name} ${m[2].replace(/\s+/g, '')}`, meta: [] });
  }
  COMPANY_SC_BEFORE.lastIndex = 0;
  for (let m = COMPANY_SC_BEFORE.exec(t); m; m = COMPANY_SC_BEFORE.exec(t)) {
    const start = m.index + m[0].length - m[1].length - m[2].length;
    // The name's words, stopping at one that is never a name.
    const words = m[2].split(/\s+/);
    const kept = [];
    for (const w of words) { if (NEVER.has(fold(w.replace(/[.,]+$/, '')))) break; kept.push(w); }
    if (!kept.length) continue;
    const name = kept.join(' ').replace(/[.,]+$/, '');
    out.push({ start, end: start + m[1].length + name.length, type: 'FIRMA', value: name, meta: [] });
  }
  return out;
}
