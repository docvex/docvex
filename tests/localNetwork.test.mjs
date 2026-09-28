// The neural network without AI (src/lib/localNetwork), under plain Node:
// npm test. Bundled first (Vite-style modules), as the other suites are.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let understandLocally; let crossReferenceLocally; let connectLocally;

before(async () => {
  const out = path.join(os.tmpdir(), `docvex-localnet-${process.pid}.mjs`);
  await build({ entryPoints: [path.join(root, 'src/lib/localNetwork.js')], outfile: out, format: 'esm', platform: 'node', bundle: true, logLevel: 'silent' });
  ({ understandLocally, crossReferenceLocally, connectLocally } = await import(pathToFileURL(out).href));
});

const DOCS = [
  ['CI Popescu.jpg', 'image-text', 'ROMANIA ROUMANIE ROMANIA\nCARTE DE IDENTITATE IDENTITY CARD\nSERIA RX NR 123456\nCNP 1850101400017\nNume/Nom/Last name\nPOPESCU\nPrenume/Prenom/First name\nION ANDREI\nValabilitate 01.02.2019-01.01.2029'],
  ['Contract.docx', 'text', 'CONTRACT DE VÂNZARE-CUMPĂRARE nr. 45/12.03.2020\nÎntre: Subsemnatul Popescu Ion Andrei, CNP 1850101400017, domiciliat în București, Str. Lalelelor nr. 5, în calitate de vânzător,\nși SC ALFA CONSTRUCT SRL, cu sediul în Cluj-Napoca, Str. Horea nr. 3, CUI 18547290, în calitate de cumpărător, privind imobilul cu nr. cadastral 223344. Prețul este de 150.000 lei.'],
  ['Act aditional.pdf', 'text', 'ACT ADIȚIONAL nr. 1 din 01.06.2020 la contractul nr. 45/12.03.2020\nÎntre Popescu Ion Andrei, în calitate de vânzător și SC ALFA CONSTRUCT SRL, CUI 18547290, în calitate de cumpărător, se modifică prețul la 160.000 lei.'],
  ['Factura.pdf', 'text', 'FACTURA nr. 889 din 15.03.2020\nFurnizor: SC ALFA CONSTRUCT SRL, CUI 18547290\nTotal de plată: 160.000 lei'],
  ['nota.txt', 'text', 'Notă despre vremea din Sibiu, 3 mai 2021.'],
];
const entriesOf = () => DOCS.map(([name, method, text], i) => ({ rel: name, file: { name }, method, stamp: { size: i, mtime: String(i) }, understanding: understandLocally(text, { name, method }) }));

test('each file is understood from its own text', () => {
  const [ci, contract] = entriesOf().map((e) => e.understanding);
  assert.equal(ci.documentType, 'Carte de identitate');
  assert.equal(ci.idDocument.holder, 'Popescu Ion Andrei');
  assert.equal(contract.documentType, 'Contract de vânzare-cumpărare');
  const firm = contract.parties.find((p) => p.kind === 'company');
  assert.equal(firm.role, 'cumpărător');
  assert.ok(firm.identifiers.includes('CUI 18547290'));
  assert.ok(contract.parties.find((p) => p.kind === 'person').identifiers.includes('CNP 1850101400017'));
  assert.deepEqual(contract.property, ['223344']);
});

test('files are linked by what they share', () => {
  const { links } = crossReferenceLocally(entriesOf());
  const has = (type, from, to) => links.some((l) => l.type === type && l.from === from && l.to === to);
  assert.ok(has('amends', 'Act aditional.pdf', 'Contract.docx'));
  assert.ok(has('evidence_for', 'CI Popescu.jpg', 'Contract.docx'));
  assert.ok(links.some((l) => l.type === 'financial_link' && l.from === 'Factura.pdf'));
  assert.ok(!links.some((l) => l.from === 'nota.txt' || l.to === 'nota.txt'));
});

test('collections are one per subject', () => {
  const entries = entriesOf();
  const { created } = connectLocally(entries, [], { allEntries: entries, sourceOf: (e, role) => ({ rel: e.rel, role }) });
  const person = created.find((c) => c.subject === 'person');
  const firm = created.find((c) => c.subject === 'company');
  assert.deepEqual(person.sources.map((s) => s.rel).sort(), ['Act aditional.pdf', 'CI Popescu.jpg', 'Contract.docx']);
  assert.equal(person.recordIn.fields.nationalId, '1850101400017');
  assert.equal(firm.recordIn.fields.taxId, '18547290');
  // A later file joins the existing collection instead of making another.
  const again = connectLocally([entries[3]], [{ ...firm, entities: [], record: { taxId: '18547290' } }], { allEntries: entries, sourceOf: (e, role) => ({ rel: e.rel, role }) });
  assert.equal(again.created.filter((c) => c.subject === 'company').length, 0);
});
