// ── Writing a document theme INTO the .docx ──────────────────────────────────
// The Doc Viewer's themes are a preview treatment: applyDocTheme (lib/docThemes)
// stamps `--dt-*` custom properties on the `.dv-docx` host and the stylesheet
// paints docx-preview's markup with them. Nothing of that exists outside the
// app, so "Open in Word" handed Word the original bytes and the theme appeared
// not to have applied at all.
//
// So the theme is written into the package before Word is given it. Two parts
// carry it:
//   word/styles.xml      — the colour (and face) of Title / Heading 1-3 and of
//                          the document's default text, as `<w:color w:val>`
//                          and `<w:rFonts>` inside each style's `<w:rPr>`;
//   word/theme/theme1.xml — the major (heading) and minor (body) latin
//                          typefaces, which is what Word's own font box reads.
//
// EVERY OTHER PART IS LEFT BYTE FOR BYTE, exactly as docxRewrite does for a
// paragraph edit: the text, the numbering, the tables, the images and the
// headers are none of a theme's business.
//
// Going back is the reason for the backup part. Once styles.xml has been
// overwritten the document's own colours are gone, so the FIRST time a theme is
// written the untouched parts are stashed inside the package itself
// (BACKUP_PART, the same trick lib/docxSource uses to carry a document's source
// in customXml). Picking "Original" restores from that and removes it, so the
// file comes back exactly as it arrived — not as an approximation of it.
import JSZip from 'jszip';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const STYLES = 'word/styles.xml';
const THEME = 'word/theme/theme1.xml';
// The body, and the parts that repeat on every page. A theme has to reach the
// text in these, not only the styles the text is nominally in — see stripDirect.
const TEXT_PARTS = /^word\/(document\d*\.xml|header\d+\.xml|footer\d+\.xml)$/;
// Not under word/, and not a part Word knows: an unreferenced entry in the zip
// is carried through a Word re-save untouched and ignored by every reader.
const BACKUP_PART = 'docvex/original-theme.xml';

// Which `w:styleId` each of the theme's colours belongs to. A style may be
// spelled several ways between Word versions and languages, so each is matched
// on any of its ids.
const STYLE_TARGETS = [
  { key: 'title', ids: ['Title', 'Titlu'] },
  { key: 'h1', ids: ['Heading1', 'heading1', 'Titlu1'] },
  { key: 'h2', ids: ['Heading2', 'heading2', 'Titlu2'] },
  { key: 'h3', ids: ['Heading3', 'heading3', 'Titlu3'] },
  { key: 'body', ids: ['Normal', 'Normala', 'Normală'] },
];

const HEX = (c) => String(c || '').replace('#', '').toUpperCase();

