import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import './MapDrawer.css';
import Tooltip from './Tooltip';
import { openExternal } from '../lib/platform';

// AN ADDRESS ON THE MAP — a panel sliding in from the right of the window,
// floating over the page (the Playbook's Word drawer's surface): Google Maps'
// embed pinned on the address (`maps?q=…&output=embed`, no key needed), with
// "Open in Google Maps" for the full site. Closed by ×, Escape or a press
// outside it. The packaged CSP allows the frame (`frame-src` in main.js).
//
// Loading the embed sends the address and the user's IP address to Google (a
// US company), so the frame is only loaded once the user has said yes — asked
// in the drawer the first time, remembered on this device after that.

const MAPS_OK_KEY = 'docvex:maps-consent:v1';
const mapsAllowed = () => { try { return localStorage.getItem(MAPS_OK_KEY) === '1'; } catch { return false; } };

const CloseIcon = (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
);
const ExternalIcon = (
  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M14 4h6v6" /><path d="M20 4l-8.5 8.5" /><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" />
  </svg>
);
export const PinIcon = (
  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z" /><circle cx="12" cy="10" r="2.4" />
  </svg>
);

export const mapsSearchUrl = (address) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address || '')}`;
const mapsEmbedUrl = (address) => `https://www.google.com/maps?q=${encodeURIComponent(address || '')}&output=embed`;

export default function MapDrawer({ address, title = 'Map', onClose }) {
  // Mounted closed, opened the next frame, so it SLIDES in.
  const [open, setOpen] = useState(false);
  const [allowed, setAllowed] = useState(mapsAllowed);
  const allow = () => {
    try { localStorage.setItem(MAPS_OK_KEY, '1'); } catch { /* this time only */ }
    setAllowed(true);
  };
  const shown = !!address;
  useEffect(() => {
    if (!shown) { setOpen(false); return undefined; }
    const id = requestAnimationFrame(() => requestAnimationFrame(() => setOpen(true)));
    return () => cancelAnimationFrame(id);
  }, [shown, address]);
  useEffect(() => {
    if (!shown) return undefined;
    const key = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [shown, onClose]);
  if (!shown) return null;
  return createPortal(
    <>
      <div className="mapd-catch" onMouseDown={() => onClose?.()} />
      <aside className={`mapd${open ? ' is-open' : ''}`} aria-label={`${title}: ${address}`}>
        <header className="mapd-head">
          <span className="mapd-title">
            <span className="mapd-pin">{PinIcon}</span>
            <span className="mapd-titletext">{title}</span>
          </span>
          <span className="mapd-actions">
            <Tooltip content="Open this address in Google Maps">
              <button type="button" className="mapd-btn" onClick={() => openExternal(mapsSearchUrl(address))}>
                <span>Google Maps</span>{ExternalIcon}
              </button>
            </Tooltip>
            <Tooltip content="Close (Esc)">
              <button type="button" className="mapd-close" aria-label="Close the map" onClick={() => onClose?.()}>{CloseIcon}</button>
            </Tooltip>
          </span>
        </header>
        <p className="mapd-address">{address}</p>
        <div className="mapd-frame">
          {allowed ? (
            <iframe title={`Map of ${address}`} src={mapsEmbedUrl(address)} loading="lazy" referrerPolicy="no-referrer" sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox" allowFullScreen />
          ) : (
            <div className="mapd-consent">
              <p>The map is provided by Google. Showing it sends this address and your IP address to Google LLC (United States).</p>
              <button type="button" className="mapd-btn" onClick={allow}>Show the map</button>
            </div>
          )}
        </div>
      </aside>
    </>,
    document.body,
  );
}
