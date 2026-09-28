// The pseudonymisation vault + Layer 1 detector (src/lib/pseudonymize), under
// plain Node:   npm test
// Bundled first (Vite-style modules), as the other suites are.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let Vault; let detectLayer1; let ibanValid; let makeLayer2; let knownEntitiesFrom; let maskBody; let makeStreamReidentifier;
let bodyText; let detectLayer3; let recordSent; let getSentLog; let clearSentLog;

before(async () => {
  const entry = path.join(os.tmpdir(), `docvex-pseudo-entry-${process.pid}.js`);
  writeFileSync(entry, [
    `export { Vault, normalizeValue } from ${JSON.stringify(path.join(root, 'src/lib/pseudonymize/vault.js'))};`,
    `export { detectLayer1, ibanValid } from ${JSON.stringify(path.join(root, 'src/lib/pseudonymize/detectorLayer1.js'))};`,
    `export { makeLayer2, knownEntitiesFrom } from ${JSON.stringify(path.join(root, 'src/lib/pseudonymize/detectorLayer2.js'))};`,
    `export { maskBody, makeStreamReidentifier, bodyText } from ${JSON.stringify(path.join(root, 'src/lib/pseudonymize/wire.js'))};`,
    `export { detectLayer3 } from ${JSON.stringify(path.join(root, 'src/lib/pseudonymize/detectorLayer3.js'))};`,
    `export { recordSent, getSentLog, clearSentLog } from ${JSON.stringify(path.join(root, 'src/lib/pseudonymize/sentLog.js'))};`,
  ].join('\n'));
  const out = path.join(os.tmpdir(), `docvex-pseudo-${process.pid}.mjs`);
  await build({ entryPoints: [entry], outfile: out, format: 'esm', platform: 'node', bundle: true, logLevel: 'silent' });
  ({ Vault, detectLayer1, ibanValid, makeLayer2, knownEntitiesFrom, maskBody, makeStreamReidentifier, bodyText, detectLayer3, recordSent, getSentLog, clearSentLog } = await import(pathToFileURL(out).href));
});

// ── Valid identifiers, made rather than typed ───────────────────────────
const cnpWith = (first12) => {
  const key = [2, 7, 9, 1, 4, 6, 3, 5, 8, 2, 7, 9];
  const sum = first12.split('').reduce((n, d, i) => n + Number(d) * key[i], 0) % 11;
  return first12 + (sum === 10 ? 1 : sum);
};
const cuiWith = (body) => {
  const key = [7, 5, 3, 2, 1, 7, 5, 3, 2];
  const digits = body.padStart(9, '0').split('').map(Number);
  const c = (digits.reduce((n, d, i) => n + d * key[i], 0) * 10) % 11;
  return body + (c === 10 ? 0 : c);
};
const CNP_ANA = cnpWith('285031213001');    // F, 1985-03-12, Cluj
const CNP_ION = cnpWith('176112440012');    // M, 1976-11-24, Bucharest
const CUI_ALFA = cuiWith('1854729');
const IBAN = 'RO49AAAA1B31007593840000';

// ── The three documents ──────────────────────────────────────────────────
const ID_CARD = `ROMANIA  CARTE DE IDENTITATE
SERIA CJ NR 482915
CNP ${CNP_ANA}
Nume/Nom/Last name POPESCU
Prenume/Prenom/First name ANA MARIA
Domiciliu/Adresse/Address Jud.CJ Mun.Cluj-Napoca Str.Horea nr.12 ap.4
IDROUPOPESCU<<ANA<MARIA<<<<<<<<<<<<<
CJ482915<4ROU8503122F3203121${CNP_ANA.slice(-6)}`;

const CONTRACT = `CONTRACT DE VÂNZARE-CUMPĂRARE
Între: SC ALFA CONSTRUCT SRL, cu sediul în Str. Mihai Eminescu nr. 5, Mun. Constanța, Jud. Constanța, CUI: RO${CUI_ALFA}, cont IBAN ${IBAN.replace(/(.{4})/g, '$1 ').trim()}, reprezentată prin Ion Ionescu, CNP ${CNP_ION}, în calitate de administrator,
și Ana Maria Popescu, domiciliată în Mun. Cluj-Napoca, Str. Horea nr. 12, ap. 4, Jud. Cluj, identificată cu C.I. seria CJ nr. 482915, telefon 0722 123 456, e-mail ana.popescu@example.ro,
în temeiul art. 1650 din Legea nr. 287/2009 privind Codul civil, republicată, a intervenit prezentul contract, încheiat la data de 12.03.2024, pentru prețul de 150.000 lei.`;

