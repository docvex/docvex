// The Attack compliance scan (src/lib/complianceScan), under plain Node:
//   npm test
// Bundled first, as the other suites are. The AI client and the source checks
// are replaced by stubs at bundle time (they need the app around them); the
// scan is handed fakes for both, so every call can be seen.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let M;

before(async () => {
  const out = path.join(os.tmpdir(), `docvex-compliance-${process.pid}.mjs`);
  const stubs = {
    name: 'stubs',
    setup(b) {
      b.onResolve({ filter: /^\.\/(projectAi|sourceChecks|aiEngine)$/ }, (a) => ({ path: a.path, namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({
        contents: a.path.includes('aiEngine')
          ? 'export const askAi = async () => ({ error: "not in tests" });'
          : a.path.includes('projectAi')
          ? 'export const askProjectAi = async () => ({ error: "not in tests" }); export const askProjectAiStream = askProjectAi;'
          : 'export const checkText = async () => null;',
        loader: 'js',
      }));
    },
  };
  await build({
    entryPoints: [path.join(root, 'src/lib/complianceScan.js')],
    outfile: out, format: 'esm', platform: 'node', bundle: true, logLevel: 'silent', plugins: [stubs],
  });
  M = await import(pathToFileURL(out).href);
});

// ── Fakes ──────────────────────────────────────────────────────────────────
const FINDINGS = {
  findings: [
    { title: 'Penalitate disproporționată', severity: 'major', law: 'ro', act: 'Legea nr. 287/2009', article: 'art. 1541', passage: 'penalitate de 5% pe zi', problem: 'Clauza penală este vădit excesivă.', fix: { before: 'penalitate de 5% pe zi', after: 'penalitate de 0,1% pe zi' } },
    { title: 'Lipsa informării GDPR', severity: 'critical', law: 'eu', act: 'Regulamentul (UE) 2016/679', article: 'art. 13', passage: '', problem: 'Persoanele vizate nu sunt informate.', fix: { before: '', after: 'Datele sunt prelucrate conform GDPR.' } },
    { title: 'Articol inventat', severity: 'minor', law: 'ro', act: 'Legea nr. 999/2099', article: 'art. 1', passage: 'x', problem: 'y', fix: { before: 'x', after: 'z' } },
  ],
};

// The connected sources, as checkText answers.
function fakeCheck(calls) {
  return async (text) => {
    calls.push(text);
    if (/999\/2099/.test(text)) {
      return { items: [{ source: 'legislation', label: 'legislatie.just.ro', result: { status: 'error', detail: 'No act nr. 999/2099 exists.' } }], waiting: [] };
    }
    if (/287\/2009/.test(text)) {
      return { items: [{ source: 'legislation', label: 'legislatie.just.ro', result: { status: 'ok', title: 'LEGE nr. 287/2009', detail: 'Exists.', excerpts: [{ art: '1541', text: '(1) Instanța nu poate reduce penalitatea...' }], source: 'live' } }], waiting: [] };
    }
    if (/2016\/679/.test(text)) return { items: [], waiting: [{ source: 'eurlex', label: 'eur-lex.europa.eu', refs: [text] }] };
    return { items: [], waiting: [] };   // the whole document
  };
}

function fakeAsk(calls, { report } = {}) {
  return async (opts) => {
    calls.push(opts);
    if (opts.usageAction === 'attack-findings') return { text: JSON.stringify(FINDINGS) };
    return { text: typeof report === 'function' ? report(opts, calls) : report };
  };
}

// ── The prompts ─────────────────────────────────────────────────────────────
test('the prompts compile and say what they must', () => {
  assert.match(M.FINDINGS_PROMPT, /Romanian/);
  assert.match(M.FINDINGS_PROMPT, /Regulamentul \(UE\) 2016\/679/);
  assert.match(M.FINDINGS_PROMPT, /JSON only/);
  for (const h of M.REPORT_SECTIONS) assert.ok(M.REPORT_PROMPT.includes(`## ${h}`), h);
  assert.match(M.REPORT_PROMPT, /```diff/);
  assert.match(M.REPORT_PROMPT, /Use ONLY these findings/);
});

// ── Pieces ──────────────────────────────────────────────────────────────────
test('findings are parsed, cleaned and deduplicated', () => {
  const list = M.parseFindings(`Here:\n${JSON.stringify(FINDINGS)}\nthanks`);
  assert.equal(list.length, 3);
  assert.equal(list[1].law, 'eu');
  assert.equal(M.parseFindings('no json'), null);
  const bad = M.parseFindings('{"findings":[{"title":"t","severity":"huge","act":"Legea nr. 1/2000","article":"art. 2"}]}');
  assert.equal(bad[0].severity, 'major');
  assert.equal(M.dedupeFindings([...list, { ...list[0] }]).length, 3);
});

test('a long document is split into sections, nothing lost', () => {
  const para = 'Articolul 1. ' + 'Clauza contractului este valabilă. '.repeat(40);
  const doc = Array.from({ length: 30 }, (_, i) => para.replace('1.', `${i + 1}.`)).join('\n\n');
  const parts = M.splitSections(doc, 5000);
  assert.ok(parts.length > 1);
  assert.ok(parts.every((p) => p.length <= 5000));
  assert.equal(parts.join(' ').replace(/\s+/g, ' ').length, doc.replace(/\s+/g, ' ').trim().length);
  assert.deepEqual(M.splitSections('short', 5000), ['short']);
  assert.deepEqual(M.splitSections('', 5000), []);
});

test('a finding is judged from the source check', () => {
  const ro = { law: 'ro' };
  assert.equal(M.judgeCheck(ro, null).status, 'unverified');
  assert.equal(M.judgeCheck(ro, { items: [{ source: 'legislation', result: { status: 'error', detail: 'none' } }] }).status, 'rejected');
  assert.equal(M.judgeCheck(ro, { items: [{ source: 'legislation', result: { status: 'warn', detail: 'Check: art. 9 was not found in the act.' } }] }).status, 'rejected');
  assert.equal(M.judgeCheck(ro, { items: [{ source: 'legislation', result: { status: 'warn', detail: 'Check: the act appears to be REPEALED.' } }] }).status, 'rejected');
  assert.equal(M.judgeCheck(ro, { items: [{ source: 'legislation', result: { status: 'unknown' } }] }).status, 'unverified');
  const ok = M.judgeCheck(ro, { items: [{ source: 'legislation', result: { status: 'ok', excerpts: [{ text: 'the text' }] } }] });
  assert.equal(ok.status, 'verified');
  assert.equal(ok.quote, 'the text');
  assert.match(M.judgeCheck({ law: 'eu' }, { items: [], waiting: [{ source: 'eurlex' }] }).note, /EUR-Lex/);
  assert.equal(M.anchorCitation({ act: 'Legea nr. 287/2009', article: '1270' }), 'art. 1270 din Legea nr. 287/2009');
});

test('the score deducts per severity, half for what could not be verified', () => {
  const f = (severity, status) => ({ severity, verification: { status } });
  assert.equal(M.scoreOf([]), 100);
  assert.equal(M.scoreOf([f('critical', 'verified')]), 80);
  assert.equal(M.scoreOf([f('critical', 'unverified')]), 90);
  assert.equal(M.scoreOf([f('major', 'verified'), f('minor', 'verified')]), 87);
  assert.equal(M.scoreOf(Array.from({ length: 10 }, () => f('critical', 'verified'))), 0);
});

test('the report validator catches every missing part', () => {
  const findings = [{ title: 'a', severity: 'major', fix: { before: 'x', after: 'y' }, verification: { status: 'verified' } }];
  const good = M.buildReport({ name: 'Doc', score: 90, findings });
  assert.deepEqual(M.validateReport(good, { score: 90, findings }), []);
  assert.ok(M.validateReport(good.replace('## Score', '## Scor'), { score: 90, findings }).some((p) => /Score/.test(p)));
  assert.ok(M.validateReport(good, { score: 80, findings }).some((p) => /80\/100/.test(p)));
  assert.ok(M.validateReport(good.replace('```diff', '```'), { score: 90, findings }).some((p) => /diff/.test(p)));
  const swapped = good.replace('## Executive Summary', '## TMP').replace('## Step-by-Step Remediation Plan', '## Executive Summary').replace('## TMP', '## Step-by-Step Remediation Plan');
  assert.ok(M.validateReport(swapped, { score: 90, findings }).length > 0);
});

// ── The scan end to end ─────────────────────────────────────────────────────
test('the scan calls the AI, checks every anchor and drops what does not exist', async () => {
  const asks = []; const checks = [];
  const res = await M.runComplianceScan({
    text: 'CONTRACT. Se aplică o penalitate de 5% pe zi. x', name: 'Contract.docx',
    ask: fakeAsk(asks, { report: 'not a report' }), check: fakeCheck(checks),
  });
  assert.equal(res.ok, true);
  // Every anchor was checked, plus the document's own citations.
  assert.ok(checks.some((c) => /art\. 1541 din Legea nr\. 287\/2009/.test(c)));
  assert.ok(checks.some((c) => /2016\/679/.test(c)));
  assert.ok(checks.some((c) => /999\/2099/.test(c)));
  assert.ok(checks.some((c) => c.startsWith('CONTRACT.')));
  // The invented act is gone; the EU finding stays, not verified; the RO one verified with its text.
  assert.equal(res.rejected.length, 1);
  assert.equal(res.findings.length, 2);
  assert.equal(res.findings[0].severity, 'critical');
  assert.equal(res.findings[0].verification.status, 'unverified');
  assert.equal(res.findings[1].verification.status, 'verified');
  assert.match(res.findings[1].verification.quote, /penalitatea/);
  assert.equal(res.score, 100 - 10 - 10);
  // The AI answered nonsense twice: the report was built locally, still valid.
  assert.equal(res.built, 'local');
  assert.deepEqual(M.validateReport(res.markdown, { score: res.score, findings: res.findings }), []);
  assert.equal(asks.filter((a) => a.usageAction === 'attack-report').length, 2);
  // The report request carried only the verified findings and the article text.
  const reportReq = asks.find((a) => a.usageAction === 'attack-report');
  assert.ok(!reportReq.messages[0].content.includes('999/2099'));
  assert.ok(reportReq.messages[0].content.includes('Instanța nu poate reduce'));
  assert.equal(reportReq.context, M.REPORT_PROMPT);
  assert.ok(asks.every((a) => a.tools === false));
});

test('a valid AI report is used as written; a fixable one is corrected once', async () => {
  const findings = [];
  const good = (score) => M.buildReport({ name: 'D', score, findings: [] }).replace('shows no legal', 'AI says: no legal');
  let res = await M.runComplianceScan({
    text: 'Text.', name: 'D',
    ask: async (o) => (o.usageAction === 'attack-findings' ? { text: '{"findings":[]}' } : { text: good(100) }),
    check: async () => ({ items: [], waiting: [] }),
  });
  assert.equal(res.built, 'ai');
  assert.match(res.markdown, /AI says/);
  let n = 0;
  res = await M.runComplianceScan({
    text: 'Text.', name: 'D',
    ask: async (o) => {
      if (o.usageAction === 'attack-findings') return { text: '{"findings":[]}' };
      n += 1;
      return { text: n === 1 ? good(100).replace('Score: 100/100', 'Score: 70/100') : good(100) };
    },
    check: async () => ({ items: [], waiting: [] }),
  });
  assert.equal(n, 2);
  assert.equal(res.built, 'ai');
  assert.equal(findings.length, 0);
});

test('sources that time out or fail leave findings not verified, never stop the scan', async () => {
  const res = await M.runComplianceScan({
    text: 'Text.', name: 'D',
    ask: fakeAsk([], { report: '' }),
    check: (t) => (t.startsWith('art.') ? new Promise(() => {}) : Promise.reject(new Error('down'))),
    limits: { ...M.SCAN_LIMITS, checkMs: 30, documentCheckMs: 30 },
  });
  assert.equal(res.ok, true);
  assert.equal(res.findings.length, 3);
  assert.ok(res.findings.every((f) => f.verification.status === 'unverified'));
  assert.equal(res.documentCheck, null);
});

test('a long document is read section by section and its findings merged', async () => {
  const asks = [];
  const doc = Array.from({ length: 6 }, (_, i) => `Articolul ${i + 1}. ${'Text de contract. '.repeat(200)}`).join('\n\n');
  const res = await M.runComplianceScan({
    text: doc, name: 'Lung',
    ask: fakeAsk(asks, { report: '' }), check: fakeCheck([]),
    limits: { ...M.SCAN_LIMITS, chunkChars: 4000 },
  });
  const reads = asks.filter((a) => a.usageAction === 'attack-findings');
  assert.ok(reads.length > 1);
  assert.match(reads[0].messages[0].content, /Section 1 of/);
  // The same three findings in every section → merged to the same set.
  assert.equal(res.findings.length + res.rejected.length, 3);
});

test('a document with no text is refused', async () => {
  const res = await M.runComplianceScan({ text: '   ', ask: async () => { throw new Error('no'); } });
  assert.equal(res.ok, false);
});

test('when no section can be read the scan says why', async () => {
  const res = await M.runComplianceScan({
    text: 'Art. 1. Text.', name: 'x.docx',
    ask: async () => ({ error: new Error('http_546') }), check: async () => null,
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /took too long/);
  assert.match(M.aiErrorText(new Error('weird')), /weird/);
});

test('sections are read a few at a time and a failed one is noted', async () => {
  let live = 0; let peak = 0; let n = 0;
  const res = await M.runComplianceScan({
    text: Array.from({ length: 6 }, (_, i) => `Art. ${i + 1}. ${'Lorem ipsum dolor sit amet. '.repeat(30)}`).join('\n\n'),
    name: 'x.docx',
    limits: { ...M.SCAN_LIMITS, chunkChars: 900, parallel: 3 },
    ask: async (o) => {
      if (o.usageAction !== 'attack-findings') return { text: '' };
      live += 1; peak = Math.max(peak, live); n += 1; const mine = n;
      await new Promise((r) => setTimeout(r, 5));
      live -= 1;
      return mine === 2 ? { error: new Error('http_504') } : { text: '{"findings":[]}' };
    },
    check: async () => null,
  });
  assert.equal(res.ok, true);
  assert.ok(peak > 1 && peak <= 3, `peak ${peak}`);
  assert.match(res.markdown, /could not be read by the AI this time/);
});
