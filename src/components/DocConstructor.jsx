import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { identityInitials, identitySummary } from '../lib/identities';
import Tooltip from './Tooltip';
import {
  fieldsOf, roleLabel, valuesFromRecord, parseSegs,
  partiesOf, identityFromValues,
  withEdits, fieldInfo, fillText, pieceDisplayText,
} from '../lib/docConstructor';
import { constructorStrings, fieldLabelIn } from './docConstructorStrings';
import './DocConstructor.css';

// The Constructor, for ONE paragraph.
//
// Picking a paragraph in the Word preview zooms in on it (DocxRenderPane). If
// the paragraph carries data, this component is what makes it fillable, in two
// places at once:
//
//   • IN THE PARAGRAPH — every blank of the clause becomes an inline INPUT,
//     right where it stands in the sentence, so you type the value into the
//     text you are reading. It is rendered through a portal into the preview
//     copy the pane lays over the real paragraph (`previewEl`), in the run
//     formatting the paragraph had (`runStyle`).
//   • IN THE SIDE PANEL, above its composer (`optionsSlot`; under the paragraph
//     only when there is no panel to go to) — the project's identity records. Hovering
//     one shows the clause with that party in it; picking one fills the party
//     everywhere, rewrites its clause in the person or company formula, and
//     settles gender, county-vs-sector and house-vs-flat. "Custom" lets go of
//     the record again.
//
// A paragraph with none of that has no panel at all — it is just text, and
// stays editable in place.
//
// It edits a DRAFT held by the workspace on top of the document's source, and
// reports what the paragraph now reads as (`onLive`), which the pane writes into
// the document on the way out. Saving is the workspace's job: the Save button
// here closes the paragraph, and closing is what saves. It never touches the
// file.

