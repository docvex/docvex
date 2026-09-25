// The CAEN letter picker's logic (src/lib/caenPicker.js), under plain Node:
//   npm test
// The module is bundled first (it is a Vite-style .js module), the same way
// scripts/legal-feed-run.mjs runs the portal code.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let m;
let tree;
let reduce;

before(async () => {
  const out = path.join(os.tmpdir(), `docvex-caen-picker-${process.pid}.mjs`);
  await build({
    entryPoints: [path.join(root, 'src/lib/caenPicker.js')],
    outfile: out, format: 'esm', platform: 'node', bundle: true, logLevel: 'silent',
  });
  m = await import(pathToFileURL(out).href);
  const data = JSON.parse(readFileSync(path.join(root, 'src/lib/caenRev3.json'), 'utf8'));
  tree = m.pickerTree(data);
  reduce = m.makePickerReducer(tree);
});

const keys = (state, ...ks) => ks.reduce((s, k) => reduce(s, m.keyToAction(k)), state);
const codes = (list) => list.map((o) => o.code);

test('the tree: 22 sections, each level in code order, every class under a group', () => {
  assert.equal(tree.sections.length, 22);
  assert.deepEqual(codes(tree.sections).slice(0, 3), ['A', 'B', 'C']);
  const divisions = m.stageOptions(tree, ['A']);
  assert.deepEqual(codes(divisions), ['01', '02', '03']);
  assert.ok(divisions.every((d) => d.level === 'd'));
  const groups = m.stageOptions(tree, ['A', '01']);
  assert.ok(groups.length > 0 && groups.every((g) => g.level === 'g' && g.code.startsWith('01')));
  const classes = m.stageOptions(tree, ['A', '01', '011']);
  assert.ok(classes.length > 0 && classes.every((c) => c.level === 'c' && c.code.startsWith('011')));
  // Rev. 3 moved IT services under K (J is publishing and broadcasting).
  assert.deepEqual(m.ancestorsOf(tree, '6210'), ['K', '62', '621']);
  assert.deepEqual(m.stageOptions(tree, []), tree.sections);
  assert.deepEqual(m.stageOptions(tree, ['nope']), []);
  // What the column shows: the part each level adds — C · 10 · 1 · 1 spells 1011.
  assert.deepEqual(['C', '10', '101', '1011'].map((c) => m.codeTail(tree.entry[c])), ['C', '10', '1', '1']);
  assert.equal(m.codeTail(null), '');
});

test('stages: Enter steps into the entry, Backspace steps back onto it', () => {
  let s = m.initialPickerState();
  assert.deepEqual([s.path, s.index], [[], 0]);
  // A → its divisions; 01 → its groups; the first group → its classes.
  s = keys(s, 'Enter');
  assert.deepEqual(s.path, ['A']);
  assert.deepEqual(codes(m.stageOptions(tree, s.path)), ['01', '02', '03']);
  s = keys(s, 'ArrowDown', 'Enter');
  assert.deepEqual(s.path, ['A', '02']);
  s = keys(s, 'Enter');
  assert.equal(s.path.length, 3);
  assert.ok(m.stageOptions(tree, s.path).every((c) => c.level === 'c'));
  // Enter on a class enters nothing — it is picked, which is the view's job.
  const before = s;
  s = keys(s, 'Enter');
  assert.deepEqual(s.path, before.path);
  // Back a stage lands the cursor on the entry just left.
  s = keys(s, 'Backspace');
  assert.deepEqual(s.path, ['A', '02']);
  assert.equal(m.stageOptions(tree, s.path)[s.index].code, before.path[2]);
  s = keys(s, 'ArrowLeft');
  assert.deepEqual(s.path, ['A']);
  assert.equal(m.stageOptions(tree, s.path)[s.index].code, '02');
  s = keys(s, 'ArrowLeft', 'ArrowLeft');
  assert.deepEqual(s.path, []);
  assert.equal(tree.sections[s.index].code, 'A');
  // A stage passed, pressed: back to it, the cursor on what was chosen there.
  s = keys(m.initialPickerState(), 'ArrowDown', 'Enter', 'ArrowDown', 'Enter', 'Enter'); // B › 06 › its first group
  assert.equal(s.path.length, 3);
  const deep = s;
  s = reduce(s, { type: 'jump', depth: 1 });                // press "06"
  assert.deepEqual(s.path, ['B']);
  assert.equal(m.stageOptions(tree, s.path)[s.index].code, deep.path[1]);
  s = reduce(deep, { type: 'jump', depth: 0 });             // press "B"
  assert.deepEqual(s.path, []);
  assert.equal(tree.sections[s.index].code, 'B');
  assert.equal(reduce(deep, { type: 'jump', depth: 3 }), deep); // the live stage is not a button
});