const INVOICE = `FACTURA FISCALA nr. 2024-0117 din 15.04.2024
Furnizor: SC ALFA CONSTRUCT SRL, CUI RO${CUI_ALFA}, IBAN ${IBAN}
Client: Popescu Ana Maria, CNP ${CNP_ANA}, tel. +40 722 123 456
Total de plată: 12.500,00 lei (TVA 19% inclus conform art. 291 din Legea nr. 227/2015)`;

const memoryStorage = () => {
  const store = new Map();
  return { store, load: (id) => store.get(id) ?? null, save: (id, data) => { store.set(id, data); } };
};

// ── Layer 1 ─────────────────────────────────────────────────────────────
test('layer 1 finds every strict identifier and nothing protected', () => {
  const types = detectLayer1(CONTRACT).map((s) => s.type).sort();
  assert.deepEqual(types, ['ADRESA', 'ADRESA', 'CI', 'CNP', 'CUI', 'EMAIL', 'IBAN', 'TEL']);
  for (const s of detectLayer1(CONTRACT)) {
    const piece = CONTRACT.slice(s.start, s.end);
    assert.ok(!/287\/2009|12\.03\.2024|150\.000/.test(piece), `${s.type} covers a protected piece: ${piece}`);
  }
});

test('a CNP carries its sex and birth year, an address its county and locality', () => {
  const spans = detectLayer1(CONTRACT);
  const cnp = spans.find((s) => s.type === 'CNP');
  assert.deepEqual(cnp.meta, ['M', '1976']);
  const addr = spans.find((s) => s.type === 'ADRESA' && /Eminescu/.test(s.value));
  assert.ok(addr.meta.includes('Constanța'), `address meta: ${addr.meta}`);
});

test('IBAN mod-97; a 13-digit number that fails the CNP check is left alone', () => {
  assert.equal(ibanValid(IBAN), true);
  assert.equal(ibanValid('RO49AAAA1B31007593840001'), false);
  const bad = `${CNP_ANA.slice(0, 12)}${(Number(CNP_ANA[12]) + 1) % 10}`;
  assert.equal(detectLayer1(`Număr dosar ${bad}.`).length, 0);
});

test('MRZ lines are masked whole', () => {
  const spans = detectLayer1(ID_CARD).filter((s) => s.type === 'MRZ');
  assert.equal(spans.length, 2);
});

// ── The vault ───────────────────────────────────────────────────────────
test('masking removes every identifier and keeps amounts, dates and citations', async () => {
  const v = new Vault({ projectId: 'p1' });
  const masked = [ID_CARD, CONTRACT, INVOICE].map((t) => v.mask(t)).join('\n');
  for (const secret of [CNP_ANA, CNP_ION, CUI_ALFA, IBAN, '482915', '0722 123 456', 'ana.popescu@example.ro', 'Eminescu nr. 5', 'IDROUPOPESCU']) {
    assert.ok(!masked.includes(secret), `still in the masked text: ${secret}`);
  }
  for (const kept of ['Legea nr. 287/2009', 'art. 1650', '12.03.2024', '150.000 lei', '12.500,00 lei', 'Legea nr. 227/2015', '15.04.2024']) {
    assert.ok(masked.includes(kept), `lost from the masked text: ${kept}`);
  }
  assert.match(masked, /\[CNP_\d{2} · F · 1985\]/);
  assert.match(masked, /\[CNP_\d{2} · M · 1976\]/);
});

test('deterministic: one value, one token, across documents and across sessions', async () => {
  const storage = memoryStorage();
  const v1 = await Vault.open('case-7', { storage });
  const a = v1.mask(CONTRACT);
  const b = v1.mask(INVOICE);
  const tokenOf = (text, re) => (text.match(re) || [])[0];
  const cnpToken = /\[CNP_\d{2} · F · 1985\]/;
  assert.equal(tokenOf(b, cnpToken), tokenOf(v1.mask(ID_CARD), cnpToken));
  assert.equal(tokenOf(a, /\[IBAN_\d{2}\]/), tokenOf(b, /\[IBAN_\d{2}\]/));
  assert.equal(tokenOf(a, /\[CUI_\d{2}\]/), tokenOf(b, /\[CUI_\d{2}\]/));
  // "+40 722 123 456" and "0722 123 456" are one number.
  assert.equal(tokenOf(a, /\[TEL_\d{2}\]/), tokenOf(b, /\[TEL_\d{2}\]/));
  await v1.save();
  const v2 = await Vault.open('case-7', { storage });
  assert.equal(v2.mask(CONTRACT), a);
  assert.ok(!storage.store.get('case-7').includes('p1'));
});

