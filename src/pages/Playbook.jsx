import React, { useCallback, useEffect, useState } from 'react';
import PageMasthead from '../components/PageMasthead';
import Tooltip from '../components/Tooltip';
import DropZone from '../components/DropZone';
import { useAuth } from '../context/AuthContext';
import { extractFileText } from '../lib/extractFileText';
import {
  listSamples, addSample, removeSample,
  loadProfile, rebuildProfile, setStyleEnabled,
} from '../lib/writingStyle';
import {
  RULE_GROUPS, DEFAULT_RULES, loadDocRules, saveDocRules, rulesOutline, optionFor,
} from '../lib/docRules';
import './Playbook.css';

// Playbook — the user's own documents, and the writing voice the AI learns from
// them.
//
// A draft that is correct but does not sound like the person sending it still
// has to be rewritten, so the time it saved is spent again. The fix is not a
// better prompt: it is showing the model how THIS person writes. So they import
// documents they wrote by hand, one pass distils those into a description of
// their drafting habits, and that description rides along with every request
// that writes or edits a document — in this project and every other.
//
// It hangs off the ACCOUNT, not a project: how someone writes follows them.

const ACCEPT = '.docx,.pdf,.txt,.md,.rtf,.csv,.xlsx';
const MAX_BYTES = 25 * 1024 * 1024;

const IconDoc = (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H14l5 5v11.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 19.5z" />
    <path d="M14 3v5h5" /><path d="M8.5 13h7M8.5 16h4.5" />
  </svg>
);
const IconX = (
  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);

