// Citizenships an identity record can hold — a FIXED list, because the value
// goes into a Romanian clause as it stands ("cetățenie română") and free text
// gave the same citizenship five spellings. `value` is the Romanian adjective in
// the feminine, agreeing with "cetățenie"; `label` / `country` are what the
// picker shows beside it and what a search can find it by.
//
// Romania and its neighbours first (that is who the records are about), then
// the rest of Europe, then the wider world — including the countries most
// residence permits in Romania are issued to. Not every state on earth: one
// that is missing is a line to add here, not a reason to go back to free text.
export const NATIONALITIES = [
  { value: 'română', label: 'Romanian', country: 'Romania' },
  { value: 'moldovenească', label: 'Moldovan', country: 'Moldova' },
  { value: 'ucraineană', label: 'Ukrainian', country: 'Ukraine' },
  { value: 'bulgară', label: 'Bulgarian', country: 'Bulgaria' },
  { value: 'maghiară', label: 'Hungarian', country: 'Hungary' },
  { value: 'sârbă', label: 'Serbian', country: 'Serbia' },

  { value: 'albaneză', label: 'Albanian', country: 'Albania' },
  { value: 'austriacă', label: 'Austrian', country: 'Austria' },
  { value: 'belarusă', label: 'Belarusian', country: 'Belarus' },
  { value: 'belgiană', label: 'Belgian', country: 'Belgium' },
  { value: 'bosniacă', label: 'Bosnian', country: 'Bosnia and Herzegovina' },
  { value: 'britanică', label: 'British', country: 'United Kingdom' },
  { value: 'cehă', label: 'Czech', country: 'Czechia' },
  { value: 'cipriotă', label: 'Cypriot', country: 'Cyprus' },
  { value: 'croată', label: 'Croatian', country: 'Croatia' },
  { value: 'daneză', label: 'Danish', country: 'Denmark' },
  { value: 'elvețiană', label: 'Swiss', country: 'Switzerland' },
  { value: 'estonă', label: 'Estonian', country: 'Estonia' },
  { value: 'finlandeză', label: 'Finnish', country: 'Finland' },
  { value: 'franceză', label: 'French', country: 'France' },
  { value: 'germană', label: 'German', country: 'Germany' },
  { value: 'greacă', label: 'Greek', country: 'Greece' },
  { value: 'irlandeză', label: 'Irish', country: 'Ireland' },
  { value: 'islandeză', label: 'Icelandic', country: 'Iceland' },
  { value: 'italiană', label: 'Italian', country: 'Italy' },
  { value: 'kosovară', label: 'Kosovar', country: 'Kosovo' },
  { value: 'letonă', label: 'Latvian', country: 'Latvia' },
  { value: 'lituaniană', label: 'Lithuanian', country: 'Lithuania' },
  { value: 'luxemburgheză', label: 'Luxembourgish', country: 'Luxembourg' },
  { value: 'macedoneană', label: 'Macedonian', country: 'North Macedonia' },
  { value: 'malteză', label: 'Maltese', country: 'Malta' },
  { value: 'muntenegreană', label: 'Montenegrin', country: 'Montenegro' },
  { value: 'norvegiană', label: 'Norwegian', country: 'Norway' },
  { value: 'olandeză', label: 'Dutch', country: 'Netherlands' },
  { value: 'poloneză', label: 'Polish', country: 'Poland' },
  { value: 'portugheză', label: 'Portuguese', country: 'Portugal' },
  { value: 'rusă', label: 'Russian', country: 'Russia' },
  { value: 'slovacă', label: 'Slovak', country: 'Slovakia' },
  { value: 'slovenă', label: 'Slovenian', country: 'Slovenia' },
  { value: 'spaniolă', label: 'Spanish', country: 'Spain' },
  { value: 'suedeză', label: 'Swedish', country: 'Sweden' },
  { value: 'turcă', label: 'Turkish', country: 'Turkey' },

  { value: 'afgană', label: 'Afghan', country: 'Afghanistan' },
  { value: 'algeriană', label: 'Algerian', country: 'Algeria' },
  { value: 'americană', label: 'American', country: 'United States' },
  { value: 'argentiniană', label: 'Argentine', country: 'Argentina' },
  { value: 'armeană', label: 'Armenian', country: 'Armenia' },
  { value: 'australiană', label: 'Australian', country: 'Australia' },
  { value: 'azeră', label: 'Azerbaijani', country: 'Azerbaijan' },
  { value: 'bangladeză', label: 'Bangladeshi', country: 'Bangladesh' },
  { value: 'braziliană', label: 'Brazilian', country: 'Brazil' },
  { value: 'cameruneză', label: 'Cameroonian', country: 'Cameroon' },
  { value: 'canadiană', label: 'Canadian', country: 'Canada' },
  { value: 'chiliană', label: 'Chilean', country: 'Chile' },
  { value: 'chineză', label: 'Chinese', country: 'China' },
  { value: 'columbiană', label: 'Colombian', country: 'Colombia' },
  { value: 'cubaneză', label: 'Cuban', country: 'Cuba' },
  { value: 'egipteană', label: 'Egyptian', country: 'Egypt' },
  { value: 'etiopiană', label: 'Ethiopian', country: 'Ethiopia' },
  { value: 'filipineză', label: 'Filipino', country: 'Philippines' },
  { value: 'georgiană', label: 'Georgian', country: 'Georgia' },
  { value: 'ghaneză', label: 'Ghanaian', country: 'Ghana' },
  { value: 'indiană', label: 'Indian', country: 'India' },
  { value: 'indoneziană', label: 'Indonesian', country: 'Indonesia' },
  { value: 'iordaniană', label: 'Jordanian', country: 'Jordan' },
  { value: 'irakiană', label: 'Iraqi', country: 'Iraq' },
  { value: 'iraniană', label: 'Iranian', country: 'Iran' },
  { value: 'israeliană', label: 'Israeli', country: 'Israel' },
  { value: 'japoneză', label: 'Japanese', country: 'Japan' },
  { value: 'kazahă', label: 'Kazakh', country: 'Kazakhstan' },
  { value: 'kenyană', label: 'Kenyan', country: 'Kenya' },
  { value: 'libaneză', label: 'Lebanese', country: 'Lebanon' },
  { value: 'libiană', label: 'Libyan', country: 'Libya' },
  { value: 'marocană', label: 'Moroccan', country: 'Morocco' },
  { value: 'mexicană', label: 'Mexican', country: 'Mexico' },
  { value: 'neozeelandeză', label: 'New Zealander', country: 'New Zealand' },
  { value: 'nepaleză', label: 'Nepali', country: 'Nepal' },
  { value: 'nigeriană', label: 'Nigerian', country: 'Nigeria' },
  { value: 'pakistaneză', label: 'Pakistani', country: 'Pakistan' },
  { value: 'peruană', label: 'Peruvian', country: 'Peru' },
  { value: 'saudită', label: 'Saudi', country: 'Saudi Arabia' },
  { value: 'siriană', label: 'Syrian', country: 'Syria' },
  { value: 'srilankeză', label: 'Sri Lankan', country: 'Sri Lanka' },
  { value: 'sud-africană', label: 'South African', country: 'South Africa' },
  { value: 'sud-coreeană', label: 'South Korean', country: 'South Korea' },
  { value: 'thailandeză', label: 'Thai', country: 'Thailand' },
  { value: 'tunisiană', label: 'Tunisian', country: 'Tunisia' },
  { value: 'venezueleană', label: 'Venezuelan', country: 'Venezuela' },
  { value: 'vietnameză', label: 'Vietnamese', country: 'Vietnam' },

  // Not a citizenship, but what a document says when there is none.
  { value: 'apatrid', label: 'Stateless', country: 'No citizenship' },
];

