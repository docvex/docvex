// CLICKABLE ANSWERS in an AI reply. When the assistant asks a question or
// offers options, the options become buttons under its message — pressing one
// sends it as the reply, so nothing has to be retyped.
//
// Two ways a reply carries them:
//   • explicitly — a fenced block at the end, which the steer (CHOICES_STEER)
//     asks the model to write:
//         ```choices
//         - Draft a formal notice
//         - List the other CNPs in the file
//         ```
//   • implicitly — a short list (2–8 items, bullets or numbers) at the END of
//     a reply that asks something (a "?" just before or after the list), which
//     is how a model offers choices when it wasn't asked to use the block.
// Either way the list is taken OUT of the text and shown as the buttons.

const ITEM = /^\s*(?:[-*•–]|\d{1,2}[.)])\s+(.+?)\s*$/;
const FENCE = /\n*```choices[^\n]*\n([\s\S]*?)(?:\n```|$)\s*$/i;

const cleanItem = (s) => String(s || '')
  .replace(/\*\*|__|`/g, '')
  .replace(/\s+/g, ' ')
  .replace(/[;,]$/, '')
  .trim();

// A line that INTRODUCES options without asking ("Opțiuni disponibile:",
// "Pot să:", "Would you like me to:") — enough, with a list or paragraphs after
// it, to read what follows as choices even with no question mark.
const OFFERS = /(op[țţt]iun|option|variant|alternativ|po[țţt]i\b|pute[țţt]i|pot\s|pot:|a[șş]\s+putea|can\s+i|i\s+can|would\s+you|do\s+you\s+want|dore[șş]ti|vrei|choose|alege|next\s+steps|pa[șş]i\s+urm[ăa]tori|what\s+would)/i;

// Options written as PARAGRAPHS under such a line: 2–6 short paragraphs that
// run to the end of the reply.
function paragraphChoices(src) {
  const blocks = src.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  for (let i = blocks.length - 3; i >= 0; i -= 1) {
    const lead = blocks[i];
    if (lead.includes('\n') || lead.length > 90 || !/:\s*$/.test(lead) || !OFFERS.test(lead)) continue;
    const opts = blocks.slice(i + 1);
    if (opts.length < 2 || opts.length > 6 || opts.some((o) => o.length > 320 || ITEM.test(o.split('\n')[0]))) return null;
    return { body: blocks.slice(0, i + 1).join('\n\n'), choices: opts.map((o) => cleanItem(o.replace(/\n/g, ' '))) };
  }
  return null;
}

export function splitChoices(text) {
  const src = String(text || '');
  const fence = FENCE.exec(src);
  if (fence) {
    const choices = fence[1].split('\n')
      .map((l) => cleanItem((ITEM.exec(l) || [null, l])[1]))
      .filter(Boolean)
      .slice(0, 8);
    return { body: src.slice(0, fence.index).trimEnd(), choices };
  }
  const lines = src.split('\n');
  // The LAST run of list lines (blank lines inside a run are allowed).
  let end = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) { if (ITEM.test(lines[i])) { end = i; break; } }
  if (end < 0) return paragraphChoices(src) || { body: src, choices: [] };
  let start = end;
  for (let i = end - 1; i >= 0; i -= 1) {
    if (ITEM.test(lines[i])) start = i;
    else if (!lines[i].trim() && i > 0 && ITEM.test(lines[i - 1])) continue;
    else break;
  }
  const items = lines.slice(start, end + 1).filter((l) => ITEM.test(l)).map((l) => cleanItem(ITEM.exec(l)[1]));
  const after = lines.slice(end + 1).filter((l) => l.trim());
  const before = lines.slice(Math.max(0, start - 2), start).join(' ');
  const asks = /\?\s*$/.test(before.trim()) || /[:?]\s*$/.test(before.trim()) && after.some((l) => l.includes('?'))
    || after.slice(0, 2).some((l) => l.includes('?'))
    || (/:\s*$/.test(before.trim()) && OFFERS.test(before));
  const ok = items.length >= 2 && items.length <= 8 && after.length <= 3
    && items.every((t) => t.length > 0 && t.length <= 160) && asks;
  if (!ok) return { body: src, choices: [] };
  const body = [...lines.slice(0, start), ...lines.slice(end + 1)].join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
  return { body, choices: items };
}

// ── THE FIXED RULE ───────────────────────────────────────────────────────
// How the assistant must offer choices, stated ONCE at the start of every
// conversation (`withChoicesRule` puts it there as the opening exchange, where
// a model weighs it most) and repeated as a one-line reminder on the latest
// message (CHOICES_STEER). Detection above stays as the safety net for a reply
// that forgets it.
export const CHOICES_RULE = [
  'FORMAT RULE — options you offer me are BUTTONS in this app. Follow it in every reply:',
  '1. Whenever you ask me something, offer options, alternatives or next steps, or end with a question, finish the reply with a fenced block named `choices` — the LAST thing in the reply, nothing after it:',
  '```choices',
  '- Redactează o somație de plată',
  '- Listează celelalte CNP-uri din dosar',
  '```',
  '2. One option per line, starting with "- ". 2 to 6 options. Each is SHORT (under 12 words) and written as the exact reply I would send, in the language we are speaking — not as a description ("Redactează o somație", not "Dacă dorești o somație, pot…").',
  '3. Do NOT also write the options as a numbered list, bullets or paragraphs in the text above the block — say what you need in one sentence, then give the block.',
  '4. For a yes/no question, the block holds the two answers (e.g. "- Da, fă asta" / "- Nu").',
  '5. When you are not asking or offering anything, write no block at all.',
  '',
  'CLARIFY RULE — when my question could mean MORE THAN ONE thing in this project, do not guess and do not answer every reading at once. Ask me which one I mean, in one short sentence, and give each candidate as a choice, named concretely with where it comes from. This applies whenever the project holds several of what I asked about: several addresses for a person (the one on the identity document vs. a rented home, a registered office vs. a work point), several people or companies with similar names, several contracts, versions, dates, amounts or files. Example — asked "does he live in a house or a flat?" when the identity card says Constanța, str. 1907 nr. 59 and a lease says Apartamentul 21, Carmen Sylva:',
  'Care adresă? Proiectul are două pentru Petre Luca-Andrei.',
  '```choices',
  '- Adresa din cartea de identitate (Constanța, str. 1907 nr. 59)',
  '- Locuința închiriată (ap. 21, Complexul Carmen Sylva)',
  '- Amândouă',
  '```',
  'Answer straight away (no clarifying question) when only one candidate fits, or when I have already said which one.',
].join('\n');

