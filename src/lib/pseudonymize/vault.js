// THE VAULT — deterministic, per-project pseudonyms for what identifies a
// person or a company, kept ONLY on this machine.
//
// What goes to the AI carries tokens instead of the values: `[PERSOANA_07]`
// for a name, `[CNP_07 · F · 1985]` for that person's CNP, `[FIRMA_03]` /
// `[CUI_03]` for a company and its fiscal code, `[IBAN_02]`, `[CI_04]`,
// `[MRZ_01]`, `[TEL_01]`, `[EMAIL_01]`, `[ADRESA_05 · Constanța · Constanța]`.
// The AI's answer is put back (`reidentify`) before anything is stored.
//
// DETERMINISTIC: the same value (normalised — a CNP's digits, an IBAN in
// capitals without spaces, an e-mail in lower case, a name folded and its
// words sorted) always gets the same token in this project, in every call,
// forever — so masking again what was stored re-identified gives the same
// text, and the AI can still tell that two documents name the same person.
//
// ONE NUMBER PER ENTITY: a person's name, CNP and ID card share their number
// (PERSOANA_07 / CNP_07 / CI_07) once the vault knows they belong together
// (`link`), a company's name and CUI likewise (FIRMA_03 / CUI_03). The TYPE
// says which of the entity's values the token stands for, which is what lets
// `reidentify` put back exactly the right one.
//
// STORAGE is injected (`{ load(projectId) → string|null, save(projectId,
// string) }`): in the app it is main's `vault:get` / `vault:put`, a file under
// userData encrypted with Electron's safeStorage — never inside the case
// folder or .docvex/, which travel with the case (lib/pseudonymize/storage).
//
// Pseudonymised data is still personal data (GDPR art. 4(5)): this lowers
// what reaches the providers, it does not take the processing out of GDPR.

import { detectLayer1, pickSpans, protectedSpans } from './detectorLayer1';

/**
 * @typedef {'PERSOANA'|'CNP'|'CI'|'FIRMA'|'CUI'|'IBAN'|'MRZ'|'TEL'|'EMAIL'|'ADRESA'} TokenType
 * @typedef {{ load(projectId: string): Promise<string|null>|string|null, save(projectId: string, data: string): Promise<void>|void }} VaultStorage
 * @typedef {{ start: number, end: number, type: TokenType, value: string, meta?: string[], link?: { type: TokenType, value: string } }} MaskSpan
 * @typedef {(text: string) => MaskSpan[]} Detector
 */

// Which values count as one entity's (and so share its number).
const FAMILY = {
  PERSOANA: 'person', CNP: 'person', CI: 'person',
  FIRMA: 'company', CUI: 'company',
  IBAN: 'iban', MRZ: 'mrz', TEL: 'tel', EMAIL: 'email', ADRESA: 'address',
};
export const TOKEN_TYPES = Object.keys(FAMILY);

const COMPANY_FORMS = new Set(['sc', 'srl', 'sa', 'srld', 'snc', 'scs', 'sca', 'pfa', 'ii', 'if']);
const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[şș]/gi, 's').replace(/[ţț]/gi, 't').toLowerCase();

/** The form a value is compared in. @param {TokenType} type @param {string} value */
export function normalizeValue(type, value) {
  const v = String(value ?? '').trim();
  switch (type) {
    case 'CNP': case 'TEL': return v.replace(/\D/g, '');
    case 'CUI': return v.replace(/^RO/i, '').replace(/\D/g, '');
    case 'IBAN': case 'MRZ': return v.replace(/\s+/g, '').toUpperCase();
    case 'CI': return v.replace(/[\s.,:-]+/g, '').toUpperCase();
    case 'EMAIL': return v.toLowerCase();
    case 'PERSOANA':
      return fold(v).replace(/[^a-z0-9\s-]/g, ' ').split(/[\s-]+/).filter(Boolean).sort().join(' ');
    case 'FIRMA':
      // The legal form is not the name: "SC ALFA CONSTRUCT SRL" and "Alfa
      // Construct S.R.L." are one company (dotted forms fold to single letters).
      return fold(v).replace(/[^a-z0-9\s-]/g, ' ').split(/[\s-]+/)
        .filter((w) => w && w.length > 1 && !COMPANY_FORMS.has(w)).sort().join(' ');
    default: return fold(v).replace(/\s+/g, ' ');
  }
}

