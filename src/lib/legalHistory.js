// ROMANIAN LEGAL HISTORY — reading a document in the law of its own time.
//
// A property file routinely reaches back through a 1960s decree, an interwar
// sale transcribed in a tribunal's register and a 19th-century act of
// partition; a zapis from 1750 can still decide who owns a field. This module
// reads any text LOCALLY (no AI, no network) and answers:
//   • `detectLegalEra(text)` — which legal era it was written under, from its
//     dates (incl. the Byzantine "leat 7250" years), its script (Cyrillic, the
//     1830–1860 transitional alphabet, Latin) and its vocabulary;
//   • `findLegalTerms(text)` — every archaic / historical legal term in it, each
//     mapped to the modern concept and what it implies (LEXICON);
//   • `findPropertyRisks(text)` — the title risks a lawyer must check (a dotal
//     immovable, land held only in use, an expropriation or confiscation decree,
//     an unauthenticated zapis, protimisis, the 1974 ban on selling land…),
//     with the decree numbers pulled out for restitution claims;
//   • `findLandMeasures(text)` — historical land measures converted to m² / ha
//     (pogon, fălcie, prăjină, stânjen pătrat, jugăr…), region-aware;
//   • `analyzeLegalHistory(text)` — all of it as one `historical_legal_analysis`
//     block, and `legalHistoryNote(analysis)` — the same as a short note the AI
//     prompts carry, so the model reads the document in its era.
// The lexicon and the risks are written in Romanian: they are read by lawyers.
import { roRx } from './roIdDocuments';

const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// ── The eras ───────────────────────────────────────────────────────────
export const LEGAL_ERAS = [
  {
    id: 'ERA_1_FEUDAL', from: 1500, to: 1831, label: 'Epoca feudală și a dreptului cutumiar (1500–1831)',
    codes: 'Obiceiul pământului (Jus Valachicum); Pravila lui Vasile Lupu (Carte românească de învățătură, Moldova, 1646); Îndreptarea legii (Pravila lui Matei Basarab, Țara Românească, 1652); Pravilniceasca condică (1780); Codul Calimach (Moldova, 1817); Legiuirea Caragea (Țara Românească, 1818)',
    note: 'Drept în mare parte nescris, bizantin și religios; voința Domnului. Societate stratificată (boieri, cler, moșneni/răzeși, rumâni/vecini). Acte în slavonă sau română cu litere chirilice (hrisov, uric, zapis, carte domnească). Anii se scriu adesea de la facerea lumii („leat 7250” = 1741/1742).',
  },
  {
    id: 'ERA_2_TRANSITIONAL', from: 1831, to: 1864, label: 'Epoca Regulamentelor Organice și a tranziției (1831–1864)',
    codes: 'Regulamentele Organice (1831–1832); Codul Calimach (Moldova, 1817) și Legiuirea Caragea (Țara Românească, 1818), încă în vigoare',
    note: 'Separație rudimentară a puterilor, birocrație și registre fiscale. Alfabetul de tranziție (litere latine amestecate cu chirilice). Apar contracte individuale, testamente și acte imobiliare în arhivele instanțelor.',
  },
  {
    id: 'ERA_3_INTERWAR', from: 1864, to: 1948, label: 'Vechiul Regat și perioada interbelică (1864–1947)',
    codes: 'Codul civil din 1864 (Alexandru Ioan Cuza, după Codul Napoleon), în vigoare până în 2011; Constituțiile din 1866, 1923 și 1938; în Transilvania și Bucovina, Codul civil austriac și cartea funciară',
    note: 'Drept secularizat, proprietate privată garantată. Terminologie de sorginte franceză (dotă, uzufruct, transcripțiune). Publicitatea imobiliară: registrele de transcripțiuni și inscripțiuni ale tribunalelor (Vechiul Regat) sau cartea funciară (Transilvania).',
  },
  {
    id: 'ERA_4_COMMUNIST', from: 1948, to: 1990, label: 'Dreptul socialist (1948–1989)',
    codes: 'Constituțiile din 1948, 1952 și 1965; Codul familiei (1954); Codul civil din 1864, aplicat în spiritul „legalității socialiste”; decretele de naționalizare, expropriere și confiscare (Decretul 83/1949, Decretul 92/1950, Decretul 111/1951, Decretul 223/1974); Legile 58/1974 și 59/1974',
    note: 'Proprietate socialistă (de stat și cooperatistă), cooperativizarea agriculturii (CAP), naționalizări și confiscări, interdicția înstrăinării terenurilor între vii (1974–1989). Terminologie: proprietate socialistă, CAP, repartiție, decizie administrativă.',
  },
  {
    id: 'ERA_5_POSTCOMMUNIST', from: 1990, to: 2007, label: 'Perioada postcomunistă (1990–2006)',
    codes: 'Constituția din 1991 (revizuită în 2003); Codul civil din 1864; legile fondului funciar și ale restituirii (Legea 18/1991, Legea 112/1995, Legea 1/2000, Legea 10/2001, Legea 247/2005)',
    note: 'Revenirea la dreptul civil romano-germanic și la proprietatea privată; titluri de proprietate, retrocedări, privatizări, rectificări de carte funciară.',
  },
  {
    id: 'ERA_6_EU', from: 2007, to: 9999, label: 'Integrarea europeană și epoca digitală (2007–prezent)',
    codes: 'Dreptul Uniunii Europene (prioritar față de dreptul intern contrar, art. 148 din Constituție); Codul civil (2011); Codul penal (2014); Codul de procedură civilă (2013); GDPR; legislația semnăturii electronice',
    note: 'Documente electronice cu semnături calificate, formate europene standardizate, cartea funciară informatizată (ANCPI).',
  },
];
const eraOfYear = (y) => LEGAL_ERAS.find((e) => y >= e.from && y < e.to) || null;

