// The brief — the screen between picking a template and the draft. A STAGED
// questionnaire (lib/docBrief: the five steps every Romanian legal document is
// built on), one step at a time, each question answered by picking, typing or
// handing it to the AI. Generate is offered once every question is answered.
//
// It reads the Playbook presets. A company can also be filled from ANAF by its CUI.


import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Tooltip from './Tooltip';
import { loadRulePresets, loadActivePresetId, loadDocRules, presetInUse } from '../lib/docRules';
import {
  BRIEF_STEPS, PARTY_FIELDS, questionsFor, briefFamily, initialAnswers, isAnswered, partyDone,
  newParty, fieldsFromAnaf, buildBriefPrompt,
} from '../lib/docBrief';
import { checkText, groundingBlock } from '../lib/sourceChecks';
import './DocBrief.css';


const Check = () => (
  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
);
const Spark = () => (
  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" /></svg>
);

function Pill({ on, onClick, children, tone, disabled }) {
  return (
    <button type="button" className={`dbr-pill${on ? ' is-on' : ''}${tone ? ` is-${tone}` : ''}`} aria-pressed={!!on} onClick={onClick} disabled={disabled}>
      {on && <Check />}{children}
    </button>
  );
}

// One question, Claude-Design style: the title, a hint, the options as pills,
// "Other" as a field, and "Let the AI decide".
function Question({ q, a, done, onChange, extra }) {
  const setChoice = (id) => {
    if (q.type === 'multi') {
      const has = a.choice.includes(id);
      onChange({ ...a, ai: false, choice: has ? a.choice.filter((x) => x !== id) : [...a.choice, id] });
    } else {
      onChange({ ...a, ai: false, choice: a.choice[0] === id ? [] : [id], text: a.choice[0] === id ? a.text : '' });
    }
  };
  return (
    <section className={`dbr-q${done ? ' is-done' : ''}`} data-q={q.id}>
      <header className="dbr-q-head">
        <span className="dbr-q-mark" aria-hidden="true">{done ? <Check /> : null}</span>
        <div className="dbr-q-titles">
          <h3 className="dbr-q-title">{q.title}</h3>
          {q.hint && <p className="dbr-q-hint">{q.hint}</p>}
        </div>
      </header>
      <div className="dbr-q-body">
        {extra}
        {q.type === 'text' && (q.multiline ? (
          <textarea
            className="dbr-input is-area" rows={3} value={a.ai ? '' : a.text}
            placeholder={a.ai ? 'The AI decides' : 'Type the answer…'}
            onChange={(e) => onChange({ ...a, ai: false, text: e.target.value })}
          />
        ) : (
          <input
            className="dbr-input" type="text" value={a.ai ? '' : a.text}
            placeholder={a.ai ? 'The AI decides' : 'Type the answer…'}
            onChange={(e) => onChange({ ...a, ai: false, text: e.target.value })}
          />
        ))}
        {(q.type === 'choice' || q.type === 'multi') && (
          <div className="dbr-pills">
            {q.options.map((o) => (
              <Pill key={o.id} on={!a.ai && a.choice.includes(o.id)} onClick={() => setChoice(o.id)}>
                {o.label}
                {q.recommend === o.id && <span className="dbr-rec">recommended</span>}
              </Pill>
            ))}
          </div>
        )}
        {(q.type === 'choice' || q.type === 'multi') && q.other && (
          <input
            className="dbr-input is-other" type="text" value={a.ai ? '' : a.text}
            placeholder="Other…"
            onChange={(e) => onChange({
              ...a, ai: false, text: e.target.value,
              // A typed answer to a single choice replaces the picked option.
              choice: q.type === 'choice' && e.target.value.trim() ? [] : a.choice,
            })}
          />
        )}
        {!q.noAi && (
          <div className="dbr-ai-row">
            <Pill tone="ai" on={a.ai} onClick={() => onChange(a.ai ? { ...a, ai: false } : { ai: true, choice: [], text: '' })}>
              <Spark /> Let the AI decide
            </Pill>
          </div>
        )}
      </div>
    </section>
  );
}

