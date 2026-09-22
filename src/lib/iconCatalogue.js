// ── Every icon in the app, read out of the source ───────────────────────────
// The app has no icon library: its glyphs are inline JSX <svg> constants at the
// top of the file that uses them (see CLAUDE.md → Conventions). This finds them
// ALL by reading the renderer's own source (Vite `?raw` imports, loaded only
// when the Debug page asks) and turns each one back into markup that can be
// drawn — so the Debug tab's icon list is never out of date and needs no
// upkeep when an icon is added or changed.
//
// Each entry: { id, name, file, line, note, html }. `name` is what the icon is
// called in code (the constant, the `case '…':` label or the map key it sits
// under), `note` the comment written above it. JSX expressions the source
// computes at runtime ({size}, {color}, conditional children…) can't be
// evaluated here and are dropped, so an icon drawn from props shows its fixed
// parts only; `<svg {...p}>` / `<Svg>` wrappers get the common stroke defaults.

const SOURCES = import.meta.glob(['../**/*.jsx', '!../**/*.test.jsx'], { query: '?raw', import: 'default' });
const SVG_FILES = import.meta.glob('../**/*.svg', { query: '?url', import: 'default' });

const STROKE_DEFAULTS = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
const KEEP_CAMEL = new Set(['viewBox', 'gradientUnits', 'gradientTransform', 'preserveAspectRatio', 'patternUnits', 'patternContentUnits', 'patternTransform', 'maskUnits', 'clipPathUnits', 'markerWidth', 'markerHeight', 'refX', 'refY', 'textLength', 'lengthAdjust', 'stdDeviation', 'baseFrequency', 'numOctaves', 'filterUnits', 'primitiveUnits', 'spreadMethod', 'startOffset', 'pathLength']);

// Index just past the `}` that closes the `{` at `i` (strings skipped).
function skipBraces(src, i) {
  let depth = 0;
  for (let k = i; k < src.length; k += 1) {
    const c = src[k];
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      for (k += 1; k < src.length && src[k] !== q; k += 1) if (src[k] === '\\') k += 1;
      continue;
    }
    if (c === '{') depth += 1;
    else if (c === '}') { depth -= 1; if (depth === 0) return k + 1; }
  }
  return src.length;
}

function attrName(name) {
  if (name === 'className') return 'class';
  if (name === 'xlinkHref') return 'xlink:href';
  if (KEEP_CAMEL.has(name) || !/[A-Z]/.test(name)) return name;
  return name.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}

