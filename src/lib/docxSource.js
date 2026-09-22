// ── A DocVex Word file carries its own source ────────────────────────────────
// What makes a Word file written here more than a Word file — the line-based
// SOURCE it was built from, its [[blanks]] (`template`), the values filled into
// them, which party each role was given, and the versions it went through — is
// what the Doc Viewer's paragraph tools work on (lib/docConstructor). It used to
// live only in this computer's localStorage (lib/conversationHistory), so the
// same file opened on another device, or by a teammate, was a stranger there:
// blanks turned to plain prose, no paragraph could be tied back to its clause,
// and the paragraph history was empty.
//
// So the source goes INTO the file, as a Custom XML part — the OOXML home for
// an application's own data. Word keeps such parts when it re-saves a document
// and nothing renders them (docx-preview ignores them too), so the file looks
// and behaves exactly as before everywhere else:
//
//   customXml/itemN.xml            <docvexSource xmlns=NS>{json}</docvexSource>
//   customXml/itemPropsN.xml       its datastore properties (schema = NS)
//   customXml/_rels/itemN.xml.rels
//   word/_rels/document.xml.rels   + a customXml relationship to the item
//   [Content_Types].xml            + the itemProps override
//
// PAYLOAD  { v: 1, active: n, versions: [{ n, text, template?, values?,
//            assigned?, kind, manual?, quiet?, instructions? }] }
// The user's own requests to the AI (an AI version's `instructions`) are left
// out: the file is shared with the project, the conversation is not.
import JSZip from 'jszip';

export const DOCX_SOURCE_NS = 'urn:docvex:document-source:v1';
const REL_CUSTOM_XML = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXml';
const REL_CUSTOM_XML_PROPS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXmlProps';
const CT_PROPS = 'application/vnd.openxmlformats-officedocument.customXmlProperties+xml';
const CT_XML = 'application/xml';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
// A document edited many times would otherwise carry every draft forever.
const MAX_VERSIONS = 40;

const ITEM_RE = /^customXml\/item(\d+)\.xml$/;

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

function guid() {
  try { return `{${crypto.randomUUID().toUpperCase()}}`; } catch {
    const h = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0').toUpperCase();
    return `{${h()}${h()}-${h()}-${h()}-${h()}-${h()}${h()}${h()}}`;
  }
}

// The versions as they go into a file: the fields the paragraph tools need.
export function sourcePayload(versions, active) {
  const list = (Array.isArray(versions) ? versions : [])
    .filter((v) => v && Number.isFinite(v.n) && typeof v.text === 'string')
    .slice(-MAX_VERSIONS)
    .map((v) => {
      const out = { n: v.n, text: v.text, kind: v.kind || 'docx' };
      if (typeof v.template === 'string') out.template = v.template;
      if (v.values && typeof v.values === 'object') out.values = v.values;
      if (v.assigned && typeof v.assigned === 'object') out.assigned = v.assigned;
      if (v.manual) { out.manual = true; if (v.instructions) out.instructions = String(v.instructions).slice(0, 200); }
      if (v.quiet) out.quiet = true;
      return out;
    });
  if (!list.length) return null;
  const act = list.some((v) => v.n === active) ? active : list[list.length - 1].n;
  return { v: 1, active: act, versions: list };
}

// Our item's index in `zip`, or null.
async function findItem(zip) {
  for (const name of Object.keys(zip.files)) {
    const m = ITEM_RE.exec(name);
    if (!m) continue;
    const xml = await zip.file(name).async('string');
    if (xml.includes(DOCX_SOURCE_NS)) return Number(m[1]);
  }
  return null;
}

// `blob` (a .docx) with `payload` written into it. Anything that goes wrong
// hands the document back untouched — the file matters more than its source.
export async function embedDocxSource(blob, payload) {
  if (!blob || !payload) return blob;
  try {
    const zip = await JSZip.loadAsync(await blob.arrayBuffer(), { createFolders: false });
    const put = (name, data) => zip.file(name, data, { createFolders: false });
    const docRelsName = 'word/_rels/document.xml.rels';
    const docRels = zip.file(docRelsName) && await zip.file(docRelsName).async('string');
    const types = zip.file('[Content_Types].xml') && await zip.file('[Content_Types].xml').async('string');
    if (!docRels || !types) return blob;

    let n = await findItem(zip);
    const fresh = n == null;
    if (fresh) {
      const used = Object.keys(zip.files).map((k) => ITEM_RE.exec(k)).filter(Boolean).map((m) => Number(m[1]));
      n = (used.length ? Math.max(...used) : 0) + 1;
    }

    put(`customXml/item${n}.xml`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<docvexSource xmlns="${DOCX_SOURCE_NS}">${escapeXml(JSON.stringify(payload))}</docvexSource>`);

    if (fresh) {
      put(`customXml/itemProps${n}.xml`,
        `<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n<ds:datastoreItem ds:itemID="${guid()}" xmlns:ds="http://schemas.openxmlformats.org/officeDocument/2006/customXml"><ds:schemaRefs><ds:schemaRef ds:uri="${DOCX_SOURCE_NS}"/></ds:schemaRefs></ds:datastoreItem>`);
      put(`customXml/_rels/item${n}.xml.rels`,
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL_CUSTOM_XML_PROPS}" Target="itemProps${n}.xml"/></Relationships>`);

      // A relationship id no other relationship of the document uses.
      const ids = new Set([...docRels.matchAll(/Id="([^"]+)"/g)].map((m) => m[1]));
      let rid = 'rIdDocvexSource';
      for (let i = 2; ids.has(rid); i += 1) rid = `rIdDocvexSource${i}`;
      put(docRelsName, docRels.replace('</Relationships>',
        `<Relationship Id="${rid}" Type="${REL_CUSTOM_XML}" Target="../customXml/item${n}.xml"/></Relationships>`));

      let nextTypes = types.replace('</Types>',
        `<Override PartName="/customXml/itemProps${n}.xml" ContentType="${CT_PROPS}"/></Types>`);
      if (!/<Default\s+Extension="xml"/i.test(nextTypes)) {
        nextTypes = nextTypes.replace('</Types>', `<Override PartName="/customXml/item${n}.xml" ContentType="${CT_XML}"/></Types>`);
      }
      put('[Content_Types].xml', nextTypes);
    }

    const bytes = await zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE' });
    return new Blob([bytes], { type: DOCX_MIME });
  } catch (err) {
    console.warn('[docxSource] could not embed the source; writing the document without it', err);
    return blob;
  }
}

// The payload a .docx carries, or null (not ours, not a zip, unreadable).
export async function readDocxSource(blob) {
  if (!blob) return null;
  try {
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const n = await findItem(zip);
    if (n == null) return null;
    const xml = await zip.file(`customXml/item${n}.xml`).async('string');
    const m = /<docvexSource\b[^>]*>([\s\S]*)<\/docvexSource>/.exec(xml);
    if (!m) return null;
    const parsed = JSON.parse(unescapeXml(m[1]));
    if (!parsed || !Array.isArray(parsed.versions) || !parsed.versions.length) return null;
    const versions = parsed.versions.filter((v) => v && Number.isFinite(v.n) && typeof v.text === 'string');
    if (!versions.length) return null;
    const active = versions.some((v) => v.n === parsed.active) ? parsed.active : versions[versions.length - 1].n;
    return { v: parsed.v || 1, active, versions };
  } catch {
    return null;
  }
}
