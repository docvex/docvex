// The CAEN "letter picker" — the pure half (pages/CaenPicker.jsx is the view).
//
// A search screen in the manner of the PS3 PlayStation Store's letter picker,
// walking the nomenclature's OWN structure in stages: a column of the sections
// (A…V), then the divisions of the chosen section (01, 02…), then its groups
// (011…), then its classes (0111…) — the code is built one level at a time,
// and what has been chosen stands to the left of the column. Everything a
// test can reach is here — the tree, the stages and the keyboard model — with
// no DOM in it, so `npm test` runs it under plain Node
// (tests/caenPicker.test.mjs).

/** The pause between a stage change and its answers (ms). Deliberate — the
 *  original does this — and one number so it can be tuned. */
export const LOAD_DELAY_MS = 380;

export const LEVEL_RO = { s: 'Sectiune', d: 'Diviziune', g: 'Grupa', c: 'Clasa' };
export const LEVEL_RO_PLURAL = { s: 'sectiuni', d: 'diviziuni', g: 'grupe', c: 'clase' };

/** The nomenclature as a tree: `{ sections, children: { code: [entry] }, parent: { code }, entry: { code } }`,
 *  an entry being `{ code, name, level }` (level s | d | g | c), lists in code order. */
export function pickerTree(data) {
  const items = data?.items || {};
  const entry = {};
  const children = {};
  const parent = {};
  for (const [code, it] of Object.entries(items)) {
    entry[code] = { code, name: it.n, level: it.l };
    if (it.p) {
      parent[code] = it.p;
      (children[it.p] ||= []).push(entry[code]);
    }
  }
  const byCode = (a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0);
  for (const list of Object.values(children)) list.sort(byCode);
  const sections = (data?.sections || []).map((s) => entry[s]).filter(Boolean).sort(byCode);
  return { sections, children, parent, entry };
}

/** The column's entries for a path: the sections, or the children of the last code chosen. */
export function stageOptions(tree, path) {
  if (!path.length) return tree.sections;
  return tree.children[path[path.length - 1]] || [];
}

/** What an entry ADDS to the code, which is what the column shows: a section
 *  its letter, a division its two digits (a section letter is not part of the
 *  code), a group and a class the one digit each puts on the end. Read left to
 *  right, the stages then spell the code: C · 10 · 1 · 1 → 1011. */
export function codeTail(entry) {
  if (!entry) return '';
  if (entry.level === 'g') return entry.code.slice(2);
  if (entry.level === 'c') return entry.code.slice(3);
  return entry.code;
}

/** A code's ancestors, top first (a class's: its section, division, group). */
export function ancestorsOf(tree, code) {
  const out = [];
  for (let p = tree.parent[code]; p; p = tree.parent[p]) out.unshift(p);
  return out;
}

// ── The keyboard model ────────────────────────────────────────────────────
// `{ path, index, focus, row, typed }`: the codes chosen so far (the stages
// passed), the cursor in the column, which list has the keys — `col` (the
// column) or `list` (the answers to its right, the highlighted entry's
// children) — the answer selected, and the digits typed at this stage.
//   ↑ ↓      in the column: the cursor; in the answers (a vertical list
//            too): along them
//   Enter    step INTO the highlighted entry (a class is picked instead —
//            the view's job); in the answers, into the selected one
//   ← / ⌫    in the column: a stage back, the cursor on the entry left;
//            in the answers: back to the column
//   →        in the column: a stage FORWARD — into the highlighted entry, as
//            Enter does (a class stays, it is picked); in the answers: into
//            the selected one. The answers are reached by Tab or a click
//            (`focus`).
//   a key    a letter finds a section; digits find a division / group /
//            class by its code from ANY stage ("62" lands in division 62)
// `ahead` is the MEMORY of the stages beyond the current one: going back
// records the entry the cursor was on, so the previews keep centring on it
// and going forward again lands on it — a step back does not lose the way.
export const initialPickerState = () => ({ path: [], index: 0, focus: 'col', row: 0, typed: '', ahead: [] });

/** The levels ahead of the cursor, as the previews show them: for each,
 *  `{ list, sel }` — the entries, and which is centred (the remembered one
 *  when it is among them, else the first). */
