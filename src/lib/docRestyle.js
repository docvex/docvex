// ── Restyle — a document laid out again to the Playbook's rules ─────────────
//
// The Playbook states how this office lays a document out (lib/docRules): that
// sections are "Art. 1" and not "CAPITOLUL I", that clauses are 1.1. and
// sub-points a), that a blank is five low lines, that amounts carry their words
// in brackets. Until now those rules only ever reached a document DocVex was
// WRITING — they ride on a drafting turn as `docRulesSteer()`.
//
// This is the other direction: a document that already exists, written to
// somebody else's rules — a contract from the other side's lawyer, a template
// inherited from a predecessor, a file drafted before the Playbook was filled
// in — laid out again to the office's own. That is the whole point of the
// feature, so the work here is not "ask the AI to rewrite the document". It is
// the opposite: hold it to changing as LITTLE as possible.
//
// HOW IT IS HELD. Three things do the holding, and all three matter:
//
//   1. The unit is the PARAGRAPH, not the document. The paragraphs go up
//      numbered and must come back under their own numbers, so a returned
//      paragraph can only ever replace the one it was given. A model that
//      merges two clauses or invents a third has nowhere to put the result.
//   2. Only what CHANGED comes back. A paragraph the rules have nothing to say
//      about is omitted, and an omitted paragraph is left byte for byte alone —
//      so the quiet majority of a document is never at risk of being retyped.
//   3. What lands is an edit LIST — [{ before, after }] — which is the shape
//      lib/docxRewrite consumes: it patches those paragraphs inside the .docx
//      and leaves every style, table, header, footer and image untouched.
//
// WHAT IT MAY CHANGE is whatever the Playbook says, in full: the rules block is
// passed through as written rather than filtered down here, because a rule the
// user set and the app then quietly declined to apply is worse than no rule.
// What it may NOT change is what the document SAYS — every fact, figure, sum,
// date value, name, deadline and obligation has to survive identically. That is
// stated to the model, and it is the one thing a reader must still check.

import { askProjectAi } from './projectAi';
import { buildDocRulesSteer, loadDocRules } from './docRules';

// The rules are read from storage on every call rather than through
// `docRulesSteer`'s module-level cache. The Doc Viewer is its OWN window, so it
// has its own copy of that cache: rules edited in the Playbook, in the main
// window, would otherwise never reach a viewer that had already read them once.
// It is a localStorage parse, and it happens once per restyle.
function currentSteer() {
  return String(buildDocRulesSteer(loadDocRules()) || '').trim();
}

// A chunk is small on purpose. The failure this guards against is not the
// context window — it is attention: given eighty paragraphs a model starts
// summarising, and a "restyled" paragraph that is two words shorter is a
// changed document. Small chunks keep every paragraph in close view, and a
// chunk that goes wrong costs only itself.
const MAX_LINES = 40;
const MAX_CHARS = 6000;
// The tail of the previous chunk, handed to the next one so the numbering runs
// on across the seam instead of restarting at every chunk boundary.
const CARRY = 3;

// Is there anything to apply? The Playbook can be switched to "Paused", and a
// restyle to no rules at all is an AI call that can only do harm.
export function restyleAvailable() {
  return !!currentSteer();
}