test('a name linked to its CNP shares the number; the TYPE picks what comes back', () => {
  const v = new Vault({ projectId: 'p' });
  v.link({ type: 'CNP', value: CNP_ANA }, { type: 'PERSOANA', value: 'Ana Maria Popescu' });
  const cnpTok = v.getOrCreateToken('CNP', CNP_ANA);
  const nameTok = v.getOrCreateToken('PERSOANA', 'POPESCU ANA MARIA');   // another spelling, same person
  assert.equal(cnpTok.match(/_(\d+)/)[1], nameTok.match(/_(\d+)/)[1]);
  assert.equal(v.resolveToken(cnpTok), CNP_ANA);
  assert.equal(v.resolveToken(nameTok), 'Ana Maria Popescu');
});

test('re-identification deep-walks an AI graph, mangled tokens included', () => {
  const v = new Vault({ projectId: 'p' });
  const masked = v.mask(CONTRACT);
  const cnp = masked.match(/\[CNP_(\d{2}) · M · 1976\]/);
  const iban = masked.match(/\[IBAN_(\d{2})\]/);
  const cui = masked.match(/\[CUI_(\d{2})\]/);
  const answer = {
    nodes: [
      { id: 'n1', kind: 'person', label: `Administrator, ${cnp[0]}` },
      { id: 'n2', kind: 'company', label: `CUI_${cui[1]}` },                 // brackets dropped
      { id: 'n3', kind: 'account', label: `[IBAN_${iban[1]}]` },            // metadata absent
    ],
    edges: [{ from: 'n1', to: 'n2', type: 'represents', evidence: [`[CNP_${cnp[1]}•M•1976] signs for [CUI_${cui[1]}]`] }],
    facts: { [`CNP_${cnp[1]}`]: 'buyer' },                                  // a key
    note: 'PERSOANA_99 is not known',                                       // never given: left alone
  };
  const back = v.reidentify(answer);
  assert.equal(back.nodes[0].label, `Administrator, ${CNP_ION}`);
  assert.equal(back.nodes[1].label, CUI_ALFA);
  assert.equal(back.nodes[2].label, IBAN);
  assert.equal(back.edges[0].evidence[0], `${CNP_ION} signs for ${CUI_ALFA}`);
  assert.deepEqual(Object.keys(back.facts), [CNP_ION]);
  assert.equal(back.note, 'PERSOANA_99 is not known');
  // The whole contract comes back as it was, identifiers restored.
  const restored = v.reidentify(masked);
  for (const s of [CNP_ION, CUI_ALFA, IBAN, 'ana.popescu@example.ro']) assert.ok(restored.includes(s), s);
});

test('mask ∘ reidentify is stable: stored real text masks to the same tokens', () => {
  const v = new Vault({ projectId: 'p' });
  const once = v.mask(INVOICE);
  const again = v.mask(v.reidentify(once));
  assert.equal(again, once);
});

test('maskDeep masks a request body without touching its structure', () => {
  const v = new Vault({ projectId: 'p' });
  const body = { model: 'x', messages: [{ role: 'user', content: [{ type: 'text', text: INVOICE }] }], n: 3 };
  const out = v.maskDeep(body);
  assert.equal(out.model, 'x');
  assert.equal(out.n, 3);
  assert.ok(!out.messages[0].content[0].text.includes(CNP_ANA));
  assert.equal(v.reidentify(out).messages[0].content[0].text.includes(CNP_ANA), true);
});

// ── Layer 2: known names ─────────────────────────────────────────────────
const KNOWN = () => [
  { kind: 'person', name: 'Ana Maria Popescu', cnp: CNP_ANA },
  { kind: 'person', name: 'Ion Ionescu', cnp: CNP_ION },
  { kind: 'company', name: 'SC ALFA CONSTRUCT SRL', cui: CUI_ALFA },
];
const layer2Vault = () => {
  const entities = KNOWN();
  const v = new Vault({ projectId: 'p', detectors: [makeLayer2(entities)] });
  for (const e of entities) {
    if (e.cnp) v.link({ type: 'CNP', value: e.cnp }, { type: 'PERSOANA', value: e.name });
    if (e.cui) v.link({ type: 'CUI', value: e.cui }, { type: 'FIRMA', value: e.name });
  }
  return v;
};