const fold = (s) => String(s ?? '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z]+/g, ' ').trim();

const BY_FOLDED = new Map();
for (const n of NATIONALITIES) {
  for (const key of [n.value, n.label, n.country]) {
    const f = fold(key);
    if (f && !BY_FOLDED.has(f)) BY_FOLDED.set(f, n.value);
  }
}
// How the same citizenship turns up in documents and older records.
for (const [alias, value] of [
  ['roman', 'română'], ['romana', 'română'], ['romaneasca', 'română'], ['rou', 'română'], ['ro', 'română'],
  ['moldoveana', 'moldovenească'], ['moldovean', 'moldovenească'], ['republica moldova', 'moldovenească'],
  ['ungara', 'maghiară'], ['ungureasca', 'maghiară'],
  ['neerlandeza', 'olandeză'], ['tarile de jos', 'olandeză'], ['olanda', 'olandeză'],
  ['engleza', 'britanică'], ['marea britanie', 'britanică'], ['regatul unit', 'britanică'], ['english', 'britanică'],
  ['sua', 'americană'], ['usa', 'americană'], ['statele unite', 'americană'],
  ['estoniana', 'estonă'], ['bielorusa', 'belarusă'], ['ucrainiana', 'ucraineană'],
  ['apatrida', 'apatrid'], ['fara cetatenie', 'apatrid'], ['stateless', 'apatrid'],
]) {
  if (!BY_FOLDED.has(alias)) BY_FOLDED.set(alias, value);
}

// Whatever was written → one of the values above, or '' when it is none of them
// (the caller keeps the original then, and the form shows it as written).
export function normalizeNationality(raw) {
  const f = fold(raw);
  if (!f) return '';
  return BY_FOLDED.get(f) || BY_FOLDED.get(f.replace(/^cetatenie\s+|^cetatean\s+/, '')) || '';
}

export function searchNationalities(query) {
  const q = fold(query);
  const rows = NATIONALITIES.map((n) => ({ key: n.value, value: n.value, label: n.value, note: n.country }));
  if (!q) return rows;
  return rows.filter((r, i) => {
    const n = NATIONALITIES[i];
    return fold(n.value).includes(q) || fold(n.label).includes(q) || fold(n.country).includes(q);
  });
}
