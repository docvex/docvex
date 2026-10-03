// Client wrapper for the `project-ai` Edge Function — live Claude for the
// project AI hub (the /ai surface). Mirrors the invoke pattern in
// legalFeed.getWeeklyDigest: the function returns a 200 with
// `{ ok:false, error }` when the AI key isn't configured, so callers fall
// back gracefully instead of throwing on a non-2xx.

import { supabase } from './supabaseClient';
import { recordAiTokens, getAiUsageProject } from './aiTokenMeter';
import { getActiveJurisdiction } from './jurisdictions';
import { isPseudonymizeOn, FAIL_CLOSED } from './pseudonymizeSetting';
import { recordSent } from './pseudonymize/sentLog';

// PSEUDONYMISATION (lib/pseudonymize, lib/pseudonymizeSetting): when a call's
// text is to be masked, its body is masked here and its answer re-identified
// here, so every caller keeps seeing real values. `guard` = what
// `vaultForCall` answered: `{ vault }` (null = send as it is) or `{ error }`
// (fail closed — nothing is sent).
// The vault and its detectors are loaded only when a call is to be masked —
// they pull in lib/lawRefs, which must stay out of the startup bundle.
async function vaultForCall(usageProject, usageAction) {
  const projectId = usageProject === undefined ? getAiUsageProject() : usageProject;
  const wanted = isPseudonymizeOn(projectId, usageAction) || (!projectId && usageProject !== null && FAIL_CLOSED.has(usageAction));
  if (!wanted) return { vault: null, projectId };
  const t = await import('./pseudonymize/transport');
  return t.vaultForCall(usageProject, usageAction);
}
const vaultError = () => ({ error: new Error('vault_unavailable') });
// The body as it will go out — masked when the call is — and a record of it in
// the "What was sent" log (lib/pseudonymize/sentLog: the masked text only;
// nothing for a call sent as it is).
// It also names the project the call is made in (`projectId`), which the
// function checks the caller belongs to (supabase/functions/_shared/guard.ts).
const masked = (guard, body, usageAction, { log = true } = {}) => {
  const maskedBody = guard.vault ? guard.wire.maskBody(body, guard.vault, guard.maskOpts) : body;
  const out = guard.projectId ? { ...maskedBody, projectId: guard.projectId } : maskedBody;
  if (log) {
    recordSent({
      usageAction, projectId: guard.projectId, masked: !!guard.vault,
      reason: guard.reason || (guard.vault ? '' : 'not masked (this project\u2019s setting)'),
      preview: guard.vault ? guard.wire.bodyText(out) : null,
    });
  }
  return out;
};
// A body whose pictures are redacted too (lib/pseudonymize/imageRedact) when
// the call is masked: identifiers in a picture painted over with their tokens.
// Fails closed — a picture that cannot be read here is not sent.
async function maskedWithImages(guard, body, usageAction) {
  if (guard.vault) {
    const { redactImagesInBody } = await import('./pseudonymize/imageRedact');
    try {
      body = await redactImagesInBody(body, guard.vault, guard.maskOpts);
    } catch (err) {
      recordSent({ usageAction, projectId: guard.projectId, masked: false, sent: false, reason: 'not sent: a picture could not be redacted on this computer' });
      throw err;
    }
  }
  return masked(guard, body, usageAction);
}
const restored = (guard, answer) => (guard.vault ? guard.vault.reidentify(answer) : answer);

// Every request carries the open project's jurisdiction so the Edge Function
// can build a system prompt that names the right law, courts and answer
// language (it re-resolves the code against its own allow-list — see
// supabase/functions/_shared/jurisdictions.ts). Omitted when nothing is set,
// which leaves the function on its Romania default.
function withJurisdiction(body, override) {
  const code = override === undefined ? getActiveJurisdiction() : override;
  return code ? { ...body, jurisdiction: code } : body;
}