// Vocabulary that points to an era (words written without diacritics; roRx
// matches every spelling). Weight = how strongly.
const ERA_WORDS = {
  ERA_1_FEUDAL: [['hrisov', 3], ['uric\\b', 2], ['zapis', 2], ['carte domneasca', 3], ['anafora', 2], ['diata\\b', 2], ['vornic', 2], ['logofat', 2], ['spatar\\b', 2], ['vistier', 2], ['rumani?\\b', 2], ['vecini de mosie', 2], ['megies', 2], ['razes', 2], ['mosnean', 2], ['ocin[aei]\\b', 2], ['bastina', 1], ['delnit', 3], ['protimis', 3], ['leat\\b', 3], ['voievod', 2], ['domnul tarii', 2], ['pravil[aei]\\b', 1], ['dajdi', 2], ['bir(?:ul|uri)?\\b', 1], ['dijm[aei]\\b', 1], ['clacas', 2]],
  ERA_2_TRANSITIONAL: [['regulamentul organic', 4], ['regulamentele organice', 4], ['jalb[aei]\\b', 2], ['bilet de trecere', 3], ['divanul\\b', 2], ['judecatoria tinutului', 3], ['ispravnic', 3], ['sfatul administrativ', 3], ['clacasi', 2]],
  ERA_3_INTERWAR: [['foaie de zestre', 3], ['dot[aei]\\b', 2], ['dotal', 3], ['act de vesnica vanzare', 3], ['vesnica vanzare', 3], ['transcriptiun', 3], ['inscriptiun', 3], ['tribunalul (?:judetului )?\\p{L}+,? sectia', 2], ['regatul romaniei', 3], ['majestatea sa regele', 3], ['portarei', 2], ['lei aur', 2], ['improprietarire', 2], ['legea agrara', 2]],
  ERA_4_COMMUNIST: [['proprietate socialista', 4], ['republica populara romana', 4], ['r\\.p\\.r\\.', 2], ['republica socialista romania', 4], ['r\\.s\\.r\\.', 2], ['cooperativa agricola de productie', 3], ['c\\.a\\.p\\.', 2], ['sfatul popular', 3], ['consiliul popular', 3], ['comitetul executiv', 2], ['repartiti', 2], ['decret(?:ul)? nr\\.?\\s*\\d+\\s*/\\s*19[4-8]\\d', 3], ['oclpo', 3], ['icral', 3], ['in folosinta pe durata constructiei', 4], ['trecut in proprietatea statului', 4], ['tovaras', 1], ['colectivizar', 2]],
  ERA_5_POSTCOMMUNIST: [['titlu de proprietate', 3], ['legea (?:nr\\.? )?18/1991', 4], ['legea (?:nr\\.? )?10/2001', 4], ['legea (?:nr\\.? )?112/1995', 4], ['legea (?:nr\\.? )?1/2000', 3], ['legea (?:nr\\.? )?247/2005', 3], ['comisia (?:locala|judeteana) de fond funciar', 3], ['retroced', 2], ['fond funciar', 2], ['lei rol', 2]],
  ERA_6_EU: [['noul cod civil', 3], ['legea (?:nr\\.? )?287/2009', 3], ['cod(?:ul)? civil.{0,20}2009', 2], ['gdpr', 3], ['regulamentul \\(ue\\)', 3], ['semnatura electronica', 2], ['semnatura electronica calificata', 3], ['ancpi', 2], ['e-factura', 3], ['euid', 2], ['codul de procedura civila', 1], ['uniunea europeana', 2], ['ghiseul\\.ro', 3]],
};
const ERA_RX = Object.fromEntries(Object.entries(ERA_WORDS).map(([id, list]) => [id, list.map(([w, n]) => [roRx(`\\b${w}`, 'giu'), n])]));

// The script: Cyrillic, the transitional alphabet (Latin with some Cyrillic
// letters mixed in, 1830–1860), or Latin.
function scriptOf(text) {
  const t = String(text || '');
  const cyr = (t.match(/[Ѐ-ӿԀ-ԯ]/g) || []).length;
  const lat = (t.match(/[A-Za-zĂÂÎȘȚăâîșț]/g) || []).length;
  if (!cyr) return 'latin';
  if (cyr > lat * 1.5) return 'cyrillic';
  return 'transitional';
}

// The years a text is DATED in: "leat 7250" (from the creation of the world,
// −5508/5509), four-digit years 1500–today. A document date ("București, 12
// martie 1952", "Data: …") counts more than a year merely mentioned.
function yearsOf(text) {
  const t = fold(text);
  const out = [];
  for (const m of t.matchAll(/\bleat(?:ul)?\s*(7\d{3})\b/g)) out.push({ year: Number(m[1]) - 5508, weight: 4, raw: m[0] });
  const now = new Date().getFullYear();
  for (const m of t.matchAll(/(?<!\d)(1[5-9]\d\d|20[0-4]\d)(?!\d)/g)) {
    const y = Number(m[1]);
    if (y > now) continue;
    const before = t.slice(Math.max(0, m.index - 30), m.index);
    // A date written as a date, not a law's number/year or a lot number.
    const isDate = /(\d{1,2}\s*[./-]\s*\d{1,2}\s*[./-]\s*$)|(\b(ianuarie|februarie|martie|aprilie|mai|iunie|iulie|august|septembrie|octombrie|noiembrie|decembrie)\s*$)|(\b(anul|din anul|in anul)\s*$)/.test(before);
    const isAct = /\/\s*$|\bnr\.?\s*\d*\s*$/.test(before);
    out.push({ year: y, weight: isDate ? 3 : isAct ? 0.5 : 1, raw: m[0] });
  }
  return out;
}

// → { era, label, confidence (0–1), script, year, signals: [...] }
export function detectLegalEra(text, { date = null } = {}) {
  const score = Object.fromEntries(LEGAL_ERAS.map((e) => [e.id, 0]));
  const signals = [];
  const script = scriptOf(text);
  if (script === 'cyrillic') { score.ERA_1_FEUDAL += 4; score.ERA_2_TRANSITIONAL += 1; signals.push('Scris cu litere chirilice'); }
  if (script === 'transitional') { score.ERA_2_TRANSITIONAL += 5; signals.push('Alfabetul de tranziție (latin și chirilic amestecat)'); }
  // A known date (the file's own, or given by the caller) outranks the text.
  const years = yearsOf(text);
  if (date) { const y = new Date(date).getFullYear(); if (y > 1400) years.push({ year: y, weight: 6, raw: String(date) }); }
  // The DOCUMENT's date is the latest one it is written on (an act cites
  // older acts, never newer ones): the heaviest-weighted latest year.
  const dated = years.filter((y) => y.weight >= 3);
  const pool = dated.length ? dated : years.filter((y) => y.weight >= 1);
  const year = pool.length ? Math.max(...pool.map((y) => y.year)) : null;
  if (year) {
    const e = eraOfYear(year);
    if (e) { score[e.id] += dated.length ? 6 : 3; signals.push(`Datat ${year}`); }
  }
  for (const [id, list] of Object.entries(ERA_RX)) {
    for (const [rx, n] of list) {
      rx.lastIndex = 0;
      const hits = String(text || '').match(rx);
      if (hits && n) { score[id] += n * Math.min(3, hits.length); signals.push(`„${hits[0].trim()}”`); }
    }
  }
  const ranked = Object.entries(score).sort((a, b) => b[1] - a[1]);
  const [best, top] = ranked[0];
  if (!top) return { era: null, label: '', confidence: 0, script, year, signals: [] };
  const total = ranked.reduce((n, [, v]) => n + v, 0);
  const e = LEGAL_ERAS.find((x) => x.id === best);
  return { era: best, label: e.label, codes: e.codes, note: e.note, confidence: Math.round((top / total) * 100) / 100, script, year, signals: [...new Set(signals)].slice(0, 12) };
}

