import React from 'react';

// mailData.jsx — static presentation data for the Mail tab: the provider cards
// on the connect screen and the category hue palette used to colour sender
// avatars / the row eyebrow. The inbox itself is REAL (fetched via lib/mail.js);
// nothing here is sample mail.

// Hue palette reused for the per-sender accent (hashed from the sender domain).
export const MAIL_CAT_HUES = [
  'var(--cat-project)',
  'var(--cat-member)',
  'var(--cat-role)',
  'var(--cat-file)',
  'var(--cat-auth)',
  'var(--cat-update)',
];

// Deterministic hue for a sender (so each correspondent keeps a stable colour).
export function hueForSender(key) {
  if (!key) return 'var(--cat-system)';
  let h = 0;
  for (let i = 0; i < key.length; i++) { h = ((h << 5) - h) + key.charCodeAt(i); h |= 0; }
  return MAIL_CAT_HUES[Math.abs(h) % MAIL_CAT_HUES.length];
}

export const MAIL_PROVIDERS = [
  {
    id: 'gmail', name: 'Gmail', sub: 'Google Workspace or personal', enabled: true,
    glyph: (
      <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
        <path fill="#EA4335" d="M5 5.5 12 11l7-5.5V4a1 1 0 0 0-1-1H6a1 1 0 0 0-1 1v1.5Z" />
        <path fill="#FBBC04" d="M3 6.2V18a1 1 0 0 0 1 1h2V8.1L3 6.2Z" />
        <path fill="#34A853" d="M21 6.2 18 8.1V19h2a1 1 0 0 0 1-1V6.2Z" />
        <path fill="#4285F4" d="M6 8.1V19h12V8.1l-6 4.6-6-4.6Z" />
      </svg>
    ),
  },
  {
    id: 'outlook', name: 'Outlook', sub: 'Microsoft 365 or Exchange', enabled: true,
    glyph: (
      <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
        <rect x="2" y="5" width="12" height="14" rx="2" fill="#0A66C2" />
        <circle cx="8" cy="12" r="3.1" fill="none" stroke="#fff" strokeWidth="1.7" />
        <path fill="#28A8EA" d="M14 8.4 22 6v12l-8-2.4V8.4Z" />
        <path fill="#0A66C2" d="M14 9.2 22 7.6V10l-8 4-0-4.8Z" opacity=".35" />
      </svg>
    ),
  },
  {
    id: 'imap', name: 'IMAP / Other', sub: 'Coming soon', enabled: false,
    glyph: (
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <path d="m3 7 9 6 9-6" />
      </svg>
    ),
  },
];

export const PROVIDER_LABELS = { gmail: 'Gmail', outlook: 'Outlook' };
