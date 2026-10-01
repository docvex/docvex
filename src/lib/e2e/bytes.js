// Byte helpers for lib/e2e — no dependencies, works in the renderer and in
// Node (tests). Base64 is the standard alphabet with padding unless `url`.

export const utf8 = {
  enc: (s) => new TextEncoder().encode(String(s)),
  dec: (u8) => new TextDecoder().decode(u8),
};

export function toBytes(x) {
  if (x instanceof Uint8Array) return x;
  if (x instanceof ArrayBuffer) return new Uint8Array(x);
  if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
  if (typeof x === 'string') return utf8.enc(x);
  throw new TypeError('bytes expected');
}

export function b64enc(u8) {
  const b = toBytes(u8);
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}
export function b64dec(s) {
  const str = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = str + '==='.slice((str.length + 3) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}
export const b64urlenc = (u8) => b64enc(u8).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const b64urldec = b64dec;

export function concat(...parts) {
  const bs = parts.map(toBytes);
  const out = new Uint8Array(bs.reduce((n, b) => n + b.length, 0));
  let o = 0;
  for (const b of bs) { out.set(b, o); o += b.length; }
  return out;
}

export const randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));

export function randomId(bytes = 16) {
  return Array.from(randomBytes(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function equalBytes(a, b) {
  const x = toBytes(a); const y = toBytes(b);
  if (x.length !== y.length) return false;
  let d = 0;
  for (let i = 0; i < x.length; i += 1) d |= x[i] ^ y[i];
  return d === 0;
}

// Canonical JSON (keys sorted, recursively) — what a signature is made over,
// so the same object always signs the same bytes whatever order it was built in.
export function canonicalJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
}