// ── The lexicon ────────────────────────────────────────────────────────
// Each: the forms it takes (no diacritics — roRx adds them), the era(s), the
// modern concept, and what it implies for a lawyer today.
export const LEXICON = [
  // A. Feudal & customary law (1500–1831)
  { id: 'zapis', forms: ['zapis(?:ul|uri|urile)?', 'izvod(?:ul)?'], eras: ['ERA_1_FEUDAL', 'ERA_2_TRANSITIONAL'], modern: 'Înscris sub semnătură privată / act consensual (adesea antecontractual)', implication: 'Nu era autentificat: dovada proprietății depinde de martori, peceți și de confirmarea ulterioară (hrisov, hotărnicie, înscriere).' },
  { id: 'hrisov', forms: ['hrisov(?:ul|ul domnesc|ului)?', 'uric(?:ul)?', 'carte(?:a)? domneasca', 'carti domnesti'], eras: ['ERA_1_FEUDAL'], modern: 'Act de autoritate al Domnului: întărire (confirmare) de proprietate, danie, împroprietărire sau privilegiu', implication: 'Temei al proprietății prin voința suveranului; verifică dacă a fost întărit de domnii următori și cuprinderea hotarelor.' },
  { id: 'anafora', forms: ['anafora(?:ua)?'], eras: ['ERA_1_FEUDAL', 'ERA_2_TRANSITIONAL'], modern: 'Raport al Divanului / al dregătorilor către Domn, pe baza căruia se lua decizia (judecată sau administrativă)', implication: 'Nu este hotărârea însăși: caută rezoluția Domnului pe anafora.' },
  { id: 'diata', forms: ['diat(?:a|ă|ei|e)', 'diiata'], eras: ['ERA_1_FEUDAL', 'ERA_2_TRANSITIONAL'], modern: 'Testament / act unilateral de ultimă voință', implication: 'Verifică forma cerută de pravila vremii (martori, iscălituri) și dacă a fost „deschisă” și confirmată.' },
  { id: 'ocina', forms: ['ocin(?:a|ă|ei|e|i)', 'bastin(?:a|ă|ei|e)', 'mosi(?:e|a|ei|i|ile)'], eras: ['ERA_1_FEUDAL', 'ERA_2_TRANSITIONAL'], modern: 'Proprietate imobiliară patrimonială, dobândită prin moștenire (moșie = domeniu funciar)', implication: 'Dreptul se transmite pe linie de neam: reconstituie șirul succesiunilor până la titularul actual.' },
  { id: 'delnita', forms: ['delnit(?:a|ă|ei|e|i)'], eras: ['ERA_1_FEUDAL', 'ERA_2_TRANSITIONAL'], modern: 'Parcelă delimitată dintr-o proprietate stăpânită în devălmășie', implication: 'Individualizarea din devălmășie trebuie dovedită (hotărnicie, partaj).' },
  { id: 'devalmasie', forms: ['devalmas(?:ie|ia|ii|e)', 'in devalmasie'], eras: ['ERA_1_FEUDAL', 'ERA_2_TRANSITIONAL'], modern: 'Coproprietate în devălmășie (fără cote determinate)', implication: 'Fiecare devălmaș nu are o cotă proprie până la partaj: o vânzare separată poate fi contestată.' },
  { id: 'protimisis', forms: ['protimis(?:is|eos|ul)?', 'drept(?:ul)? de protimis'], eras: ['ERA_1_FEUDAL', 'ERA_2_TRANSITIONAL'], modern: 'Drept de preempțiune al rudelor și vecinilor (megieșilor) la cumpărarea pământului', implication: 'O vânzare făcută fără a oferi mai întâi rudelor și megieșilor putea fi desființată: verifică renunțările la protimisis.' },
  { id: 'rumani', forms: ['rumân(?:i|ii|ul)?', 'rumani(?:e)?', 'vecin(?:i|ii)(?=\\s+(?:ai|ale|lui|sai)\\s+(?:boier|manastir|domn))', 'vecini de mosie', 'clacas(?:i|ii|ul)?', 'clac(?:a|ă)'], eras: ['ERA_1_FEUDAL', 'ERA_2_TRANSITIONAL'], modern: 'Țăran dependent, fără libertate juridică deplină (rumânie / vecinie; după 1746–1749, clăcaș obligat la clacă și dijmă)', implication: 'Nu era proprietar al pământului lucrat; împroprietărirea a venit prin Legea rurală din 1864.' },
  { id: 'razes', forms: ['razes(?:i|ii|ul)?', 'mosnean(?:i|ii|ul)?', 'megies(?:i|ii|ul)?'], eras: ['ERA_1_FEUDAL', 'ERA_2_TRANSITIONAL'], modern: 'Țăran liber, proprietar (moșnean în Țara Românească, răzeș în Moldova); megieș = vecin de moșie', implication: 'Proprietate adesea în devălmășie cu neamul: caută partajele și hotărniciile.' },
  { id: 'bir', forms: ['bir(?:ul|uri)?', 'dajd(?:ie|ia|ii)', 'dijm(?:a|ă|ei)'], eras: ['ERA_1_FEUDAL', 'ERA_2_TRANSITIONAL'], modern: 'Impozit / obligație fiscală (dijma = a zecea parte din produse, datorată proprietarului sau statului)', implication: '' },
  { id: 'gloaba', forms: ['gloab(?:a|ă|e)'], eras: ['ERA_1_FEUDAL'], modern: 'Amendă', implication: '' },
  { id: 'carte-de-judecata', forms: ['carte(?:a)? de judecata', 'carti de judecata'], eras: ['ERA_1_FEUDAL', 'ERA_2_TRANSITIONAL'], modern: 'Hotărâre judecătorească', implication: 'Verifică dacă a rămas definitivă (reînfățișări, apel la Divan / Domn).' },
  { id: 'hotarnicie', forms: ['hotarnic(?:ie|ia|ii|ul)'], eras: ['ERA_1_FEUDAL', 'ERA_2_TRANSITIONAL', 'ERA_3_INTERWAR'], modern: 'Act de hotărnicie: stabilirea și marcarea hotarelor unei moșii (echivalentul istoric al documentației cadastrale)', implication: 'Principala dovadă a întinderii și a limitelor unei proprietăți vechi.' },
  { id: 'embatic', forms: ['embatic(?:ul)?', 'bezmen(?:ul)?'], eras: ['ERA_1_FEUDAL', 'ERA_2_TRANSITIONAL', 'ERA_3_INTERWAR'], modern: 'Emfiteoză: folosință perpetuă a terenului altuia, contra unei redevențe (embatic / bezmen)', implication: 'Cel care a construit nu era proprietarul terenului: verifică răscumpărarea embaticului.' },
  { id: 'danie', forms: ['dani(?:e|a|ei)', 'dania'], eras: ['ERA_1_FEUDAL', 'ERA_2_TRANSITIONAL'], modern: 'Donație', implication: '' },
  // B. Transitional (1831–1864)
  { id: 'jalba', forms: ['jalb(?:a|ă|ei|e)', 'anafora(?:ua)? de judecata'], eras: ['ERA_2_TRANSITIONAL', 'ERA_1_FEUDAL'], modern: 'Acțiune în justiție / cerere de chemare în judecată (jalba); raport judiciar către Domn (anaforaua)', implication: '' },
  { id: 'condica', forms: ['condic(?:a|ă|uta|uța|ii)', 'pravil(?:a|ă|ei|e|ele)'], eras: ['ERA_1_FEUDAL', 'ERA_2_TRANSITIONAL'], modern: 'Registru oficial (condica) / cod de legi (pravila: Codul Calimach, Legiuirea Caragea)', implication: '' },
  { id: 'bilet-de-trecere', forms: ['bilet(?:ul)? de trecere'], eras: ['ERA_2_TRANSITIONAL'], modern: 'Pașaport / act de liberă circulație', implication: '' },
  // C. Old Kingdom & interwar (1864–1947)
  { id: 'dota', forms: ['foaie(?:a)? de zestre', 'dot(?:a|ă|ei|ale)', 'dotal(?:a|ă|e)?', 'zestre(?:a)?'], eras: ['ERA_3_INTERWAR', 'ERA_2_TRANSITIONAL'], modern: 'Regim matrimonial dotal: bunurile aduse în căsătorie de soție (Codul civil 1864, art. 1233 și urm.)', implication: 'Imobilul dotal era inalienabil: soțul îl administra, dar nu-l putea înstrăina decât în cazurile și cu autorizarea prevăzute de lege.', risk: 'DOTAL_RESTRICTION' },
  { id: 'vesnica-vanzare', forms: ['act(?:ul)? de vesnica vanzare', 'vesnica vanzare', 'vesnic(?:a|ă) st[aă]p[aâ]nire'], eras: ['ERA_3_INTERWAR', 'ERA_2_TRANSITIONAL'], modern: 'Contract de vânzare-cumpărare a dreptului de proprietate deplină', implication: 'Opozabil terților doar dacă a fost transcris în registrul tribunalului (Vechiul Regat) sau intabulat (cartea funciară).' },
  { id: 'transcriptiune', forms: ['transcript(?:iune|iunea|iuni|iunile|ie)', 'transkript\\p{L}*', 'inscript(?:iune|iunea|iuni|iunile|ie)', 'inskript\\p{L}*', 'registrul de transcrip\\p{L}*'], eras: ['ERA_3_INTERWAR', 'ERA_4_COMMUNIST'], modern: 'Publicitate imobiliară prin transcriere (sistemul personal al registrelor de transcripțiuni și inscripțiuni, Vechiul Regat — înaintea cărții funciare)', implication: 'Caută actul în registrul tribunalului județului: ordinea transcrierii decide între doi cumpărători.' },
  { id: 'comunitate', forms: ['comunitate(?:a)? (?:legala|de bunuri)'], eras: ['ERA_4_COMMUNIST', 'ERA_5_POSTCOMMUNIST', 'ERA_6_EU'], modern: 'Regimul comunității de bunuri a soților', implication: 'Introdus de Codul familiei (1954); înainte de 1954, regula era separația bunurilor sau regimul dotal.' },
  { id: 'tribunal-judet', forms: ['tribunalul judetului\\s+\\p{L}+', 'tribunalul\\s+\\p{L}+\\s*,?\\s*sectia\\s+[ivx\\d]+'], eras: ['ERA_3_INTERWAR', 'ERA_4_COMMUNIST'], modern: 'Instanța de fond competentă material și teritorial (tribunalul județean de atunci)', implication: '' },
  { id: 'ipoteca', forms: ['bilet(?:ul)? de ipotec(?:a|ă)', 'inscriptiune ipotecara'], eras: ['ERA_3_INTERWAR'], modern: 'Act de constituire a unei ipoteci (garanție reală imobiliară)', implication: 'Verifică radierea inscripțiunii: o ipotecă neradiată grevează încă imobilul în registre.' },
  { id: 'improprietarire', forms: ['improprietarir(?:e|ea|ii)', 'legea agrara', 'reforma agrara'], eras: ['ERA_3_INTERWAR', 'ERA_4_COMMUNIST'], modern: 'Atribuire de pământ prin reforma agrară (1864, 1921, 1945)', implication: 'Loturile din 1921 și 1945 au avut restricții de înstrăinare; cele din 1945 au fost adesea preluate la cooperativizare.' },
  // D. Communist era (1948–1989)
  { id: 'prop-socialista', forms: ['proprietate(?:a)? socialista de stat', 'proprietate(?:a)? socialista', 'bun(?:uri)? ale intregului popor'], eras: ['ERA_4_COMMUNIST'], modern: 'Domeniul public al statului (după 1991: public sau privat al statului)', implication: 'Inalienabilă, insesizabilă și imprescriptibilă în acea epocă: nicio vânzare, uzucapiune sau executare nu era posibilă.', risk: 'SOCIALIST_USE_ONLY' },
  { id: 'cap', forms: ['cooperativ(?:a|ei) agricol(?:a|ă|e) de productie', 'proprietate(?:a)? cooperatist(?:a|ă)', 'c\\.\\s?a\\.\\s?p\\.', 'zon(?:a|ă) cooperativizat(?:a|ă)', 'cooperativizat\\p{L}*'], eras: ['ERA_4_COMMUNIST'], modern: 'Proprietate cooperatistă a Cooperativelor Agricole de Producție — pământ adus, în mare parte forțat, la colectivizare (1949–1962)', implication: 'Restituirea s-a făcut prin legile fondului funciar (Legea 18/1991, Legea 1/2000, Legea 247/2005): verifică titlul de proprietate emis.', risk: 'COOPERATIVIZED_LAND' },
  { id: 'folosinta', forms: ['(?:teren|terenul)?\\s*dat in folosinta(?: pe durata (?:existentei )?constructiei)?', 'in folosinta pe durata constructiei', 'drept de folosinta asupra terenului'], eras: ['ERA_4_COMMUNIST'], modern: 'Drept de folosință (asemănător superficiei) asupra unui teren al statului, pe durata construcției', implication: 'Terenul rămânea al statului; cetățeanul deținea doar construcția. Legea 18/1991 (art. 36) a permis trecerea terenului în proprietatea proprietarului locuinței — verifică emiterea ordinului prefectului / titlului.', risk: 'SOCIALIST_USE_ONLY' },
  { id: 'oclpo', forms: ['o\\.?c\\.?l\\.?p\\.?o\\.?', 'oficiul de construire a locuintelor proprietate personala', 'icral', 'contract de construire'], eras: ['ERA_4_COMMUNIST'], modern: 'Contract de construire / cumpărare a unei locuințe proprietate personală, prin OCLPO, finanțat de stat (CEC)', implication: 'Clădirea devenea proprietate personală; terenul era dat doar în folosință (vezi dreptul de folosință).' },
  // (Not "expropriat" / "confiscat" alone: a lawful modern expropriation for
  // public utility is not a communist taking.)
  { id: 'trecut-stat', forms: ['trecut(?:a|ă|e)? in proprietatea statului', 'nationalizat(?:a|ă|e)?(?= (?:prin|de|in baza|conform))', 'nationaliz[aă]r(?:ii|ea) (?:imobil|cladir|locuint)\\p{L}*', 'preluat(?:a|ă|e)? de stat'], eras: ['ERA_4_COMMUNIST'], modern: 'Expropriere / naționalizare / confiscare fără justă despăgubire', implication: 'Preluare abuzivă: temei de restituire în natură sau prin măsuri reparatorii (Legea 10/2001, Legea 165/2013). Extrage numărul decretului.', risk: 'EXPROPRIATION_DECREE' },
  { id: 'repartitie', forms: ['repartiti(?:e|a|ei)', 'repartitie in munca', 'ordin de repartitie'], eras: ['ERA_4_COMMUNIST'], modern: 'Repartizare administrativă (a unui loc de muncă sau a unei locuințe de stat)', implication: 'O locuință „repartizată” era a statului: chiriașul a putut-o cumpăra după Legea 112/1995 sau Decretul-lege 61/1990.' },
  { id: 'decizie-admin', forms: ['decizi(?:e|a) (?:a )?(?:comitetului executiv|consiliului popular|sfatului popular)'], eras: ['ERA_4_COMMUNIST'], modern: 'Act administrativ al organului local al puterii de stat', implication: '' },
  // E. Post-communist restitution (1990–2006)
  { id: 'titlu', forms: ['titlu(?:l)? de proprietate'], eras: ['ERA_5_POSTCOMMUNIST', 'ERA_6_EU'], modern: 'Titlu de proprietate emis în temeiul legilor fondului funciar', implication: 'Constitutiv de proprietate pentru teren; verifică intabularea și eventualele acțiuni în nulitate (art. III din Legea 169/1997).' },
];
const LEX_RX = LEXICON.map((e) => ({ ...e, rx: roRx(`(?<![\\p{L}])(?:${e.forms.join('|')})(?![\\p{L}])`, 'giu') }));
// → [{ id, term (as written), modern, implication, eras, count }]
export function findLegalTerms(text) {
  const t = String(text || '');
  const out = [];
  for (const e of LEX_RX) {
    e.rx.lastIndex = 0;
    const hits = t.match(e.rx);
    if (!hits) continue;
    out.push({ id: e.id, term: hits[0].trim(), count: hits.length, modern: e.modern, implication: e.implication, eras: e.eras, risk: e.risk || null });
  }
  return out;
}
// The text with each historical term followed by its modern equivalent in
// brackets — what the AI and the legal searches read.
export function normalizeLegalText(text, { max = 200 } = {}) {
  const t = String(text || '');
  // Every term's place in the ORIGINAL text, longest first where two overlap,
  // then one pass — an inserted gloss is never glossed again.
  const hits = [];
  for (const e of LEX_RX) {
    e.rx.lastIndex = 0;
    for (const m of t.matchAll(e.rx)) hits.push({ start: m.index, end: m.index + m[0].length, gloss: e.modern.split(' (')[0].split(' — ')[0] });
  }
  hits.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  let out = ''; let at = 0; let n = 0;
  for (const h of hits) {
    if (h.start < at || n >= max) continue;
    out += `${t.slice(at, h.end)} [= ${h.gloss}]`;
    at = h.end; n += 1;
  }
  return out + t.slice(at);
}

