import React, { useEffect, useState } from 'react';
import Tooltip from './Tooltip';
import { openExternal } from '../lib/platform';
import { peekLinkPreview, loadLinkPreview, subscribeLinkPreviews } from '../lib/linkPreviews';
import './WebSources.css';

// THE WEB SOURCES of an AI answer (2026-10-02) — Claude's own web search
// (project-ai `webSearch`): the server numbers every source the answer cites
// and writes " [n](url)" after the statement it supports; it also lists every
// source the searches reviewed (`sources`: [{ index, title, url, snippet,
// cited }]).
//   · CiteLink   — one of those [n] links in the answer, drawn as a small
//                  numbered chip; it opens straight away (the address came
//                  from the search, not from the text the AI read).
//   · SourcesReviewed — the strip of cards under the answer: number, site,
//                  title; the cited ones first, in the accent.
// Each card wears its SITE's icon, found as the QR code / barcode tooltip finds
// it (lib/linkPreviews → main's `link:preview`: the site's own icon, private
// networks refused, cached in the encrypted store). Only the site's ROOT is
// asked — one request per site, never the cited page — and the initial stands
// in until (or unless) the icon arrives.

export const hostOf = (url) => {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
};

// The answer's sources as a lookup: the URL of each, for its [n] links.
export function sourceIndex(sources) {
  const byUrl = new Map();
  for (const s of sources || []) if (s?.url) byUrl.set(String(s.url), s);
  return byUrl;
}

export function CiteLink({ source, children }) {
  const open = (e) => { e.preventDefault(); e.stopPropagation(); openExternal(source.url); };
  return (
    <Tooltip content={`${source.title || hostOf(source.url)} — ${hostOf(source.url)}`}>
      <a className="ai-cite" href={source.url} onClick={open} rel="noopener noreferrer nofollow" referrerPolicy="no-referrer">
        {children}
      </a>
    </Tooltip>
  );
}

const siteRoot = (url) => {
  try { const u = new URL(url); return /^https?:$/.test(u.protocol) ? `${u.protocol}//${u.host}/` : ''; } catch { return ''; }
};

// The site's icon (a data: URL), null until known.
function useSiteIcon(url) {
  const root = siteRoot(url);
  const [, bump] = useState(0);
  useEffect(() => {
    if (!root) return undefined;
    const off = subscribeLinkPreviews(() => bump((n) => n + 1));
    if (!peekLinkPreview(root)) loadLinkPreview(root);
    return off;
  }, [root]);
  return root ? peekLinkPreview(root)?.icon || null : null;
}

function SiteIcon({ url, host }) {
  const icon = useSiteIcon(url);
  const [broken, setBroken] = useState(false);
  if (icon && !broken) {
    return <img className="ws-source-ico is-img" src={icon} alt="" aria-hidden="true" onError={() => setBroken(true)} />;
  }
  return <SiteIcon url={s.url} host={host} />;
}

export function SourcesReviewed({ sources }) {
  const list = (sources || []).filter((s) => s?.url);
  if (!list.length) return null;
  const cited = list.filter((s) => s.cited).length;
  return (
    <section className="ws-sources" aria-label="Sources reviewed">
      <h4 className="ws-sources-head">
        Sources reviewed
        <span className="ws-sources-count">{cited ? `${cited} cited · ${list.length} reviewed` : `${list.length} reviewed`}</span>
      </h4>
      <div className="ws-sources-row">
        {list.map((s) => {
          const host = hostOf(s.url);
          return (
            <Tooltip key={s.url} content={s.snippet ? `${s.title}\n\n“${s.snippet}”` : s.title}>
              <button type="button" className={`ws-source${s.cited ? ' is-cited' : ''}`} onClick={() => openExternal(s.url)}>
                <span className="ws-source-top">
                  <span className="ws-source-n">{s.index}</span>
                  <span className="ws-source-ico" aria-hidden="true">{(host[0] || '?').toUpperCase()}</span>
                  <span className="ws-source-host">{host}</span>
                </span>
                <span className="ws-source-title">{s.title || host}</span>
              </button>
            </Tooltip>
          );
        })}
      </div>
    </section>
  );
}

// "Searching the web for “…”" — the status line while a search runs.
export function searchLabel(query) {
  return query ? `Searching the web for “${query.length > 60 ? `${query.slice(0, 57)}…` : query}”` : 'Searching the web';
}
