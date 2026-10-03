import React, { useEffect, useState } from 'react';
import RuleOptions from '../components/RuleOptions';
import {
  AI_SURFACES, CAPABILITIES, AI_LIMITS, AI_MODELS, AI_PROMPTS, AI_MANNERS, AI_SETTING_KEYS, AI_STYLES,
  ROUTER_MODEL, FALLBACK_MODEL, loadAiModel, loadAiProjectFiles, loadAiStyle, aiModel, aiStyle, quickRoute,
} from '../lib/aiEngine';
import { EDIT_RULE } from '../lib/aiFileEdits';

// EVERY AI SETTING, IN ONE PLACE — the unified AI (lib/aiEngine) that Research
// and the Doc Viewer's advisor run on: what each surface may do, the models
// and Auto, the time limits, what this device has picked, and EVERY text the
// AI is sent, word for word. Then the instructions the app's OTHER AIs send
// (the Advisor tab, the Files scan, identity reading, picture → Word…), read
// from their own modules so what is shown is what runs.

const VIEWS = {
  label: 'Show',
  options: [
    { id: 'what', label: 'What each AI may do' },
    { id: 'models', label: 'Models & Auto' },
    { id: 'limits', label: 'Limits' },
    { id: 'speed', label: 'Speed & caching' },
    { id: 'styles', label: 'Answer styles' },
    { id: 'prompts', label: 'What the AI is sent' },
    { id: 'others', label: 'Other AIs in the app' },
  ],
};
const SURFACES = Object.values(AI_SURFACES);
const ms = (n) => (n >= 60_000 ? `${n / 60_000} min` : n >= 1000 ? `${n / 1000} s` : `${n} ms`);
const LIMIT_INFO = {
  routeMs: 'Auto’s routing call; past it, Sonnet 5 answers.',
  contextMs: 'Gathering the project’s digest; past it, the answer is written without it and says so.',
  portalsMs: 'Reading the portal records a question names.',
  answerMs: 'An answer.',
  draftMs: 'Writing a document (file viewer).',
  historyTurns: 'Earlier messages sent back with a question.',
  contextTtlMs: 'How long a project’s digest is reused before it is built again.',
  portalRefs: 'References read from the portals per question.',
  portalChars: 'Characters of one portal record handed to the model.',
  openFileChars: 'Characters of the open file handed to the model (file viewer).',
  effort: 'output_config.effort on every turn (not Haiku). Kept constant so the cache holds — a change drops it.',
  warmCache: 'Write the prompt cache while the question is being typed.',
  warmEveryMs: 'At most one warm-up per model and data this often (the cache lives 5 minutes).',
};
const ROUTE_SAMPLES = ['Bună ziua!', 'Redactează o notificare de punere în întârziere', 'Analizează riscurile acestui contract', 'Ce termen de prescripție se aplică?'];
const SPEED = [
  ['Streaming', 'Questions in Research and the file viewer are STREAMED: the answer shows as it arrives instead of after it is complete (project-ai `stream: true` → server-sent events). Drafting a document, paragraph edits and summaries are not streamed.'],
  ['Prompt caching', 'The request is laid out stable → volatile with a cache breakpoint after each stable part: (1) tools + the server’s instructions, (2) the stable data sent apart as `context` (the open file, the project’s files), (3) the conversation up to the last reply. The question and its portal records come last, uncached. Cached input costs a tenth and is read much faster.'],
  ['Cache warm-up', 'While a question is typed, the same prefix is written to the cache with max_tokens 0 (nothing generated), for the model the question will likely go to — so the answer starts warm.'],
  ['Auto, quickly', 'A local check settles the obvious cases with no call (small talk → Haiku, writing / summarising → Sonnet 5, deep analysis or a long request → Opus 5.5); only the rest go to the router, which now waits at most 4 s.'],
  ['In parallel', 'Auto, the project’s digest, the portal records and (file viewer) the files you name are gathered at the same time; the project’s files are only listed when the digest has to be rebuilt.'],
  ['Portals', 'The answer waits at most 6 s for the portal records; later ones are left out and the byline says so. Acts kept on this machine open from the local copy.'],
  ['Effort', 'Every turn runs at medium effort (Sonnet defaults to high).'],
  ['Stop', 'Stop cancels the request itself, not only its result.'],
  ['Not used', 'Fast mode (2.5× faster output on Opus) is a research preview that needs access from Anthropic.'],
];