// ── The decrees and laws that took property ─────────────────────────────
export const PROPERTY_DECREES = {
  'Legea 187/1945': { what: 'Reforma agrară: exproprierea proprietăților agricole de peste 50 ha', claim: 'Legea 18/1991, Legea 1/2000, Legea 247/2005' },
  'Decretul 83/1949': { what: 'Exproprierea moșiilor rămase după reforma agrară (cu inventar, conace)', claim: 'Legea 1/2000, Legea 10/2001' },
  'Decretul 92/1950': { what: 'Naționalizarea unor imobile (clădiri de locuit, industriale, bancare…)', claim: 'Legea 10/2001 (notificare), Legea 112/1995, Legea 165/2013' },
  'Decretul 111/1951': { what: 'Regimul bunurilor confiscate, fără stăpân sau abandonate, trecute la stat', claim: 'Legea 10/2001' },
  'Decretul 115/1959': { what: 'Lichidarea exploatării prin închiriere a locuințelor („rămășițe ale exploatării”)', claim: 'Legea 10/2001' },
  'Decretul 218/1960': { what: 'Modificarea regimului locuințelor naționalizate', claim: 'Legea 10/2001' },
  'Decretul 712/1966': { what: 'Trecerea în proprietatea statului a unor imobile și terenuri', claim: 'Legea 10/2001' },
  'Decretul 223/1974': { what: 'Confiscarea bunurilor celor care emigrau / părăseau definitiv țara', claim: 'Legea 10/2001; Decretul-lege 1/1990' },
  'Legea 58/1974': { what: 'Sistematizarea: interzicerea înstrăinării terenurilor între vii; la vânzarea construcției terenul trecea la stat', claim: 'Legea 18/1991 art. 36; Legea 10/2001' },
  'Legea 59/1974': { what: 'Fondul funciar: terenurile agricole nu puteau fi dobândite decât prin moștenire legală', claim: 'Legea 18/1991' },
  'Legea 4/1973': { what: 'Construirea și vânzarea locuințelor din fondul de stat', claim: '—' },
};
// → [{ key: 'Decretul 92/1950', number, year, what?, claim?, raw }]
export function findPropertyDecrees(text) {
  const t = String(text || '');
  const out = new Map();
  const rx = roRx('\\b(decret(?:ul)?(?:-lege)?|legea|legii|decretului)\\s*(?:nr\\.?\\s*)?(\\d{1,4})\\s*(?:\\/|din(?:\\s+(?:anul\\s+)?)?)\\s*(?:\\d{1,2}\\s*[./]\\s*\\d{1,2}\\s*[./]\\s*)?(19\\d\\d|18\\d\\d|20\\d\\d)', 'giu');
  for (const m of t.matchAll(rx)) {
    const kind = /^leg/i.test(fold(m[1])) ? 'Legea' : 'Decretul';
    const key = `${kind} ${Number(m[2])}/${m[3]}`;
    const known = PROPERTY_DECREES[key];
    const year = Number(m[3]);
    // Only the acts that took, restricted or gave back property — or any
    // decree of 1945–1989, which a lawyer will want to read.
    if (!known && !(kind === 'Decretul' && year >= 1945 && year <= 1989)) continue;
    if (!out.has(key)) out.set(key, { key, number: Number(m[2]), year, raw: m[0], ...(known || {}) });
  }
  return [...out.values()];
}