// JSX (one <svg>…</svg> block) → HTML the browser can draw.
function jsxToHtml(jsx) {
  let out = '';
  let spread = false;
  let i = 0;
  while (i < jsx.length) {
    const c = jsx[i];
    if (c === '{') {
      // A JSX expression: `{/* comment */}`, `{...spread}` or a runtime value —
      // none of which can be drawn here.
      const end = skipBraces(jsx, i);
      if (/^\{\s*\.\.\./.test(jsx.slice(i, end))) spread = true;
      i = end;
      continue;
    }
    if (c === '<') {
      const m = /^<\/?\s*([A-Za-z][\w.:-]*)?/.exec(jsx.slice(i));
      const tag = m?.[1] || '';
      const closing = jsx[i + 1] === '/';
      // Fragments and components (<Foo />) drop out; their children stay.
      const keep = tag && (/^[a-z]/.test(tag) || tag === 'Svg');
      let k = i + (m ? m[0].length : 1);
      let attrs = '';
      while (k < jsx.length && jsx[k] !== '>') {
        if (jsx[k] === '/' && jsx[k + 1] === '>') break;
        if (jsx[k] === '{') {
          const end = skipBraces(jsx, k);
          if (/^\{\s*\.\.\./.test(jsx.slice(k, end))) spread = true;
          k = end;
          continue;
        }
        const a = /^([A-Za-z_:][\w:.-]*)(?:\s*=\s*)?/.exec(jsx.slice(k));
        if (!a) { k += 1; continue; }
        k += a[0].length;
        const name = a[1];
        let value = null;
        if (a[0].includes('=')) {
          if (jsx[k] === '"' || jsx[k] === "'") {
            const q = jsx[k];
            const end = jsx.indexOf(q, k + 1);
            value = jsx.slice(k + 1, end);
            k = end + 1;
          } else if (jsx[k] === '{') {
            const end = skipBraces(jsx, k);
            const expr = jsx.slice(k + 1, end - 1).trim();
            const lit = /^(['"`])([^'"`$]*)\1$/.exec(expr);
            if (lit) value = lit[2];
            else if (/^-?[\d.]+$/.test(expr)) value = expr;
            k = end;
          }
        }
        if (value != null && keep) attrs += ` ${attrName(name)}="${value.replace(/"/g, '&quot;')}"`;
      }
      const selfClose = jsx[k] === '/';
      k = jsx.indexOf('>', k) + 1 || jsx.length;
      if (keep) {
        const t = tag === 'Svg' ? 'svg' : tag;
        if (closing) out += `</${t}>`;
        else {
          let extra = '';
          if (t === 'svg') {
            if (tag === 'Svg' || (spread && !/\sstroke=|\sfill=/.test(attrs))) extra = ` ${STROKE_DEFAULTS}`;
            if (!/\sviewBox=/.test(attrs + extra)) extra += ' viewBox="0 0 24 24"';
            attrs = attrs.replace(/\s(width|height|class)="[^"]*"/g, '');
          }
          out += `<${t}${extra}${attrs}${selfClose ? ` /></${t}>`.replace(' />', '>') : '>'}`;
        }
      }
      spread = false;
      i = k;
      continue;
    }
    out += c;
    i += 1;
  }
  return out.replace(/\s+/g, ' ').trim();
}

// The end of the <svg> (or <Svg>) block starting at `start`.
function blockEnd(src, start, tag) {
  const re = new RegExp(`<${tag}\\b|</${tag}>|/>`, 'g');
  // A self-closing <Svg ... /> ends at its own `/>`.
  const openEnd = (() => {
    for (let k = start; k < src.length; k += 1) {
      if (src[k] === '{') { k = skipBraces(src, k) - 1; continue; }
      if (src[k] === '>') return k;
    }
    return src.length;
  })();
  if (src[openEnd - 1] === '/') return openEnd + 1;
  let depth = 1;
  re.lastIndex = openEnd + 1;
  let m;
  while ((m = re.exec(src))) {
    if (m[0] === `</${tag}>`) { depth -= 1; if (depth === 0) return m.index + m[0].length; }
    else if (m[0] !== '/>') depth += 1;
  }
  return src.length;
}

// What the icon is called, and the comment above it.
function nameFor(src, at) {
  const before = src.slice(Math.max(0, at - 500), at);
  const tries = [
    /(?:^|\n)[ \t]*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:\([^)]*\)\s*=>\s*)?\(?\s*$/,
    /case\s+['"]([^'"]+)['"]\s*:\s*(?:return\s*)?\(?\s*$/,
    /(?:^|[\s,{])['"]?([\w-]+)['"]?\s*:\s*\(?\s*$/,
    /([\w$]+)\s*={1,3}\s*['"]([^'"]+)['"]\s*\)?\s*(?:\?|&&)\s*\(?\s*$/,
  ];
  for (const re of tries) {
    const m = re.exec(before);
    if (!m) continue;
    const name = m[2] || m[1];
    const lineStart = src.lastIndexOf('\n', at - before.length + m.index + 1) + 1;
    return { name, note: commentAbove(src, lineStart) };
  }
  // Inside a component: name it after the function / const that owns it.
  const head = src.slice(0, at);
  const owner = [...head.matchAll(/(?:^|\n)(?:export\s+(?:default\s+)?)?(?:function\s+([A-Z][\w$]*)|const\s+([A-Z][\w$]*)\s*=)/g)].pop();
  if (owner) {
    const lineStart = owner.index + (owner[0].startsWith('\n') ? 1 : 0);
    return { name: `${owner[1] || owner[2]} (inline)`, note: commentAbove(src, lineStart) };
  }
  return { name: '(unnamed)', note: '' };
}

function commentAbove(src, lineStart) {
  const lines = src.slice(0, lineStart).split('\n');
  lines.pop();
  const out = [];
  while (lines.length) {
    const l = lines.pop().trim();
    if (l.startsWith('//')) out.unshift(l.replace(/^\/\/+\s?/, ''));
    else if (l.endsWith('*/') || (out.length === 0 && l.startsWith('*'))) {
      const block = [l];
      while (lines.length && !block[0].startsWith('/*')) block.unshift(lines.pop().trim());
      out.unshift(block.join(' ').replace(/^\/\*+|\*+\/$/g, '').replace(/\s*\*\s/g, ' ').trim());
      break;
    } else break;
  }
  return out.join(' ').replace(/\s+/g, ' ').trim().slice(0, 240);
}

export function iconsInSource(src, file) {
  const out = [];
  const re = /<(svg|Svg)\b/g;
  let m;
  while ((m = re.exec(src))) {
    // `const Svg = (p) => <svg …/>` is the wrapper itself, not an icon.
    if (/const\s+Svg\s*=\s*\([^)]*\)\s*=>\s*$/.test(src.slice(Math.max(0, m.index - 60), m.index))) continue;
    const end = blockEnd(src, m.index, m[1]);
    const jsx = src.slice(m.index, end);
    re.lastIndex = end;
    const html = jsxToHtml(jsx);
    if (!/<(path|circle|rect|line|polyline|polygon|ellipse|text|use|g)\b/.test(html)) continue;
    const { name, note } = nameFor(src, m.index);
    const line = src.slice(0, m.index).split('\n').length;
    out.push({ id: `${file}:${line}`, name, file, line, note, html });
  }
  return out;
}

// Every icon in the renderer's source, plus the standalone .svg files.
export async function loadIconCatalogue() {
  const icons = [];
  await Promise.all(Object.entries(SOURCES).map(async ([path, load]) => {
    if (path.includes('/lib/iconCatalogue')) return;
    let src = '';
    try { src = await load(); } catch { return; }
    if (!/<(svg|Svg)\b/.test(src)) return;
    icons.push(...iconsInSource(src, path.replace(/^\.\.\//, 'src/')));
  }));
  await Promise.all(Object.entries(SVG_FILES).map(async ([path, load]) => {
    let url = '';
    try { url = await load(); } catch { return; }
    const file = path.replace(/^\.\.\//, 'src/');
    const name = file.split('/').pop();
    icons.push({ id: file, name, file, line: null, note: 'Standalone .svg file', url });
  }));
  icons.sort((a, b) => a.file.localeCompare(b.file) || (a.line || 0) - (b.line || 0));
  return icons;
}