function Text({ title, where, text }) {
  const [done, setDone] = useState(false);
  const body = Array.isArray(text) ? text.join('\n') : String(text ?? '');
  return (
    <article className="debug-arc-item">
      <header className="debug-arc-head">
        <h3 className="debug-arc-title">{title}</h3>
        {where ? <span className="debug-arc-when">{where}</span> : null}
        <button
          type="button"
          className="debug-arc-btn"
          onClick={() => navigator.clipboard?.writeText(body).then(() => { setDone(true); setTimeout(() => setDone(false), 1200); }).catch(() => {})}
        >{done ? 'Copied' : 'Copy'}</button>
      </header>
      <pre className="debug-arc-text">{body || '(empty)'}</pre>
    </article>
  );
}

// What the other AIs send — loaded when the view is opened (their modules are
// heavy and the rest of Debug doesn't need them).
function useOtherPrompts(on) {
  const [list, setList] = useState(null);
  useEffect(() => {
    if (!on || list) return;
    let dead = false;
    (async () => {
      const out = [];
      const add = async (load, pick) => {
        try { out.push(...pick(await load())); } catch (e) { out.push({ title: 'Could not load', where: String(e?.message || e), text: '' }); }
      };
      await add(() => import('../lib/aiFileEdits'), (m) => [{ title: 'File viewer — edit rule', where: 'lib/aiFileEdits EDIT_RULE', text: m.EDIT_RULE }]);
      await add(() => import('../lib/docAuthority'), (m) => [{ title: 'Official documents win', where: 'lib/docAuthority AUTHORITY_RULE', text: m.AUTHORITY_RULE }]);
      await add(() => import('../lib/roIdDocuments'), (m) => [
        { title: 'Identity documents — the MRZ strip', where: 'lib/roIdDocuments MRZ_PROMPT', text: m.MRZ_PROMPT },
        { title: 'Identity documents — reading a Romanian ID', where: 'lib/roIdDocuments RO_ID_PROMPT', text: m.RO_ID_PROMPT },
      ]);
      await add(() => import('../lib/identities'), (m) => [{ title: 'Identity documents — the kind of document', where: 'lib/identities ID_TYPE_RULE', text: m.ID_TYPE_RULE }]);
      await add(() => import('../lib/imageToWord'), (m) => [{ title: 'Picture → Word', where: 'lib/imageToWord PROMPT', text: m.PROMPT }]);
      if (!dead) setList(out);
    })();
    return () => { dead = true; };
  }, [on, list]);
  return list;
}

// The drafting steer is live: it is what the Playbook and the writing profile
// say right now.
function useDraftingSteer(on) {
  const [steer, setSteer] = useState(null);
  useEffect(() => {
    if (!on || steer) return;
    let dead = false;
    (async () => {
      let rules = ''; let style = '';
      try { rules = (await import('../lib/docRules')).docRulesSteer(); } catch { /* none */ }
      try { style = await (await import('../lib/writingStyle')).styleSteer(); } catch { /* none */ }
      if (!dead) setSteer({ rules, style });
    })();
    return () => { dead = true; };
  }, [on, steer]);
  return steer;
}