const pad = (n) => String(n).padStart(2, '0');
const tokenId = (type, n) => `${type}_${pad(n)}`;

// A token in an AI's answer — bracketed with its metadata, bracketed bare, or
// just TYPE_NN (a model may drop the brackets, the middle dot, the metadata).
const TOKEN_RE = new RegExp(String.raw`\[\s*(${TOKEN_TYPES.join('|')})_(\d{1,4})(?:\s*[·•|,;:\-–]\s*[^\]\n]{0,80})?\s*\]|\b(${TOKEN_TYPES.join('|')})_(\d{1,4})\b`, 'g');

export class Vault {
  /**
   * @param {{ projectId: string, storage?: VaultStorage|null, detectors?: Detector[] }} opts
   */
  constructor({ projectId, storage = null, detectors = [] }) {
    this.projectId = projectId;
    this.storage = storage;
    /** Extra detectors after Layer 1 (Layer 2 — known names — plugs in here). */
    this.detectors = detectors;
    this.reset();
    this.dirty = false;
    this.saving = null;
    /** Why the stored vault could not be read, if it could not. */
    this.storageError = null;
  }

  reset() {
    /** @type {Record<string, number>} family → last number given */
    this.counters = {};
    /** @type {Record<string, { family: string, n: number, values: Record<string, { value: string, meta: string[] }> }>} */
    this.entities = {};          // `${family}:${n}` → entity
    /** @type {Record<string, string>} `${TYPE}|${normalised}` → entity key */
    this.index = {};
    /**
     * Entities MERGED into another: dropped key → kept key. Kept for good, so a
     * token sent under the old number (a stored answer, a call in flight)
     * still re-identifies.
     * @type {Record<string, string>}
     */
    this.redirects = {};
  }

  /** An entity key after its redirects (a merged entity → the one kept). */
  resolveKey(key) {
    let k = key;
    for (let i = 0; i < 32 && this.redirects[k]; i += 1) k = this.redirects[k];
    return k;
  }

  /** Open a project's vault from storage. */
  static async open(projectId, { storage = null, detectors = [] } = {}) {
    const v = new Vault({ projectId, storage, detectors });
    if (storage) {
      try {
        const raw = await storage.load(projectId);
        if (raw) v.fromJSON(JSON.parse(raw));
      } catch (err) {
        // Unreadable, or storage refused (no OS encryption, an old preload):
        // the vault works in memory, and the transport treats it as
        // unavailable where a call must not go out without a lasting vault.
        v.storageError = String(err?.message || err || 'storage_error');
      }
    }
    return v;
  }

  // v2 adds `redirects` (merged entities); a v1 vault reads as one with none.
  toJSON() { return { v: 2, counters: this.counters, entities: this.entities, redirects: this.redirects }; }
  fromJSON(data) {
    this.reset();
    if (!data || (data.v !== 1 && data.v !== 2)) return;
    this.counters = { ...(data.counters || {}) };
    this.entities = { ...(data.entities || {}) };
    this.redirects = data.v === 2 ? { ...(data.redirects || {}) } : {};
    for (const [key, e] of Object.entries(this.entities)) {
      for (const [type, rec] of Object.entries(e.values || {})) {
        for (const alias of rec.aliases || [rec.value]) this.index[`${type}|${normalizeValue(type, alias)}`] = key;
      }
    }
  }

  /**
   * Written in the background after a change; await it where it matters.
   * Writes run one after another, each taking the state as it is when it
   * starts, so an older copy can never land after a newer one.
   */
  save() {
    if (!this.storage || !this.dirty) return this.saving || Promise.resolve();
    this.dirty = false;
    const run = async () => {
      try { await this.storage.save(this.projectId, JSON.stringify(this.toJSON())); } catch { this.dirty = true; }
    };
    const next = (this.saving || Promise.resolve()).then(run);
    this.saving = next;
    next.finally(() => { if (this.saving === next) this.saving = null; });
    return next;
  }

