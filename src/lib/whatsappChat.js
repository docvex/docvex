// Parser + detector for WhatsApp chat exports (the ".txt" you get from
// WhatsApp's "Export chat" → without media). Used by the document viewer to
// render a recognised export as a styled conversation instead of raw text.
//
// Two export layouts are handled:
//   Android: "15/01/2023, 14:30 - Sender: message"   /  "1/15/23, 2:30 PM - …"
//   iOS:     "[15/01/2023, 14:30:45] Sender: message"
// Lines that don't start with a timestamp header are treated as continuation
// lines of the previous message (WhatsApp messages can span many lines).

// WhatsApp injects narrow / non-breaking spaces (e.g. before AM/PM) and LTR
// marks (before "<attached>" etc.); normalise them so the regexes are simple.
function normalizeLine(line) {
  return line.replace(/[  ]/g, ' ').replace(/[‎‏]/g, '');
}

// Capture group 1 = the timestamp text, 2 = the remainder ("Sender: msg" or a
// system line). The timestamp shape is intentionally loose to cover locales.
const IOS_RE = /^\[(\d{1,4}[./-]\d{1,2}[./-]\d{1,4},?\s+\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AaPp]\.?[Mm]\.?)?)\]\s*(.*)$/;
const ANDROID_RE = /^(\d{1,2}[./-]\d{1,2}[./-]\d{2,4},?\s+\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AaPp]\.?[Mm]\.?)?)\s+[-–]\s+(.*)$/;

function matchHeader(line) {
  let m = line.match(IOS_RE);
  if (m) return { time: m[1].trim(), rest: m[2] };
  m = line.match(ANDROID_RE);
  if (m) return { time: m[1].trim(), rest: m[2] };
  return null;
}

// ── Attachment / media detection ───────────────────────────────────────
// A message body that references a media file. WhatsApp writes one of:
//   iOS / newer Android:  "‎<attached: 00000042-PHOTO-….jpg>"
//   older Android:        "IMG-20230101-WA0001.jpg (file attached)"
// When the chat was exported WITHOUT media, a placeholder appears instead:
//   iOS:      "image omitted" / "video omitted" / "audio omitted" / …
//   Android:  "<Media omitted>"
const ATTACHED_ANGLE_RE = /<attached:\s*([^>\n]+?)\s*>/i;
const ATTACHED_PAREN_RE = /^([\s\S]+?\.[A-Za-z0-9]{1,5})\s*\(file attached\)\s*$/i;
const OMITTED_RE = /^(image|photo|video|audio|voice message|GIF|sticker|document|contact card)\s+omitted\.?$/i;
const MEDIA_OMITTED_RE = /^<\s*Media omitted\s*>$/i;

// WhatsApp appends an auto descriptor next to a document attachment — the file's
// display name plus a " • N pages" / " • <size>" tail (e.g. "contract …docx • 3
// pages"). That just duplicates the file card, so it's dropped; genuine
// user-typed captions are kept. Matches the filename with or without the
// numeric export-id prefix WhatsApp adds ("00000939-…").
function isRedundantDocCaption(caption, name) {
  const cap = (caption || '').trim().toLowerCase();
  if (!cap) return false;
  const file = (name || '').trim().toLowerCase();
  const fileNoPrefix = file.replace(/^\d{4,}-/, '');
  // Strip a trailing " • N pages" / " • <size>" descriptor, then compare.
  const base = cap.replace(/\s*[•·]\s*(\d+\s*pages?|[\d.]+\s*(?:bytes|b|kb|mb|gb|tb))\s*$/i, '').trim();
  const hadDescriptor = base !== cap;
  if (hadDescriptor && base === '') return true;      // just "• 3 pages"
  return base === file || base === fileNoPrefix;       // "<filename> • 3 pages" / bare filename
}

// Pull the page count WhatsApp embeds in a document descriptor ("… • 3 pages").
function pagesFromDocCaption(caption) {
  const m = String(caption || '').match(/[•·]\s*(\d+)\s*pages?\b/i);
  return m ? parseInt(m[1], 10) : null;
}

