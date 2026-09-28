// THE LEGISLATION-DETECTION ARCHIVE — everything the user gave about how
// Romanian legislation (and the identifiers around it) is recognised, kept
// VERBATIM so it is never lost: their source texts, their instructions, the
// rules as documented, every regex and the whole catalogue, and a copy of the
// detector's code — all FROZEN on 2026-09-28. Shown in the Debug tab
// (pages/Debug `LegalDetectionArchive`) beside the LIVE patterns
// (lib/lawRefs `LAW_REF_REGEXES` / `REF_CATALOGUE`), which it compares
// against the frozen copy. Data only; nothing in the app reads it but Debug.
// Do not edit by hand — add to it, never rewrite what is here.
export const LEGAL_DETECTION_ARCHIVE = {
 "frozenAt": "2026-09-28",
 "sources": [
  {
   "id": "4d8f3e42:330",
   "at": "2026-09-23T20:39:30.568Z",
   "title": "How Romanian documents cite a normative act (Legea nr. 24/2000)",
   "text": "\"În documentele oficiale, juridice sau administrative din România, citarea și trimiterea la un act normativ se fac după reguli stricte stabilite prin Legea nr. 24/2000 privind normele de tehnică legislativă.Pentru ca o referință să fie corectă și completă, ea trebuie să cuprindă categoria actului, numărul acestuia, anul adoptării și titlul complet.1. Structura standard a primei menționăriPrima dată când menționezi o lege într-un text, trebuie să folosești forma completă:[Categoria de act] nr. [număr]/[an] [titlul actului]Exemplu: Legea nr. 287/2009 privind Codul civilExemplu: Ordonanța de urgență a Guvernului nr. 195/2002 privind circulația pe drumurile publice2. Trimiterea la elemente structurale (Articole, Alineate, Litere)Dacă faci referire la o parte specifică din lege, elementele se ordonează de la cel mai specific la cel mai general (de la mic la mare) sau invers, însă structura standard recomandată de tehnica legislativă este:[Articol] [Alineat] [Literă] din [Act normativ]Abrevierile oficiale utilizate sunt:Articol / Articole → art.Alineat / Alineate → alin.Literă / Litere → lit.Punct / Puncte → pct.Exemplu: Potrivit art. 12 alin. (1) lit. b) din Legea nr. 24/2000...(Notă: Numărul alineatului se scrie întotdeauna între paranteze).3. Menționarea ulterioară în text (Forma scurtă)După ce ai menționat actul normativ în formă completă prima dată, în restul documentului poți folosi o formă simplificată pentru a nu îngreuna citirea:Puteți folosi doar numărul și anul: Legea nr. 24/2000 sau O.U.G. nr. 195/2002.Dacă te referi strict la acel act pe tot parcursul unui paragraf, poți folosi sintagme de legătură: „din legea menționată mai sus” sau „din actul normativ citat”.4. Specificarea modificărilor (Republicări sau Actualizări)Dacă legea a suferit modificări majore și a fost republicată, sau dacă vrei să arăți că te双refeferi la forma ei actualizată la zi, se adaugă mențiuni speciale la sfârșitul citării:Pentru acte republicate: Legea nr. 24/2000 privind normele de tehnică legislativă, republicată.Pentru acte cu modificări ulterioare: Legea nr. 227/2015 privind Codul fiscal, cu modificările și completările ulterioare.\" theese are all the ways specific laws are refered to in romania law related documents. Create a feature for detecting all of theese laws refrences and wrap them in the ai linear gradint my app hase"
  },
  {
   "id": "c2b3c945:1543",
   "at": "2026-09-26T12:11:56.065Z",
   "title": "The identifier catalogue, groups I–XI",
   "text": "update the detection of romanian law refrences to include theese: \"\n\n<pasted_content id=\"f865\">\nI. Identificatori Economici, Fiscali și Registre de CompaniiNumăr de ordine în Registrul Comerțului (ONRC)Tipar: [J|F|C][0-9]{2}/[0-9]+/[0-9]{4}Sintagme: J40/123/2026, F12/456/2024, C23/789/2025, nr. de ordine în Registrul Comerțului.Cod Unic de Înregistrare / Cod de Identificare Fiscală (CUI / CIF)Tipar: (RO)?[0-9]{2,10}Sintagme: CUI, C.U.I., CIF, C.I.F., Cod Unic de Înregistrare, Cod de Identificare Fiscală.Identificator Unic la Nivel European (EUID)Tipar: ROONRC\\.[JFC][0-9]{2}/[0-9]+/[0-9]{4}Sintagme: ROONRC.J40/123/2026.Registrul Asociațiilor și Fundațiilor (ONG-uri)Tipar: [0-9]+/A/[0-9]{4} sau [0-9]+/B/[0-9]{4} sau [0-9]+/PJ/[0-9]{4}Sintagme: înscrisă în Registrul Asociațiilor și Fundațiilor sub nr., aflat la grefa [Instanță].Conturi Bancare Românești (IBAN)Tipar: RO[0-9]{2}[A-Z]{4}[A-Z0-9]{16} (Fix 24 caractere).Sintagme: contul IBAN, cont curent.Sistemul RO e-Factura & Documente FiscaleSintagme: Factura seria [X] nr. [Y], Chitanța nr., Ordin de plată / OP nr., id descărcare e-Factura, index încărcare.Numărul EORI (Economic Operators Registration and Identification - Vamă)Tipar: RO[0-9]{2,10} (Cuvântul „RO” urmat direct de CUI).Codul LEI (Legal Entity Identifier - Financiar/Investiții)Tipar: [A-Z0-9]{20}II. Forme Juridice de Organizare (Nomenclator companii & profesii liberale)Entități Economice Standard: S.R.L. / SRL, S.A. / SA, P.F.A. / PFA, I.I. / II (Întreprindere Individuală), I.F. / IF (Întreprindere Familială), S.N.C., S.C.A..Forme Profesionale Reglementate:Avocatură: C.A. (Cabinet de Avocat), S.C.A. (Societate Civilă de Avocați), S.P.R.L..Notari: B.N.P. (Birou Notarial Public), S.P.N. (Societate Profesională Notarială), B.I.N..Executori: B.E.J. / BEJ (Biroul Executorului Judecătoresc), S.C.P.E.J. / SCPEJ.Practicieni în insolvență: S.P.R.L. (Societate Profesională cu Răspundere Limitată).Medicină: C.M.I. (Cabinet Medical Individual).Arhitectură: B.I.A. (Birou Individual de Arhitectură).III. Clasificări, Nomenclatoare și Coduri de StatCoduri CAEN (Clasificarea Activităților din Economia Națională)Tipar: [0-9]{4}Sintagme: cod CAEN, clasa CAEN, obiect de activitate conform CAEN.Coduri COR (Clasificarea Ocupațiilor din România)Tipar: [0-9]{6}Sintagme: cod COR, funcția ocupată conform COR.Coduri CPV (Vocabularul Comun privind Achizițiile Publice)Tipar: [0-9]{8}-[0-9]Sintagme: cod CPV, achiziție publică având codul CPV.Coduri NC (Nomenclatura Combinată / Vamală)Tipar: [0-9]{8}Sintagme: cod vamal, poziția tarifară NC.Coduri SIRUTA (Registrul Unităților Administrativ-Teritoriale)Tipar: [0-9]{5,6}Sintagme: cod SIRUTA, localitatea [Nume] (SIRUTA: [0-9]{5,6}).IV. Structura Actelor Normative (Tehnica Legislativă - Legea 24/2000)Identificare Act MacroTipar: [Tip Act] nr. [X]/[An] sau [Tip Act] [X]/[An]Tipuri de acte: Legea, Ordonanța de Urgență a Guvernului / O.U.G. / OUG, Ordonanța Guvernului / O.G. / OG, Hotărârea de Guvern / H.G. / HG, Ordinul [Minister] nr., Decretul nr..Coduri Naționale (Fără număr de lege în exprimarea curentă)Sintagme/Acronime: Codul civil / C.civ. / C. civ., Codul de procedură civilă / C.proc.civ. / C. pr. civ. / CPC, Codul penal / C.pen. / C. pen., Codul de procedură penală / C.proc.pen. / C. pr. pen. / CPP, Codul muncii, Codul fiscal, Codul administrativ, Codul silvic.Subdiviziuni Interne MicroArticol: art. [0-9]+, articolul, art. [0-9]+^([0-9]+) (cu indice, ex: art. 155^1), art. [0-9]+ bis / ter / quater.Alineat: alin. ([0-9]+), alin. [0-9]+, alineatul.Literă: lit. [a-z]\\), litera.Punct: pct. [0-9]+, punctul.Teză: teza I, teza a II-a, teza 1, teza 2.Starea textului legalSintagme: republicată, cu modificările și completările ulterioare.V. Jurisprudență, Instanțe și Structuri JudiciareNumăr Unic de Dosar (Sistemul ECRIS - Instanțe)Tipar: [0-9]+/[0-9]+/[0-9]{4}Sintagme: dosar nr., dosarul penal nr., dosar asociat nr..Număr de Dosar de Urmărire Penală (Parchet)Tipar: [0-9]+/P/[0-9]{4} (Atenție la identificatorul /P/ care indică faza de urmărire penală).Sintagme: dosar nr. [X]/P/[An] al Parchetului de pe lângă....Seria și Numărul Proceselor-Verbale (Contravenții/Amenzi)Tipar: seria [A-Z]{2,4} nr. [0-9]+Sintagme: Proces-verbal de constatare și sancționare a contravenției.Hotărâri Judecătorești de SpețăTipar: [Tip Hotărâre] nr. [X]/[Dată|An]Tipuri: Sentința civilă, Sentința penală, Decizia civilă, Decizia penală, Încheiere, Încheierea de ședință, Ordonanța președințială.Nomenclator Instanțe JudecătoreștiSintagme: Judecătoria [Nume/Sector], Tribunalul [Nume], Curtea de Apel [Nume], Înalta Curte de Casație și Justiție / ÎCCJ.Jurisprudență Obligatorie (Instanțe Supreme)Decizii CCR: Decizia Curții Constituționale nr. [X] din [Dată], Decizia CCR nr. [X]/[An].Recursuri în Interesul Legii: Decizia RIL nr. [X]/[An], Decizia nr. [X]/[An] pronunțată în recursul în interesul legii.Hotărâri Prealabile: Decizia HP nr. [X]/[An], Decizia nr. [X]/[An] pentru dezlegarea unor chestiuni de drept.VI. Cadastru și Dreptul Proprietății (Imobile)Identificatori ANCPICarte Funciară: Carte Funciară nr. [X], CF nr., C.F. nr..Număr Cadastral: nr. cadastral [X], nr. cad..Număr Topografic: nr. topografic [X], nr. top..Parcelare: Tarla [X] / T [X], Parcela [Y] / P [Y].VII. Identificare Persoane FiziceCod Numeric Personal (CNP)Tipar: [1-8][0-9]{12} (Validare fixă pe 13 cifre).Acte de IdentitateSintagme: C.I. seria [A-Z]{2} nr. [0-9]{6}, B.I. seria, Pașaport nr..VIII. Executare Silită și Acte NotarialeDosare de Executare SilităTipar: Dosar de executare (silită) nr. [X]/[An] (Generat de executor).Acte NotarialeSintagme: Încheiere de autentificare nr., Certificat de moștenitor nr..IX. Drept Internațional și European (Invocat în România)Cauze CJUE (Curtea de Justiție a Uniunii Europene)Tipar: Cauza C-[0-9]+/[0-9]{2}Sintagme: Hotărârea CJUE în cauza.Acte UESintagme: Regulamentul (UE) nr., Directiva [An]/[X]/UE, GDPR.Jurisprudență CEDOSintagme: Hotărârea CEDO în cauza [Nume] contra României, Art. [X] din Convenție.X. Conectori Juridici Logici (Pentru Contextul IA)Cuvinte-cheie și sintagme care semnalează modelului de IA apariția iminentă a unei entități din listă:Introducere temei: în temeiul, în drept, potrivit dispozițiilor, prin raportare la, având în vedere prevederile.Corelare: coroborat cu, prin coroborare cu, în conexiune cu.Subordonare/Interpretare: în subsidiar, în principal, per a contrario, ad litteram.XI. Organe Fiscale și de Control (Nomenclator Emitenți ANAF)Apar frecvent ca emitenți în antetul actelor administrative contestate:ANAF (Agenția Națională de Administrare Fiscală)D.G.R.F.P. (Direcția Generală Regională a Finanțelor Publice)A.J.F.P. (Administrația Județeană a Finanțelor Publice)D.G.A.M.C. (Direcția Generală de Administrare a Marilor Contribuabili)D.G.A.F. (Direcția Generală Antifraudă Fiscală)\n</pasted_content id=\"f865\">\n\n\" inside the debug tab, create a list to disaply all the ways ai and regex recognize theese so I can view all of them"
  },
  {
   "id": "c2b3c945:27050",
   "at": "2026-09-26T21:45:34.081Z",
   "title": "CAEN codes as a trade-register extract lists them",
   "text": "in \"\n\n<pasted_content id=\"f865\">\nOBIECTE DE ACTIVITATE, conform codificării (Ordin 377/2024) Rev. Caen (3)\n\nOperație: adăugare\n\nActivitate principală\n\n6210 - Activități de realizare a soft-ului la comandă (software orientat client)\n\nActivitate secundară\n\n6220 - Activități de consultanță în tehnologia informației și de management (gestiune și exploatare) a mijloacelor de calcul\n\n6290 - Alte activități de servicii privind tehnologia informației\n\n6310 - Prelucrarea datelor, administrarea paginilor web și activități conexe\n\n6391 - Activități ale portalurilor web\n\n6392 - Alte activități de servicii informaționale n.c. a\n\nAVIZE\n\nOperație: adaugare\n\nModel declarație: Model unic\n\nObiecte de activitate avizate, conform codificării (Ordin 377/2024) Rev. Caen (3):\n\n6210 - Activități de realizare a soft-ului la comandă (software orientat client) (la terț)\n\n6220 - Activități de consultanță în tehnologia informației și de management (gestiune și\n\nRaport generat în data de 17.06.2026 12:02:51\n</pasted_content id=\"f865\">\n\n              \" caen cades are not recognized. Update the detection system to detect caen codes in this format"
  },
  {
   "id": "c2b3c945:35192",
   "at": "2026-09-26T22:54:36.723Z",
   "title": "A CUI written as \"Cod unic de înregistrare : …\"",
   "text": "Cod unic de înregistrare : 54912561 is a caen code and the recognition did not pick it up. Update the recognition system"
  }
 ],
 "instructions": [
  {
   "id": "4d8f3e42:610.0",
   "at": "2026-09-23T20:54:10.574Z",
   "text": "wrap law refrence detections inside a animated linear gradint with blue and purple bg"
  },
  {
   "id": "4d8f3e42:868.0",
   "at": "2026-09-23T21:11:20.647Z",
   "text": "also add detection for romanian caen codes"
  },
  {
   "id": "4d8f3e42:1313.0",
   "at": "2026-09-23T21:30:59.932Z",
   "text": "make caen refrences be always on, ouside the laws button"
  },
  {
   "id": "4d8f3e42:1313.1",
   "at": "2026-09-23T21:30:59.932Z",
   "text": "and make Internal cross-references outide the laws button and make it clickable"
  },
  {
   "id": "4d8f3e42:1313.2",
   "at": "2026-09-23T21:30:59.932Z",
   "text": "choose diferent styling for caen codes and Internal cross-references"
  },
  {
   "id": "4d8f3e42:1670.0",
   "at": "2026-09-23T21:53:36.676Z",
   "text": "i want only  Internal cross-references to have the styling, not the destination. the \"pct. 6.1. lit. d).\" I mean"
  },
  {
   "id": "4d8f3e42:1956.0",
   "at": "2026-09-23T22:15:40.894Z",
   "text": "make the select color be the same color as the button of the Internal cross-references text"
  },
  {
   "id": "4d8f3e42:2081.0",
   "at": "2026-09-23T22:38:13.303Z",
   "text": "for selected paragraph that have law refrenecs in them, under the selected paraagprah, create a list of links where I can view the law and its details"
  },
  {
   "id": "4d8f3e42:2445.0",
   "at": "2026-09-23T23:18:03.755Z",
   "text": "make detected laws inside paragraph have a option to open the law infomation inside my app"
  },
  {
   "id": "d2d6d0b8:18900.0",
   "at": "2026-09-25T15:39:21.480Z",
   "text": "i want tabs inside legislation, i want all tabs to comunicate with one and the other, for example, inside the legislatie.just.ro, add caen code recognition like in file viewer, and when I click it, open a modal that I can search it inside the insse.ro and automaticly search"
  },
  {
   "id": "91229ddb:2.0",
   "at": "2026-09-27T10:16:54.631Z",
   "text": "inside the design system, disaply all the ways text that is detected toa  romanian legislation is highlited"
  },
  {
   "id": "91229ddb:2728.0",
   "at": "2026-09-27T15:54:32.888Z",
   "text": "change the color of the cross refrence button to black, faded out and when I press it, replace the blue section with fading out text that is not part of that"
  },
  {
   "id": "91229ddb:5605.0",
   "at": "2026-09-27T16:46:14.121Z",
   "text": "add the section under the selected paragraph that disaplyed data from before. Law detection, autofill etc"
  }
 ],
 "docs": [
  {
   "title": "lawRefs.js — the detector",
   "text": "| `lawRefs.js` | **Romanian legal references** — `findLawRefs(text)` finds every citation of a normative act by the SHAPE Legea nr. 24/2000 prescribes, so no list of known laws is needed: the full first mention (`Legea nr. 287/2009 privind Codul civil`, `Ordonanța de urgență a Guvernului nr. 195/2002 privind …`, EU acts' year/number order and their body written after the number — `Directiva 2007/43/CE`, `Regulamentul (CEE) nr. 2913/92`, `Directiva 96/29/Euratom` (`EU_SUFFIX`; `readNumberYear` tells the year from the number: a four-digit year, else the two-digit side, else EU = year first — and gives a two-digit year its century)), a structural pointer (`art. 12 alin. (1) lit. b)`, folded into the act when `din …` follows so the whole thing is ONE reference), the short later forms (`O.U.G. nr. 195/2002`, a code by name, `legea menționată mai sus`), and the `, republicată` / `, cu modificările și completările ulterioare` notes, which are part of the citation. **CAEN codes** too (`cod CAEN 6201`, `clasa CAEN 4711`, `CAEN Rev. 2 – 6201`, lists like `CAEN 6201, 6202 și 6209`) — not an act, but the same thing to a reader, and how a company's object of activity is always written; the keyword is required, since a bare four-digit number in a legal document is far more often a year or an amount. The hit carries `codes`. **The one-per-line list of a trade-register extract** is recognised too (`CAEN_LINE_RE`: a line that is four digits, a dash and a capitalised name — `6210 - Activități de realizare a soft-ului …`), but ONLY in a text that mentions CAEN at all (`caenContextOf(text)` → `{ on, rev }`, the revision read off \"CAEN Rev. 2\" / \"Rev. Caen (3)\"); a caller that scans a paragraph at a time hands the WHOLE document's context in (`findLawRefs(text, { caenContext })` — `markLawRefs` and the paragraph dock do, from the host's text). Verified in Node on an ONRC extract: all eight listed codes found as Rev. 3; a lone line without a CAEN context and a \"2024 - Anul …\" line are not marked. **A company's FISCAL CODE (CUI / CIF)** is followable too (`findCuiRefs` → `{ kind: 'cui', cui }`, in `findFollowableRefs`): the keyword required — CUI / C.U.I. / CIF / C.I.F. in capitals, \"Cod unic de înregistrare (fiscală)\", \"cod de înregistrare fiscală\", \"cod de identificare fiscală\", \"cod fiscal\", with an optional \"nr.\" and \":\" (spaced or not) and an optional RO — and the number must pass the CUI check digit (`cuiValid`). The Doc Viewer's Word preview marks it whatever the Laws switch says (`.dv-cuiref`, anaf.ro’s green `--success`, `data-cui`; a click opens the company in the MAIN window's ANAF tab), and so does an act in the Legislation tab (`.lg-ref.is-cui` → `/anaf?cui=`); the one search routes a line naming one to ANAF (`detectQuery`, before the words are read). Verified in Node on \"Cod unic de înregistrare : 54912561\" and its variants; a wrong check digit is not marked. **Internal cross-references** are the same detector's `element` hits that no act follows (“…indicată la pct. 6.1. lit. d)”, “clauzei 4.3” — dotted clause numbering, the abbreviations and the written-out words in any declension): each carries `target` (the clause number) and `letter`, and the preview draws it as a CONTROL rather than a highlight: `.dv-xref`, the LAW MARK'S LOOK IN GREY (#6B7280: the sweeping wash, the rule under it, the 5.5s shimmer — it points inside the document, not at a platform) and the hand cursor, which deepens on hover and again while held (`.is-hot` / `.is-press`, set by the pane on every span sharing the mark’s `data-ref-id` — Word cuts one reference into several runs and `:hover` can only reach the one under the pointer, which lit half a reference). Over it the paragraph pill stops naming the paragraph and says “Go to 6.1 lit. d)” — what pressing it will do. A block that OPENS with a structural element is naming ITSELF and is never marked (`opensTheBlock` in `markLawRefs`): \"Art. 2 OBIECTUL DE ACTIVITATE\", \"Secțiunea 1 …\", \"pct. 6.1. Datele de contact …\" are the document’s own numbering, and marking them turned every article heading in the file into a button that went to itself — a real cross-reference is always mid-sentence, because it is something the sentence SAYS. Only `element` hits are judged this way; a paragraph may perfectly well open by citing an act. A delegated click then finds where it points and brings that to the middle of the pane, with EVERYTHING ELSE FADED BACK to 0.38 (`.has-xref-focus` on the host, `.is-xref-target` on the clause and the item named — no colour painted on them, no pulse). What it finds is the block OPENING with that number — leaf blocks only, since a wrapper’s `textContent` starts with its first child’s and would answer to \"6.1\" earlier in document order, lighting the whole of it — and, when the reference names a letter (\"pct. 6.1. lit. d)\"), the ITEM: the line beginning \"d)\", looked for below the clause and only as far as the next numbered one, so an item of a later clause can never be borrowed. A document that runs its items inside the clause’s own paragraph has no such line and the clause stays the answer, as it does for a letter that is not there; a clause that does not exist falls back to the section that would hold it (\"6.3\" → \"6\"). A block’s number is read with or without the word introducing it (\"6.1.\", \"6.1)\", \"Art. 6\") — a smooth scroll ends without saying where, and a page of legal prose gives the eye nothing to land on. The fade is answered by the READER, not by a timer: being over the clause and moving away again puts the page back (`is-xref-leaving` keeps the opacity transition for the way back); `XREF_LIT_MS` (12s) gives up for a reader who never goes near it. Both diacritic spellings (ș/ț and cedilla ş/ţ) are matched, and a word ending is `\\p{L}*` — `\\w` is ASCII-only even under /u and stops at the first diacritic. A title is cut where the sentence starts talking ABOUT the act (`cutTitle`), or the highlight ran to the full stop. Pure text in, ranges out. **The wider catalogue** (`REF_GROUPS` / `REF_CATALOGUE` / `findEntityRefs` / `findAllLegalRefs` / `scanRefPatterns` / `refKindName`, same file): every OTHER identifier a Romanian legal document carries, grouped I–XI — ONRC/EUID numbers, CUI/CIF, NGO registry, IBAN, invoices/e-Factura, EORI, LEI; legal forms (SRL, BNP, BEJ… — bare SA/II/IF/CA and C.A. deliberately excluded as ambiguous); COR/CPV/NC/SIRUTA codes; prosecution files (/P/), procese-verbale, court decisions and court names, CCR/RIL/HP decisions; Carte Funciară/cadastral/topo/tarla; CNP (with a real-date check) and C.I./pașaport; enforcement and notarial acts; CJUE/GDPR/CEDO; the legal connectors („în temeiul”… — context cues for the AI); ANAF bodies. Each entry: id (= the hit's kind), via ('shape' | 'keyword' | 'context'), its regexes, phrases, examples and an `ai` note; `live: true` marks the kinds `findLawRefs`/`findCaseRefs` already find (not re-run). `scanRefPatterns` enforces the letter boundary JS's ASCII-only `\b` cannot (never write `\b` next to a diacritic) and keeps a trailing dot („S.R.L.”). The existing detectors also learned: Codul administrativ + the dotted code abbreviations (C.civ., C.proc.civ., C. pr. pen.…) + case-sensitive CPC/CPP/NCPC/NCPP siglas; `teza`, roman-numeral values (Cap. III, teza a II-a) and bis/ter/quater in element runs. NOT wired into the Word preview marking — `findFollowableRefs` and `refClassFor` still know only act/code/caen/element/case. **The Debug tab renders the whole catalogue** (`LawRefCatalogue` in pages/Debug.jsx, `.debug-ref*` in Debug.css): a tester textarea running `findAllLegalRefs` over any pasted text with every hit marked and tagged, then each entry with its via pill, AI note, phrase chips, its examples lit by its OWN patterns, and the regex sources under a fold. The Doc Viewer's Word preview paints them: `markLawRefs` / `clearLawRefs` in DocViewer.jsx wrap each hit WHERE IT LIES — one element per text node it covers, never one across several (a `<dv-mark>`, not a span: docx-preview writes run formatting as rules on every span under a paragraph — `.docx span`, `p.docx_<style> span` — so an added span took the paragraph's default size / weight / italics over its own run's; the empty-field chips use it too), so Word's own runs (and the bold inside a citation) survive and `serializeParagraphMarkdown` sees what it saw before — and gives each its own mark — all three drawn purely in background layers, with no padding and no font change, so marking a paginated document cannot re-wrap a line. Every mark has ROOM that costs no width (2.4px above and below — inline, so no line moves — and 3.2px at the reference's outer ends cancelled by an equal negative margin; the empty fields excluded), and switching the eye FADES the marks and the fields in and out (`--dv-ref-a`, a registered number scaling every mark's colour; `.is-refs-hidden` on the host, `REF_FADE_MS` 280) while the eye itself BLINKS between open and shut (`EyeGlyph`, one drawing, `.dv-eye`). **Every mark, one preference.** EVERY MARK WEARS ITS PLATFORM’S COLOUR (lib/legalBrowser `PLATFORMS[…].tone`, the tones the Legislation tabs, results and scopes wear — Design system → Platform colours): an ACT gets `.dv-lawref` in legislatie.just.ro’s violet (`--cat-update`, a sweep of that one hue shimmering on a 5.5s cycle — a soft wash behind the words and the same gradient at full strength as a rule under them), and ALL of them — acts, codes, CAEN codes, CUIs, cross-references — AND the empty fields' look are toggled by the **Highlights** quick action, an EYE (open / shut with its state; `docvex:doc-viewer:law-refs`, default on; it replaced the Laws action, which switched the acts alone): off, `markLawRefs` marks nothing and stamps `.dv-docx.is-plain`, under which a blank reads as its plain underscores / text. EVERY MARK ANSWERS ITS OWN POINTER, never the paragraph it sits in: a click on an act / code, a CAEN code or a CUI EXPANDS its hover tooltip into a CARD (DocParaPill `card`, the morph pill's menu state, sticky: `refPill(…, { full: true })` — everything known, every CAEN code's name and successor, the citation as written — then **Search** and **Close**); Search opens it in a NEW tab of the Legislation browser in the MAIN window — or, when a tab already shows that item (same platform, same address; parameter order and `_` / `open` / `newtab` ignored — `sameAddr` in `arrive`), brings THAT tab forward (`refSearchHref`: the mark's `data-href` — `legislationHref(lawRefDetails(hit))` / `caenHref` — the company at ANAF, or a words search for an act too general to open; `newtab=1`, which LegalWorkspace's arrival reads because the main-window channel carries no router state; with the paragraph tools off the click opens it at once); a cross-reference's click is the jump — stopped in the capture phase before the pick handler, except inside a paragraph being typed in; PICKING a paragraph paints NOTHING on it (the cognac tint, ring and outline were removed) and DOES NOTHING ELSE: the rest dims to 0.14 (a table holding it stays bright) — the zoom onto it, the blur veil, the lifted card, the close button, the paragraph rail, the version dots and the panel docked under it (Constructor inputs, identity records, the cited acts) are switched off by `PICK_POP_OUT = false` in DocViewer.jsx — EXCEPT the panel's data, which `PICK_DOCK` keeps: the panel (Constructor inputs + record autofill, `ParaLawRefs`) is DOCKED straight under the paragraph where it lies (`.dv-docx-liftpanel.is-docked`: white ground, hairline, card shadow; placed by `layoutLift`'s docked branch on every scroll / resize / input, hidden while the paragraph is out of the pane), with the preview copy back (the blanks' inputs; drawn as the plain paragraph with the sleeve, dropped by the same branch when the pick moves or ends); the panel stands on the tooltip ground (`--bg-sidebar`), and while a paragraph is picked the pane does NOT scroll (`.dv-docview-body:has(> .dv-docx.has-pick)`: overflow hidden, gutter kept). **The AUTOFILL** (current state: NO kind switch and NO kind bar — both removed at the user's request, as were the representative's separate column and its capacity choice; one choice per PARTY: every data collection is listed, and the one picked dictates the part — a collection of another kind rewrites the part for it and fills it in one step (`setKind(k, recordKindOf(r), r)`), hovering previews that rewrite (`previewKind(k, kind, rec)`), and a party's pick fills its representative's blanks too from the collection (`ownsField`); what follows describes the earlier steps) (DocParagraphConstructor) is one list for every clause — one entry per person the paragraph names — laid out as a COLUMN OF PARTIES (`peopleGroups`, `.dcx-party-group`: one row per party the clause names) with a party and its REPRESENTATIVE side by side in their row (`.is-pair`, a hairline between, wrapping in a narrow panel), since the representative is owned by the party. The gender comes from `genderOf` (lib/identities: the record's stated gender, else its CNP's first digit — 1 3 5 7 man, 2 4 6 8 woman — else the first name) and `applyGenderToText` now also resolves the slash form \"identificat/ă\" / \"născut/a\" (→ -ă; \"-ul/a\" → -a). The panel ends in **Undo** and **Apply**: Undo steps back one change at a time (every `patch` keeps the draft as it was before it — a burst of typing is one step; ≤60, per paragraph, reset when another is picked; the count beside the word), Apply (`onApply` = the pane's `clearParas`) writes the paragraph's changes and closes the pick (disabled until something changed). The list no longer has a **Custom** row (Undo is how a pick is taken back). **Filling SETTLES the wording** (`settleFor` in DocConstructor: lib/docConstructor `settleClauseFor` — gender agreement, the bl./sc./et./ap. clauses dropped for a house, județul vs. sectorul — applied to THAT PERSON'S PART of the clause only, from `entitySpans`; a one-person clause whole) on every path: a party the document names (`assign`), an entity it doesn't (`assignPerson`), a collection of another kind (`setKind` / `previewKind` with the record), and the HOVER previews (`previewWording` → the copy shows the settled text). While the copy only previews (`data-previewing`, a record / kind / version hovered) the docked panel HOLDS ITS PLACE (its gap to the real paragraph, `panel.__dockGap`, kept from the last committed layout) and moves only once a choice is made. **„reprezentată legal prin X, în calitate de Y”** is read as the law reads it: X = WHO signs for the company (a person, by name — the representative's column lists people, labelled 'Legal representative (who signs)'), Y = their FUNCTION in the firm, never a fact about the person — a segmented choice in that column (`REP_CAPACITIES`: administrator / director general / împuternicit / președinte, plus the document's own wording when it is something else) writes the capacity blank(s); picking the person takes their function from the COMPANY picked for that party when its people table lists them (`capacityFor`, the role lower-cased for mid-sentence), else leaves it; picking the company itself fills both from its record (`settleRepresentative`) (the old single-party grid is gone; no `--bg-elevated` ground): the name, a **kind switch** — which in the viewer stands in the KIND BAR ABOVE THE PARAGRAPH (`.dv-docx-kindbar`, the pane's `kindSlot` the Constructor portals into: one row per party, placed by layoutLift's docked branch just above the paragraph, clamped in the pane; the panel keeps it only where there is no bar, e.g. the Design system sample), and whose options PREVIEW ON HOVER (RuleOptions' `onHover` → `previewKind`: the paragraph shows the rewrite, filled values carried, nothing applied until a click) — (`components/RuleOptions` over `ENTITY_KINDS` in lib/docConstructor — Persoană fizică / PFA / II / Persoană juridică), set to what the clause says (`entityKindOf`: the entity's own words for a PFA, else `clauseKind` of its blanks) and, changed, REWRITING THAT ENTITY'S PART of the clause in the chosen formula (`rewriteEntity` over `entitySpans`: from the boundary before its first blank — `:` / `;` / „și” (matched with \\p{L}, `\b` can't see „ș”) / the last comma — to its last blank, so the „denumit(ă) în continuare …” ending stays; a document that names nobody gets `p1`, `p2`… roles for the rewritten blanks; filled values carried by field; `FORMULA.pfa` added), then Custom and the project's DATA COLLECTIONS, FILTERED by that switch (`recordKindOf`: a record of kind org whose legal form or name says PFA / II is a PFA; a representative lists people) — the switch also offers **All** (per person, `filters` state, reset per paragraph): every collection listed, and picking one of ANOTHER kind rewrites that person's part for the record's kind and fills it in the same step (`setKind(key, kind, rec)`); picking a kind both filters and rewrites — each shown as its FILE (ExtGlyph, file name, who it holds · kind · CUI/CNP). A party the document names is filled everywhere (`assign`); an entity only the clause knows, blank by blank (`assignPerson`). The Design system's Empty fields section also shows the blanks with Highlights OFF (`.dsg-fieldsdoc.is-plain`, mirrored) and the autofill (`AutofillSample`, live switch). NOT verified in the app.; while a paragraph is picked NO OTHER paragraph is detected (DocParaPill's `blockUnder` answers nothing: no hover pill, dim or menu; the marks outside it are not live) and a plain click anywhere outside it dismisses the pick (inside it keeps it; Shift / Ctrl / ⌘ still change the pick) (the code is kept behind it; the descriptions of that pop-out elsewhere in this file describe it when switched on); a CLICK ON THE BACKGROUND (the pane's grey ground outside the pages, or a page's margin — not the pane's controls) DISMISSES EVERY SELECTION (`dismissAll`: the pick, a cross-reference landing via `host.__dismissXref`, selected text; an open card closes on the same press). The picked paragraph and the hovered one wear a BLACK SLEEVE down their left (two box-shadows — ink 8px out, page-white 5px out on top of it — so it takes no room); HOVERING A PARAGRAPH no longer dims the rest (removed at the user's request; the sleeve is the hover look) — formerly it dimmed the rest of the document to 0.72 (DocParaPill marks it — `.dv-docx.has-para-hot` + `.is-para-hot`, a 140ms grace across the gaps; off while a paragraph is picked or a jump is showing) — it replaced a cognac tint and ring on the hovered paragraph; and the paragraph's hover pill describes the mark instead (`refPill`: the platform in its colour, what is cited, the CAEN name / the act's title / its article, what a click does). A CAEN code gets `.dv-caenref`, a flat stamp in insse.ro’s amber (`--warning`) with a solid rule and no animation, and an internal cross-reference gets `.dv-xref`: both are marked whatever the preference says, because a company’s object of activity IS its code (hiding the mark hides the fact) and because a cross-reference is how the reader gets around the document — a way of moving through a file must not depend on a highlighting switch. `markLawRefs(host, { laws })` is what narrows the set; every mark also carries `dv-ref`, which is what the clean-up removes and what rounds the outer ends of a reference split across runs. **A PICKED paragraph also LISTS what it cites** (`ParaLawRefs`, docked under it in `.dv-docx-liftpanel` beside the Constructor's controls, so the clause and what it turns on are one thing to look at): `lawRefDetails(hit)` reads the citation back apart — the pointer into the act (`art. 12 alin. (1) lit. b)`), the category, the number and year, the title as the document gave it on first mention, and the `republicată` / `cu modificările …` notes — all out of the same `raw` the mark covers, so the list can never claim something the document does not say. `lawRefLookupUrl(hit)` is a SEARCH of legislatie.just.ro, not a link into it: the portal reaches a document by an internal id and searches by form POST, so there is no address for “Legea 24/2000” — an invented `/Public/DetaliiDocument/<guess>` would 404 with a straight face. Acts, codes and CAEN codes are listed; internal cross-references are not (they point inside this document and already have their own button in the text). Each act row leads with **Read here** — `legislationHref(details)` in lib/legislation turns the citation into a `/legislation?tip&nr&an&titlu&open=1` route (`portalTypeFor` maps the word a clause uses, “Legii” / “O.U.G.”, onto the portal’s own `TipAct`), and the viewer sends the MAIN window there over `window:navigate-main` + `window:focus-main`, the same channel its account menu uses. The tab runs the search itself and opens the act when the answer is unambiguous — one act, or several versions of one, in which case the newest in force wins. The document stays open behind it, which is the point: the clause and the act it turns on are meant to be read against each other. “Look it up” stays as the secondary way out to a browser, and is the only one a CAEN code gets. |"
  },
  {
   "title": "legalOmni.js — the one search reading what was typed",
   "text": "| `legalOmni.js` | The Legislation tab's ONE search: `detectQuery(text)` → `{ source, what, label, site, params, to }` (which platform answers a typed line, and its route), `validCui`, `randomQuery()` (the dice). See the LegalWorkspace bullet. |"
  },
  {
   "title": "legislation.js — references in an act, the portal",
   "text": "| `legislation.js` | **Romanian national legislation, in the app** **Styled by the Design system's rules (2026-09-27):** its rows (`.lg-row` = the gallery's List row: page ground, `--ds-hairline`, `--ds-row-radius`, `--ds-row-density`, no lift — a wash on hover), sections (`.lg-lib`: `--ds-card-fill` / `-shadow` / `-radius`), button (`.lg-btn` = `.dsg-btn`, danger soft at rest), pills (`.lg-source` / `.lg-tag` = the soft pill tokens), the authority note (`.lg-act-warn` = the CALLOUT: hairline box, no fill, no coloured rule, a warning dot before the title — its icon hidden), labels (`--ds-label-size/-tracking`), table / drawing / diagram frames (`--ds-row-radius`) and the CAEN reference in `--warning` (no literal colours); the workspace's rail card (`--ds-bar-*`), the one search's pill and the \"i\" list (`--ds-pill-*`, `--ds-menu-radius`, hairline rows) likewise. The other platforms' results follow the same rules (PortalJust.css, Anaf.css, Caen.css, CourtMap.css, CaenModal.css: no `--bg-card` / `--bg-elevated` — which read blue on Ink — on rows, sections, buttons or hovers; `--ds-card-fill` / `-shadow` / `--ds-hairline` / row and card radii and a neutral text-colour wash instead; `.pj-tag` / `.an-flag` are soft pills). The main column has no right padding (`.lws .lg-shell-main`), so results end on the header divider's right edge. The open records (ANAF's `.an-card` and its note, the court file `.pj-file`, the CAEN card `.cn-card`) are no longer capped at 82ch — they take the column's full width too. They also have no frame, corners or padding of their own — they stand on the page ground, as an act does. (`pages/Legislation`, `/legislation`, the Personal section). legislatie.just.ro publishes a FREE web service — `legislatie.just.ro/apiws/FreeWebService.svc`, SOAP, `GetToken` (anonymous, no registration or key) then `Search` — and it is the only lawful complete source of Romanian legislation a program can read. It is called from the MAIN PROCESS (`legislation:*` in main.js) and can never be called from the renderer: it is a 2015-era WCF endpoint that sends no CORS headers, and its nginx answers 403 to a default user agent. A `Legi` record carries `TipAct`, `Numar`, `Titlu`, `Emitent`, `Publicatie`, `DataVigoare`, the act's FULL `Text`, and `LinkHtml` — the portal's own `/Public/DetaliiDocument/<id>` address, which is the only way to get one (there is no page addressable by number and year, and no `get by id` method — only `Search`). **The portal is a SOURCE, not a dependency.** Every answer is kept under `userData/legislation`: each result's metadata is folded into `archive.json` and an act that is opened is written whole to `acts/<id>.json`, so with the ministry's server down the same search runs against the index instead. **SPEED (2026-09-27): an act kept on this machine now OPENS FROM THAT COPY AT ONCE** (`loadAct`: the session's memory first — `actMemo` — then `acts/<id>.json`, then the portal; the page's background check still says \"Live from the portal\" or offers \"Differs from the portal - click to sync\"), its page from the copy (`fetchPage(rec, fresh)` is fresh only for an act just read live; `peekActPage` puts a page this session already has up in the same frame), live searches are kept for 10 minutes (`searchLegislation` memo; failures never kept), parsed page trees are kept (`parseActHtml` memo, last 8), and main keeps `archive.json` and the kept texts' size in memory (`legisIndexCache` / `legisBytesCache`). What follows describes the earlier rule — **An act OPENS FROM THE PORTAL FIRST** (`loadAct`: `fetchActLive`, kept whole on arrival; the copy on disk only when the portal cannot answer — offline, down, or the act gone — with `portalError` saying why; a record still carrying its text came from a live search a moment ago and counts as live) and so does its PAGE (`loadActPage` defaults to `fresh`; main's `legislation:page` falls back to `acts/<id>.html` itself when the fetch fails, and the lib asks for the copy a second time for a main process that predates that). What is on screen is therefore the law as it is today whenever the portal is up, and the copy is what keeps the tab working when it is not. The answer always says WHICH of the two it came from (`source: 'live' | 'archive'`) and the page shows it — the two are never silently mixed, because “no results” offline means something very different from the portal saying there are none. Quirks the model handles: a SOAP fault — an expired token (\"TOKEN INVALID SAU EXPIRAT\"; the portal invalidates a token when another client asks for one), a bad query — arrives as an HTTP **500** with the fault envelope in its body, so `legisPost` reads the body before judging the status and hands a fault back as an answer for the handler's one retry with a fresh token (treating the 500 as a transport failure kept the dead token in use for its ten-minute TTL, every search falling back to the archive; `courtsPost` reads its faults the same way); the text carries HTML ENTITIES of its own (\"tatea &lt; 1,6 kg/cap\" — a level the envelope's decoding never reaches; `unentity`, applied in `tidy`, on an act's text and on a page's preformatted rows — left in, a \"&lt;\" is four characters where a box-drawn table counted one and every row after it fell out of line, which is how half a table used to come through as text), `Titlu` is the printed act's whole masthead run together (BOM, tabs, the issuing body and gazette reference trailing the title — `cutTrailer`), `SearchAn` behaves like “in force that year” rather than “enacted that year” (so a typed year is applied client-side too: an act whose own year — read off its title — is known and differs is dropped; “Hotărâre 1383 2022” used to answer with the 2024 act of that number beside it; the archive search reads the year the same way), there is NO act-type parameter (so `LEGIS_TYPES` filters `TipAct` client-side, which is why a search can show fewer rows than the portal found), and matching is done on values folded to ASCII (`fold`) since Romanian is typed with ș/ț, with ş/ţ, or with neither. **The act is laid out from the PORTAL'S OWN PAGE, by the portal's own rules.** The service's `Text` is the act flattened; the page at `/Public/DetaliiDocument/<id>` marks the act's structure up with `S_*` classes — `S_DEN` (name), `S_HDR` (title), the `S_EMT` / `S_PUB` tables, `S_ART` › `S_ART_TTL` / `S_ART_DEN` / `S_ART_BDY` (an article), `S_ALN` (a numbered paragraph, \"(1)\"), `S_LIT` (a letter, \"a)\"), `S_PCT` (a point, \"1.\"), `S_CIT` (text an amendment quotes), `S_NTA` (a note), `S_ANX` (an annex), `S_SMN` › `S_SMN_PAR` (the signatures), `S_PRE` › `S_PAR` rows (a preformatted block: a form, a model), `S_PAR` (a paragraph; nested in a body it is the portal's amendment note, \"(la 16-11-2022, … a fost modificat de …)\"), inline `S_LGI` (a reference) and `<A>` links, `TAG_COLLAPSED` (+/−) and `S_*_SHORT` (collapsed previews) to skip. `loadActPage(rec, { fresh })` gets the page (main's `legislation:page`) and `parseActHtml(html)` (DOMParser, renderer code; no `:scope` — found by walking children) reads it into a TREE — `{ head: { den, hdr, meta }, blocks, tables }`, a node being `{ kind, title, den, text, children }` for a unit (`art` / `aln` / `lit` / `pct` / `anx` / `cap` / `ttl` / `sec` … / `nta`), `{ kind: 'par', text, children }`, `{ kind: 'cit', children }`, `{ kind: 'smn', lines }`, `{ kind: 'pre', segs }` (runs of box rows → `{ type: 'table', id, rows, grid }`, the rest `{ type: 'text', rows }`); `actTreeStrings(tree, drawn)` lists every string in reading order (the find counts them; the marks are laid in the same order, so `renderNode` must visit title → den → text → lines/segs → children exactly as it does). **The HEAD is the portal's** (`.lg-src-head`, from `tree.head`): the act's name (`S_DEN`, its bracketed state — \"(republicată)\", \"(*actualizată*)\" — in bold, `denParts`), the title under it (`S_HDR`, or the first plain paragraph), then EMITENT and Publicat în as label / value rows in a fixed label column, as the portal's EMITENT table sets them; the record's own head (kind line, title, meta) is shown only until the page arrives. **Lists written as plain paragraphs** are read as lists (`asListItem`): an `S_PAR` opening with a marker — \"a)\", \"1.\", \"(ii)\", \"-\", \"●\" — or pushed in with spaces the TEXT carries (non-breaking spaces, or plain ones on its own line; whitespace with a line break or tab is the page's source formatting and does not count), never an amendment note, gets `title` (the marker), `list` (num / letter / roman / bullet / indent) and `indent` (0–4); drawn as `.lg-li`. **Nested lists hang on a GUIDE LINE**: `.lg-lit`, a point inside a paragraph, and the letter / roman / bullet / indent list items stand right of an accent hairline, spaced by PADDING so consecutive items keep one unbroken line, moved in further by `--li-indent`. Every number marker (\"(1)\", \"a)\", \"1.\") is in the theme's ACCENT, not the secondary text's blue-grey. The page renders the tree (`.lg-body.is-tree`: `.lg-art` with its label, `.lg-aln` / `.lg-lit` / `.lg-pct` as number-column rows indenting under each other, `.lg-cit` rule-marked, `.lg-amend` muted, `.lg-smn` right-aligned, `.lg-pre` › `.lg-preline` monospace rows + the tables) and falls back to the plain text's shape while the page is being fetched or cannot be had (offline with no copy). Verified under happy-dom on three saved pages (an order with 8 preformatted blocks / 17 tables / 3 annexes / 2 notes, a Government decision with 8 articles / 21 paragraphs / 10 letters / 9 points / 8 citations / signatures, an emergency ordinance). `parseActText` reads the act's SHAPE back off the plain text (and its BOX-DRAWN TABLES — older acts carry forms and schedules drawn in ┌─┬─┐ characters, which the portal flattens onto one line with runs of spaces where the row breaks were; `splitTables` takes the first row's width from `┌…┐` and cuts the rest into rows of that width, and `parseBoxTable` reads the drawing as a GRID — every column with a vertical/junction character is a column line, every row with `─` a row line, a cell grows right while the line through its band is not drawn and down while the line under it is not, its text is every row inside it (border rows included, a merged cell's words can sit on one) — `{ cols, rows: [[{ text, colSpan, rowSpan }]] }`, null for a drawing that is not a grid. The page draws each table with a SWITCH INSIDE its frame, in the TOP-RIGHT corner (`.lg-tblbar`, absolute in `.lg-tblwrap`; the table box, the drawing and the diagram keep a 38px band clear at the top for it) (`DocVex` · `Source`, the tab bar's toggle with the chosen one filled in the accent like the dice and the Search button; `drawnTables`, keyed `t:<id>` for a page table and by block index for a plain-text one): DocVex's real `<table class=\"lg-tbl\">` with merged cells by default (in a `.lg-tblbox` frame), or the portal's drawing as a monospace `<pre class=\"lg-table\">` where the boxes line up — both framed alike: the search bar's hairline, tint and frost, 8px corners (a collapsed table cannot round its corners, so the box carries the frame and each cell draws only its right and bottom hairlines, the table running a pixel past the box so the last ones fall under it); the switch itself has NO frost and no lift — the blur put its buttons on a compositing layer snapped to whole pixels while the act's text sits on fractions, and the words inside jumped a pixel as the page scrolled; the find counts whichever is shown. NO LINE BREAKS INSIDE A WORD in either: the drawing never wraps (it scrolls sideways), and DocVex's cells wrap only after a word (`overflow-wrap: normal; word-break: keep-all`), a word the drawing hyphenated across two rows (\"repro-\" / \"ducţie\") being made whole again when the cell's rows are joined. A cell's rows become its LINES (`lines` beside `text`): a row opening an item — a bullet (● • - –), a number (\"1.\"), a letter (\"a)\") — starts a line, a blank row ends one, the rest continues the last; the page draws each line on its own (`.lg-tbl-line`), so the eligibility box's six bullets stand one under the other instead of running together. Verified on Ordinul 228/2012's APIA forms: 17 tables, 485 rows, every row the same width, all 17 read as grids) **DIAGRAMS** — an organisation chart drawn in the same characters is NOT a grid, and the grid reader answered it with nonsense, so a run of box rows is tried as a diagram FIRST (`parseBoxDiagram`): a box is a `┌` whose top edge runs along `─`/junctions to a `┐`, whose left edge runs down `│`/junctions to a `└`, with the `┘` and the other two edges drawn; two or more boxes side by side or one inside another make a diagram; a box holding another is a FRAME; every other line character is a CONNECTOR, each character saying which of its four sides it joins (`DIR_OF`) and a junction on a box's border drawing only the side pointing away from the box, the half-segments merged into runs — `{ w, h, boxes: [{ x, y, w, h, lines, frame }], hseg, vseg }` in character units. The page draws it as an SVG chart (`BoxDiagram`, `.lg-diagram`: a cell is 8 × 17 px, a box a rounded card at its corner cells' centres, a frame a dashed outline, connectors a muted stroke, the words real HTML in a foreignObject so the find marks them; the chart scales down to the column, never up), Source being the drawing as ever; `diagramStrings` lists its words for the find. Verified on HG 725/2010's MADR chart: 27 boxes, 1 frame, 33 line runs; the order's 17 tables still read as grids. In the PLAIN-TEXT fallback a chart is still cut by `splitTables` at the first box's width (the flattened text has no row width to go by), so it reads as text until the page arrives. — the portal puts each structural unit on a line of its own separated by a bare `+`, so divisions, articles and their numbered paragraphs come back as blocks and the act is laid out as a document rather than dumped as a wall of characters (verified on the consolidated Legea nr. 24/2000: 69,912 characters → 14 units, 85 articles, 245 paragraphs, none empty). **Nothing of the portal's own design is copied** — the page is built from the app's semantic tokens, which is both the house rule and what keeps this clear of anyone's trade dress; what is carried across is the text, which carries no copyright (Legea nr. 8/1996 art. 9) and whose reuse the portal's terms allow. Every act shows the portal's own caveat, on the act and not in an About page: a consolidated text is NOT authentic, only the Monitorul Oficial print is. **References in an act behave as in the Doc Viewer** (`LegalRefPill` in pages/Legislation.jsx, one morph pill for the page, native listeners delegated on it; each `.lg-ref` carries `data-ref-hit` → its lib/lawRefs hit): hovering shows the viewer's HIGHLIGHT PILL and a click EXPANDS it into the CARD — `components/RefHitPill` `refHitPill(hit, { full })`, the viewer's `refPill` built from a hit instead of a marked span (RefPill.css) — whose **Search** does what the click used to (`onRef`: the act here, the CAEN modal, Court files, ANAF) and Close; Enter on a focused reference still follows it. The APP SIDEBAR's Legislation tab rows show the same pill on hover (`legalTabPill` in Sidebar.jsx: the platform's dot and site, the loaded name, the kind, what a click does). **THE TABS ANSWER EACH OTHER — the references in an act are CONTROLS** (`marked` in Legislation.jsx, over the same detector as the Doc Viewer's: `findFollowableRefs` in lib/lawRefs = the `act` / `code` / `caen` hits of `findLawRefs` + `findCaseRefs`, court file numbers — \"Dosarul nr. 1.234/1/2022\", the word required, thousands dots dropped — found once per string and cached per act): a cited ACT (`.lg-ref`, legislatie.just.ro’s violet `--cat-update`) is FOLLOWED HERE — but ONLY a citation that fills the form WHOLE: kind, number AND year (`fixedQueryOf`: `lawRefDetails` → `legislationQueryFor`, all three present — \"Legea nr. 287/2009\", \"art. 5 din O.U.G. nr. 195/2002\"; \"Codul muncii\" or a directive the portal has no kind for is left as plain text, since it could only be found by WORDS, and the words search with the AI behind it is the user's to run, never a click's); `followCitation` fills Kind / Number / Year with it, runs that FIXED search (no title words, no AI) and opens the act when the answer is one act (`openIfUnambiguous`, shared with the `?open=1` arrival), else shows the results; a CAEN code (`.is-caen`, insse.ro’s amber) opens the nomenclature in a MODAL over the page — **`components/CaenModal`** (`{ code, codes?, rev? }`: the code in its words box and its card open at once, the same search as the CAEN tab's down the left, the codes a citation listed as chips, \"Open in the CAEN tab\" the way to the tab itself; the card is **`components/CaenCard`**, the CAEN tab's own entry card moved out so any tab can show it — `cn-` styles, Caen.css); a COURT FILE number (`.is-case`, portal.just.ro’s blue `--info`; a CUI `.is-cui`, anaf.ro’s green) opens the Court files tab on that file (`/portal-just?nr=`). **The rail is ALWAYS there, and the SEARCH lives in its Search item**: before anything is asked the Search item is the tabs' EMPTY STATE (`.lg-start`: the placeholder tabs' `.lss-card` — a bare thin-stroke mark, a title, a muted line, centred) holding the two ways to search STACKED in one centred column (by number, \"or\", by words) at a LARGER size (the bar's and the box's tokens re-declared in `.lg-start-mode`: 36px fields, 13.6px type) with \"or\" between them on the fields' line, each labelled and hinted — BY NUMBER (the bar) and BY WORDS (the words box) — and Clear under them; once there is an answer the same fields stand as one compact row (`.lg-searchrow`) over it; the RESULTS SECTION is for a WORDS search — a search by the form alone (typed or filled by a citation) whose answer is one act, or versions of one, OPENS it and lists nothing (`runNow` returns `opened`, which `openIfUnambiguous` respects), and only an answer of several different acts (or none) is listed; a fixed search with words too is opened and listed; a **Clear** button in the search row empties the form, the words and the answer (and drops a search still on its way); **SEARCH is the mini header's**: at the far LEFT of its second line (the page's `tools`), a control the SAME SIZE as the act's find field (`.lg-searchtab`: the find's height, width, hairline, corners, tint and frost; icon and word centred; its HOVER and SELECTED looks the APP SIDEBAR's, as the rail's items wear them — a pointer-tracked wash on hover; selected while the search is on show: Ink accent tint, ring and text, Cream the lifted cognac pill — at rest its field look), with History (the clock alone, `HistoryButton` `iconOnly`, `.lg-searchtab-hist`) beside it; the rail holds only the acts opened; Search + the line's gap + History = the rail's width (`--lg-rail-w`, 236px), so the pair ENDS ON THE RAIL'S DIVIDER; the rail's items wear the APP SIDEBAR's look (`.lg-rail-item` = `.nav-item`, components/Sidebar.css — keep them in step): no icon, TWO LINES — the act's kind on top in small capitals (`.lg-rail-kind`, \"ORDONANȚĂ DE URGENȚĂ\"), its number and year under it (`.lg-rail-num`, \"nr. 64/2012\"), a 44px row — the same weight and size selected or not; HOVER a wash brightening where the pointer is (accent on Ink, neutral on Cream; `--item-spot-x/y` from `useItemSpots`), SELECTED the sidebar's selected tab (Ink: accent tint, ring and text with a brighter pointer glow on hover; Cream: the solid cognac pill, lifted, cream text); the rail itself carries the sidebar's SPOTLIGHT — a soft accent glow following the pointer (`::before`) and, once pinned, a shine on its border (`::after`), both from `--spot-x/y` eased toward the pointer by Sidebar.jsx's frame-rate-independent loop; the DIVIDER between the rail and the act is a DRAG HANDLE (`.lg-rail-resizer`, a band on the rail's right border that lights in the accent): dragging sets `--lg-rail-w` on the page (180–420px, kept per device in `docvex:legislation:rail-w`; double-click = 236px; ←/→ in 16px steps when focused), and since the Search button reads the same width the pair above still ends on the divider; the act's column has a 20px RIGHT padding, the same as the gap between the divider and it; the rail's LEFT EDGE is the mini header's (pulled left exactly as the bar is — `--lg-rail-pull` = the content gap less the window-edge inset — and widened by the same, its items padded back onto the content edge); the rail runs from just under the mini header to the BOTTOM of the window (`--lg-bar-h` / `--lg-scroll-h`, measured with a ResizeObserver); it is STICKY under the header, NOTHING sits below the shell (the page's and the scroller's bottom padding moved into `.lg-shell-main` — any space under the shell let the sticky rail be pushed up at the end of the scroll), and the shell is kept at least the rail's height plus the distance the page scrolls before it sticks (`--lg-rail-travel`, measured) — without that, on the Search screen or a short act the block around the rail was no taller than the rail and the rail scrolled away (making it `position: fixed` instead was tried and broke the layout: an ancestor here makes its own frame, so \"fixed\" is measured from the wrong box); its surface is SYNCED to the header's — LegalTabs hands its own pinned state over (`onPinnedChange`, a layout effect, so the rail repaints on the very frame the bar does) and the rail renders `is-pinned` from it — and, pinned, takes the mini header's pinned surface — the frosted page ground, the flat hairline all round, the bar's corners — and, pinned, rises to z 20, above the page's bottom fade (`.sv-single-body::after`, z 5) and below the bar (z 30), its height gliding to end one `--chrome-inset` above the window's bottom so its rounded foot floats — (NOT the seam shadow: it masks the gap above the bar at the window's top, and on the rail it painted a strip of backdrop colour between bar and rail) (one border all round, only its right edge showing until then, so nothing moves when the frame appears); the search view opens with `.lg-searchrow` — the bar (dice, Kind, Number, Year, Search) and the words box (`LegalSearchBox`, exported from LegalTabs: the tab bar's search box as a component of its own, with its Ctrl/⌘+F), then the bar's note; the tab bar's second line carries only the OPEN act's FIND, at its right end, which which behaves as the Doc Viewer's find bar (and Windows') does — every match lit as the words are typed, the position (\"3/17\" / \"No results\" in red) and previous / next / clear INSIDE the field (`search.find` = `{ current, total, prev, next }` on `LegalSearchBox`, `.lgt-find-count` / `.lgt-find-btn`), Enter the next match, Shift+Enter the one before, Escape clears and leaves the field and, with no act open, no box at all (LegalTabs' `noSearch`: the box stays LAID OUT but hidden and inert, `.lgt-search.is-hidden`, so the line keeps its height and nothing moves when an act is opened and the find box comes back). **READING SESSIONS, in a RAIL** (`tabs` / `activeTab` in Legislation.jsx, kept in page memory): the Advisor's list of chats, for acts — every act opened from the results, from History or from a citation arriving from the Doc Viewer starts a SESSION that stands as an item down the page's left (`.lg-rail`, sticky under the tab bar, `.lg-rail-item` = `.aichat-item` to the letter, keep them in step; the way back to the search and its results is the mini header's Search control, lit when no session is active); the active session's reading state IS the live state (act, page, find, table switches — NO scroll position: moving between items, or opening one, always lands at the TOP of the page, and the restored find does not pull it down to its match until the find is used again, `skipFindScroll`) and the others hold theirs as snapshots (`stashActive` / `applyReader` / `showTab`; `leaveToResults` puts the active one away and shows the search — Back with no trail, Search pressed, a search submitted, a History search picked; `closeTab` removes one); an act already open in a session is switched to, not opened twice; a citation followed INSIDE an act opens as a NEW session (`followCitation`: the query run, the act opened when unambiguous, else the results shown), the act it was cited in staying open in its own; an answer arriving after the reader moved to another session lands in its own item. `open` is remade every render (it reads the sessions), so `runNow` and `openIfUnambiguous` call it through `openRef`. With no session the page is the search and its results, as it was. There is NO Back button: the rail's Search item is the way back to the search (the act keeps its place in the rail). Background layers only, no padding, no font change, so marking cannot re-wrap a line. |"
  }
 ],
 "regexes": [
  {
   "name": "ACT_RE",
   "what": "A normative act: category, number/year (either order, EU suffix), title from \"privind…\", republication / amendment notes.",
   "source": "(?:Ordonan[țţ]\\p{L}*\\s+de\\s+urgen[țţ]\\p{L}*(?:\\s+a\\s+Guvernului)?|Ordonan[țţ]\\p{L}*(?:\\s+a)?\\s+Guvernului|Ordonan[țţ]\\p{L}*|Hotăr[âî]r\\p{L}*(?:\\s+a)?\\s+Guvernului|Hotăr[âî]r\\p{L}*|Leg(?:ea|ii|e)|Decret(?:ul|ului)?(?:-lege)?|Ordin(?:ul|ului)?|Deciz(?:ia|iei)|Regulament(?:ul|ului)?|Directiv(?:a|ei)|Instruc[țţ]iun\\p{L}*|Norm\\p{L}*\\s+metodologic\\p{L}*|O\\.?U\\.?G\\.?|O\\.?G\\.?|H\\.?G\\.?|O\\.?M\\.?F\\.?P?\\.?)(?:\\s*\\((?:UE|CE|CEE|EU)\\))?\\s*(?:nr\\.?\\s*)?(\\d{1,5})\\s*\\/\\s*(\\d{2,4})(?:\\/(?:Euratom|CECO|CEEA|PESC|JAI|CEE|CE|UE|EU))?(?:\\s+(?:privind|pentru|referitor\\p{L}*\\s+la|asupra|cu\\s+privire\\s+la)\\s+[^.,;:()\\n]{2,200})?(?:\\s*,\\s*(?:republicat[ăa]|actualizat[ăa]|cu\\s+modificările(?:\\s+[șş]i\\s+completările)?\\s+ulterioare|cu\\s+completările\\s+ulterioare))*",
   "flags": "giu"
  },
  {
   "name": "STRUCT_RE",
   "what": "A structural pointer: art. / alin. / lit. / pct. / teza with values, joined runs, bis/ter/quater, ^indices, roman numerals.",
   "source": "\\b(?:art\\.|alin\\.|lit\\.|pct\\.|paragr\\.|parag\\.|cap\\.|articol\\p{L}*|alineat\\p{L}*|liter\\p{L}*|punct\\p{L}*|clauz\\p{L}*|capitol\\p{L}*|anex\\p{L}*|sec[țţ]iun\\p{L}*|tez\\p{L}*)\\s*(?:\\(\\d+\\)|\\d+(?:\\.\\d+)*(?:\\^\\d+)?(?:\\s+(?:bis|ter|quater))?\\.?|[a-zșşțţăâî]\\)|(?:a\\s+)?[IVX]{1,5}(?:-a)?(?!\\p{L}))(?:(?:\\s*(?:,|[șş]i|-|–)\\s*|\\s+)(?:(?:art\\.|alin\\.|lit\\.|pct\\.|paragr\\.|parag\\.|cap\\.|articol\\p{L}*|alineat\\p{L}*|liter\\p{L}*|punct\\p{L}*|clauz\\p{L}*|capitol\\p{L}*|anex\\p{L}*|sec[țţ]iun\\p{L}*|tez\\p{L}*)\\s*)?(?:\\(\\d+\\)|\\d+(?:\\.\\d+)*(?:\\^\\d+)?(?:\\s+(?:bis|ter|quater))?\\.?|[a-zșşțţăâî]\\)|(?:a\\s+)?[IVX]{1,5}(?:-a)?(?!\\p{L})))*",
   "flags": "giu"
  },
  {
   "name": "FROM_ACT_RE",
   "what": "What joins a pointer to its act (\"din\", \"al\", \"ale\"…).",
   "source": "^\\s*(?:din|ale|al|ai|a)\\s+",
   "flags": "iu"
  },
  {
   "name": "CODE_RE",
   "what": "A code by name (Codul civil, de procedură…), the dotted abbreviations (C.civ., C.proc.pen.), the Constitution.",
   "source": "\\bCod(?:ul|ului)?\\s+(?:de\\s+procedură\\s+(?:civilă|penală|fiscală)|civil|penal|fiscal|muncii|rutier|vamal|silvic|aerian|comercial|administrativ)|\\bC\\.\\s?(?:proc\\.|pr\\.)\\s?(?:civ|pen|fisc)\\.?|\\bC\\.\\s?(?:civ|pen|fisc)\\.?|\\bConstitu[țţ]i(?:a|ei)(?:\\s+Rom[âî]niei)?",
   "flags": "giu"
  },
  {
   "name": "CODE_SIGLA_RE",
   "what": "Code siglas CPC / CPP / NCPC / NCPP — case-sensitive on purpose.",
   "source": "\\b(?:NCPC|NCPP|CPC|CPP)\\b",
   "flags": "gu"
  },
  {
   "name": "CAEN_RE",
   "what": "CAEN codes with the keyword required: cod CAEN 6201, clasa CAEN, CAEN Rev. 2 – 6201, lists.",
   "source": "(?:(?:clas[ăa]|grup[ăa]|diviziune[ai]?|sec[țţ]iune[ai]?)\\s+)?(?:cod(?:ul|uri|urile)?\\s+)?C\\.?A\\.?E\\.?N\\.?(?:\\s*Rev\\.?\\s*\\d)?(?:\\s+(?:principal|secundar)\\w*)?(?:\\s*[:\\-–—]\\s*|\\s+)\\d{2,4}(?:\\s*(?:,|[șş]i|\\/)\\s*\\d{2,4})*",
   "flags": "giu"
  },
  {
   "name": "CAEN_LINE_RE",
   "what": "A trade-register extract’s one-per-line list: \"6210 - Activități…\" (only in a text that mentions CAEN).",
   "source": "(^|\\n)([ \\t]*)(\\d{4})([ \\t]*[-–—][ \\t]+)(?=\\p{Lu})",
   "flags": "gu"
  },
  {
   "name": "CAEN_WORD_RE",
   "what": "Does the text mention CAEN at all (the context for CAEN_LINE_RE).",
   "source": "\\bC\\.?A\\.?E\\.?N\\b",
   "flags": "i"
  },
  {
   "name": "CAEN_REV_RE",
   "what": "The revision a document names: \"CAEN Rev. 2\", \"Rev. Caen (3)\".",
   "source": "(?:C\\.?A\\.?E\\.?N\\.?\\s*Rev\\.?\\s*\\(?\\s*(\\d)|Rev\\.?\\s*C\\.?A\\.?E\\.?N\\.?\\s*\\(?\\s*(\\d))",
   "flags": "i"
  },
  {
   "name": "BACKREF_RE",
   "what": "Pointing back at an act already cited: \"legea menționată mai sus\", \"actul normativ citat\".",
   "source": "(?:leg(?:ea|ii)|act(?:ul|ului)\\s+normativ|ordonan[țţ]\\p{L}*|hotăr[âî]r\\p{L}*|deciz\\p{L}*|ordin\\p{L}*|regulament\\p{L}*|directiv\\p{L}*)\\s+(?:sus-)?(?:men[țţ]ionat\\p{L}*|citat\\p{L}*|indicat\\p{L}*|amintit\\p{L}*|invocat\\p{L}*)(?:\\s+mai\\s+sus)?",
   "flags": "giu"
  },
  {
   "name": "CASE_RE",
   "what": "A court file number with the word required: \"Dosarul nr. 1.234/1/2023\".",
   "source": "\\bdosar(?:ul|ului|e|ele|elor)?\\s+(?:nr\\.?\\s*|num[ăa]r(?:ul)?\\s+)?(\\d{1,3}(?:\\.\\d{3})+|\\d{1,7})\\s*\\/\\s*(\\d{1,4}(?:\\.\\d{3})?)\\s*\\/\\s*(\\d{4})",
   "flags": "giu"
  },
  {
   "name": "CUI_RE",
   "what": "A fiscal code (CUI / CIF) after its keyword; the check digit is verified separately (weights 7 5 3 2 1 7 5 3 2).",
   "source": "(?:C\\.?\\s?U\\.?\\s?I\\.?|C\\.?\\s?I\\.?\\s?F\\.?|[Cc]od(?:ul)?\\s+[Uu]nic\\s+de\\s+[ÎîÂâIi]nregistrare(?:\\s+[Ff]iscal[ăa])?|[Cc]od(?:ul)?\\s+de\\s+[ÎîIi]nregistrare\\s+[Ff]iscal[ăa]|[Cc]od(?:ul)?\\s+de\\s+[Ii]dentificare\\s+[Ff]iscal[ăa]|[Cc]od(?:ul)?\\s+[Ff]iscal)\\s*(?:nr\\.?\\s*)?[:\\-–]?\\s*((?:RO\\s?)?(\\d{2,10}))(?!\\d)",
   "flags": "gu"
  },
  {
   "name": "EU_MARK_RE",
   "what": "An EU act’s body mark: (UE), (CE), /Euratom…",
   "source": "\\((?:UE|CE|CEE|EU)\\)|\\/(?:Euratom|CECO|CEEA|PESC|JAI|CEE|CE|UE|EU)\\b",
   "flags": "iu"
  },
  {
   "name": "TITLE_OPEN_RE",
   "what": "Where a title opens: privind / pentru / referitor la / asupra / cu privire la.",
   "source": "\\s(?:privind|pentru|referitor\\p{L}*\\s+la|asupra|cu\\s+privire\\s+la)\\s",
   "flags": "iu"
  },
  {
   "name": "TITLE_STOP_RE",
   "what": "Where a title ends: the first word that starts saying something ABOUT the act (se, este, prevede…).",
   "source": "\\s(?:se|s-a|s-au|este|sunt|era|erau|va|vor|care|nu|urmează|prevede|prevăd|stabile[șş]te|stabilesc|dispune|reglementează|răm[âî]ne|răm[âî]n|devine|devin|intră|cuprinde|impune|a\\s+fost|au\\s+fost|[îâ]n\\s+tot|[îâ]n\\s+cele)\\s",
   "flags": "iu"
  },
  {
   "name": "NOTE_ONE_RE",
   "what": "One republication / amendment note, read back apart.",
   "source": "\\s*,\\s*(republicat[ăa]|actualizat[ăa]|cu\\s+modificările(?:\\s+[șş]i\\s+completările)?\\s+ulterioare|cu\\s+completările\\s+ulterioare)",
   "flags": "giu"
  },
  {
   "name": "CAT_HEAD_RE",
   "what": "A citation that opens with an act category.",
   "source": "^(?:Ordonan[țţ]\\p{L}*\\s+de\\s+urgen[țţ]\\p{L}*(?:\\s+a\\s+Guvernului)?|Ordonan[țţ]\\p{L}*(?:\\s+a)?\\s+Guvernului|Ordonan[țţ]\\p{L}*|Hotăr[âî]r\\p{L}*(?:\\s+a)?\\s+Guvernului|Hotăr[âî]r\\p{L}*|Leg(?:ea|ii|e)|Decret(?:ul|ului)?(?:-lege)?|Ordin(?:ul|ului)?|Deciz(?:ia|iei)|Regulament(?:ul|ului)?|Directiv(?:a|ei)|Instruc[țţ]iun\\p{L}*|Norm\\p{L}*\\s+metodologic\\p{L}*|O\\.?U\\.?G\\.?|O\\.?G\\.?|H\\.?G\\.?|O\\.?M\\.?F\\.?P?\\.?)",
   "flags": "iu"
  }
 ],
 "groups": [
  {
   "id": "I",
   "name": "Economic and fiscal identifiers"
  },
  {
   "id": "II",
   "name": "Legal forms of organisation"
  },
  {
   "id": "III",
   "name": "Classifications and nomenclatures"
  },
  {
   "id": "IV",
   "name": "Normative acts (Legea nr. 24/2000)"
  },
  {
   "id": "V",
   "name": "Case law, courts and files"
  },
  {
   "id": "VI",
   "name": "Land registry and property"
  },
  {
   "id": "VII",
   "name": "Natural persons"
  },
  {
   "id": "VIII",
   "name": "Enforcement and notarial acts"
  },
  {
   "id": "IX",
   "name": "EU and international law"
  },
  {
   "id": "X",
   "name": "Legal connectors (context cues)"
  },
  {
   "id": "XI",
   "name": "Fiscal bodies (ANAF)"
  }
 ],
 "catalogue": [
  {
   "id": "euid",
   "group": "I",
   "name": "EUID — European unique identifier",
   "what": "The European form of the trade-register number: ROONRC. + the ONRC number. Tried before ONRC — it contains one.",
   "via": "shape",
   "live": false,
   "res": [
    {
     "source": "ROONRC\\.?\\s?[JFC]\\d{1,2}\\s*\\/\\s*\\d{1,7}\\s*\\/\\s*(?:19|20)\\d{2}",
     "flags": "gu"
    }
   ],
   "phrases": [
    "ROONRC.J40/123/2026"
   ],
   "examples": [
    "identificată prin EUID ROONRC.J40/123/2026"
   ],
   "ai": ""
  },
  {
   "id": "onrc",
   "group": "I",
   "name": "ONRC — trade-register number",
   "what": "J/F/C + county code + entry + year — J companies, F sole traders (PFA/II/IF), C cooperatives. The shape alone is distinctive.",
   "via": "shape",
   "live": false,
   "res": [
    {
     "source": "\\b[JFC]\\s?\\d{1,2}\\s*\\/\\s*\\d{1,7}\\s*\\/\\s*(?:19|20)\\d{2}\\b",
     "flags": "gu"
    },
    {
     "source": "(?:nr\\.?|num[ăa]r(?:ul)?)\\s+de\\s+ordine\\s+(?:[îâ]n|la)\\s+registrul\\s+comer[țţ]ului",
     "flags": "giu"
    }
   ],
   "phrases": [
    "J40/123/2026",
    "F12/456/2024",
    "C23/789/2025",
    "nr. de ordine în Registrul Comerțului"
   ],
   "examples": [
    "înmatriculată la ORC sub nr. J40/123/2026",
    "numărul de ordine în registrul comerțului F12/456/2024"
   ],
   "ai": "The identity reader (Fill from documents / Create identity) asks the model for this and writes it into the record. Record key: regNo."
  },
  {
   "id": "cui",
   "group": "I",
   "name": "CUI / CIF — fiscal code",
   "what": "2–10 digits, optionally RO-prefixed. The keyword is REQUIRED — bare digits are anything — and the acronyms are matched case-sensitively (“cui” is a Romanian word).",
   "via": "keyword",
   "live": false,
   "res": [
    {
     "source": "(?:C\\.?U\\.?I\\.?|C\\.?I\\.?F\\.?|[Cc]od(?:ul)?\\s+[Uu]nic\\s+de\\s+[ÎîÂâ]nregistrare(?:\\s+[Ff]iscal[ăa])?|[Cc]od(?:ul)?\\s+de\\s+[ÎîIi]nregistrare\\s+[Ff]iscal[ăa]|[Cc]od(?:ul)?\\s+de\\s+[Ii]dentificare\\s+[Ff]iscal[ăa]|[Cc]od(?:ul)?\\s+[Ff]iscal)\\s*(?:nr\\.?\\s*)?[:\\-–]?\\s*(?:RO\\s?)?\\d{2,10}\\b",
     "flags": "gu"
    }
   ],
   "phrases": [
    "CUI",
    "C.U.I.",
    "CIF",
    "C.I.F.",
    "Cod Unic de Înregistrare",
    "Cod de Identificare Fiscală"
   ],
   "examples": [
    "CUI RO12345678",
    "cod unic de înregistrare 987654",
    "C.I.F. RO 4204020"
   ],
   "ai": "The identity reader (Fill from documents / Create identity) asks the model for this and writes it into the record. Record key: taxId."
  },
  {
   "id": "ong",
   "group": "I",
   "name": "NGO registry — Registrul Asociațiilor și Fundațiilor",
   "what": "nr/A/year (associations), nr/B/year (federations), nr/PJ/year — the register kept at each court’s clerk’s office. The /A/ / /B/ / /PJ/ middle is what makes the bare shape safe.",
   "via": "shape",
   "live": false,
   "res": [
    {
     "source": "\\b\\d{1,5}\\s*\\/\\s*(?:A|B|PJ)\\s*\\/\\s*(?:19|20)\\d{2}\\b",
     "flags": "gu"
    },
    {
     "source": "registrul\\s+(?:special\\s+al\\s+)?asocia[țţ]iilor\\s+[șş]i\\s+funda[țţ]iilor",
     "flags": "giu"
    }
   ],
   "phrases": [
    "înscrisă în Registrul Asociațiilor și Fundațiilor sub nr.",
    "aflat la grefa Judecătoriei"
   ],
   "examples": [
    "înscrisă în Registrul Asociațiilor și Fundațiilor sub nr. 12/A/2020"
   ],
   "ai": ""
  },
  {
   "id": "iban",
   "group": "I",
   "name": "IBAN — Romanian bank account",
   "what": "RO + 2 check digits + 4-letter bank code + 16 alphanumerics = 24 characters, written solid or in groups of four.",
   "via": "shape",
   "live": false,
   "res": [
    {
     "source": "\\bRO\\d{2}(?:\\s?[A-Z0-9]{4}){5}\\b",
     "flags": "gu"
    }
   ],
   "phrases": [
    "contul IBAN",
    "cont curent"
   ],
   "examples": [
    "în contul IBAN RO49AAAA1B31007593840000",
    "cont RO49 AAAA 1B31 0075 9384 0000"
   ],
   "ai": "The identity reader (Fill from documents / Create identity) asks the model for this and writes it into the record. Record keys: iban, bank."
  },
  {
   "id": "fiscal-doc",
   "group": "I",
   "name": "Fiscal documents — e-Factura, invoices, receipts",
   "what": "An invoice or receipt by its series and number, a payment order, and the e-Factura system’s own ids (id descărcare, index încărcare).",
   "via": "keyword",
   "live": false,
   "res": [
    {
     "source": "factur\\p{L}*(?:\\s+fiscal\\p{L}*)?\\s+(?:seria\\s+[A-Z0-9-]{1,8}\\s*,?\\s*)?nr\\.?\\s*[0-9][0-9A-Za-z.\\/-]*|chitan[țţ]\\p{L}*\\s+(?:seria\\s+[A-Z0-9-]{1,8}\\s*,?\\s*)?nr\\.?\\s*\\d+|ordin(?:ul|e|ele)?\\s+de\\s+plat[ăa]\\s+nr\\.?\\s*\\d+|\\bOP\\s+nr\\.?\\s*\\d+|id(?:-ul)?\\s+(?:de\\s+)?desc[ăa]rcare(?:\\s+e-?factura)?\\s*:?\\s*\\d+|index(?:ul)?\\s+(?:de\\s+)?[îâ]nc[ăa]rcare\\s*:?\\s*\\d+",
     "flags": "giu"
    }
   ],
   "phrases": [
    "Factura seria X nr. Y",
    "Chitanța nr.",
    "Ordin de plată / OP nr.",
    "id descărcare e-Factura",
    "index încărcare"
   ],
   "examples": [
    "Factura seria ABC nr. 1042 din 03.02.2026",
    "achitat cu OP nr. 55",
    "index încărcare: 5312024"
   ],
   "ai": ""
  },
  {
   "id": "eori",
   "group": "I",
   "name": "EORI — customs operator number",
   "what": "RO followed directly by the CUI. Indistinguishable from a plain RO-prefixed CUI, so the EORI keyword is required.",
   "via": "keyword",
   "live": false,
   "res": [
    {
     "source": "\\bEORI\\b(?:\\s*(?:nr\\.?|:)?\\s*RO\\s?\\d{2,10})?",
     "flags": "gu"
    }
   ],
   "phrases": [
    "numărul EORI",
    "cod EORI"
   ],
   "examples": [
    "operator cu numărul EORI RO12345678"
   ],
   "ai": ""
  },
  {
   "id": "lei-code",
   "group": "I",
   "name": "LEI — legal entity identifier",
   "what": "20 alphanumerics. Matched only against the LEI keyword and only in capitals — otherwise every amount “în lei” would light up.",
   "via": "keyword",
   "live": false,
   "res": [
    {
     "source": "(?:[Cc]od(?:ul)?\\s+)?LEI\\s*:?\\s*[A-Z0-9]{20}\\b",
     "flags": "gu"
    }
   ],
   "phrases": [
    "cod LEI"
   ],
   "examples": [
    "cod LEI 549300GFX6WN7JDUSN34"
   ],
   "ai": ""
  },
  {
   "id": "legalform",
   "group": "II",
   "name": "Legal form — SRL, SA, PFA, BNP, BEJ…",
   "what": "The form a firm or a regulated practice trades under. Case-sensitive; the bare undotted SA, II, IF and CA are left out — in capitals they are also “să”, initials and Curtea de Apel — and C.A. (Cabinet de Avocat) is skipped for the same collision.",
   "via": "shape",
   "live": false,
   "res": [
    {
     "source": "(?<![\\p{L}.])(?:S\\.C\\.P\\.E\\.J\\.?|SCPEJ|S\\.P\\.R\\.L\\.?|SPRL|S\\.R\\.L\\.?|SRL|S\\.N\\.C\\.?|SNC|S\\.C\\.A\\.?|P\\.F\\.A\\.?|PFA|B\\.N\\.P\\.?|BNP|S\\.P\\.N\\.?|B\\.I\\.N\\.?|B\\.E\\.J\\.?|BEJ|C\\.M\\.I\\.?|B\\.I\\.A\\.?|S\\.A\\.?|Î\\.I\\.?|I\\.I\\.?|Î\\.F\\.?|I\\.F\\.?)(?!\\p{L})",
     "flags": "gu"
    }
   ],
   "phrases": [
    "S.R.L. / SRL",
    "S.A.",
    "P.F.A. / PFA",
    "I.I. / Î.I.",
    "I.F.",
    "S.N.C.",
    "S.C.A.",
    "S.P.R.L.",
    "B.N.P.",
    "S.P.N.",
    "B.I.N.",
    "B.E.J. / BEJ",
    "S.C.P.E.J.",
    "C.M.I.",
    "B.I.A."
   ],
   "examples": [
    "EXEMPLU CONS S.R.L.",
    "B.E.J. Ionescu Radu",
    "PFA Popescu Ana",
    "BANCA EXEMPLU S.A."
   ],
   "ai": "The identity reader (Fill from documents / Create identity) asks the model for this and writes it into the record. Record key: legalForm."
  },
  {
   "id": "caen",
   "group": "III",
   "name": "CAEN — economic activities",
   "what": "The nomenclature a company’s object of activity is written in. Keyword required — a bare four-digit number is a year or an amount. Live: marked amber in the Word preview, opens the CAEN tab / modal.",
   "via": "keyword",
   "live": true,
   "res": [
    {
     "source": "(?:(?:clas[ăa]|grup[ăa]|diviziune[ai]?|sec[țţ]iune[ai]?)\\s+)?(?:cod(?:ul|uri|urile)?\\s+)?C\\.?A\\.?E\\.?N\\.?(?:\\s*Rev\\.?\\s*\\d)?(?:\\s+(?:principal|secundar)\\w*)?(?:\\s*[:\\-–—]\\s*|\\s+)\\d{2,4}(?:\\s*(?:,|[șş]i|\\/)\\s*\\d{2,4})*",
     "flags": "giu"
    }
   ],
   "phrases": [
    "cod CAEN",
    "clasa CAEN",
    "CAEN Rev. 2 –",
    "obiect de activitate conform CAEN"
   ],
   "examples": [
    "cod CAEN 6201",
    "clasa CAEN 4711",
    "CAEN 6201, 6202 și 6209"
   ],
   "ai": "The Doc Viewer’s paragraph dock lists each code with its official name (ParaCaenCodes); the advisor sees them in context."
  },
  {
   "id": "cor",
   "group": "III",
   "name": "COR — occupations",
   "what": "Six digits after the COR keyword (capitals only).",
   "via": "keyword",
   "live": false,
   "res": [
    {
     "source": "(?:[Cc]od(?:ul|uri|urile)?\\s+)?COR\\s*:?[\\s-]*\\d{6}(?!\\d)",
     "flags": "gu"
    }
   ],
   "phrases": [
    "cod COR",
    "funcția ocupată conform COR"
   ],
   "examples": [
    "funcția de consilier juridic, cod COR 261103"
   ],
   "ai": ""
  },
  {
   "id": "cpv",
   "group": "III",
   "name": "CPV — public procurement vocabulary",
   "what": "8 digits, a dash and a check digit — distinctive enough on its own; the keyword form is tried first.",
   "via": "shape",
   "live": false,
   "res": [
    {
     "source": "(?:[Cc]od(?:ul|uri|urile)?\\s+)?CPV\\s*:?\\s*\\d{8}\\s*-\\s*\\d\\b",
     "flags": "gu"
    },
    {
     "source": "\\b\\d{8}-\\d\\b(?!-)",
     "flags": "gu"
    }
   ],
   "phrases": [
    "cod CPV",
    "achiziție publică având codul CPV"
   ],
   "examples": [
    "cod CPV 79110000-8",
    "servicii juridice 79100000-5"
   ],
   "ai": ""
  },
  {
   "id": "nc",
   "group": "III",
   "name": "NC — combined (customs) nomenclature",
   "what": "Eight digits, often spaced 4-2-2. Keyword required — eight bare digits are a phone number or an amount.",
   "via": "keyword",
   "live": false,
   "res": [
    {
     "source": "(?:cod(?:ul)?\\s+(?:vamal|NC)|pozi[țţ]i\\p{L}*\\s+tarifar[ăa](?:\\s+NC)?)\\s*:?\\s*\\d{4}(?:[ .]?\\d{2}){0,2}",
     "flags": "giu"
    }
   ],
   "phrases": [
    "cod vamal",
    "poziția tarifară NC"
   ],
   "examples": [
    "încadrate la poziția tarifară NC 8471 30 00"
   ],
   "ai": ""
  },
  {
   "id": "siruta",
   "group": "III",
   "name": "SIRUTA — administrative units",
   "what": "5–6 digits after the SIRUTA keyword.",
   "via": "keyword",
   "live": false,
   "res": [
    {
     "source": "(?:cod(?:ul)?\\s+)?SIRUTA\\s*:?\\s*\\d{4,6}\\b",
     "flags": "giu"
    }
   ],
   "phrases": [
    "cod SIRUTA",
    "localitatea X (SIRUTA: …)"
   ],
   "examples": [
    "localitatea Voluntari (cod SIRUTA 179587)"
   ],
   "ai": ""
  },
  {
   "id": "act",
   "group": "IV",
   "name": "Normative act — Legea / O.U.G. / H.G. / Ordinul / EU acts",
   "what": "Category + nr. + number/year (+ title on first mention, + republicată / cu modificările… notes, which are part of the citation). EU acts carry their body in brackets or after the number. Live: the AI-gradient mark in the Word preview; “Read here” opens it in the Legislation tab.",
   "via": "shape",
   "live": true,
   "res": [
    {
     "source": "(?:Ordonan[țţ]\\p{L}*\\s+de\\s+urgen[țţ]\\p{L}*(?:\\s+a\\s+Guvernului)?|Ordonan[țţ]\\p{L}*(?:\\s+a)?\\s+Guvernului|Ordonan[țţ]\\p{L}*|Hotăr[âî]r\\p{L}*(?:\\s+a)?\\s+Guvernului|Hotăr[âî]r\\p{L}*|Leg(?:ea|ii|e)|Decret(?:ul|ului)?(?:-lege)?|Ordin(?:ul|ului)?|Deciz(?:ia|iei)|Regulament(?:ul|ului)?|Directiv(?:a|ei)|Instruc[țţ]iun\\p{L}*|Norm\\p{L}*\\s+metodologic\\p{L}*|O\\.?U\\.?G\\.?|O\\.?G\\.?|H\\.?G\\.?|O\\.?M\\.?F\\.?P?\\.?)(?:\\s*\\((?:UE|CE|CEE|EU)\\))?\\s*(?:nr\\.?\\s*)?(\\d{1,5})\\s*\\/\\s*(\\d{2,4})(?:\\/(?:Euratom|CECO|CEEA|PESC|JAI|CEE|CE|UE|EU))?(?:\\s+(?:privind|pentru|referitor\\p{L}*\\s+la|asupra|cu\\s+privire\\s+la)\\s+[^.,;:()\\n]{2,200})?(?:\\s*,\\s*(?:republicat[ăa]|actualizat[ăa]|cu\\s+modificările(?:\\s+[șş]i\\s+completările)?\\s+ulterioare|cu\\s+completările\\s+ulterioare))*",
     "flags": "giu"
    }
   ],
   "phrases": [
    "Legea nr. 287/2009 privind Codul civil",
    "O.U.G. nr. 195/2002",
    "H.G. 1/2016",
    "Regulamentul (UE) 2016/679",
    "Directiva 96/29/Euratom",
    ", republicată",
    ", cu modificările și completările ulterioare"
   ],
   "examples": [
    "Legea nr. 24/2000 privind normele de tehnică legislativă, republicată",
    "Ordonanța de urgență a Guvernului nr. 195/2002"
   ],
   "ai": "lawRefDetails reads the citation apart (category, number, year, title, notes); the Legislation tab’s words search asks the AI what an act is called when the form is empty."
  },
  {
   "id": "element",
   "group": "IV",
   "name": "Structural element / internal cross-reference",
   "what": "art. / alin. / lit. / pct. / teza / cap. / anexa runs — with ^-indices (art. 155^1), bis/ter/quater, and roman values (teza a II-a, Cap. III). Followed by “din <act>” it folds into that citation; alone it is an INTERNAL pointer and (with a dotted target) becomes a go-to control. Live in the Word preview.",
   "via": "shape",
   "live": true,
   "res": [
    {
     "source": "\\b(?:art\\.|alin\\.|lit\\.|pct\\.|paragr\\.|parag\\.|cap\\.|articol\\p{L}*|alineat\\p{L}*|liter\\p{L}*|punct\\p{L}*|clauz\\p{L}*|capitol\\p{L}*|anex\\p{L}*|sec[țţ]iun\\p{L}*|tez\\p{L}*)\\s*(?:\\(\\d+\\)|\\d+(?:\\.\\d+)*(?:\\^\\d+)?(?:\\s+(?:bis|ter|quater))?\\.?|[a-zșşțţăâî]\\)|(?:a\\s+)?[IVX]{1,5}(?:-a)?(?!\\p{L}))(?:(?:\\s*(?:,|[șş]i|-|–)\\s*|\\s+)(?:(?:art\\.|alin\\.|lit\\.|pct\\.|paragr\\.|parag\\.|cap\\.|articol\\p{L}*|alineat\\p{L}*|liter\\p{L}*|punct\\p{L}*|clauz\\p{L}*|capitol\\p{L}*|anex\\p{L}*|sec[țţ]iun\\p{L}*|tez\\p{L}*)\\s*)?(?:\\(\\d+\\)|\\d+(?:\\.\\d+)*(?:\\^\\d+)?(?:\\s+(?:bis|ter|quater))?\\.?|[a-zșşțţăâî]\\)|(?:a\\s+)?[IVX]{1,5}(?:-a)?(?!\\p{L})))*",
     "flags": "giu"
    }
   ],
   "phrases": [
    "art. 12 alin. (1) lit. b)",
    "articolul",
    "alineatul",
    "litera",
    "punctul",
    "teza I / teza a II-a",
    "art. 155^1",
    "art. 4 bis"
   ],
   "examples": [
    "potrivit art. 12 alin. (1) lit. b) din Legea nr. 24/2000",
    "sancțiunea prevăzută la pct. 6.1. lit. d)",
    "art. 6 teza a II-a"
   ],
   "ai": "The AI is told a picked paragraph’s references; internal pointers are resolved to the clause they name, no AI involved."
  },
  {
   "id": "code",
   "group": "IV",
   "name": "National code, by name or sigla",
   "what": "Codul civil / penal / fiscal / muncii / administrativ…, the Constitution, the dotted abbreviations (C.civ., C.proc.pen., C. pr. civ.) and — case-sensitively — the bare siglas CPC / CPP / NCPC / NCPP. Live in the Word preview.",
   "via": "shape",
   "live": true,
   "res": [
    {
     "source": "\\bCod(?:ul|ului)?\\s+(?:de\\s+procedură\\s+(?:civilă|penală|fiscală)|civil|penal|fiscal|muncii|rutier|vamal|silvic|aerian|comercial|administrativ)|\\bC\\.\\s?(?:proc\\.|pr\\.)\\s?(?:civ|pen|fisc)\\.?|\\bC\\.\\s?(?:civ|pen|fisc)\\.?|\\bConstitu[țţ]i(?:a|ei)(?:\\s+Rom[âî]niei)?",
     "flags": "giu"
    },
    {
     "source": "\\b(?:NCPC|NCPP|CPC|CPP)\\b",
     "flags": "gu"
    }
   ],
   "phrases": [
    "Codul civil / C.civ.",
    "Codul de procedură civilă / C.proc.civ. / C. pr. civ. / CPC",
    "Codul penal / C.pen.",
    "Codul de procedură penală / CPP",
    "Codul muncii",
    "Codul fiscal",
    "Codul administrativ",
    "Codul silvic",
    "Constituția României"
   ],
   "examples": [
    "art. 1349 C.civ.",
    "în condițiile Codului administrativ",
    "art. 453 CPC"
   ],
   "ai": ""
  },
  {
   "id": "back",
   "group": "IV",
   "name": "Back-reference to the act just cited",
   "what": "“legea menționată mai sus”, “actul normativ citat” — the short form the drafting rules allow once the act has been named in full. Live in the Word preview.",
   "via": "shape",
   "live": true,
   "res": [
    {
     "source": "(?:leg(?:ea|ii)|act(?:ul|ului)\\s+normativ|ordonan[țţ]\\p{L}*|hotăr[âî]r\\p{L}*|deciz\\p{L}*|ordin\\p{L}*|regulament\\p{L}*|directiv\\p{L}*)\\s+(?:sus-)?(?:men[țţ]ionat\\p{L}*|citat\\p{L}*|indicat\\p{L}*|amintit\\p{L}*|invocat\\p{L}*)(?:\\s+mai\\s+sus)?",
     "flags": "giu"
    }
   ],
   "phrases": [
    "legea menționată mai sus",
    "actul normativ citat",
    "ordonanța sus-menționată"
   ],
   "examples": [
    "în sensul legii menționate mai sus"
   ],
   "ai": "Only the AI can say WHICH act it points back to — the regex only marks that it points."
  },
  {
   "id": "case",
   "group": "V",
   "name": "Court file (ECRIS)",
   "what": "number / court code / year, the word “dosar” required — three slashed numbers are otherwise a date. Thousands dots dropped. Live: opens the Court files tab.",
   "via": "keyword",
   "live": true,
   "res": [
    {
     "source": "\\bdosar(?:ul|ului|e|ele|elor)?\\s+(?:nr\\.?\\s*|num[ăa]r(?:ul)?\\s+)?(\\d{1,3}(?:\\.\\d{3})+|\\d{1,7})\\s*\\/\\s*(\\d{1,4}(?:\\.\\d{3})?)\\s*\\/\\s*(\\d{4})",
     "flags": "giu"
    }
   ],
   "phrases": [
    "dosar nr.",
    "dosarul penal nr.",
    "dosar asociat nr."
   ],
   "examples": [
    "în dosarul nr. 1.234/3/2023 al Tribunalului București"
   ],
   "ai": ""
  },
  {
   "id": "pcase",
   "group": "V",
   "name": "Prosecution file (parchet)",
   "what": "number /P/ year — the /P/ middle marks the criminal-investigation phase and makes the bare shape safe; “dosar penal nr.” is taken with it.",
   "via": "shape",
   "live": false,
   "res": [
    {
     "source": "(?:[Dd]osar(?:ul|ului)?\\s+(?:penal\\s+)?(?:nr\\.?\\s*|num[ăa]r(?:ul)?\\s+)?)?\\b\\d{1,6}\\s*\\/\\s*P\\s*\\/\\s*(?:19|20)\\d{2}\\b",
     "flags": "gu"
    }
   ],
   "phrases": [
    "dosar nr. X/P/An al Parchetului de pe lângă…"
   ],
   "examples": [
    "dosarul penal nr. 123/P/2024 al Parchetului de pe lângă Judecătoria Sectorului 1"
   ],
   "ai": ""
  },
  {
   "id": "pv",
   "group": "V",
   "name": "Proces-verbal (contravention report)",
   "what": "The report by its series and number — “proces-verbal … seria X nr. Y”, or the bare “seria XX nr. NNN” pair.",
   "via": "keyword",
   "live": false,
   "res": [
    {
     "source": "proces(?:ul|ului)?[-\\s]verbal(?:\\s+de\\s+constatare[^,;.\\n]{0,60}?|\\s+de\\s+contraven[țţ]ie)?\\s*,?\\s*(?:seria\\s+[A-Z0-9]{1,5}\\s*,?\\s*)?nr\\.?\\s*\\d+|\\bseria\\s+[A-Z]{2,4}\\s*,?\\s*nr\\.?\\s*\\d{3,}\\b",
     "flags": "giu"
    }
   ],
   "phrases": [
    "Proces-verbal de constatare și sancționare a contravenției seria X nr. Y"
   ],
   "examples": [
    "procesul-verbal de constatare a contravenției seria PCA nr. 1234567"
   ],
   "ai": ""
  },
  {
   "id": "decision",
   "group": "V",
   "name": "Court decision — sentință, decizie, încheiere",
   "what": "Sentința / Încheierea / Ordonanța președințială nr. …, and Decizia only with its civilă / penală qualifier — plain “Decizia nr. X/Y” already reads as a normative act.",
   "via": "shape",
   "live": false,
   "res": [
    {
     "source": "(?:sentin[țţ](?:a|ei)|[îâ]ncheier(?:ea|ii|e)(?:\\s+de\\s+[șş]edin[țţ][ăa])?|ordonan[țţ](?:a|ei)\\s+pre[șş]edin[țţ]ial[ăa])(?:\\s+(?:civil[ăae]|penal[ăae]|comercial[ăae]))?\\s+nr\\.?\\s*\\d+(?:\\s*\\/\\s*\\d{2,4}|\\s+din\\s+\\d{1,2}[./]\\d{1,2}[./]\\d{4}|\\s+din\\s+\\d{1,2}\\s+\\p{L}+\\s+\\d{4})?|decizi(?:a|ei)\\s+(?:civil[ăae]|penal[ăae]|comercial[ăae])\\s+nr\\.?\\s*\\d+(?:\\s*\\/\\s*\\d{2,4}|\\s+din\\s+[^,;.\\n]{4,30})?",
     "flags": "giu"
    }
   ],
   "phrases": [
    "Sentința civilă nr.",
    "Decizia penală nr.",
    "Încheierea de ședință",
    "Ordonanța președințială nr."
   ],
   "examples": [
    "prin Sentința civilă nr. 4521/2023",
    "Decizia civilă nr. 100 din 12.03.2024"
   ],
   "ai": ""
  },
  {
   "id": "court",
   "group": "V",
   "name": "Court name",
   "what": "Judecătoria / Tribunalul / Curtea de Apel + a capitalised name, and ÎCCJ in full or as sigla. A bare “Curtea de Apel” with no name is left alone.",
   "via": "shape",
   "live": false,
   "res": [
    {
     "source": "(?:Judec[ăa]tori(?:a|ei)|Tribunalul(?:ui)?(?:\\s+(?:Specializat|Militar|pentru\\s+[Mm]inori\\s+[șş]i\\s+[Ff]amilie))?|Cur(?:tea|[țţ]ii)\\s+(?:Militar[ăa]\\s+|Militare\\s+)?de\\s+Apel)\\s+(?:[A-ZĂÂÎȘŞȚŢ][\\p{L}-]*|\\d+)(?:[\\s-]+(?:[A-ZĂÂÎȘŞȚŢ][\\p{L}-]*|\\d+)){0,3}|[ÎI]nalt(?:a|ei)\\s+Cur(?:te|[țţ]i)\\s+de\\s+Casa[țţ]ie\\s+[șş]i\\s+Justi[țţ]ie|[ÎI]\\.?C\\.?C\\.?J\\.?(?!\\p{L})",
     "flags": "gu"
    }
   ],
   "phrases": [
    "Judecătoria Sectorului 4",
    "Tribunalul București",
    "Curtea de Apel Cluj",
    "Înalta Curte de Casație și Justiție / ÎCCJ"
   ],
   "examples": [
    "pe rolul Judecătoriei Sectorului 4 București",
    "Tribunalul pentru Minori și Familie Brașov",
    "decizia ÎCCJ"
   ],
   "ai": "The Court files tab’s own list (lib/courts.json) is the closed nomenclature; this regex only marks the words."
  },
  {
   "id": "ccr",
   "group": "V",
   "name": "Constitutional Court decision",
   "what": "Decizia Curții Constituționale / CCR nr. X/an or “din <date>”.",
   "via": "shape",
   "live": false,
   "res": [
    {
     "source": "decizi(?:a|ei)\\s+(?:cur[țţ]ii\\s+constitu[țţ]ionale(?:\\s+a\\s+rom[âî]niei)?|C\\.?C\\.?R\\.?)\\s*,?\\s*nr\\.?\\s*\\d+(?:\\s*\\/\\s*\\d{4}|\\s+din\\s+[^,;.\\n]{4,40})?",
     "flags": "giu"
    }
   ],
   "phrases": [
    "Decizia Curții Constituționale nr. X din …",
    "Decizia CCR nr. X/An"
   ],
   "examples": [
    "Decizia CCR nr. 458/2020",
    "Decizia Curții Constituționale nr. 405 din 15 iunie 2016"
   ],
   "ai": ""
  },
  {
   "id": "ril",
   "group": "V",
   "name": "RIL — appeal in the interest of the law",
   "what": "Decizia RIL nr. X/an, or Decizia nr. X/an + the “pronunțată în recursul în interesul legii” phrase — without either it is a plain act citation.",
   "via": "keyword",
   "live": false,
   "res": [
    {
     "source": "decizi(?:a|ei)\\s+(?:RIL\\s+nr\\.?\\s*\\d+\\s*\\/\\s*\\d{4}|nr\\.?\\s*\\d+\\s*\\/\\s*\\d{4}\\s*,?\\s*pronun[țţ]at[ăa]\\s+[îâ]n\\s+recurs(?:ul)?\\s+[îâ]n\\s+interesul\\s+legii)",
     "flags": "giu"
    }
   ],
   "phrases": [
    "Decizia RIL nr. X/An",
    "Decizia nr. X/An pronunțată în recursul în interesul legii"
   ],
   "examples": [
    "Decizia RIL nr. 19/2019",
    "Decizia nr. 3/2020 pronunțată în recursul în interesul legii"
   ],
   "ai": ""
  },
  {
   "id": "hp",
   "group": "V",
   "name": "HP — preliminary ruling on questions of law",
   "what": "Decizia HP nr. X/an, or Decizia nr. X/an + “pentru dezlegarea unor chestiuni de drept”.",
   "via": "keyword",
   "live": false,
   "res": [
    {
     "source": "decizi(?:a|ei)\\s+(?:HP\\s+nr\\.?\\s*\\d+\\s*\\/\\s*\\d{4}|nr\\.?\\s*\\d+\\s*\\/\\s*\\d{4}\\s*,?\\s*(?:pentru|privind)\\s+dezlegarea\\s+unor\\s+chestiuni\\s+de\\s+drept)",
     "flags": "giu"
    }
   ],
   "phrases": [
    "Decizia HP nr. X/An",
    "Decizia nr. X/An pentru dezlegarea unor chestiuni de drept"
   ],
   "examples": [
    "Decizia HP nr. 52/2018",
    "Decizia nr. 9/2016 pentru dezlegarea unor chestiuni de drept"
   ],
   "ai": ""
  },
  {
   "id": "cf",
   "group": "VI",
   "name": "Carte Funciară — land book",
   "what": "The land-book number, written out or as CF / C.F. The sigla is capitals-only: lowercase “cf.” is “confer”.",
   "via": "keyword",
   "live": false,
   "res": [
    {
     "source": "(?:[Cc]arte(?:a|ii)?\\s+[Ff]unciar[ăa]|C\\.?\\s?F\\.?)\\s+(?:nr\\.?\\s*)?\\d+",
     "flags": "gu"
    }
   ],
   "phrases": [
    "Carte Funciară nr.",
    "CF nr.",
    "C.F. nr."
   ],
   "examples": [
    "imobil înscris în Cartea Funciară nr. 54321 Cluj-Napoca",
    "CF nr. 12345"
   ],
   "ai": ""
  },
  {
   "id": "cadastral",
   "group": "VI",
   "name": "Cadastral number",
   "what": "“nr. cadastral X” / “nr. cad. X”.",
   "via": "keyword",
   "live": false,
   "res": [
    {
     "source": "(?:nr|num[ăa]r(?:ul)?)\\.?\\s*(?:cadastral|cad\\.?)\\s*:?\\s*\\d+",
     "flags": "giu"
    }
   ],
   "phrases": [
    "nr. cadastral",
    "nr. cad."
   ],
   "examples": [
    "identificat cu nr. cadastral 123",
    "nr. cad. 4567"
   ],
   "ai": ""
  },
  {
   "id": "topo",
   "group": "VI",
   "name": "Topographic number",
   "what": "“nr. topografic X” / “nr. top. X” — the older Transylvanian land-book numbering.",
   "via": "keyword",
   "live": false,
   "res": [
    {
     "source": "(?:nr|num[ăa]r(?:ul)?)\\.?\\s*top(?:ografic)?\\.?\\s*:?\\s*\\d+",
     "flags": "giu"
    }
   ],
   "phrases": [
    "nr. topografic",
    "nr. top."
   ],
   "examples": [
    "nr. top. 1024/2"
   ],
   "ai": ""
  },
  {
   "id": "tarla",
   "group": "VI",
   "name": "Tarla / parcelă",
   "what": "“Tarlaua X, Parcela Y” written out, or the bare “T X, P Y” pair — the pair, because a bare T or P is a letter.",
   "via": "shape",
   "live": false,
   "res": [
    {
     "source": "Tarla(?:ua)?\\s+[0-9A-Z\\/]+(?:\\s*,?\\s*[Pp]arcel(?:a|ele)?\\s+[0-9A-Z\\/]+)?|\\bT\\s?\\d+\\s*,?\\s*P\\s?\\d+(?!\\d)",
     "flags": "gu"
    }
   ],
   "phrases": [
    "Tarla X",
    "Parcela Y",
    "T X, P Y"
   ],
   "examples": [
    "teren situat în Tarlaua 24, Parcela 102/3",
    "amplasat în T 24, P 102"
   ],
   "ai": ""
  },
  {
   "id": "cnp",
   "group": "VII",
   "name": "CNP — personal numeric code",
   "what": "13 digits: sex/century digit 1–8, then a REAL date (month 01–12, day 01–31) — the date check is what keeps random 13-digit numbers out.",
   "via": "shape",
   "live": false,
   "res": [
    {
     "source": "(?:C\\.?N\\.?P\\.?\\s*:?\\s*)?\\b[1-8]\\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\\d|3[01])\\d{6}\\b",
     "flags": "gu"
    }
   ],
   "phrases": [
    "CNP"
   ],
   "examples": [
    "CNP 1850101123456",
    "domiciliat în …, 2921231123456"
   ],
   "ai": "The identity reader (Fill from documents / Create identity) asks the model for this and writes it into the record. Record key: nationalId."
  },
  {
   "id": "idcard",
   "group": "VII",
   "name": "Identity documents — C.I. / B.I. / passport",
   "what": "C.I. seria XX nr. NNNNNN (series 1–2 letters, number 6 digits), the old B.I., and “Pașaport nr.”.",
   "via": "keyword",
   "live": false,
   "res": [
    {
     "source": "(?:C\\.?I\\.?|B\\.?I\\.?|[Cc]arte(?:a)?\\s+de\\s+identitate|[Bb]uletin(?:ul)?(?:\\s+de\\s+identitate)?)\\s+seri[ae]\\s+[A-Z]{1,2}\\s*,?\\s*nr\\.?\\s*\\d{6}\\b|[Pp]a[șş]aport(?:ul)?\\s+nr\\.?\\s*\\d{6,9}\\b",
     "flags": "gu"
    }
   ],
   "phrases": [
    "C.I. seria XX nr. NNNNNN",
    "B.I. seria",
    "Pașaport nr."
   ],
   "examples": [
    "identificat cu C.I. seria RX nr. 456789",
    "pașaport nr. 05512345"
   ],
   "ai": "The identity reader (Fill from documents / Create identity) asks the model for this and writes it into the record. Record keys: idType, idSeries, idNumber."
  },
  {
   "id": "exec",
   "group": "VIII",
   "name": "Enforcement file",
   "what": "“Dosar de executare (silită) nr. X/an”, with the executing BEJ taken when named.",
   "via": "keyword",
   "live": false,
   "res": [
    {
     "source": "dosar(?:ul|ului)?\\s+(?:de\\s+)?executare(?:\\s+silit[ăa])?\\s+nr\\.?\\s*\\d+(?:\\s*\\/\\s*(?:19|20)?\\d{2,4})?(?:\\s+al\\s+(?:B\\.?E\\.?J\\.?|S\\.?C\\.?P\\.?E\\.?J\\.?)[^,;.\\n]{0,40})?",
     "flags": "giu"
    }
   ],
   "phrases": [
    "Dosar de executare silită nr. X/An"
   ],
   "examples": [
    "în dosarul de executare silită nr. 210/2024 al B.E.J. Ionescu"
   ],
   "ai": ""
  },
  {
   "id": "notarial",
   "group": "VIII",
   "name": "Notarial acts",
   "what": "“Încheiere de autentificare nr.” and “Certificat de moștenitor nr.”.",
   "via": "keyword",
   "live": false,
   "res": [
    {
     "source": "[îâ]ncheier(?:ea|ii|e)\\s+de\\s+autentificare\\s+nr\\.?\\s*\\d+(?:\\s*\\/\\s*[\\d.]+)?(?:\\s+din\\s+[^,;.\\n]{4,30})?|certificat(?:ul)?\\s+de\\s+mo[șş]tenitor\\s+nr\\.?\\s*\\d+(?:\\s*\\/\\s*\\d{4}|\\s+din\\s+[^,;.\\n]{4,30})?",
     "flags": "giu"
    }
   ],
   "phrases": [
    "Încheiere de autentificare nr.",
    "Certificat de moștenitor nr."
   ],
   "examples": [
    "autentificat prin Încheierea de autentificare nr. 1502 din 12 mai 2025",
    "certificat de moștenitor nr. 44/2023"
   ],
   "ai": ""
  },
  {
   "id": "cjue",
   "group": "IX",
   "name": "CJEU case",
   "what": "“Cauza C-131/12”, optionally with the party name; “Hotărârea CJUE în cauza …”. (EU regulations and directives are already acts.)",
   "via": "shape",
   "live": false,
   "res": [
    {
     "source": "[Cc]auz(?:a|ei)\\s+C[-‑–]\\s?\\d+\\/\\d{2}(?:\\s+[A-Z][\\p{L}-]+)?|Hot[ăa]r[âî]r(?:ea|ii)\\s+CJUE(?:\\s+[îâ]n\\s+cauza\\s+[^,;.\\n]{3,60})?",
     "flags": "gu"
    }
   ],
   "phrases": [
    "Cauza C-131/12",
    "Hotărârea CJUE în cauza"
   ],
   "examples": [
    "principiul stabilit în Cauza C-131/12 Google Spain"
   ],
   "ai": ""
  },
  {
   "id": "gdpr",
   "group": "IX",
   "name": "GDPR",
   "what": "The sigla, or the regulation by its Romanian description. The numbered form — Regulamentul (UE) 2016/679 — is already an act.",
   "via": "shape",
   "live": false,
   "res": [
    {
     "source": "\\bGDPR\\b|[Rr]egulamentul\\s+general\\s+privind\\s+protec[țţ]ia\\s+datelor",
     "flags": "gu"
    }
   ],
   "phrases": [
    "GDPR",
    "Regulamentul general privind protecția datelor"
   ],
   "examples": [
    "cu respectarea GDPR"
   ],
   "ai": ""
  },
  {
   "id": "cedo",
   "group": "IX",
   "name": "ECHR case law",
   "what": "“Hotărârea CEDO în cauza …”, the “X contra României” case-name shape, and “art. N din Convenție”.",
   "via": "shape",
   "live": false,
   "res": [
    {
     "source": "Hot[ăa]r[âî]r(?:ea|ii)\\s+(?:CEDO|Cur[țţ]ii\\s+Europene\\s+a\\s+Drepturilor\\s+Omului)(?:\\s+[îâ]n\\s+cauza\\s+[^,;.\\n]{3,60})?|[A-Z][\\p{L}-]+(?:\\s+[șş]i\\s+al[țţ]ii)?\\s+(?:contra|[îâ]mpotriva|c\\.)\\s+Rom[âî]niei\\b|art\\.?\\s*\\d+\\s+din\\s+Conven[țţ]i(?:e|a)(?!\\p{L})",
     "flags": "gu"
    }
   ],
   "phrases": [
    "Hotărârea CEDO în cauza X contra României",
    "art. 6 din Convenție"
   ],
   "examples": [
    "Hotărârea CEDO în cauza Popescu contra României",
    "garanțiile art. 6 din Convenție"
   ],
   "ai": ""
  },
  {
   "id": "connector",
   "group": "X",
   "name": "Legal connectors",
   "what": "Not identifiers — the phrases that announce one: a legal basis (“în temeiul”, “potrivit dispozițiilor”), a correlation (“coroborat cu”), an interpretive stance (“per a contrario”). Found by regex here, but their JOB is context: they tell the AI a citation follows.",
   "via": "context",
   "live": false,
   "res": [
    {
     "source": "(?:[îâ]n\\s+temeiul|[îâ]n\\s+drept\\b|potrivit\\s+dispozi[țţ]iilor|prin\\s+raportare\\s+la|av[âî]nd\\s+[îâ]n\\s+vedere\\s+(?:prevederile|dispozi[țţ]iile)|coroborat\\p{L}*\\s+cu|prin\\s+coroborare\\s+cu|[îâ]n\\s+conexiune\\s+cu|[îâ]n\\s+subsidiar|[îâ]n\\s+principal\\b|per\\s+a\\s+contrario|ad\\s+litteram)",
     "flags": "giu"
    }
   ],
   "phrases": [
    "în temeiul",
    "în drept",
    "potrivit dispozițiilor",
    "prin raportare la",
    "având în vedere prevederile",
    "coroborat cu",
    "în subsidiar",
    "per a contrario",
    "ad litteram"
   ],
   "examples": [
    "În temeiul art. 194 CPC, coroborat cu art. 148…",
    "în subsidiar, per a contrario"
   ],
   "ai": "These are the cues the AI reads a legal argument by — where one appears, an entity from this catalogue is imminent."
  },
  {
   "id": "fiscal-body",
   "group": "XI",
   "name": "Fiscal bodies — ANAF and its directorates",
   "what": "The issuers in the letterhead of a contested administrative act: ANAF, D.G.R.F.P., A.J.F.P., D.G.A.M.C., D.G.A.F. — siglas in capitals, names written out.",
   "via": "shape",
   "live": false,
   "res": [
    {
     "source": "\\bANAF\\b|Agen[țţ]i(?:a|ei)\\s+Na[țţ]ional[ăae]\\s+de\\s+Administrare\\s+Fiscal[ăa]|D\\.?G\\.?R\\.?F\\.?P\\.?(?!\\p{L})|Direc[țţ]i(?:a|ei)\\s+Generale?\\s+Regional[ăae]\\s+a\\s+Finan[țţ]elor\\s+Publice|A\\.?J\\.?F\\.?P\\.?(?!\\p{L})|Administra[țţ]i(?:a|ei)\\s+Jude[țţ]en[ăae]\\s+a\\s+Finan[țţ]elor\\s+Publice|D\\.?G\\.?A\\.?M\\.?C\\.?(?!\\p{L})|Direc[țţ]i(?:a|ei)\\s+Generale?\\s+de\\s+Administrare\\s+a\\s+Marilor\\s+Contribuabili|D\\.?G\\.?A\\.?F\\.?(?!\\p{L})|Direc[țţ]i(?:a|ei)\\s+Generale?\\s+Antifraud[ăa]\\s+Fiscal[ăa]",
     "flags": "gu"
    }
   ],
   "phrases": [
    "ANAF",
    "D.G.R.F.P.",
    "A.J.F.P.",
    "D.G.A.M.C.",
    "D.G.A.F."
   ],
   "examples": [
    "decizia de impunere emisă de A.J.F.P. Cluj",
    "inspecția fiscală ANAF — D.G.A.F."
   ],
   "ai": ""
  }
 ],
 "code": [
  {
   "file": "src/lib/lawRefs.js",
   "text": "// Romanian legal references — finding them in a document's text.\r\n//\r\n// Legea nr. 24/2000 (normele de tehnică legislativă) fixes how an act is cited\r\n// in an official, legal or administrative document, and Romanian drafting\r\n// follows it closely. That is what makes a citation findable by SHAPE rather\r\n// than by a list of known laws: it is a category of act, a number, a year and\r\n// (on first mention) the act's title, optionally preceded by the part of it\r\n// being pointed at and followed by a republication / amendment note.\r\n//\r\n// The shapes this recognises, in the order the drafting rules introduce them:\r\n//\r\n//   1. First mention, in full — `[categorie] nr. [număr]/[an] [titlul]`\r\n//        Legea nr. 287/2009 privind Codul civil\r\n//        Ordonanța de urgență a Guvernului nr. 195/2002 privind circulația …\r\n//   2. A structural element of an act — `art. N alin. (N) lit. x) din [act]`\r\n//        Potrivit art. 12 alin. (1) lit. b) din Legea nr. 24/2000 …\r\n//      The element on its own is a reference too (to the act under discussion),\r\n//      so `art. 5 alin. (2)` with no `din …` is still marked.\r\n//   3. Later mentions, short — `Legea nr. 24/2000`, `O.U.G. nr. 195/2002`, a\r\n//      code by name (`Codul fiscal`), or a phrase pointing back at the act just\r\n//      cited (`din legea menționată mai sus`, `actul normativ citat`).\r\n//   4. Republication / amendment notes, which are part of the citation and are\r\n//      taken with it: `, republicată`, `, cu modificările și completările\r\n//      ulterioare`.\r\n//   5. CAEN codes — `cod CAEN 6201`, `clasa CAEN 4711`, `CAEN 6201, 6202`.\r\n//      Not an act, but the same thing to a reader: a pointer into an official\r\n//      nomenclature, and how a company's object of activity is always written.\r\n//      The hit carries `codes` — the numbers on their own.\r\n//\r\n// Pure text in, ranges out — no DOM, no React — so the same detector serves the\r\n// Word preview, an extracted PDF text, or anything added later.\r\n\r\n// ── Diacritics ────────────────────────────────────────────────────────────\r\n// Romanian text in the wild carries BOTH the correct comma-below ș/ț and the\r\n// old cedilla ş/ţ (Windows-1250-era documents, and anything typed on a legacy\r\n// layout), so every pattern below is written with the correct letters and\r\n// widened here. Same for â/î, which alternate by spelling reform.\r\n//\r\n// One pass, from a map: chained .replace() calls would rewrite the brackets an\r\n// earlier call had just inserted (â → [âî], then the î inside that → [î[îâ]],\r\n// which is not a regex). A letter written INSIDE a character class is spelled\r\n// with its variants by hand instead — a class can't nest another one.\r\nconst DIA_CLASS = {\r\n  ș: '[șş]', Ș: '[ȘŞ]', ț: '[țţ]', Ț: '[ȚŢ]',\r\n  â: '[âî]', Â: '[ÂÎ]', î: '[îâ]', Î: '[ÎÂ]',\r\n};\r\nfunction dia(src) {\r\n  return src.replace(/[șȘțȚâÂîÎ]/g, (c) => DIA_CLASS[c]);\r\n}\r\n\r\n// A word's ending. NOT `\\w*`: that is ASCII-only even under the /u flag, so it\r\n// stops dead at the first diacritic — \"urgenț|ă\", \"menționat|ă\" — which is\r\n// exactly where a Romanian ending tends to begin.\r\nconst TAIL = '\\\\p{L}*';\r\n\r\n// ── The categories of normative act ───────────────────────────────────────\r\n// Written out and abbreviated, both of which the rules allow (the abbreviation\r\n// only after a full first mention, but a detector has no business policing\r\n// that). Declensions are covered by the loose ending — a citation reads \"Legea\r\n// nr. …\" in the nominative and \"Legii nr. …\" when governed by another word.\r\nconst CATEGORY = dia([\r\n  // Longest first: the alternation is ordered, so \"Ordonanța de urgență a\r\n  // Guvernului\" must be tried before \"Ordonanța\" would match its head alone.\r\n  `Ordonanț${TAIL}\\\\s+de\\\\s+urgenț${TAIL}(?:\\\\s+a\\\\s+Guvernului)?`,\r\n  `Ordonanț${TAIL}(?:\\\\s+a)?\\\\s+Guvernului`,\r\n  `Ordonanț${TAIL}`,\r\n  `Hotărâr${TAIL}(?:\\\\s+a)?\\\\s+Guvernului`,\r\n  `Hotărâr${TAIL}`,\r\n  'Leg(?:ea|ii|e)',\r\n  'Decret(?:ul|ului)?(?:-lege)?',\r\n  'Ordin(?:ul|ului)?',\r\n  'Deciz(?:ia|iei)',\r\n  'Regulament(?:ul|ului)?',\r\n  'Directiv(?:a|ei)',\r\n  `Instrucțiun${TAIL}`,\r\n  `Norm${TAIL}\\\\s+metodologic${TAIL}`,\r\n  // Abbreviations, with or without the dots people drop.\r\n  'O\\\\.?U\\\\.?G\\\\.?',\r\n  'O\\\\.?G\\\\.?',\r\n  'H\\\\.?G\\\\.?',\r\n  'O\\\\.?M\\\\.?F\\\\.?P?\\\\.?',\r\n].join('|'));\r\n\r\n// An EU act carries its issuing body in brackets before the number:\r\n// Regulamentul (UE) 2016/679, Directiva (CE) nr. 95/46.\r\nconst EU_TAG = '(?:\\\\s*\\\\((?:UE|CE|CEE|EU)\\\\))?';\r\n// `nr.` is optional — EU numbering omits it, and so do plenty of drafters.\r\nconst NUMBER = '(?:nr\\\\.?\\\\s*)?';\r\n// Romanian numbering is number/year, EU numbering year/number. Both are two\r\n// groups of digits around a slash, so one shape covers them and the caller\r\n// tells them apart by which side holds the four-digit year.\r\nconst NUM_YEAR = '(\\\\d{1,5})\\\\s*\\\\/\\\\s*(\\\\d{2,4})';\r\n// An older EU act carries its body AFTER the number instead: Directiva\r\n// 2007/43/CE, Regulamentul (CEE) nr. 2913/92, Directiva 96/29/Euratom. Part\r\n// of the number, so part of the reference — without it \"Directiva 2007/43\"\r\n// was marked and \"/CE\" left hanging.\r\n// Longest first: the alternation is ordered, and \"Euratom\" would otherwise\r\n// be cut to \"Eu\" (the match is case-insensitive).\r\nconst EU_SUFFIX = '(?:\\\\/(?:Euratom|CECO|CEEA|PESC|JAI|CEE|CE|UE|EU))?';\r\nconst EU_MARK_RE = /\\((?:UE|CE|CEE|EU)\\)|\\/(?:Euratom|CECO|CEEA|PESC|JAI|CEE|CE|UE|EU)\\b/iu;\r\nconst YEAR_NOW = new Date().getFullYear();\r\n// The title, on a first mention. It opens at `privind` / `pentru` and runs to\r\n// the end of the clause; punctuation closes it here, and `cutTitle` below ends\r\n// it at the first word that can only start a new clause.\r\nconst TITLE_OPEN = dia(`(?:privind|pentru|referitor${TAIL}\\\\s+la|asupra|cu\\\\s+privire\\\\s+la)`);\r\nconst TITLE = `(?:\\\\s+${TITLE_OPEN}\\\\s+[^.,;:()\\\\n]{2,200})?`;\r\n// Republication / amendment notes. Part of the citation, so they are taken with\r\n// it: \"Legea nr. 227/2015 privind Codul fiscal, cu modificările și completările\r\n// ulterioare.\"\r\nconst NOTES = dia('(?:\\\\s*,\\\\s*(?:republicat[ăa]|actualizat[ăa]|cu\\\\s+modificările(?:\\\\s+și\\\\s+completările)?\\\\s+ulterioare|cu\\\\s+completările\\\\s+ulterioare))*');\r\n\r\nconst ACT_RE = new RegExp(\r\n  `(?:${CATEGORY})${EU_TAG}\\\\s*${NUMBER}${NUM_YEAR}${EU_SUFFIX}${TITLE}${NOTES}`,\r\n  'giu',\r\n);\r\n\r\n// Where a title stops. It is a noun phrase naming the act; the moment the\r\n// sentence starts saying something ABOUT the act (\"… privind Codul civil se\r\n// aplică …\") the citation is over. Without this the highlight ran from the\r\n// number to the full stop and took half the sentence with it.\r\nconst TITLE_OPEN_RE = new RegExp(`\\\\s${TITLE_OPEN}\\\\s`, 'iu');\r\nconst TITLE_STOP_RE = new RegExp(dia(\r\n  '\\\\s(?:se|s-a|s-au|este|sunt|era|erau|va|vor|care|nu|urmează|prevede|prevăd'\r\n  + '|stabilește|stabilesc|dispune|reglementează|rămâne|rămân|devine|devin'\r\n  + '|intră|cuprinde|impune|a\\\\s+fost|au\\\\s+fost|în\\\\s+tot|în\\\\s+cele)\\\\s',\r\n), 'iu');\r\n\r\n// Which side of the slash is the year. A four-digit year is its own\r\n// evidence; a two-digit one (\"Legea nr. 31/90\", \"Directiva 96/29/CE\") is\r\n// the side with two digits; with both sides two digits an EU act reads\r\n// year/number and a Romanian one number/year. A two-digit year is given its\r\n// century, since it is what the Legislation tab searches by.\r\nconst plausibleYear = (x) => x.length === 4 && Number(x) >= 1800 && Number(x) <= YEAR_NOW + 1;\r\nfunction readNumberYear(a, b, raw) {\r\n  const eu = EU_MARK_RE.test(raw);\r\n  let year; let number;\r\n  if (plausibleYear(b) && !plausibleYear(a)) { year = b; number = a; }\r\n  else if (plausibleYear(a) && !plausibleYear(b)) { year = a; number = b; }\r\n  else if (b.length === 2 && a.length !== 2) { year = b; number = a; }\r\n  else if (a.length === 2 && b.length !== 2) { year = a; number = b; }\r\n  else if (eu) { year = a; number = b; }\r\n  else { year = b; number = a; }\r\n  if (year.length === 2) year = `${Number(year) > YEAR_NOW % 100 ? '19' : '20'}${year}`;\r\n  return { number, year };\r\n}\r\n\r\nfunction cutTitle(raw) {\r\n  const open = TITLE_OPEN_RE.exec(raw);\r\n  if (!open) return raw;\r\n  const from = open.index + open[0].length;\r\n  const stop = TITLE_STOP_RE.exec(raw.slice(from));\r\n  return stop ? raw.slice(0, from + stop.index) : raw;\r\n}\r\n\r\n// ── Structural elements ───────────────────────────────────────────────────\r\n// art. / alin. / lit. / pct. are the official abbreviations. A run starts at\r\n// any of them (a document mid-argument writes \"alin. (2) lit. b)\" alone) and\r\n// takes every element that follows, so the whole pointer is ONE reference\r\n// rather than three touching ones. `art. 12^1` is how an article inserted by a\r\n// later amendment is numbered.\r\n// The abbreviations Legea nr. 24/2000 prescribes, and the words they stand for:\r\n// a contract pointing at ITSELF writes them out (\"clauzei 4.3\", \"punctul 6.1\"),\r\n// and in whatever declension the sentence needs, so the endings are loose.\r\nconst ELEMENT = dia('(?:art\\\\.|alin\\\\.|lit\\\\.|pct\\\\.|paragr\\\\.|parag\\\\.|cap\\\\.'\r\n  + `|articol${TAIL}|alineat${TAIL}|liter${TAIL}|punct${TAIL}|clauz${TAIL}`\r\n  + `|capitol${TAIL}|anex${TAIL}|secțiun${TAIL}|tez${TAIL})`);\r\n// A bracketed number, a number, or a letter. The number may be DOTTED — \"6.1\",\r\n// \"4.3.2\" — which is how a contract numbers its own clauses and what an\r\n// internal cross-reference points at. Its trailing dot is taken WITH it\r\n// (\"pct. 6.1. lit. d)\"): Romanian numbering closes a clause number with one,\r\n// and leaving it outside split the run in two, so the pointer and the item it\r\n// points at came out as two references. `trimEnd` drops it again where it\r\n// really was a full stop.\r\n// Already a character class, so the letters are written with both diacritic\r\n// spellings by hand rather than run through dia().\r\n// A number may carry the Latin insertion words an older amendment used\r\n// (\"art. 4 bis\"), and a value may be a ROMAN numeral — \"Cap. III\", \"teza I\",\r\n// \"teza a II-a\" (the agreed article and the \"-a\" belong to it). The letter-\r\n// paren alternative stays AHEAD of the roman one: \"lit. i)\" is the letter i\r\n// with its paren, and the roman branch would take the bare \"i\" and leave the\r\n// paren hanging. `(?!\\p{L})` closes the roman so \"teza in...\" never reads\r\n// \"in\" as a numeral.\r\nconst ELEMENT_VALUE = '(?:\\\\(\\\\d+\\\\)|\\\\d+(?:\\\\.\\\\d+)*(?:\\\\^\\\\d+)?(?:\\\\s+(?:bis|ter|quater))?\\\\.?'\r\n  + '|[a-zșşțţăâî]\\\\)|(?:a\\\\s+)?[IVX]{1,5}(?:-a)?(?!\\\\p{L}))';\r\nconst ELEMENT_JOIN = `(?:\\\\s*(?:,|${dia('și')}|-|–)\\\\s*|\\\\s+)`;\r\nconst STRUCT_RE = new RegExp(\r\n  `\\\\b${ELEMENT}\\\\s*${ELEMENT_VALUE}(?:${ELEMENT_JOIN}(?:${ELEMENT}\\\\s*)?${ELEMENT_VALUE})*`,\r\n  'giu',\r\n);\r\n// What joins an element to the act it belongs to: \"art. 12 … din Legea nr. …\".\r\nconst FROM_ACT_RE = /^\\s*(?:din|ale|al|ai|a)\\s+/iu;\r\n\r\n// ── Codes and the Constitution ────────────────────────────────────────────\r\n// Cited by name, never by number — \"Codul civil\", not \"Legea nr. 287/2009\",\r\n// once the full form has been given.\r\n// The dotted abbreviations are how a pleading cites a code mid-sentence —\r\n// \"art. 1349 C.civ.\", \"art. 453 C.proc.pen.\" — with or without the inner\r\n// spaces (\"C. pr. civ.\"). The procedure forms come first in the alternation:\r\n// both start with \"C.\" and the plain form would cut \"C.proc.civ.\" at \"C.\".\r\nconst CODE_RE = new RegExp(dia(\r\n  '\\\\bCod(?:ul|ului)?\\\\s+(?:de\\\\s+procedură\\\\s+(?:civilă|penală|fiscală)'\r\n  + '|civil|penal|fiscal|muncii|rutier|vamal|silvic|aerian|comercial|administrativ)'\r\n  + '|\\\\bC\\\\.\\\\s?(?:proc\\\\.|pr\\\\.)\\\\s?(?:civ|pen|fisc)\\\\.?'\r\n  + '|\\\\bC\\\\.\\\\s?(?:civ|pen|fisc)\\\\.?'\r\n  + '|\\\\bConstituți(?:a|ei)(?:\\\\s+României)?',\r\n), 'giu');\r\n// The bare siglas — CPC, CPP, and the \"noul …\" forms from the 2011–2014\r\n// transition. CASE-SENSITIVE on purpose: under /i they would match ordinary\r\n// syllables, and nobody writes a code's sigla in lowercase.\r\nconst CODE_SIGLA_RE = /\\b(?:NCPC|NCPP|CPC|CPP)\\b/gu;\r\n\r\n// ── CAEN codes ────────────────────────────────────────────────────────────\r\n// Not a citation of an act but the same kind of thing to a reader: a pointer\r\n// into an official nomenclature (Clasificarea Activităților din Economia\r\n// Națională), and the way a Romanian company's object of activity is always\r\n// written — in the articles of association, the trade-register extract, the\r\n// contract's recitals. Marked so it is as findable as the laws around it.\r\n//\r\n// The shapes: `CAEN 6201`, `cod CAEN: 6201`, `codul CAEN principal 6920`,\r\n// `clasa CAEN 4711`, `CAEN Rev. 2 – 6201`, and lists (`CAEN 6201, 6202 și\r\n// 6209`). The keyword is REQUIRED — a bare four-digit number in a legal\r\n// document is far more often a year, an article or an amount.\r\nconst CAEN_RE = new RegExp(dia(\r\n  '(?:(?:clas[ăa]|grup[ăa]|diviziune[ai]?|secțiune[ai]?)\\\\s+)?'\r\n  + '(?:cod(?:ul|uri|urile)?\\\\s+)?'\r\n  + 'C\\\\.?A\\\\.?E\\\\.?N\\\\.?'\r\n  + '(?:\\\\s*Rev\\\\.?\\\\s*\\\\d)?'                       // CAEN Rev. 2 / Rev. 3\r\n  + '(?:\\\\s+(?:principal|secundar)\\\\w*)?'\r\n  + '(?:\\\\s*[:\\\\-–—]\\\\s*|\\\\s+)'\r\n  + '\\\\d{2,4}'                                      // the class / group / division\r\n  + '(?:\\\\s*(?:,|și|\\\\/)\\\\s*\\\\d{2,4})*',            // …and any others listed with it\r\n), 'giu');   // the whole pattern goes through dia() once — never dia() a part of it too\r\n\r\n// ── CAEN codes as a LIST, one per line ───────────────────────────────────\r\n// A trade-register extract (ONRC's \"Certificat constatator\", the \"Obiecte de\r\n// activitate\" of a registration) names the nomenclature ONCE — \"…conform\r\n// codificării (Ordin 377/2024) Rev. Caen (3)\" — and then lists the classes one\r\n// per line as `6210 - Activități de realizare a soft-ului …`. No keyword stands\r\n// beside each code, so CAEN_RE cannot see them. They are recognised by their\r\n// SHAPE — a line that is a four-digit number, a dash, and a capitalised name —\r\n// and only in a text that mentions CAEN at all (`caenContext`), since a bare\r\n// \"2024 - Anul …\" elsewhere is no activity.\r\nconst CAEN_LINE_RE = /(^|\\n)([ \\t]*)(\\d{4})([ \\t]*[-–—][ \\t]+)(?=\\p{Lu})/gu;\r\nconst CAEN_WORD_RE = /\\bC\\.?A\\.?E\\.?N\\b/i;\r\n// The revision the document names: \"CAEN Rev. 2\", \"Rev. Caen (3)\", \"Rev.3\".\r\nconst CAEN_REV_RE = /(?:C\\.?A\\.?E\\.?N\\.?\\s*Rev\\.?\\s*\\(?\\s*(\\d)|Rev\\.?\\s*C\\.?A\\.?E\\.?N\\.?\\s*\\(?\\s*(\\d))/i;\r\n/** Does a text speak of CAEN, and in which revision? → { on, rev } */\r\nexport function caenContextOf(text) {\r\n  const s = String(text || '');\r\n  const m = CAEN_REV_RE.exec(s);\r\n  return { on: CAEN_WORD_RE.test(s), rev: m ? Number(m[1] || m[2]) || 0 : 0 };\r\n}\r\n\r\n// ── Pointing back at the act already cited ────────────────────────────────\r\n// The short form the rules allow once the act has been named in full.\r\nconst BACKREF_RE = new RegExp(dia(\r\n  `(?:leg(?:ea|ii)|act(?:ul|ului)\\\\s+normativ|ordonanț${TAIL}|hotărâr${TAIL}`\r\n  + `|deciz${TAIL}|ordin${TAIL}|regulament${TAIL}|directiv${TAIL})`\r\n  + `\\\\s+(?:sus-)?(?:menționat${TAIL}|citat${TAIL}|indicat${TAIL}|amintit${TAIL}|invocat${TAIL})`\r\n  + '(?:\\\\s+mai\\\\s+sus)?',\r\n), 'giu');\r\n\r\n// Overlapping ranges are one reference seen twice (a code named inside an act's\r\n// title, an element run already folded into its act). The longer one — and, at\r\n// equal length, the earlier — is the reference; the other is dropped.\r\nexport function dropOverlaps(hits) {\r\n  const sorted = hits.slice().sort((a, b) => (a.start - b.start) || ((b.end - b.start) - (a.end - a.start)));\r\n  const out = [];\r\n  for (const hit of sorted) {\r\n    const last = out[out.length - 1];\r\n    if (last && hit.start < last.end) {\r\n      if (hit.end > last.end) out[out.length - 1] = hit;\r\n      continue;\r\n    }\r\n    out.push(hit);\r\n  }\r\n  return out;\r\n}\r\n\r\n// Trailing space or punctuation a pattern swept up is not part of the\r\n// reference — it would be underlined for nothing.\r\nfunction trimEnd(hit, text) {\r\n  let end = hit.end;\r\n  while (end > hit.start && /[\\s,;:.]/.test(text[end - 1])) end -= 1;\r\n  return { ...hit, end, raw: text.slice(hit.start, end) };\r\n}\r\n\r\n/**\r\n * Every reference to a normative act in `text`.\r\n *\r\n * @returns {{ start:number, end:number, raw:string, kind:'act'|'element'|'code'|'back'|'caen',\r\n *             number?:string, year?:string, codes?:string[], rev?:number, target?:string, letter?:string }[]}\r\n *          in document order, never overlapping. An `element` with a `target` is\r\n *          an INTERNAL cross-reference — a clause of this same document.\r\n */\r\nexport function findLawRefs(text, { caenContext = null } = {}) {\r\n  const s = String(text || '');\r\n  if (s.length < 6) return [];\r\n  const hits = [];\r\n  // Whether this text is in a CAEN setting — handed in by a caller that scans\r\n  // a document a paragraph at a time (the Word preview), else read here.\r\n  const caen = caenContext || caenContextOf(s);\r\n\r\n  // 1. Acts with a number — the anchor everything else hangs off.\r\n  const acts = [];\r\n  ACT_RE.lastIndex = 0;\r\n  for (let m = ACT_RE.exec(s); m; m = ACT_RE.exec(s)) {\r\n    const raw = cutTitle(m[0]);\r\n    const { number, year } = readNumberYear(m[1], m[2], raw);\r\n    const hit = { start: m.index, end: m.index + raw.length, raw, kind: 'act', number, year };\r\n    acts.push(hit);\r\n    hits.push(hit);\r\n  }\r\n\r\n  // 2. Structural elements. One immediately followed by `din <act>` belongs to\r\n  //    that citation, so the two are marked as ONE reference — \"art. 12 alin.\r\n  //    (1) lit. b) din Legea nr. 24/2000\" is a single thing a reader looks up.\r\n  STRUCT_RE.lastIndex = 0;\r\n  for (let m = STRUCT_RE.exec(s); m; m = STRUCT_RE.exec(s)) {\r\n    const end = m.index + m[0].length;\r\n    const join = FROM_ACT_RE.exec(s.slice(end, end + 8));\r\n    const act = join ? acts.find((h) => h.start === end + join[0].length) : null;\r\n    if (act) { act.start = m.index; act.raw = s.slice(m.index, act.end); continue; }\r\n    // No act after it: the pointer is INTERNAL — it means a clause of the\r\n    // document being read (\"…indicată la pct. 6.1. lit. d)\"). `target` is the\r\n    // clause number it points at and `letter` the item within it, which is what\r\n    // lets a reader be taken there.\r\n    const target = (/\\d+(?:\\.\\d+)*/.exec(m[0]) || [''])[0];\r\n    const letter = (/lit\\.\\s*([a-zșşțţăâî])\\)/i.exec(m[0]) || ['', ''])[1];\r\n    hits.push({ start: m.index, end, raw: m[0], kind: 'element', target, letter });\r\n  }\r\n\r\n  // 3. Codes / the Constitution, and 4. the short forms pointing back.\r\n  CODE_RE.lastIndex = 0;\r\n  for (let m = CODE_RE.exec(s); m; m = CODE_RE.exec(s)) {\r\n    hits.push({ start: m.index, end: m.index + m[0].length, raw: m[0], kind: 'code' });\r\n  }\r\n  CODE_SIGLA_RE.lastIndex = 0;\r\n  for (let m = CODE_SIGLA_RE.exec(s); m; m = CODE_SIGLA_RE.exec(s)) {\r\n    hits.push({ start: m.index, end: m.index + m[0].length, raw: m[0], kind: 'code' });\r\n  }\r\n  BACKREF_RE.lastIndex = 0;\r\n  for (let m = BACKREF_RE.exec(s); m; m = BACKREF_RE.exec(s)) {\r\n    hits.push({ start: m.index, end: m.index + m[0].length, raw: m[0], kind: 'back' });\r\n  }\r\n  // 5. CAEN codes — the company's object of activity, by nomenclature number.\r\n  CAEN_RE.lastIndex = 0;\r\n  for (let m = CAEN_RE.exec(s); m; m = CAEN_RE.exec(s)) {\r\n    // The revision is dropped before the numbers are read, or \"CAEN Rev. 2 –\r\n    // 6201\" would report the revision as a code.\r\n    const codes = m[0].replace(/Rev\\.?\\s*\\d+/i, '').match(/\\d{2,4}/g) || [];\r\n    // …and kept on its own: \"6201\" means one thing in Rev. 2 and another in\r\n    // Rev. 3, so the revision a citation names decides how it is read (lib/caen).\r\n    const rev = Number((/Rev\\.?\\s*(\\d)/i.exec(m[0]) || [])[1]) || 0;\r\n    hits.push({ start: m.index, end: m.index + m[0].length, raw: m[0], kind: 'caen', codes, rev });\r\n  }\r\n  // 5b. …and the one-per-line list of an extract (\"6210 - Activități de …\").\r\n  if (caen.on) {\r\n    CAEN_LINE_RE.lastIndex = 0;\r\n    for (let m = CAEN_LINE_RE.exec(s); m; m = CAEN_LINE_RE.exec(s)) {\r\n      const start = m.index + m[1].length + m[2].length;\r\n      hits.push({ start, end: start + 4, raw: m[3], kind: 'caen', codes: [m[3]], rev: caen.rev || 0 });\r\n    }\r\n  }\r\n\r\n  return dropOverlaps(hits).map((h) => trimEnd(h, s)).filter((h) => h.end > h.start);\r\n}\r\n\r\n// ── Court file numbers ────────────────────────────────────────────────────\r\n// \"Dosarul nr. 1.234/1/2023\" — a file at a court, by the number the courts'\r\n// portal knows it by (number / court code / year), which is how a published\r\n// decision names the case it was given in. The word is REQUIRED: three\r\n// numbers with slashes between them are otherwise a date. Thousands dots are\r\n// dropped from the number (\"1.234\" → \"1234\"), which is how the portal wants it.\r\nconst CASE_RE = new RegExp(dia(\r\n  '\\\\bdosar(?:ul|ului|e|ele|elor)?\\\\s+(?:nr\\\\.?\\\\s*|num[ăa]r(?:ul)?\\\\s+)?'\r\n  + '(\\\\d{1,3}(?:\\\\.\\\\d{3})+|\\\\d{1,7})\\\\s*\\\\/\\\\s*(\\\\d{1,4}(?:\\\\.\\\\d{3})?)\\\\s*\\\\/\\\\s*(\\\\d{4})',\r\n), 'giu');\r\n\r\n/**\r\n * Every court file number in `text` — `{ start, end, raw, kind: 'case', number }`,\r\n * `number` as the courts' portal takes it (\"1234/1/2023\").\r\n */\r\nexport function findCaseRefs(text) {\r\n  const s = String(text || '');\r\n  if (s.length < 10) return [];\r\n  const hits = [];\r\n  CASE_RE.lastIndex = 0;\r\n  for (let m = CASE_RE.exec(s); m; m = CASE_RE.exec(s)) {\r\n    const number = `${m[1].replace(/\\./g, '')}/${m[2].replace(/\\./g, '')}/${m[3]}`;\r\n    hits.push({ start: m.index, end: m.index + m[0].length, raw: m[0], kind: 'case', number });\r\n  }\r\n  return hits;\r\n}\r\n\r\n/**\r\n * The references a READER can follow out of a passage, for a page that turns\r\n * them into controls: acts and codes (→ the Legislation tab), CAEN codes (→ the\r\n * CAEN nomenclature), court file numbers (→ Court files). Internal\r\n * cross-references and short back-references are left out — they point at the\r\n * document itself. In document order, never overlapping.\r\n */\r\nexport function findFollowableRefs(text) {\r\n  const law = findLawRefs(text).filter((h) => h.kind === 'act' || h.kind === 'code' || h.kind === 'caen');\r\n  const extra = [...findCaseRefs(text), ...findCuiRefs(text)];\r\n  if (!extra.length) return law;\r\n  return dropOverlaps([...law, ...extra]);\r\n}\r\n\r\n// ── A company's fiscal code (CUI / CIF) ──────────────────────────────\r\n// \"Cod unic de înregistrare : 54912561\", \"CUI RO 14399840\", \"C.I.F. 4204020\",\r\n// \"cod fiscal RO54912561\", \"Codul de identificare fiscală: …\" — the KEYWORD is\r\n// required (bare digits are anything: a sum, a phone number, a file number),\r\n// the acronyms are matched in capitals (\"cui\" is a Romanian word), and the\r\n// number must pass the CUI check digit, which is what keeps a registration\r\n// number or an amount that happens to follow the word out. A hit carries\r\n// `cui` (digits only) — ANAF answers it (the ANAF tab, `/anaf?cui=`).\r\nconst CUI_KEYWORD = String.raw`(?:C\\.?\\s?U\\.?\\s?I\\.?|C\\.?\\s?I\\.?\\s?F\\.?|[Cc]od(?:ul)?\\s+[Uu]nic\\s+de\\s+[ÎîÂâIi]nregistrare(?:\\s+[Ff]iscal[ăa])?|[Cc]od(?:ul)?\\s+de\\s+[ÎîIi]nregistrare\\s+[Ff]iscal[ăa]|[Cc]od(?:ul)?\\s+de\\s+[Ii]dentificare\\s+[Ff]iscal[ăa]|[Cc]od(?:ul)?\\s+[Ff]iscal)`;\r\nconst CUI_RE = new RegExp(`${CUI_KEYWORD}\\\\s*(?:nr\\\\.?\\\\s*)?[:\\\\-–]?\\\\s*((?:RO\\\\s?)?(\\\\d{2,10}))(?!\\\\d)`, 'gu');\r\nconst CUI_KEY = [7, 5, 3, 2, 1, 7, 5, 3, 2];\r\nexport function cuiValid(digits) {\r\n  const s = String(digits || '');\r\n  if (!/^\\d{2,10}$/.test(s)) return false;\r\n  const body = s.slice(0, -1).padStart(9, '0').split('').map(Number);\r\n  const c = (body.reduce((n, d, i) => n + d * CUI_KEY[i], 0) * 10) % 11;\r\n  return (c === 10 ? 0 : c) === Number(s.slice(-1));\r\n}\r\nexport function findCuiRefs(text) {\r\n  const out = [];\r\n  const s = String(text || '');\r\n  CUI_RE.lastIndex = 0;\r\n  for (let m = CUI_RE.exec(s); m; m = CUI_RE.exec(s)) {\r\n    if (!cuiValid(m[2])) continue;\r\n    // A letter glued before the keyword (\"ACUI…\") is not the keyword.\r\n    if (m.index > 0 && /\\p{L}/u.test(s[m.index - 1])) continue;\r\n    out.push({ kind: 'cui', start: m.index, end: m.index + m[0].length, raw: m[0], cui: m[2] });\r\n  }\r\n  return out;\r\n}\r\n\r\n/** A short label for one reference — what a tooltip or a list calls it. */\r\n// ── Reading a citation back out ─────────────────────────────────────\r\n// The detector's job is to find WHERE a citation is; this takes the text it\r\n// found and says WHAT it is — the pointer into the act, the category, the\r\n// number and year, the title and the republication notes, each on its own, so\r\n// a reader can be shown the parts of a citation rather than the string.\r\n//\r\n// It reads the same `raw` the mark covers, with the same patterns that matched\r\n// it, so the two can never disagree about what a citation contains.\r\nconst CAT_HEAD_RE = new RegExp(`^(?:${CATEGORY})`, 'iu');\r\n// The pointer and the act are joined by \"din\": \"art. 12 alin. (1) lit. b) din\r\n// Legea nr. 24/2000\". Only when a CATEGORY follows — \"din\" is an ordinary word\r\n// and a title is full of them.\r\nconst JOINED_BY_DIN_RE = /\\s+din\\s+/iu;\r\nconst NOTE_ONE_RE = new RegExp(dia(\r\n  '\\\\s*,\\\\s*(republicat[ăa]|actualizat[ăa]'\r\n  + '|cu\\\\s+modificările(?:\\\\s+și\\\\s+completările)?\\\\s+ulterioare'\r\n  + '|cu\\\\s+completările\\\\s+ulterioare)',\r\n), 'giu');\r\nconst TITLE_FROM_RE = new RegExp(`\\\\s${TITLE_OPEN}\\\\s+([\\\\s\\\\S]+)$`, 'iu');\r\n\r\n/**\r\n * The parts of one reference, for showing it to a reader.\r\n * @param {object} hit one entry from `findLawRefs`\r\n * @returns {{ kind:string, raw:string, element:string, category:string,\r\n *             number:string, year:string, title:string, notes:string[],\r\n *             codes:string[], heading:string }}\r\n *          `heading` is the shortest thing that names the act (\"Legea nr.\r\n *          24/2000\"), for when the citation itself is a paragraph long.\r\n */\r\nexport function lawRefDetails(hit) {\r\n  const out = {\r\n    kind: hit?.kind || '',\r\n    raw: (hit?.raw || '').trim(),\r\n    element: '',\r\n    category: '',\r\n    number: hit?.number || '',\r\n    year: hit?.year || '',\r\n    title: '',\r\n    notes: [],\r\n    codes: hit?.codes || [],\r\n    heading: '',\r\n  };\r\n  let raw = out.raw;\r\n  const din = JOINED_BY_DIN_RE.exec(raw);\r\n  if (din) {\r\n    const after = raw.slice(din.index + din[0].length);\r\n    if (CAT_HEAD_RE.test(after)) {\r\n      out.element = raw.slice(0, din.index).trim();\r\n      raw = after;\r\n    }\r\n  }\r\n  NOTE_ONE_RE.lastIndex = 0;\r\n  raw = raw.replace(NOTE_ONE_RE, (_m, note) => { out.notes.push(note.trim()); return ''; });\r\n  const cat = CAT_HEAD_RE.exec(raw);\r\n  if (cat) out.category = cat[0].trim();\r\n  const title = TITLE_FROM_RE.exec(raw);\r\n  // The opening word belongs to the title as it is read aloud (\"privind Codul\r\n  // civil\"), so it is kept: without it the line reads as a bare noun phrase\r\n  // hanging off nothing.\r\n  if (title) out.title = raw.slice(title.index).trim().replace(/[.,;:]+$/, '');\r\n  out.heading = out.title ? raw.slice(0, title.index).trim() : raw.trim();\r\n  if (!out.heading) out.heading = out.raw;\r\n  return out;\r\n}\r\n\r\n// Where to send a reader who wants the act itself.\r\n//\r\n// The official source is the Ministry of Justice's legislative portal, and it\r\n// has NO addressable page for an act by number and year: a document there is\r\n// reached by an internal id, and its search is a form POST. So this is a\r\n// search of that site rather than a link into it, which is the honest version\r\n// — a made-up /Public/DetaliiDocument/<guess> is a 404 with a straight face.\r\nconst LAW_PORTAL = 'legislatie.just.ro';\r\nexport function lawRefLookupUrl(hit) {\r\n  if (!hit) return '';\r\n  if (hit.kind === 'caen') {\r\n    const codes = (hit.codes || []).join(' ');\r\n    return `https://www.google.com/search?q=${encodeURIComponent(`cod CAEN ${codes}`.trim())}`;\r\n  }\r\n  const d = lawRefDetails(hit);\r\n  // The heading alone, not the whole citation: a title of two hundred\r\n  // characters is a worse query than \"Legea nr. 24/2000\", and the number and\r\n  // year are what identify an act.\r\n  const q = d.number && d.year\r\n    ? `${d.category || ''} ${d.number}/${d.year}`.trim()\r\n    : d.heading || hit.raw;\r\n  return `https://www.google.com/search?q=${encodeURIComponent(`${q} site:${LAW_PORTAL}`)}`;\r\n}\r\n\r\nexport function lawRefLabel(hit) {\r\n  if (!hit) return '';\r\n  if (hit.kind === 'element') return hit.target ? `Go to ${hit.target}` : 'Part of an act';\r\n  if (hit.kind === 'code') return 'Code';\r\n  if (hit.kind === 'back') return 'The act cited above';\r\n  if (hit.kind === 'caen') {\r\n    const codes = hit.codes || [];\r\n    return codes.length > 1 ? `CAEN codes ${codes.join(', ')}` : `CAEN code ${codes[0] || ''}`.trim();\r\n  }\r\n  return hit.number && hit.year ? `Act no. ${hit.number}/${hit.year}` : 'Normative act';\r\n}\r\n\r\n// ═══ The wider catalogue — every legal identifier the app recognises ═══════\r\n//\r\n// A Romanian legal document is full of identifiers that are not citations of\r\n// acts but are the same kind of thing to a reader: registry numbers, fiscal\r\n// codes, court files, land-registry entries, the phrases that announce a legal\r\n// basis. This catalogue is the ONE list of them — what each is, the regex that\r\n// finds it, the phrases it rides on, and what the AI side does with it — and\r\n// it is what the Debug tab's \"Legal references\" section renders, so every way\r\n// the app recognises these can be READ in one place.\r\n//\r\n// Each entry: `id` (the hit's `kind`), `group` (REF_GROUPS), `name`, `what`\r\n// (one line, for a reader), `via` — 'shape' (the pattern alone is evidence\r\n// enough), 'keyword' (the digits mean nothing without their keyword) or\r\n// 'context' (not an identifier but a cue that one follows — what the AI is\r\n// steered by) — `res` (the regexes, in the order they are tried), `phrases`\r\n// (the wording it answers to), `examples` (real-shaped text the Debug tab runs\r\n// the entry's own regexes over), `ai` (what the AI layer does with it, when it\r\n// does anything), and `live: true` on the kinds `findLawRefs` / `findCaseRefs`\r\n// already find — those are NOT run again by `findEntityRefs`.\r\n//\r\n// Boundary note: JS `\\b` is ASCII-only, so it is useless next to a diacritic\r\n// (`\\bîn` never matches — space→î is no boundary to \\b). Patterns here lean on\r\n// `scanRefPatterns`' own letter-boundary check instead, and only use `\\b`\r\n// against ASCII letters and digits.\r\n\r\nexport const REF_GROUPS = [\r\n  { id: 'I', name: 'Economic and fiscal identifiers' },\r\n  { id: 'II', name: 'Legal forms of organisation' },\r\n  { id: 'III', name: 'Classifications and nomenclatures' },\r\n  { id: 'IV', name: 'Normative acts (Legea nr. 24/2000)' },\r\n  { id: 'V', name: 'Case law, courts and files' },\r\n  { id: 'VI', name: 'Land registry and property' },\r\n  { id: 'VII', name: 'Natural persons' },\r\n  { id: 'VIII', name: 'Enforcement and notarial acts' },\r\n  { id: 'IX', name: 'EU and international law' },\r\n  { id: 'X', name: 'Legal connectors (context cues)' },\r\n  { id: 'XI', name: 'Fiscal bodies (ANAF)' },\r\n];\r\n\r\nconst IDENTITY_AI = 'The identity reader (Fill from documents / Create identity) asks the model for this and writes it into the record.';\r\n\r\nexport const REF_CATALOGUE = [\r\n  // ── I. Economic and fiscal identifiers ────────────────────────────────\r\n  {\r\n    id: 'euid',\r\n    group: 'I',\r\n    name: 'EUID — European unique identifier',\r\n    what: 'The European form of the trade-register number: ROONRC. + the ONRC number. Tried before ONRC — it contains one.',\r\n    via: 'shape',\r\n    res: [new RegExp('ROONRC\\\\.?\\\\s?[JFC]\\\\d{1,2}\\\\s*\\\\/\\\\s*\\\\d{1,7}\\\\s*\\\\/\\\\s*(?:19|20)\\\\d{2}', 'gu')],\r\n    phrases: ['ROONRC.J40/123/2026'],\r\n    examples: ['identificată prin EUID ROONRC.J40/123/2026'],\r\n    ai: '',\r\n  },\r\n  {\r\n    id: 'onrc',\r\n    group: 'I',\r\n    name: 'ONRC — trade-register number',\r\n    what: 'J/F/C + county code + entry + year — J companies, F sole traders (PFA/II/IF), C cooperatives. The shape alone is distinctive.',\r\n    via: 'shape',\r\n    res: [\r\n      new RegExp('\\\\b[JFC]\\\\s?\\\\d{1,2}\\\\s*\\\\/\\\\s*\\\\d{1,7}\\\\s*\\\\/\\\\s*(?:19|20)\\\\d{2}\\\\b', 'gu'),\r\n      new RegExp('(?:nr\\\\.?|num[ăa]r(?:ul)?)\\\\s+de\\\\s+ordine\\\\s+(?:[îâ]n|la)\\\\s+registrul\\\\s+comer[țţ]ului', 'giu'),\r\n    ],\r\n    phrases: ['J40/123/2026', 'F12/456/2024', 'C23/789/2025', 'nr. de ordine în Registrul Comerțului'],\r\n    examples: ['înmatriculată la ORC sub nr. J40/123/2026', 'numărul de ordine în registrul comerțului F12/456/2024'],\r\n    ai: IDENTITY_AI + ' Record key: regNo.',\r\n  },\r\n  {\r\n    id: 'cui',\r\n    group: 'I',\r\n    name: 'CUI / CIF — fiscal code',\r\n    what: '2–10 digits, optionally RO-prefixed. The keyword is REQUIRED — bare digits are anything — and the acronyms are matched case-sensitively (“cui” is a Romanian word).',\r\n    via: 'keyword',\r\n    res: [new RegExp(\r\n      '(?:C\\\\.?U\\\\.?I\\\\.?|C\\\\.?I\\\\.?F\\\\.?|[Cc]od(?:ul)?\\\\s+[Uu]nic\\\\s+de\\\\s+[ÎîÂâ]nregistrare(?:\\\\s+[Ff]iscal[ăa])?|[Cc]od(?:ul)?\\\\s+de\\\\s+[ÎîIi]nregistrare\\\\s+[Ff]iscal[ăa]|[Cc]od(?:ul)?\\\\s+de\\\\s+[Ii]dentificare\\\\s+[Ff]iscal[ăa]|[Cc]od(?:ul)?\\\\s+[Ff]iscal)\\\\s*(?:nr\\\\.?\\\\s*)?[:\\\\-–]?\\\\s*(?:RO\\\\s?)?\\\\d{2,10}\\\\b',\r\n      'gu',\r\n    )],\r\n    phrases: ['CUI', 'C.U.I.', 'CIF', 'C.I.F.', 'Cod Unic de Înregistrare', 'Cod de Identificare Fiscală'],\r\n    examples: ['CUI RO12345678', 'cod unic de înregistrare 987654', 'C.I.F. RO 4204020'],\r\n    ai: IDENTITY_AI + ' Record key: taxId.',\r\n  },\r\n  {\r\n    id: 'ong',\r\n    group: 'I',\r\n    name: 'NGO registry — Registrul Asociațiilor și Fundațiilor',\r\n    what: 'nr/A/year (associations), nr/B/year (federations), nr/PJ/year — the register kept at each court’s clerk’s office. The /A/ / /B/ / /PJ/ middle is what makes the bare shape safe.',\r\n    via: 'shape',\r\n    res: [\r\n      new RegExp('\\\\b\\\\d{1,5}\\\\s*\\\\/\\\\s*(?:A|B|PJ)\\\\s*\\\\/\\\\s*(?:19|20)\\\\d{2}\\\\b', 'gu'),\r\n      new RegExp('registrul\\\\s+(?:special\\\\s+al\\\\s+)?asocia[țţ]iilor\\\\s+[șş]i\\\\s+funda[țţ]iilor', 'giu'),\r\n    ],\r\n    phrases: ['înscrisă în Registrul Asociațiilor și Fundațiilor sub nr.', 'aflat la grefa Judecătoriei'],\r\n    examples: ['înscrisă în Registrul Asociațiilor și Fundațiilor sub nr. 12/A/2020'],\r\n    ai: '',\r\n  },\r\n  {\r\n    id: 'iban',\r\n    group: 'I',\r\n    name: 'IBAN — Romanian bank account',\r\n    what: 'RO + 2 check digits + 4-letter bank code + 16 alphanumerics = 24 characters, written solid or in groups of four.',\r\n    via: 'shape',\r\n    res: [new RegExp('\\\\bRO\\\\d{2}(?:\\\\s?[A-Z0-9]{4}){5}\\\\b', 'gu')],\r\n    phrases: ['contul IBAN', 'cont curent'],\r\n    examples: ['în contul IBAN RO49AAAA1B31007593840000', 'cont RO49 AAAA 1B31 0075 9384 0000'],\r\n    ai: IDENTITY_AI + ' Record keys: iban, bank.',\r\n  },\r\n  {\r\n    id: 'fiscal-doc',\r\n    group: 'I',\r\n    name: 'Fiscal documents — e-Factura, invoices, receipts',\r\n    what: 'An invoice or receipt by its series and number, a payment order, and the e-Factura system’s own ids (id descărcare, index încărcare).',\r\n    via: 'keyword',\r\n    res: [new RegExp(\r\n      'factur\\\\p{L}*(?:\\\\s+fiscal\\\\p{L}*)?\\\\s+(?:seria\\\\s+[A-Z0-9-]{1,8}\\\\s*,?\\\\s*)?nr\\\\.?\\\\s*[0-9][0-9A-Za-z.\\\\/-]*'\r\n      + '|chitan[țţ]\\\\p{L}*\\\\s+(?:seria\\\\s+[A-Z0-9-]{1,8}\\\\s*,?\\\\s*)?nr\\\\.?\\\\s*\\\\d+'\r\n      + '|ordin(?:ul|e|ele)?\\\\s+de\\\\s+plat[ăa]\\\\s+nr\\\\.?\\\\s*\\\\d+|\\\\bOP\\\\s+nr\\\\.?\\\\s*\\\\d+'\r\n      + '|id(?:-ul)?\\\\s+(?:de\\\\s+)?desc[ăa]rcare(?:\\\\s+e-?factura)?\\\\s*:?\\\\s*\\\\d+'\r\n      + '|index(?:ul)?\\\\s+(?:de\\\\s+)?[îâ]nc[ăa]rcare\\\\s*:?\\\\s*\\\\d+',\r\n      'giu',\r\n    )],\r\n    phrases: ['Factura seria X nr. Y', 'Chitanța nr.', 'Ordin de plată / OP nr.', 'id descărcare e-Factura', 'index încărcare'],\r\n    examples: ['Factura seria ABC nr. 1042 din 03.02.2026', 'achitat cu OP nr. 55', 'index încărcare: 5312024'],\r\n    ai: '',\r\n  },\r\n  {\r\n    id: 'eori',\r\n    group: 'I',\r\n    name: 'EORI — customs operator number',\r\n    what: 'RO followed directly by the CUI. Indistinguishable from a plain RO-prefixed CUI, so the EORI keyword is required.',\r\n    via: 'keyword',\r\n    res: [new RegExp('\\\\bEORI\\\\b(?:\\\\s*(?:nr\\\\.?|:)?\\\\s*RO\\\\s?\\\\d{2,10})?', 'gu')],\r\n    phrases: ['numărul EORI', 'cod EORI'],\r\n    examples: ['operator cu numărul EORI RO12345678'],\r\n    ai: '',\r\n  },\r\n  {\r\n    id: 'lei-code',\r\n    group: 'I',\r\n    name: 'LEI — legal entity identifier',\r\n    what: '20 alphanumerics. Matched only against the LEI keyword and only in capitals — otherwise every amount “în lei” would light up.',\r\n    via: 'keyword',\r\n    res: [new RegExp('(?:[Cc]od(?:ul)?\\\\s+)?LEI\\\\s*:?\\\\s*[A-Z0-9]{20}\\\\b', 'gu')],\r\n    phrases: ['cod LEI'],\r\n    examples: ['cod LEI 549300GFX6WN7JDUSN34'],\r\n    ai: '',\r\n  },\r\n\r\n  // ── II. Legal forms ───────────────────────────────────────────────────\r\n  {\r\n    id: 'legalform',\r\n    group: 'II',\r\n    name: 'Legal form — SRL, SA, PFA, BNP, BEJ…',\r\n    what: 'The form a firm or a regulated practice trades under. Case-sensitive; the bare undotted SA, II, IF and CA are left out — in capitals they are also “să”, initials and Curtea de Apel — and C.A. (Cabinet de Avocat) is skipped for the same collision.',\r\n    via: 'shape',\r\n    res: [new RegExp(\r\n      '(?<![\\\\p{L}.])(?:S\\\\.C\\\\.P\\\\.E\\\\.J\\\\.?|SCPEJ|S\\\\.P\\\\.R\\\\.L\\\\.?|SPRL|S\\\\.R\\\\.L\\\\.?|SRL|S\\\\.N\\\\.C\\\\.?|SNC'\r\n      + '|S\\\\.C\\\\.A\\\\.?|P\\\\.F\\\\.A\\\\.?|PFA|B\\\\.N\\\\.P\\\\.?|BNP|S\\\\.P\\\\.N\\\\.?|B\\\\.I\\\\.N\\\\.?|B\\\\.E\\\\.J\\\\.?|BEJ'\r\n      + '|C\\\\.M\\\\.I\\\\.?|B\\\\.I\\\\.A\\\\.?|S\\\\.A\\\\.?|Î\\\\.I\\\\.?|I\\\\.I\\\\.?|Î\\\\.F\\\\.?|I\\\\.F\\\\.?)(?!\\\\p{L})',\r\n      'gu',\r\n    )],\r\n    phrases: ['S.R.L. / SRL', 'S.A.', 'P.F.A. / PFA', 'I.I. / Î.I.', 'I.F.', 'S.N.C.', 'S.C.A.', 'S.P.R.L.', 'B.N.P.', 'S.P.N.', 'B.I.N.', 'B.E.J. / BEJ', 'S.C.P.E.J.', 'C.M.I.', 'B.I.A.'],\r\n    examples: ['EXEMPLU CONS S.R.L.', 'B.E.J. Ionescu Radu', 'PFA Popescu Ana', 'BANCA EXEMPLU S.A.'],\r\n    ai: IDENTITY_AI + ' Record key: legalForm.',\r\n  },\r\n\r\n  // ── III. Classifications ──────────────────────────────────────────────\r\n  {\r\n    id: 'caen',\r\n    group: 'III',\r\n    name: 'CAEN — economic activities',\r\n    what: 'The nomenclature a company’s object of activity is written in. Keyword required — a bare four-digit number is a year or an amount. Live: marked amber in the Word preview, opens the CAEN tab / modal.',\r\n    via: 'keyword',\r\n    live: true,\r\n    res: [CAEN_RE],\r\n    phrases: ['cod CAEN', 'clasa CAEN', 'CAEN Rev. 2 –', 'obiect de activitate conform CAEN'],\r\n    examples: ['cod CAEN 6201', 'clasa CAEN 4711', 'CAEN 6201, 6202 și 6209'],\r\n    ai: 'The Doc Viewer’s paragraph dock lists each code with its official name (ParaCaenCodes); the advisor sees them in context.',\r\n  },\r\n  {\r\n    id: 'cor',\r\n    group: 'III',\r\n    name: 'COR — occupations',\r\n    what: 'Six digits after the COR keyword (capitals only).',\r\n    via: 'keyword',\r\n    res: [new RegExp('(?:[Cc]od(?:ul|uri|urile)?\\\\s+)?COR\\\\s*:?[\\\\s-]*\\\\d{6}(?!\\\\d)', 'gu')],\r\n    phrases: ['cod COR', 'funcția ocupată conform COR'],\r\n    examples: ['funcția de consilier juridic, cod COR 261103'],\r\n    ai: '',\r\n  },\r\n  {\r\n    id: 'cpv',\r\n    group: 'III',\r\n    name: 'CPV — public procurement vocabulary',\r\n    what: '8 digits, a dash and a check digit — distinctive enough on its own; the keyword form is tried first.',\r\n    via: 'shape',\r\n    res: [\r\n      new RegExp('(?:[Cc]od(?:ul|uri|urile)?\\\\s+)?CPV\\\\s*:?\\\\s*\\\\d{8}\\\\s*-\\\\s*\\\\d\\\\b', 'gu'),\r\n      new RegExp('\\\\b\\\\d{8}-\\\\d\\\\b(?!-)', 'gu'),\r\n    ],\r\n    phrases: ['cod CPV', 'achiziție publică având codul CPV'],\r\n    examples: ['cod CPV 79110000-8', 'servicii juridice 79100000-5'],\r\n    ai: '',\r\n  },\r\n  {\r\n    id: 'nc',\r\n    group: 'III',\r\n    name: 'NC — combined (customs) nomenclature',\r\n    what: 'Eight digits, often spaced 4-2-2. Keyword required — eight bare digits are a phone number or an amount.',\r\n    via: 'keyword',\r\n    res: [new RegExp('(?:cod(?:ul)?\\\\s+(?:vamal|NC)|pozi[țţ]i\\\\p{L}*\\\\s+tarifar[ăa](?:\\\\s+NC)?)\\\\s*:?\\\\s*\\\\d{4}(?:[ .]?\\\\d{2}){0,2}', 'giu')],\r\n    phrases: ['cod vamal', 'poziția tarifară NC'],\r\n    examples: ['încadrate la poziția tarifară NC 8471 30 00'],\r\n    ai: '',\r\n  },\r\n  {\r\n    id: 'siruta',\r\n    group: 'III',\r\n    name: 'SIRUTA — administrative units',\r\n    what: '5–6 digits after the SIRUTA keyword.',\r\n    via: 'keyword',\r\n    res: [new RegExp('(?:cod(?:ul)?\\\\s+)?SIRUTA\\\\s*:?\\\\s*\\\\d{4,6}\\\\b', 'giu')],\r\n    phrases: ['cod SIRUTA', 'localitatea X (SIRUTA: …)'],\r\n    examples: ['localitatea Voluntari (cod SIRUTA 179587)'],\r\n    ai: '',\r\n  },\r\n\r\n  // ── IV. Normative acts ────────────────────────────────────────────────\r\n  {\r\n    id: 'act',\r\n    group: 'IV',\r\n    name: 'Normative act — Legea / O.U.G. / H.G. / Ordinul / EU acts',\r\n    what: 'Category + nr. + number/year (+ title on first mention, + republicată / cu modificările… notes, which are part of the citation). EU acts carry their body in brackets or after the number. Live: the AI-gradient mark in the Word preview; “Read here” opens it in the Legislation tab.',\r\n    via: 'shape',\r\n    live: true,\r\n    res: [ACT_RE],\r\n    phrases: ['Legea nr. 287/2009 privind Codul civil', 'O.U.G. nr. 195/2002', 'H.G. 1/2016', 'Regulamentul (UE) 2016/679', 'Directiva 96/29/Euratom', ', republicată', ', cu modificările și completările ulterioare'],\r\n    examples: ['Legea nr. 24/2000 privind normele de tehnică legislativă, republicată', 'Ordonanța de urgență a Guvernului nr. 195/2002'],\r\n    ai: 'lawRefDetails reads the citation apart (category, number, year, title, notes); the Legislation tab’s words search asks the AI what an act is called when the form is empty.',\r\n  },\r\n  {\r\n    id: 'element',\r\n    group: 'IV',\r\n    name: 'Structural element / internal cross-reference',\r\n    what: 'art. / alin. / lit. / pct. / teza / cap. / anexa runs — with ^-indices (art. 155^1), bis/ter/quater, and roman values (teza a II-a, Cap. III). Followed by “din <act>” it folds into that citation; alone it is an INTERNAL pointer and (with a dotted target) becomes a go-to control. Live in the Word preview.',\r\n    via: 'shape',\r\n    live: true,\r\n    res: [STRUCT_RE],\r\n    phrases: ['art. 12 alin. (1) lit. b)', 'articolul', 'alineatul', 'litera', 'punctul', 'teza I / teza a II-a', 'art. 155^1', 'art. 4 bis'],\r\n    examples: ['potrivit art. 12 alin. (1) lit. b) din Legea nr. 24/2000', 'sancțiunea prevăzută la pct. 6.1. lit. d)', 'art. 6 teza a II-a'],\r\n    ai: 'The AI is told a picked paragraph’s references; internal pointers are resolved to the clause they name, no AI involved.',\r\n  },\r\n  {\r\n    id: 'code',\r\n    group: 'IV',\r\n    name: 'National code, by name or sigla',\r\n    what: 'Codul civil / penal / fiscal / muncii / administrativ…, the Constitution, the dotted abbreviations (C.civ., C.proc.pen., C. pr. civ.) and — case-sensitively — the bare siglas CPC / CPP / NCPC / NCPP. Live in the Word preview.',\r\n    via: 'shape',\r\n    live: true,\r\n    res: [CODE_RE, CODE_SIGLA_RE],\r\n    phrases: ['Codul civil / C.civ.', 'Codul de procedură civilă / C.proc.civ. / C. pr. civ. / CPC', 'Codul penal / C.pen.', 'Codul de procedură penală / CPP', 'Codul muncii', 'Codul fiscal', 'Codul administrativ', 'Codul silvic', 'Constituția României'],\r\n    examples: ['art. 1349 C.civ.', 'în condițiile Codului administrativ', 'art. 453 CPC'],\r\n    ai: '',\r\n  },\r\n  {\r\n    id: 'back',\r\n    group: 'IV',\r\n    name: 'Back-reference to the act just cited',\r\n    what: '“legea menționată mai sus”, “actul normativ citat” — the short form the drafting rules allow once the act has been named in full. Live in the Word preview.',\r\n    via: 'shape',\r\n    live: true,\r\n    res: [BACKREF_RE],\r\n    phrases: ['legea menționată mai sus', 'actul normativ citat', 'ordonanța sus-menționată'],\r\n    examples: ['în sensul legii menționate mai sus'],\r\n    ai: 'Only the AI can say WHICH act it points back to — the regex only marks that it points.',\r\n  },\r\n\r\n  // ── V. Case law, courts and files ─────────────────────────────────────\r\n  {\r\n    id: 'case',\r\n    group: 'V',\r\n    name: 'Court file (ECRIS)',\r\n    what: 'number / court code / year, the word “dosar” required — three slashed numbers are otherwise a date. Thousands dots dropped. Live: opens the Court files tab.',\r\n    via: 'keyword',\r\n    live: true,\r\n    res: [CASE_RE],\r\n    phrases: ['dosar nr.', 'dosarul penal nr.', 'dosar asociat nr.'],\r\n    examples: ['în dosarul nr. 1.234/3/2023 al Tribunalului București'],\r\n    ai: '',\r\n  },\r\n  {\r\n    id: 'pcase',\r\n    group: 'V',\r\n    name: 'Prosecution file (parchet)',\r\n    what: 'number /P/ year — the /P/ middle marks the criminal-investigation phase and makes the bare shape safe; “dosar penal nr.” is taken with it.',\r\n    via: 'shape',\r\n    res: [new RegExp('(?:[Dd]osar(?:ul|ului)?\\\\s+(?:penal\\\\s+)?(?:nr\\\\.?\\\\s*|num[ăa]r(?:ul)?\\\\s+)?)?\\\\b\\\\d{1,6}\\\\s*\\\\/\\\\s*P\\\\s*\\\\/\\\\s*(?:19|20)\\\\d{2}\\\\b', 'gu')],\r\n    phrases: ['dosar nr. X/P/An al Parchetului de pe lângă…'],\r\n    examples: ['dosarul penal nr. 123/P/2024 al Parchetului de pe lângă Judecătoria Sectorului 1'],\r\n    ai: '',\r\n  },\r\n  {\r\n    id: 'pv',\r\n    group: 'V',\r\n    name: 'Proces-verbal (contravention report)',\r\n    what: 'The report by its series and number — “proces-verbal … seria X nr. Y”, or the bare “seria XX nr. NNN” pair.',\r\n    via: 'keyword',\r\n    res: [new RegExp(\r\n      'proces(?:ul|ului)?[-\\\\s]verbal(?:\\\\s+de\\\\s+constatare[^,;.\\\\n]{0,60}?|\\\\s+de\\\\s+contraven[țţ]ie)?\\\\s*,?\\\\s*(?:seria\\\\s+[A-Z0-9]{1,5}\\\\s*,?\\\\s*)?nr\\\\.?\\\\s*\\\\d+'\r\n      + '|\\\\bseria\\\\s+[A-Z]{2,4}\\\\s*,?\\\\s*nr\\\\.?\\\\s*\\\\d{3,}\\\\b',\r\n      'giu',\r\n    )],\r\n    phrases: ['Proces-verbal de constatare și sancționare a contravenției seria X nr. Y'],\r\n    examples: ['procesul-verbal de constatare a contravenției seria PCA nr. 1234567'],\r\n    ai: '',\r\n  },\r\n  {\r\n    id: 'decision',\r\n    group: 'V',\r\n    name: 'Court decision — sentință, decizie, încheiere',\r\n    what: 'Sentința / Încheierea / Ordonanța președințială nr. …, and Decizia only with its civilă / penală qualifier — plain “Decizia nr. X/Y” already reads as a normative act.',\r\n    via: 'shape',\r\n    res: [new RegExp(\r\n      '(?:sentin[țţ](?:a|ei)|[îâ]ncheier(?:ea|ii|e)(?:\\\\s+de\\\\s+[șş]edin[țţ][ăa])?|ordonan[țţ](?:a|ei)\\\\s+pre[șş]edin[țţ]ial[ăa])'\r\n      + '(?:\\\\s+(?:civil[ăae]|penal[ăae]|comercial[ăae]))?\\\\s+nr\\\\.?\\\\s*\\\\d+(?:\\\\s*\\\\/\\\\s*\\\\d{2,4}|\\\\s+din\\\\s+\\\\d{1,2}[./]\\\\d{1,2}[./]\\\\d{4}|\\\\s+din\\\\s+\\\\d{1,2}\\\\s+\\\\p{L}+\\\\s+\\\\d{4})?'\r\n      + '|decizi(?:a|ei)\\\\s+(?:civil[ăae]|penal[ăae]|comercial[ăae])\\\\s+nr\\\\.?\\\\s*\\\\d+(?:\\\\s*\\\\/\\\\s*\\\\d{2,4}|\\\\s+din\\\\s+[^,;.\\\\n]{4,30})?',\r\n      'giu',\r\n    )],\r\n    phrases: ['Sentința civilă nr.', 'Decizia penală nr.', 'Încheierea de ședință', 'Ordonanța președințială nr.'],\r\n    examples: ['prin Sentința civilă nr. 4521/2023', 'Decizia civilă nr. 100 din 12.03.2024'],\r\n    ai: '',\r\n  },\r\n  {\r\n    id: 'court',\r\n    group: 'V',\r\n    name: 'Court name',\r\n    what: 'Judecătoria / Tribunalul / Curtea de Apel + a capitalised name, and ÎCCJ in full or as sigla. A bare “Curtea de Apel” with no name is left alone.',\r\n    via: 'shape',\r\n    res: [new RegExp(\r\n      '(?:Judec[ăa]tori(?:a|ei)|Tribunalul(?:ui)?(?:\\\\s+(?:Specializat|Militar|pentru\\\\s+[Mm]inori\\\\s+[șş]i\\\\s+[Ff]amilie))?|Cur(?:tea|[țţ]ii)\\\\s+(?:Militar[ăa]\\\\s+|Militare\\\\s+)?de\\\\s+Apel)'\r\n      + '\\\\s+(?:[A-ZĂÂÎȘŞȚŢ][\\\\p{L}-]*|\\\\d+)(?:[\\\\s-]+(?:[A-ZĂÂÎȘŞȚŢ][\\\\p{L}-]*|\\\\d+)){0,3}'\r\n      + '|[ÎI]nalt(?:a|ei)\\\\s+Cur(?:te|[țţ]i)\\\\s+de\\\\s+Casa[țţ]ie\\\\s+[șş]i\\\\s+Justi[țţ]ie'\r\n      + '|[ÎI]\\\\.?C\\\\.?C\\\\.?J\\\\.?(?!\\\\p{L})',\r\n      'gu',\r\n    )],\r\n    phrases: ['Judecătoria Sectorului 4', 'Tribunalul București', 'Curtea de Apel Cluj', 'Înalta Curte de Casație și Justiție / ÎCCJ'],\r\n    examples: ['pe rolul Judecătoriei Sectorului 4 București', 'Tribunalul pentru Minori și Familie Brașov', 'decizia ÎCCJ'],\r\n    ai: 'The Court files tab’s own list (lib/courts.json) is the closed nomenclature; this regex only marks the words.',\r\n  },\r\n  {\r\n    id: 'ccr',\r\n    group: 'V',\r\n    name: 'Constitutional Court decision',\r\n    what: 'Decizia Curții Constituționale / CCR nr. X/an or “din <date>”.',\r\n    via: 'shape',\r\n    res: [new RegExp('decizi(?:a|ei)\\\\s+(?:cur[țţ]ii\\\\s+constitu[țţ]ionale(?:\\\\s+a\\\\s+rom[âî]niei)?|C\\\\.?C\\\\.?R\\\\.?)\\\\s*,?\\\\s*nr\\\\.?\\\\s*\\\\d+(?:\\\\s*\\\\/\\\\s*\\\\d{4}|\\\\s+din\\\\s+[^,;.\\\\n]{4,40})?', 'giu')],\r\n    phrases: ['Decizia Curții Constituționale nr. X din …', 'Decizia CCR nr. X/An'],\r\n    examples: ['Decizia CCR nr. 458/2020', 'Decizia Curții Constituționale nr. 405 din 15 iunie 2016'],\r\n    ai: '',\r\n  },\r\n  {\r\n    id: 'ril',\r\n    group: 'V',\r\n    name: 'RIL — appeal in the interest of the law',\r\n    what: 'Decizia RIL nr. X/an, or Decizia nr. X/an + the “pronunțată în recursul în interesul legii” phrase — without either it is a plain act citation.',\r\n    via: 'keyword',\r\n    res: [new RegExp('decizi(?:a|ei)\\\\s+(?:RIL\\\\s+nr\\\\.?\\\\s*\\\\d+\\\\s*\\\\/\\\\s*\\\\d{4}|nr\\\\.?\\\\s*\\\\d+\\\\s*\\\\/\\\\s*\\\\d{4}\\\\s*,?\\\\s*pronun[țţ]at[ăa]\\\\s+[îâ]n\\\\s+recurs(?:ul)?\\\\s+[îâ]n\\\\s+interesul\\\\s+legii)', 'giu')],\r\n    phrases: ['Decizia RIL nr. X/An', 'Decizia nr. X/An pronunțată în recursul în interesul legii'],\r\n    examples: ['Decizia RIL nr. 19/2019', 'Decizia nr. 3/2020 pronunțată în recursul în interesul legii'],\r\n    ai: '',\r\n  },\r\n  {\r\n    id: 'hp',\r\n    group: 'V',\r\n    name: 'HP — preliminary ruling on questions of law',\r\n    what: 'Decizia HP nr. X/an, or Decizia nr. X/an + “pentru dezlegarea unor chestiuni de drept”.',\r\n    via: 'keyword',\r\n    res: [new RegExp('decizi(?:a|ei)\\\\s+(?:HP\\\\s+nr\\\\.?\\\\s*\\\\d+\\\\s*\\\\/\\\\s*\\\\d{4}|nr\\\\.?\\\\s*\\\\d+\\\\s*\\\\/\\\\s*\\\\d{4}\\\\s*,?\\\\s*(?:pentru|privind)\\\\s+dezlegarea\\\\s+unor\\\\s+chestiuni\\\\s+de\\\\s+drept)', 'giu')],\r\n    phrases: ['Decizia HP nr. X/An', 'Decizia nr. X/An pentru dezlegarea unor chestiuni de drept'],\r\n    examples: ['Decizia HP nr. 52/2018', 'Decizia nr. 9/2016 pentru dezlegarea unor chestiuni de drept'],\r\n    ai: '',\r\n  },\r\n\r\n  // ── VI. Land registry ─────────────────────────────────────────────────\r\n  {\r\n    id: 'cf',\r\n    group: 'VI',\r\n    name: 'Carte Funciară — land book',\r\n    what: 'The land-book number, written out or as CF / C.F. The sigla is capitals-only: lowercase “cf.” is “confer”.',\r\n    via: 'keyword',\r\n    res: [new RegExp('(?:[Cc]arte(?:a|ii)?\\\\s+[Ff]unciar[ăa]|C\\\\.?\\\\s?F\\\\.?)\\\\s+(?:nr\\\\.?\\\\s*)?\\\\d+', 'gu')],\r\n    phrases: ['Carte Funciară nr.', 'CF nr.', 'C.F. nr.'],\r\n    examples: ['imobil înscris în Cartea Funciară nr. 54321 Cluj-Napoca', 'CF nr. 12345'],\r\n    ai: '',\r\n  },\r\n  {\r\n    id: 'cadastral',\r\n    group: 'VI',\r\n    name: 'Cadastral number',\r\n    what: '“nr. cadastral X” / “nr. cad. X”.',\r\n    via: 'keyword',\r\n    res: [new RegExp('(?:nr|num[ăa]r(?:ul)?)\\\\.?\\\\s*(?:cadastral|cad\\\\.?)\\\\s*:?\\\\s*\\\\d+', 'giu')],\r\n    phrases: ['nr. cadastral', 'nr. cad.'],\r\n    examples: ['identificat cu nr. cadastral 123', 'nr. cad. 4567'],\r\n    ai: '',\r\n  },\r\n  {\r\n    id: 'topo',\r\n    group: 'VI',\r\n    name: 'Topographic number',\r\n    what: '“nr. topografic X” / “nr. top. X” — the older Transylvanian land-book numbering.',\r\n    via: 'keyword',\r\n    res: [new RegExp('(?:nr|num[ăa]r(?:ul)?)\\\\.?\\\\s*top(?:ografic)?\\\\.?\\\\s*:?\\\\s*\\\\d+', 'giu')],\r\n    phrases: ['nr. topografic', 'nr. top.'],\r\n    examples: ['nr. top. 1024/2'],\r\n    ai: '',\r\n  },\r\n  {\r\n    id: 'tarla',\r\n    group: 'VI',\r\n    name: 'Tarla / parcelă',\r\n    what: '“Tarlaua X, Parcela Y” written out, or the bare “T X, P Y” pair — the pair, because a bare T or P is a letter.',\r\n    via: 'shape',\r\n    res: [new RegExp('Tarla(?:ua)?\\\\s+[0-9A-Z\\\\/]+(?:\\\\s*,?\\\\s*[Pp]arcel(?:a|ele)?\\\\s+[0-9A-Z\\\\/]+)?|\\\\bT\\\\s?\\\\d+\\\\s*,?\\\\s*P\\\\s?\\\\d+(?!\\\\d)', 'gu')],\r\n    phrases: ['Tarla X', 'Parcela Y', 'T X, P Y'],\r\n    examples: ['teren situat în Tarlaua 24, Parcela 102/3', 'amplasat în T 24, P 102'],\r\n    ai: '',\r\n  },\r\n\r\n  // ── VII. Natural persons ──────────────────────────────────────────────\r\n  {\r\n    id: 'cnp',\r\n    group: 'VII',\r\n    name: 'CNP — personal numeric code',\r\n    what: '13 digits: sex/century digit 1–8, then a REAL date (month 01–12, day 01–31) — the date check is what keeps random 13-digit numbers out.',\r\n    via: 'shape',\r\n    res: [new RegExp('(?:C\\\\.?N\\\\.?P\\\\.?\\\\s*:?\\\\s*)?\\\\b[1-8]\\\\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\\\\d|3[01])\\\\d{6}\\\\b', 'gu')],\r\n    phrases: ['CNP'],\r\n    examples: ['CNP 1850101123456', 'domiciliat în …, 2921231123456'],\r\n    ai: IDENTITY_AI + ' Record key: nationalId.',\r\n  },\r\n  {\r\n    id: 'idcard',\r\n    group: 'VII',\r\n    name: 'Identity documents — C.I. / B.I. / passport',\r\n    what: 'C.I. seria XX nr. NNNNNN (series 1–2 letters, number 6 digits), the old B.I., and “Pașaport nr.”.',\r\n    via: 'keyword',\r\n    res: [new RegExp(\r\n      '(?:C\\\\.?I\\\\.?|B\\\\.?I\\\\.?|[Cc]arte(?:a)?\\\\s+de\\\\s+identitate|[Bb]uletin(?:ul)?(?:\\\\s+de\\\\s+identitate)?)\\\\s+seri[ae]\\\\s+[A-Z]{1,2}\\\\s*,?\\\\s*nr\\\\.?\\\\s*\\\\d{6}\\\\b'\r\n      + '|[Pp]a[șş]aport(?:ul)?\\\\s+nr\\\\.?\\\\s*\\\\d{6,9}\\\\b',\r\n      'gu',\r\n    )],\r\n    phrases: ['C.I. seria XX nr. NNNNNN', 'B.I. seria', 'Pașaport nr.'],\r\n    examples: ['identificat cu C.I. seria RX nr. 456789', 'pașaport nr. 05512345'],\r\n    ai: IDENTITY_AI + ' Record keys: idType, idSeries, idNumber.',\r\n  },\r\n\r\n  // ── VIII. Enforcement and notarial acts ───────────────────────────────\r\n  {\r\n    id: 'exec',\r\n    group: 'VIII',\r\n    name: 'Enforcement file',\r\n    what: '“Dosar de executare (silită) nr. X/an”, with the executing BEJ taken when named.',\r\n    via: 'keyword',\r\n    res: [new RegExp('dosar(?:ul|ului)?\\\\s+(?:de\\\\s+)?executare(?:\\\\s+silit[ăa])?\\\\s+nr\\\\.?\\\\s*\\\\d+(?:\\\\s*\\\\/\\\\s*(?:19|20)?\\\\d{2,4})?(?:\\\\s+al\\\\s+(?:B\\\\.?E\\\\.?J\\\\.?|S\\\\.?C\\\\.?P\\\\.?E\\\\.?J\\\\.?)[^,;.\\\\n]{0,40})?', 'giu')],\r\n    phrases: ['Dosar de executare silită nr. X/An'],\r\n    examples: ['în dosarul de executare silită nr. 210/2024 al B.E.J. Ionescu'],\r\n    ai: '',\r\n  },\r\n  {\r\n    id: 'notarial',\r\n    group: 'VIII',\r\n    name: 'Notarial acts',\r\n    what: '“Încheiere de autentificare nr.” and “Certificat de moștenitor nr.”.',\r\n    via: 'keyword',\r\n    res: [new RegExp(\r\n      '[îâ]ncheier(?:ea|ii|e)\\\\s+de\\\\s+autentificare\\\\s+nr\\\\.?\\\\s*\\\\d+(?:\\\\s*\\\\/\\\\s*[\\\\d.]+)?(?:\\\\s+din\\\\s+[^,;.\\\\n]{4,30})?'\r\n      + '|certificat(?:ul)?\\\\s+de\\\\s+mo[șş]tenitor\\\\s+nr\\\\.?\\\\s*\\\\d+(?:\\\\s*\\\\/\\\\s*\\\\d{4}|\\\\s+din\\\\s+[^,;.\\\\n]{4,30})?',\r\n      'giu',\r\n    )],\r\n    phrases: ['Încheiere de autentificare nr.', 'Certificat de moștenitor nr.'],\r\n    examples: ['autentificat prin Încheierea de autentificare nr. 1502 din 12 mai 2025', 'certificat de moștenitor nr. 44/2023'],\r\n    ai: '',\r\n  },\r\n\r\n  // ── IX. EU and international ──────────────────────────────────────────\r\n  {\r\n    id: 'cjue',\r\n    group: 'IX',\r\n    name: 'CJEU case',\r\n    what: '“Cauza C-131/12”, optionally with the party name; “Hotărârea CJUE în cauza …”. (EU regulations and directives are already acts.)',\r\n    via: 'shape',\r\n    res: [new RegExp('[Cc]auz(?:a|ei)\\\\s+C[-‑–]\\\\s?\\\\d+\\\\/\\\\d{2}(?:\\\\s+[A-Z][\\\\p{L}-]+)?|Hot[ăa]r[âî]r(?:ea|ii)\\\\s+CJUE(?:\\\\s+[îâ]n\\\\s+cauza\\\\s+[^,;.\\\\n]{3,60})?', 'gu')],\r\n    phrases: ['Cauza C-131/12', 'Hotărârea CJUE în cauza'],\r\n    examples: ['principiul stabilit în Cauza C-131/12 Google Spain'],\r\n    ai: '',\r\n  },\r\n  {\r\n    id: 'gdpr',\r\n    group: 'IX',\r\n    name: 'GDPR',\r\n    what: 'The sigla, or the regulation by its Romanian description. The numbered form — Regulamentul (UE) 2016/679 — is already an act.',\r\n    via: 'shape',\r\n    res: [new RegExp('\\\\bGDPR\\\\b|[Rr]egulamentul\\\\s+general\\\\s+privind\\\\s+protec[țţ]ia\\\\s+datelor', 'gu')],\r\n    phrases: ['GDPR', 'Regulamentul general privind protecția datelor'],\r\n    examples: ['cu respectarea GDPR'],\r\n    ai: '',\r\n  },\r\n  {\r\n    id: 'cedo',\r\n    group: 'IX',\r\n    name: 'ECHR case law',\r\n    what: '“Hotărârea CEDO în cauza …”, the “X contra României” case-name shape, and “art. N din Convenție”.',\r\n    via: 'shape',\r\n    res: [new RegExp(\r\n      'Hot[ăa]r[âî]r(?:ea|ii)\\\\s+(?:CEDO|Cur[țţ]ii\\\\s+Europene\\\\s+a\\\\s+Drepturilor\\\\s+Omului)(?:\\\\s+[îâ]n\\\\s+cauza\\\\s+[^,;.\\\\n]{3,60})?'\r\n      + '|[A-Z][\\\\p{L}-]+(?:\\\\s+[șş]i\\\\s+al[țţ]ii)?\\\\s+(?:contra|[îâ]mpotriva|c\\\\.)\\\\s+Rom[âî]niei\\\\b'\r\n      + '|art\\\\.?\\\\s*\\\\d+\\\\s+din\\\\s+Conven[țţ]i(?:e|a)(?!\\\\p{L})',\r\n      'gu',\r\n    )],\r\n    phrases: ['Hotărârea CEDO în cauza X contra României', 'art. 6 din Convenție'],\r\n    examples: ['Hotărârea CEDO în cauza Popescu contra României', 'garanțiile art. 6 din Convenție'],\r\n    ai: '',\r\n  },\r\n\r\n  // ── X. Connectors ─────────────────────────────────────────────────────\r\n  {\r\n    id: 'connector',\r\n    group: 'X',\r\n    name: 'Legal connectors',\r\n    what: 'Not identifiers — the phrases that announce one: a legal basis (“în temeiul”, “potrivit dispozițiilor”), a correlation (“coroborat cu”), an interpretive stance (“per a contrario”). Found by regex here, but their JOB is context: they tell the AI a citation follows.',\r\n    via: 'context',\r\n    res: [new RegExp(\r\n      '(?:[îâ]n\\\\s+temeiul|[îâ]n\\\\s+drept\\\\b|potrivit\\\\s+dispozi[țţ]iilor|prin\\\\s+raportare\\\\s+la'\r\n      + '|av[âî]nd\\\\s+[îâ]n\\\\s+vedere\\\\s+(?:prevederile|dispozi[țţ]iile)|coroborat\\\\p{L}*\\\\s+cu|prin\\\\s+coroborare\\\\s+cu'\r\n      + '|[îâ]n\\\\s+conexiune\\\\s+cu|[îâ]n\\\\s+subsidiar|[îâ]n\\\\s+principal\\\\b|per\\\\s+a\\\\s+contrario|ad\\\\s+litteram)',\r\n      'giu',\r\n    )],\r\n    phrases: ['în temeiul', 'în drept', 'potrivit dispozițiilor', 'prin raportare la', 'având în vedere prevederile', 'coroborat cu', 'în subsidiar', 'per a contrario', 'ad litteram'],\r\n    examples: ['În temeiul art. 194 CPC, coroborat cu art. 148…', 'în subsidiar, per a contrario'],\r\n    ai: 'These are the cues the AI reads a legal argument by — where one appears, an entity from this catalogue is imminent.',\r\n  },\r\n\r\n  // ── XI. Fiscal bodies ─────────────────────────────────────────────────\r\n  {\r\n    id: 'fiscal-body',\r\n    group: 'XI',\r\n    name: 'Fiscal bodies — ANAF and its directorates',\r\n    what: 'The issuers in the letterhead of a contested administrative act: ANAF, D.G.R.F.P., A.J.F.P., D.G.A.M.C., D.G.A.F. — siglas in capitals, names written out.',\r\n    via: 'shape',\r\n    res: [new RegExp(\r\n      '\\\\bANAF\\\\b|Agen[țţ]i(?:a|ei)\\\\s+Na[țţ]ional[ăae]\\\\s+de\\\\s+Administrare\\\\s+Fiscal[ăa]'\r\n      + '|D\\\\.?G\\\\.?R\\\\.?F\\\\.?P\\\\.?(?!\\\\p{L})|Direc[țţ]i(?:a|ei)\\\\s+Generale?\\\\s+Regional[ăae]\\\\s+a\\\\s+Finan[țţ]elor\\\\s+Publice'\r\n      + '|A\\\\.?J\\\\.?F\\\\.?P\\\\.?(?!\\\\p{L})|Administra[țţ]i(?:a|ei)\\\\s+Jude[țţ]en[ăae]\\\\s+a\\\\s+Finan[țţ]elor\\\\s+Publice'\r\n      + '|D\\\\.?G\\\\.?A\\\\.?M\\\\.?C\\\\.?(?!\\\\p{L})|Direc[țţ]i(?:a|ei)\\\\s+Generale?\\\\s+de\\\\s+Administrare\\\\s+a\\\\s+Marilor\\\\s+Contribuabili'\r\n      + '|D\\\\.?G\\\\.?A\\\\.?F\\\\.?(?!\\\\p{L})|Direc[țţ]i(?:a|ei)\\\\s+Generale?\\\\s+Antifraud[ăa]\\\\s+Fiscal[ăa]',\r\n      'gu',\r\n    )],\r\n    phrases: ['ANAF', 'D.G.R.F.P.', 'A.J.F.P.', 'D.G.A.M.C.', 'D.G.A.F.'],\r\n    examples: ['decizia de impunere emisă de A.J.F.P. Cluj', 'inspecția fiscală ANAF — D.G.A.F.'],\r\n    ai: '',\r\n  },\r\n];\r\n\r\n/** The display name of a hit's kind, from the catalogue. */\r\nconst KIND_NAME = new Map(REF_CATALOGUE.map((e) => [e.id, e.name]));\r\nexport const refKindName = (kind) => KIND_NAME.get(kind) || kind || '';\r\n\r\n/**\r\n * Run a set of the catalogue's patterns over `text` — the shared scan the\r\n * Debug tab's per-entry previews use too. Enforces the letter boundary JS's\r\n * ASCII-only `\\b` cannot (a match may not start or end mid-word), trims\r\n * trailing space/commas but KEEPS a trailing dot (it belongs to \"S.R.L.\").\r\n */\r\nexport function scanRefPatterns(text, res, kind = '') {\r\n  const s = String(text || '');\r\n  if (!s) return [];\r\n  const letter = (c) => !!c && /\\p{L}/u.test(c);\r\n  const hits = [];\r\n  for (const re of res || []) {\r\n    re.lastIndex = 0;\r\n    for (let m = re.exec(s); m; m = re.exec(s)) {\r\n      if (!m[0]) { re.lastIndex += 1; continue; }\r\n      const a = m.index; let b = a + m[0].length;\r\n      if ((a > 0 && letter(s[a - 1]) && letter(s[a]))\r\n        || (b < s.length && letter(s[b]) && letter(s[b - 1]))) continue;\r\n      while (b > a && /[\\s,;:]/.test(s[b - 1])) b -= 1;\r\n      if (b > a) hits.push({ start: a, end: b, raw: s.slice(a, b), kind });\r\n    }\r\n  }\r\n  return dropOverlaps(hits);\r\n}\r\n\r\n/**\r\n * Every identifier from the wider catalogue — everything `findLawRefs` /\r\n * `findCaseRefs` do NOT already find. `{ start, end, raw, kind }`, the kind\r\n * being the catalogue entry's id; in document order, never overlapping.\r\n */\r\nexport function findEntityRefs(text) {\r\n  const s = String(text || '');\r\n  if (s.length < 3) return [];\r\n  const hits = [];\r\n  for (const e of REF_CATALOGUE) {\r\n    if (e.live) continue;\r\n    hits.push(...scanRefPatterns(s, e.res, e.id));\r\n  }\r\n  return dropOverlaps(hits);\r\n}\r\n\r\n/**\r\n * The whole picture in one pass: acts, elements, codes, CAEN, court files AND\r\n * the wider catalogue, overlaps resolved (the law detectors win at equal\r\n * length — they are pushed first). What the Debug tab's tester runs.\r\n */\r\nexport function findAllLegalRefs(text) {\r\n  return dropOverlaps([...findLawRefs(text), ...findCaseRefs(text), ...findEntityRefs(text)]);\r\n}\r\n\n/**\n * The CORE detectors' patterns, named — what `findLawRefs` / `findCaseRefs` /\n * `findCuiRefs` / the CAEN readers run. Read by the Debug tab's legislation\n * archive (pages/Debug `LegalDetectionArchive`), which shows them live beside\n * the frozen copy kept in lib/legalDetectionArchive. The wider catalogue's\n * own patterns are on each `REF_CATALOGUE` entry (`res`).\n */\nexport const LAW_REF_REGEXES = [\n  { name: 'ACT_RE', what: 'A normative act: category, number/year (either order, EU suffix), title from \"privind…\", republication / amendment notes.', re: ACT_RE },\n  { name: 'STRUCT_RE', what: 'A structural pointer: art. / alin. / lit. / pct. / teza with values, joined runs, bis/ter/quater, ^indices, roman numerals.', re: STRUCT_RE },\n  { name: 'FROM_ACT_RE', what: 'What joins a pointer to its act (\"din\", \"al\", \"ale\"…).', re: FROM_ACT_RE },\n  { name: 'CODE_RE', what: 'A code by name (Codul civil, de procedură…), the dotted abbreviations (C.civ., C.proc.pen.), the Constitution.', re: CODE_RE },\n  { name: 'CODE_SIGLA_RE', what: 'Code siglas CPC / CPP / NCPC / NCPP — case-sensitive on purpose.', re: CODE_SIGLA_RE },\n  { name: 'CAEN_RE', what: 'CAEN codes with the keyword required: cod CAEN 6201, clasa CAEN, CAEN Rev. 2 – 6201, lists.', re: CAEN_RE },\n  { name: 'CAEN_LINE_RE', what: 'A trade-register extract’s one-per-line list: \"6210 - Activități…\" (only in a text that mentions CAEN).', re: CAEN_LINE_RE },\n  { name: 'CAEN_WORD_RE', what: 'Does the text mention CAEN at all (the context for CAEN_LINE_RE).', re: CAEN_WORD_RE },\n  { name: 'CAEN_REV_RE', what: 'The revision a document names: \"CAEN Rev. 2\", \"Rev. Caen (3)\".', re: CAEN_REV_RE },\n  { name: 'BACKREF_RE', what: 'Pointing back at an act already cited: \"legea menționată mai sus\", \"actul normativ citat\".', re: BACKREF_RE },\n  { name: 'CASE_RE', what: 'A court file number with the word required: \"Dosarul nr. 1.234/1/2023\".', re: CASE_RE },\n  { name: 'CUI_RE', what: 'A fiscal code (CUI / CIF) after its keyword; the check digit is verified separately (weights 7 5 3 2 1 7 5 3 2).', re: CUI_RE },\n  { name: 'EU_MARK_RE', what: 'An EU act’s body mark: (UE), (CE), /Euratom…', re: EU_MARK_RE },\n  { name: 'TITLE_OPEN_RE', what: 'Where a title opens: privind / pentru / referitor la / asupra / cu privire la.', re: TITLE_OPEN_RE },\n  { name: 'TITLE_STOP_RE', what: 'Where a title ends: the first word that starts saying something ABOUT the act (se, este, prevede…).', re: TITLE_STOP_RE },\n  { name: 'NOTE_ONE_RE', what: 'One republication / amendment note, read back apart.', re: NOTE_ONE_RE },\n  { name: 'CAT_HEAD_RE', what: 'A citation that opens with an act category.', re: CAT_HEAD_RE },\n];\n"
  },
  {
   "file": "src/lib/legalOmni.js",
   "text": "// THE LEGISLATION TAB'S ONE SEARCH — what a line typed into it IS, and which\r\n// platform answers it. The tab used to be a row of platforms, each with its own\r\n// form (Kind / Number / Year, a court and a period, a CUI box); it is one\r\n// search bar now, like a browser's address bar: whatever is typed is read, and\r\n// the platform that can answer it is opened with the query in its route.\r\n//\r\n//   \"Legea 31/1990\", \"OUG nr. 195/2002\", \"HG 1383 2022\"  → legislatie.just.ro, the act opened\r\n//   \"31/1990\"                                             → legislatie.just.ro, by number and year\r\n//   \"1234/3/2026\", \"dosar 1234/3/2026\"                    → portal.just.ro, the file\r\n//   \"dosare Popescu Ion\", \"parte SC Exemplu SRL\"          → portal.just.ro, by party\r\n//   \"RO14399840\", \"14399840\", \"cui 6859662\", a list       → anaf.ro\r\n//   \"6210\", \"caen 6210\", \"caen software\"                  → insse.ro (CAEN)\r\n//   anything else — words                                 → legislatie.just.ro, by title and text\r\n//\r\n// A prefix naming the platform (\"anaf …\", \"caen …\", \"dosar …\", \"lege …\")\r\n// always wins. `detectQuery(text)` → { source, label, what, to } | null, `to`\r\n// being the route (with a nonce, so the same search can be run twice).\r\n\r\nimport { findLawRefs, lawRefDetails, findCuiRefs } from './lawRefs';\r\nimport { legislationQueryFor, portalTypeFor } from './legislation';\r\n\r\nexport const OMNI_SOURCES = {\r\n  legislation: { to: '/legislation', site: 'legislatie.just.ro' },\r\n  caen: { to: '/caen', site: 'insse.ro' },\r\n  'portal-just': { to: '/portal-just', site: 'portal.just.ro' },\r\n  anaf: { to: '/anaf', site: 'anaf.ro' },\r\n};\r\n\r\nconst fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();\r\n\r\n// A CUI's check digit: the other digits (padded to nine) times 7 5 3 2 1 7 5 3 2,\r\n// times ten, mod 11 (10 → 0).\r\nconst CUI_KEY = [7, 5, 3, 2, 1, 7, 5, 3, 2];\r\nexport function validCui(raw) {\r\n  const s = String(raw || '').replace(/^ro/i, '').trim();\r\n  if (!/^\\d{2,10}$/.test(s)) return false;\r\n  const body = s.slice(0, -1).padStart(9, '0').split('').map(Number);\r\n  const sum = body.reduce((n, d, i) => n + d * CUI_KEY[i], 0);\r\n  const c = (sum * 10) % 11;\r\n  return (c === 10 ? 0 : c) === Number(s.slice(-1));\r\n}\r\n\r\nconst route = (source, params) => {\r\n  const p = new URLSearchParams(params);\r\n  p.set('_', String(Date.now()));\r\n  return `${OMNI_SOURCES[source].to}?${p.toString()}`;\r\n};\r\nconst hit = (source, what, label, params) => ({ source, what, label, site: OMNI_SOURCES[source].site, params, get to() { return route(source, params); } });\r\n\r\nconst KIND_WORD = '(lege[a]?|l|o\\\\.?\\\\s?u\\\\.?\\\\s?g\\\\.?|o\\\\.?\\\\s?g\\\\.?|h\\\\.?\\\\s?g\\\\.?|ordonan[țţt][aă](?:\\\\s+de\\\\s+urgen[țţt][aă])?(?:\\\\s+a\\\\s+guvernului)?|hot[aă]r[aâ]re(?:a)?(?:\\\\s+(?:a\\\\s+)?guvernului)?|ordin(?:ul)?|decret(?:ul)?|decizi[ae]|regulament(?:ul)?|norm[aăe]|instruc[țţt]iuni(?:le)?)';\r\nconst ACT_RE = new RegExp(`^${KIND_WORD}\\\\.?\\\\s*(?:nr\\\\.?\\\\s*)?(\\\\d{1,5})\\\\s*(?:\\\\/|\\\\s+din\\\\s+|\\\\s+)\\\\s*((?:19|20)\\\\d{2}|\\\\d{2})\\\\b\\\\.?$`, 'iu');\r\nconst KIND_OF = (w) => {\r\n  const f = fold(w).replace(/\\s+/g, ' ').trim();\r\n  if (f === 'l') return 'LEGE';\r\n  return portalTypeFor(f);\r\n};\r\nconst fullYear = (y) => (y.length === 2 ? (Number(y) > 40 ? `19${y}` : `20${y}`) : y);\r\nconst KIND_LABEL = {\r\n  LEGE: 'Legea', 'ORDONANȚĂ DE URGENȚĂ': 'OUG', 'ORDONANȚĂ': 'OG', 'HOTĂRÂRE': 'HG', ORDIN: 'Ordinul',\r\n  DECIZIE: 'Decizia', DECRET: 'Decretul', REGULAMENT: 'Regulamentul', 'NORMĂ': 'Norma', 'INSTRUCȚIUNI': 'Instrucțiunile',\r\n};\r\n\r\n/** What a line typed into the Legislation tab's search is, or null (empty). */\r\nexport function detectQuery(raw) {\r\n  const text = String(raw || '').replace(/\\s+/g, ' ').trim();\r\n  if (!text) return null;\r\n  const f = fold(text);\r\n\r\n  // ── A prefix naming the platform wins ──\r\n  let m = /^(?:anaf|cui|cif)\\s*[:\\-]?\\s*(.+)$/i.exec(text);\r\n  if (m) {\r\n    const cuis = m[1].split(/[\\s,;]+/).map((s) => s.replace(/^ro/i, '')).filter((s) => /^\\d{2,10}$/.test(s));\r\n    if (cuis.length) return hit('anaf', 'company', cuis.length === 1 ? `CUI ${cuis[0]}` : `${cuis.length} CUIs`, { cui: cuis.join(' ') });\r\n  }\r\n  m = /^caen\\s*(?:rev\\.?\\s*([123]))?\\s*[:\\-]?\\s*(.*)$/i.exec(text);\r\n  if (m) {\r\n    const rest = m[2].trim();\r\n    const rev = m[1] || '';\r\n    if (/^\\d{2,4}$/.test(rest)) return hit('caen', 'code', `CAEN ${rest}${rev ? ` · Rev. ${rev}` : ''}`, { code: rest, open: '1', ...(rev && rev !== '3' ? { rev } : {}) });\r\n    if (rest) return hit('caen', 'words', `CAEN “${rest}”`, { q: rest });\r\n    return hit('caen', 'browse', 'The CAEN nomenclature', {});\r\n  }\r\n  m = /^(?:dosar(?:ul|e|ele)?|portal|instan[țţt][aăe])\\s*(?:nr\\.?)?\\s*[:\\-]?\\s*(.+)$/i.exec(text);\r\n  if (m) {\r\n    const rest = m[1].trim();\r\n    const nr = /^\\d{1,7}\\/\\d{1,4}(?:\\/\\d{1,4})?\\/(?:19|20)\\d{2}(?:\\/[a-z0-9.*]+)?$/i.exec(rest);\r\n    if (nr) return hit('portal-just', 'file', `Dosar ${rest}`, { nr: rest });\r\n    return hit('portal-just', 'party', `Files naming “${rest}”`, { parte: rest });\r\n  }\r\n  m = /^(?:parte|partea|p[aâ]r[țţt]i)\\s*[:\\-]?\\s*(.+)$/i.exec(text);\r\n  if (m) return hit('portal-just', 'party', `Files naming “${m[1].trim()}”`, { parte: m[1].trim() });\r\n\r\n  // A fiscal code NAMED as one anywhere in the line — \"Cod unic de\r\n  // înregistrare : 54912561\", \"cod fiscal RO54912561\" (every one, for a\r\n  // list) — is a company, before anything else reads the words.\r\n  const cuiHits = findCuiRefs(text);\r\n  if (cuiHits.length) {\r\n    const cuis = [...new Set(cuiHits.map((h) => h.cui))];\r\n    return hit('anaf', 'company', cuis.length === 1 ? `CUI ${cuis[0]}` : `${cuis.length} CUIs`, { cui: cuis.join(' ') });\r\n  }\r\n\r\n  // ── By shape ──\r\n  // A court file number: three or four parts, the year third (\"1234/3/2026\",\r\n  // \"1234/299/2021/a1\"). An act's is two (\"31/1990\").\r\n  if (/^(?:nr\\.?\\s*)?\\d{1,7}\\/\\d{1,4}(?:\\/\\d{1,4})?\\/(?:19|20)\\d{2}(?:\\/[a-z0-9.*]+)?$/i.test(text)) {\r\n    const nr = text.replace(/^nr\\.?\\s*/i, '');\r\n    return hit('portal-just', 'file', `Dosar ${nr}`, { nr });\r\n  }\r\n  // A CUI (or a list of them): RO + digits, or five-plus digits with a valid\r\n  // check digit. Four digits or fewer are a CAEN code — a CUI is never that short.\r\n  const parts = text.split(/[\\s,;]+/);\r\n  if (parts.every((p) => /^(?:ro)?\\d{5,10}$/i.test(p)) && parts.every((p) => /^ro/i.test(p) || validCui(p))) {\r\n    const cuis = parts.map((p) => p.replace(/^ro/i, ''));\r\n    return hit('anaf', 'company', cuis.length === 1 ? `CUI ${cuis[0]}` : `${cuis.length} CUIs`, { cui: cuis.join(' ') });\r\n  }\r\n  if (/^\\d{2,4}$/.test(text) && !/^(19|20)\\d{2}$/.test(text)) return hit('caen', 'code', `CAEN ${text}`, { code: text, open: '1' });\r\n  // A section letter and a class (\"J 6210\") is CAEN too.\r\n  m = /^([a-v])\\s?(\\d{2,4})$/i.exec(text);\r\n  if (m) return hit('caen', 'code', `CAEN ${m[2]}`, { code: m[2], open: '1' });\r\n\r\n  // An act: \"Legea 31/1990\", \"OUG nr. 195/2002\", \"HG 1383 2022\", \"Ordinul 228 din 2012\".\r\n  m = ACT_RE.exec(text);\r\n  if (m) {\r\n    const tip = KIND_OF(m[1]);\r\n    const an = fullYear(m[3]);\r\n    if (tip) return hit('legislation', 'act', `${KIND_LABEL[tip] || tip} nr. ${m[2]}/${an}`, { tip, nr: m[2], an, open: '1' });\r\n  }\r\n  // A citation the detector knows (\"art. 5 din Legea nr. 24/2000 privind …\",\r\n  // \"Codul civil\").\r\n  const refs = findLawRefs(text).filter((h) => h.kind === 'act' || h.kind === 'code');\r\n  if (refs.length) {\r\n    const q = legislationQueryFor(lawRefDetails(refs[0]));\r\n    if (q?.tip && q.numar && q.an) return hit('legislation', 'act', `${KIND_LABEL[q.tip] || q.tip} nr. ${q.numar}/${q.an}`, { tip: q.tip, nr: q.numar, an: q.an, open: '1' });\r\n    if (q?.titlu && refs[0].kind === 'code') return hit('legislation', 'words', `“${q.titlu}”`, { titlu: q.titlu });\r\n  }\r\n  // Just a number and a year: every act of that number that year.\r\n  if (/^(?:19|20)\\d{2}$/.test(text)) return hit('legislation', 'year', `Acts of ${text}`, { an: text });\r\n  m = /^(?:nr\\.?\\s*)?(\\d{1,5})\\s*\\/\\s*((?:19|20)\\d{2})$/.exec(text);\r\n  if (m) return hit('legislation', 'number', `Acts nr. ${m[1]}/${m[2]}`, { nr: m[1], an: m[2] });\r\n  // Only a kind named (\"lege …words\") — the words, narrowed to that kind.\r\n  m = new RegExp(`^${KIND_WORD}\\\\s+(.{3,})$`, 'iu').exec(text);\r\n  if (m && KIND_OF(m[1]) && !/\\d/.test(m[2])) return hit('legislation', 'words', `${KIND_LABEL[KIND_OF(m[1])] || KIND_OF(m[1])} · “${m[2]}”`, { tip: KIND_OF(m[1]), titlu: m[2] });\r\n\r\n  if (f.length < 2) return null;\r\n  return hit('legislation', 'words', `“${text}”`, { titlu: text });\r\n}\r\n\r\n// ── The dice ──────────────────────────────────────────────────────────────\r\n// Something THAT EXISTS, from one of the platforms, written into the search as\r\n// it would be typed — nothing is run (pressing Enter is the user's). Each\r\n// platform's draw is the one its page used to make.\r\nconst pick = (a) => a[Math.floor(Math.random() * a.length)];\r\n\r\nasync function randomAct() {\r\n  const { searchLegislation, LEGIS_TYPES } = await import('./legislation');\r\n  const WORDS = ['privind', 'pentru', 'aprobarea', 'modificarea', 'completarea', 'organizarea', 'unor', 'masuri'];\r\n  const now = new Date().getFullYear();\r\n  for (let tries = 0; tries < 6; tries++) {\r\n    const an = String(1990 + Math.floor(Math.random() * (now - 1990 + 1)));\r\n    const res = await searchLegislation({ tip: '', numar: '', an, titlu: pick(WORDS), text: '', perPage: 30 });\r\n    if (!res?.ok) return null;\r\n    if (!res.records.length) continue;\r\n    const r = pick(res.records);\r\n    const kindOf = String(r.tipAct || '').toUpperCase();\r\n    const tip = LEGIS_TYPES.find((t) => t.id && kindOf.startsWith(t.id))?.id || '';\r\n    if (!tip || !r.numar) continue;\r\n    return `${KIND_LABEL[tip] || tip} ${r.numar}/${r.year || an}`;\r\n  }\r\n  return null;\r\n}\r\n\r\nasync function randomCaen() {\r\n  const { loadCaen } = await import('./caen');\r\n  const data = await loadCaen();\r\n  const classes = Object.keys(data?.items || {}).filter((k) => data.items[k].l === 'c');\r\n  return classes.length ? `caen ${pick(classes)}` : null;\r\n}\r\n\r\nasync function randomCompany() {\r\n  const { lookupCompanies } = await import('./anaf');\r\n  const withCheck = (base) => {\r\n    const digits = String(base).padStart(9, '0').split('').map(Number);\r\n    const c = (digits.reduce((s, d, i) => s + d * CUI_KEY[i], 0) * 10) % 11;\r\n    return `${base}${c === 10 ? 0 : c}`;\r\n  };\r\n  for (let tries = 0; tries < 3; tries++) {\r\n    const cuis = [];\r\n    while (cuis.length < 100) cuis.push(withCheck(100000 + Math.floor(Math.random() * 4400000)));\r\n    const res = await lookupCompanies(cuis.join(' '));\r\n    if (!res?.ok) return null;\r\n    if (res.companies.length) return `RO${pick(res.companies).cui}`;\r\n    await new Promise((r) => setTimeout(r, 1100));\r\n  }\r\n  return null;\r\n}\r\n\r\nasync function randomCase() {\r\n  const { COURTS, listHearings } = await import('./courts');\r\n  const pool = COURTS.filter((c) => c.kind === 'jud' || c.kind === 'trib' || c.kind === 'ca');\r\n  for (let tries = 0; tries < 4; tries++) {\r\n    const court = pick(pool);\r\n    const d = new Date();\r\n    d.setDate(d.getDate() - Math.floor(Math.random() * 45));\r\n    while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1);\r\n    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;\r\n    const res = await listHearings({ institutie: court.id, day });\r\n    if (!res?.ok) return null;\r\n    const numbers = (res.sedinte || []).flatMap((s) => (s.dosare || []).map((x) => x.numar)).filter(Boolean);\r\n    if (numbers.length) return pick(numbers);\r\n  }\r\n  return null;\r\n}\r\n\r\nconst DRAWS = { legislation: randomAct, caen: randomCaen, anaf: randomCompany, 'portal-just': randomCase };\r\n\r\n/** A random query that exists — from `source`, else from any platform. */\r\nexport async function randomQuery(source = null) {\r\n  const order = source && DRAWS[source] ? [source] : Object.keys(DRAWS).sort(() => Math.random() - 0.5);\r\n  for (const s of order) {\r\n    try {\r\n      const q = await DRAWS[s]();\r\n      if (q) return q;\r\n    } catch { /* that platform could not be reached — try the next */ }\r\n  }\r\n  return null;\r\n}\r\n"
  }
 ]
};
