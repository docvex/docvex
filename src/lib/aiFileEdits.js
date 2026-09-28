// THE AI EDITS PROJECT FILES. The advisors' server tools can only write a new
// Office document or ask a question, so a change to an EXISTING file travels
// as a fenced block at the end of the reply, which the app applies:
//
//   ```docvex-edit
//   {"file": "PETRE LUCA-ANDREI.dvc", "record": {"phone": "0722 123 456"}}
//   ```
//
// What each kind of file takes:
//   • a DATA COLLECTION (.dvc, JSON): `record` — fields of the person / company
//     record merged in (null removes one); `facts` — [{ label, value }] upserted
//     by label (value null removes it); `summary` / `title` — replaced.
//   • a TEXT file (.txt .md .csv .json .xml .html .srt .rtf…): `replace` —
//     [{ find, with }], each `find` exact text in the file; or `content` — the
//     whole new text.
//   • a WORD file (.docx): `replace` — [{ find, with }], `find` a whole
//     paragraph as it reads; rewritten IN PLACE (lib/docxRewrite), formatting
//     kept.
// Every edit keeps the file's previous bytes so it can be undone.

import { localFolderApi, readLocalBlob } from './localFolder';
import { notifyFilesChanged } from './platform';

const FENCE = /```docvex-edit[^\n]*\n([\s\S]*?)(?:\n```|$)/gi;
const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|xml|html?|srt|vtt|rtf|ini|yml|yaml|log)$/i;

// Pull the edit blocks out of a reply: `{ body, edits }`.
export function splitEdits(text) {
  const src = String(text || '');
  const edits = [];
  const body = src.replace(FENCE, (_, json) => {
    try {
      const v = JSON.parse(json.trim());
      for (const e of Array.isArray(v) ? v : [v]) if (e && typeof e.file === 'string') edits.push(e);
    } catch { /* not valid JSON — left out */ }
    return '';
  }).replace(/\n{3,}/g, '\n\n').trim();
  return { body, edits };
}

export const EDIT_RULE = [
  'EDITING RULE — you CAN change the files of this project, including DATA COLLECTIONS (.dvc), text files and Word documents. Never tell me you cannot edit a file or that I must do it by hand.',
  'To change an existing file, end your reply (before any ```choices block) with one fenced block per file, JSON inside, exactly like this:',
  '```docvex-edit',
  '{"file": "PETRE LUCA-ANDREI.dvc", "record": {"phone": "0722 123 456"}, "facts": [{"label": "Telefon", "value": "0722 123 456"}]}',
  '```',
  '- `file`: the file name exactly as listed in the project.',
  '- A data collection (.dvc): "record" = fields to set on its person/company record (the record\'s own keys, e.g. legalName, nationalId, phone, email, address, iban; null removes one), "facts" = [{"label","value"}] to add or update by label (value null removes), "summary"/"title" to replace.',
  '- A text file: "replace" = [{"find": "exact text now in the file", "with": "new text"}], or "content" = the whole new text.',
  '- A Word file (.docx): "replace" = [{"find": "the whole paragraph as it reads now", "with": "the new paragraph"}].',
  'The app applies the block, shows what changed and offers Undo — so just make the change when I ask for it; say in one sentence what you changed. To create a NEW Office document use write_document instead.',
].join('\n');

// Adds the editing rule as an opening exchange.
export function withEditRule(msgs) {
  const list = Array.isArray(msgs) ? msgs : [];
  return [
    { role: 'user', content: EDIT_RULE },
    { role: 'assistant', content: 'Understood — I can edit the project’s files, and will put each change in a ```docvex-edit block at the end of my reply.' },
    ...list,
  ];
}

