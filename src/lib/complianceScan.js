// ATTACK — the legal compliance scan of a document (the Doc Viewer's Attack
// quick action).
//
// A document is read against Romanian and EU law, given a score out of 100 and
// a report: Executive Summary, Score, Identified Vulnerabilities (each tied to
// the law and article it turns on — its Legal Anchor) and a Step-by-Step
// Remediation Plan whose every fix is a markdown `diff` block.
//
// WHY IT IS A PIPELINE, NOT ONE AI CALL WITH TOOLS. The legal sources the app
// is connected to (lib/sourceChecks: legislatie.just.ro, ANAF, CAEN, the courts'
// portal) can only be reached from THIS computer — legislatie.just.ro refuses
// the server, ANAF and the courts are called by the desktop app's main process
// — and the project-ai function runs only its own two tools. So the AI cannot
// look a law up in the middle of its answer; the verifying happens here:
//   1. FINDINGS  — the AI reads the document (in sections when it is long) and
//      answers JSON: every vulnerability with the passage, the act and article
//      it turns on, a severity and the rewrite that fixes it.
//   2. VERIFY    — every finding's anchor is checked against the connected
//      sources (checkText on "art. N din <act>"): an act that does not exist,
//      an article that is not in it or is repealed → the finding is DROPPED;
//      a source that cannot be reached, or an EU act (EUR-Lex is not connected
//      yet) → kept, marked NOT VERIFIED. The article's real text is quoted.
//      The document's own citations are checked the same way.
//   3. REPORT    — the AI writes the report from the VERIFIED findings and the
//      quoted article texts only, with the score computed here.
//   4. ENFORCE   — the report must have every section, the exact score and a
//      `diff` block per remediation; an answer that doesn't is sent back once
//      with what is wrong, and failing that the report is built here from the
//      same data, so the layout is always right.
//
// Everything that reaches the AI goes through lib/projectAi, so the project's
// pseudonymisation applies. `ask` / `check` are injectable for the tests.

import { checkText } from './sourceChecks';

// The app's one AI engine (lib/aiEngine), as a utility call — streamed, so a
// long answer is never cut off as idle. Its errors are strings; the scan
// reads Errors.
const askEngine = async (opts) => {
  const { askAi } = await import('./aiEngine');
  const { tools, ...rest } = opts; // eslint-disable-line no-unused-vars
  const res = await askAi({ surface: 'tool', timeoutMs: SCAN_LIMITS.askMs, ...rest });
  return res?.error ? { ...res, error: new Error(res.error) } : res;
};

// TIME: an Edge Function call is cut off at 150 s (wall clock), and one that
// sends nothing for 150 s is cut off as idle. So every call is STREAMED (the
// text keeps the connection alive) and kept SMALL — a section of ~20k
// characters, at most 10 findings, short fields — to end well inside the limit.
// (Reading 60k characters at once ran past 150 s and every scan failed.)
export const SCAN_LIMITS = {
  chunkChars: 20000,      // a section of a long document read in one call
  maxChunks: 12,
  parallel: 3,            // sections read at once
  perSection: 10,         // findings kept per section
  maxFindings: 30,
  checkMs: 20000,         // one anchor's check
  documentCheckMs: 45000, // the document's own citations
  askMs: 140000,          // one AI call (the function's own limit is 150 s)
};

export const SEVERITY = {
  critical: { label: 'Critical', min: 15, max: 25, base: 20 },
  major: { label: 'Major', min: 6, max: 14, base: 10 },
  minor: { label: 'Minor', min: 1, max: 5, base: 3 },
};
// A finding that could not be verified costs half.
export const UNVERIFIED_WEIGHT = 0.5;

export const REPORT_SECTIONS = ['Executive Summary', 'Score', 'Identified Vulnerabilities', 'Step-by-Step Remediation Plan'];

