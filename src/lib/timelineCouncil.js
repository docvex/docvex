// AI council for the case-timeline reconstruction (Timeline tab,
// ProjectEvents.jsx). Instead of one model pass, the chronology is built by a
// COUNCIL: three analysts with different lenses each draft an independent
// timeline from the same file excerpts (in parallel), then a presiding chair
// merges the drafts into one final timeline — corroborated events survive,
// disagreements between drafts become Contradiction flags.
//
// Degradation is graceful: analysts that error are dropped (any one valid
// draft keeps the run alive); with a single surviving draft the chair round is
// skipped (nothing to merge); if the chair itself fails, the richest draft is
// used as-is. Every path returns the same JSON shape the page's
// normalizeTimeline expects — callers can't tell a degraded run apart except
// via the returned `council` metadata.

import { askProjectAi } from './projectAi';

// Analysts draft on Sonnet (fast/parallel, three calls); the chair merges on
// Opus (one call, the hard synthesis). Both ids are allow-listed by the
// project-ai Edge Function (see AI_MODELS in lib/projectAi.js).
const MEMBER_MODEL = 'claude-sonnet-4-6';
const CHAIR_MODEL = 'claude-opus-4-7';

export const COUNCIL_MEMBERS = [
  {
    id: 'chronologist',
    name: 'Chronologist',
    lens: `Your lens: PRECISION OF THE RECORD. Extract every datable event with exact dates, amounts, parties and document references. Prefer completeness and accuracy over storytelling — short factual titles and bodies, nothing that isn't literally in the sources.`,
  },
  {
    id: 'auditor',
    name: 'Auditor',
    lens: `Your lens: WHAT'S WRONG WITH THE RECORD. Hunt contradictions (dates or amounts that disagree between documents), gaps (long unexplained intervals, referenced-but-missing documents, absent signatures) and ambiguities. Still list the events you can date, but invest most in the "flags" array and per-event "flag" annotations.`,
  },
  {
    id: 'narrator',
    name: 'Narrator',
    lens: `Your lens: THE STORY. Reconstruct the causal chain — what led to what, how the dispute escalated, what each side did and why it mattered. Write a strong "lede" and event bodies that connect events to each other, while staying strictly inside what the files support.`,
  },
];

// Output contract shared by every council round — verbatim the schema the
// single-pass pipeline used, so normalizeTimeline keeps working unchanged.
const TIMELINE_JSON_SPEC = `Respond with ONLY a JSON object — no prose, no markdown fences — in exactly this shape:
{
  "lede": "2-4 sentence narrative summary of the story",
  "events": [
    {
      "date": "14 Mar",
      "year": "2023",
      "kind": "Contract",
      "cat": "project",
      "title": "Framework agreement signed",
      "body": "1-2 sentence description of what happened",
      "files": ["filename.pdf"],
      "isVideo": false,
      "flag": null
    }
  ],
  "flags": [
    { "type": "Contradiction", "sev": "High", "title": "...", "detail": "...", "sources": "file A · file B" }
  ]
}

Field rules:
- "date" is a short day+month ("14 Mar"); "year" the 4-digit year. Order events chronologically.
- "kind" is a short document/event label (Contract, Correspondence, Evidence, Invoice, Filing, …).
- "cat" is one of: project, file, update, member, role.
- "files" lists the EXACT filename(s), verbatim from the provided set, the event is based on. Set "isVideo" true only for events sourced from video/audio.
- An event's "flag" is either null or { "sev": "danger"|"warning", "label": "Contradiction:", "text": "…" } — use it only for issues tied to that moment.
- List EVERY issue in "flags" too. "sev": "High" = must resolve before filing, "Medium" = gap in the record, "Low" = wording/ambiguity.
- Only include events supported by the files; do not invent facts. Write in English (translate foreign-language content; keep short quotes in the original followed by a translation).
- If the files contain no datable events, return {"lede": "", "events": [], "flags": []}.`;

function filesBlock(excerpts) {
  return excerpts.map((f, i) => (f.text
    ? `--- FILE ${i + 1}: ${f.name} ---\n${f.text}`
    : `--- FILE ${i + 1}: ${f.name} --- (contents not readable in-app${f.error === 'unsupported' ? ' — media/binary file, use the filename as context' : `: ${f.error}`})`
  )).join('\n\n');
}

function memberPrompt(projectName, excerpts, member) {
  return `You are the ${member.name}, one analyst on a three-member council reconstructing the chronological story of a legal matter${projectName ? ` for the project "${projectName}"` : ''} from the files below. Each analyst drafts independently; a presiding chair will merge the drafts, so do NOT hedge toward consensus — commit to your own reading.

${member.lens}

${TIMELINE_JSON_SPEC}

${filesBlock(excerpts)}`;
}