export const CHOICES_STEER = '[Reminder: if this reply asks me anything or offers options, end it with the ```choices block (one short "- " line per option, written as my reply). No block when you ask nothing.]';

// The rule as the conversation's opening exchange + the reminder on the last
// user message. `msgs` are API messages ({ role, content }).
export function withChoicesRule(msgs) {
  const list = Array.isArray(msgs) ? msgs : [];
  const head = [
    { role: 'user', content: CHOICES_RULE },
    { role: 'assistant', content: 'Understood — every option I offer goes in a ```choices block at the very end, one short line per option, written as your reply.' },
  ];
  const out = [...head, ...list];
  const last = out[out.length - 1];
  if (last?.role === 'user' && typeof last.content === 'string' && !last.content.includes(CHOICES_STEER)) {
    out[out.length - 1] = { ...last, content: `${last.content}\n\n${CHOICES_STEER}` };
  }
  return out;
}

// A prompt that never got an answer (stopped, failed, interrupted) must not
// ride along with the next one: sent as two user turns in a row — or merged
// into one — the model answers the OLD question. `isUser(m)` says which
// messages are the user's; a user message is dropped when the next message
// kept is also the user's (the last one always stays).
export function dropUnanswered(list, isUser) {
  const out = [];
  for (let i = 0; i < list.length; i += 1) {
    const m = list[i];
    if (isUser(m) && i < list.length - 1 && isUser(list[i + 1])) continue;
    out.push(m);
  }
  return out;
}