function bytesLabel(chars) {
  if (!chars) return '';
  if (chars < 1000) return `${chars} characters`;
  return `${Math.round(chars / 1000)}k characters`;
}
function whenLabel(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

// ── Templates (NOT MOUNTED) ──────────────────────────────────────────────
// This section was taken off the page and is kept for a rewrite: render
// <TemplatesSection onNote={setNote} /> in the page body to bring it back. The
// ── Document rules ─────────────────────────────────────────────────────────
// The half of the Playbook that is STATED rather than learned: how a document
// is numbered and laid out. A model asked twice will answer "Art. 1" once and
// "CAPITOLUL I" the next time, so consistency between two documents from the
// same office cannot come from a distilled description — it has to be a
// decision the user makes once, here. See lib/docRules for what each choice
// tells the model, and why the choices are the shapes they are (the app's own
// paragraph parser reads them back).
function RulesSection() {
  const [rules, setRules] = useState(() => loadDocRules());
  const set = useCallback((key, value) => {
    setRules((cur) => saveDocRules({ ...cur, [key]: value }));
  }, []);
  const outline = rulesOutline(rules);
  const dirty = Object.keys(DEFAULT_RULES).some((k) => rules[k] !== DEFAULT_RULES[k]);

  return (
    <section className={`pbk-rules${rules.enabled ? '' : ' is-paused'}`}>
      <header className="pbk-rules-head">
        <div className="pbk-profile-title">
          <h2>Document rules</h2>
          <p>
            How the AI lays a document out — what a section is called, how
            clauses are numbered, how dates and amounts are written. Set once,
            followed by everything it drafts, so two documents from this office
            match.
          </p>
        </div>
        <div className="pbk-profile-tools">
          {dirty && (
            <Tooltip content="Put every rule back to the default">
              <button type="button" className="pbk-relearn" onClick={() => setRules(saveDocRules({ ...DEFAULT_RULES, enabled: rules.enabled }))}>
                Reset
              </button>
            </Tooltip>
          )}
          <Tooltip content={rules.enabled ? 'Stop applying these rules — nothing is lost' : 'Apply these rules again'}>
            <button
              type="button"
              role="switch"
              aria-checked={!!rules.enabled}
              className={`pbk-switch${rules.enabled ? ' is-on' : ''}`}
              onClick={() => set('enabled', !rules.enabled)}
            >
              <span className="pbk-switch-track"><span className="pbk-switch-knob" /></span>
              <span className="pbk-switch-label">{rules.enabled ? 'In use' : 'Paused'}</span>
            </button>
          </Tooltip>
        </div>
      </header>

      <div className="pbk-rules-body">
        <div className="pbk-rules-sets">
          {RULE_GROUPS.map((group) => (
            <div className="pbk-ruleset" key={group.id}>
              <h3>{group.title}</h3>
              <p className="pbk-ruleset-note">{group.note}</p>
              {group.fields.map((f) => (
                <div className="pbk-rule" key={f.key}>
                  <div className="pbk-rule-label">
                    <span>{f.label}</span>
                    {f.hint && <small>{f.hint}</small>}
                  </div>
                  {/* Each choice shows what it LOOKS like, not just what it is
                      called — "a)" means nothing until you see it in a line. */}
                  <div className="pbk-rule-opts" role="radiogroup" aria-label={f.label}>
                    {f.options.map((o) => (
                      <Tooltip content={o.example || o.label} key={o.id}>
                        <button
                          type="button"
                          role="radio"
                          aria-checked={rules[f.key] === o.id}
                          className={`pbk-rule-opt${rules[f.key] === o.id ? ' is-on' : ''}`}
                          onClick={() => set(f.key, o.id)}
                        >
                          {o.label}
                        </button>
                      </Tooltip>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ))}

          <div className="pbk-ruleset">
            <h3>Anything else</h3>
            <p className="pbk-ruleset-note">
              Rules the settings above don’t cover, in your own words — one per
              line. They are passed to the AI exactly as written.
            </p>
            <textarea
              className="pbk-rules-extra"
              value={rules.extra}
              rows={5}
              maxLength={2000}
              placeholder={'Always cite the article of the Civil Code in brackets.\nEnd every contract with a signature block for both parties.\nNever use the word „prezentul” more than once per clause.'}
              onChange={(e) => set('extra', e.target.value)}
            />
          </div>
        </div>

        {/* The settings applied to a document, which is the only way numbering
            rules can be read at a glance. */}
        <aside className="pbk-rules-preview" aria-label="Example">
          <h3>What that looks like</h3>
          <div className="pbk-preview-sheet">
            {outline.map((line, i) => (
              // eslint-disable-next-line react/no-array-index-key
              <p className={`pbk-preview-line is-l${line.level}`} key={i}>{line.text}</p>
            ))}
          </div>
          <p className="pbk-preview-foot">
            {optionFor('language', rules.language)?.id === 'auto'
              ? 'Written in whichever language you ask in.'
              : `Written in ${rules.language === 'en' ? 'English' : 'Romanian'}.`}
          </p>
        </aside>
      </div>
    </section>
  );
}

export default function Playbook() {
  const { session } = useAuth();
  const signedIn = !!session?.user?.id;

  const [samples, setSamples] = useState([]);
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [learning, setLearning] = useState(false);
  const [note, setNote] = useState(null);       // { tone, text }
  // Filename → why it was skipped, while a batch is being read.
  const [importing, setImporting] = useState([]);

  const refresh = useCallback(async () => {
    if (!signedIn) { setLoading(false); return; }
    setLoading(true);
    const [s, p] = await Promise.all([listSamples(), loadProfile()]);
    if (!s.error) setSamples(s.samples);
    if (!p.error) setProfile(p.profile);
    setLoading(false);
  }, [signedIn]);
  useEffect(() => { refresh(); }, [refresh]);

  // Learn from whatever is currently imported. Run automatically after an
  // import or a removal — the profile is a claim about the documents on this
  // page, so it must not be allowed to disagree with them.
  const learn = useCallback(async () => {
    setLearning(true);
    const res = await rebuildProfile();
    setLearning(false);
    if (res.error) {
      setNote({
        tone: 'error',
        text: res.error.message === 'ai_not_configured'
          ? 'The AI isn’t configured on the server yet, so it can’t read these documents.'
          : 'Couldn’t reach the AI to read those documents. Try again in a moment.',
      });
      return;
    }
    setProfile(res.profile);
    setNote(res.profile.text
      ? { tone: 'ok', text: 'Learned. New documents will be written in your voice.' }
      : null);
  }, []);

  const ingest = useCallback(async (files) => {
    const list = Array.from(files || []);
    if (!list.length) return;
    setNote(null);
    setImporting(list.map((f) => f.name));
    const skipped = [];
    let added = 0;
    for (const f of list) {
      if (f.size > MAX_BYTES) { skipped.push(`${f.name} — too large`); continue; }
      // eslint-disable-next-line no-await-in-loop
      const ex = await extractFileText(f, f.name);
      const text = ex?.text || '';
      if (!text.trim()) {
        skipped.push(`${f.name} — no text could be read from it`);
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      const res = await addSample({ name: f.name, mimeType: f.type || '', text });
      if (res.error) skipped.push(`${f.name} — couldn’t be saved`);
      else added += 1;
    }
    setImporting([]);
    const s = await listSamples();
    if (!s.error) setSamples(s.samples);
    if (skipped.length) {
      setNote({ tone: added ? 'warn' : 'error', text: `Skipped ${skipped.length}: ${skipped.join('; ')}.` });
    }
    if (added) await learn();
  }, [learn]);

  const drop = async (id) => {
    const res = await removeSample(id);
    if (res.error) { setNote({ tone: 'error', text: 'Couldn’t remove that document.' }); return; }
    const next = samples.filter((s) => s.id !== id);
    setSamples(next);
    await learn();
  };

  const toggle = async (on) => {
    setProfile((p) => (p ? { ...p, enabled: on } : p));
    const res = await setStyleEnabled(on);
    if (res.error) { setProfile((p) => (p ? { ...p, enabled: !on } : p)); }
  };

  const hasStyle = !!profile?.text;
  const busy = learning || importing.length > 0;

  return (
    <div className="page-frame pbk-frame">
      <PageMasthead
        eyebrow="DocVex"
        eyebrowMuted="Your writing"
        title="Playbook"
      >
        Import documents you wrote yourself and the AI learns how you draft —
        your structure, your phrasing, your tone. From then on everything it
        writes or edits for you comes out in your voice instead of its own.
      </PageMasthead>

      {!signedIn ? (
        <p className="pbk-signedout">Sign in to teach the AI how you write.</p>
      ) : (
        <div className="pbk">
          {/* ── The rules the user sets ───────────────────────────────── */}
          <RulesSection />

          {/* ── What it learned ───────────────────────────────────────── */}
          <section className={`pbk-profile${hasStyle ? '' : ' is-empty'}`}>
            <header className="pbk-profile-head">
              <div className="pbk-profile-title">
                <h2>Your writing voice</h2>
                <p>
                  {hasStyle
                    ? `Read from ${profile.sampleCount} ${profile.sampleCount === 1 ? 'document' : 'documents'}${profile.generatedAt ? ` on ${whenLabel(profile.generatedAt)}` : ''}.`
                    : 'Nothing learned yet — import a document below and this fills itself in.'}
                </p>
              </div>
              {hasStyle && (
                <div className="pbk-profile-tools">
                  {/* Off without forgetting: a one-off piece that has to read
                      neutrally shouldn't cost someone everything they taught it. */}
                  <Tooltip content={profile.enabled ? 'Stop writing in your voice — nothing is forgotten' : 'Write in your voice again'}>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={!!profile.enabled}
                      className={`pbk-switch${profile.enabled ? ' is-on' : ''}`}
                      onClick={() => toggle(!profile.enabled)}
                    >
                      <span className="pbk-switch-track"><span className="pbk-switch-knob" /></span>
                      <span className="pbk-switch-label">{profile.enabled ? 'In use' : 'Paused'}</span>
                    </button>
                  </Tooltip>
                  <Tooltip content="Read your documents again and rewrite this">
                    <button type="button" className="pbk-relearn" onClick={learn} disabled={busy}>
                      {learning ? 'Reading…' : 'Learn again'}
                    </button>
                  </Tooltip>
                </div>
              )}
            </header>
            {hasStyle ? (
              <div className={`pbk-profile-body${profile.enabled ? '' : ' is-paused'}`}>
                {profile.text.split(/\n{2,}/).map((para, i) => <p key={i}>{para}</p>)}
              </div>
            ) : (
              <p className="pbk-profile-blank">
                This is where the AI writes down what it noticed about your
                drafting — how you open and close, how you build a clause, the
                phrases you reach for. You can read it, and correct it by
                importing better examples.
              </p>
            )}
          </section>

          {/* ── The documents it learned from ─────────────────────────── */}
          <section className="pbk-samples">
            <header className="pbk-samples-head">
              <h2>Documents you wrote</h2>
              <p>
                Word, PDF or plain text. Pick the ones that read most like you —
                a handful of good examples teaches more than a folder of
                everything.
              </p>
            </header>

            {/* The Timeline's import surface, shared verbatim — same component,
                same stylesheet. It collapses to its compact row once there are
                documents, exactly as it does there.

                The one deliberate difference is `accept`: the Timeline takes
                any file, because one it cannot read still anchors the story by
                name. Here a file that yields no text teaches nothing, so the
                picker is filtered to the formats that can actually be read. */}
            <DropZone
              compact={samples.length > 0 || importing.length > 0}
              disabled={busy}
              accept={ACCEPT}
              onFiles={ingest}
              title="Drop documents you wrote here"
              sub={
                samples.length > 0
                  ? 'Word, PDF or plain text. Only the text is kept — the files stay on your computer.'
                  : 'Word, PDF or plain text. The AI reads how you draft — your structure, your phrasing, your tone — and writes in that voice from then on. Only the text is kept, and only the first pages of it; the files stay on your computer.'
              }
            />

            {note && (
              <p className={`pbk-note is-${note.tone}`} role={note.tone === 'error' ? 'alert' : 'status'}>
                {note.text}
              </p>
            )}

            {importing.length > 0 && (
              <ul className="pbk-list">
                {importing.map((n) => (
                  <li className="pbk-item is-reading" key={`reading-${n}`}>
                    <span className="pbk-item-mark" aria-hidden="true">{IconDoc}</span>
                    <span className="pbk-item-text"><span className="pbk-item-name">{n}</span><span className="pbk-item-meta">Reading…</span></span>
                  </li>
                ))}
              </ul>
            )}

            {loading ? (
              <p className="pbk-empty">Loading…</p>
            ) : samples.length === 0 && importing.length === 0 ? (
              <p className="pbk-empty">No documents yet.</p>
            ) : (
              <ul className="pbk-list">
                {samples.map((s) => (
                  <li className="pbk-item" key={s.id}>
                    <span className="pbk-item-mark" aria-hidden="true">{IconDoc}</span>
                    <span className="pbk-item-text">
                      <span className="pbk-item-name">{s.name}</span>
                      <span className="pbk-item-meta">
                        {[bytesLabel(s.char_count), whenLabel(s.created_at)].filter(Boolean).join(' · ')}
                      </span>
                    </span>
                    <Tooltip content="Remove — the AI relearns without it">
                      <button type="button" className="pbk-item-drop" onClick={() => drop(s.id)} disabled={busy} aria-label={`Remove ${s.name}`}>
                        {IconX}
                      </button>
                    </Tooltip>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
