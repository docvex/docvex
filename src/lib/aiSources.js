// Where an Advisor answer comes from — the Insights question box's sources,
// carried over to the Advisor. A reply about the project's files ends with a
// ```sources fenced block (JSON: [{ "file": "...", "why": "..." }]); the page
// takes it out of the text and draws each file as a chip that opens it.
// Added ON TOP of the Advisor's other rules (choices, edits, steer) — it
// replaces none of them.
import { AUTHORITY_RULE } from './docAuthority';
import { CHOICES_RULE } from './aiChoices';
import { EDIT_RULE } from './aiFileEdits';

const FENCE = /```sources[^\n]*\n([\s\S]*?)(?:```|$)/i;

export const SOURCES_RULE = [
  'A fixed rule for this conversation, on top of every other rule you have:',
  '- When you answer from the project\'s files (the project context, the data collections, what the AI scan understood, attached files), end your reply with a ```sources fenced block holding JSON — [{"file":"the file name or path exactly as the context writes it","why":"what this file says that answers it"}] — one entry per file you relied on, the most important first, at most 8. Leave the block out when no file was used.',
  '- When the question is about the project, answer from its files, not from guesses; name people, amounts, dates and identifiers exactly as the files write them. If the files disagree, say so. If they do not answer it, say that and what is missing.',
  `- ${AUTHORITY_RULE} The project context says how official each scanned file is ("Official: …").`,
  '- Put the block after your answer (before or after a ```choices / ```docvex-edit block — either works); it is never shown as text.',
].join('\n');

export function withSourcesRule(msgs) {
  const list = Array.isArray(msgs) ? msgs : [];
  return [
    { role: 'user', content: SOURCES_RULE },
    { role: 'assistant', content: 'Understood — when I answer from the project\'s files I end with a ```sources block naming each file and what it says, and I favour the most official document when files disagree.' },
    ...list,
  ];
}

// The rules ride as fake opening exchanges (a user turn stating a rule, an
// assistant turn agreeing). Three of them in a row taught the model the
// pattern "a message arrives → acknowledge the rules", and it answered a
// question with "Understood, I will follow your rules…" instead of the
// answer. So they are FOLDED into ONE exchange, said to be agreed already,
// and the question itself is told to be answered straight away.
const RULE_TEXTS = [SOURCES_RULE, CHOICES_RULE, EDIT_RULE];
const ANSWER_NOW = '[Reply to the message above directly — answer it. The standing rules are already agreed: never acknowledge, list, repeat or summarise them, and never start with "Understood" or similar.]';
export function foldRuleExchanges(msgs) {
  const list = Array.isArray(msgs) ? msgs : [];
  const rules = [];
  let i = 0;
  while (i + 1 < list.length && list[i].role === 'user' && list[i + 1].role === 'assistant'
    && typeof list[i].content === 'string' && RULE_TEXTS.includes(list[i].content)) {
    rules.push(list[i].content);
    i += 2;
  }
  const rest = list.slice(i);
  const out = rules.length ? [
    { role: 'user', content: `STANDING RULES for this whole conversation. They are already agreed — follow them silently in every reply; never acknowledge, list or restate them.\n\n${rules.join('\n\n')}` },
    { role: 'assistant', content: 'OK.' },
    ...rest,
  ] : rest;
  const last = out[out.length - 1];
  if (last?.role === 'user' && typeof last.content === 'string' && !last.content.includes(ANSWER_NOW)) {
    out[out.length - 1] = { ...last, content: `${last.content}\n\n${ANSWER_NOW}` };
  }
  return out;
}

// → { body, sources: [{ file, why }] }
export function splitSources(text) {
  const src = String(text || '');
  const m = FENCE.exec(src);
  if (!m) return { body: src, sources: [] };
  let sources = [];
  try {
    const parsed = JSON.parse(m[1].trim());
    sources = (Array.isArray(parsed) ? parsed : [])
      .map((s) => (typeof s === 'string' ? { file: s, why: '' } : { file: String(s?.file || '').trim(), why: String(s?.why || '').trim() }))
      .filter((s) => s.file)
      .slice(0, 8);
  } catch { sources = []; }
  const body = (src.slice(0, m.index) + src.slice(m.index + m[0].length)).replace(/\n{3,}/g, '\n\n').trimEnd();
  return { body, sources };
}

const fold = (s) => String(s || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\\/g, '/').trim();

// Match each named file to one in the project listing ({ name, path,
// folderPath }); unknown names are dropped.
export function resolveSources(sources, files) {
  const out = [];
  const seen = new Set();
  for (const s of sources || []) {
    const want = fold(s.file);
    const base = want.split('/').pop();
    const f = (files || []).find((x) => fold(`${x.folderPath ? `${x.folderPath}/` : ''}${x.name}`) === want)
      || (files || []).find((x) => fold(x.path).endsWith(`/${want}`))
      || (files || []).find((x) => fold(x.name) === base);
    if (!f || seen.has(f.path || f.name)) continue;
    seen.add(f.path || f.name);
    out.push({ ...s, name: f.name, path: f.path || null, folderPath: f.folderPath || '' });
  }
  return out;
}

// Example questions drawn from what the scan read (the question box's
// examples): the people named in the files, then general case questions.
export function caseStarterPrompts(people = []) {
  const [a, b] = people;
  return [
    a ? `Who is ${a} and what do they own?` : 'Who owns the property?',
    'What amounts are owed, and to whom?',
    b ? `Where does ${b} live?` : 'What are the key dates in this case?',
    'Which documents are signed, and by whom?',
  ];
}