const dirOf = (p) => String(p || '').replace(/[\\/][^\\/]*$/, '');
const baseOf = (p) => String(p || '').split(/[\\/]/).pop();
const fold = (s) => String(s || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();

function findFile(name, files) {
  const want = fold(name);
  return files.find((f) => f.name === name)
    || files.find((f) => fold(f.name) === want)
    || files.find((f) => fold(f.path).endsWith(want))
    || null;
}

async function writeBack(path, blob) {
  const res = await localFolderApi.writeFiles({ dir: dirOf(path), files: [{ filename: baseOf(path), blob }] });
  if (res?.error) throw new Error(res.error);
  const r = res?.results?.[0];
  if (r && (r.ok === false || r.error)) throw new Error(r.error || 'write failed');
  notifyFilesChanged();
}

// Apply one edit. Returns `{ file, path, changes: [text], undo }`, or
// `{ file, error }`.
async function applyOne(edit, files) {
  const f = findFile(edit.file, files);
  if (!f?.path) return { file: edit.file, error: 'No file of that name in the project.' };
  const before = await readLocalBlob(f.path);
  if (!before) return { file: f.name, error: 'The file could not be read.' };
  const changes = [];
  let next = null;

  if (/\.dvc$/i.test(f.name)) {
    let doc;
    try { doc = JSON.parse(await before.text()); } catch { return { file: f.name, error: 'The data collection could not be read.' }; }
    if (edit.record && typeof edit.record === 'object') {
      doc.record = doc.record && typeof doc.record === 'object' ? doc.record : {};
      for (const [k, v] of Object.entries(edit.record)) {
        if (v == null || v === '') { if (k in doc.record) { delete doc.record[k]; changes.push(`${k} removed`); } } else if (doc.record[k] !== v) {
          changes.push(`${k}: ${doc.record[k] ? `${doc.record[k]} → ` : ''}${v}`);
          doc.record[k] = v;
        }
      }
    }
    if (Array.isArray(edit.facts)) {
      doc.facts = Array.isArray(doc.facts) ? doc.facts : [];
      for (const fx of edit.facts) {
        if (!fx?.label) continue;
        const at = doc.facts.findIndex((x) => fold(x?.label) === fold(fx.label));
        if (fx.value == null || fx.value === '') {
          if (at >= 0) { doc.facts.splice(at, 1); changes.push(`fact “${fx.label}” removed`); }
        } else if (at >= 0) {
          if (doc.facts[at].value !== fx.value) { changes.push(`${fx.label}: ${doc.facts[at].value} → ${fx.value}`); doc.facts[at] = { ...doc.facts[at], value: String(fx.value), sources: [...new Set([...(doc.facts[at].sources || []), 'AI edit'])] }; }
        } else {
          doc.facts.push({ label: String(fx.label), value: String(fx.value), sources: ['AI edit'] });
          changes.push(`${fx.label}: ${fx.value} (added)`);
        }
      }
    }
    for (const k of ['summary', 'title']) {
      if (typeof edit[k] === 'string' && edit[k] !== doc[k]) { doc[k] = edit[k]; changes.push(`${k} rewritten`); }
    }
    if (!changes.length) return { file: f.name, error: 'Nothing to change — it already says that.' };
    doc.updatedAt = Date.now();
    next = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
  } else if (/\.docx$/i.test(f.name)) {
    const reps = (Array.isArray(edit.replace) ? edit.replace : []).filter((r) => r?.find && r.with != null);
    if (!reps.length) return { file: f.name, error: 'No paragraph to change was given.' };
    const { rewriteDocxParagraphs } = await import('./docxRewrite');
    const out = await rewriteDocxParagraphs(before, reps.map((r) => ({ before: String(r.find), after: String(r.with) })));
    if (!out.applied) return { file: f.name, error: 'The paragraph to change was not found in the file.' };
    next = out.blob;
    changes.push(`${out.applied} paragraph${out.applied === 1 ? '' : 's'} rewritten${out.missed?.length ? ` (${out.missed.length} not found)` : ''}`);
  } else if (TEXT_EXT.test(f.name)) {
    let text = await before.text();
    if (typeof edit.content === 'string') { text = edit.content; changes.push('rewritten'); }
    for (const r of (Array.isArray(edit.replace) ? edit.replace : [])) {
      if (!r?.find || r.with == null) continue;
      if (!text.includes(r.find)) continue;
      text = text.replace(r.find, String(r.with));
      changes.push(`“${String(r.find).slice(0, 40)}” → “${String(r.with).slice(0, 40)}”`);
    }
    if (!changes.length) return { file: f.name, error: 'The text to change was not found in the file.' };
    next = new Blob([text], { type: before.type || 'text/plain' });
  } else {
    return { file: f.name, error: 'This kind of file cannot be edited this way.' };
  }

  try { await writeBack(f.path, next); } catch (err) { return { file: f.name, error: `Saving failed — ${err?.message || err}.` }; }
  return {
    file: f.name,
    path: f.path,
    changes,
    undo: async () => { await writeBack(f.path, before); },
  };
}

// Apply every edit in a reply. `files`: the project's files ({ name, path }).
export async function applyAiEdits(edits, files) {
  const out = [];
  for (const e of edits || []) {
    try { out.push(await applyOne(e, files || [])); } catch (err) { out.push({ file: e?.file, error: String(err?.message || err) }); }
  }
  return out;
}

// Undo lives for the session: a message keeps only the key (threads are saved
// as JSON), the previous bytes stay in memory.
const UNDO = new Map();
let undoSeq = 0;
// The results as a message keeps them: no functions, an undo key instead.
export function keepResults(results) {
  return (results || []).map(({ undo, ...r }) => {
    if (!undo) return r;
    const key = `u${Date.now().toString(36)}${(undoSeq += 1)}`;
    UNDO.set(key, undo);
    return { ...r, undoKey: key };
  });
}
export function canUndo(key) { return !!key && UNDO.has(key); }
export async function runUndo(key) {
  const fn = UNDO.get(key);
  if (!fn) return false;
  await fn();
  UNDO.delete(key);
  return true;
}

// A reply's edits applied: the results to keep on the message ([] when none).
export async function applyReplyEdits(text, files) {
  const { edits } = splitEdits(text);
  if (!edits.length) return [];
  return keepResults(await applyAiEdits(edits, files));
}