// ── Title risks ────────────────────────────────────────────────────────
const RISK_TEXT = {
  DOTAL_RESTRICTION: 'Imobil dotal (Codul civil 1864, art. 1248 și urm.): era inalienabil în timpul căsătoriei. O înstrăinare făcută de soț fără autorizarea cerută de lege poate fi anulată la cererea soției sau a moștenitorilor ei. Verifică foaia de zestre, căsătoria și autorizarea.',
  SOCIALIST_USE_ONLY: 'Teren al statului dat doar în folosință: cetățeanul deținea construcția, nu terenul. Proprietatea asupra terenului se dobândește doar printr-un act ulterior (Legea 18/1991, art. 36 — ordinul prefectului; cumpărare de la stat). Fără acesta, titlul nu cuprinde terenul.',
  UNREGULATED_PREEMPTION_PROTIMISIS: 'Vânzare supusă dreptului de protimisis (preempțiunea rudelor și a megieșilor). Fără dovada renunțării lor, vânzarea putea fi desființată; lanțul de proprietate trebuie verificat la acest act.',
  EXPROPRIATION_DECREE: 'Bun preluat de stat printr-un decret sau o lege de naționalizare / expropriere / confiscare. Preluare abuzivă în sensul Legii 10/2001: deschide dreptul la restituire în natură sau la măsuri reparatorii (Legea 165/2013), cu termenele și procedura prevăzute. Verifică notificările depuse și soluțiile date.',
  COOPERATIVIZED_LAND: 'Teren preluat de CAP la colectivizare. Proprietatea s-a reconstituit prin legile fondului funciar; titlul actual este cel emis de comisia de fond funciar. Verifică titlul, suprafața și amplasamentul reconstituit, și eventualele litigii de fond funciar.',
  LAND_ALIENATION_BAN_1974: 'Legea 58/1974 (art. 30) interzicea înstrăinarea terenurilor între vii (1974–1989): la vânzarea unei construcții, terenul trecea în proprietatea statului. Un act din această perioadă nu putea transmite terenul; verifică art. 36 din Legea 18/1991 și restituirile.',
  UNAUTHENTICATED_TITLE: 'Titlu întemeiat pe un înscris sub semnătură privată (zapis) neautentificat și netranscris: nu este opozabil terților și dovada lui depinde de martori și de confirmări ulterioare. Recomandat: completarea lanțului prin acte autentice, uzucapiune sau acțiune în constatare.',
  EMPHYTEUSIS: 'Teren deținut în embatic (emfiteoză): constructorul avea doar folosința, contra redevenței. Verifică răscumpărarea embaticului; altfel terenul aparține încă proprietarului inițial sau succesorilor lui.',
  UNREGISTERED_OLD_REGISTRY: 'Act din sistemul registrelor de transcripțiuni și inscripțiuni: opozabilitatea depinde de transcrierea lui. Caută-l în registrul tribunalului și verifică dacă imobilul a fost apoi înscris în cartea funciară.',
  CO_OWNERSHIP_DEVALMASIE: 'Proprietate în devălmășie (fără cote): un devălmaș nu putea înstrăina singur o parte determinată fără partaj. Verifică partajul sau hotărnicia care au individualizat parcela.',
};
// → [{ risk_type, legal_explanation_for_lawyer, evidence: [strings] }]
export function findPropertyRisks(text, { terms = null, decrees = null, era = null } = {}) {
  const t = String(text || '');
  const f = fold(t);
  const ts = terms || findLegalTerms(t);
  const ds = decrees || findPropertyDecrees(t);
  const out = new Map();
  const add = (type, evidence) => {
    const cur = out.get(type) || { risk_type: type, legal_explanation_for_lawyer: RISK_TEXT[type], evidence: [] };
    if (evidence && !cur.evidence.includes(evidence)) cur.evidence.push(evidence);
    out.set(type, cur);
  };
  for (const term of ts) if (term.risk) add(term.risk, `„${term.term}”`);
  // The 1974 laws did not take property: they barred selling land.
  const BAN = new Set(['Legea 58/1974', 'Legea 59/1974']);
  for (const d of ds) {
    if (d.key === 'Legea 4/1973') continue;
    add(BAN.has(d.key) ? 'LAND_ALIENATION_BAN_1974' : 'EXPROPRIATION_DECREE', `${d.key}${d.what ? ` — ${d.what}` : ''}`);
  }
  if (ts.some((x) => x.id === 'protimisis') || (ts.some((x) => x.id === 'zapis') && /vanz|vand|vindut|cumpar/.test(f) && (era === 'ERA_1_FEUDAL' || era === 'ERA_2_TRANSITIONAL'))) {
    add('UNREGULATED_PREEMPTION_PROTIMISIS', ts.find((x) => x.id === 'protimisis') ? `„${ts.find((x) => x.id === 'protimisis').term}”` : 'vânzare de pământ din epoca protimisisului');
  }
  if (ts.some((x) => x.id === 'zapis') && !/autentific|transcri|intabul|legalizat/.test(f)) add('UNAUTHENTICATED_TITLE', `„${ts.find((x) => x.id === 'zapis').term}”`);
  if (ts.some((x) => x.id === 'embatic')) add('EMPHYTEUSIS', `„${ts.find((x) => x.id === 'embatic').term}”`);
  if (ts.some((x) => x.id === 'transcriptiune')) add('UNREGISTERED_OLD_REGISTRY', `„${ts.find((x) => x.id === 'transcriptiune').term}”`);
  if (ts.some((x) => x.id === 'devalmasie' || x.id === 'delnita')) add('CO_OWNERSHIP_DEVALMASIE', `„${ts.find((x) => x.id === 'devalmasie' || x.id === 'delnita').term}”`);
  // A sale of land (or of a building with its land) dated 1974–1989.
  const years = yearsOf(t).filter((y) => y.weight >= 3).map((y) => y.year);
  const dated = years.length ? Math.max(...years) : null;
  if (dated && dated >= 1974 && dated <= 1989 && /\bteren|\bloc de casa|\bcurte\b|\bgradin/.test(f) && /vanz|vand|vindut|instrain|cumpar/.test(f)) {
    add('LAND_ALIENATION_BAN_1974', `act datat ${dated}`);
  }
  return [...out.values()];
}

