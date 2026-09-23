// The Constructor's own words, in the two languages its toggle offers.
//
// The rest of the app isn't translated yet (AppPrefs' `language` is a
// placeholder), so this is local to the Constructor rather than the start of an
// app-wide i18n layer: a lawyer reading a Romanian contract wants "CNP" and
// "Reprezentant" beside it, whatever the chrome around it says.
//
// What is NOT translated: the document. Section titles, party names, clause
// numbers and free-text blanks ("prețul în lei") are the document's own words
// and are shown as written.

export const CONSTRUCTOR_LANGS = [
  { id: 'en', label: 'EN', name: 'English' },
  { id: 'ro', label: 'RO', name: 'Română' },
];

const STRINGS = {
  en: {
    language: 'Language',
    drafting: 'Drafting…',
    nothingToFill: 'Nothing to fill in',
    filledOf: (a, b) => `${a} of ${b} filled in`,
    save: 'Save to document',
    saving: 'Saving…',
    preparing: 'Preparing the document',
    emptyTitle: 'Nothing to build from yet',
    emptySub: 'Ask the AI advisor for a document and what needs filling in appears here.',
    nothingSub: 'This document has no parties or blanks left open. Its text is in the Word preview.',
    fixedWording: 'Fixed wording',
    fillIn: 'Fill in…',
    fromFile: (file) => `From ${file}`,
    fromRecord: 'From an identity record',
    organisation: 'Organisation',
    individual: 'Individual',
    detailsFilled: (a, b) => `${a} of ${b} details filled in`,
    noOne: 'No one assigned yet',
    stateRecord: 'Identity record',
    stateChoose: 'Fill from an identity',
    stateByHand: 'Filled in by hand',
    identities: 'Identities',
    recordsInProject: (n) => `${n} record${n === 1 ? '' : 's'} in this project`,
    custom: 'Custom',
    customMeta: 'Type the details yourself',
    saveAsIdentity: 'Save as identity',
    saveAsIdentityTip: 'Save these details as an identity record, so the next document fills from it',
    noRecords: 'No identity records in this project yet. Add one from the Files tab — Create → Identity, or right-click a document → Create identity.',
    minimise: 'Minimise',
    maximise: 'Maximise',
    notAssigned: 'Not assigned yet',
    followsParty: 'Follows the party',
    notLinked: 'Not linked',
    openParty: 'open party',
    party: 'Party',
  },
  ro: {
    language: 'Limbă',
    drafting: 'Se redactează…',
    nothingToFill: 'Nimic de completat',
    filledOf: (a, b) => `${a} din ${b} completate`,
    save: 'Salvează în document',
    saving: 'Se salvează…',
    preparing: 'Se pregătește documentul',
    emptyTitle: 'Încă nu există din ce construi',
    emptySub: 'Cere-i asistentului AI un document, iar ce trebuie completat apare aici.',
    nothingSub: 'Documentul nu mai are părți sau spații de completat. Textul lui se vede în previzualizarea Word.',
    fixedWording: 'Text fix',
    fillIn: 'Completează…',
    fromFile: (file) => `Din ${file}`,
    fromRecord: 'Dintr-o fișă de identitate',
    organisation: 'Persoană juridică',
    individual: 'Persoană fizică',
    detailsFilled: (a, b) => `${a} din ${b} date completate`,
    noOne: 'Nicio persoană atribuită',
    stateRecord: 'Fișă de identitate',
    stateChoose: 'Completează dintr-o identitate',
    stateByHand: 'Completat manual',
    identities: 'Identități',
    recordsInProject: (n) => (n === 1 ? '1 fișă în acest proiect' : `${n} fișe în acest proiect`),
    custom: 'Personalizat',
    customMeta: 'Completezi datele manual',
    saveAsIdentity: 'Salvează ca identitate',
    saveAsIdentityTip: 'Salvează aceste date ca fișă de identitate, ca următorul document să se completeze din ea',
    noRecords: 'Proiectul nu are încă fișe de identitate. Adaugă una din Fișiere — Create → Identity, sau clic dreapta pe un document → Create identity.',
    minimise: 'Minimizează',
    maximise: 'Maximizează',
    notAssigned: 'Încă neatribuit',
    followsParty: 'Urmează partea',
    notLinked: 'Nelegat',
    openParty: 'deschide partea',
    party: 'Parte',
  },
};

