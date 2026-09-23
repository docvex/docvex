import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { identityInitials, identitySummary, identityValueForField } from '../lib/identities';
import Tooltip from './Tooltip';
import {
  fieldsOf, roleLabel, valuesFromRecord, parseSegs, settleClauseFor,
  partiesOf, identityFromValues,
  withEdits, fieldInfo, fillText, pieceDisplayText, clauseKind,
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

// ── A colour per PERSON ────────────────────────────────────────────────────
// A clause that identifies two people — a seller and a buyer, an employer and
// an employee — has its blanks interleaved, and which gap belongs to whom is
// read off the prose around it. Where the paragraph names MORE THAN ONE person,
// each blank is tinted by the one it answers to, so a glance is enough.
//
// PERSON, not party. A company is named together with the human being who signs
// for it — "SC X SRL, reprezentată legal prin Y, în calitate de administrator"
// — and that representative is a second person in the clause but NOT a second
// party: `representative` and `repCapacity` are fields of the company's own
// role. Grouping by role alone left exactly that clause, the commonest one
// there is, with a single colour and nothing to tell the two people apart.
//
// The colour comes from the role's own name, so a party keeps it between
// paragraphs and between documents — positional colours would swap over as soon
// as a clause named its parties the other way round. Same djb2 + 12-colour
// scheme the app uses for avatars and project accents.
// Which language the DOCUMENT is written in. Romanian is settled by its own
// letters and, failing those (a short clause can be written without one), by
// the words a contract cannot avoid. Only ever asked about the words shown
// inside the document — the panel around it is English.
const RO_LETTERS = /[\u0103\u00E2\u00EE\u0219\u021B\u0102\u00C2\u00CE\u0218\u021A]/;
const RO_WORDS = /\b(?:si|sau|care|dintre|prin|catre|potrivit|conform|prezentul|prezenta|domiciliat|domiciliul|sediul|denumit|denumita|partile|contract|obliga|nascut|cetatenie|judetul|localitatea|strada|numarul)\b/i;
function documentLanguage(model, piece) {
  const bits = [];
  if (piece?.text) bits.push(piece.text);
  for (const sec of model?.sections || []) {
    if (sec.title) bits.push(sec.title);
    for (const pc of sec.pieces) {
      bits.push(pc.text);
      if (bits.join(' ').length > 4000) break;
    }
  }
  const sample = bits.join('\n');
  if (RO_LETTERS.test(sample)) return 'ro';
  // Diacritics are often dropped when typing; the words are not.
  return RO_WORDS.test(sample) ? 'ro' : 'en';
}

// The fields that belong to the person REPRESENTING a party rather than to the
// party itself (lib/identities: both are `only: 'org'`).
const REP_KEYS = new Set(['representative', 'repCapacity']);
const REP_MARK = '\u0000rep';
const personKeyOf = (f) => (f?.role ? `${f.role}${REP_KEYS.has(f.key) ? REP_MARK : ''}` : '');

// SIX colours, each a genuinely different colour — not twelve shades of six.
// The avatar palette this started from has three violets within 20° of each
// other, two greens 2° apart and two pinks 2° apart, so two people could be
// given "different" colours nobody could tell apart. These were CHOSEN by
// measurement rather than by eye: no two are less than 43° apart on the hue
// circle, and each clears 4.5:1 contrast against a white page, so the tint can
// answer "whose gap is this?" at a glance — which a colour that could be either
// does not.
const PARTY_PALETTE = [
  '#9F1239', // crimson  343°
  '#0369A1', // blue     201°
  '#854D0E', // ochre     32°
  '#4338CA', // indigo   245°
  '#15803D', // green    142°
  '#86198F', // magenta  295°
];
function partyColor(role) {
  const seed = String(role || '');
  if (!seed) return null;
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) { h = ((h << 5) - h) + seed.charCodeAt(i); h |= 0; }
  return PARTY_PALETTE[Math.abs(h) % PARTY_PALETTE.length];
}