  entityKeyOf(type, value) {
    const key = this.index[`${type}|${normalizeValue(type, value)}`];
    return key ? this.resolveKey(key) : null;
  }

  /** Merge two entities of one family, keeping the lower number. → the kept key. */
  mergeEntities(a, b) {
    const ka = this.resolveKey(a); const kb = this.resolveKey(b);
    if (ka === kb) return ka;
    const ea = this.entities[ka]; const eb = this.entities[kb];
    if (!ea || !eb || ea.family !== eb.family) return ka;
    return ea.n <= eb.n ? this.merge(ka, kb) : this.merge(kb, ka);
  }

  /**
   * Fold `dropKey`'s values into `keepKey`: a value type the kept entity lacks
   * moves across; one it has keeps its canonical value and gains the dropped
   * one's spellings (and its metadata, if it had none). Every index entry and
   * earlier redirect pointing at the dropped entity is re-pointed, and the
   * dropped key redirects to the kept one for good.
   * @param {string} keepKey @param {string} dropKey @returns {string} the kept key
   */
  merge(keepKey, dropKey) {
    const keep = this.entities[keepKey]; const drop = this.entities[dropKey];
    if (!keep || !drop || keepKey === dropKey) return keepKey;
    for (const [type, rec] of Object.entries(drop.values || {})) {
      const mine = keep.values[type];
      if (!mine) { keep.values[type] = { ...rec, aliases: [...(rec.aliases || [rec.value])] }; continue; }
      mine.aliases = mine.aliases || [mine.value];
      for (const alias of rec.aliases || [rec.value]) {
        if (!mine.aliases.some((x) => normalizeValue(type, x) === normalizeValue(type, alias))) mine.aliases.push(alias);
      }
      if (!(mine.meta || []).length && (rec.meta || []).length) mine.meta = [...rec.meta];
    }
    for (const [k, v] of Object.entries(this.index)) if (v === dropKey) this.index[k] = keepKey;
    for (const [k, v] of Object.entries(this.redirects)) if (v === dropKey) this.redirects[k] = keepKey;
    this.redirects[dropKey] = keepKey;
    delete this.entities[dropKey];
    this.dirty = true;
    return keepKey;
  }

  /**
   * The token for a value — the same one every time. `link` names another
   * value of the SAME entity already met (a name for its CNP), so both share
   * one number.
   * @param {TokenType} type
   * @param {string} value
   * @param {string[]} [meta]
   * @param {{ link?: { type: TokenType, value: string } }} [opts]
   * @returns {string}
   */
  getOrCreateToken(type, value, meta = [], { link } = {}) {
    if (!FAMILY[type]) throw new Error(`Unknown token type ${type}`);
    const norm = normalizeValue(type, value);
    if (!norm) return String(value ?? '');
    const indexKey = `${type}|${norm}`;
    let key = this.index[indexKey] ? this.resolveKey(this.index[indexKey]) : null;
    const linkKey = link && FAMILY[link.type] === FAMILY[type] ? this.entityKeyOf(link.type, link.value) : null;
    if (!key && linkKey) key = linkKey;
    // Both already known, as two entities: they are one — merged, the lower
    // number kept.
    else if (key && linkKey && key !== linkKey) key = this.mergeEntities(key, linkKey);
    const family = FAMILY[type];
    if (!key) {
      const n = (this.counters[family] || 0) + 1;
      this.counters[family] = n;
      key = `${family}:${n}`;
      this.entities[key] = { family, n, values: {} };
    }
    const e = this.entities[key];
    const rec = e.values[type];
    if (!rec) e.values[type] = { value: String(value).trim(), meta: meta.filter(Boolean), aliases: [String(value).trim()] };
    else if (!rec.aliases.some((a) => normalizeValue(type, a) === norm)) rec.aliases.push(String(value).trim());
    // Registered without its metadata (linked up front, before the value was
    // met in a text): the first sighting that knows it fills it in.
    if (rec && !(rec.meta || []).length && meta.filter(Boolean).length) { rec.meta = meta.filter(Boolean); this.dirty = true; }
    if (this.index[indexKey] !== key) { this.index[indexKey] = key; this.dirty = true; }
    if (!rec) this.dirty = true;
    const shown = e.values[type].meta || [];
    return `[${tokenId(type, e.n)}${shown.length ? ` · ${shown.join(' · ')}` : ''}]`;
  }