export function previewChain(tree, state) {
  const out = [];
  const opts = stageOptions(tree, state.path);
  let node = opts[Math.min(state.index, Math.max(0, opts.length - 1))];
  const ahead = state.ahead || [];
  for (let d = 0; node; d += 1) {
    const list = tree.children[node.code] || [];
    if (!list.length) break;
    const sel = Math.max(0, list.findIndex((o) => o.code === ahead[d]));
    out.push({ list, sel });
    node = list[sel];
  }
  return out;
}

/** The reducer, bound to a tree. */
export function makePickerReducer(tree) {
  const clampIndex = (path, i) => Math.min(Math.max(0, stageOptions(tree, path).length - 1), Math.max(0, i));
  // Every beginning of a division / group / class code — what typed digits
  // are kept as long as they are one of.
  const prefixes = new Set();
  for (const code of Object.keys(tree.entry)) {
    if (tree.entry[code].level === 's') continue;
    for (let i = 1; i <= code.length; i += 1) prefixes.add(code.slice(0, i));
  }
  // Into an entry: the cursor lands on the remembered choice there, if any.
  // A stage with a SINGLE entry is no choice — it is entered too, straight
  // through, until a stage offers more than one or the single one is a
  // class (which then stands under the cursor, to be picked).
  const into = (state, code) => {
    let path = [...state.path, code];
    let ahead = state.ahead || [];
    for (;;) {
      const opts = stageOptions(tree, path);
      if (opts.length !== 1 || opts[0].level === 'c') break;
      path = [...path, opts[0].code];
      ahead = ahead[0] === opts[0].code ? ahead.slice(1) : [];
    }
    const i = stageOptions(tree, path).findIndex((o) => o.code === ahead[0]);
    return { path, index: Math.max(0, i), focus: 'col', row: 0, typed: '', ahead: i >= 0 ? ahead.slice(1) : [] };
  };
  const highlighted = (state) => stageOptions(tree, state.path)[clampIndex(state.path, state.index)];

  const kidsOf = (state) => { const opt = highlighted(state); return opt ? tree.children[opt.code] || [] : []; };
  const clampRow = (state, r) => Math.min(Math.max(0, kidsOf(state).length - 1), Math.max(0, r));
  // Into the selected answer (from the list): the highlighted entry, then it.
  const intoRow = (state) => {
    const opt = highlighted(state);
    const child = kidsOf(state)[state.row];
    if (!opt || !child || child.level === 'c') return state;
    return into(into(state, opt.code), child.code);
  };

  return function pickerReducer(state, action) {
    const inList = state.focus === 'list';
    switch (action.type) {
      case 'up':
        if (inList) return { ...state, row: clampRow(state, state.row - 1) };
        return { ...state, index: clampIndex(state.path, state.index - 1), focus: 'col', typed: '' };
      case 'down':
        if (inList) return { ...state, row: clampRow(state, state.row + 1) };
        return { ...state, index: clampIndex(state.path, state.index + 1), focus: 'col', typed: '' };
      case 'char': return { ...state, index: clampIndex(state.path, action.index), focus: 'col', typed: '' };
      case 'enter': {
        if (inList) return intoRow(state);
        const opt = highlighted(state);
        return opt && opt.level !== 'c' ? into(state, opt.code) : state;
      }
      case 'backspace': return back(state);
      case 'left': return inList ? { ...state, focus: 'col' } : back(state);
      case 'right': {
        if (inList) return intoRow(state);
        const opt = highlighted(state);
        return opt && opt.level !== 'c' ? into(state, opt.code) : state;
      }
      case 'type': return typeChar(state, String(action.ch || '').toUpperCase());
      case 'focus': return { ...state, focus: action.focus === 'list' ? 'list' : 'col' };
      // A click on one of the entries to the right: select it there.
      case 'row': return { ...state, focus: 'list', row: Math.max(0, Number(action.row) || 0) };
      // To a code, wherever it is: a stage already passed is gone back to
      // (its memory kept); anything else is walked to fresh — the path its
      // ancestors, the cursor on it.
      case 'goto': {
        const code = String(action.code || '');
        const at = state.path.indexOf(code);
        if (at >= 0) return pickerReducer(state, { type: 'jump', depth: at });
        if (!tree.entry[code]) return state;
        const path = ancestorsOf(tree, code);
        const index = Math.max(0, stageOptions(tree, path).findIndex((o) => o.code === code));
        return { path, index, focus: 'col', row: 0, typed: '', ahead: [] };
      }
      // A click on a stage passed ("A", "01"): back to it, the cursor on the
      // code that was chosen there.
      case 'jump': {
        const depth = Math.min(state.path.length, Math.max(0, Number(action.depth) || 0));
        if (depth === state.path.length) return state;
        const path = state.path.slice(0, depth);
        const index = Math.max(0, stageOptions(tree, path).findIndex((o) => o.code === state.path[depth]));
        // Remembered: the stages between, and the entry the cursor was on.
        const here = highlighted(state);
        const ahead = [...state.path.slice(depth + 1), ...(here ? [here.code] : []), ...(state.ahead || [])];
        return { path, index, focus: 'col', row: 0, typed: '', ahead };
      }
      default: return state;
    }
  };

  function back(state) {
    if (!state.path.length) return { ...state, focus: 'col', typed: '' };
    const path = state.path.slice(0, -1);
    const gone = state.path[state.path.length - 1];
    const index = Math.max(0, stageOptions(tree, path).findIndex((o) => o.code === gone));
    // Remembered: the entry the cursor was on at the stage being left.
    const here = highlighted(state);
    const ahead = [...(here ? [here.code] : []), ...(state.ahead || [])];
    return { path, index, focus: 'col', row: 0, typed: '', ahead };
  }

  // A letter: the section. Digits: the code they spell, at whatever stage —
  // a division / group / class code is unique across the whole nomenclature,
  // so "62" can be typed from the sections and lands in division 62 (the
  // column then shows its groups); a class lands the cursor ON it, since a
  // class is picked, not entered. Digits short of a code move the cursor at
  // the current stage to the first entry whose code continues with them.
  function typeChar(state, ch) {
    if (/^[A-Z]$/.test(ch)) {
      const i = tree.sections.findIndex((s) => s.code === ch);
      if (i < 0) return { ...state, typed: '' };
      return { path: [], index: i, focus: 'col', row: 0, typed: '', ahead: [] };
    }
    if (!/^\d$/.test(ch)) return state;
    const attempt = (typed) => {
      const hit = tree.entry[typed];
      if (hit && hit.level !== 's') {
        const anc = ancestorsOf(tree, typed);
        if (hit.level === 'c') {
          const index = Math.max(0, stageOptions(tree, anc).findIndex((o) => o.code === typed));
          return { path: anc, index, focus: 'col', row: 0, typed, ahead: [] };
        }
        return { path: [...anc, typed], index: 0, focus: 'col', row: 0, typed, ahead: [] };
      }
      const opts = stageOptions(tree, state.path);
      const parentCode = state.path[state.path.length - 1] || '';
      const tail = (o) => (o.level === 'd' ? o.code : o.code.slice(parentCode.length));
      const i = opts.findIndex((o) => tail(o).startsWith(typed));
      if (i >= 0) return { ...state, index: i, focus: 'col', typed };
      // Nothing here starts with it, but a code somewhere does ("6" at the
      // sections): kept, for the digit that completes it.
      return prefixes.has(typed) ? { ...state, typed } : null;
    };
    return attempt(state.typed + ch) || attempt(ch) || { ...state, typed: '' };
  }
}

/** A KeyboardEvent's `key` → the action it means, or null. Space is not here:
 *  it picks, which the view does (as does Enter on a class). */
export function keyToAction(key) {
  switch (key) {
    case 'ArrowUp': return { type: 'up' };
    case 'ArrowDown': return { type: 'down' };
    case 'ArrowLeft': return { type: 'left' };
    case 'ArrowRight': return { type: 'right' };
    case 'Enter': return { type: 'enter' };
    case 'Backspace': return { type: 'backspace' };
    default: return /^[0-9a-zA-Z]$/.test(key) ? { type: 'type', ch: key } : null;
  }
}
