// EVERY PLATFORM THE APP READS, OR WILL — what each is, whether it is
// connected, and HOW it is reached (the kind of access and what it costs).
// Read by Research's "i" (components/SourcesModal) and by the Legislation
// tab's placeholder pages (pages/LegalSourceStub, the planned ones).
// Connecting a planned source = a real page on its route, its `stub` flag
// dropped in components/LegalTabs, and its entry moved to CONNECTED_SOURCES.

// `cost`: 'free' | 'paid' | 'bundled'. `tone`: the platform's own colour
// (lib/legalBrowser PLATFORMS — the dots and pills everywhere).
export const CONNECTED_SOURCES = [
  {
    id: 'legislation', site: 'legislatie.just.ro', name: 'Legislation', tone: 'var(--cat-update)', cost: 'free',
    what: 'Every Romanian normative act — searched, read whole and kept on this machine.',
    how: 'The Ministry of Justice’s official web service (SOAP, anonymous token — no key, no registration), called from the desktop app; acts opened are kept in a local archive, so the tab works offline.',
  },
  {
    id: 'portal-just', site: 'portal.just.ro', name: 'Court files', tone: 'var(--info)', cost: 'free',
    what: 'Court files by number or by a party — parties, hearings, solutions, appeals.',
    how: 'The courts’ official web service (SOAP, free, no key), called from the desktop app; answers kept on this machine for when it is down.',
  },
  {
    id: 'anaf', site: 'anaf.ro', name: 'Companies', tone: 'var(--success)', cost: 'free',
    what: 'A company’s fiscal record by CUI — VAT, inactive or struck off, e-Factura, balance-sheet CAEN.',
    how: 'ANAF’s public REST service (JSON, free, no key; one request a second, up to 100 CUIs per request), called from the desktop app.',
  },
  {
    id: 'caen', site: 'insse.ro', name: 'CAEN codes', tone: 'var(--warning)', cost: 'bundled',
    what: 'The CAEN nomenclature — all three revisions, the explanatory notes and the correspondences.',
    how: 'Bundled with the app from the National Institute of Statistics’ own files — no network call at all; a new revision ships with a release.',
  },
];

// The AI behind Research's answers — reached the same way for every question.
export const AI_SOURCE = {
  id: 'claude', site: 'api.anthropic.com', name: 'Claude (the AI)', tone: 'var(--accent)', cost: 'paid',
  what: 'Answers questions, picks the model (Auto) and writes the summaries — never trained on what is sent.',
  how: 'Anthropic’s commercial API through DocVex’s own server function (project-ai), which holds the key; billed per token, cached input at a tenth.',
};

