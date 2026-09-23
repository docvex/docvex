// ── Editing a Word file that DocVex did not write ────────────────────────────
// A document written here is rebuilt from its own source on every save (the
// versions in lib/docxSource), which is why its paragraph tools can change it
// freely. A file that came from somewhere else has no source: rebuilding it
// from the text read out of the preview would hand back a plain document and
// throw away everything Word carries — styles, numbering, tables, headers and
// footers, fonts, spacing, images, fields.
//
// So a foreign file is edited IN PLACE instead: the .docx is a zip, its text
// lives in `word/document.xml`, and a paragraph is a `<w:p>` element whose
// words sit in `<w:t>` runs. This finds the paragraphs whose text matches what
// the user edited and rewrites only those runs. Everything else in the package
// — every other part, every other paragraph, every property — is left byte for
// byte as it was.
//
// WHAT SURVIVES a rewritten paragraph: its style, numbering, indentation,
// spacing, borders, the table cell it sits in, and the character formatting of
// its FIRST run (the paragraph's dominant formatting), which the new text is
// given. WHAT DOES NOT: formatting that varied WITHIN the paragraph — a bold
// word in the middle, a hyperlink, a footnote reference — because the new text
// is one run and there is no way to know which of its characters the old runs'
// formatting belonged to. Paragraphs that aren't edited never change.
import JSZip from 'jszip';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
// Parts that hold paragraphs a reader sees. The body first — it is where an
// edit almost always is — then the headers and footers.
const TEXT_PARTS = /^word\/(document\d*\.xml|header\d+\.xml|footer\d+\.xml)$/;

function escapeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function unescapeXml(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// How a paragraph reads on screen, for matching what the user edited against
// what is in the file: the same letters, whatever the whitespace.
export function normalizeParaText(s) {
  return unescapeXml(String(s || ''))
    // Word writes the no-break space and the various dashes the preview shows.
    .replace(/ /g, ' ')
    .replace(/[‐-―]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

// Every `<w:p …>…</w:p>` in `xml`, as [start, end) offsets. `w:p` never nests.
function paragraphSpans(xml) {
  const out = [];
  const open = /<w:p(?=[ >/])[^>]*>/g;
  let m;
  while ((m = open.exec(xml))) {
    if (m[0].endsWith('/>')) continue;            // an empty paragraph, nothing to edit
    const close = xml.indexOf('</w:p>', m.index);
    if (close === -1) break;
    out.push([m.index, close + 6]);
    open.lastIndex = close + 6;
  }
  return out;
}

// The text of one paragraph's XML, as the preview shows it.
function paraText(p) {
  let out = '';
  const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/?>|<w:br\b[^>]*\/?>/g;
  let m;
  while ((m = re.exec(p))) {
    if (m[1] != null) out += unescapeXml(m[1]);
    else out += m[0].startsWith('<w:tab') ? '\t' : '\n';
  }
  return out;
}

// One paragraph's XML with `text` in place of its words. The paragraph's own
// properties (`w:pPr`) and the first run's character properties (`w:rPr`) are
// kept; the other runs go, since their text has gone.
function withText(p, text) {
  const openMatch = /^<w:p(?=[ >/])[^>]*>/.exec(p);
  if (!openMatch) return p;
  const open = openMatch[0];
  const inner = p.slice(open.length, p.length - 6);
  const pPrMatch = /^\s*<w:pPr\b[\s\S]*?<\/w:pPr>/.exec(inner);
  const pPr = pPrMatch ? pPrMatch[0].trim() : '';
  // The formatting the new text inherits: the first run that carries any.
  const rPrMatch = /<w:r(?=[ >])[^>]*>\s*(<w:rPr\b[\s\S]*?<\/w:rPr>)/.exec(inner);
  const rPr = rPrMatch ? rPrMatch[1] : '';
  // Anything that isn't a run and isn't the paragraph's properties — a bookmark,
  // a comment anchor, a proofing mark — is kept, in order, so cross-references
  // into this paragraph survive.
  const keep = [];
  const other = /<w:(bookmarkStart|bookmarkEnd|commentRangeStart|commentRangeEnd|proofErr)\b[^>]*\/?>/g;
  let k;
  while ((k = other.exec(inner))) keep.push(k[0]);

  // Line breaks in the new text become real Word breaks rather than literal
  // characters, which Word would otherwise drop.
  const runs = String(text).split('\n').map((line, i) => {
    const br = i ? '<w:br/>' : '';
    return `${br}<w:t xml:space="preserve">${escapeXml(line)}</w:t>`;
  }).join('');
  return `${open}${pPr}${keep.join('')}<w:r>${rPr}${runs}</w:r></w:p>`;
}

// The document's paragraphs, in order, one string each — the body only, since
// that is what the preview shows and what a person picks. This is the SOURCE a
// file DocVex did not write is given: the paragraph tools split a source into
// one piece per LINE, so the lines have to be the document's real paragraphs.
// Reading `textContent` off a rendered copy (what this used to do) is not that
// — block elements contribute no line break, so the whole document arrived as a
// single line and every paragraph matched the one enormous piece it made.
// Reading `<w:p>` also means the pieces are exactly the units rewriteDocxParagraphs
// can find again, and there is no second render to pay for.
export async function readDocxParagraphs(blob) {
  if (!blob) return [];
  const zip = await JSZip.loadAsync(await blob.arrayBuffer(), { createFolders: false });
  const part = zip.file('word/document.xml');
  if (!part) return [];
  const xml = await part.async('string');
  // A paragraph's own newlines (a <w:br/>) would split it into pieces that no
  // longer match anything in the file, so they are kept as spaces.
  return paragraphSpans(xml).map(([from, to]) => paraText(xml.slice(from, to)).replace(/\s+/g, ' ').trim());
}

// Rewrite the paragraphs of `blob` (a .docx) named by `edits`, an array of
// `{ before, after }` — the paragraph as it reads now and as it should read.
// Returns `{ blob, applied, missed }`: the new file, how many paragraphs were
// changed, and the edits whose paragraph could not be found (a paragraph that
// has been changed in Word since, or one the preview shows as one block but
// the file keeps as several).
export async function rewriteDocxParagraphs(blob, edits) {
  const list = (edits || []).filter((e) => e && e.before != null && e.after != null && e.before !== e.after);
  if (!blob || !list.length) return { blob, applied: 0, missed: list };

  const zip = await JSZip.loadAsync(await blob.arrayBuffer(), { createFolders: false });
  // before (normalised) → the replacement still to make. A document may repeat
  // a paragraph; each occurrence takes the next edit with that text.
  const pending = new Map();
  for (const e of list) {
    const key = normalizeParaText(e.before);
    if (!key) continue;
    if (!pending.has(key)) pending.set(key, []);
    pending.get(key).push(e);
  }
  let applied = 0;

  const parts = Object.keys(zip.files).filter((n) => TEXT_PARTS.test(n)).sort();
  for (const name of parts) {
    if (!pending.size) break;
    const xml = await zip.file(name).async('string');
    const spans = paragraphSpans(xml);
    let out = '';
    let at = 0;
    for (const [from, to] of spans) {
      const p = xml.slice(from, to);
      const key = normalizeParaText(paraText(p));
      const queue = key && pending.get(key);
      if (!queue || !queue.length) continue;
      const edit = queue.shift();
      if (!queue.length) pending.delete(key);
      out += xml.slice(at, from) + withText(p, edit.after);
      at = to;
      applied += 1;
    }
    if (!applied || at === 0) continue;
    out += xml.slice(at);
    zip.file(name, out, { createFolders: false });
  }

  if (!applied) return { blob, applied: 0, missed: list };
  const bytes = await zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE' });
  const missed = [...pending.values()].flat();
  return { blob: new Blob([bytes], { type: DOCX_MIME }), applied, missed };
}

export default rewriteDocxParagraphs;