// ── Historical land measures ───────────────────────────────────────────
// Square metres per unit, by region. Sources: the stânjen of Țara Românească
// (Șerban Vodă, 1.9665 m → 3.8671 m²), of Moldova (2.23 m → 4.9729 m²), the
// Viennese Klafter of Transilvania / Banat / Bucovina (1.8965 m → 3.5966 m²);
// pogon = 1296 stânjeni² muntenești; fălcie = 2880 stânjeni² moldovenești
// (80 prăjini fălcești); jugăr cadastral = 1600 stânjeni² vienezi; jugăr
// unguresc (catastral maghiar) = 1200 stânjeni² vienezi. Regions:
// 'tara_romaneasca' | 'moldova' | 'transilvania'.
export const LAND_UNITS = {
  pogon: { m2: { tara_romaneasca: 5011.79, moldova: 5011.79, transilvania: 5011.79 }, forms: ['pogo(?:n|ane|anele|nul|nului)'] },
  falcie: { m2: { moldova: 14321.95, tara_romaneasca: 14321.95, transilvania: 14321.95 }, forms: ['falc(?:ie|ia|ii|i|e)'] },
  prajina: { m2: { moldova: 179.02, tara_romaneasca: 34.80, transilvania: 179.02 }, forms: ['praj(?:ina|ini|inile|inii)', 'pr\\.'] },
  stanjen_patrat: { m2: { tara_romaneasca: 3.8671, moldova: 4.9729, transilvania: 3.5966 }, forms: ['stanjen(?:i)? (?:patrat(?:i)?|p\\.)', 'st\\.?\\s?p\\.?', 'stanjeni', 'stanjen', 'st\\.?\\s?2', 'klafter', 'orgii? patrat(?:e)?'] },
  jugar: { m2: { transilvania: 5754.64, moldova: 5754.64, tara_romaneasca: 5754.64 }, forms: ['(?:i|j)ug(?:a|ă)r(?:e|ul|ului)?(?: cadastral(?:e)?)?', 'hold', 'joch'] },
  jugar_unguresc: { m2: { transilvania: 4315.98, moldova: 4315.98, tara_romaneasca: 4315.98 }, forms: ['(?:i|j)ug(?:a|ă)r(?:e)? unguresc(?:i)?', 'jugar(?:e)? maghiar(?:e)?'] },
  // "Lanț": read as the cadastral jugăr (its usual value in Transilvanian
  // land books); elsewhere it varied — flagged as an assumption.
  lant: { m2: { transilvania: 5754.64, moldova: 5754.64, tara_romaneasca: 5754.64 }, forms: ['lant(?:uri|ul)?'], assumed: true },
  hectar: { m2: { any: 10000 }, forms: ['ha', 'hectar(?:e|ul)?'] },
  ar: { m2: { any: 100 }, forms: ['ari', 'arii'] },
  metru_patrat: { m2: { any: 1 }, forms: ['mp', 'm2', 'm²', 'metri patrati', 'metri p\\.', 'mp\\.'] },
};
const UNIT_LABELS = { pogon: 'pogon', falcie: 'fălcie', prajina: 'prăjină', stanjen_patrat: 'stânjen pătrat', jugar: 'jugăr cadastral', jugar_unguresc: 'jugăr unguresc', lant: 'lanț', hectar: 'hectar', ar: 'ar', metru_patrat: 'm²' };
const REGIONS = ['tara_romaneasca', 'moldova', 'transilvania'];
export function normalizeRegion(r) {
  const t = fold(r).replace(/[^a-z]/g, '');
  if (/moldov|basarab|bucovin/.test(t)) return 'moldova';
  if (/transilv|ardeal|banat|crisan|maramures|bucovina/.test(t)) return 'transilvania';
  if (/tararomaneasca|muntenia|valahia|wallach|oltenia|dobroge/.test(t)) return 'tara_romaneasca';
  return REGIONS.includes(r) ? r : null;
}
// The region a text is from, when it says: its words and places.
export function detectRegion(text) {
  const t = fold(text);
  const score = { tara_romaneasca: 0, moldova: 0, transilvania: 0 };
  if (/\bfalc(ie|ii|i)\b|\brazes|\buric\b|\btinutul\b|\biasi\b|suceav|vaslui|botosan|roman\b|bacau|putna|tutova|falciu|dorohoi|\bneamt/.test(t)) score.moldova += 2;
  if (/\bpogo(n|ane)\b|\bmosnean|\bbucurest|\bcraiov|ploiest|\bargeș|arges|\bbuzau|ialomit|teleorman|\bolt\b|romanat|mehedint|\bgorj|valcea|muscel|dambovit|prahova|vlasca|ilfov/.test(t)) score.tara_romaneasca += 2;
  if (/\bjug(a|ă)r|\bcarte(a)? funciar|\bklafter|\bcluj|\bbrasov|\bsibiu|\bmures|\balba\b|\bbihor|\barad\b|timis|\bbanat|hunedoar|\bnasaud|\bsomes|maramures|comitat/.test(t)) score.transilvania += 2;
  const best = Object.entries(score).sort((a, b) => b[1] - a[1])[0];
  return best[1] ? best[0] : null;
}
const NUM_WORDS = { un: 1, una: 1, o: 1, doi: 2, doua: 2, trei: 3, patru: 4, cinci: 5, sase: 6, sapte: 7, opt: 8, noua: 9, zece: 10, unsprezece: 11, doisprezece: 12, douasprezece: 12, douazeci: 20, treizeci: 30, patruzeci: 40, cincizeci: 50, suta: 100, jumatate: 0.5 };
function readNumber(s) {
  const t = fold(s).trim().replace(/\s+/g, ' ');
  if (!t) return null;
  const frac = /^(\d+)\s*\/\s*(\d+)$/.exec(t);
  if (frac && Number(frac[2])) return Number(frac[1]) / Number(frac[2]);
  if (/^\d{1,3}(?:[.\s]\d{3})+(?:,\d+)?$/.test(t)) return Number(t.replace(/[.\s]/g, '').replace(',', '.'));
  if (/^\d+(?:[.,]\d+)?$/.test(t)) return Number(t.replace(',', '.'));
  if (NUM_WORDS[t] != null) return NUM_WORDS[t];
  return null;
}
// `convertHistoricalLandToMetric(2, 'pogon')` → { square_meters, hectares,
// unit, region, assumptions } — or null for a unit it does not know.
export function convertHistoricalLandToMetric(value, unit, region = null) {
  const key = Object.keys(LAND_UNITS).find((k) => k === unit) || Object.keys(LAND_UNITS).find((k) => LAND_UNITS[k].forms.some((f) => roRx(`^(?:${f})$`, 'iu').test(String(unit || '').trim())));
  if (!key || !Number.isFinite(Number(value))) return null;
  const u = LAND_UNITS[key];
  const assumptions = [];
  let reg = normalizeRegion(region);
  let m2 = u.m2.any;
  if (m2 == null) {
    if (!reg) {
      // A unit belongs to its own region unless told otherwise.
      reg = key === 'falcie' ? 'moldova' : key.startsWith('jugar') || key === 'lant' ? 'transilvania' : 'tara_romaneasca';
      if (key === 'stanjen_patrat' || key === 'prajina') assumptions.push(`Regiunea nu reiese din act: s-a folosit ${reg === 'tara_romaneasca' ? 'Țara Românească' : reg === 'moldova' ? 'Moldova' : 'Transilvania'}.`);
    }
    m2 = u.m2[reg];
  }
  if (u.assumed) assumptions.push('„Lanț” a fost socotit ca jugăr cadastral (5 754,64 m²); valoarea a variat regional — verifică.');
  const square_meters = Math.round(Number(value) * m2 * 100) / 100;
  return { value: Number(value), unit: key, unit_label: UNIT_LABELS[key], region: reg || null, square_meters, hectares: Math.round(square_meters / 100) / 100, assumptions };
}
// Every surface stated in a text, its parts summed ("2 pogoane și 40
// stânjeni" = one surface). A moșie measured in stânjeni "de moșie" / "în
// lățime" is a WIDTH, not an area: flagged, not converted.
// → [{ original_value, parts: [...], calculated_square_meters, hectares, region, assumptions }]
export function findLandMeasures(text, { region = null } = {}) {
  const t = String(text || '');
  const reg = normalizeRegion(region) || detectRegion(t);
  const unitAlt = Object.entries(LAND_UNITS).flatMap(([k, u]) => u.forms.map((f) => [k, f]))
    .sort((a, b) => b[1].length - a[1].length);
  const numSrc = `(\\d{1,3}(?:[.\\s]\\d{3})+(?:,\\d+)?|\\d+(?:[.,]\\d+)?|\\d+\\s*/\\s*\\d+|${Object.keys(NUM_WORDS).sort((a, b) => b.length - a.length).join('|')})`;
  const partRx = roRx(`(?<![\\p{L}\\d])${numSrc}\\s*(${unitAlt.map(([, f]) => f).join('|')})(?![\\p{L}])`, 'giu');
  const hits = [];
  for (const m of t.matchAll(partRx)) {
    const unitText = m[2];
    const key = unitAlt.find(([, f]) => roRx(`^(?:${f})$`, 'iu').test(unitText))?.[0];
    const value = readNumber(m[1]);
    if (!key || value == null) continue;
    hits.push({ start: m.index, end: m.index + m[0].length, raw: m[0], key, value });
  }
  // Consecutive parts joined by "și" / "," / nothing make one surface.
  const out = [];
  let cur = null;
  for (const h of hits) {
    const gap = cur ? t.slice(cur.end, h.start) : '';
    if (cur && gap.length <= 6 && /^[\s,]*(?:[sș]i)?[\s,]*$/i.test(gap) && cur.parts.every((p) => p.key !== h.key)) {
      cur.parts.push(h); cur.end = h.end;
    } else {
      if (cur) out.push(cur);
      cur = { start: h.start, end: h.end, parts: [h] };
    }
  }
  if (cur) out.push(cur);
  return out.map((g) => {
    const original = t.slice(g.start, g.end);
    const after = fold(t.slice(g.end, g.end + 30));
    const assumptions = [];
    let total = 0;
    const parts = g.parts.map((p) => {
      const c = convertHistoricalLandToMetric(p.value, p.key, reg);
      c.assumptions.forEach((a) => { if (!assumptions.includes(a)) assumptions.push(a); });
      total += c.square_meters;
      return { value: p.value, unit: c.unit_label, square_meters: c.square_meters };
    });
    const width = g.parts.length === 1 && g.parts[0].key === 'stanjen_patrat' && /^\s*(?:de mosie|in latime|latime|lungime|in lungime)/.test(after);
    if (width) assumptions.push('Stânjeni „de moșie” / „în lățime”: măsură de lungime (lățimea moșiei), nu de suprafață — nu se poate converti fără lungime.');
    return {
      original_value: original,
      parts,
      calculated_square_meters: width ? null : Math.round(total * 100) / 100,
      hectares: width ? null : Math.round(total / 100) / 100,
      region: reg,
      assumptions,
    };
  });
}

