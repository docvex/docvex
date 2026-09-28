// What the vault does to a REQUEST and to a STREAMED ANSWER — pure functions,
// no storage, no window (lib/pseudonymize/transport wires them into
// lib/projectAi; tests/pseudonymize.test.mjs runs them under Node).

import { TOKEN_TYPES } from './vault';

// Keys whose strings are structure, not content: never masked.
const STRUCTURAL = new Set([
  'action', 'model', 'jurisdiction', 'tools', 'docTools', 'forceDocument', 'docKind', 'effort',
  'stream', 'warm', 'id', 'role', 'type', 'tool_use_id', 'media_type', 'usageProject', 'usageAction',
  'method', 'stop_reason', 'cache_control',
]);
// A block that carries bytes (a picture, a PDF) — passed through untouched:
// masking base64 could "find" an IBAN inside it and corrupt the file.
const isBinaryBlock = (v) => v.type === 'image' || v.type === 'document' || (v.source && typeof v.source === 'object');

/**
 * Mask every CONTENT string of a request body — message texts, tool inputs and
 * results, the stable context, file texts and names, passports — leaving its
 * structure (model, tools, ids, roles, block types) and binary blocks as they
 * are.
 * @param {any} body
 * @param {{ mask(text: string, opts?: object): string }} vault
 * @param {{ detectors?: Function[] }} [opts] — this call's extra detectors (Layer 3)
 */
export function maskBody(body, vault, opts) {
  const walk = (v, key) => {
    if (typeof v === 'string') return STRUCTURAL.has(key) ? v : vault.mask(v, opts);
    if (Array.isArray(v)) return v.map((x) => walk(x, key));
    if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
      if (isBinaryBlock(v)) return v;
      const out = {};
      for (const [k, x] of Object.entries(v)) out[k] = walk(x, k);
      return out;
    }
    return v;
  };
  return walk(body, '');
}

// How much of a streamed text's END could be the start of a token still
// arriving: an unclosed "[" (within a token's reach) or a trailing run that
// is a prefix of TYPE_NN.
const MAX_TOKEN = 100;
export function heldBack(raw) {
  let hold = 0;
  const open = raw.lastIndexOf('[');
  if (open >= 0 && open > raw.lastIndexOf(']') && raw.length - open <= MAX_TOKEN && !raw.slice(open).includes('\n')) hold = raw.length - open;
  const m = /(?:^|[^A-Za-z0-9_])([A-Z]{1,8}(?:_\d{0,4})?)$/.exec(raw);
  if (m) {
    const cap = m[1];
    const partial = TOKEN_TYPES.some((t) => `${t}_`.startsWith(cap) || (cap.startsWith(`${t}_`) && /^\d{0,4}$/.test(cap.slice(t.length + 1))));
    if (partial) hold = Math.max(hold, cap.length);
  }
  return hold;
}

/**
 * Re-identify a streamed answer as it arrives, never splitting a token: what
 * could still be a token's start is held back until the next piece (or the
 * end) says what it is. `onText(piece, soFar)` sees re-identified text only.
 * @param {{ reidentify(text: string): string }} vault
 * @param {(piece: string, soFar: string) => void} [onText]
 */
export function makeStreamReidentifier(vault, onText) {
  let raw = '';
  let shown = '';
  const emit = (upto) => {
    const next = vault.reidentify(raw.slice(0, upto));
    if (next.length > shown.length && next.startsWith(shown)) {
      const piece = next.slice(shown.length);
      shown = next;
      onText?.(piece, shown);
    } else if (next !== shown) {
      // Never expected (tokens are held whole), but never show a wrong prefix.
      shown = next;
      onText?.('', shown);
    }
  };
  return {
    push(piece) { raw += piece; emit(raw.length - heldBack(raw)); },
    end() { emit(raw.length); return shown; },
    get text() { return shown; },
  };
}

/**
 * The TEXT of a request body as it went out (content strings only, binary
 * blocks named, not included) — for the "What was sent" log.
 * @param {any} body @param {number} [max]
 */
export function bodyText(body, max = 4000) {
  const parts = [];
  let size = 0;
  const walk = (v, key) => {
    if (size >= max) return;
    if (typeof v === 'string') {
      if (!STRUCTURAL.has(key) && v.trim()) { parts.push(v); size += v.length + 2; }
      return;
    }
    if (Array.isArray(v)) { v.forEach((x) => walk(x, key)); return; }
    if (v && typeof v === 'object') {
      if (isBinaryBlock(v)) { parts.push(`[${v.type || 'binary'} not shown]`); size += 20; return; }
      for (const [k, x] of Object.entries(v)) walk(x, k);
    }
  };
  walk(body, '');
  const text = parts.join('\n\n');
  return text.length > max ? `${text.slice(0, max)}\u2026` : text;
}