// ── The prompts ──────────────────────────────────────────────────────────────
export const FINDINGS_PROMPT = `You are a senior Romanian lawyer auditing a document for legal vulnerabilities under ROMANIAN and EUROPEAN UNION law: the Civil Code (Codul civil, Legea nr. 287/2009), the Labour Code (Codul muncii, Legea nr. 53/2003), consumer protection (OG nr. 21/1992, OUG nr. 34/2014, Legea nr. 193/2000 on unfair terms), data protection (GDPR — Regulamentul (UE) 2016/679, Legea nr. 190/2018), the Fiscal Code, the Code of Civil Procedure and any other act that governs the document.

Find every clause that is unlawful, void, voidable, unenforceable, unfair to a consumer or employee, non-compliant, or that exposes a party to a sanction or a claim. Also find what the law requires and the document leaves out.

Rules:
- Every finding must rest on a SPECIFIC act and article that you are sure exists. Write the act the way a Romanian lawyer cites it: "Legea nr. 287/2009" (or "Codul civil"), "Legea nr. 53/2003" (or "Codul muncii"), "OUG nr. 34/2014", "Regulamentul (UE) 2016/679". Write the article as "art. 1270" (add "alin. (2)" where it matters, in the article field). Never invent a number. If you are not sure of the article, leave the finding out.
- Mark "law": "eu" for an act of the European Union, "ro" otherwise.
- "passage": the document's exact words the finding is about, copied character for character (empty only for something MISSING).
- "fix": "before" = the exact passage (or "" when adding), "after" = the corrected wording, in the document's own language and style.
- "severity": "critical" (void / sanction / major liability), "major" (likely unenforceable or a real exposure), "minor" (a formal defect or a risk).
- Write "title", "problem" and "after" in the language of the document.
- Report AT MOST 10 findings, the most serious first. Keep it short: "passage" is the shortest exact span that shows the problem (one sentence, at most ~300 characters), "problem" at most two sentences, "after" only the corrected wording of that span.

Answer with JSON only, no prose, in exactly this shape:
{"findings":[{"title":"","severity":"critical|major|minor","law":"ro|eu","act":"","article":"","passage":"","problem":"","fix":{"before":"","after":""}}]}
An answer with nothing to report is {"findings":[]}.`;

export const REPORT_PROMPT = `You write the final report of a legal compliance scan. You are given the document's name, the score (already computed — use it EXACTLY), and the findings that survived verification against the official sources, each with the text of the article it rests on when the source returned it.

Use ONLY these findings and these article texts. Add no finding, cite no other article, do not change a score. A finding marked NOT VERIFIED must say so in its entry.

Write in the language of the document's findings. Use exactly this markdown layout, these four headings in English, in this order:

## Executive Summary
Three to six sentences: what the document is, its overall standing, the most serious problems.

## Score
The line \`Score: N/100\` (N as given), then one line per deduction: "- <title>: -<points>".

## Identified Vulnerabilities
One entry per finding, numbered, in the order given: the title in bold, the severity, the problem, then a line "Legal anchor: <act>, <article>" and, when given, the article's text as a quote (> …). Add "(not verified)" after the anchor of a NOT VERIFIED finding.

## Step-by-Step Remediation Plan
One numbered step per finding, in the same order: what to do, then a fenced \`\`\`diff block with the passage as "-" lines and the corrected wording as "+" lines (only "+" lines when something is added).`;

// ── Splitting a long document ───────────────────────────────────────────────
// At a heading or a blank line where possible, never inside a word.
export function splitSections(text, max = SCAN_LIMITS.chunkChars) {
  const s = String(text || '');
  if (s.length <= max) return s ? [s] : [];
  const out = [];
  let at = 0;
  while (at < s.length) {
    if (s.length - at <= max) { out.push(s.slice(at)); break; }
    const window = s.slice(at, at + max);
    const cut = (() => {
      const head = window.search(/\n(?=(?:CAPITOLUL|Capitolul|SECȚIUNEA|Secțiunea|Art\.|Articolul|\d+\.\s+[A-ZĂÂÎȘȚ]))[^\n]*$/);
      const candidates = [
        window.lastIndexOf('\n\n'),
        head,
        window.lastIndexOf('\n'),
        window.lastIndexOf('. '),
        window.lastIndexOf(' '),
      ].filter((i) => i > max * 0.5);
      return candidates.length ? Math.max(...candidates) + 1 : max;
    })();
    out.push(s.slice(at, at + cut));
    at += cut;
  }
  return out.map((c) => c.trim()).filter(Boolean);
}

// ── Reading the AI's JSON ───────────────────────────────────────────────────
// What went wrong with a call, in words a reader can act on.
export function aiErrorText(err) {
  const m = String(err?.message || err || '');
  if (/http_546|http_504|cut off|took too long|IDLE_TIMEOUT|WORKER_RESOURCE/i.test(m)) return 'The AI took too long on this document. Try again.';
  if (/not_signed_in|http_401/.test(m)) return 'Sign in to run the scan.';
  if (/http_429|rate_limit/i.test(m)) return 'Too many AI requests right now. Try again in a minute.';
  if (/vault_unavailable/.test(m)) return 'Nothing was sent: names could not be masked on this computer (Settings → Privacy).';
  if (/aborted/.test(m)) return 'Stopped.';
  return m ? `The AI could not read the document (${m}).` : 'The AI could not read the document.';
}