// Returns { attachment: { name, caption } | null, omitted: kind | null }.
// `name` is the on-disk filename to resolve against the export folder;
// `caption` is any text the user typed alongside the media.
function detectAttachment(text) {
  const t = String(text || '');
  let m = t.match(ATTACHED_ANGLE_RE);
  if (m) {
    const name = m[1].trim();
    let caption = (t.slice(0, m.index) + t.slice(m.index + m[0].length)).trim();
    let pages = null;
    if (isRedundantDocCaption(caption, name)) {
      pages = pagesFromDocCaption(caption); // keep WhatsApp's page count; drop the rest
      caption = '';
    }
    return { attachment: { name, caption, pages }, omitted: null };
  }
  m = t.match(ATTACHED_PAREN_RE);
  if (m) return { attachment: { name: m[1].trim(), caption: '' }, omitted: null };
  m = t.match(OMITTED_RE);
  if (m) return { attachment: null, omitted: m[1].toLowerCase() };
  if (MEDIA_OMITTED_RE.test(t)) return { attachment: null, omitted: 'media' };
  return { attachment: null, omitted: null };
}

// Split a header's timestamp into a date label (for day dividers — grouped by
// raw string so we don't have to parse locale-specific date formats) and the
// time-of-day shown in the bubble corner.
export function splitTimestamp(time) {
  const m = String(time || '').match(/^(.*?)[,\s]+(\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AaPp]\.?[Mm]\.?)?)\s*$/);
  if (!m) return { date: '', clock: time || '' };
  return { date: m[1].trim(), clock: m[2].trim() };
}

// Parse the raw export. Returns `{ messages, isWhatsApp }`.
//   messages: [{ time, sender|null, text, system }]
// `isWhatsApp` is a confidence heuristic so the viewer only offers the styled
// view for files that really look like an export.
export function parseWhatsAppChat(raw) {
  const lines = String(raw || '').split(/\r?\n/);
  const messages = [];
  let headerCount = 0;
  // Continuation lines are buffered per message and joined once when the next
  // header arrives — `text += '\n' + line` re-copies the accumulated string on
  // every line, which goes quadratic on a message with thousands of lines
  // (long forwarded texts in multi-MB exports).
  let curParts = null;
  const flush = () => {
    if (curParts && curParts.length > 1) {
      messages[messages.length - 1].text = curParts.join('\n');
    }
    curParts = null;
  };

  for (const rawLine of lines) {
    const line = normalizeLine(rawLine);
    const h = matchHeader(line);
    if (h) {
      flush();
      headerCount += 1;
      // "Sender: text" — the sender is the short prefix before the first ": ".
      // System lines (group created, encryption notice, "Sender left", …) have
      // no such prefix. An empty-body message exports as "Sender:" with the
      // trailing space stripped; accept a colon at end-of-line too, otherwise it
      // falls through to the system branch and renders as a centred "Sender:"
      // pill mid-conversation instead of that sender's (empty) bubble.
      const hm = h.rest.match(/^(.{1,60}?):(?: (.*))?$/);
      if (hm && hm[1].trim()) {
        messages.push({ time: h.time, sender: hm[1].trim(), text: hm[2] || '', system: false });
      } else {
        messages.push({ time: h.time, sender: null, text: h.rest, system: true });
      }
    } else if (messages.length) {
      // Continuation of the previous message.
      if (!curParts) curParts = [messages[messages.length - 1].text];
      curParts.push(line);
    } else if (line.trim()) {
      // Stray leading line before any header — keep it as a system note.
      messages.push({ time: '', sender: null, text: line, system: true });
    }
  }
  flush();

  // Second pass (after continuation lines are joined): tag each real message
  // with any media it references so the viewer can render it inline.
  for (const msg of messages) {
    if (msg.system) { msg.attachment = null; msg.omitted = null; continue; }
    const det = detectAttachment(msg.text);
    msg.attachment = det.attachment;
    msg.omitted = det.omitted;
  }

  const nonEmpty = lines.filter((l) => l.trim()).length;
  const realCount = messages.filter((m) => !m.system).length;
  const isWhatsApp = headerCount >= 3 && realCount >= 2 && headerCount >= nonEmpty * 0.4;
  return { messages, isWhatsApp };
}