// The model answers in JSON, but it is a language model: it may fence the
// block, or open with a sentence about what it did. Take the outermost array
// and ignore the rest rather than failing the chunk over a stray preamble.
function parseEdits(raw) {
  const s = String(raw || '');
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : s;
  const a = body.indexOf('[');
  const b = body.lastIndexOf(']');
  if (a < 0 || b <= a) return null;
  try {
    const v = JSON.parse(body.slice(a, b + 1));
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

// Paragraphs worth sending. A blank line carries no layout to restyle, and a
// line of pure punctuation — a signature rule, a row of dots a template drew —
// is not a sentence: sending either spends tokens to be told nothing changed.
// Their indices are kept, so what comes back still lands in the right place.
function worthSending(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  return /\p{L}/u.test(t);
}

function chunkOf(items, from) {
  const out = [];
  let chars = 0;
  for (let i = from; i < items.length; i += 1) {
    const len = items[i].text.length + 8;
    if (out.length >= MAX_LINES || (out.length && chars + len > MAX_CHARS)) break;
    out.push(items[i]);
    chars += len;
  }
  return out;
}

const RULES = [
  'Change only the FORM of each paragraph, exactly as the document rules below require: its numbering or heading marker, the capitalisation of a heading, the marker of a list or sub-point, the way a date or an amount is written, how a party is named, how a defined term is capitalised, and the shape of an empty field.',
  'Never change what the paragraph SAYS. Every fact, figure, sum, percentage, date value, name, address, identifier, deadline, obligation and cross-reference must survive with its meaning identical. Restyling "1.000 lei" as "1.000 lei (una mie lei)" is a change of form; "1.500 lei" is a different document.',
  'Do not add, delete, merge, split or reorder paragraphs. One paragraph in, at most one paragraph out, under its own number.',
  'A cross-reference must keep pointing at the same clause. If renumbering moves a clause, update references to it so they still name the clause they meant.',
  'A token written between double square brackets — [[vanzator.legalName]] — is a field this app fills in from a party record. Reproduce it character for character. Never translate it, never renumber it and never turn it into a blank; it is already the strongest kind of blank there is.',
  'Leave a paragraph alone when the rules have nothing to say about it, and omit it from your answer.',
];

// Restyle one chunk. Returns a Map of index → new text for the paragraphs the
// model changed, or null when the call failed or came back unreadable — the
// caller treats that as "this chunk is unchanged" rather than losing the run.
async function restyleChunk({ items, carry, total, steer, model, signal }) {
  if (signal?.aborted) return null;
  const numbered = items.map((it) => `[${it.i + 1}] ${it.text}`).join('\n');
  const lead = [
    `Below are paragraphs of a ${total}-paragraph legal document, each on one line, each opening with its own number in square brackets. The number is a label for this task, NOT part of the paragraph: never carry it into your answer.`,
    '',
    'Lay them out again so they follow the document rules at the end of this message.',
    '',
    ...RULES.map((r) => `- ${r}`),
    '',
  ];
  if (carry.length) {
    lead.push(
      'The paragraphs just before these, already restyled, end like this — carry the numbering on from them:',
      ...carry.map((t) => `    ${t}`),
      '',
    );
  }
  lead.push(
    'Paragraphs to restyle:',
    numbered,
    '',
    'Answer with JSON and nothing else: an array of {"i": <the paragraph\'s number>, "text": "<that paragraph, restyled>"}, holding ONLY the paragraphs you changed. If none of them needed changing, answer [].',
    '',
    steer,
  );

  const res = await askProjectAi({
    messages: [{ role: 'user', content: lead.join('\n') }],
    model,
    tools: false,
    usageAction: 'restyle',
  });
  if (res?.error || signal?.aborted) return null;
  const edits = parseEdits(res.text);
  if (!edits) return null;

  const byIndex = new Map(items.map((it) => [it.i, it.text]));
  const out = new Map();
  for (const e of edits) {
    const i = Number(e?.i) - 1;
    const next = typeof e?.text === 'string' ? e.text.trim() : '';
    if (!Number.isInteger(i) || !byIndex.has(i) || !next) continue;
    const before = byIndex.get(i);
    if (next === before) continue;
    // A paragraph that comes back a third of its length is not restyled, it is
    // summarised. Refuse it rather than write it into the file: the rules can
    // only ever add or swap a marker, never take a clause's substance away.
    if (next.length < before.length * 0.5 && before.length > 40) continue;
    out.set(i, next);
  }
  return out;
}

// ── The whole document ──────────────────────────────────────────────────────
// `paragraphs` is the document's paragraphs in order — what readDocxParagraphs
// gives for a .docx, or a version's source split by line.
//
// Returns { edits, changed, scanned } where `edits` is [{ i, before, after }]
// in document order — `before`/`after` are what rewriteDocxRewrite matches and
// writes, and `i` is the paragraph's index for a caller rebuilding a source by
// position instead. Or { error } when there was nothing to do.
// `onProgress({ done, total })` is called as the chunks land.
export async function restyleDocument(paragraphs, { model, onProgress, signal } = {}) {
  const steer = currentSteer();
  if (!steer) return { error: 'no_rules' };

  const items = [];
  (paragraphs || []).forEach((text, i) => {
    if (worthSending(text)) items.push({ i, text: String(text).trim() });
  });
  if (!items.length) return { error: 'empty' };

  const total = items.length;
  const changes = new Map();
  let carry = [];
  let at = 0;
  let done = 0;
  let failed = 0;

  while (at < items.length) {
    if (signal?.aborted) return { error: 'cancelled' };
    const chunk = chunkOf(items, at);
    if (!chunk.length) break;
    const got = await restyleChunk({ items: chunk, carry, total, steer, model, signal });
    if (got) {
      for (const [i, text] of got) changes.set(i, text);
      // What the next chunk continues from is the chunk as it now READS —
      // restyled where it was restyled, original where it wasn't.
      carry = chunk.slice(-CARRY).map((it) => got.get(it.i) ?? it.text);
    } else {
      failed += 1;
      carry = chunk.slice(-CARRY).map((it) => it.text);
    }
    at += chunk.length;
    done += chunk.length;
    onProgress?.({ done, total });
  }

  if (signal?.aborted) return { error: 'cancelled' };
  // Every chunk failed — the AI is unreachable or unconfigured, which is a
  // different thing from a document that already follows the rules.
  if (failed && !changes.size) return { error: 'ai_failed' };

  const edits = [...changes.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([i, after]) => ({ i, before: String(paragraphs[i]).trim(), after }));
  return { edits, changed: edits.length, scanned: total, partial: failed > 0 };
}
