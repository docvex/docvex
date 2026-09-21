// Romanian places for identity records: the counties (and București's sectors),
// and every locality in the country — 13,851 of them, towns to villages.
//
// The localities are `roLocalities.json`: `{ [plate]: [names, biggest first] }`,
// built from the public-domain dataset github.com/catalin87/baza-de-date-
// localitati-romania (INS + Poșta Română, 2019), with its legacy cedilla ş/ţ
// rewritten as the comma-below ș/ț Romanian is actually written with — these
// names go into legal documents as they stand. ~180 kB, so it is imported
// lazily: the first record opened pays for it, nothing else does.
import { RO_COUNTIES, COUNTY_BY_PLATE, classifyCounty } from './identities';

const PLATE_BY_COUNTY = new Map([...COUNTY_BY_PLATE.entries()].map(([plate, name]) => [name, plate.toUpperCase()]));
export const plateOf = (countyName) => PLATE_BY_COUNTY.get(countyName) || '';

const fold = (s) => String(s ?? '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// What "County / sector" can be: the 41 counties, then the capital's six
// sectors (București is its own county, and an address there is written by
// sector — see `classifyCounty`).
let countyMemo = null;
export function countyOptions() {
  if (countyMemo) return countyMemo;
  const counties = RO_COUNTIES.filter((c) => c !== 'București')
    .map((name) => ({ key: name, value: name, label: name, note: plateOf(name), group: 'Counties', folded: fold(name) }));
  const sectors = [1, 2, 3, 4, 5, 6].map((n) => ({
    key: `Sector ${n}`, value: `Sector ${n}`, label: `Sector ${n}`, note: 'București', group: 'București', folded: fold(`sector ${n} bucuresti`),
  }));
  countyMemo = [...counties, ...sectors];
  return countyMemo;
}
export function searchCounties(query) {
  const q = fold(query);
  if (!q) return countyOptions();
  return countyOptions().filter((o) => o.folded.includes(q) || o.note.toLowerCase() === q);
}

let localitiesPromise = null;
export function loadLocalities() {
  if (!localitiesPromise) {
    localitiesPromise = import('./roLocalities.json')
      .then((mod) => {
        const data = mod.default || mod;
        // Folded once, for a search that doesn't care about diacritics.
        const index = {};
        for (const [plate, names] of Object.entries(data)) {
          const countyName = COUNTY_BY_PLATE.get(plate.toLowerCase()) || plate;
          index[plate] = names.map((name, rank) => ({ name, folded: fold(name), countyName, plate, rank }));
        }
        return index;
      })
      .catch(() => { localitiesPromise = null; return null; });
  }
  return localitiesPromise;
}

// Which county's localities a city is picked from, given what "County / sector"
// holds: a sector (or București) means the capital; a county, that county; and
// anything else — empty, foreign, half-typed — means the whole country.
export function plateForCountyValue(countyValue) {
  const seen = classifyCounty(countyValue, '');
  if (seen.kind === 'sector') return 'B';
  if (seen.kind === 'county') return plateOf(seen.value);
  return '';
}

// Rows for the city picker. Names that START with the query first, then names
// that contain it; each list is already biggest-first, so "Cluj" offers
// Cluj-Napoca before a village. Capped — the list is searched, not scrolled.
export function searchLocalities(index, plate, query, limit = 80) {
  if (!index) return { rows: [], more: false };
  const q = fold(query);
  // The whole country with nothing typed is 13,851 rows of nothing useful.
  if (!q && !(plate && index[plate])) return { rows: [], more: true };
  const pools = plate && index[plate] ? [index[plate]] : Object.values(index);
  const starts = [];
  const contains = [];
  for (const pool of pools) {
    for (const item of pool) {
      if (!q) { starts.push(item); continue; }
      const at = item.folded.indexOf(q);
      if (at === 0) starts.push(item);
      else if (at > 0) contains.push(item);
    }
  }
  const whole = !(plate && index[plate]);
  // Across the whole country there is no single size order, but each county's
  // list is biggest-first — so a place's RANK in its own county stands in for
  // its size, and "timis" offers Timișoara before Timișu de Jos.
  if (whole) { starts.sort((a, b) => a.rank - b.rank); contains.sort((a, b) => a.rank - b.rank); }
  const all = starts.concat(contains);
  return {
    more: all.length > limit,
    rows: all.slice(0, limit).map((item) => ({
      key: `${item.plate}:${item.name}`,
      value: item.name,
      label: item.name,
      // Searching the whole country: say WHERE, the same name is in many counties.
      note: whole ? item.countyName : '',
      countyName: item.countyName,
    })),
  };
}