// The colours for ONE paragraph's people. A hash over a handful of colours
// puts two of them on the same one sooner than intuition suggests — with seven
// colours and four people it is better than even odds — and in a clause about
// both, one colour for two people is worse than no colour at all. So within a
// paragraph no colour is used twice: the first person to ask keeps the colour
// their name gives them (which is what makes it stable from paragraph to
// paragraph), and anyone who lands on a taken one walks to the next free entry.
// The palette is ordered so that walk lands on a distant hue, not a neighbour.
function partyColors(keys) {
  const out = new Map();
  const taken = new Set();
  for (const r of keys) {
    let c = partyColor(r);
    if (!c) continue;
    if (taken.has(c)) {
      const from = PARTY_PALETTE.indexOf(c);
      for (let i = 1; i <= PARTY_PALETTE.length; i += 1) {
        const next = PARTY_PALETTE[(from + i) % PARTY_PALETTE.length];
        if (!taken.has(next)) { c = next; break; }
      }
    }
    // More people than colours — no clause has seven parties, but if one ever
    // does the last of them share rather than go untinted.
    taken.add(c);
    out.set(r, c);
  }
  return out;
}

export default function DocParagraphConstructor({
  model,
  section,          // the section the picked paragraph belongs to
  piece,            // …and the piece it is
  draft: draftProp,
  setDraft,
  baseValues = null,
  records = [],
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
  // …with ONE exception: the placeholder sitting inside a blank is not the
  // panel talking, it is the DOCUMENT saying what it still wants, and English
  // words in the middle of a Romanian clause read as a mistake in the contract.
  // So that one string follows the document. Nothing else does: the panel is
  // app chrome and stays English, which is what keeps it from getting stuck in
  // a language with no switch to leave it by.
  const docLang = useMemo(() => (documentLanguage(model, piece) === 'ro' ? 'ro' : 'en'), [model, piece]);

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
      // Picking a record fills the party's blanks wherever in the document they
      // are — and SETTLES THE PICKED CLAUSE against what the record says. A
      // clause is written to cover every case at once, and a record answers
      // some of them outright: a house has no block, stair, floor or flat, so
      // those blanks are not gaps left empty but words the paragraph should not
      // be carrying, and each goes together with the label that introduces it
      // (", bl. ___" disappears whole). Agreement follows the party's gender,
      // and "județul/sectorul" settles to whichever Romania gives that address.
      //
      // Only the PICKED paragraph is rewritten: it is the one on screen, and a
      // change you cannot see is not one you can check. The rest of the
      // document keeps the drafter's wording and is filled in as before.
      const filled = valuesFromRecord(withEdits(model, d.edits), role, rec);
      let edits = d.edits;
      if (piece) {
        const now = edits[piece.id] !== undefined ? edits[piece.id] : piece.text;
        const settled = settleClauseFor(now, role, rec);
        if (settled !== now) edits = { ...edits, [piece.id]: settled };
      }
      return {
        values: { ...d.values, ...filled },
        edits,
        assigned: { ...d.assigned, [roleKey]: rec.id || rec._path || rec.name },
        custom: nextCustom,
      };
    });
    setPreview({});
  };

  // What a record says for one of a person's blanks.
  //
  // A REPRESENTATIVE's row is filled by the record OF THAT PERSON, and the
  // blank naming them is the company's `representative` field — which a person
  // record has nothing under, because it is not a fact about them. So that
  // blank takes the record's own NAME. Without this, hovering or picking any
  // record on a representative's row did nothing at all: every value it looked
  // for was empty, which is why the preview appeared to work for some rows and
  // not others. (`repCapacity` is a capacity in THIS contract, not a property
  // of the person, so it is filled only when the record actually carries one.)
  const recordValueFor = (rec, key, isRep) => (
    isRep && key === 'representative'
      ? identityValueForField(rec, 'legalName')
      : identityValueForField(rec, key)
  );

  // Fill ONE person's blanks from a record. Used for a clause whose blanks name
  // nobody (a document DocVex did not write): there is no role to fill BY, so
  // the entity's own fields are written one at a time, which is also what keeps
  // the other entity in the same clause untouched.
  const assignPerson = (personKey, recOrNull) => {
    const isRep = personKey.endsWith(REP_MARK);
    patch((d) => {
      const next = { ...d.values };
      for (const f of fields) {
        if (!f.key || peopleOf.get(f.id) !== personKey) continue;
        if (!recOrNull) { next[f.id] = ''; continue; }
        const v = recordValueFor(recOrNull, f.key, isRep);
        if (v) next[f.id] = v;
      }
      const assignedNext = { ...d.assigned };
      if (recOrNull) assignedNext[personKey] = ridOf(recOrNull); else delete assignedNext[personKey];
      return { values: next, assigned: assignedNext };
    });
    setPreview({});
  };
  // What that person's blanks would read as — for the hover preview, which is
  // how you tell two records apart without committing to one.
  const previewPerson = (personKey, recOrNull) => {
    if (!recOrNull) { setPreview({}); return; }
    const isRep = personKey.endsWith(REP_MARK);
    const out = {};
    for (const f of fields) {
      if (!f.key || peopleOf.get(f.id) !== personKey) continue;
      const v = recordValueFor(recOrNull, f.key, isRep);
      if (v) out[f.id] = v;
    }
    setPreview(out);
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
  // Who each blank answers to, as a map from the blank to a person.
  //
  // When the document NAMES its parties ("[[vanzator.legalName]]") the role is
  // the answer, and a representative's fields make their own person under it.
  //
  // A document DocVex did not write names nothing: its blanks resolve to a bare
  // field key ("addressBlock", "regNo") with no role at all, which left an
  // identification clause listing a person AND a company — the commonest thing
  // such a clause does — with no colour whatever. There they are told apart by
  // REPETITION: one entity cannot have two names, two CNPs or two registered
  // offices, so a field key appearing a second time is the clause moving on to
  // the next entity. Read in document order, which is the order they are named.
  const fieldsSig = fields.map((f) => f.id).join('|');
  const peopleOf = useMemo(() => {
    const map = new Map();
    if (fields.some((f) => f.key && f.role)) {
      for (const f of fields) if (f.key) map.set(f.id, personKeyOf(f));
      return map;
    }
    let n = 0;
    let seen = new Set();
    for (const f of fields) {
      if (!f.key) continue;
      if (REP_KEYS.has(f.key)) { map.set(f.id, `e${n}${REP_MARK}`); continue; }
      if (seen.has(f.key)) { n += 1; seen = new Set(); }
      seen.add(f.key);
      map.set(f.id, `e${n}`);
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fieldsSig]);
  const peopleKeys = [...new Set([...peopleOf.values()])].filter(Boolean);
  const multiParty = peopleKeys.length > 1;
  // What each person IS, read off the blanks the clause gives them: a CUI, a
  // trade-register number or a legal form can only belong to a company; a CNP
  // or an identity document to a human being. A representative is always a
  // person — that is the whole reason a company has one.
  const kindOf = (key) => {
    if (key.endsWith(REP_MARK)) return 'person';
    const own = fields.filter((f) => f.key && peopleOf.get(f.id) === key);
    return clauseKind(own) || 'person';
  };
  // What to call a person in the legend. A role says it outright ("Vanzator").
  // An entity the document never named is called by whatever has been filled in
  // as its name — which is the whole point of the colour, so it is worth
  // showing — and until then by where it stands in the clause.
  const legendName = (key, i) => {
    if (!/^e\d+$/.test(key)) return roleLabel(key);
    const named = fields.find((f) => peopleOf.get(f.id) === key
      && ['legalName', 'lastName', 'firstName'].includes(f.key)
      && String(values[f.id] || '').trim());
    return named ? String(values[named.id]).trim() : `${t.party || 'Party'} ${i + 1}`;
  };
  const partyTints = useMemo(() => partyColors(peopleKeys), [peopleKeys.join('|')]); // eslint-disable-line react-hooks/exhaustive-deps
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

  // The widest each slot has needed so far, in `ch`. A slot GROWS to hold what
  // it is given and never shrinks back: hovering one record after another, or
  // typing into a blank, used to re-size the field under the cursor and re-wrap
  // the clause around it, so the sentence moved while it was being read. Kept
  // per paragraph — the ratchet is about holding one clause still, not about
  // the document, and it starts again at the next one.
  const widthRef = useRef(new Map());
  useEffect(() => { widthRef.current = new Map(); }, [piece?.id]);

  // One blank, as an input. `style` carries the bold / italic of the source
  // when the paragraph is rebuilt from it; in the rich copy the input simply
  // inherits the run it sits in.
  // An EMPTY blank carries WHAT IT WANTS as placeholder text, when the document
  // says: "[[vanzator.legalName]]" and "[Client name]" both explain themselves,
  // so the explanation is shown in the slot rather than being reachable only by
  // hovering. A blank that explains NOTHING — a bare "_____", which the parser
  // can only call `blank1` — has no placeholder, because its own name would be
  // noise.
  //
  // The slot keeps the width the document drew for it (`blankChars`: the
  // underscores of the viewer's marker, less the input's own 8px of padding +
  // margin), so picking a paragraph doesn't re-wrap it — a long explanation is
  // ellipsized rather than allowed to push the line. The full text is still on
  // hover, and to a screen reader.
  const renderInput = (fieldId, key, style, blankChars = 0) => {
    const f = infoOf(fieldId);
    const shown = versionPreview
      ? (versionPreview.values?.[fieldId] || '')
      : (preview[fieldId] !== undefined ? preview[fieldId] : (values[fieldId] || ''));
    const hint = labelOf(f);
    // A positional name is the parser counting gaps, not the document speaking.
    const explains = !/^blank\d+$/i.test(String(fieldId || '').trim());
    const ghost = explains ? fieldLabelIn(f, docLang) : '';
    // Only where telling them apart is the problem: one party needs no key.
    const tint = multiParty ? (partyTints.get(peopleOf.get(fieldId)) || null) : null;
    // An EMPTY slot is as wide as the document drew it OR as wide as what it
    // asks for, whichever is larger, so the placeholder is read rather than
    // clipped. Widening is safe HERE and only here: this input lives in the
    // paragraph's preview copy, which is laid out of flow over the real one
    // (`.dv-docx-livecard`), so its wrapping is its own and the page's is
    // untouched. The CHIP in the unpicked document still may not grow — the
    // sheets were paginated before the blanks were marked, and they clip.
    // Italic runs a little wider than the upright `ch` it is measured in, so
    // the allowance is 2 rather than the 1.5 a value gets.
    const ghostCh = ghost ? ghost.length + 2 : 0;
    const valueCh = String(shown) ? String(shown).length + 1.5 : 0;
    // The high-water mark: what this slot has ever had to hold. Reading it here
    // is a max of things already known, so it is the same on every render of
    // the same state.
    const held = Math.max(widthRef.current.get(fieldId) || 0, ghostCh, valueCh, 4);
    widthRef.current.set(fieldId, held);
    // …and the slot the document drew is a FLOOR, not a competitor: a blank
    // printed wide stays wide even when what goes in it is short.
    const width = blankChars ? `max(calc(${blankChars}ch - 8px), ${held}ch)` : `${held}ch`;
    const tip = f.role && f.key ? `${hint} · ${roleLabel(f.role)}` : hint;
    return (
      <Tooltip key={key} content={tip}>
        <input
          className={`dcx-inline${String(shown).trim() ? ' is-filled' : ''}${versionPreview || preview[fieldId] !== undefined ? ' is-preview' : ''}${tint ? ' is-party' : ''}`}
          readOnly={!!versionPreview}
          style={{ ...(style || {}), width, ...(tint ? { '--dcx-party': tint } : null) }}
          value={shown}
          placeholder={ghost}
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
  const hasOptions = !!party || !!saveError || multiParty;

  const canSaveIdentity = !!ownParty && !rec && !!onCreateIdentity && !!identityFromValues(ownParty, values);
  // The options — the identity records that fill the party, and the notes that
  // go with them. They are shown UNDER THE PARAGRAPH they fill, in the pane's
  // dock: the record being picked and the clause it rewrites are one thing to
  // look at, and the dock rides the camera with the paragraph. `optionsSlot`
  // portals them somewhere else instead (the side panel, above its composer —
  // the advisor's `ctorSlot`); the pane passes none. There is no prompt field
  // here either way: asking the AI about the paragraph is the side panel's
  // composer, which is aimed at the picked paragraph.
  const optionsEl = hasOptions ? (
      <div className={`dcx-para${optionsSlot ? ' is-docked' : ''}`}>
        {/* Named whichever side it is on: docked under the paragraph it is the
            only label the panel has, and a grid of records with nothing over it
            reads as part of the document rather than as a choice to make. */}
        <h3 className="dcx-dock-title">{t.autofill || 'Autofill'}</h3>
        {(<>
        {/* No title, no counter, no frame — just the options. (Leaving the
            paragraph is what writes its changes, so there is no Save either.) */}
        {saveError && <p className="dcx-note is-error" role="alert">{saveError}</p>}

        {/* ── One entry per person the clause names ──────────────────────
            A clause that identifies two people needs two choices, not one, and
            each has to say WHOSE it is — so every person the paragraph names
            gets a row of their own: their colour (the same tint their blanks
            carry, which is what ties the choice to the gaps it fills), what
            they are, and the records to fill them from, listed downwards.
            Shown only where there is more than one; a single party keeps the
            grid below, which is the same choice without the ceremony. */}
        {multiParty && (
          <div className="dcx-people">
            {peopleKeys.map((k, i) => {
              const isRep = k.endsWith(REP_MARK);
              const base = isRep ? k.slice(0, -REP_MARK.length) : k;
              const kind = kindOf(k);
              const chosen = assigned[k];
              return (
                <section className="dcx-person" key={k} style={{ '--dcx-party': partyTints.get(k) }}>
                  <header className="dcx-person-head">
                    <span className="dcx-person-dot" aria-hidden="true" />
                    <span className="dcx-person-name">{legendName(base, i)}</span>
                    <span className="dcx-person-kind">
                      {kind === 'org' ? 'Persoană juridică' : 'Persoană fizică'}
                      {isRep && ` · ${fieldLabelIn({ key: 'representative', label: 'Representative' }, lang)}`}
                    </span>
                  </header>
                  <ul className="dcx-person-list">
                    <li>
                      <button
                        type="button"
                        className={`dcx-person-opt is-custom${chosen ? '' : ' is-on'}`}
                        onClick={() => { if (chosen) assignPerson(k, null); }}
                        onMouseLeave={() => setPreview({})}
                      >
                        <span className="dcx-person-av">{PenGlyph}</span>
                        <span className="dcx-person-text">{t.custom}</span>
                        <span className="dcx-person-mark">{CheckGlyph}</span>
                      </button>
                    </li>
                    {records.map((r) => {
                      const rid = ridOf(r);
                      return (
                        <li key={rid}>
                          <button
                            type="button"
                            className={`dcx-person-opt${chosen === rid ? ' is-on' : ''}`}
                            onClick={() => assignPerson(k, r)}
                            onMouseEnter={() => previewPerson(k, r)}
                            onMouseLeave={() => setPreview({})}
                          >
                            <span className="dcx-person-av">{identityInitials(r)}</span>
                            <span className="dcx-person-text">
                              <span className="dcx-person-rec">{r.legalName || r.name}</span>
                              <span className="dcx-person-meta">{identitySummary(r)}</span>
                            </span>
                            <span className="dcx-person-mark">{CheckGlyph}</span>
                          </button>
                        </li>
                      );
                    })}
                    {records.length === 0 && <li className="dcx-person-none">{t.noRecords}</li>}
                  </ul>
                </section>
              );
            })}
          </div>
        )}

        <div className="dcx-para-body">
          {/* The single-party grid is the SAME choice the list above already
              offers, so it is shown only when there is no list: a clause that
              identifies a company AND its representative sets both `ownParty`
              and more than one person, and used to draw the cards underneath
              the rows that had just replaced them. */}
          {party && !multiParty && (
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