export default function AiSettings() {
  const [view, setView] = useState('what');
  const others = useOtherPrompts(view === 'others');
  const steer = useDraftingSteer(view === 'prompts');
  const picked = loadAiModel();
  const files = loadAiProjectFiles();
  const sample = 'Art. 1. Vânzătorul vinde, iar cumpărătorul cumpără imobilul situat în [[adresa]].';

  return (
    <section className="debug-icons debug-arc">
      <div className="debug-icons-head">
        <div>
          <h2 className="debug-card-title">AI settings — everything the AI is set to</h2>
          <p className="debug-card-body">
            Research and the file viewer run on ONE AI (lib/aiEngine): change it there and both change.
            Here is what each may do, the models and Auto, the time limits, what this device has picked,
            and every text the AI is sent, word for word. The app’s other AIs are listed last.
          </p>
        </div>
      </div>

      <div className="debug-arc-switch"><RuleOptions field={VIEWS} value={view} onPick={setView} /></div>

      {view === 'what' && (
        <>
          <table className="debug-set-table">
            <thead>
              <tr><th>Capability</th>{SURFACES.map((s) => <th key={s.id}>{s.label}</th>)}</tr>
            </thead>
            <tbody>
              {CAPABILITIES.map((c) => (
                <tr key={c.id}>
                  <td><b>{c.label}</b><span>{c.what}</span></td>
                  {SURFACES.map((s) => (
                    <td key={s.id} className={s[c.id] ? 'is-yes' : 'is-no'}>{s[c.id] ? 'Yes' : 'No'}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <dl className="debug-set-facts">
            <dt>Model picked on this device</dt><dd>{aiModel(picked).label} <code>{AI_SETTING_KEYS.model}</code></dd>
            <dt>Project files switch</dt><dd>{files ? 'On' : 'Off'} <code>{AI_SETTING_KEYS.projectFiles}</code></dd>
            <dt>Answer style</dt><dd>{aiStyle(loadAiStyle()).label} <code>{AI_SETTING_KEYS.style}</code></dd>
            <dt>Shared by</dt><dd>Research and the file viewer — one setting (components/AiControls).</dd>
            <dt>Usage labels</dt><dd>{SURFACES.map((s) => <code key={s.id}>{s.usageAction}</code>)} <code>paragraph-edit</code> <code>ai-route</code> <code>ai-warm</code> <code>research-summary</code></dd>
          </dl>
        </>
      )}

      {view === 'models' && (
        <>
          <table className="debug-set-table">
            <thead><tr><th>In the picker</th><th>Model id</th><th>Runs on</th><th>Note</th></tr></thead>
            <tbody>
              {AI_MODELS.map((m) => (
                <tr key={m.id}>
                  <td><b>{m.label}</b>{m.id === picked ? <span className="debug-ref-pill is-live">Picked here</span> : null}</td>
                  <td><code>{m.id}</code></td>
                  <td><code>{m.run || 'chosen per question'}</code></td>
                  <td>{m.tip || ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <dl className="debug-set-facts">
            <dt>Auto’s router</dt><dd><code>{ROUTER_MODEL}</code>, answers JSON {'{ model, reasoning }'}</dd>
            <dt>Fallback</dt><dd><code>{FALLBACK_MODEL}</code> — when Auto fails or takes over {ms(AI_LIMITS.routeMs)}</dd>
            <dt>Server allow-list</dt><dd>project-ai MODEL_ALLOW — Fable 5.1 is not on it, so it runs on Opus 5.5.</dd>
          </dl>
          <Text title="Auto — the routing prompt (yours, word for word)" where="AI_PROMPTS.router" text={AI_PROMPTS.router} />
        </>
      )}

      {view === 'limits' && (
        <table className="debug-set-table">
          <thead><tr><th>Setting</th><th>Value</th><th>What it is</th></tr></thead>
          <tbody>
            {Object.entries(AI_LIMITS).map(([k, v]) => (
              <tr key={k}>
                <td><code>{k}</code></td>
                <td><b>{/Ms$/.test(k) ? ms(v) : v.toLocaleString()}</b></td>
                <td>{LIMIT_INFO[k] || ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {view === 'speed' && (
        <>
          <table className="debug-set-table">
            <thead><tr><th>What</th><th>How</th></tr></thead>
            <tbody>{SPEED.map(([k, v]) => <tr key={k}><td><b>{k}</b></td><td>{v}</td></tr>)}</tbody>
          </table>
          <table className="debug-set-table">
            <thead><tr><th>Question</th><th>Auto, quickly</th></tr></thead>
            <tbody>
              {ROUTE_SAMPLES.map((q) => {
                const r = quickRoute(q);
                return <tr key={q}><td>{q}</td><td>{r ? <><b>{aiModel(r.id).label}</b><span>{r.reasoning}</span></> : 'Asked the router'}</td></tr>;
              })}
            </tbody>
          </table>
        </>
      )}

      {view === 'styles' && (
        <>
          <p className="debug-icons-count">
            The dropdown left of Research’s search (and in the file viewer’s composer) — ONE setting for both.
            The style line rides at the END of a question only (not drafts or paragraph edits), so the cached prefix is untouched.
          </p>
          {AI_STYLES.map((x) => (
            <Text key={x.id} title={`${x.label} — ${x.tip}`} where={`AI_STYLES.${x.id}`} text={x.prompt || '(nothing is added — Claude answers its own way)'} />
          ))}
        </>
      )}

      {view === 'prompts' && (
        <>
          <p className="debug-icons-count">
            No standing rules. A question is sent with the last {AI_LIMITS.historyTurns} messages and, in front of it,
            the data gathered for it in these blocks: <code>{'<open_file name>'}</code> (file viewer),{' '}
            <code>{'<historical_legal_context file>'}</code> (an old document), <code>{'<portal_record source ref>'}</code>,{' '}
            <code>{'<project_files project>'}</code>. The texts below are the only instructions, each sent only where its capability is on.
          </p>
          <Text title="How every AI addresses you (yours, word for word) — first in the cached context of every answer; not on paragraph rewrites" where="AI_MANNERS" text={AI_MANNERS} />
          <Text title="Research — AI summary of an exact match" where="AI_PROMPTS.summary" text={AI_PROMPTS.summary({ ask: 'Summarise this Romanian normative act for a lawyer', question: '<the line typed>', site: 'legislatie.just.ro', text: '<the whole record>' })} />
          <Text title="File viewer — create files: the two tools" where="AI_PROMPTS.drafting, on the latest message while drafting" text={AI_PROMPTS.drafting} />
          <Text title="File viewer — create files: the document being drafted" where="AI_PROMPTS.currentDocument + its acknowledgement" text={`${AI_PROMPTS.currentDocument('Contract.docx', '<the current version>')}\n\n— ${AI_PROMPTS.currentDocumentAck}`} />
          <Text title="File viewer — a Word file DocVex did not write" where="AI_PROMPTS.foreignDocument + its acknowledgement" text={`${AI_PROMPTS.foreignDocument('Contract.docx', '<its text>')}\n\n— ${AI_PROMPTS.foreignDocumentAck}`} />
          <Text title="File viewer — edit files: changing project files" where="lib/aiFileEdits EDIT_RULE, as the opening exchange" text={EDIT_RULE} />
          <Text title="File viewer — create AND edit files: your Playbook document rules (live)" where="lib/docRules docRulesSteer, as <playbook_rules> in the cached context of every file-viewer turn (drafts, paragraph edits, file edits); the server defers to it (PLAYBOOK_RULE)" text={steer ? (steer.rules || '(the Playbook rules are paused)') : 'Loading…'} />
          <Text title="File viewer — create files: your writing style (live)" where="lib/writingStyle styleSteer, on a draft" text={steer ? (steer.style || '(no writing voice learned yet)') : 'Loading…'} />
        </>
      )}

      {view === 'others' && (
        <>
          <p className="debug-icons-count">
            These AIs are not part of the unified AI yet; their own instructions, read from their modules.
            Every AI use and its model is in the AI inventory above.
          </p>
          {others ? others.map((o, i) => <Text key={`${o.title}${i}`} title={o.title} where={o.where} text={o.text} />)
            : <p className="debug-icons-count">Loading…</p>}
        </>
      )}
    </section>
  );
}