// The first family in a CSS font stack, unquoted — Word wants a face, not a
// fallback list ("Calibri, Carlito, sans-serif" → "Calibri").
function firstFamily(stack) {
  const first = String(stack || '').split(',')[0].trim();
  return first.replace(/^['"]|['"]$/g, '');
}

// WordprocessingML orders a style's children as a SEQUENCE, so where a new
// <w:rPr> is put matters: dropped in ahead of <w:name>, Word calls the document
// unreadable and "repairs" it, which throws the theme away — silently, which is
// exactly what "the theme didn't apply" looks like from the outside.
// These are the children that come BEFORE rPr; the new one goes after the last
// of them that the style actually has.
const BEFORE_RPR = /<w:(?:name|aliases|basedOn|next|link|autoRedefine|hidden|uiPriority|semiHidden|unhideWhenUsed|qFormat|locked|personal|personalCompose|personalReply|rsid)\b[^>]*\/>|<\/w:pPr>/gi;
// …and the run properties that come after <w:color> inside an <w:rPr>, so the
// colour lands in its place there too rather than at the end.
const AFTER_COLOR = /<w:(?:spacing|w|kern|position|sz|szCs|highlight|u|effect|bdr|shd|fitText|vertAlign|rtl|cs|em|lang|eastAsianLayout|specVanish|oMath)\b/i;

// Where a new <w:rPr> belongs inside one <w:style> block.
function rPrInsertAt(block) {
  let at = -1;
  BEFORE_RPR.lastIndex = 0;
  for (let m = BEFORE_RPR.exec(block); m; m = BEFORE_RPR.exec(block)) at = m.index + m[0].length;
  if (at >= 0) return at;
  const open = block.match(/<w:style\b[^>]*>/i);
  return open ? open.index + open[0].length : 0;
}

// Put `<w:color>` / `<w:rFonts>` into one style's run properties. The style's
// own `<w:rPr>` is edited in place when it has one and inserted in its proper
// position when it does not; everything else the style says is untouched.
function styleWithRun(xml, ids, color, face) {
  for (const id of ids) {
    // The <w:style> element carrying this id, whatever order its attributes
    // are written in.
    const open = new RegExp(`<w:style\\b[^>]*w:styleId="${id}"[^>]*>`, 'i');
    const at = xml.search(open);
    if (at < 0) continue;
    const end = xml.indexOf('</w:style>', at);
    if (end < 0) continue;
    let block = xml.slice(at, end);

    const colorTag = color ? `<w:color w:val="${HEX(color)}"/>` : '';
    const fontTag = face
      ? `<w:rFonts w:ascii="${face}" w:hAnsi="${face}" w:cs="${face}"/>`
      : '';
    if (!colorTag && !fontTag) return xml;

    const rPrOpen = block.search(/<w:rPr\b[^>]*>/i);
    if (rPrOpen >= 0) {
      const rPrEnd = block.indexOf('</w:rPr>', rPrOpen);
      let rPr = block.slice(rPrOpen, rPrEnd);
      // Replace what is already there rather than adding a second one: Word
      // takes the FIRST of a duplicated property and would ignore the new one.
      rPr = rPr.replace(/<w:color\b[^>]*\/>/gi, '').replace(/<w:color\b[^>]*>[\s\S]*?<\/w:color>/gi, '');
      if (fontTag) rPr = rPr.replace(/<w:rFonts\b[^>]*\/>/gi, '').replace(/<w:rFonts\b[^>]*>[\s\S]*?<\/w:rFonts>/gi, '');
      // rFonts opens a run's properties; the colour goes ahead of the first
      // property the schema puts after it, or last when there is none.
      rPr = rPr.replace(/(<w:rPr\b[^>]*>)/i, `$1${fontTag}`);
      if (colorTag) {
        const after = rPr.search(AFTER_COLOR);
        rPr = after >= 0 ? rPr.slice(0, after) + colorTag + rPr.slice(after) : rPr + colorTag;
      }
      block = block.slice(0, rPrOpen) + rPr + block.slice(rPrEnd);
    } else {
      const ins = rPrInsertAt(block);
      block = block.slice(0, ins) + `<w:rPr>${fontTag}${colorTag}</w:rPr>` + block.slice(ins);
    }
    return xml.slice(0, at) + block + xml.slice(end);
  }
  return xml;   // the document has no such style — nothing to colour
}

// The document's DEFAULT run properties — what text inherits before any style
// is considered. A document whose Normal style says nothing about colour or
// face takes both from here, so a theme that only touched the styles left it
// exactly as it was.
function docDefaultsWithRun(xml, color, face) {
  const colorTag = color ? `<w:color w:val="${HEX(color)}"/>` : '';
  const fontTag = face ? `<w:rFonts w:ascii="${face}" w:hAnsi="${face}" w:cs="${face}"/>` : '';
  // Matched whole, and the body taken from the END of the match. Looking for
  // '<w:rPr' by index instead finds `<w:rPrDefault>` ITSELF — it begins with
  // those characters — which put the new font tag outside the <w:rPr> it
  // belongs in: invalid, and so another silent Word repair.
  const m = xml.match(/<w:rPrDefault>\s*<w:rPr\b[^>]*>/i);
  if (!m) {
    // No defaults at all: give the document a set, ahead of the styles.
    return xml.replace(/(<w:docDefaults>)/i, `$1<w:rPrDefault><w:rPr>${fontTag}${colorTag}</w:rPr></w:rPrDefault>`);
  }
  const bodyStart = m.index + m[0].length;
  const end = xml.indexOf('</w:rPr>', bodyStart);
  if (end < 0) return xml;
  let inner = xml.slice(bodyStart, end)
    .replace(/<w:color\b[^>]*\/>/gi, '')
    .replace(/<w:rFonts\b[^>]*\/>/gi, '');
  inner = fontTag + inner;
  if (colorTag) {
    const after = inner.search(AFTER_COLOR);
    inner = after >= 0 ? inner.slice(0, after) + colorTag + inner.slice(after) : inner + colorTag;
  }
  return xml.slice(0, bodyStart) + inner + xml.slice(end);
}

// ── Why the text itself has to be touched ──────────────────────────────────
// In Word, DIRECT formatting beats every style: a run carrying its own
// <w:rFonts> or <w:color> ignores Normal, ignores Heading 1 and ignores the
// theme. Most real documents are full of it — anything pasted in, anything a
// font box was used on — which is why a correctly written theme could still
// change nothing whatever on screen.
// So the run-level colour and face are REMOVED, which lets what the styles and
// the defaults now say come through. Nothing else in the run is touched: bold,
// italics, size, spacing, highlighting and every other property stay as they
// are, and the text is not read or rewritten. `word/document.xml` is in the
// backup, so picking Original puts all of it back exactly.
function stripDirect(xml) {
  return xml
    .replace(/<w:color\b[^>]*\/>/gi, '')
    .replace(/<w:rFonts\b[^>]*\/>/gi, '');
}

// The theme's major (heading) and minor (body) latin faces, which is what
// Word's font box and its own Design tab read.
function themeWithFonts(xml, headFace, bodyFace) {
  const one = (src, tag, face) => src.replace(
    new RegExp(`(<a:${tag}>\\s*<a:latin[^>]*typeface=")[^"]*(")`, 'i'),
    `$1${face}$2`,
  );
  let out = xml;
  if (headFace) out = one(out, 'majorFont', headFace);
  if (bodyFace) out = one(out, 'minorFont', bodyFace);
  return out;
}

// Apply a DOC_THEMES entry to a .docx blob.
//   theme.vars  → the colours; `null` means "Original", which RESTORES the file
//                 from the backup written the first time a theme was applied.
// Returns { blob, changed }. `changed: false` means there was nothing to do —
// the caller can then open the file as it stands rather than rewriting it.
export async function applyThemeToDocx(blob, theme) {
  const zip = await JSZip.loadAsync(await blob.arrayBuffer(), { createFolders: false });
  const backupFile = zip.file(BACKUP_PART);

  // ── Original: put the document back exactly as it came ──────────────────
  if (!theme?.vars) {
    if (!backupFile) return { blob, changed: false };   // never themed; nothing to undo
    let saved;
    try {
      saved = JSON.parse(await backupFile.async('string'));
    } catch {
      return { blob, changed: false };                  // unreadable backup: leave the file alone
    }
    if (typeof saved?.styles === 'string') zip.file(STYLES, saved.styles);
    if (typeof saved?.theme === 'string') zip.file(THEME, saved.theme);
    for (const [name, xml] of Object.entries(saved?.parts || {})) {
      if (typeof xml === 'string') zip.file(name, xml);
    }
    zip.remove(BACKUP_PART);
    const out = await zip.generateAsync({ type: 'blob', mimeType: DOCX_MIME, compression: 'DEFLATE' });
    return { blob: out, changed: true };
  }

  const stylesFile = zip.file(STYLES);
  if (!stylesFile) return { blob, changed: false };     // not a package we can theme
  const themeFile = zip.file(THEME);

  const styles0 = await stylesFile.async('string');
  const theme0 = themeFile ? await themeFile.async('string') : null;

  // The backup is written ONCE — from the parts as they are the first time a
  // theme goes in. Writing it again on a later theme would save an already
  // themed file as "the original".
  // The body parts, read once and kept for the backup.
  const partNames = Object.keys(zip.files).filter((n) => TEXT_PARTS.test(n));
  const parts = {};
  for (const name of partNames) parts[name] = await zip.file(name).async('string');

  if (!backupFile) {
    zip.file(BACKUP_PART, JSON.stringify({ v: 1, styles: styles0, theme: theme0, parts }));
  }

  const headFace = firstFamily(theme.fonts?.head);
  const bodyFace = firstFamily(theme.fonts?.body);
  let styles = styles0;
  for (const t of STYLE_TARGETS) {
    const color = theme.vars[t.key];
    // Headings take the heading face, body text the body face.
    styles = styleWithRun(styles, t.ids, color, t.key === 'body' ? bodyFace : headFace);
  }
  styles = docDefaultsWithRun(styles, theme.vars.body, bodyFace);
  zip.file(STYLES, styles);
  if (theme0 != null) zip.file(THEME, themeWithFonts(theme0, headFace, bodyFace));
  // …and take the direct formatting off the text, which is what was hiding all
  // of the above. Always from the parts as they were BACKED UP, never from
  // whatever a previous theme left, so this can't compound.
  const base = (() => {
    if (backupFile) return null;          // read below when there is a backup
    return parts;
  })();
  const source = base || JSON.parse(await zip.file(BACKUP_PART).async('string')).parts || parts;
  for (const name of partNames) {
    const xml = source[name] ?? parts[name];
    zip.file(name, stripDirect(xml));
  }

  const out = await zip.generateAsync({ type: 'blob', mimeType: DOCX_MIME, compression: 'DEFLATE' });
  return { blob: out, changed: true };
}

export default applyThemeToDocx;
