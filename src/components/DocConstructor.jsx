import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import Tooltip from './Tooltip';
import { identityInitials, identitySummary } from '../lib/identities';
import {
  parseSource, composeSource, fillText, fieldsOf, roleLabel, variantsFor,
  valuesFromRecord, settleClauseFor, suggestionsFor,
  partiesOf, partyFieldId, isSignatureTitle, signatureLinked, signatureSyncEdits, identityFromValues,
  withEdits, partyTextFor, optionalPartsFor, setOptionalPart, clauseKind,
} from '../lib/docConstructor';
import './DocConstructor.css';

// The Constructor — a Word document as sections made of pieces.
//
// The preview shows what the file IS; this shows what it is MADE OF. Each
// section is a jigsaw block, each paragraph in it a piece that can be reworded
// by hand, reworded by the AI, filled blank by blank, or — for an
// identification clause — filled in one click from a party's record.
//
// It edits a DRAFT (held by the parent, so switching to the Word preview and
// back loses nothing) on top of the document's source, and hands the composed
// source back through `onSave`. It never touches the file itself.

const GripGlyph = (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
    <circle cx="9" cy="6" r="1.8" /><circle cx="15" cy="6" r="1.8" />
    <circle cx="9" cy="12" r="1.8" /><circle cx="15" cy="12" r="1.8" />
    <circle cx="9" cy="18" r="1.8" /><circle cx="15" cy="18" r="1.8" />
  </svg>
);
const LinesGlyph = (
  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <path d="M4 7h16M4 12h16M4 17h10" />
  </svg>
);
const ChevGlyph = (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <polyline points="6 9 12 15 18 9" />
  </svg>
);
const SparkGlyph = (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 3l1.8 4.6L18.5 9.4l-4.7 1.8L12 16l-1.8-4.8L5.5 9.4l4.7-1.8z" />
    <path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z" />
  </svg>
);
const CheckGlyph = (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

// Outline of one section: a rounded rect with a knob on top and a matching
// notch in the bottom edge, so stacked sections read as interlocking. The knob
// lives in the 18px band above the box.
function puzzlePath(w, h) {
  const r = 14, k = 17, top = 18, cx = w / 2, b = h - 0.5, x0 = 0.5, x1 = w - 0.5, y0 = top + 0.5;
  return `M${x0 + r},${y0} H${cx - k} A${k},${k} 0 0 1 ${cx + k},${y0} H${x1 - r} A${r},${r} 0 0 1 ${x1},${y0 + r} V${b - r} A${r},${r} 0 0 1 ${x1 - r},${b} H${cx + k} A${k},${k} 0 0 0 ${cx - k},${b} H${x0 + r} A${r},${r} 0 0 1 ${x0},${b - r} V${y0 + r} A${r},${r} 0 0 1 ${x0 + r},${y0} Z`;
}

// The shape is drawn to the section's measured size — an SVG path can't stretch
// without distorting the knob, so it is re-cut whenever the box resizes.
function PuzzleShape() {
  const ref = useRef(null);
  const [size, setSize] = useState(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(([entry]) => {
      const w = Math.round(entry.contentRect.width);
      const h = Math.round(entry.contentRect.height);
      setSize((cur) => (cur && cur.w === w && cur.h === h ? cur : { w, h }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div className="dcx-shape" ref={ref} aria-hidden="true">
      {size && size.w > 0 && size.h > 40 && (
        <svg width={size.w} height={size.h} viewBox={`0 0 ${size.w} ${size.h}`}>
          <path d={puzzlePath(size.w, size.h)} />
        </svg>
      )}
    </div>
  );
}

const EMPTY_DRAFT = { edits: {}, values: {}, assigned: {}, open: null, plain: {} };

export default function DocConstructor({
  source = '',
  fileName = '',
  docLabel = '',
  draft: draftProp,
  setDraft,
  baseValues = null,
  apiRef = null,
  records = [],
  busy = false,
  saving = false,
  foreign = false,
  saveError = null,
  onAskAi,
  onSave,
  onOpenIdentity,
  onCreateIdentity,
}) {
  const draft = draftProp || EMPTY_DRAFT;
  const { edits, values, assigned, open, plain } = draft;
  const patch = useCallback((fn) => setDraft?.((d) => ({ ...(d || EMPTY_DRAFT), ...fn(d || EMPTY_DRAFT) })), [setDraft]);

  const model = useMemo(() => parseSource(source), [source]);
  // The parties the document identifies. They get their own rendering — a card
  // tied to an identity record rather than a clause row — and the signature
  // section at the end is drawn from the same list, so the two can't disagree.
  // Read off the document AS EDITED: a clause rewritten for a company has a
  // representative the draft never mentioned, and the signatures need it.
  const parties = useMemo(() => partiesOf(withEdits(model, draftProp?.edits)), [model, draftProp?.edits]);
  const ridOf = (r) => r.id || r._path || r.name;
  const [creating, setCreating] = useState({});
  const [prompts, setPrompts] = useState({});
  const [aiBusy, setAiBusy] = useState({});
  const [aiErr, setAiErr] = useState({});
  // Hovering a record shows its values in the chips before anything is chosen.
  const [preview, setPreview] = useState({});

  const val = useCallback(
    (id) => (preview[id] !== undefined ? preview[id] : (values[id] || '')),
    [preview, values],
  );
  const textOf = useCallback((pc) => (edits[pc.id] !== undefined ? edits[pc.id] : pc.text), [edits]);

  // Dirty against what the open version already holds — a saved document
  // reopens with its blanks filled, and that alone is not a change.
  const dirty = useMemo(() => {
    if (Object.keys(edits).length > 0) return true;
    const base = baseValues || {};
    const keys = new Set([...Object.keys(values), ...Object.keys(base)]);
    for (const k of keys) if ((values[k] || '').trim() !== (base[k] || '').trim()) return true;
    return false;
  }, [edits, values, baseValues]);

  // The parent saves on its own schedule (leaving for the Word preview) and
  // exports from here, so it needs the composed document on demand.
  const compose = useCallback(() => {
    const { template, text } = composeSource(model, edits, values);
    return { template, text, values, assigned };
  }, [model, edits, values, assigned]);
  useEffect(() => {
    if (!apiRef) return undefined;
    apiRef.current = { compose, isDirty: () => dirty };
    return () => { apiRef.current = null; };
  }, [apiRef, compose, dirty]);

  // If the signature section already follows the parties, keep it following:
  // a party that became a company now signs through a representative, and one
  // that became a person no longer does. Plain-text signatures are left alone —
  // rewriting those is the user's call (the "Sync" button).
  const resyncSignatures = (nextEdits) => {
    const sigSec = model.sections.find((sec) => isSignatureTitle(sec.title));
    if (!sigSec) return nextEdits;
    const live = withEdits(model, nextEdits);
    const liveParties = partiesOf(live);
    const texts = live.sections.find((sec) => sec.id === sigSec.id).pieces.map((pc) => pc.text);
    if (!liveParties.length || !liveParties.every((pt) => signatureLinked(texts, pt))) return nextEdits;
    return { ...nextEdits, ...signatureSyncEdits(sigSec, liveParties) };
  };

  const assign = (role, rec) => {
    patch((d) => {
      let nextEdits = { ...d.edits };
      for (const sec of model.sections) {
        for (const pc of sec.pieces) {
          if (pc.party !== role) continue;
          // Built from the clause AS DRAFTED, never from a previous party's
          // settled wording: picking the wrong record first has to be undoable
          // by picking the right one. partyTextFor picks the person or company
          // formula for this record, keeps the optional details as they are
          // set, then settles gender, county/sector and house-vs-flat.
          const next = partyTextFor(pc, d.edits[pc.id], role, rec);
          if (next !== pc.text) nextEdits[pc.id] = next;
          else delete nextEdits[pc.id];
        }
      }
      nextEdits = resyncSignatures(nextEdits);
      // Values from the document as it now reads — the new formula may have
      // blanks (a representative, a CUI) the draft never had.
      const filled = valuesFromRecord(withEdits(model, nextEdits), role, rec);
      return {
        edits: nextEdits,
        values: { ...d.values, ...filled },
        assigned: { ...d.assigned, [role || '_']: rec.id || rec._path || rec.name },
      };
    });
    setPreview({});
  };

  // An optional detail switched on or off in a party's clause. On adds the
  // phrase (its blank fills from the assigned record straight away); off cuts
  // the phrase out of the sentence.
  const toggleOptional = (pc, role, partId, on, rec) => patch((d) => {
    const current = d.edits[pc.id] !== undefined ? d.edits[pc.id] : pc.text;
    const next = setOptionalPart(current, role, partId, on);
    let nextEdits = { ...d.edits };
    if (next === pc.text) delete nextEdits[pc.id]; else nextEdits[pc.id] = next;
    nextEdits = resyncSignatures(nextEdits);
    const filled = rec ? valuesFromRecord(withEdits(model, nextEdits), role, rec) : {};
    return { edits: nextEdits, values: { ...d.values, ...filled } };
  });

  const askAi = async (pc) => {
    const instruction = (prompts[pc.id] || '').trim();
    if (!instruction || aiBusy[pc.id] || !onAskAi) return;
    setAiBusy((m) => ({ ...m, [pc.id]: true }));
    setAiErr((m) => ({ ...m, [pc.id]: null }));
    try {
      const next = await onAskAi(textOf(pc), instruction);
      if (next) {
        patch((d) => ({ edits: { ...d.edits, [pc.id]: next } }));
        setPrompts((m) => ({ ...m, [pc.id]: '' }));
      } else {
        setAiErr((m) => ({ ...m, [pc.id]: 'The AI couldn’t be reached — the piece is unchanged.' }));
      }
    } finally {
      setAiBusy((m) => ({ ...m, [pc.id]: false }));
    }
  };

  // A party typed in by hand becomes an identity record, and the party is then
  // tied to it — so the next contract fills from the record in one click.
  const saveAsIdentity = async (party) => {
    const draftRecord = identityFromValues(party, values);
    if (!draftRecord || !onCreateIdentity || creating[party.roleKey]) return;
    setCreating((m) => ({ ...m, [party.roleKey]: true }));
    try {
      const rec = await onCreateIdentity(draftRecord);
      if (rec) patch((d) => ({ assigned: { ...d.assigned, [party.roleKey]: ridOf(rec) } }));
    } finally {
      setCreating((m) => ({ ...m, [party.roleKey]: false }));
    }
  };
  const unlink = (party) => patch((d) => {
    const next = { ...d.assigned };
    delete next[party.roleKey];
    return { assigned: next };
  });

  // Rewrite the signature section from the parties: one block each, signed
  // under the name the document gives the party and carrying the party's own
  // blanks. Only the lines that merely name a signatory are replaced — a date
  // or a place in the section stays (see signatureSyncEdits).
  const syncSignatures = (sec) => patch((d) => (
    { edits: { ...d.edits, ...signatureSyncEdits(sec, parties) }, open: null }
  ));
  const restoreSignatures = (sec) => patch((d) => {
    const next = { ...d.edits };
    sec.pieces.forEach((pc) => { delete next[pc.id]; });
    return { edits: next };
  });

  const save = () => {
    if (!dirty || saving) return;
    onSave?.(compose());
  };

  // ── Derived view ────────────────────────────────────────────────────────
  let totalBlanks = 0;
  let readySections = 0;
  const sections = model.sections.map((sec) => {
    let secBlanks = 0;
    const pieces = sec.pieces.map((pc, k) => {
      const text = textOf(pc);
      // An edited piece may have lost (or gained) blanks — read them off what
      // it says now, not what it said when the document was parsed.
      const fields = edits[pc.id] !== undefined ? fieldsOf(text) : pc.fields;
      const missing = fields.filter((f) => !val(f.id).trim());
      const roleKey = pc.party == null ? null : (pc.party || '_');
      const isParty = pc.party != null && fields.some((f) => f.key);
      const rec = isParty ? records.find((r) => (r.id || r._path || r.name) === assigned[roleKey]) : null;
      secBlanks += missing.length;
      // The piece's number is the document's own — "1.1.", "(2)", "a)" — read
      // off the source, so it is the same one the Word preview prints. A
      // paragraph the document leaves unnumbered is unnumbered here too.
      return { pc, k, text, fields, missing, isParty, rec, num: pc.num || '' };
    // A piece emptied by an edit (the signature lines a sync replaced) is gone
    // from the document, so it is gone from here too.
    }).filter((row) => row.text.trim());
    totalBlanks += secBlanks;
    if (secBlanks === 0) readySections += 1;
    return { sec, pieces };
  });

  const title = model.title || docLabel || fileName.replace(/\.[^.]+$/, '');
  const statusLine = busy && !sections.length
    ? ''
    : busy
      ? `Drafting… ${sections.length} section${sections.length === 1 ? '' : 's'} so far`
      : `${readySections} of ${sections.length} sections ready · ${totalBlanks} blank${totalBlanks === 1 ? '' : 's'} left`;

  // Bring an opened piece into view — it can expand well past the fold.
  const rootRef = useRef(null);
  useEffect(() => {
    if (!open) return;
    const el = rootRef.current?.querySelector(`[data-piece="${open}"]`);
    el?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, [open]);

  return (
    <div className="dcx-scroll">
      <div className="dcx-root" ref={rootRef}>
        <header className="dcx-head">
          <div className="dcx-head-titles">
            <span className="dcx-eyebrow">Constructor · {docLabel || fileName.replace(/\.[^.]+$/, '')}</span>
            <h1 className="dcx-title">{title}</h1>
          </div>
          <div className="dcx-head-row">
            <span className="dcx-status">{statusLine}</span>
            {(dirty || saving) && (
              <button type="button" className="dcx-save" onClick={save} disabled={saving}>
                {saving ? 'Saving…' : 'Save to document'}
              </button>
            )}
          </div>
          {saveError && <p className="dcx-note is-error" role="alert">{saveError}</p>}
          {foreign && sections.length > 0 && (
            <p className="dcx-note">
              This file wasn’t written in DocVex. Saving from the Constructor rebuilds it from its
              text, so Word-only formatting — tables, images, custom styles — is simplified.
            </p>
          )}
        </header>

        {busy && !sections.length && (
          <div className="dcx-skeleton" role="status" aria-label="Preparing the document">
            <div className="dcx-skel-line is-head" />
            <div className="dcx-skel-line" style={{ width: '100%' }} />
            <div className="dcx-skel-line" style={{ width: '92%' }} />
            <div className="dcx-skel-line" style={{ width: '60%' }} />
          </div>
        )}

        {!busy && !sections.length && (
          <div className="dcx-empty">
            <p className="dcx-empty-title">Nothing to build from yet</p>
            <p className="dcx-empty-sub">Ask the AI advisor for a document and its sections appear here.</p>
          </div>
        )}

        <div className="dcx-sections">
          {sections.map(({ sec, pieces }, si) => {
            const isPlain = !!plain[sec.id];
            return (
              <section className="dcx-section" key={sec.id} style={{ animationDelay: `${Math.min(si, 10) * 60}ms` }}>
                <PuzzleShape />
                <div className="dcx-section-in">
                  <div className="dcx-section-head">
                    <span className="dcx-grip">{GripGlyph}</span>
                    <span className="dcx-secnum">{sec.num || sec.n || '§'}</span>
                    <h2 className="dcx-sectitle">{sec.title}</h2>
                    <Tooltip content="Read this section as plain text">
                      <button
                        type="button"
                        className={`dcx-plainbtn${isPlain ? ' is-on' : ''}`}
                        aria-pressed={isPlain}
                        onClick={() => patch((d) => ({ plain: { ...d.plain, [sec.id]: !d.plain[sec.id] } }))}
                      >
                        {LinesGlyph}Text
                      </button>
                    </Tooltip>
                  </div>

                  {isPlain && (
                    <div className="dcx-plain">
                      {pieces.map(({ text, num }) => `${num ? `${num} ` : ''}${fillText(text, values, { keep: false })}`).join('\n\n')}
                    </div>
                  )}

                  {/* Signatures — drawn from the parties, not from the text: one
                      card per party, showing who will sign as it stands right
                      now. Pick an identity for a party above and its card here
                      changes with it. */}
                  {!isPlain && isSignatureTitle(sec.title) && parties.length > 0 && (() => {
                    const texts = pieces.map((row) => row.text);
                    const cards = parties.map((party) => ({
                      party,
                      linked: signatureLinked(texts, party),
                      rec: records.find((r) => ridOf(r) === assigned[party.roleKey]) || null,
                      name: val(partyFieldId(party, 'legalName')).trim(),
                      rep: val(partyFieldId(party, 'representative')).trim(),
                      cap: val(partyFieldId(party, 'repCapacity')).trim(),
                    }));
                    const allLinked = cards.every((c) => c.linked);
                    const touched = sec.pieces.some((pc) => edits[pc.id] !== undefined);
                    return (
                      <div className="dcx-sign">
                        <div className="dcx-sign-bar">
                          <span className={`dcx-sign-state${allLinked ? ' is-on' : ''}`}>
                            <span className="dcx-sign-state-dot" aria-hidden="true" />
                            {allLinked
                              ? 'In sync with the parties — whoever is named there signs here.'
                              : 'These signatures are plain text, so they don’t follow the parties.'}
                          </span>
                          {!allLinked && (
                            <button type="button" className="dcx-sign-btn is-primary" onClick={() => syncSignatures(sec)}>
                              Sync with the parties
                            </button>
                          )}
                          {touched && (
                            <button type="button" className="dcx-sign-btn" onClick={() => restoreSignatures(sec)}>
                              Restore original
                            </button>
                          )}
                        </div>
                        <div className="dcx-sign-grid">
                          {cards.map(({ party, linked, rec, name, rep, cap }) => (
                            <button
                              type="button"
                              key={party.roleKey}
                              className={`dcx-sign-card${linked ? ' is-linked' : ''}${name ? ' is-named' : ''}`}
                              onClick={() => patch(() => ({ open: party.pieceId }))}
                            >
                              <span className="dcx-sign-role">{party.name}</span>
                              <span className="dcx-sign-who">
                                <span className="dcx-party-av">{rec ? identityInitials(rec) : (name || party.name).slice(0, 1).toUpperCase()}</span>
                                <span className="dcx-sign-name">{name || 'Not assigned yet'}</span>
                              </span>
                              {rep && <span className="dcx-sign-rep">prin {rep}{cap ? `, ${cap}` : ''}</span>}
                              <span className="dcx-sign-line" aria-hidden="true" />
                              <span className="dcx-sign-foot">
                                {linked ? 'Follows the party' : 'Not linked'} · open party
                              </span>
                            </button>
                          ))}
                        </div>
                      </div>
                    );
                  })()}

                  {!isPlain && pieces.filter(({ fields }) => {
                    // In the signature section the cards above stand for every
                    // line that only names a party. What stays as a row is what
                    // they don't cover — a date, a place, a witness.
                    if (!isSignatureTitle(sec.title) || !parties.length) return true;
                    const roles = new Set(parties.map((pt) => pt.role || ''));
                    return fields.some((f) => !(f.key && roles.has(f.role || '')));
                  }).map(({ pc, k, text, fields, missing, isParty, rec, num }) => {
                    const isOpen = open === pc.id;
                    const party = isParty ? parties.find((pt) => pt.roleKey === (pc.party || '_')) : null;
                    const edited = edits[pc.id] !== undefined;
                    const variant = variantsFor(sec, k);
                    const roleKey = pc.party || '_';
                    const prompt = prompts[pc.id] || '';
                    const canAsk = !!prompt.trim() && !aiBusy[pc.id];
                    // A party has no blanks column: it is filled from its identity
                    // record, and what the clause mentions is set by the pills.
                    const showBlanks = fields.length > 0 && !isParty;

                    let chips;
                    const previewRec = isParty && Object.keys(preview).length
                      ? records.find((r) => preview.__rec === (r.id || r._path || r.name) && preview.__role === roleKey)
                      : null;
                    if (previewRec) chips = [{ text: previewRec.name || previewRec.legalName, kind: 'filled is-preview' }];
                    else if (isParty && rec) chips = [{ text: rec.name || rec.legalName, kind: 'filled' }];
                    else if (isParty && missing.length) chips = [{ text: `${roleLabel(pc.party)} · not assigned`, kind: 'blank' }];
                    else if (fields.length) chips = fields.map((f) => (val(f.id).trim() ? { text: val(f.id), kind: 'filled' } : { text: f.label, kind: 'blank' }));
                    else if (edited) chips = [{ text: 'wording changed', kind: 'note is-accent' }];
                    else chips = [{ text: 'standard wording', kind: 'note' }];

                    return (
                      <div
                        className={`dcx-piece${isOpen ? ' is-open' : ''}${pc.depth ? ' is-sub' : ''}${party ? ' is-party' : ''}`}
                        style={pc.depth ? { '--dcx-depth': Math.min(pc.depth, 3) } : undefined}
                        data-piece={pc.id}
                        key={pc.id}
                      >
                        {party && (() => {
                          // A party is a person or a company, not a sentence —
                          // so it is shown as one: who it is, which identity
                          // record it is tied to, and how complete it is.
                          const shownRec = previewRec || rec;
                          const typedName = val(partyFieldId(party, 'legalName')).trim();
                          const name = (shownRec && (shownRec.name || shownRec.legalName)) || typedName;
                          const filled = fields.length - missing.length;
                          return (
                            <button
                              type="button"
                              className={`dcx-party${shownRec ? ' is-linked' : ''}${previewRec ? ' is-preview' : ''}`}
                              aria-expanded={isOpen}
                              onClick={() => patch(() => ({ open: isOpen ? null : pc.id }))}
                            >
                              <span className="dcx-party-av">
                                {shownRec ? identityInitials(shownRec) : (name || party.name).slice(0, 1).toUpperCase()}
                              </span>
                              <span className="dcx-party-text">
                                <span className="dcx-party-role">
                                  {num && <span className="dcx-piece-num">{num}</span>}
                                  {party.name}
                                </span>
                                <span className={`dcx-party-name${name ? '' : ' is-empty'}`}>{name || 'No one assigned yet'}</span>
                                <span className="dcx-party-meta">
                                  {shownRec
                                    ? [shownRec.kind === 'org' ? 'Organisation' : 'Individual', identitySummary(shownRec)].filter(Boolean).join(' · ')
                                    : `${filled} of ${fields.length} details filled in`}
                                </span>
                              </span>
                              <span className={`dcx-party-state${shownRec ? ' is-on' : ''}`}>
                                {shownRec ? 'Identity record' : (missing.length ? 'Choose an identity' : 'Filled in by hand')}
                              </span>
                              <span className="dcx-chev">{ChevGlyph}</span>
                            </button>
                          );
                        })()}
                        {!party && (
                        <button
                          type="button"
                          className="dcx-piece-row"
                          aria-expanded={isOpen}
                          onClick={() => patch(() => ({ open: isOpen ? null : pc.id }))}
                        >
                          <span className="dcx-piece-label">
                            {num && <span className="dcx-piece-num">{num}</span>}
                            {/* The clause in full — filled values in place, open
                                blanks named in brackets. Never cut short: the
                                row grows to fit. */}
                            <span className="dcx-piece-text">
                              {pc.wholeLabel
                                ? (fillText(text, values, { keep: false }).replace(/\*\*|__|`/g, '').trim() || pc.label)
                                : pc.label}
                            </span>
                          </span>
                          <span className="dcx-chips">
                            {chips.map((c, ci) => <span className={`dcx-chip is-${c.kind}`} key={ci}>{c.text}</span>)}
                          </span>
                          <span className="dcx-chev">{ChevGlyph}</span>
                        </button>
                        )}

                        {isOpen && (
                          <div className="dcx-piece-body">
                            {/* What this party's clause mentions. Each pill is an
                                optional detail: on, the clause carries it; off,
                                it is cut from the sentence. Which pills there
                                are depends on whether the party is a person or
                                a company. */}
                            {party && (
                              <div className="dcx-optional">
                                <span className="dcx-collabel">Optional details in this clause</span>
                                <div className="dcx-optional-pills">
                                  {optionalPartsFor(text, pc.party, rec ? (rec.kind === 'org' ? 'org' : 'person') : clauseKind(fields)).map((part) => (
                                    <button
                                      type="button"
                                      key={part.id}
                                      role="switch"
                                      aria-checked={part.on}
                                      className={`dcx-pill${part.on ? ' is-on' : ''}`}
                                      onClick={() => toggleOptional(pc, pc.party, part.id, !part.on, rec)}
                                    >
                                      <span className="dcx-pill-mark" aria-hidden="true">{part.on ? CheckGlyph : null}</span>
                                      {part.label}
                                    </button>
                                  ))}
                                </div>
                              </div>
                            )}
                            {!party && (
                            <div className="dcx-col">
                              <span className="dcx-collabel">Text in the document</span>
                              {variant && (
                                <div className="dcx-variants">
                                  <span className="dcx-variants-label">{variant.label} ·</span>
                                  {variant.options.map((o) => (
                                    <button
                                      type="button"
                                      key={o.label}
                                      className={`dcx-variant${text.trim() === o.text ? ' is-on' : ''}`}
                                      onClick={() => patch((d) => ({ edits: { ...d.edits, [pc.id]: o.text } }))}
                                    >
                                      {o.label}
                                    </button>
                                  ))}
                                </div>
                              )}
                              <textarea
                                className="dcx-textarea"
                                rows={5}
                                value={fillText(text, values)}
                                onChange={(e) => patch((d) => ({ edits: { ...d.edits, [pc.id]: e.target.value } }))}
                              />
                              <div className="dcx-askrow">
                                <div className="dcx-ask">
                                  <span className="dcx-ask-glyph">{SparkGlyph}</span>
                                  <input
                                    value={prompt}
                                    disabled={!onAskAi}
                                    placeholder="Ask the AI to change this piece: “shorten”, “more formal”, “add a 30-day term”…"
                                    onChange={(e) => setPrompts((m) => ({ ...m, [pc.id]: e.target.value }))}
                                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); askAi(pc); } }}
                                  />
                                  <button type="button" className={`dcx-ask-go${canAsk ? ' is-ready' : ''}`} disabled={!canAsk} onClick={() => askAi(pc)}>
                                    {aiBusy[pc.id] ? 'Rewriting…' : 'Ask AI'}
                                  </button>
                                </div>
                                {edited && (
                                  <button
                                    type="button"
                                    className="dcx-reset"
                                    onClick={() => patch((d) => { const e = { ...d.edits }; delete e[pc.id]; return { edits: e }; })}
                                  >
                                    Revert to original
                                  </button>
                                )}
                              </div>
                              {aiErr[pc.id] && <p className="dcx-note is-error" role="alert">{aiErr[pc.id]}</p>}
                            </div>
                            )}

                            {isParty && (
                              <div className="dcx-col">
                                <span className="dcx-collabel dcx-collabel--split">
                                  Identities
                                  <span className="dcx-collabel-sub">{records.length} record{records.length === 1 ? '' : 's'} in this project</span>
                                </span>
                                {/* What ties this party to the identity feature:
                                    open the record it is filled from, let go of
                                    it, or turn what was typed here into one. */}
                                {party && (
                                  <div className="dcx-party-actions">
                                    {rec && onOpenIdentity && (
                                      <button type="button" className="dcx-sign-btn" onClick={() => onOpenIdentity(rec)}>Open record</button>
                                    )}
                                    {rec && (
                                      <button type="button" className="dcx-sign-btn" onClick={() => unlink(party)}>Unlink</button>
                                    )}
                                    {!rec && onCreateIdentity && identityFromValues(party, values) && (
                                      <Tooltip content="Save these details as an identity record, so the next document fills from it">
                                        <button
                                          type="button"
                                          className="dcx-sign-btn"
                                          disabled={!identityFromValues(party, values) || !!creating[party.roleKey]}
                                          onClick={() => saveAsIdentity(party)}
                                        >
                                          {creating[party.roleKey] ? 'Saving…' : 'Save as identity'}
                                        </button>
                                      </Tooltip>
                                    )}
                                  </div>
                                )}
                                {records.length === 0 && (
                                  <p className="dcx-note">No identity records in this project yet. Add one from the Files tab — Create → Identity, or right-click a document → Create identity.</p>
                                )}
                                {records.map((r) => {
                                  const rid = r.id || r._path || r.name;
                                  const on = assigned[roleKey] === rid;
                                  return (
                                    <button
                                      type="button"
                                      key={rid}
                                      className={`dcx-identity${on ? ' is-on' : ''}`}
                                      onClick={() => assign(pc.party, r)}
                                      onMouseEnter={() => setPreview({ ...valuesFromRecord(model, pc.party, r), __rec: rid, __role: roleKey })}
                                      onMouseLeave={() => setPreview({})}
                                    >
                                      <span className="dcx-identity-av">{identityInitials(r)}</span>
                                      <span className="dcx-identity-text">
                                        <span className="dcx-identity-name">{r.name || r.legalName}</span>
                                        <span className="dcx-identity-meta">
                                          {[r.kind === 'org' ? 'Organisation' : 'Individual', identitySummary(r), r._fileName].filter(Boolean).join(' · ')}
                                        </span>
                                      </span>
                                      <span className="dcx-identity-mark">{CheckGlyph}</span>
                                    </button>
                                  );
                                })}
                              </div>
                            )}

                            {showBlanks && (
                              <div className="dcx-col">
                                <span className="dcx-collabel">Blanks to fill in</span>
                                {fields.map((f) => {
                                  const suggs = suggestionsFor(f, records, values[f.id] || '');
                                  return (
                                    <div className="dcx-blank" key={f.id}>
                                      <span className="dcx-blank-label">{f.role ? `${f.label} · ${roleLabel(f.role)}` : f.label}</span>
                                      <input
                                        value={values[f.id] || ''}
                                        placeholder="Type it in…"
                                        onChange={(e) => patch((d) => ({ values: { ...d.values, [f.id]: e.target.value } }))}
                                      />
                                      {suggs.length > 0 && (
                                        <div className="dcx-suggs">
                                          {suggs.map((sg) => (
                                            <Tooltip content={sg.file ? `From ${sg.file}` : 'From an identity record'} key={sg.value}>
                                              <button
                                                type="button"
                                                className="dcx-sugg"
                                                onClick={() => patch((d) => ({ values: { ...d.values, [f.id]: sg.value } }))}
                                              >
                                                {sg.value}
                                              </button>
                                            </Tooltip>
                                          ))}
                                        </div>
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}
