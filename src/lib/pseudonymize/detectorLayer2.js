// LAYER 2 — the NAMES of people and companies the project already knows (its
// data collections' records, the parties the AI scan read), found in a text.
//
// A person is found by their WHOLE name — every word of it, in any order
// ("Ana Maria Popescu", "POPESCU ANA MARIA", "Popescu Ana-Maria"), the last
// word also in a declined form ("Mariei", "Popescului") — never by one word:
// a surname alone is a street, a village or someone else. A company by its
// name without the legal form, in order, with the "SC" before it and the
// "SRL / SA / …" after it taken into the span when they are there; a
// one-word company name only next to its legal form.
//
// Matching runs on a FOLDED copy of the text of the same length (case,
// diacritics — ș/ş/s, ț/ţ/t, ă/â/a, î/i — folded character by character), so
// every match maps straight back onto the original.
//
// Each span carries `link` to the entity's CNP / CUI when it is known, so the
// vault numbers the name and the identifier as one entity (the caller also
// registers those pairs up front with `vault.link`).

import { decodeCnp } from '../roIdDocuments';
import { cuiValid } from '../lawRefs';

/**
 * @typedef {{ kind: 'person'|'company', name: string, cnp?: string, cui?: string }} KnownEntity
 */

// One character → one character (lower case, no diacritics).
const foldChar = (ch) => {
  const base = ch.normalize('NFD')[0] || ch;
  const low = base.toLowerCase();
  return low.length === 1 ? low : base;
};
export const foldSameLength = (text) => {
  let out = '';
  for (const ch of String(text || '')) out += ch.length === 1 ? foldChar(ch) : ch;
  return out;
};

const LEGAL_FORMS = new Set(['sc', 'srl', 'sa', 'srld', 'snc', 'scs', 'sca', 'pfa', 'ii', 'if', 'ong', 'sl', 'd']);
// The legal form around a company's name, on the FOLDED text.
const FORM_BEFORE = /(?:^|[^a-z0-9])(s\.?\s?c\.?\s+)$/;
const FORM_AFTER = /^\s*,?\s*(?:s\.?\s?r\.?\s?l\.?(?:\s?-?\s?d\.?)?|s\.?\s?a\.?|s\.?\s?n\.?\s?c\.?|s\.?\s?c\.?\s?s\.?|s\.?\s?c\.?\s?a\.?|p\.?\s?f\.?\s?a\.?|i\.?\s?i\.?|i\.?\s?f\.?)(?![a-z0-9])/;
// Endings a Romanian name takes in the genitive / dative / with the article.
const SUFFIXES = ['ului', 'lui', 'ei', 'ii', 'ul', 'a', 'i'];
const wordsOf = (s) => foldSameLength(s).split(/[^a-z0-9]+/).filter(Boolean);

/** The bases a (last) word may stand for: itself, and undeclined forms. */
function declined(word) {
  const out = [word];
  for (const suf of SUFFIXES) {
    if (word.length > suf.length + 2 && word.endsWith(suf)) {
      const base = word.slice(0, -suf.length);
      out.push(base, `${base}u`, `${base}a`, `${base}e`);
    }
  }
  return out;
}

/**
 * The detector for a list of known entities.
 * @param {KnownEntity[]} entities
 * @returns {(text: string) => Array<{ start: number, end: number, type: 'PERSOANA'|'FIRMA', value: string, meta: string[], link?: { type: 'CNP'|'CUI', value: string } }>}
 */
