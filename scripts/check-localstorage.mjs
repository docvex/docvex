#!/usr/bin/env node
// Fails (exit 1) when code writes a key to localStorage that is not a UI
// preference — i.e. whose key does not start with one of
// ALLOWED_LOCALSTORAGE_PREFIXES in src/lib/secureStore.js, or that starts with
// one of its SECURE_PREFIXES. Content and personal data belong in the
// encrypted store (lib/secureStore), never in Chromium's plaintext LevelDB.
//
// A static scan: for every `localStorage.setItem(` in src/**/*.js(x) the key
// argument is read as a string literal, a template literal (its text up to the
// first `${`), or an identifier / call resolved to such a literal in the same
// file (`const KEY = '…'`, `const keyFor = (id) => \`…${id}\``,
// `function keyFor(id) { return '…' + id; }`, `KEY + id`). A write that cannot
// be resolved fails too. Escape hatch: `// secure-store-ok` on the line (or
// the line above) — for a key built somewhere this scan cannot follow.
//
//   node scripts/check-localstorage.mjs      (npm run check:storage)

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'src');

// Read the two prefix lists straight out of the module's source (it is an ES
// module written for the renderer; no need to load it).
function readList(text, name) {
  const m = new RegExp(`export const ${name} = Object\\.freeze\\(\\[([\\s\\S]*?)\\]\\)`).exec(text);
  if (!m) throw new Error(`secureStore.js: ${name} not found`);
  return [...m[1].matchAll(/'([^']*)'|"([^"]*)"/g)].map((x) => x[1] ?? x[2]);
}
const storeSrc = readFileSync(path.join(src, 'lib/secureStore.js'), 'utf8');
const ALLOWED = readList(storeSrc, 'ALLOWED_LOCALSTORAGE_PREFIXES');
const SECURE = readList(storeSrc, 'SECURE_PREFIXES');

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(jsx?|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

// The first argument of a call starting at `i` (just after the `(`).
function firstArg(text, i) {
  let depth = 0; let q = null; let out = '';
  for (; i < text.length; i += 1) {
    const c = text[i];
    if (q) {
      out += c;
      if (c === '\\') { out += text[i + 1]; i += 1; continue; }
      if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { q = c; out += c; continue; }
    if ('([{'.includes(c)) depth += 1;
    if (')]}'.includes(c)) { if (depth === 0) break; depth -= 1; }
    if (c === ',' && depth === 0) break;
    out += c;
  }
  return out.trim();
}

// The literal prefix an expression starts with, or null.
function literalPrefix(expr, file, seen = new Set()) {
  const e = expr.trim().replace(/^\(+/, '');
  let m = /^(['"])((?:\\.|(?!\1).)*)\1/.exec(e);
  if (m) return m[2];
  // A template: its text up to the first `${`; one opening with `${X}` is X's
  // prefix followed by the rest.
  m = /^`\$\{\s*([A-Za-z_$][\w$]*)\s*\}([^`$]*)/.exec(e);
  if (m) { const head = literalPrefix(m[1], file, seen); return head == null ? null : head + m[2]; }
  m = /^`([^`$]*)/.exec(e);
  if (m) return m[1];
  // `String(x)` / `x.trim()` — nothing to go on.
  m = /^([A-Za-z_$][\w$]*)(?:\s*\(|\b)/.exec(e);
  if (!m) return null;
  const id = m[1];
  if (seen.has(id)) return null;
  seen.add(id);
  const decl = new RegExp(`(?:const|let|var)\\s+${id}\\s*=\\s*([^;\\n]+)`).exec(file);
  if (decl) {
    let rhs = decl[1].trim();
    // An arrow function: its body.
    const arrow = /^(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*(.+)$/.exec(rhs);
    if (arrow) rhs = arrow[1];
    return literalPrefix(rhs, file, seen);
  }
  const fn = new RegExp(`function\\s+${id}\\s*\\([^)]*\\)\\s*\\{[^}]*?return\\s+([^;\\n]+)`).exec(file);
  if (fn) return literalPrefix(fn[1], file, seen);
  return null;
}

const failures = [];
let checked = 0;
// The main process has no user content in localStorage; its one write copies
// the renderer's storage between origins (src/main.js migrateOriginStorage).
const SKIP = new Set(['main.js', 'preload.js', 'backgroundWorker.js'].map((n) => path.join(src, n)));
for (const file of walk(src)) {
  if (SKIP.has(file)) continue;
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');
  const re = /localStorage\s*\.\s*setItem\s*\(/g;
  let m;
  while ((m = re.exec(text))) {
    const lineNo = text.slice(0, m.index).split('\n').length;
    const line = lines[lineNo - 1] || '';
    // A comment mentioning the call is not a call.
    const before = line.slice(0, line.indexOf('localStorage'));
    if (/\/\/|^\s*\*/.test(before)) continue;
    checked += 1;
    if (/secure-store-ok/.test(line) || /secure-store-ok/.test(lines[lineNo - 2] || '')) continue;
    const arg = firstArg(text, m.index + m[0].length);
    const prefix = literalPrefix(arg, text);
    const rel = path.relative(root, file);
    if (prefix == null) { failures.push(`${rel}:${lineNo}  cannot tell the key of localStorage.setItem(${arg})`); continue; }
    if (SECURE.some((p) => prefix.startsWith(p) || (prefix.length >= 8 && p.startsWith(prefix)))) {
      failures.push(`${rel}:${lineNo}  "${prefix}…" is content / personal data — use lib/secureStore`);
      continue;
    }
    if (!ALLOWED.some((p) => prefix.startsWith(p))) {
      failures.push(`${rel}:${lineNo}  "${prefix}…" is not in ALLOWED_LOCALSTORAGE_PREFIXES (lib/secureStore.js)`);
    }
  }
}

if (failures.length) {
  console.error(`check-localstorage: ${failures.length} write(s) to localStorage with a key that is not allowed:\n`);
  for (const f of failures) console.error(`  ${f}`);
  console.error('\nContent and personal data go to lib/secureStore (encrypted). A UI preference: add its prefix to ALLOWED_LOCALSTORAGE_PREFIXES.');
  process.exit(1);
}
console.log(`check-localstorage: ${checked} localStorage.setItem call(s), all keys allowed.`);
