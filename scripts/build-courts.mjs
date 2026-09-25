// Rebuilds src/lib/courts.json — every court the portal.just.ro service knows,
// read from its own WSDL (the `Institutie` enumeration). Run when a court is
// added or renamed (rare), then release:
//
//   node scripts/build-courts.mjs
//
// The ids are the service's own ("JudecatoriaSECTORUL4BUCURESTI"); the label
// is the kind written out and the PLACE WRITTEN PROPERLY — the id spells it
// run together, uppercase and without diacritics ("ALBAIULIA",
// "SANNICOLAULMARE"), so it is looked up by that spelling in the app's own
// gazetteer (lib/roLocalities.json, every locality of Romania; the counties
// from lib/identities) and written as the place writes itself: "Alba Iulia",
// "Sânnicolau Mare", "Sectorul 4 București". A place the gazetteer does not
// know (none today) is written with a capital and the rest small.
//
//   node scripts/build-courts.mjs            # from the WSDL
//   node scripts/build-courts.mjs --relabel  # the ids already in courts.json, no network

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/lib/courts.json');

const KINDS = [
  ['InaltaCurtedeCasatiesiJustitie', 'Înalta Curte de Casație și Justiție', 'iccj'],
  ['CurteaMilitaradeApel', 'Curtea Militară de Apel', 'ca'],
  ['CurteadeApel', 'Curtea de Apel', 'ca'],
  ['TribunalulMilitarTeritorial', 'Tribunalul Militar Teritorial', 'trib'],
  ['TribunalulMilitar', 'Tribunalul Militar', 'trib'],
  ['TribunalulComercial', 'Tribunalul Comercial', 'trib'],
  ['TribunalulpentruminoriSifamilie', 'Tribunalul pentru minori și familie', 'trib'],
  ['TribunalulSpecializat', 'Tribunalul Specializat', 'trib'],
  ['Tribunalul', 'Tribunalul', 'trib'],
  ['Judecatoria', 'Judecătoria', 'jud'],
];
const ORDER = { iccj: 0, ca: 1, trib: 2, jud: 3, other: 4 };

// ── The gazetteer: a place as the id spells it → as it writes itself ──
const fold = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const lib = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/lib');
const localities = JSON.parse(readFileSync(path.join(lib, 'roLocalities.json'), 'utf8'));
const counties = [...readFileSync(path.join(lib, 'identities.js'), 'utf8')
  .match(/export const RO_COUNTIES = \[([\s\S]*?)\];/)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
const BY_PLACE = new Map(); // every locality, the first spelling wins
for (const plate of Object.keys(localities)) for (const name of localities[plate]) { const k = fold(name); if (!BY_PLACE.has(k)) BY_PLACE.set(k, name); }
const BY_COUNTY = new Map(counties.map((n) => [fold(n), n]));
// Spellings the gazetteer writes differently from the service.
const EXTRA = { odorheiulsecuiesc: 'Odorheiu Secuiesc', sannicolaulmare: 'Sânnicolau Mare', simleulsilvaniei: 'Șimleu Silvaniei' };
const capital = (w) => (w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w);
const unnamed = [];
const prettyPlace = (raw, kind) => {
  if (!raw) return '';
  const sector = /^SECTORUL\s*(\d)\s*BUCURESTI$/i.exec(raw.replace(/\s+/g, ' '));
  if (sector) return `Sectorul ${sector[1]} București`;
  const k = fold(raw);
  const county = BY_COUNTY.get(k); const place = EXTRA[k] || BY_PLACE.get(k);
  // A tribunal sits in a county and is named for it; every other court for its town.
  const best = kind === 'trib' ? (county || place) : (place || county);
  if (best) return best;
  unnamed.push(raw);
  return raw.split(/\s+/).map(capital).join(' ');
};

let ids;
if (process.argv.includes('--relabel')) {
  ids = JSON.parse(readFileSync(out, 'utf8')).map((c) => c.id);
} else {
  const res = await fetch('http://portalquery.just.ro/query.asmx?WSDL', {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  if (!res.ok) throw new Error(`WSDL: HTTP ${res.status}`);
  const xml = await res.text();
  const block = /<s:simpleType name="Institutie">([\s\S]*?)<\/s:simpleType>/.exec(xml)?.[1];
  if (!block) throw new Error('no Institutie enumeration in the WSDL');
  ids = [...block.matchAll(/enumeration value="([A-Za-z0-9]+)"/g)].map((m) => m[1]);
}

const unmatched = [];
const courts = ids.map((id) => {
  const kind = KINDS.find(([prefix]) => id.toLowerCase().startsWith(prefix.toLowerCase()));
  if (!kind) { unmatched.push(id); return { id, label: id, kind: 'other', place: id }; }
  const place = prettyPlace(id.slice(kind[0].length).replace(/(\d+)/g, ' $1 ').replace(/\s+/g, ' ').trim(), kind[2]);
  return { id, label: place ? `${kind[1]} ${place}` : kind[1], kind: kind[2], place };
});
courts.sort((a, b) => (ORDER[a.kind] - ORDER[b.kind]) || a.place.localeCompare(b.place, 'ro'));

writeFileSync(out, `${JSON.stringify(courts.map(({ id, label, kind }) => ({ id, label, kind })))}\n`);
console.log(`${courts.length} courts → ${path.relative(process.cwd(), out)}`);
if (unmatched.length) console.log('unmatched ids (labelled as-is):', unmatched.join(', '));
if (unnamed.length) console.log('places the gazetteer does not know (capitalised as spelt):', unnamed.join(', '));