export function makeLayer2(entities) {
  const people = [];
  const companies = [];
  for (const e of entities || []) {
    const name = String(e?.name || '').trim();
    if (!name) continue;
    if (e.kind === 'company') {
      const core = wordsOf(name).filter((w) => !LEGAL_FORMS.has(w.replace(/\./g, '')));
      if (!core.length || (core.length === 1 && core[0].length < 4)) continue;
      const cui = String(e.cui || '').replace(/^RO/i, '').replace(/\D/g, '');
      companies.push({ name, core, link: cui && cuiValid(cui) ? { type: 'CUI', value: cui } : null });
    } else {
      const words = wordsOf(name).filter((w) => w.length >= 2);
      if (words.length < 2) continue;   // one word is never enough to name a person
      const cnp = String(e.cnp || '').replace(/\D/g, '');
      people.push({ name, words, sorted: [...words].sort().join(' '), link: cnp.length === 13 && decodeCnp(cnp).valid ? { type: 'CNP', value: cnp } : null });
    }
  }
  if (!people.length && !companies.length) return () => [];
  const personWords = new Set(people.flatMap((p) => p.words));
  const sizes = [...new Set(people.map((p) => p.words.length))];
  const bySorted = new Map(people.map((p) => [p.sorted, p]));

  return (text) => {
    const t = String(text || '');
    if (!t) return [];
    const folded = foldSameLength(t);
    // The words of the text with where they are, and whether the gap before
    // each joins it to the previous one (spaces, hyphens, underscores only).
    const tokens = [];
    for (const m of folded.matchAll(/[a-z0-9]+/g)) {
      const prev = tokens[tokens.length - 1];
      const gap = prev ? folded.slice(prev.end, m.index) : '';
      tokens.push({ w: m[0], start: m.index, end: m.index + m[0].length, joined: !!prev && /^[\s_-]{1,3}$/.test(gap) && !gap.includes('\n\n') });
    }
    const out = [];

    // People: a run of n joined words whose set is a known name.
    for (let i = 0; i < tokens.length; i += 1) {
      if (!personWords.has(tokens[i].w) && !declined(tokens[i].w).some((b) => personWords.has(b))) continue;
      for (const n of sizes) {
        if (i + n > tokens.length) continue;
        let joined = true;
        for (let k = i + 1; k < i + n; k += 1) if (!tokens[k].joined) { joined = false; break; }
        if (!joined) continue;
        const head = tokens.slice(i, i + n - 1).map((x) => x.w);
        const last = tokens[i + n - 1].w;
        const hit = declined(last).map((b) => bySorted.get([...head, b].sort().join(' '))).find(Boolean);
        if (hit) out.push({ start: tokens[i].start, end: tokens[i + n - 1].end, type: 'PERSOANA', value: hit.name, meta: [], ...(hit.link ? { link: hit.link } : {}) });
      }
    }

    // Companies: the core words in order, the legal form around them taken in.
    for (const c of companies) {
      const n = c.core.length;
      for (let i = 0; i + n <= tokens.length; i += 1) {
        let ok = true;
        for (let k = 0; k < n; k += 1) {
          const w = tokens[i + k].w;
          if (k > 0 && !tokens[i + k].joined) { ok = false; break; }
          if (w !== c.core[k] && !(k === n - 1 && declined(w).includes(c.core[k]))) { ok = false; break; }
        }
        if (!ok) continue;
        let start = tokens[i].start;
        let end = tokens[i + n - 1].end;
        // "S.C." / "SC" before, "S.R.L." / "SRL" / "SA"… after (dotted or not).
        const before = FORM_BEFORE.exec(folded.slice(Math.max(0, start - 10), start));
        const after = FORM_AFTER.exec(folded.slice(end, end + 16));
        if (before) start -= before[1].length;
        if (after) end += after[0].length;
        if (n === 1 && !before && !after) continue;   // a one-word name only beside its legal form
        out.push({ start, end, type: 'FIRMA', value: c.name, meta: [], ...(c.link ? { link: c.link } : {}) });
      }
    }
    return out;
  };
}

/**
 * The known entities from a project's records and the AI scan's parties.
 * @param {{ records?: any[], parties?: any[] }} src
 * @returns {KnownEntity[]}
 */
export function knownEntitiesFrom({ records = [], parties = [] } = {}) {
  const out = [];
  for (const r of records) {
    if (!r?.name) continue;
    if (r.kind === 'org') out.push({ kind: 'company', name: r.name, cui: r.taxId || '' });
    else if (r.kind === 'person') out.push({ kind: 'person', name: r.name, cnp: r.nationalId || '' });
  }
  for (const p of parties) {
    if (!p?.name) continue;
    const ids = (Array.isArray(p.identifiers) ? p.identifiers : []).map(String);
    const company = /company|org|firm|legal/i.test(String(p.kind || ''));
    if (company) {
      const cui = ids.map((x) => x.replace(/^.*?(?:RO)?\s*(\d{2,10})\D*$/i, '$1')).find((d) => /^\d{2,10}$/.test(d) && cuiValid(d)) || '';
      out.push({ kind: 'company', name: p.name, cui });
    } else {
      const cnp = ids.map((x) => (x.match(/(?<!\d)[1-9]\d{12}(?!\d)/) || [])[0]).find((d) => d && decodeCnp(d).valid) || '';
      out.push({ kind: 'person', name: p.name, cnp });
    }
  }
  return out;
}