// ── The whole analysis ─────────────────────────────────────────────────
// → historical_legal_analysis: { detected_era, era_label, confidence, script,
//   year, applicable_historical_code, era_note, historical (bool), terms,
//   property_status_risks, decrees, surface_conversions, signals }
export function analyzeLegalHistory(text, { date = null, region = null } = {}) {
  const era = detectLegalEra(text, { date });
  const terms = findLegalTerms(text);
  const decrees = findPropertyDecrees(text);
  const risks = findPropertyRisks(text, { terms, decrees, era: era.era });
  const surfaces = findLandMeasures(text, { region });
  const historical = !!era.era && !['ERA_6_EU'].includes(era.era) && (era.era !== 'ERA_5_POSTCOMMUNIST' || risks.length > 0 || terms.length > 0);
  return {
    detected_era: era.era,
    era_label: era.label,
    confidence: era.confidence,
    script: era.script,
    year: era.year,
    applicable_historical_code: era.codes || '',
    era_note: era.note || '',
    historical,
    terms,
    property_status_risks: risks,
    decrees,
    surface_conversions: surfaces,
    signals: era.signals,
  };
}

// The analysis, compact — what is kept with a file (the scan's understanding).
// null when there is nothing historical to keep.
export function compactLegalHistory(a) {
  if (!a) return null;
  const surfaces = a.surface_conversions.filter((s) => s.parts.some((p) => !['hectar', 'ar', 'm²'].includes(p.unit)));
  if (!a.historical && !a.property_status_risks.length && !surfaces.length) return null;
  return {
    detected_era: a.detected_era, era_label: a.era_label, year: a.year, confidence: a.confidence, script: a.script,
    applicable_historical_code: a.applicable_historical_code,
    terms: a.terms.slice(0, 20).map((t) => ({ id: t.id, term: t.term, modern: t.modern, implication: t.implication })),
    property_status_risks: a.property_status_risks,
    decrees: a.decrees.map((d) => ({ key: d.key, what: d.what || '', claim: d.claim || '' })),
    surface_conversions: surfaces.slice(0, 12),
  };
}