// Selectable Claude models, surfaced in the chat composer's model picker. The
// `best` line is the in-UI guidance for "which model for which task". `id`s are
// passed through to the `project-ai` Edge Function, which allow-lists them.
// Default is Opus 4.7 (the model the chat has always used here, so the default
// behaviour is unchanged); Sonnet/Haiku are opt-in for speed/cost.
export const AI_MODELS = [
  {
    id: 'claude-opus-4-7',
    label: 'Opus',
    tagline: 'Deepest reasoning',
    best: 'Complex drafting, nuanced legal analysis, and long documents. Most capable — slowest and priciest.',
  },
  {
    id: 'claude-sonnet-4-6',
    label: 'Sonnet',
    tagline: 'Fast & balanced',
    best: 'Most everyday tasks — chat, summaries, and building slide decks / Word docs. Great quality, much quicker than Opus.',
  },
  {
    id: 'claude-haiku-4-5',
    label: 'Haiku',
    tagline: 'Fastest & cheapest',
    best: 'Quick questions, short edits, and simple lists. Snappiest and cheapest; less deep on hard reasoning.',
  },
];
export const DEFAULT_AI_MODEL = 'claude-opus-4-7';
const MODEL_IDS = new Set(AI_MODELS.map((m) => m.id));
// Normalise a possibly-stale/unknown model id to a valid one (or the default).
export function coerceModel(id) {
  return MODEL_IDS.has(id) ? id : DEFAULT_AI_MODEL;
}

function unwrap(data, error) {
  if (error) return { error };
  if (!data || data.ok === false) {
    return { error: new Error(data?.error || 'ai_unavailable') };
  }
  return { data };
}

// Q&A turn. `messages` is the running conversation as
// [{ role: 'user' | 'assistant', content }] — `content` is a string for ordinary
// turns or an array of content blocks for a tool round-trip. Returns
// `{ text, usage, stopReason?, tool?, toolUse?, askUser?, assistantContent? }` or
// `{ error }`.
//   • `usage` = { input_tokens, output_tokens } for the token-usage indicator.
//   • When the model calls a tool, `stopReason === 'tool_use'` and `tool` names it:
//     - 'ask_user'       → `askUser = { id, input:{ questions:[…] } }`
//     - 'write_document' → `toolUse = { id, input:{ kind, summary?, content } }`
//     `assistantContent` is the raw assistant content blocks (replay on resume).
// Options:
//   • `tools: false`   — utility calls (e.g. title generation): no tools at all.
//   • `docTools: true` — DocViewer "generate" surface: expose write_document so
//     the model drives an iterative document build (it may also ask_user).
//   • `forceDocument: true` — pin tool_choice to write_document (guarantees a new
//     version; use when the user clearly asked for a document).
//   • `docKind` — 'docx'|'pptx'|'xlsx' to lock the format across versions.
//   • `usageProject` — which project this turn's tokens are billed to. Omit for
//     the ambient selected project (the normal case); pass `null` for calls
//     that aren't project work at all (the personal Mail tab).
//   • `usageAction` — the project_ai_usage action bucket for this turn.
//   • `context` — the turn's STABLE data (the project's files, the open file),
//     sent apart so the server caches it as its own block (prompt caching).
//   • `effort` — 'low' | 'medium' | 'high' (output_config.effort; ignored on
//     Haiku). Keep it constant within a conversation: a change drops the cache.
//   • `webSearch` — let Claude search the web (Anthropic's own server-side
//     search); the answer then carries `sources` (numbered as the [n](url)
//     links the server writes into its text) and `searches` (the queries).
function askBody({ messages, projectName, fileNames, model, tools, docTools, forceDocument, docKind, jurisdiction, context, effort, webSearch, searchAlways }) {
  const body = withJurisdiction({ action: 'ask', messages, projectName, fileNames, model }, jurisdiction);
  if (tools === false) body.tools = false;
  if (docTools) body.docTools = true;
  if (forceDocument) body.forceDocument = true;
  if (docKind) body.docKind = docKind;
  if (context) body.context = context;
  if (effort) body.effort = effort;
  if (webSearch) body.webSearch = true;
  if (webSearch && searchAlways) body.searchAlways = true;
  return body;
}
// The server reports cached input apart (cache reads / writes); the meter
// counts all of it as input.
function meterUsage(usage) {
  const u = usage || {};
  return {
    ...u,
    input_tokens: (Number(u.input_tokens) || 0) + (Number(u.cache_read_input_tokens) || 0) + (Number(u.cache_creation_input_tokens) || 0),
    output_tokens: Number(u.output_tokens) || 0,
  };
}
function answerFrom(data, { usageProject, usageAction, model }) {
  const usage = data.usage || { input_tokens: 0, output_tokens: 0 };
  // Every project-ai `ask` turn — chat, the Doc Viewer advisor, AI file
  // indexing, AI search, the timeline council — funnels through here, so this
  // one line is what makes the per-project token total real. Fire-and-forget:
  // it must not delay or fail the answer.
  recordAiTokens({ projectId: usageProject, usage: meterUsage(usage), action: usageAction, model: model || null });
  return {
    text: data.text || '',
    usage,
    stopReason: data.stopReason || null,
    tool: data.tool || null,
    toolUse: data.toolUse || null,
    askUser: data.askUser || null,
    assistantContent: data.assistantContent || null,
    features: Array.isArray(data.features) ? data.features : [],
    // The web sources the answer cites ([{ index, title, url, snippet, cited }])
    // and the searches made — empty when it didn't search.
    sources: Array.isArray(data.sources) ? data.sources : [],
    searches: Array.isArray(data.searches) ? data.searches : [],
  };
}