test('layer 2 masks the known names in the three documents', () => {
  const v = layer2Vault();
  const masked = [ID_CARD, CONTRACT, INVOICE].map((t) => v.mask(t)).join('\n');
  for (const name of ['Ana Maria Popescu', 'Popescu Ana Maria', 'Ion Ionescu', 'ALFA CONSTRUCT']) {
    assert.ok(!masked.includes(name), `still in the masked text: ${name}`);
  }
  // The legal form goes with the company's name, not left dangling.
  assert.ok(!/\] SRL/.test(masked), 'SRL left beside the token');
});

test('a name and its identifier share one number', () => {
  const v = layer2Vault();
  const masked = v.mask(`Subsemnata Ana Maria Popescu, CNP ${CNP_ANA}.`);
  const name = masked.match(/\[PERSOANA_(\d{2})\]/);
  const cnp = masked.match(/\[CNP_(\d{2}) · F · 1985\]/);
  assert.ok(name && cnp, masked);
  assert.equal(name[1], cnp[1]);
  const co = v.mask(`S.C. ALFA CONSTRUCT S.R.L., CUI ${CUI_ALFA}`);
  assert.equal(co.match(/\[FIRMA_(\d{2})\]/)[1], co.match(/\[CUI_(\d{2})\]/)[1]);
  assert.equal(v.reidentify(masked), `Subsemnata Ana Maria Popescu, CNP ${CNP_ANA}.`);
});

test('any word order, any case, diacritics or none, a declined last word', () => {
  const detect = makeLayer2(KNOWN());
  for (const form of ['POPESCU ANA MARIA', 'Popescu Ana-Maria', 'ana maria popescu', 'Ana Maria Popescului', 'Popescu Ana Mariei']) {
    const spans = detect(`Semnat de ${form}, azi.`);
    assert.equal(spans.length, 1, form);
    assert.equal(spans[0].type, 'PERSOANA');
    assert.equal(spans[0].value, 'Ana Maria Popescu');
    assert.deepEqual(spans[0].link, { type: 'CNP', value: CNP_ANA });
  }
  const co = makeLayer2([{ kind: 'company', name: 'Țesătoria Nouă SRL' }]);
  assert.equal(co('Contract cu TESATORIA NOUA S.R.L. din Brașov').length, 1);
});

test('no false positives: a surname alone, a street, a common word', () => {
  const detect = makeLayer2([...KNOWN(), { kind: 'person', name: 'Ion Mare' }, { kind: 'company', name: 'Alfa SRL' }]);
  assert.equal(detect('Imobilul din Str. Popescu nr. 3 aparține domnului Popescu.').length, 0);
  assert.equal(detect('O zi mare pentru ion din sat.').length, 0);
  assert.equal(detect('Litera alfa din alfabet.').length, 0);   // one-word company only beside its form
  assert.equal(detect('Furnizor: Alfa SRL.').length, 1);
});

test('knownEntitiesFrom reads records and scan parties', () => {
  const list = knownEntitiesFrom({
    records: [{ kind: 'person', name: 'Ana Maria Popescu', nationalId: CNP_ANA }, { kind: 'org', name: 'Alfa Construct SRL', taxId: `RO${CUI_ALFA}` }],
    parties: [{ name: 'Ion Ionescu', kind: 'person', identifiers: [`CNP ${CNP_ION}`] }, { name: 'Beta SA', kind: 'company', identifiers: ['CUI RO123'] }],
  });
  assert.deepEqual(list.map((e) => [e.kind, e.name, e.cnp || e.cui || '']), [
    ['person', 'Ana Maria Popescu', CNP_ANA],
    ['company', 'Alfa Construct SRL', `RO${CUI_ALFA}`],
    ['person', 'Ion Ionescu', CNP_ION],
    ['company', 'Beta SA', ''],
  ]);
});