const str = (v, n = 2000) => String(v ?? '').replace(/\s+\n/g, '\n').trim().slice(0, n);
export function parseFindings(answer) {
  const t = String(answer || '');
  const start = t.indexOf('{'); const end = t.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let data;
  try { data = JSON.parse(t.slice(start, end + 1)); } catch { return null; }
  if (!data || !Array.isArray(data.findings)) return null;
  return data.findings
    .filter((f) => f && typeof f === 'object')
    .map((f) => ({
      title: str(f.title, 200),
      severity: SEVERITY[f.severity] ? f.severity : 'major',
      law: f.law === 'eu' ? 'eu' : 'ro',
      act: str(f.act, 200),
      article: str(f.article, 80),
      passage: str(f.passage, 3000),
      problem: str(f.problem, 2000),
      fix: { before: str(f.fix?.before, 3000), after: str(f.fix?.after, 3000) },
    }))
    .filter((f) => f.title && f.act && f.article);
}

const fold = (s) => String(s || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
// The same finding found in two sections (or twice) is kept once.
export function dedupeFindings(list) {
  const seen = new Set();
  const out = [];
  for (const f of list) {
    const key = `${fold(f.act)}|${fold(f.article).replace(/[^0-9a-z^]/g, '')}|${fold(f.passage).slice(0, 120)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

// ── Verifying a finding ─────────────────────────────────────────────────────
// The timer is cleared as soon as the work settles (a long limit left behind
// would hold the process — and the tests — open).
const withTimeout = (p, ms, fallback) => {
  let timer = 0;
  return Promise.race([
    Promise.resolve(p).catch(() => fallback),
    new Promise((res) => { timer = setTimeout(() => res(fallback), ms); }),
  ]).finally(() => clearTimeout(timer));
};

// The citation a source can read: "art. 1270 din Legea nr. 287/2009".
export function anchorCitation(f) {
  const art = /\bart/i.test(f.article) ? f.article : `art. ${f.article}`;
  return `${art} din ${f.act}`;
}

// → { status: 'verified' | 'rejected' | 'unverified', note, source, quote }
export function judgeCheck(f, report) {
  if (!report) return { status: 'unverified', note: 'The sources could not be reached in time.' };
  const item = (report.items || []).find((it) => it.source === 'legislation');
  if (!item) {
    const eu = f.law === 'eu' || (report.waiting || []).some((w) => w.source === 'eurlex');
    return {
      status: 'unverified',
      note: eu ? 'EU act — EUR-Lex is not connected yet, so it could not be checked.' : 'No connected source could read this citation.',
    };
  }
  const r = item.result || {};
  const quote = (r.excerpts || []).map((e) => e.text).filter(Boolean)[0] || '';
  if (r.status === 'error') return { status: 'rejected', note: r.detail || 'The act does not exist.', source: item.label };
  if (r.status === 'warn' && /not found in the act|REPEALED/i.test(r.detail || '')) {
    return { status: 'rejected', note: r.detail, source: item.label };
  }
  if (r.status === 'unknown') return { status: 'unverified', note: r.detail || 'The source could not be reached.', source: item.label };
  return {
    status: 'verified',
    note: r.status === 'warn' ? r.detail : (r.source === 'archive' ? 'Checked against the copy kept on this computer.' : 'Checked on the official portal.'),
    source: item.label,
    actTitle: r.title || '',
    quote,
  };
}

export function deductionFor(f) {
  const sev = SEVERITY[f.severity] || SEVERITY.major;
  const full = sev.base;
  return Math.round(f.verification?.status === 'unverified' ? full * UNVERIFIED_WEIGHT : full);
}
export function scoreOf(findings) {
  const lost = findings.reduce((n, f) => n + deductionFor(f), 0);
  return Math.max(0, Math.min(100, 100 - lost));
}

// ── The report ──────────────────────────────────────────────────────────────
const diffBlock = (before, after) => {
  const minus = String(before || '').split('\n').filter((l) => l.trim()).map((l) => `- ${l}`);
  const plus = String(after || '').split('\n').filter((l) => l.trim()).map((l) => `+ ${l}`);
  return ['```diff', ...minus, ...plus, '```'].join('\n');
};

// What the report must be (REPORT_SECTIONS in order, the exact score, a diff
// block per finding with a fix). → [] when right, else what is wrong.
export function validateReport(md, { score, findings }) {
  const t = String(md || '');
  const problems = [];
  let last = -1;
  for (const h of REPORT_SECTIONS) {
    const i = t.search(new RegExp(`^##\\s+${h.replace(/[-]/g, '\\-')}\\s*$`, 'm'));
    if (i < 0) problems.push(`the "## ${h}" heading is missing`);
    else if (i < last) problems.push(`"## ${h}" is out of order`);
    else last = i;
  }
  const m = /Score:\s*(\d{1,3})\s*\/\s*100/.exec(t);
  if (!m) problems.push('the "Score: N/100" line is missing');
  else if (Number(m[1]) !== score) problems.push(`the score must be ${score}/100, not ${m[1]}/100`);
  const needDiffs = findings.filter((f) => f.fix?.after || f.fix?.before).length;
  const diffs = (t.match(/```diff\n[\s\S]*?```/g) || []).length;
  if (diffs < needDiffs) problems.push(`there must be a \`\`\`diff block for each of the ${needDiffs} remediation steps (found ${diffs})`);
  return problems;
}

// The report built here, from the same data — used when the AI's answer can't
// be put right. Always valid.
export function buildReport({ name, score, findings, summary = '' }) {
  const lines = [];
  lines.push('## Executive Summary', '');
  lines.push(summary || (findings.length
    ? `${name ? `"${name}"` : 'The document'} has ${findings.length} legal vulnerabilit${findings.length === 1 ? 'y' : 'ies'}: ${findings.filter((f) => f.severity === 'critical').length} critical, ${findings.filter((f) => f.severity === 'major').length} major, ${findings.filter((f) => f.severity === 'minor').length} minor.`
    : `${name ? `"${name}"` : 'The document'} shows no legal vulnerability that could be verified.`), '');
  lines.push('## Score', '', `Score: ${score}/100`, '');
  for (const f of findings) lines.push(`- ${f.title}: -${deductionFor(f)}`);
  lines.push('', '## Identified Vulnerabilities', '');
  if (!findings.length) lines.push('None found.');
  findings.forEach((f, i) => {
    lines.push(`${i + 1}. **${f.title}** — ${SEVERITY[f.severity].label}`, '', `   ${f.problem}`, '');
    lines.push(`   Legal anchor: ${f.act}, ${f.article}${f.verification?.status === 'unverified' ? ' (not verified)' : ''}`);
    if (f.verification?.quote) lines.push('', `   > ${f.verification.quote.replace(/\n+/g, ' ')}`);
    lines.push('');
  });
  lines.push('## Step-by-Step Remediation Plan', '');
  if (!findings.length) lines.push('Nothing to change.');
  findings.forEach((f, i) => {
    lines.push(`${i + 1}. ${f.title}`, '');
    if (f.fix?.before || f.fix?.after) lines.push(diffBlock(f.fix.before, f.fix.after), '');
  });
  return lines.join('\n').trim();
}

const findingsForReport = (findings) => findings.map((f, i) => ({
  n: i + 1,
  title: f.title,
  severity: f.severity,
  deduction: deductionFor(f),
  act: f.act,
  article: f.article,
  verified: f.verification?.status === 'verified',
  not_verified_reason: f.verification?.status === 'unverified' ? f.verification.note : undefined,
  article_text: f.verification?.quote || undefined,
  passage: f.passage,
  problem: f.problem,
  fix: f.fix,
}));

// ── The scan ────────────────────────────────────────────────────────────────
/**
 * → { ok, score, markdown, findings, rejected, documentCheck, sections, built: 'ai' | 'local', error? }
 * `onProgress({ step, done, total })` — 'reading' (a section), 'verifying',
 * 'checking-citations', 'writing'.
 */
export async function runComplianceScan({
  text, name = '', model, projectId = null, onProgress = () => {}, signal,
  ask = askEngine, check = checkText, limits = SCAN_LIMITS,
} = {}) {
  const body = String(text || '').trim();
  if (!body) return { ok: false, error: 'This document has no text to scan.' };
  const sections = splitSections(body, limits.chunkChars).slice(0, limits.maxChunks);
  const truncated = splitSections(body, limits.chunkChars).length > sections.length;
  const call = (opts) => withTimeout(ask({ model, tools: false, usageProject: projectId, signal, ...opts }), limits.askMs, { error: new Error('The AI took too long.') });

  // 1. Findings, a few sections at a time (each its own small call).
  const perSection = new Array(sections.length);
  let failure = null;
  const readSection = async (i) => {
    const head = sections.length > 1 ? `Section ${i + 1} of ${sections.length} of the document "${name}".` : `The document "${name}".`;
    const res = await call({
      usageAction: 'attack-findings',
      context: FINDINGS_PROMPT,
      effort: 'medium',
      messages: [{ role: 'user', content: `${head}\n\n<document>\n${sections[i]}\n</document>\n\nAudit it and answer with the JSON only.` }],
    });
    if (res?.error) { failure = failure || res.error; return; }
    let list = parseFindings(res.text);
    if (!list) {
      // Once more, asking for the JSON alone.
      const again = await call({
        usageAction: 'attack-findings',
        context: FINDINGS_PROMPT,
        effort: 'medium',
        messages: [
          { role: 'user', content: `${head}\n\n<document>\n${sections[i]}\n</document>\n\nAudit it and answer with the JSON only.` },
          { role: 'assistant', content: String(res.text || '').slice(0, 4000) || '(nothing)' },
          { role: 'user', content: 'That was not valid JSON in the required shape. Answer again with the JSON object only.' },
        ],
      });
      list = parseFindings(again?.text) || [];
    }
    perSection[i] = list.slice(0, limits.perSection || 10);
  };
  const step = limits.parallel || 1;
  let read = 0;
  onProgress({ step: 'reading', done: 0, total: sections.length });
  for (let at = 0; at < sections.length; at += step) {
    if (signal?.aborted) return { ok: false, error: 'Stopped.' };
    await Promise.all(sections.slice(at, at + step).map((_, k) => readSection(at + k).finally(() => {
      read += 1;
      onProgress({ step: 'reading', done: read, total: sections.length });
    })));
  }
  // No section read at all = the scan failed, with the reason; a section that
  // failed among others that were read is noted at the foot of the report.
  const readCount = perSection.filter(Boolean).length;
  if (!readCount) return { ok: false, error: aiErrorText(failure) };
  const missed = sections.length - readCount;
  const found = dedupeFindings(perSection.filter(Boolean).flat()).slice(0, limits.maxFindings);

  // 2. Verify every anchor; check the document's own citations alongside.
  onProgress({ step: 'verifying', done: 0, total: found.length });
  const documentCheckP = withTimeout(check(body), limits.documentCheckMs, null);
  let done = 0;
  const checked = await Promise.all(found.map(async (f) => {
    const report = await withTimeout(check(anchorCitation(f)), limits.checkMs, null);
    done += 1;
    onProgress({ step: 'verifying', done, total: found.length });
    return { ...f, verification: judgeCheck(f, report) };
  }));
  const rejected = checked.filter((f) => f.verification.status === 'rejected');
  const order = { critical: 0, major: 1, minor: 2 };
  const findings = checked.filter((f) => f.verification.status !== 'rejected')
    .sort((a, b) => order[a.severity] - order[b.severity]);
  onProgress({ step: 'checking-citations', done: 0, total: 1 });
  const documentCheck = await documentCheckP;
  const score = scoreOf(findings);

  // 3. The report, from the verified findings only.
  onProgress({ step: 'writing', done: 0, total: 1 });
  const data = JSON.stringify({ document: name, score, findings: findingsForReport(findings) }, null, 1);
  const msgs = [{ role: 'user', content: `<scan>\n${data}\n</scan>\n\nWrite the report.` }];
  let markdown = '';
  let built = 'local';
  const first = await call({ usageAction: 'attack-report', context: REPORT_PROMPT, effort: 'low', messages: msgs });
  if (!first?.error) {
    let md = String(first.text || '').trim();
    let problems = validateReport(md, { score, findings });
    if (problems.length) {
      // 4. Sent back once with what is wrong.
      const fixed = await call({
        usageAction: 'attack-report',
        context: REPORT_PROMPT,
        effort: 'low',
        messages: [...msgs, { role: 'assistant', content: md || '(nothing)' }, { role: 'user', content: `Correct the report. Problems: ${problems.join('; ')}. Answer with the whole corrected report only.` }],
      });
      if (!fixed?.error) { md = String(fixed.text || '').trim(); problems = validateReport(md, { score, findings }); }
    }
    if (!problems.length) { markdown = md; built = 'ai'; }
  }
  if (!markdown) markdown = buildReport({ name, score, findings });
  if (missed) markdown += `\n\n_${missed} of the ${sections.length} sections could not be read by the AI this time; run the scan again to cover them._`;
  if (truncated) markdown += `\n\n_Only the first ${sections.length} sections of the document were scanned (it is longer than the scan reads at once)._`;
  return { ok: true, score, markdown, findings, rejected, documentCheck, sections: sections.length, built };
}