// What a record field is called above its input. English comes from the model
// (lib/docConstructor › FIELD_LABELS); this is the Romanian a contract uses.
const FIELD_LABELS_RO = {
  legalName: 'Nume / denumire', lastName: 'Nume', firstName: 'Prenume', aka: 'Cunoscut(ă) și ca', nationalId: 'CNP', dateOfBirth: 'Data nașterii',
  placeOfBirth: 'Locul nașterii', nationality: 'Cetățenie', idType: 'Tip act',
  idDocument: 'Act de identitate', idSeries: 'Serie', idNumber: 'Număr act', idIssuer: 'Eliberat de',
  idIssuedAt: 'Data eliberării', taxId: 'CUI', regNo: 'Nr. Registrul Comerțului', legalForm: 'Formă juridică',
  representative: 'Reprezentant', repCapacity: 'Calitatea reprezentantului', iban: 'IBAN', bank: 'Banca',
  address: 'Adresă', addressStreet: 'Stradă', addressNumber: 'Număr', addressBlock: 'Bloc',
  addressStair: 'Scară', addressFloor: 'Etaj', addressApartment: 'Apartament',
  addressLocality: 'Localitate', addressCounty: 'Județ', addressSector: 'Sector',
  addressCountyOrSector: 'Județ / sector', addressPostalCode: 'Cod poștal',
  city: 'Localitate', county: 'Județ', country: 'Țară', email: 'E-mail', phone: 'Telefon',
};

export function constructorStrings(lang) {
  return STRINGS[lang] || STRINGS.en;
}

// A field's label in `lang`. A free-text blank has no key — its label is the
// document's own words, which are never translated.
export function fieldLabelIn(field, lang) {
  if (lang === 'ro' && field?.key && FIELD_LABELS_RO[field.key]) return FIELD_LABELS_RO[field.key];
  return field?.label || '';
}

// What stands in an unfilled party field: an example of the value, in the form
// a Romanian document writes it. The examples are the same in both languages —
// they are data, not labels — except where the example is itself a word.
const FIELD_PLACEHOLDERS = {
  legalName: { en: 'e.g. Popescu Ion / SC Exemplu SRL', ro: 'ex. Popescu Ion / SC Exemplu SRL' },
  aka: { en: 'Other name used', ro: 'Alt nume folosit' },
  nationalId: '13 cifre', dateOfBirth: 'zz.ll.aaaa', placeOfBirth: { en: 'e.g. Cluj-Napoca', ro: 'ex. Cluj-Napoca' },
  nationality: { en: 'e.g. română', ro: 'ex. română' }, idType: 'CI',
  idDocument: { en: 'e.g. CI seria RX nr. 123456', ro: 'ex. CI seria RX nr. 123456' },
  idSeries: 'RX', idNumber: '123456', idIssuer: { en: 'e.g. SPCLEP Sector 1', ro: 'ex. SPCLEP Sector 1' },
  idIssuedAt: 'zz.ll.aaaa', taxId: 'RO12345678', regNo: 'J40/1234/2020', legalForm: 'SRL',
  representative: { en: 'e.g. Ionescu Maria', ro: 'ex. Ionescu Maria' },
  repCapacity: { en: 'e.g. administrator', ro: 'ex. administrator' },
  iban: 'RO49 AAAA 1B31 0075 9384 0000', bank: { en: 'e.g. Banca Transilvania', ro: 'ex. Banca Transilvania' },
  address: { en: 'Street, number, locality, county', ro: 'Stradă, număr, localitate, județ' },
  addressStreet: { en: 'e.g. Str. Lalelelor', ro: 'ex. Str. Lalelelor' },
  addressNumber: '12', addressBlock: 'A1', addressStair: 'B', addressFloor: '3', addressApartment: '14',
  addressLocality: { en: 'e.g. București', ro: 'ex. București' }, addressCounty: { en: 'e.g. Cluj', ro: 'ex. Cluj' },
  addressSector: '1–6', addressCountyOrSector: { en: 'e.g. Cluj / Sector 1', ro: 'ex. Cluj / Sector 1' },
  addressPostalCode: '010101', city: { en: 'e.g. București', ro: 'ex. București' },
  county: { en: 'e.g. Cluj', ro: 'ex. Cluj' }, country: 'România',
  email: 'nume@exemplu.ro', phone: '07xx xxx xxx',
};
export function fieldPlaceholderIn(field, lang) {
  const ph = FIELD_PLACEHOLDERS[field?.key];
  if (!ph) return '';
  return typeof ph === 'string' ? ph : (ph[lang] || ph.en);
}

const LANG_KEY = 'docvex.constructor.lang';
export function readConstructorLang() {
  try {
    const v = localStorage.getItem(LANG_KEY);
    return v === 'ro' || v === 'en' ? v : 'en';
  } catch {
    return 'en';
  }
}
export function writeConstructorLang(lang) {
  try { localStorage.setItem(LANG_KEY, lang); } catch { /* private window — the choice lasts the session */ }
}