// One party: its role, individual or company, and where its details come from.
function PartyCard({ party, index, canRemove, onChange, onRemove }) {
  const [anafBusy, setAnafBusy] = useState(false);
  const [anafNote, setAnafNote] = useState('');
  const done = partyDone(party);
  const set = (patch) => onChange({ ...party, ...patch, auto: undefined });
  const setField = (key, v) => set({ fields: { ...party.fields, [key]: v } });

  const lookUp = async () => {
    const cui = String(party.fields?.taxId || '').trim();
    if (!cui || anafBusy) return;
    setAnafBusy(true); setAnafNote('');
    try {
      const { lookupCompanies } = await import('../lib/anaf');
      const res = await lookupCompanies(cui);
      const c = res?.companies?.[0];
      if (!c) { setAnafNote(res?.ok ? 'ANAF has no company with that CUI.' : 'ANAF could not be reached (desktop app only).'); return; }
      set({ fields: { ...party.fields, ...fieldsFromAnaf(c) } });
      setAnafNote(`Filled from ANAF — ${c.name}.`);
    } catch {
      setAnafNote('ANAF could not be reached.');
    } finally {
      setAnafBusy(false);
    }
  };

  return (
    <div className={`dbr-party${done ? ' is-done' : ''}`}>
      <div className="dbr-party-head">
        <span className="dbr-party-n">{index + 1}</span>
        <input
          className="dbr-input dbr-party-role" type="text" value={party.role}
          placeholder="Role — Vânzător, Reclamant…" aria-label="Party role"
          onChange={(e) => set({ role: e.target.value })}
        />
        {canRemove && (
          <Tooltip content="Remove this party">
            <button type="button" className="dbr-x" aria-label="Remove this party" onClick={onRemove}>
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
            </button>
          </Tooltip>
        )}
      </div>

      <div className="dbr-party-row">
        <span className="dbr-label">Is it</span>
        <div className="dbr-pills">
          <Pill on={party.kind === 'person'} onClick={() => set({ kind: 'person', path: null })}>Persoană fizică</Pill>
          <Pill on={party.kind === 'org'} onClick={() => set({ kind: 'org', path: null })}>Persoană juridică</Pill>
        </div>
      </div>

      <div className="dbr-party-row">
        <span className="dbr-label">Details</span>
        <div className="dbr-pills">
          <Pill on={party.source === 'typed'} disabled={!party.kind} onClick={() => set({ source: 'typed', path: null })}>Type them</Pill>
          <Pill on={party.source === 'blank'} disabled={!party.kind} onClick={() => set({ source: 'blank', path: null })}>Leave blanks</Pill>
        </div>
      </div>
      {party.source === 'typed' && party.kind && (
        <div className="dbr-fields">
          {PARTY_FIELDS[party.kind].map((f) => (
            <label key={f.key} className={`dbr-field${f.wide ? ' is-wide' : ''}`}>
              <span className="dbr-field-label">{f.label}{f.required ? ' *' : ''}</span>
              <span className="dbr-field-line">
                <input
                  className="dbr-input" type="text" value={party.fields?.[f.key] || ''} placeholder={f.hint || ''}
                  onChange={(e) => setField(f.key, e.target.value)}
                  onKeyDown={(e) => { if (f.anaf && e.key === 'Enter') { e.preventDefault(); lookUp(); } }}
                />
                {f.anaf && (
                  <button type="button" className="dbr-anaf" disabled={anafBusy || !String(party.fields?.taxId || '').trim()} onClick={lookUp}>
                    {anafBusy ? 'Looking up…' : 'Fill from ANAF'}
                  </button>
                )}
              </span>
            </label>
          ))}
          {anafNote && <p className="dbr-note is-wide">{anafNote}</p>}
        </div>
      )}
    </div>
  );
}