// When the analysts' drafts materially disagree, the run pauses and asks the
// AUTHOR how the chair should weigh them (via the `resolveDispute` callback).
// Each option's `rule` is injected verbatim into the chair's merging rules —
// the user's pick genuinely changes the merge.
export const DISPUTE_OPTIONS = [
  {
    id: 'corroborated',
    label: 'Keep only corroborated events',
    desc: 'The chair keeps the beats two or more analysts agree on — a tighter, safer story.',
    rule: 'The author directs: keep ONLY events corroborated by at least two drafts; drop single-draft events unless a flag explains why they matter.',
  },
  {
    id: 'full-record',
    label: 'Keep the full record',
    desc: 'Every sourced event stays in, even ones a single analyst found — the uncertain ones get flagged.',
    rule: 'The author directs: keep EVERY event that cites a source file, including single-draft events, and add a flag on the ones only one draft supports.',
  },
];

// The chair merges drafts — it never sees the raw files, so it is instructed
// to stay inside what the drafts (and the verbatim filename list) support.
// `guidanceRule` (optional) is the author's dispute direction.
function chairPrompt(projectName, fileNames, drafts, guidanceRule) {
  const draftsBlock = drafts.map((d) => (
    `--- DRAFT by ${d.member.name} (${d.member.id}) ---\n${JSON.stringify(d.parsed).slice(0, 20000)}`
  )).join('\n\n');
  return `You are the presiding chair of an AI council reconstructing the chronological story of a legal matter${projectName ? ` for the project "${projectName}"` : ''}. Below are ${drafts.length} independent drafts produced by council analysts from the SAME case files. Merge them into ONE final timeline.

Merging rules:
- Keep an event when at least one draft ties it to a source file; prefer events corroborated by two or more drafts.
- When drafts disagree on a date, amount or sequence, pick the best-supported version AND record the disagreement as a flag (type "Contradiction") naming the files involved.
- Union the drafts' flags; merge near-duplicates, keeping the highest severity and the most specific detail.
- "files" entries must be EXACT filenames from this set: ${fileNames.join(' · ')} — drop any reference that isn't in it.
- Take the lede from the strongest narrative draft, tightened to 2-4 sentences.
- Do not invent facts that appear in none of the drafts.${guidanceRule ? `\n- ${guidanceRule}` : ''}

${TIMELINE_JSON_SPEC}

${draftsBlock}`;
}

// Tolerant JSON extraction — strips markdown fences and grabs the outermost
// object so a stray preamble doesn't sink the parse.
export function parseTimelineJson(text) {
  const raw = String(text || '').trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : raw;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(body.slice(start, end + 1)); } catch { return null; }
}

// A draft is usable when it parsed and actually dated something.
function usableDraft(parsed) {
  return parsed && Array.isArray(parsed.events) && parsed.events.length > 0;
}

// How many of a draft's events cite each filename — real per-file "who read
// what" data for the council UI's fact chips.
function countCitations(parsed) {
  const counts = {};
  for (const e of parsed.events) {
    for (const name of (Array.isArray(e?.files) ? e.files : [])) {
      counts[name] = (counts[name] || 0) + 1;
    }
  }
  return counts;
}

// Do the drafts disagree enough to warrant asking the author? Real signal:
// a wide spread in how many events the analysts dated, or one analyst raising
// flags while another sees a clean record.
function draftsDispute(drafts) {
  const events = drafts.map((d) => d.parsed.events.length);
  const flags = drafts.map((d) => (Array.isArray(d.parsed.flags) ? d.parsed.flags.length : 0));
  return (Math.max(...events) - Math.min(...events)) >= 4
    || (Math.max(...flags) > 0 && Math.min(...flags) === 0);
}

