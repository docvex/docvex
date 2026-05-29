import React, { useState, useEffect, useRef } from 'react';
import { ICONS as I, MATTER as D } from './aiHub';
import { askProjectAi, generateDocument } from '../../lib/projectAi';

// The six AI-hub tool surfaces, ported from the Claude Design "ai-tab-v1"
// handoff. Ask + Generate are wired to live Claude via the `project-ai`
// Edge Function; Review / Research / Compliance remain illustrative static
// panels (they'd need real document ingestion / a legal DB / scanning to be
// real). The matter (file list, parties) is a static placeholder.

// Split a model's plain-text document into a centered title + body
// paragraphs. The generate prompt asks for an UPPERCASE title line first;
// if present we lift it into the styled <h1>, otherwise fall back to the
// template label.
function splitDoc(text, fallbackTitle) {
  const blocks = (text || '').trim().split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  if (blocks.length) {
    const first = blocks[0];
    if (!first.includes('\n') && first.length <= 90 && first === first.toUpperCase() && /[A-ZĂÂÎȘȚ]/.test(first)) {
      return { title: first, paras: blocks.slice(1) };
    }
  }
  return { title: fallbackTitle, paras: blocks };
}

// Render a model answer (plain text) as paragraphs, splitting on blank lines.
function answerParagraphs(text) {
  return (text || '').trim().split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
}

// Sequential paragraph reveal — simulates streaming generation.
function useStream(active, count, speed = 320) {
  const [shown, setShown] = useState(0);
  useEffect(() => {
    if (!active) { setShown(0); return undefined; }
    setShown(0);
    let i = 0;
    const id = setInterval(() => {
      i += 1;
      setShown(i);
      if (i >= count) clearInterval(id);
    }, speed);
    return () => clearInterval(id);
  }, [active, count, speed]);
  return shown;
}

function StreamDoc({ active, paras, title, sub }) {
  const shown = useStream(active, paras.length);
  return (
    <div className="doc-body">
      {title && <h1 className="dh">{title}</h1>}
      {sub && <div className="dh-sub">{sub}</div>}
      {paras.slice(0, shown).map((p, i) => (
        <p key={i}>{p}{i === shown - 1 && shown < paras.length ? <span className="cursor" /> : null}</p>
      ))}
    </div>
  );
}

// ─────────────────────────── GENERATE ───────────────────────────
const GEN_TEMPLATES = [
  { id: 'submissions', icon: 'gavel', t: 'Written submissions', d: 'Final arguments on the merits' },
  { id: 'claim', icon: 'file', t: 'Statement of claim', d: 'Originating action, with legal basis' },
  { id: 'defence', icon: 'file', t: 'Statement of defence', d: 'Defences and procedural objections' },
  { id: 'notice', icon: 'send', t: 'Notice of default / demand', d: 'Formal demand, art. 1522 Civil Code' },
  { id: 'contract', icon: 'pen', t: 'Service agreement', d: 'Draft from scratch or from a model' },
  { id: 'poa', icon: 'users', t: 'Power of attorney', d: 'Mandate of representation' },
  { id: 'client', icon: 'inbox', t: 'Client letter', d: 'Status update in plain language' },
];