export async function askProjectAi(opts) {
  const { usageProject, usageAction = 'chat', model } = opts;
  const guard = await vaultForCall(usageProject, usageAction);
  if (guard.error) return vaultError();
  let body;
  try { body = await maskedWithImages(guard, askBody(opts), usageAction); } catch (err) { return { error: err }; }
  const { data, error } = await supabase.functions.invoke('project-ai', { body });
  const res = unwrap(data, error);
  if (res.error) return res;
  return restored(guard, answerFrom(res.data, { usageProject, usageAction, model }));
}

/**
 * The same turn, STREAMED: `onText(piece, soFar)` is called as the answer
 * arrives, then the finished answer is returned exactly as askProjectAi returns
 * it. A server that does not stream yet (it answers JSON) is read as a plain
 * answer, so this is safe to call before the function is redeployed. `signal`
 * aborts the request (Stop). With `webSearch`, `onSearch(query)` is called as a
 * search starts ('' while its query is still being written) and
 * `onSources(list)` whenever the numbered sources change.
 */
export async function askProjectAiStream(opts) {
  const { usageProject, usageAction = 'chat', model, signal } = opts;
  const guard = await vaultForCall(usageProject, usageAction);
  if (guard.error) return vaultError();
  // Re-identified as it arrives, a token never split across two pieces.
  const sink = guard.vault ? guard.wire.makeStreamReidentifier(guard.vault, opts.onText) : null;
  const onText = sink ? (piece) => sink.push(piece) : opts.onText;
  let body;
  try { body = await maskedWithImages(guard, askBody(opts), usageAction); } catch (err) { return { error: err }; }
  let token = '';
  try { token = (await supabase.auth.getSession())?.data?.session?.access_token || ''; } catch { token = ''; }
  // Signed in or nothing: the function refuses the anon key, so don't send it.
  if (!token) return { error: new Error('not_signed_in') };
  const anon = import.meta.env.VITE_SUPABASE_ANON_KEY;
  let resp;
  try {
    resp = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/project-ai`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: anon, Authorization: `Bearer ${token}` },
      body: JSON.stringify({ ...body, stream: true }),
      signal,
    });
  } catch (e) {
    return { error: e?.name === 'AbortError' ? new Error('aborted') : e };
  }
  const type = resp.headers.get('content-type') || '';
  if (!type.includes('text/event-stream') || !resp.body) {
    let data = null;
    try { data = await resp.json(); } catch { data = null; }
    const res = unwrap(data, resp.ok ? null : new Error(data?.error || `http_${resp.status}`));
    if (res.error) return res;
    if (res.data.text) onText?.(res.data.text, res.data.text);
    sink?.end();
    return restored(guard, answerFrom(res.data, { usageProject, usageAction, model }));
  }
  const reader = resp.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  let text = '';
  let done = null;
  try {
    for (;;) {
      const { value, done: end } = await reader.read();
      if (end) break;
      buf += value;
      let cut;
      while ((cut = buf.indexOf('\n\n')) >= 0) {
        const line = buf.slice(0, cut).split('\n').find((l) => l.startsWith('data:'));
        buf = buf.slice(cut + 2);
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
        if (ev.t === 'text') { text += ev.d; onText?.(ev.d, text); } else if (ev.t === 'done') done = ev;
        else if (ev.t === 'search') opts.onSearch?.(String(ev.q || ''));
        else if (ev.t === 'sources' && Array.isArray(ev.d)) opts.onSources?.(restored(guard, ev.d));
        else if (ev.t === 'error') return { error: new Error(ev.detail || ev.error || 'ai_failed') };
      }
    }
  } catch (e) {
    return { error: e?.name === 'AbortError' ? new Error('aborted') : e };
  }
  if (!done) return { error: new Error('The answer was cut off.') };
  sink?.end();
  return restored(guard, answerFrom(done, { usageProject, usageAction, model }));
}

/**
 * Write the cache for a turn's prefix without generating anything (the
 * server's `warm` — max_tokens 0), so the question that follows starts warm.
 * Fire-and-forget; `opts` must match the coming turn (model, tools, context,
 * effort) or the warm-up is wasted.
 */
export async function warmProjectAi(opts) {
  try {
    // Masked exactly as the turn will be, or the cached prefix never matches
    // (and an unmasked warm-up would send what the turn keeps back).
    const guard = await vaultForCall(opts.usageProject, opts.usageAction || 'chat');
    if (guard.error) return null;
    const body = masked(guard, askBody({ ...opts, messages: [{ role: 'user', content: '.' }] }), opts.usageAction || 'chat', { log: false });
    const { data } = await supabase.functions.invoke('project-ai', { body: { ...body, warm: true } });
    return data?.usage || null;
  } catch { return null; }
}

// ── The file graph (the Files tab's AI scan; project-ai fileGraph.ts) ──────
// MAP: ≤8 files' text → one PASSPORT each (summary, subject, document type,
// facts, parties, dates, themes, identity-document holder). Returns
// `{ passports, missing }` or `{ error }`; a file in `missing` was left out by
// the model and should be retried.
export async function passportFiles({ files, jurisdiction, usageProject, usageAction = 'files-scan' }) {
  const guard = await vaultForCall(usageProject, usageAction);
  if (guard.error) return vaultError();
  const body = masked(guard, withJurisdiction({ action: 'passport', files }, jurisdiction), usageAction);
  const { data, error } = await supabase.functions.invoke('project-ai', { body });
  const res = unwrap(data, error);
  if (res.error) return res;
  recordAiTokens({ projectId: usageProject, usage: res.data.usage || {}, action: usageAction, model: 'claude-sonnet-5' });
  return restored(guard, { passports: res.data.passports || [], missing: res.data.missing || [] });
}

// REDUCE: passports (`{ id, name, ...passport }`) → `{ graph: { timeline,
// facts, links }, dropped }` or `{ error }`. Each link is `{ from_file_id,
// to_file_id, connection_type, explanation, evidence, confidence }`.
export async function crossrefPassports({ passports, jurisdiction, usageProject, usageAction = 'files-scan' }) {
  const guard = await vaultForCall(usageProject, usageAction);
  if (guard.error) return vaultError();
  const body = masked(guard, withJurisdiction({ action: 'crossref', passports }, jurisdiction), usageAction);
  const { data, error } = await supabase.functions.invoke('project-ai', { body });
  const res = unwrap(data, error);
  if (res.error) return res;
  recordAiTokens({ projectId: usageProject, usage: res.data.usage || {}, action: usageAction, model: 'claude-sonnet-5' });
  return restored(guard, { graph: res.data.graph || { timeline: [], facts: [], links: [] }, dropped: res.data.dropped || [] });
}

// Build the two messages that RESUME a paused ask_user turn: the assistant turn
// replayed exactly as received (its tool_use block) + a user turn carrying the
// tool_result. Append both to history before the next askProjectAi call.
export function buildAskResume(askUser, assistantContent, answers) {
  return [
    { role: 'assistant', content: assistantContent || [{ type: 'tool_use', id: askUser.id, name: 'ask_user', input: askUser.input }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: askUser.id, content: JSON.stringify(answers) }] },
  ];
}

// Normalise the panel's per-question selections into the tool_result payload the
// model reads back. `perQuestion` is keyed by question id → an array of selected
// option ids, a free-text string, or a boolean (confirm).
export function makeAskAnswers(questions, perQuestion, { dismissed = false } = {}) {
  if (dismissed) return { answers: [], dismissed: true };
  const answers = (questions || []).map((q) => {
    const v = perQuestion[q.id];
    if (q.response_type === 'free_text') return { question_id: q.id, response_type: 'free_text', text: String(v ?? '') };
    if (q.response_type === 'confirm') return { question_id: q.id, response_type: 'confirm', approved: !!v };
    const ids = Array.isArray(v) ? v : v != null ? [v] : [];
    const labels = ids.map((id) => (q.options || []).find((o) => o.id === id)?.label).filter(Boolean);
    return { question_id: q.id, response_type: q.response_type, selected: ids, label: labels };
  });
  return { answers };
}

// Suggest content-aware actions for a dropped file. `excerpt` is an optional
// text sample (texty files only); binaries pass just name + mime. Returns
// `{ suggestions: [{ label, prompt }] }` or `{ error }` so the caller can fall
// back to its own heuristic list.
export async function suggestFileActions({ fileName, excerpt, mimeType }) {
  const guard = await vaultForCall(undefined, 'suggest');
  if (guard.error) return vaultError();
  const { data, error } = await supabase.functions.invoke('project-ai', {
    body: masked(guard, { action: 'suggest', fileName, excerpt, mimeType }, 'suggest'),
  });
  const res = unwrap(data, error);
  if (res.error) return res;
  const suggestions = Array.isArray(res.data.suggestions) ? res.data.suggestions : [];
  return { suggestions: restored(guard, suggestions) };
}

// Draft a document. Returns `{ text }` or `{ error }`.
//
// The user's learned writing style (Playbook) is folded into the instructions
// rather than sent as its own field: `generate` takes free-text instructions, so
// this works against the function as already deployed and needs nothing added
// server-side. Lazy-imported to keep this module free of a cycle — writingStyle
// calls askProjectAi from right here.
export async function generateDocument({ template, instructions, projectName, fileNames }) {
  let steered = instructions;
  try {
    const { styleSteer } = await import('./writingStyle');
    const { docRulesSteer } = await import('./docRules');
    // How they write (learned) and how they lay a document out (stated in the
    // Playbook). Both ride on the instructions, both are optional.
    const parts = [instructions || '', await styleSteer(), docRulesSteer()].filter((x) => String(x).trim());
    steered = parts.join('\n\n').trim();
  } catch { /* a generic voice is a worse draft, not a failed one */ }
  const guard = await vaultForCall(undefined, 'generate');
  if (guard.error) return vaultError();
  const { data, error } = await supabase.functions.invoke('project-ai', {
    body: masked(guard, withJurisdiction({ action: 'generate', template, instructions: steered, projectName, fileNames }), 'generate'),
  });
  const res = unwrap(data, error);
  if (res.error) return res;
  return { text: restored(guard, res.data.text || '') };
}

// Build a real Office file from `content` using Anthropic's document Agent Skills
// (pptx/docx/xlsx/pdf) — the high-fidelity path. Returns `{ base64, kind }` on
// success, or `{ unavailable: true }` when the account lacks the betas (so the
// caller falls back to the local JS builders), or `{ error }` on a hard failure.
export async function generateOfficeFile({ kind, content, instructions, model }) {
  // The file comes back BUILT: placeholders inside it could not be put back,
  // and it would sit in the provider's Files API. With masking on, the caller's
  // local builders (docx / pptxgenjs / SheetJS / jsPDF) make it on this machine.
  const projectId = getAiUsageProject();
  if (isPseudonymizeOn(projectId, 'office')) return { unavailable: true, code: 'masked_local' };
  const { data, error } = await supabase.functions.invoke('project-ai', {
    body: withJurisdiction({ action: 'office', kind, content, instructions, model }),
  });
  if (error) return { error, detail: error.message };
  if (data?.ok && data.base64) return { base64: data.base64, kind: data.kind || kind, containerId: data.containerId || null };
  // Soft signals → fall back to local generation rather than failing the write.
  if (data?.error === 'office_unavailable' || data?.error === 'unsupported_kind' || data?.error === 'no_file') {
    return { unavailable: true, code: data.error, detail: data.detail };
  }
  return { error: new Error(data?.error || 'office_failed'), detail: data?.detail };
}