  /** Tie two values of one entity together (a name and its CNP). */
  link(a, b) {
    // Whichever is known already gives the number; neither → a new one for
    // both; both, under two entities → merged (getOrCreateToken's link).
    const [first, second] = !this.entityKeyOf(a.type, a.value) && this.entityKeyOf(b.type, b.value) ? [b, a] : [a, b];
    this.getOrCreateToken(first.type, first.value, first.meta || []);
    this.getOrCreateToken(second.type, second.value, second.meta || [], { link: first });
  }

  /**
   * The real value behind a token, or null — "[CNP_07 · F · 1985]",
   * "[CNP_07]", "CNP_07" alike.
   * @param {string} token
   */
  resolveToken(token) {
    TOKEN_RE.lastIndex = 0;
    const m = TOKEN_RE.exec(String(token || ''));
    if (!m) return null;
    return this.valueOf(m[1] || m[3], Number(m[2] || m[4]));
  }

  valueOf(type, n) {
    const e = this.entities[this.resolveKey(`${FAMILY[type]}:${n}`)];
    return e?.values?.[type]?.value ?? null;
  }

  /**
   * Put the real values back into an AI's answer: strings, arrays and plain
   * objects walked to any depth (keys too). A token the vault never gave is
   * left as it is.
   * @template T @param {T} value @returns {T}
   */
  reidentify(value) {
    if (typeof value === 'string') {
      TOKEN_RE.lastIndex = 0;
      return value.replace(TOKEN_RE, (whole, t1, n1, t2, n2) => this.valueOf(t1 || t2, Number(n1 || n2)) ?? whole);
    }
    if (Array.isArray(value)) return value.map((v) => this.reidentify(v));
    if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
      const out = {};
      for (const [k, v] of Object.entries(value)) out[this.reidentify(k)] = this.reidentify(v);
      return out;
    }
    return value;
  }

  /**
   * Replace every identifier in a text with its token. Layer 1 first, then the
   * extra detectors; of overlapping spans the longer wins.
   * @param {string} text
   * @returns {string}
   */
  mask(text, { detectors: extra = [] } = {}) {
    const t = String(text ?? '');
    if (!t) return t;
    // Layer 1, then the vault's own (Layer 2, known names), then this call's
    // (Layer 3, guessed names): an equal span keeps the earlier detector's.
    // Citations of law, dates and amounts are off limits to EVERY layer.
    const protect = protectedSpans(t);
    const others = [...this.detectors, ...extra].flatMap((d) => d(t) || [])
      .filter((s) => !protect.some(([a, b]) => s.start < b && a < s.end));
    const spans = pickSpans([...detectLayer1(t, { protect }), ...others]);
    let out = '';
    let at = 0;
    for (const s of spans) {
      out += t.slice(at, s.start) + this.getOrCreateToken(s.type, s.value, s.meta || [], { link: s.link });
      at = s.end;
    }
    out += t.slice(at);
    if (this.dirty) void this.save();
    return out;
  }

  /** Mask every string inside a JSON-like value (a request body). */
  maskDeep(value, opts) {
    if (typeof value === 'string') return this.mask(value, opts);
    if (Array.isArray(value)) return value.map((v) => this.maskDeep(v, opts));
    if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = this.maskDeep(v, opts);
      return out;
    }
    return value;
  }

  /** Forget every mapping (and the stored copy). */
  async clear() {
    this.reset();
    this.dirty = true;
    await this.save();
  }
}
