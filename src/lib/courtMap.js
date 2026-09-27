// The courts on the MAP — the model behind components/CourtMap (the Court
// files tab's map of the counties, as portal.just.ro draws its own).
//
// Pressing a county shows the court of appeal it answers to, and every court
// of that court of appeal's circumscription, county by county. Two things are
// needed for that and neither is in the service's list of courts
// (lib/courts.json is only id + label + kind):
//
//   - the CIRCUMSCRIPTIONS — which counties each of the fifteen courts of
//     appeal covers (Legea nr. 304/2004, anexa; unchanged in its shape since),
//     written out below;
//   - each court's COUNTY — read off its label: a tribunal is named after its
//     county ("Tribunalul Cluj", "Tribunalul Comercial Argeș"), a court of
//     appeal after its seat, a district court after its town ("Judecătoria
//     Turda"), which the app's gazetteer (lib/roLocalities.json, every
//     locality by county) places — a town name found in several counties is
//     taken from the county where it ranks highest (the lists are biggest
//     first), which is where a court would sit.
//
// Courts with no county of their own (the High Court, the military courts) are
// listed as NATIONAL.

import COURTS from './courts.json';
import LOCALITIES from './roLocalities.json';
import { COUNTY_BY_PLATE } from './identities';

const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Plate code → county name ("CJ" → "Cluj", "B" → "București"). */
export const countyName = (code) => COUNTY_BY_PLATE.get(String(code || '').toLowerCase()) || code;

/** The fifteen courts of appeal: seat, and the counties they cover (plates). */
export const CIRCUMSCRIPTIONS = [
  { seat: 'Alba Iulia', counties: ['AB', 'SB', 'HD'] },
  { seat: 'Bacău', counties: ['BC', 'NT'] },
  { seat: 'Brașov', counties: ['BV', 'CV'] },
  { seat: 'București', counties: ['B', 'IF', 'CL', 'GR', 'IL', 'TR'] },
  { seat: 'Cluj', counties: ['CJ', 'BN', 'MM', 'SJ'] },
  { seat: 'Constanța', counties: ['CT', 'TL'] },
  { seat: 'Craiova', counties: ['DJ', 'GJ', 'MH', 'OT'] },
  { seat: 'Galați', counties: ['GL', 'BR', 'VN'] },
  { seat: 'Iași', counties: ['IS', 'VS'] },
  { seat: 'Oradea', counties: ['BH', 'SM'] },
  { seat: 'Pitești', counties: ['AG', 'VL'] },
  { seat: 'Ploiești', counties: ['PH', 'BZ', 'DB'] },
  { seat: 'Suceava', counties: ['SV', 'BT'] },
  { seat: 'Târgu Mureș', counties: ['MS', 'HR'] },
  { seat: 'Timișoara', counties: ['TM', 'AR', 'CS'] },
];

const circOf = new Map(CIRCUMSCRIPTIONS.flatMap((c) => c.counties.map((k) => [k, c])));
/** The circumscription a county belongs to. */
export const circumscriptionOf = (code) => circOf.get(code) || null;

// County names, folded, → plate ("cluj" → "CJ", "bucuresti" → "B").
const plateByName = new Map([...COUNTY_BY_PLATE.entries()].map(([plate, name]) => [fold(name), plate.toUpperCase()]));
// Locality, folded → the plate of the county where it ranks highest.
const plateByTown = (() => {
  const best = new Map();
  for (const [plate, towns] of Object.entries(LOCALITIES)) {
    towns.forEach((t, i) => {
      const k = fold(t);
      const had = best.get(k);
      if (!had || i < had.rank) best.set(k, { plate, rank: i });
    });
  }
  return new Map([...best.entries()].map(([k, v]) => [k, v.plate]));
})();

// Towns a court sits in whose name the gazetteer also has, ranked higher, in
// another county — checked against the courts' own circumscriptions.
const TOWN_OVERRIDE = new Map([['costesti', 'AG'], ['liesti', 'GL']]);

// The place a court's label names, after the kind of court.
const PREFIX = /^(curtea de apel|tribunalul pentru minori si familie|tribunalul comercial|tribunalul|judecatoria)\s+/;

function courtCounty(c) {
  const f = fold(c.label);
  if (/militar|inalta curte/.test(f)) return null;
  if (/sectorul\s+\d/.test(f) || /\bbucuresti\b/.test(f)) return 'B';
  const place = f.replace(PREFIX, '');
  if (c.kind === 'ca') {
    const seat = CIRCUMSCRIPTIONS.find((x) => fold(x.seat) === place);
    return seat ? seat.counties[0] : null;
  }
  if (c.kind === 'trib') return plateByName.get(place) || plateByTown.get(place) || null;
  return TOWN_OVERRIDE.get(place) || plateByTown.get(place) || plateByName.get(place) || null;
}

const COUNTY_OF = new Map(COURTS.map((c) => [c.id, courtCounty(c)]));
/** The county (plate) a court sits in, or null (national). */
export const countyOfCourt = (id) => COUNTY_OF.get(id) || null;

const RANK = { ca: 0, trib: 1, jud: 2, other: 3, iccj: 4 };
const byRank = (a, b) => (RANK[a.kind] ?? 9) - (RANK[b.kind] ?? 9) || a.label.localeCompare(b.label, 'ro');

/** Every court in a county, the court of appeal first, then tribunals, then district courts. */
export function courtsInCounty(code) {
  return COURTS.filter((c) => COUNTY_OF.get(c.id) === code).sort(byRank);
}

/** A county's circumscription laid out for the dropdown:
 *  `{ seat, counties: [{ code, name, courts }] }`, the pressed county first. */
export function circumscriptionCourts(code) {
  const circ = circumscriptionOf(code);
  if (!circ) return null;
  const order = [code, ...circ.counties.filter((k) => k !== code)];
  return {
    seat: circ.seat,
    counties: order.map((k) => ({ code: k, name: countyName(k), courts: courtsInCounty(k) })),
  };
}

/** The courts no county holds (the High Court, the military courts). */
export const nationalCourts = () => COURTS.filter((c) => !COUNTY_OF.get(c.id)).sort(byRank);
