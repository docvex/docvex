// How OFFICIAL a document is — what decides between files that disagree about
// a person or a company. An identity card outranks a government register,
// which outranks a notarised act, which outranks a signed contract, which
// outranks everything else (an e-mail, a chat, a draft, a note):
//   5  identity documents — carte de identitate / CEI / buletin, passport,
//      driving licence, residence permit, civil-status certificates;
//   4  state records — the trade register (ONRC certificate, "furnizare
//      informații"), ANAF, the land register (ANCPI, extras CF), a ministry
//      (Ministerul Justiției…), the Monitorul Oficial, a court's decision, a
//      town hall, the police, the prefecture;
//   3  notarised / authenticated acts;
//   2  signed contracts, addenda, reports, declarations, powers of attorney,
//      invoices, receipts;
//   1  anything else.
// Read off what the scan understood of the file (its document type, subject,
// whether it is an identity document) and its name. Words are folded (no
// diacritics, lower case).
const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export const AUTHORITY_LEVELS = [
  { score: 5, label: 'Identity document', re: /carte (electronica )?de identitate|cartea de identitate|\bbuletin|pasaport|passport|permis (de conducere|de sedere)|driving licen|residence permit|identity card|certificat de (nastere|casatorie|deces)|birth certificate|marriage certificate/ },
  { score: 4, label: 'State record', re: /registrul comertului|\bonrc\b|certificat(ul)? de inregistrare|certificat constatator|furnizare (de )?informatii|\banaf\b|certificat (de atestare )?fiscal|atestare fiscal|cart(e|ii)(a)? funciar|\bancpi\b|extras (de )?cf|oficiul de cadastru|ministerul|monitorul oficial|hotarare(a)? (judecatoreasca|civila|penala|nr)|sentint|decizi(a|e) (civila|penala|nr)|incheiere(a)? (civila|penala|de sedinta)|\btribunal|judecatori|curtea de apel|inalta curte|primari|consiliul (local|judetean)|\bpolitia|inspectoratul|prefectur|directia (generala )?de evidenta|\bspclep\b|\bdgep|court (decision|ruling)|land regist|trade regist/ },
  { score: 3, label: 'Notarised act', re: /notar|autentificat|incheiere de autentificare|act autentic|legalizat|notari(al|zed)/ },
  { score: 2, label: 'Signed document', re: /contract|act aditional|addend|proces.?verbal|declarati|imputernicire|procura|factur|invoice|chitant|receipt|adeverint|certificat/ },
];
const OTHER = { score: 1, label: 'Other document' };

// `f` = { name, u } (a scanned file: its name and what the scan understood).
export function documentAuthority(f) {
  const u = f?.u || f?.understanding || {};
  if (u.idDocument || u.roId?.document_type) return AUTHORITY_LEVELS[0];
  const hay = fold(`${u.documentType || ''} ${u.subject || ''} ${f?.name || ''}`);
  return AUTHORITY_LEVELS.find((l) => l.re.test(hay)) || OTHER;
}

// The rule the AI prompts carry, so the model resolves disagreements the same way.
export const AUTHORITY_RULE = 'When files disagree about a person or a company (name, CNP / CUI, date of birth, address, registration number…), take the value from the MOST OFFICIAL document: first an identity document (carte de identitate, passport, civil-status certificate), then a state record (trade register / ONRC, ANAF, land register / ANCPI, a ministry, a court decision, a town hall), then a notarised act, then a signed contract — never from an e-mail, a chat, a note or a draft when an official document states it.';