test('→ is a stage forward, like Enter; a class is not entered', () => {
  let s = keys(m.initialPickerState(), 'ArrowRight');      // into A
  assert.deepEqual(s.path, ['A']);
  s = keys(s, 'ArrowRight', 'ArrowRight');                  // into 01, into its first group
  assert.deepEqual(s.path, ['A', '01', tree.children['01'][0].code]);
  const atClasses = s;
  assert.deepEqual(keys(s, 'ArrowRight'), atClasses);       // a class: → stays (Space picks)
  s = keys(s, 'ArrowLeft', 'ArrowLeft', 'ArrowLeft');
  assert.deepEqual(s.path, []);
});

test('the entries to the right: reached by focus, ↑/↓ run along them, ← is back to the column, → / Enter step into one', () => {
  let s = keys(m.initialPickerState(), 'Enter');           // in A: 01 02 03
  s = reduce(s, { type: 'focus', focus: 'list' });          // Tab / a click into 01's groups
  assert.deepEqual([s.focus, s.row], ['list', 0]);
  const groups = tree.children['01'];
  s = keys(s, ...Array(groups.length + 3).fill('ArrowDown'));
  assert.equal(s.row, groups.length - 1);                   // clamped
  s = keys(s, ...Array(groups.length + 3).fill('ArrowUp'));
  assert.deepEqual([s.focus, s.row], ['list', 0]);
  s = keys(s, 'ArrowDown', 'ArrowLeft');                    // ← from anywhere in the list: the column
  assert.deepEqual([s.focus, s.path], ['col', ['A']]);
  s = reduce(s, { type: 'row', row: 1 });                   // a click on the second group
  s = keys(s, 'Enter');
  assert.deepEqual(s.path, ['A', '01', groups[1].code]);
  assert.equal(s.focus, 'col');
  // → in the list steps into the selected one too; on a class it stays.
  // (Two stages back: the list beside the cursor holds what the HIGHLIGHTED
  // entry contains — back at A with 01 under the cursor, that is its groups.)
  s = reduce(keys(s, 'Backspace', 'Backspace'), { type: 'row', row: 0 });
  s = keys(s, 'ArrowRight');
  assert.deepEqual(s.path, ['A', '01', groups[0].code]);
  s = reduce(s, { type: 'focus', focus: 'list' });          // the classes of that group
  assert.deepEqual(keys(s, 'ArrowRight').path, s.path);
});

test('typing "62" on the keyboard lands in division 62 and lists its groups', () => {
  let s = keys(m.initialPickerState(), '6', '2');
  assert.deepEqual(s.path, ['K', '62']);
  const groups = m.stageOptions(tree, s.path);
  assert.ok(groups.length > 0);
  assert.ok(groups.every((g) => g.level === 'g' && g.code.startsWith('62')));
  // On to a class: "6210" puts the cursor ON the class (a class is picked, not entered).
  s = keys(s, '1', '0');
  assert.deepEqual(s.path, ['K', '62', '621']);
  assert.equal(m.stageOptions(tree, s.path)[s.index].code, '6210');
  // A letter is a section, from anywhere.
  s = keys(s, 'f');
  assert.deepEqual(s.path, []);
  assert.equal(tree.sections[s.index].code, 'F');
  // A lone digit at the divisions moves the cursor to the first one starting with it.
  s = keys(s, 'Enter', '4');
  assert.deepEqual(s.path, ['F']);
  assert.ok(m.stageOptions(tree, s.path)[s.index].code.startsWith('4'));
  // The digits typed here stay in the buffer: with "4" typed, "9" spells
  // division 49 (transport by land), wherever that is.
  assert.deepEqual(keys(s, '9').path, ['H', '49']);
  // A sequence no code begins with ("00") changes nothing.
  const t = keys(s, '0', '0');
  assert.deepEqual([t.path, t.index], [s.path, s.index]);
});