// ── The transport: request bodies and streamed answers ───────────────────
test('maskBody masks content and leaves structure and pictures alone', () => {
  const v = layer2Vault();
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: `AAAA${IBAN}BBBB` } };
  const body = {
    action: 'ask', model: 'claude-sonnet-5', tools: false,
    messages: [{ role: 'user', content: [image, { type: 'text', text: `CNP ${CNP_ANA}` }] }],
    context: 'Client: Ana Maria Popescu',
    files: [{ id: 'F1', name: 'CI Popescu Ana Maria.jpg', text: INVOICE }],
  };
  const out = maskBody(body, v);
  assert.equal(out.action, 'ask');
  assert.equal(out.model, 'claude-sonnet-5');
  assert.equal(out.files[0].id, 'F1');
  assert.equal(out.messages[0].role, 'user');
  assert.strictEqual(out.messages[0].content[0], image);             // the picture's bytes untouched
  assert.ok(!JSON.stringify(out).replace(image.source.data, '').includes(CNP_ANA));
  assert.ok(!out.context.includes('Popescu'));
  assert.ok(!out.files[0].name.includes('Popescu'));
});

test('the stream is re-identified without splitting a token', () => {
  const v = layer2Vault();
  const masked = v.mask(`Ana Maria Popescu (CNP ${CNP_ANA}) plătește prin ${IBAN}.`);
  // Cut into every possible pair of pieces, then into single characters.
  for (let cut = 1; cut < masked.length; cut += 1) {
    const seen = [];
    const sink = makeStreamReidentifier(v, (piece) => seen.push(piece));
    sink.push(masked.slice(0, cut));
    sink.push(masked.slice(cut));
    const all = sink.end();
    assert.equal(all, v.reidentify(masked));
    assert.equal(seen.join(''), all);
    for (const piece of seen) assert.ok(!/\[|PERSOANA_|CNP_\d|IBAN_/.test(piece), `a token leaked at cut ${cut}: ${piece}`);
  }
  const seen = [];
  const sink = makeStreamReidentifier(v, (piece) => seen.push(piece));
  for (const ch of masked) sink.push(ch);
  sink.end();
  assert.equal(seen.join(''), v.reidentify(masked));
});

// ── 5a: merging entities ─────────────────────────────────────────────────
test('a late link merges two entities; old and new tokens both re-identify; it survives a reopen', async () => {
  const storage = memoryStorage();
  const v = await Vault.open('merge', { storage });
  const oldCnp = v.getOrCreateToken('CNP', CNP_ANA, ['F', '1985']);      // CNP_01
  v.getOrCreateToken('CNP', CNP_ION, ['M', '1976']);                      // CNP_02
  const oldName = v.getOrCreateToken('PERSOANA', 'Ana Maria Popescu');   // PERSOANA_03 — not yet known to be her
  assert.match(oldName, /PERSOANA_03/);
  v.link({ type: 'CNP', value: CNP_ANA }, { type: 'PERSOANA', value: 'Ana Maria Popescu' });
  // Masking now uses the kept (lower) number for both.
  assert.equal(v.getOrCreateToken('PERSOANA', 'POPESCU ANA MARIA'), '[PERSOANA_01]');
  assert.equal(v.getOrCreateToken('CNP', CNP_ANA), oldCnp);
  // A token already sent under the dropped number still comes back.
  assert.equal(v.reidentify(`${oldName} / PERSOANA_01 / ${oldCnp}`), `Ana Maria Popescu / Ana Maria Popescu / ${CNP_ANA}`);
  await v.save();
  assert.equal(JSON.parse(storage.store.get('merge')).v, 2);
  const again = await Vault.open('merge', { storage });
  assert.equal(again.reidentify('[PERSOANA_03]'), 'Ana Maria Popescu');
  assert.equal(again.getOrCreateToken('PERSOANA', 'Ana Maria Popescu'), '[PERSOANA_01]');
  // The other person is untouched.
  assert.equal(again.reidentify('[CNP_02 · M · 1976]'), CNP_ION);
});

test('a v1 vault still reads', () => {
  const v = new Vault({ projectId: 'old' });
  v.fromJSON({ v: 1, counters: { person: 1 }, entities: { 'person:1': { family: 'person', n: 1, values: { CNP: { value: CNP_ANA, meta: ['F', '1985'], aliases: [CNP_ANA] } } } } });
  assert.equal(v.getOrCreateToken('CNP', CNP_ANA), '[CNP_01 · F · 1985]');
  assert.deepEqual(v.redirects, {});
});

// ── 5b: guessed names ─────────────────────────────────────────────────────
const guessed = (text) => detectLayer3(text).map((s) => text.slice(s.start, s.end));

test('layer 3 finds names from their cues', () => {
  assert.deepEqual(guessed('Subsemnatul POPESCU ION, domiciliat în Cluj.'), ['POPESCU ION']);
  assert.ok(guessed('SC Beta SRL, reprezentată prin Maria Ionescu, în calitate de administrator').includes('Maria Ionescu'));
  assert.ok(guessed('Vânzător: Gheorghe Vasilescu-Pop, cetățean român').includes('Gheorghe Vasilescu-Pop'));
  assert.ok(guessed('Contract încheiat cu S.C. Gamma Trans S.R.L. din Iași').some((x) => /Gamma Trans/.test(x)));
  assert.ok(guessed('Furnizor Delta Impex SRL').includes('Delta Impex SRL'));
});

test('layer 3 leaves courts, laws, streets, months and places alone', () => {
  for (const text of [
    'Tribunalul București a admis cererea.',
    'în temeiul Legea nr. 287/2009 privind Codul civil',
    'domiciliat în Str. Mihai Eminescu nr. 5',
    'domnul a semnat în luna Martie 2024',
    'Judecătoria Sectorului 4 București',
    'născut la 12.03.1985 în Cluj-Napoca',
  ]) assert.deepEqual(guessed(text), [], text);
});

test('a guessed name and a known one become one entity once linked', () => {
  const v = new Vault({ projectId: 'g' });
  const first = v.mask('Subsemnata Ana Maria Popescu, domiciliată în Cluj.', { detectors: [detectLayer3] });
  const guessedTok = first.match(/\[PERSOANA_(\d{2})\]/);
  assert.ok(guessedTok, first);
  // Later a record says whose CNP this is: Layer 2 links, the entities merge.
  const detect = makeLayer2([{ kind: 'person', name: 'Ana Maria Popescu', cnp: CNP_ANA }]);
  v.link({ type: 'CNP', value: CNP_ANA }, { type: 'PERSOANA', value: 'Ana Maria Popescu' });
  const second = new Vault({ projectId: 'g' });
  second.fromJSON(v.toJSON());
  second.detectors = [detect];
  const masked = second.mask(`Ana Maria Popescu, CNP ${CNP_ANA}`);
  const name = masked.match(/\[PERSOANA_(\d{2})\]/)[1];
  const cnp = masked.match(/\[CNP_(\d{2})/)[1];
  assert.equal(name, cnp);
  assert.equal(second.reidentify(guessedTok[0]), 'Ana Maria Popescu');
});

test('a known name wins over a guess of the same span', () => {
  const v = layer2Vault();
  const out = v.mask('Subsemnata Ana Maria Popescu declar', { detectors: [detectLayer3] });
  assert.equal(out.match(/\[PERSOANA_(\d{2})\]/)[1], v.getOrCreateToken('CNP', CNP_ANA).match(/_(\d{2})/)[1]);
});

// ── 5c: what was sent ─────────────────────────────────────────────────────
test('the sent log keeps the masked text only, 30 at most', () => {
  clearSentLog();
  const v = layer2Vault();
  const body = maskBody({ action: 'ask', messages: [{ role: 'user', content: `Client Ana Maria Popescu, CNP ${CNP_ANA}` }] }, v);
  recordSent({ usageAction: 'files-scan', projectId: 'p', masked: true, preview: bodyText(body) });
  const [e] = getSentLog();
  assert.equal(e.masked, true);
  assert.ok(!e.bodyPreview.includes(CNP_ANA) && !e.bodyPreview.includes('Popescu'), e.bodyPreview);
  assert.match(e.bodyPreview, /\[CNP_\d{2}/);
  // A call sent as it is keeps no text.
  recordSent({ usageAction: 'chat', projectId: 'p', masked: false, preview: `CNP ${CNP_ANA}` });
  assert.equal(getSentLog()[0].bodyPreview, null);
  for (let i = 0; i < 40; i += 1) recordSent({ usageAction: `a${i}`, masked: true, preview: 'x' });
  assert.equal(getSentLog().length, 30);
  assert.equal(getSentLog()[0].usageAction, 'a39');
  assert.ok(bodyText({ messages: [{ content: 'y'.repeat(9000) }] }).length <= 4001);
});
