import React from 'react';
import { useLocation } from 'react-router-dom';
import './LegalSourceStub.css';
import PageMasthead from '../components/PageMasthead';
import LegalTabs from '../components/LegalTabs';
import HistoryButton from '../components/HistoryMenu';

// The Legislation tab's sources that are not connected yet. One page for all
// of them: the masthead names the source, the card says how it would be
// reached and what it is for. Nothing is fetched — these exist so the tab
// shows every source the app is meant to read, not only the three it does.
// Connecting one = a real page on its route + dropping its `stub` flag in
// components/LegalTabs.

const SOURCES = {
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

const LEVEL = { critical: 'Critical', high: 'High', medium: 'Medium' };

export default function LegalSourceStub() {
  const { pathname } = useLocation();
  const src = SOURCES[pathname];
  if (!src) return null;
  return (
    <div className="lss-page">
      <PageMasthead eyebrow={src.eyebrow} eyebrowMuted={`source: ${src.site}`} title={src.title} compact={false}>
        {src.blurb}
      </PageMasthead>
      {/* The History button every tab has — this one's log stays empty
          until the source is connected. */}
      <LegalTabs trailing={<HistoryButton tab={pathname.slice(1)} tip="Nothing is logged here until the source is connected" emptyText="Nothing yet. This source is not connected." onPick={() => {}} />} />
      {/* Drawn as the Doc Viewer advisor's empty state ("Ask about this
          document"): a bare thin-stroke mark, the sentence under it, nothing
          framed — centred across the page under the bar. */}
      <section className="lss-card">
        <span className="lss-mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="64" height="64" fill="none" stroke="currentColor" strokeWidth="1.15" strokeLinecap="round" strokeLinejoin="round">
            <path d="m19 5 3-3" />
            <path d="m2 22 3-3" />
            <path d="M6.3 20.3a2.4 2.4 0 0 0 3.4 0L12 18l-6-6-2.3 2.3a2.4 2.4 0 0 0 0 3.4Z" />
            <path d="M7.5 13.5 10 11" />
            <path d="M10.5 16.5 13 14" />
            <path d="m12 6 6 6 2.3-2.3a2.4 2.4 0 0 0 0-3.4l-2.6-2.6a2.4 2.4 0 0 0-3.4 0Z" />
          </svg>
        </span>
        {/* First: in plain words — that the page is not available, and what
            it will do. */}
        <p className="lss-title">Unavailable at the moment</p>
        <p className="lss-plain">{src.plain}</p>

        {/* Second: the technical part, folded away — how the source would be
            reached — and the uses as a row of pills. */}
        <div className="lss-tech">
          <details className="lss-more">
            <summary className="lss-more-head">
              <span>How it would connect</span>
              <svg className="lss-chev" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M6 9l6 6 6-6" />
              </svg>
            </summary>
            <p className="lss-access">{src.access}</p>
          </details>
          <ul className="lss-uses">
            {src.uses.map((u) => (
              <li key={u.text} className="lss-use">
                <span className={`lss-level is-${u.level}`}>{LEVEL[u.level]}</span>
                <span>{u.text}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>
    </div>
  );
}