// Run the council. `excerpts` is [{ name, text?, error? }] (the page's
// extraction output). Observability hooks (all optional):
//   • onPhase('drafting' | 'chair') — coarse staging (kept for compatibility).
//   • onEvent(e) — live council telemetry for the Scanning tab's chamber UI:
//       { type:'convene', members }                        the session opens
//       { type:'member-start', member }                    an analyst begins
//       { type:'member-done', member, events, flags, citations }
//       { type:'member-error', member, message }
//       { type:'dispute', drafts:[{ id, name, events, flags }] }
//       { type:'steer', option }                           the author decided
//       { type:'chair-start', drafts }                     merge round opens
//       { type:'chair-done', events, flags }               merge succeeded
//       { type:'chair-skip' } / { type:'chair-fallback' }  degraded paths
//   • resolveDispute(dispute) — awaited when the drafts materially disagree;
//     resolve with one of DISPUTE_OPTIONS (its `rule` steers the chair) or
//     null to let the chair weigh the drafts itself.
// Resolves { parsed, council } — `parsed` feeds normalizeTimeline, `council`
// is metadata for display/persistence:
//   { size, memberModel, chairModel, members: [{ id, name, ok, events }],
//     merged, degraded, steer? }
// Throws when no analyst produced a usable draft.
export async function runTimelineCouncil({ projectName, fileNames, excerpts, onPhase, onEvent, resolveDispute }) {
  const emit = (e) => { try { onEvent?.(e); } catch { /* UI-only */ } };
  emit({ type: 'convene', members: COUNCIL_MEMBERS.map((m) => ({ id: m.id, name: m.name })) });
  onPhase?.('drafting');

  const results = await Promise.all(COUNCIL_MEMBERS.map(async (member) => {
    emit({ type: 'member-start', member });
    try {
      const res = await askProjectAi({
        messages: [{ role: 'user', content: memberPrompt(projectName, excerpts, member) }],
        projectName,
        fileNames,
        model: MEMBER_MODEL,
        tools: false,
      });
      if (res.error) throw res.error;
      const parsed = parseTimelineJson(res.text);
      if (!usableDraft(parsed)) throw new Error('the draft contained no datable events');
      emit({
        type: 'member-done',
        member,
        events: parsed.events.length,
        flags: Array.isArray(parsed.flags) ? parsed.flags.length : 0,
        citations: countCitations(parsed),
        // The draft's reading of the story — surfaces as the analyst's
        // "proposal" in the chamber UI.
        lede: String(parsed.lede || '').slice(0, 240),
      });
      return { member, parsed };
    } catch (err) {
      emit({ type: 'member-error', member, message: String(err?.message || err) });
      return { member, error: err };
    }
  }));

  const drafts = results.filter((r) => r.parsed);
  if (drafts.length === 0) {
    const firstError = results.find((r) => r.error)?.error;
    throw new Error(firstError?.message
      ? `the AI council could not read the files (${firstError.message})`
      : 'the AI council found no datable events in these files');
  }

  const memberMeta = COUNCIL_MEMBERS.map((m) => ({
    id: m.id,
    name: m.name,
    ok: drafts.some((d) => d.member.id === m.id),
    events: drafts.find((d) => d.member.id === m.id)?.parsed.events.length ?? 0,
  }));
  const council = {
    size: drafts.length,
    memberModel: MEMBER_MODEL,
    chairModel: CHAIR_MODEL,
    members: memberMeta,
    merged: false,
    degraded: drafts.length < COUNCIL_MEMBERS.length,
  };

  // One surviving draft → nothing to merge; skip the chair round.
  if (drafts.length === 1) {
    emit({ type: 'chair-skip' });
    return { parsed: drafts[0].parsed, council: { ...council, degraded: true } };
  }

  // Real dispute round — when the drafts materially disagree, the author
  // steers how the chair weighs them (the picked option's rule goes verbatim
  // into the chair prompt).
  let steer = null;
  if (typeof resolveDispute === 'function' && draftsDispute(drafts)) {
    const summary = drafts.map((d) => ({
      id: d.member.id,
      name: d.member.name,
      events: d.parsed.events.length,
      flags: Array.isArray(d.parsed.flags) ? d.parsed.flags.length : 0,
    }));
    emit({ type: 'dispute', drafts: summary });
    try { steer = await resolveDispute({ drafts: summary, options: DISPUTE_OPTIONS }); }
    catch { steer = null; }
    if (steer) emit({ type: 'steer', option: steer });
  }

  onPhase?.('chair');
  emit({ type: 'chair-start', drafts: drafts.length });
  let chairParsed = null;
  try {
    const res = await askProjectAi({
      messages: [{ role: 'user', content: chairPrompt(projectName, fileNames, drafts, steer?.rule) }],
      projectName,
      fileNames,
      model: CHAIR_MODEL,
      tools: false,
    });
    if (!res.error) chairParsed = parseTimelineJson(res.text);
  } catch { /* chair failure falls back to the best draft below */ }

  if (usableDraft(chairParsed)) {
    emit({
      type: 'chair-done',
      events: chairParsed.events.length,
      flags: Array.isArray(chairParsed.flags) ? chairParsed.flags.length : 0,
    });
    return { parsed: chairParsed, council: { ...council, merged: true, steer: steer?.id || null } };
  }
  // Chair failed — richest draft (most events) stands in for the merge.
  emit({ type: 'chair-fallback' });
  const best = [...drafts].sort((a, b) => b.parsed.events.length - a.parsed.events.length)[0];
  return { parsed: best.parsed, council: { ...council, degraded: true, steer: steer?.id || null } };
}