// The analysis as a short note for an AI prompt: read the document in its era.
export function legalHistoryNote(a, { max = 2400 } = {}) {
  if (!a || (!a.historical && !a.property_status_risks.length && !a.surface_conversions.some((s) => s.parts.some((p) => !['hectar', 'ar', 'm²'].includes(p.unit))))) return '';
  const lines = [];
  if (a.detected_era) lines.push(`Era juridică: ${a.era_label}${a.year ? ` (datat ${a.year})` : ''}. Legislația aplicabilă atunci: ${a.applicable_historical_code}.`);
  if (a.era_note) lines.push(a.era_note);
  if (a.terms.length) lines.push(`Termeni istorici: ${a.terms.slice(0, 14).map((x) => `„${x.term}” = ${x.modern}`).join('; ')}.`);
  if (a.decrees.length) lines.push(`Acte de preluare / restituire citate: ${a.decrees.map((d) => `${d.key}${d.what ? ` (${d.what})` : ''}`).join('; ')}.`);
  if (a.property_status_risks.length) lines.push(`Riscuri de titlu: ${a.property_status_risks.map((r) => r.risk_type).join(', ')}.`);
  const conv = a.surface_conversions.filter((s) => s.calculated_square_meters != null && s.parts.some((p) => !['hectar', 'ar', 'm²'].includes(p.unit)));
  if (conv.length) lines.push(`Suprafețe convertite: ${conv.slice(0, 8).map((s) => `${s.original_value} ≈ ${s.calculated_square_meters.toLocaleString('ro-RO')} m² (${s.hectares} ha)`).join('; ')}.`);
  lines.push('Citește documentul după dreptul epocii lui: nu aplica anacronic noțiunile Codului civil actual și spune când un efect juridic depinde de legislația de atunci.');
  const out = lines.join('\n');
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}