export default function DocBrief({ template, custom, hint, onBack, onGenerate, busy }) {
  const presets = useMemo(() => loadRulePresets(), []);
  const activePresetId = useMemo(() => presetInUse(presets, loadDocRules(), loadActivePresetId())?.id || null, [presets]);
  const ctx = useMemo(() => ({ family: briefFamily(template), template }), [template]);
  const questions = useMemo(() => questionsFor(ctx), [ctx]);
  const [answers, setAnswers] = useState(() => initialAnswers(template, { presetId: activePresetId || presets[0]?.id, custom }));
  const [stepIdx, setStepIdx] = useState(0);
  const scrollRef = useRef(null);


  const setAnswer = useCallback((id, a) => setAnswers((prev) => ({ ...prev, [id]: a })), []);

  const touched = useRef(new Set());
  const userSet = useCallback((id, a) => {
    touched.current.add(id);
    const { auto: _auto, ...rest } = a || {};
    setAnswers((prev) => ({ ...prev, [id]: rest }));
  }, []);

  const answered = (q) => isAnswered(q, answers[q.id]);
  const stepQs = (id) => questions.filter((q) => q.step === id);
  const stepDone = (id) => stepQs(id).every(answered);
  const left = questions.filter((q) => !answered(q));
  const allDone = left.length === 0;
  const step = BRIEF_STEPS[stepIdx];
  const last = stepIdx === BRIEF_STEPS.length - 1;

  const goTo = (i) => {
    setStepIdx(i);
    scrollRef.current?.scrollTo?.({ top: 0 });
  };
  // Takes the reader to the first question still open (possibly on another step).
  const showFirstOpen = () => {
    const q = left[0];
    if (!q) return;
    const i = BRIEF_STEPS.findIndex((s) => s.id === q.step);
    setStepIdx(i);
    requestAnimationFrame(() => {
      const el = scrollRef.current?.querySelector(`[data-q="${q.id}"]`);
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el?.classList.add('is-flash');
      setTimeout(() => el?.classList.remove('is-flash'), 1200);
    });
  };
  // Everything still open that the AI may decide is handed to it; parties,
  // collections and the preset still need the user.
  const aiTheRest = () => setAnswers((prev) => {
    const next = { ...prev };
    for (const q of questions) if (!q.noAi && !isAnswered(q, prev[q.id])) next[q.id] = { ai: true, choice: [], text: '' };
    return next;
  });

  // Before the draft is asked for, what the brief names is checked against the
  // connected sources (lib/sourceChecks) — the acts picked as the legal basis,
  // the parties' CUIs at ANAF — and what they say goes into the request, so
  // the draft starts from the official data rather than being corrected to it
  // afterwards. Capped in time: a portal that doesn't answer never holds the
  // draft back.
  const [grounding, setGrounding] = useState(false);
  const generate = async () => {
    if (!allDone || busy || grounding) { if (!allDone) showFirstOpen(); return; }
    const out = buildBriefPrompt({
      template, custom, answers,
      presets, activePresetId,
    });
    const cuis = (answers.parties?.parties || []).map((p) => (
      p.source === 'typed' ? p.fields?.taxId : null
    )).filter(Boolean).map((c) => `CUI ${String(c).replace(/\D/g, '')}`);
    setGrounding(true);
    let block = '';
    try {
      const report = await Promise.race([
        checkText([out.prompt, ...cuis].join('\n')),
        new Promise((resolve) => { setTimeout(() => resolve(null), 25000); }),
      ]);
      block = groundingBlock(report);
    } catch { block = ''; }
    setGrounding(false);
    onGenerate?.(out.shown, block ? [out.prompt, block].join('\n\n') : out.prompt);
  };

  const partiesA = answers.parties;
  const setParties = (list) => userSet('parties', { ...partiesA, parties: list });

  const renderQuestion = (q) => {
    const a = answers[q.id];
    if (q.type === 'parties') {
      return (
        <section key={q.id} className={`dbr-q${answered(q) ? ' is-done' : ''}`} data-q={q.id}>
          <header className="dbr-q-head">
            <span className="dbr-q-mark" aria-hidden="true">{answered(q) ? <Check /> : null}</span>
            <div className="dbr-q-titles">
              <h3 className="dbr-q-title">{q.title} <span className="dbr-q-count">{partiesA.parties.length}</span></h3>
              <p className="dbr-q-hint">{q.hint}</p>
            </div>
          </header>
          <div className="dbr-q-body">
            {partiesA.parties.map((p, i) => (
              <PartyCard
                key={p.id} party={p} index={i}
                canRemove={partiesA.parties.length > 1}
                onChange={(np) => setParties(partiesA.parties.map((x) => (x.id === p.id ? np : x)))}
                onRemove={() => setParties(partiesA.parties.filter((x) => x.id !== p.id))}
              />
            ))}
            <button type="button" className="dbr-add" onClick={() => setParties([...partiesA.parties, newParty(`Partea ${partiesA.parties.length + 1}`)])}>
              + Add a party
            </button>
          </div>
        </section>
      );
    }
    if (q.type === 'preset') {
      return (
        <Question key={q.id} q={q} a={a} done={answered(q)} onChange={(v) => userSet(q.id, v)} extra={(
          <div className="dbr-pills">
            {presets.map((p) => (
              <Pill key={p.id} on={a.choice[0] === p.id} onClick={() => userSet(q.id, { ...a, choice: [p.id] })}>
                {p.name}{p.id === activePresetId && <span className="dbr-rec">in use</span>}
              </Pill>
            ))}
          </div>
        )} />
      );
    }
    return <Question key={q.id} q={q} a={a} done={answered(q)} onChange={(v) => userSet(q.id, v)} />;
  };

  return (
    <div className="dbr-root" ref={scrollRef}>
      <div className="dbr-inner">
        <button type="button" className="dbr-back" onClick={onBack} disabled={busy}>
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6" /></svg>
          All templates
        </button>
        <p className="dbr-eyebrow">{template ? template.label : 'Something else'}</p>
        <h1 className="dbr-title">Tell us about the document</h1>

        {/* The five steps. Each is a button: the steps can be taken in any order. */}
        <ol className="dbr-steps">
          {BRIEF_STEPS.map((s, i) => {
            const done = stepDone(s.id);
            return (
              <li key={s.id}>
                <button
                  type="button"
                  className={`dbr-step${i === stepIdx ? ' is-on' : ''}${done ? ' is-done' : ''}`}
                  onClick={() => goTo(i)}
                >
                  <span className="dbr-step-n">{done ? <Check /> : s.n}</span>
                  <span className="dbr-step-text">
                    <span className="dbr-step-title">{s.title}</span>
                    <span className="dbr-step-ask">{s.ask}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>

        <div className="dbr-stage" key={step.id}>
          <p className="dbr-stage-sub">{step.sub}</p>
          {stepQs(step.id).map(renderQuestion)}
        </div>
      </div>

      <div className="dbr-bar">
        <div className="dbr-bar-inner">
          <button type="button" className="dbr-btn" disabled={stepIdx === 0} onClick={() => goTo(stepIdx - 1)}>Back</button>
          <div className="dbr-bar-mid">
            <span className="dbr-progress" aria-hidden="true">
              <span style={{ width: `${Math.round(((questions.length - left.length) / questions.length) * 100)}%` }} />
            </span>
            {allDone ? (
              <span className="dbr-bar-note">Every detail is in.</span>
            ) : (
              <>
                <button type="button" className="dbr-link" onClick={showFirstOpen}>
                  {left.length} question{left.length === 1 ? '' : 's'} left
                </button>
                {left.some((q) => !q.noAi) && (
                  <button type="button" className="dbr-link" onClick={aiTheRest}><Spark /> Let the AI decide the rest</button>
                )}
              </>
            )}
          </div>
          {!last && <button type="button" className="dbr-btn" onClick={() => goTo(stepIdx + 1)}>Next</button>}
          <Tooltip content={allDone ? 'Write the document from these details' : 'Answer every question first — press to go to the next one'}>
            <button type="button" className={`dbr-btn is-primary${allDone ? '' : ' is-waiting'}`} disabled={busy || grounding} onClick={generate}>
              <Spark /> {grounding ? 'Checking the sources…' : busy ? 'Starting…' : 'Generate'}
            </button>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}