export const PLANNED_SOURCES = {
  '/firme': {
    eyebrow: 'Company data aggregators',
    site: 'termene.ro - listafirme.ro',
    title: 'Company aggregators',
    blurb: 'Financial data and risk on companies from the private aggregators — turnover, insolvencies, shareholding and hidden links between firms — to sync a client’s figures quickly and see the risk before a contract. Not connected yet.',
    plain: "Company data from the private aggregators is not available yet. When it is, this page will show a client’s financial figures, its insolvencies, its shareholders and the links between firms, so you can see who you are dealing with before signing.",
    access: 'Private paid API (REST) — subscription or credits.',
    uses: [
      { level: 'medium', text: 'Quick sync of clients’ financial data.' },
      { level: 'critical', text: 'Risk scores, insolvencies, shareholding and hidden links.' },
    ],
  },
  '/bpi': {
    eyebrow: 'Insolvency bulletin',
    site: 'bpi.ro',
    title: 'BPI',
    blurb: 'The Insolvency Proceedings Bulletin, where every opening, reorganisation and bankruptcy is published — an alert the moment an existing client can no longer pay, and a party’s insolvency state identified before you act. Not connected yet.',
    plain: "The Insolvency Bulletin is not connected yet. When it is, this page will tell you the moment a client or an opposing party enters insolvency, reorganisation or bankruptcy, and show the state of any company you name.",
    access: 'Official data feed (ONRC B2B protocol) or a private API — paid.',
    uses: [
      { level: 'medium', text: 'An alert when an existing client can no longer pay.' },
      { level: 'critical', text: 'Bankruptcy, reorganisation or insolvency states, identified.' },
    ],
  },
  '/ancpi': {
    eyebrow: 'Cadastre and property',
    site: 'ancpi.ro',
    title: 'ANCPI',
    blurb: 'The cadastre and land register — owners, mortgages and encumbrances on a property checked from the extract, and the land-register extracts themselves kept in the electronic file, paid per extract at the state fee. Not connected yet.',
    plain: "The land register is not connected yet. When it is, this page will pull the extract for a property, show its owners, mortgages and other encumbrances, and keep the extracts in the case file.",
    access: 'WebView automations, or an API through private partners — paid per extract (state fee).',
    uses: [
      { level: 'medium', text: 'Land-register extracts kept in the electronic file.' },
      { level: 'critical', text: 'Owners, mortgages and encumbrances on a property, checked.' },
    ],
  },
  '/rejust': {
    eyebrow: 'Case law (CSM)',
    site: 'rejust.ro',
    title: 'ReJust',
    blurb: 'The courts’ published decisions, from the Superior Council of Magistracy — judicial precedents attached straight to the case notes, and a court’s orientation on a question read before you argue it, to weigh the chances. Not connected yet.',
    plain: "The courts’ published decisions are not connected yet. When they are, this page will find precedents for a question, attach them to the case notes, and show how a given court tends to decide.",
    access: 'Web scraping / RPA (Playwright or Puppeteer, local) — free, needs code maintenance.',
    uses: [
      { level: 'medium', text: 'Judicial precedents attached straight to the case notes.' },
      { level: 'high', text: 'Chances of winning, by the court’s orientation.' },
    ],
  },
  '/unbr': {
    eyebrow: 'Lawyer verification',
    site: 'unbr.ro',
    title: 'UNBR register',
    blurb: 'The national bar’s register of lawyers — the opposing counsel’s details validated for the service of documents, and whether a name on a power of attorney is a lawyer in good standing, before anything is served. Not connected yet.',
    plain: "The bar’s register of lawyers is not connected yet. When it is, this page will confirm that a lawyer is registered and in good standing, and give the details needed to serve documents on them.",
    access: 'Local web scraping (HTTP GET on their search engine) — free.',
    uses: [
      { level: 'high', text: 'The opposing lawyer’s details validated for service of documents.' },
    ],
  },
  '/eurlex': {
    eyebrow: 'European Union law',
    site: 'eur-lex.europa.eu',
    title: 'EUR-Lex',
    blurb: 'The Union’s own legal database — every regulation, directive and decision in Romanian, with the Court of Justice’s case law and each act’s national transposition — so a directive an act transposes, or a regulation a contract turns on, is read here rather than in a browser. Not connected yet.',
    plain: 'European Union law is not connected yet. When it is, this page will open a regulation or directive cited in an act or a document in its Romanian text, show its consolidated versions, the Romanian acts that transpose it and the Court of Justice’s decisions on it.',
    access: 'Official free API (the EUR-Lex web service, SOAP with registration, or the Cellar SPARQL endpoint) — free.',
    uses: [
      { level: 'high', text: 'A regulation or directive cited in an act opened in its Romanian text.' },
      { level: 'medium', text: 'What transposes a directive in Romania, and the case law on it.' },
    ],
  },
};

// A cost as the modal shows it, from the planned sources' access line.
export function costOf(access) {
  const a = String(access || '').toLowerCase();
  if (/paid|plătit|per extract|subscription/.test(a)) return 'paid';
  if (/free|gratuit/.test(a)) return 'free';
  return '';
}