test('a step back remembers the way: the previews keep it and forward lands on it', () => {
  // Down to a class, the cursor moved off the first entry at each stage.
  let s = keys(m.initialPickerState(), 'ArrowDown', 'Enter', 'ArrowDown', 'Enter', 'ArrowDown', 'Enter', 'ArrowDown', 'ArrowDown');
  const deep = { path: s.path, code: m.stageOptions(tree, s.path)[s.index].code };
  assert.equal(deep.path.length, 3);
  // Back one: the previews centre on the class the cursor was on…
  s = keys(s, 'Backspace');
  let chain = m.previewChain(tree, s);
  assert.equal(chain.length, 1);
  assert.equal(chain[0].list[chain[0].sel].code, deep.code);
  // …and forward lands the cursor on it again.
  s = keys(s, 'Enter');
  assert.deepEqual(s.path, deep.path);
  assert.equal(m.stageOptions(tree, s.path)[s.index].code, deep.code);
  // Back two (a jump): both remembered, in order.
  s = reduce(s, { type: 'jump', depth: 1 });
  chain = m.previewChain(tree, s);
  assert.equal(chain.length, 2);
  assert.equal(chain[0].list[chain[0].sel].code, deep.path[2]);
  assert.equal(chain[1].list[chain[1].sel].code, deep.code);
  s = keys(s, 'Enter', 'Enter');
  assert.equal(m.stageOptions(tree, s.path)[s.index].code, deep.code);
  // Moving the cursor elsewhere before going forward: the memory does not
  // apply there (different children), and the previews start at the first.
  s = keys(s, 'Backspace', 'ArrowUp');
  chain = m.previewChain(tree, s);
  assert.equal(chain[0].sel, 0);
  s = keys(s, 'Enter');
  assert.equal(s.index, 0);
});

test('goto: a code anywhere — an ancestor passed keeps the memory, another is walked to fresh', () => {
  let s = keys(m.initialPickerState(), 'ArrowDown', 'Enter', 'Enter', 'ArrowDown');  // B › 05 › its 2nd group
  const deep = s;
  s = reduce(s, { type: 'goto', code: 'B' });                // an ancestor: like pressing its pill
  assert.deepEqual(s.path, []);
  assert.equal(tree.sections[s.index].code, 'B');
  assert.ok(s.ahead.length >= 2);                            // the way down remembered
  s = reduce(deep, { type: 'goto', code: '6210' });          // elsewhere: fresh
  assert.deepEqual(s.path, ['K', '62', '621']);
  assert.equal(m.stageOptions(tree, s.path)[s.index].code, '6210');
  assert.deepEqual(s.ahead, []);
  assert.deepEqual(reduce(deep, { type: 'goto', code: 'nope' }), deep);
});

test('a stage with a single entry is entered straight through', () => {
  // A division with one group, and a group with one class — the
  // nomenclature has several of each; find one of the first kind.
  const div = Object.values(tree.entry).find((e) => e.level === 'd' && (tree.children[e.code] || []).length === 1);
  assert.ok(div, 'a division with a single group');
  const group = tree.children[div.code][0];
  const [section] = m.ancestorsOf(tree, div.code);
  let s = reduce(m.initialPickerState(), { type: 'goto', code: div.code });
  assert.deepEqual(s.path, [section]);
  s = keys(s, 'Enter');                                     // into the division…
  // …and, its one group being no choice, into the group too: the cursor is
  // on the group's classes (or, were there one class only, on that class).
  assert.ok(s.path.length >= 2 && s.path[1] === div.code);
  assert.equal(s.path[2], group.code);
  const opts = m.stageOptions(tree, s.path);
  assert.ok(opts.length > 1 || opts[0].level === 'c');
  // Backspace steps back one stage at a time, as ever.
  s = keys(s, 'Backspace');
  assert.deepEqual(s.path, [section, div.code]);
});

test('the key map: arrows, Enter, Backspace, letters and digits; nothing else', () => {
  assert.deepEqual(m.keyToAction('ArrowUp'), { type: 'up' });
  assert.deepEqual(m.keyToAction('Backspace'), { type: 'backspace' });
  assert.deepEqual(m.keyToAction('7'), { type: 'type', ch: '7' });
  assert.deepEqual(m.keyToAction('q'), { type: 'type', ch: 'q' });
  assert.equal(m.keyToAction(' '), null);
  assert.equal(m.keyToAction('Escape'), null);
});