const PenGlyph = (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </svg>
);
const CheckGlyph = (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

const EMPTY_DRAFT = { edits: {}, values: {}, assigned: {}, open: null, collapsed: {}, custom: {} };

export default function DocParagraphConstructor({
  model,
  section,          // the section the picked paragraph belongs to
  piece,            // …and the piece it is
  draft: draftProp,
  setDraft,
  baseValues = null,
  records = [],
  foreign = false,
  saveError = null,
  onLive,
  onCreateIdentity,
  previewEl = null,   // the pane's preview copy of the paragraph — the portal target
  runStyle = null,    // { css, size } — the run formatting the paragraph had
  versionPreview = null, // { text, values } — a saved version being hovered: shown, not applied
  optionsSlot = null,    // where the options go: the side panel's slot above its composer (else: under the paragraph)
  originalHtml = '',     // the real paragraph's markup, as the Word preview rendered it
}) {
  const draft = draftProp || EMPTY_DRAFT;
  const { edits, values, assigned } = draft;
  const patch = useCallback((fn) => setDraft?.((d) => ({ ...(d || EMPTY_DRAFT), ...fn(d || EMPTY_DRAFT) })), [setDraft]);

  // English or Romanian — the Constructor's own labels only, never the
  // document's words. Remembered across documents and windows.
  // English throughout — the labels, the placeholders in the paragraph's inputs
  // and the panel's own wording. (The Romanian set and the EN / RO switch that
  // chose between them are gone; a choice left over from it must not leave the
  // panel stuck in Romanian with no way back.)
  const lang = 'en';
  const t = constructorStrings(lang);
  const labelOf = (f) => fieldLabelIn(f, lang);

  // The parties the document identifies. They get their own rendering — a card
  // tied to an identity record rather than a clause row. Read off the document
  // AS EDITED: a clause rewritten for a company has a representative the draft
  // never mentioned.
  const parties = useMemo(() => partiesOf(withEdits(model, draftProp?.edits)), [model, draftProp?.edits]);
  const ridOf = (r) => r.id || r._path || r.name;
  const [creating, setCreating] = useState({});
  // Hovering a record shows its values in the chips before anything is chosen.
  const [preview, setPreview] = useState({});

  const textOf = useCallback((pc) => (edits[pc.id] !== undefined ? edits[pc.id] : pc.text), [edits]);

  // What the picked paragraph reads as right now — hovered record included, so
  // pointing at an identity shows the clause with that party in it. Null while
  // it still reads exactly as the file does, which tells the preview to leave
  // the rendered paragraph alone.
  const liveText = useMemo(() => {
    if (!piece) return null;
    const merged = { ...values };
    for (const [k, v] of Object.entries(preview)) if (!k.startsWith('__')) merged[k] = v;
    const now = pieceDisplayText(piece, fillText(textOf(piece), merged));
    const base = pieceDisplayText(piece, fillText(piece.text, baseValues || {}));
    return now === base ? null : now;
  }, [piece, values, preview, textOf, baseValues]);
  useEffect(() => { onLive?.(liveText); }, [liveText, onLive]);
  useEffect(() => () => onLive?.(null), [onLive]);

  // What a party holds as CUSTOM data: the details typed by hand, set aside
  // when a record is picked so that Custom can show them again — on hover as a
  // preview, on click for good. A detail never typed is blank.
  const customValuesFor = (party, d) => {
    const kept = d.custom?.[party.roleKey] || {};
    return Object.fromEntries(party.fields.map((f) => [f.id, kept[f.id] || '']));
  };

  const assign = (role, rec) => {
    patch((d) => {
      const roleKey = role || '_';
      let nextCustom = d.custom || {};
      if (!d.assigned[roleKey]) {
        const party = parties.find((pt) => pt.roleKey === roleKey);
        if (party) {
          nextCustom = {
            ...nextCustom,
            [roleKey]: Object.fromEntries(party.fields.map((f) => [f.id, d.values[f.id] || ''])),
          };
        }
      }
      // Picking a record FILLS IN DATA and nothing else: the record's values go
      // into the party's blanks, wherever in the document they are. The wording
      // is not touched — the clause is not rewritten into a person or company
      // formula, no phrase is added or dropped, no agreement is settled. What
      // the paragraph says stays what the drafter wrote (changing it is what the
      // AI prompt under the paragraph is for).
      const filled = valuesFromRecord(withEdits(model, d.edits), role, rec);
      return {
        values: { ...d.values, ...filled },
        assigned: { ...d.assigned, [roleKey]: rec.id || rec._path || rec.name },
        custom: nextCustom,
      };
    });
    setPreview({});
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
  // Back to Custom: let go of the record and put the hand-typed details back.
  const selectCustom = (party) => {
    patch((d) => {
      const next = { ...d.assigned };
      delete next[party.roleKey];
      return { assigned: next, values: { ...d.values, ...customValuesFor(party, d) } };
    });
    setPreview({});
  };

  // ── What this paragraph needs ───────────────────────────────────────────
  const text = piece ? textOf(piece) : '';
  // An edited piece may have lost (or gained) blanks — read them off what it
  // says now, not what it said when the document was parsed.
  const fields = !piece ? [] : (edits[piece.id] !== undefined ? fieldsOf(text) : piece.fields);
  const ownParty = piece ? (parties.find((pt) => pt.pieceId === piece.id) || null) : null;
  // Whose records to offer: the party this clause identifies, or — for a
  // paragraph that merely mentions ONE party's details — that party.
  const roles = [...new Set(fields.filter((f) => f.key).map((f) => f.role || ''))];
  const party = ownParty || (roles.length === 1 ? (parties.find((pt) => (pt.role || '') === roles[0]) || null) : null);
  const role = party ? party.role : null;
  const rec = party ? (records.find((r) => ridOf(r) === assigned[party.roleKey]) || null) : null;

  // ── The paragraph, with its blanks as inputs ───────────────────────────
  // The clause is walked once, left to right: `**` / `__` toggle bold, a single
  // `*` italic, and `[[…]]` is a blank — so a name the drafter wrote in bold
  // (`**[[seller.legalName]]**`) is a bold input, and the emphasis either side
  // of a blank survives being cut around it.
  const tokens = useMemo(() => {
    const out = [];
    // A hovered version shows ITS wording; the draft is untouched underneath.
    const src = pieceDisplayText(piece, versionPreview ? versionPreview.text : text);
    const re = /(\*\*|__)|(\*)|\[\[([^[\]]+?)\]\]|`/g;
    let bold = false;
    let italic = false;
    let last = 0;
    let m;
    const push = (str) => { if (str) out.push({ text: str, bold, italic }); };
    while ((m = re.exec(src))) {
      push(src.slice(last, m.index));
      last = m.index + m[0].length;
      if (m[1]) bold = !bold;
      else if (m[2]) italic = !italic;
      else if (m[3]) out.push({ field: m[3].trim(), bold, italic });
    }
    push(src.slice(last));
    return out;
  }, [piece, text, versionPreview]);

  // `typed` marks the draft as holding something the user WROTE. Picking a
  // suggested identity doesn't set it — that is an answer being chosen, not a
  // change being made, and it doesn't earn the paragraph a new version circle.
  const setValue = (id, value) => patch((d) => ({ values: { ...d.values, [id]: value }, typed: true }));
  const infoOf = (id) => fields.find((f) => f.id === id) || fieldInfo(id);

  // One blank, as an input. `style` carries the bold / italic of the source
  // when the paragraph is rebuilt from it; in the rich copy the input simply
  // inherits the run it sits in.
  // An EMPTY blank is just the slot — no placeholder words in it — and is as
  // wide as the slot the document drew for it (`blankChars`: the underscores of
  // the viewer's marker, less the input's own 8px of padding + margin), so
  // picking a paragraph doesn't re-wrap it. What the blank wants is said on
  // hover (and to a screen reader) instead.
  const renderInput = (fieldId, key, style, blankChars = 0) => {
    const f = infoOf(fieldId);
    const shown = versionPreview
      ? (versionPreview.values?.[fieldId] || '')
      : (preview[fieldId] !== undefined ? preview[fieldId] : (values[fieldId] || ''));
    const hint = labelOf(f);
    const width = String(shown)
      ? `${Math.max(4, String(shown).length + 1.5)}ch`
      : (blankChars ? `calc(${blankChars}ch - 8px)` : `${Math.max(4, hint.length + 1.5)}ch`);
    const tip = f.role && f.key ? `${hint} · ${roleLabel(f.role)}` : hint;
    return (
      <Tooltip key={key} content={tip}>
        <input
          className={`dcx-inline${String(shown).trim() ? ' is-filled' : ''}${versionPreview || preview[fieldId] !== undefined ? ' is-preview' : ''}`}
          readOnly={!!versionPreview}
          style={{ ...(style || {}), width }}
          value={shown}
          aria-label={tip}
          spellCheck={false}
          onChange={(e) => setValue(fieldId, e.target.value)}
        />
      </Tooltip>
    );
  };

  // ── Two ways to show the paragraph ─────────────────────────────────────
  // RICH: the paragraph exactly as the Word preview rendered it — every run's
  // own font, size, colour, underline, tab — with only its blanks swapped for
  // inputs. This is what is shown for as long as the clause's WORDING is what
  // the file has (values may differ: they live in the inputs). The real
  // paragraph's markup is copied, each blank is found in it — an unfilled one is
  // the marker span the viewer wrapped it in, a filled one is its saved value in
  // the text — and an empty mount is left in its place for an input.
  //
  // REBUILT: from the source text, for a clause whose wording has changed (an AI
  // rewrite, an identity that switched the clause to the company formula, an
  // older version's wording). There is no rendered markup for words that were
  // never in the file, so it is set in the paragraph's main run formatting.
  //
  // Both live inside the preview copy, in a host each; only one is displayed.
  const [hosts, setHosts] = useState(null);
  useLayoutEffect(() => {
    if (!previewEl) { setHosts(null); return; }
    const doc = previewEl.ownerDocument;
    const rich = doc.createElement('span');
    const rebuilt = doc.createElement('span');
    previewEl.replaceChildren(rich, rebuilt);
    setHosts({ rich, rebuilt });
  }, [previewEl]);

  const [mounts, setMounts] = useState(null); // [{ id, el, key }] — null when the rich copy can't be made
  useLayoutEffect(() => {
    if (!hosts || !piece) { setMounts(null); return; }
    const { rich } = hosts;
    rich.innerHTML = originalHtml || '';
    if (!originalHtml) { setMounts(null); return; }
    const doc = rich.ownerDocument;
    // Each blank with the few characters of wording that lead up to it: a saved
    // value is found in the text by what it says, and a short one ("12", "B")
    // could just as well be part of a clause number — so the match that also
    // has the right words in front of it is preferred.
    const wanted = [];
    let lead = '';
    for (const sg of parseSegs(piece.text)) {
      if (sg.field) { wanted.push({ id: sg.field, lead: lead.replace(/[*_`]/g, '').slice(-8) }); lead = ''; }
      else lead = sg.text || '';
    }
    const made = [];
    const mountFor = (id, blank = 0) => {
      const el = doc.createElement('span');
      el.className = 'dcx-mount';
      made.push({ id, el, key: `${id}:${made.length}`, blank });
      return el;
    };
    // Walked in document order, one blank at a time, never looking back — so a
    // value that occurs twice is matched to the right blank each time.
    const walker = doc.createTreeWalker(rich, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    let from = 0;
    let ok = true;
    for (const { id, lead: before } of wanted) {
      const raw = `[[${id}]]`;
      const saved = String(baseValues?.[id] ?? '').trim();
      let placed = false;
      while (node && !placed) {
        const marker = node.parentElement?.closest?.('.dv-field');
        if (marker && rich.contains(marker)) {
          // An unfilled blank: the viewer's marker span, still holding the token.
          const after = (() => { let n = walker.nextNode(); while (n && marker.contains(n)) n = walker.nextNode(); return n; })();
          if ((marker.dataset.dvfieldRaw || marker.textContent || '').trim() === raw) {
            marker.replaceWith(mountFor(id, (marker.dataset.label || '').length));
            placed = true;
          }
          node = after; from = 0;
          continue;
        }
        const needle = saved || raw;
        const withLead = before ? node.data.indexOf(before + needle, from) : -1;
        const at = withLead >= 0 ? withLead + before.length : node.data.indexOf(needle, from);
        if (at >= 0) {
          const tail = node.splitText(at);
          tail.data = tail.data.slice(needle.length);
          tail.before(mountFor(id));
          walker.currentNode = tail;
          node = tail; from = 0;
          placed = true;
        } else {
          node = walker.nextNode(); from = 0;
        }
      }
      if (!placed) { ok = false; break; }
    }
    if (!ok) { rich.innerHTML = ''; setMounts(null); return; }
    setMounts(made);
  }, [hosts, originalHtml, piece, baseValues]);

  const wordingNow = versionPreview ? versionPreview.text : text;
  const showRich = !!hosts && !!mounts && !!piece && wordingNow === piece.text;
  useLayoutEffect(() => {
    if (!hosts) return;
    hosts.rich.style.display = showRich ? '' : 'none';
    hosts.rebuilt.style.display = showRich ? 'none' : '';
  }, [hosts, showRich]);
  // Either view can wrap to a different height — let the pane re-place what
  // hangs under the paragraph.
  useEffect(() => { onLive?.(liveText); }, [showRich, mounts]); // eslint-disable-line react-hooks/exhaustive-deps

  const paragraph = hosts ? (
    <>
      {(mounts || []).map((m) => createPortal(renderInput(m.id, m.key, undefined, m.blank), m.el, m.key))}
      {createPortal(
        <span ref={(n) => { if (n) n.style.cssText = runStyle?.css || ''; }}>
          {tokens.map((tk, i) => {
            const style = { fontWeight: tk.bold ? 700 : undefined, fontStyle: tk.italic ? 'italic' : undefined };
            if (tk.field == null) {
              // eslint-disable-next-line react/no-array-index-key
              return <span key={i} style={tk.bold || tk.italic ? style : undefined}>{tk.text}</span>;
            }
            return renderInput(tk.field, `${tk.field}:${i}`, style);
          })}
        </span>,
        hosts.rebuilt,
      )}
    </>
  ) : null;

  if (!piece) return null;
  const hasOptions = !!party || !!saveError || foreign;

  const canSaveIdentity = !!ownParty && !rec && !!onCreateIdentity && !!identityFromValues(ownParty, values);
  // The options — the identity records that fill the party, and the notes that
  // go with them. They are shown in the SIDE PANEL, above its message composer
  // (`optionsSlot`, handed down by the pane from the advisor), so the paragraph
  // on the page carries nothing under it; with no slot to go to (the panel is
  // hidden) they fall back to the pane's dock under the paragraph. There is no
  // prompt field here any more: asking the AI about the paragraph is the side
  // panel's composer, which is aimed at the picked paragraph.
  const optionsEl = hasOptions ? (
      <div className={`dcx-para${optionsSlot ? ' is-docked' : ''}`}>
        {optionsSlot && <h3 className="dcx-dock-title">{t.autofill || 'Autofill'}</h3>}
        {(<>
        {/* No title, no counter, no frame — just the options. (Leaving the
            paragraph is what writes its changes, so there is no Save either.) */}
        {saveError && <p className="dcx-note is-error" role="alert">{saveError}</p>}
        {foreign && <p className="dcx-note">{t.foreignNote}</p>}

        <div className="dcx-para-body">
          {party && (
            <div className="dcx-idgrid">
              {/* Always first: the party typed in by hand — what a party is until
                  a record is picked. Hovering it shows the hand-typed details in
                  the paragraph, as hovering a record shows the record's; picking
                  it lets go of the record and puts them back. */}
              <button
                type="button"
                className={`dcx-identity is-custom${rec ? '' : ' is-on'}`}
                onClick={() => { if (rec) selectCustom(party); }}
                onMouseEnter={() => { if (rec) setPreview({ ...customValuesFor(party, draft), __custom: party.roleKey }); }}
                onMouseLeave={() => setPreview({})}
              >
                <span className="dcx-identity-av">{PenGlyph}</span>
                <span className="dcx-identity-text">
                  <span className="dcx-identity-name">{t.custom}</span>
                  <span className="dcx-identity-meta">{t.customMeta}</span>
                </span>
                <span className="dcx-identity-mark">{CheckGlyph}</span>
              </button>
              {records.map((r) => {
                const rid = ridOf(r);
                return (
                  <button
                    type="button"
                    key={rid}
                    className={`dcx-identity${assigned[party.roleKey] === rid ? ' is-on' : ''}`}
                    onClick={() => assign(role, r)}
                    onMouseEnter={() => setPreview({ ...valuesFromRecord(model, role, r), __rec: rid, __role: party.roleKey })}
                    onMouseLeave={() => setPreview({})}
                  >
                    <span className="dcx-identity-av">{identityInitials(r)}</span>
                    <span className="dcx-identity-text">
                      <span className="dcx-identity-name">{r.name || r.legalName}</span>
                      <span className="dcx-identity-meta">
                        {[r.kind === 'org' ? t.organisation : t.individual, identitySummary(r)].filter(Boolean).join(' · ')}
                      </span>
                    </span>
                    <span className="dcx-identity-mark">{CheckGlyph}</span>
                  </button>
                );
              })}
              {/* Custom details can become an identity record of their own. */}
              {canSaveIdentity && (
                <button
                  type="button"
                  className="dcx-identity is-action"
                  disabled={!!creating[ownParty.roleKey]}
                  onClick={() => saveAsIdentity(ownParty)}
                >
                  <span className="dcx-identity-av">+</span>
                  <span className="dcx-identity-text">
                    <span className="dcx-identity-name">{creating[ownParty.roleKey] ? t.saving : t.saveAsIdentity}</span>
                    <span className="dcx-identity-meta">{t.saveAsIdentityTip}</span>
                  </span>
                </button>
              )}
            </div>
          )}
          {party && records.length === 0 && <p className="dcx-note">{t.noRecords}</p>}
        </div>
        </>)}
      </div>
  ) : null;
  return (
    <>
      {paragraph}
      {optionsSlot ? (optionsEl && createPortal(optionsEl, optionsSlot)) : optionsEl}
    </>
  );
}