export function GenerateTool({ projectName, fileNames }) {
  const [sel, setSel] = useState('submissions');
  const [state, setState] = useState('idle'); // idle | thinking | done | error
  const [instructions, setInstructions] = useState('');
  const [result, setResult] = useState({ title: '', paras: [] });
  const [errMsg, setErrMsg] = useState('');
  const reqId = useRef(0);

  const tpl = GEN_TEMPLATES.find((t) => t.id === sel) || GEN_TEMPLATES[0];

  // Reset the output whenever the template changes — the previous draft no
  // longer matches the selected document type.
  useEffect(() => { setState('idle'); setResult({ title: '', paras: [] }); }, [sel]);

  const run = async () => {
    const myReq = ++reqId.current;
    setState('thinking');
    setErrMsg('');
    const { text, error } = await generateDocument({
      template: tpl.t,
      instructions,
      projectName,
      fileNames,
    });
    if (myReq !== reqId.current) return; // a newer run superseded this one
    if (error) {
      setErrMsg(error.message === 'ai_not_configured'
        ? 'The AI assistant is not configured (the AI key is missing). Contact your administrator.'
        : 'Generation failed. Please try again in a moment.');
      setState('error');
      return;
    }
    setResult(splitDoc(text, tpl.t.toUpperCase()));
    setState('done');
  };

  return (
    <div className="tool">
      <div className="tool-side">
        <div className="tool-side-label">Templates</div>
        {GEN_TEMPLATES.map((t) => (
          <button type="button" key={t.id} className={`side-item${sel === t.id ? ' active' : ''}`} onClick={() => setSel(t.id)}>
            <span className="si-ico">{I[t.icon]()}</span>
            <span><span className="si-t">{t.t}</span><span className="si-d">{t.d}</span></span>
          </button>
        ))}
      </div>
      <div className="tool-main">
        <div className="field">
          <div className="field-l">{I.pen({ width: 14, height: 14, style: { color: 'var(--accent)' } })} Instructions for {tpl.t.toLowerCase()}</div>
          <textarea
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            placeholder="Describe what the document should contain: facts, legal basis, tone, amounts, deadlines…"
          />
          <div className="field-foot">
            <span className="cmd-ctx">{I.files({ width: 13, height: 13 })} Context: <b>{(fileNames || []).length} files</b> in the matter</span>
            <button type="button" className="btn btn-primary" style={{ marginLeft: 'auto' }} disabled={state === 'thinking'} onClick={run}>{I.spark()} {state === 'thinking' ? 'Drafting…' : 'Generate'}</button>
          </div>
        </div>

        {state === 'idle' && (
          <div className="doc"><div className="gen-empty">
            <div className="ai-orb ge-orb">{I.spark()}</div>
            <h3>Ready to draft</h3>
            <p>Choose a template, add instructions and press Generate. DocVex AI will draft a document based on the matter context.</p>
          </div></div>
        )}
        {state === 'thinking' && (
          <div className="doc"><div className="gen-empty">
            <div className="ai-orb ge-orb">{I.spark()}</div>
            <h3>Drafting…</h3>
            <p style={{ marginBottom: 14 }}>DocVex AI is drafting {tpl.t.toLowerCase()} for this matter.</p>
            <span className="thinking"><span /><span /><span /></span>
          </div></div>
        )}
        {state === 'error' && (
          <div className="doc"><div className="gen-empty">
            <div className="ai-orb ge-orb">{I.alert()}</div>
            <h3>Couldn’t generate the document</h3>
            <p>{errMsg}</p>
          </div></div>
        )}
        {state === 'done' && (
          <div className="doc">
            <div className="doc-bar">
              <span className="doc-name">{I.file()} {tpl.t} — AI draft</span>
              <div className="doc-actions">
                <button type="button" className="iconbtn" title="Copy" onClick={() => navigator.clipboard?.writeText([result.title, ...result.paras].filter(Boolean).join('\n\n'))}>{I.copy()}</button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={run}>{I.spark()} Regenerate</button>
              </div>
            </div>
            <StreamDoc active paras={result.paras} title={result.title} sub={projectName} />
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────── REVIEW ───────────────────────────
export function ReviewTool() {
  const [open, setOpen] = useState(0);
  const flags = [
    { sev: 'high', t: 'Disproportionate penalty clause', loc: 'Art. 9.2 — Framework Agreement, p. 14', quote: '“In the event of delay, the supplier owes penalties of 0.05%/day, such penalties not exceeding 5% of the contract value.”', rec: 'The 5% cap severely limits recovery of the actual loss (estimated at ~25% of value). We recommend removing the cap or raising it.', redline: { del: 'such penalties not exceeding 5% of the contract value', ins: 'such penalties not being limited to the loss actually proven' } },
    { sev: 'high', t: 'No balanced force-majeure clause', loc: 'Art. 12 — Framework Agreement, p. 19', quote: '“Force majeure exonerates exclusively the supplier from any liability, for the entire duration of the event.”', rec: 'The clause is one-sided in the Defendant’s favour. We recommend reciprocity and a duty to notify within 5 days.', redline: { del: 'exclusively the supplier', ins: 'either party, subject to notice within 5 business days' } },
    { sev: 'high', t: 'Delivery term inconsistent with Schedule 2', loc: 'Art. 4.1 vs. Schedule 2', quote: '“Delivery shall be made within a reasonable time of the order.”', rec: 'Conflicts with the firm schedule in Schedule 2. “Reasonable time” weakens the essential nature of the term — key for art. 1523 Civil Code.', redline: { del: 'within a reasonable time of the order', ins: 'in accordance with the firm deadlines in Schedule 2, as an essential time limit' } },
    { sev: 'med', t: 'Ambiguous jurisdiction and governing law', loc: 'Art. 18 — p. 31', quote: '“Disputes shall be settled amicably or by the competent courts.”', rec: 'Does not name the territorially competent court. We recommend expressly designating the Bucharest Tribunal.', redline: { del: 'the competent courts', ins: 'the Bucharest Tribunal, as the court chosen by mutual agreement' } },
    { sev: 'med', t: 'Confidentiality clause has no duration', loc: 'Art. 14 — p. 24', quote: '“The parties shall keep the information confidential.”', rec: 'The post-contractual duration of the obligation is missing. We recommend 3 years from termination.', redline: { del: 'shall keep the information confidential', ins: 'shall keep the information confidential during the contract and for 3 years thereafter' } },
    { sev: 'low', t: 'Reference to a non-existent schedule', loc: 'Art. 6.3 — p. 11', quote: '“…in accordance with the rates in Schedule 5.”', rec: 'The contract contains no Schedule 5. Clarify or remove the reference.', redline: null },
  ];
  const counts = { high: flags.filter((f) => f.sev === 'high').length, med: flags.filter((f) => f.sev === 'med').length, low: flags.filter((f) => f.sev === 'low').length };
  return (
    <div className="tool">
      <div className="tool-side">
        <div className="tool-side-label">Document reviewed</div>
        {D.files.filter((f) => ['Contract', 'Annex', 'Pleading'].includes(f.kind)).map((f, i) => (
          <button type="button" key={f.id} className={`side-item${i === 0 ? ' active' : ''}`}>
            <span className="si-ico">{I.file()}</span>
            <span><span className="si-t">{f.name.replace(/\.[a-z]+$/, '')}</span><span className="si-d">{f.kind} · {f.pages} pp.</span></span>
          </button>
        ))}
      </div>
      <div className="tool-main">
        <div className="risk-summary">
          <div className="risk-stat high"><div className="rs-n">{counts.high}</div><div className="rs-l">Major risks</div></div>
          <div className="risk-stat med"><div className="rs-n">{counts.med}</div><div className="rs-l">Medium risks</div></div>
          <div className="risk-stat low"><div className="rs-n">{counts.low}</div><div className="rs-l">To clarify</div></div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div className="sec-label" style={{ margin: 0, flex: 1 }}>11 clauses flagged · Framework Agreement<span className="rule" /></div>
          <button type="button" className="btn btn-ghost btn-sm">{I.download()} Export redline</button>
        </div>
        {flags.map((f, i) => (
          <div key={i} className={`flag${open === i ? ' open' : ''}`} data-sev={f.sev}>
            <div className="flag-h" onClick={() => setOpen(open === i ? -1 : i)}>
              <span className="flag-sev"><span /><span /><span /></span>
              <div className="flag-ht"><div className="ft">{f.t}</div><div className="fl">{f.loc}</div></div>
              <span className="flag-sevlabel">{f.sev === 'high' ? 'Major' : f.sev === 'med' ? 'Medium' : 'Minor'}</span>
              <span className="flag-caret">{I.caret({ width: 16, height: 16 })}</span>
            </div>
            <div className="flag-body">
              <div className="flag-quote">{f.quote}</div>
              <div className="flag-rec"><b>Recommendation:</b> {f.rec}</div>
              {f.redline && (
                <div className="flag-redline">{I.pen({ width: 13, height: 13, style: { color: 'var(--accent)', verticalAlign: 'middle', marginRight: 6 } })}
                  <span className="del">{f.redline.del}</span> <span className="ins">→ {f.redline.ins}</span>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────── ASK ───────────────────────────
// Map a UI message to the Anthropic role/content shape. Seeded demo
// messages carry `paras` (HTML); live ones carry plain `text`.
function toApiMessages(list) {
  return list.map((m) => ({
    role: m.who === 'me' ? 'user' : 'assistant',
    content: m.text != null
      ? m.text
      : (m.paras || []).map((p) => String(p).replace(/<[^>]+>/g, '')).join('\n\n'),
  }));
}

export function AskTool({ projectName, fileNames, seedQuestion, onSeedConsumed }) {
  const [msgs, setMsgs] = useState([
    { who: 'ai', text: `Hi! I'm DocVex AI. Ask me anything about ${projectName || 'this matter'} — I can summarize the files, explain deadlines and obligations, or help you prepare a strategy. How can I help?` },
  ]);
  const [val, setVal] = useState('');
  const [streaming, setStreaming] = useState(false);
  const scroller = useRef(null);
  const sendRef = useRef(null);

  const suggest = ['Was the Defendant put on notice?', 'What evidence supports the delay?', 'Summarize the defences in the statement of defence'];

  const send = async (q) => {
    const text = (q != null ? String(q) : val).trim();
    if (!text || streaming) return;
    setVal('');
    const next = [...msgs, { who: 'me', text }];
    setMsgs(next);
    setStreaming(true);
    const { text: answer, error } = await askProjectAi({
      messages: toApiMessages(next),
      projectName,
      fileNames,
    });
    setStreaming(false);
    setMsgs((m) => [...m, error
      ? { who: 'ai', text: error.message === 'ai_not_configured'
        ? 'The AI assistant is not configured (the AI key is missing). Contact your administrator.'
        : 'Couldn’t get an answer right now. Please try again in a moment.', isError: true }
      : { who: 'ai', text: answer }]);
  };
  sendRef.current = send;

  // Command-bar seed: when the landing routes a typed question here, fire it
  // once and tell the parent to clear the seed.
  useEffect(() => {
    if (seedQuestion && sendRef.current) {
      sendRef.current(seedQuestion);
      onSeedConsumed?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedQuestion]);

  useEffect(() => { if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight; }, [msgs, streaming]);

  return (
    <div style={{ marginTop: 22 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 16 }}>
        <span className="cmd-ctx" style={{ fontSize: '0.8rem' }}>{I.files({ width: 14, height: 14 })} DocVex AI knows the matter’s <b>{(fileNames || []).length} files</b> (by name) and answers in context</span>
      </div>
      <div ref={scroller} style={{ maxHeight: 480, overflowY: 'auto', paddingRight: 6 }}>
        <div className="chat">
          {msgs.map((m, i) => (
            <div key={i} className={`bubble ${m.who === 'me' ? 'me' : ''}`}>
              <div className="bubble-av" style={m.who === 'ai' ? { background: 'linear-gradient(135deg, var(--accent), color-mix(in srgb, var(--accent) 60%, var(--cat-role)))', color: '#fff' } : {}}>{m.who === 'me' ? 'You' : I.spark({ width: 17, height: 17 })}</div>
              <div className="bubble-c">
                <div className="bubble-name">{m.who === 'me' ? 'You' : 'DocVex AI'}</div>
                {m.who === 'me'
                  ? <div className="bubble-msg">{m.text}</div>
                  : (m.paras
                    ? (
                      <div className="bubble-msg">
                        {m.paras.map((p, j) => <p key={j} dangerouslySetInnerHTML={{ __html: p.replace(/<sup data-c="(\d+)"><\/sup>/g, '<sup class="cite">$1</sup>') }} />)}
                        <div className="sources">
                          <div className="sources-l">Sources</div>
                          {m.sources.map((s, j) => (
                            <div className="source" key={j}><span className="src-n">{s.n}</span><b>{s.f}</b><span className="pg">{s.pg}</span></div>
                          ))}
                        </div>
                      </div>
                    )
                    : (
                      <div className="bubble-msg">
                        {answerParagraphs(m.text).map((p, j) => <p key={j}>{p}</p>)}
                      </div>
                    ))}
              </div>
            </div>
          ))}
          {streaming && (
            <div className="bubble">
              <div className="bubble-av" style={{ background: 'linear-gradient(135deg, var(--accent), color-mix(in srgb, var(--accent) 60%, var(--cat-role)))', color: '#fff' }}>{I.spark({ width: 17, height: 17 })}</div>
              <div className="bubble-c"><div className="bubble-name">DocVex AI</div><div className="bubble-msg"><span className="thinking"><span /><span /><span /></span></div></div>
            </div>
          )}
        </div>
      </div>
      <div className="chips" style={{ margin: '16px 0 12px' }}>
        {suggest.map((s, i) => <button type="button" key={i} className="chip" onClick={() => send(s)}>{I.spark()}{s}</button>)}
      </div>
      <div className="field" style={{ display: 'flex', gap: 12, alignItems: 'flex-end', padding: 14 }}>
        <textarea style={{ minHeight: 26 }} rows={1} value={val} onChange={(e) => setVal(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} placeholder="Ask anything about the matter…" />
        <button type="button" className="btn btn-primary" disabled={streaming} onClick={() => send()}>{I.send()} Ask</button>
      </div>
    </div>
  );
}

// ─────────────────────────── RESEARCH ───────────────────────────
export function ResearchTool() {
  const results = [
    { type: 'Legislation', badge: 'Civil Code', t: 'Art. 1530–1548 — Performance by equivalent (damages)', meta: 'Law no. 287/2009 · in force', sum: 'The creditor is entitled to <b>damages</b> in reparation of the loss caused by non-performance. The loss covers the loss actually suffered and the lost benefit (art. 1531), recoverable if foreseeable at the conclusion of the contract (art. 1533).', rel: 98 },
    { type: 'Legislation', badge: 'Civil Code', t: 'Art. 1523 — Default by operation of law', meta: 'Law no. 287/2009 · in force', sum: 'The debtor is in default by operation of law where the obligation could only usefully be performed within a certain time which the debtor allowed to pass — an <b>essential time limit</b>. Relevant to the firm schedule in Schedule 2.', rel: 94 },
    { type: 'Case law', badge: 'HCCJ', t: 'Decision no. 2371/2019 — 2nd Civil Division', meta: 'High Court of Cassation and Justice', sum: 'A contractual cap on penalties does not prevent the creditor from claiming <b>additional damages</b> for proven loss exceeding the penalty, where that right has not been expressly excluded.', rel: 89 },
    { type: 'EU Directive', badge: 'EU', t: 'Directive 2011/7/EU — combating late payment', meta: 'Transposed by Law no. 72/2013', sum: 'Establishes the right to interest for late payment and to a fixed sum of <b>EUR 40</b> for recovery costs in commercial transactions. Applicable to B2B relationships such as that between the parties.', rel: 81 },
  ];
  const [q, setQ] = useState('damages for late delivery under a commercial contract');
  const filters = ['All sources', 'Civil Code', 'HCCJ case law', 'EU directives', 'Official Gazette'];
  return (
    <div style={{ marginTop: 22 }}>
      <div className="field" style={{ display: 'flex', gap: 12, alignItems: 'center', padding: 14 }}>
        {I.search({ width: 18, height: 18, style: { color: 'var(--text-muted)', flexShrink: 0 } })}
        <textarea rows={1} style={{ minHeight: 24 }} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search Romanian legislation, EU directives and case law…" />
        <button type="button" className="btn btn-primary">{I.scale()} Search</button>
      </div>
      <div className="chips" style={{ margin: '14px 0 4px' }}>
        {filters.map((f, i) => <button type="button" key={f} className={`chip${i === 0 ? ' on' : ''}`}>{f}</button>)}
      </div>
      <div className="sec-label">4 relevant sources · sorted by relevance<span className="rule" /></div>
      <div className="stack">
        {results.map((r, i) => (
          <div className="research-result" key={i}>
            <div className="rr-eyebrow">{r.type}<span className="badge">{r.badge}</span></div>
            <div className="rr-t">{r.t}</div>
            <div className="rr-meta">{r.meta}</div>
            <div className="rr-sum" dangerouslySetInnerHTML={{ __html: r.sum }} />
            <div className="rr-foot">
              <button type="button" className="rr-link">{I.book({ width: 14, height: 14 })} Read the text</button>
              <button type="button" className="rr-link">{I.copy({ width: 14, height: 14 })} Cite</button>
              <button type="button" className="rr-link">{I.pen({ width: 14, height: 14 })} Insert into document</button>
              <span className="rr-relevance">{I.target({ width: 13, height: 13 })} {r.rel}% relevance</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────── AUTOMATE ───────────────────────────
export function AutomateTool() {
  const initial = [
    { icon: 'tag', t: 'Auto-tag uploaded files', when: 'a new file is uploaded', then: 'classify by type (contract, evidence, correspondence) and tag', meta: '24 files classified · last today', on: true },
    { icon: 'bell', t: 'Procedural deadline alerts', when: '5 days before a deadline', then: 'notify the team and create a to-do', meta: 'Next: Jun 3 · filing deadline', on: true },
    { icon: 'route', t: 'Route documents to the matter', when: 'a document arrives by email', then: 'identify the matter and move the file to the right folder', meta: '7 documents routed this week', on: true },
    { icon: 'inbox', t: 'New-client intake', when: 'the contact form is submitted', then: 'extract the data, run a conflict check and create the file', meta: '2 awaiting validation', on: true },
    { icon: 'file', t: 'Auto-summary on upload', when: 'a document over 10 pages is added', then: 'generate a one-page summary and key facts', meta: 'off', on: false },
    { icon: 'calendar', t: 'Sync deadlines to calendar', when: 'a procedural date is identified', then: 'add an event to the team calendar', meta: 'off', on: false },
  ];
  const [rules, setRules] = useState(initial);
  const toggle = (i) => setRules((r) => r.map((x, j) => (j === i ? { ...x, on: !x.on } : x)));
  const active = rules.filter((r) => r.on).length;
  return (
    <div style={{ marginTop: 22 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div>
          <div className="ai-eyebrow"><span className="spark">{I.bolt({ width: 13, height: 13 })}</span> {active} of {rules.length} active</div>
        </div>
        <button type="button" className="btn btn-primary" style={{ marginLeft: 'auto' }}>{I.plus()} New automation</button>
      </div>
      <div className="sec-label" style={{ marginTop: 18 }}>“When → then” rules<span className="rule" /></div>
      <div className="stack">
        {rules.map((r, i) => (
          <div className="auto-card" key={i} style={{ opacity: r.on ? 1 : 0.62 }}>
            <div className="auto-ico">{I[r.icon]()}</div>
            <div className="auto-b">
              <div className="auto-t">{r.t}</div>
              <div className="auto-flow"><span className="when">WHEN</span> {r.when} <span className="arrow">→</span> <span className="then">THEN</span> {r.then}</div>
              <div className="auto-meta">{r.on ? I.check({ width: 12, height: 12, style: { color: 'var(--success)' } }) : I.clock({ width: 12, height: 12 })}<span>{r.meta}</span></div>
            </div>
            <button type="button" className={`toggle${r.on ? ' on' : ''}`} onClick={() => toggle(i)} aria-label="toggle" />
          </div>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────── COMPLIANCE ───────────────────────────
export function ComplianceTool() {
  const R = 42;
  const C = 2 * Math.PI * R;
  const score = 86;
  const checks = [
    { st: 'pass', t: 'Legal basis for processing client data', d: 'Contract and legitimate interest documented (art. 6 GDPR).' },
    { st: 'pass', t: 'Confidentiality agreement with external collaborators', d: 'The technical expert signed the confidentiality undertaking.' },
    { st: 'warn', t: 'Personal data in scanned correspondence', d: 'National ID numbers detected in 3 documents. We recommend anonymising before external sharing.', fix: 'Anonymise automatically' },
    { st: 'warn', t: 'Matter retention period undefined', d: 'The retention policy does not specify a duration for this type of matter.', fix: 'Set policy' },
    { st: 'fail', t: 'Conflict-of-interest check — incomplete', d: 'Veridian Logistics SA has not been checked against the firm’s conflicts register.', fix: 'Run the check' },
    { st: 'pass', t: 'Matter access restricted by role', d: 'Only members of the assigned team can access the files.' },
  ];
  return (
    <div style={{ marginTop: 22 }}>
      <div className="score-ring">
        <div className="ring">
          <svg width="96" height="96">
            <circle cx="48" cy="48" r={R} fill="none" stroke="var(--bg-elevated)" strokeWidth="8" />
            <circle cx="48" cy="48" r={R} fill="none" stroke="var(--accent)" strokeWidth="8" strokeLinecap="round" strokeDasharray={C} strokeDashoffset={C * (1 - score / 100)} />
          </svg>
          <div className="ring-label"><b>{score}</b><span>score</span></div>
        </div>
        <div className="score-txt">
          <h3>Good compliance — 1 issue to resolve</h3>
          <p>GDPR and conflict-of-interest scan for the matter <b>Aedificia v. Veridian</b>. Resolving the conflict check would raise the score to 94.</p>
        </div>
      </div>
      <div className="sec-label" style={{ marginTop: 24 }}>Checks<span className="rule" /><span className="count">6</span></div>
      <div className="panel">
        {checks.map((c, i) => (
          <div className="check" key={i}>
            <div className={`check-ico ${c.st}`}>{c.st === 'pass' ? I.check() : c.st === 'warn' ? I.alert() : I.x()}</div>
            <div className="check-b">
              <div className="check-t">{c.t}</div>
              <div className="check-d">{c.d}</div>
              {c.fix && <button type="button" className="check-fix">{c.fix} →</button>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
