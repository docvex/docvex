import React, { useState } from 'react';
import { useNotifications } from '../context/NotificationsContext';
import { useUpdates } from '../context/UpdatesContext';
import { clearThumbnailCache } from '../lib/thumbnailResolver';
import { clearPdfCache } from '../lib/pdfCache';
import { sendInviteDebug } from '../lib/projects';
import { sendSupportReport } from '../lib/support';
import { sendWelcomeEmail } from '../lib/sendWelcome';
import { TEST_NOTIFICATIONS, TEST_NOTIFICATION_STAGGER_MS } from '../notifications/testNotifications';
import PageMasthead from '../components/PageMasthead';
import './Debug.css';

// In-app developer tools. These used to live in the native "DEBUG" menu that
// the main process built (and which fired the actions over IPC). The menu has
// been removed, so the actions now run directly here in the renderer — no IPC
// round-trip needed since everything they touch (caches, notify(), Edge
// Functions) is already renderer-side.

// Wipes the renderer's module-level caches (resolved thumbnails in
// thumbnailResolver.js, parsed pdf.js docs in pdfCache.js) and toasts so
// there's feedback.
function clearAllCaches(notify) {
  clearThumbnailCache();
  clearPdfCache();
  notify?.({
    category: 'system',
    variant: 'info',
    priority: 'low',
    icon: 'sparkles',
    title: 'Cache cleared',
    body: 'Thumbnails + PDF documents dropped. Reopen any file to refetch.',
    dedupeKey: 'debug-cache-cleared',
  });
}

// Fires one of every entry in TEST_NOTIFICATIONS, staggered 200ms apart so the
// toast stack animates in cleanly. Lets devs eyeball every category × priority
// × icon combo without triggering the live actions.
function sendAllTestNotifications(notify) {
  TEST_NOTIFICATIONS.forEach((payload, idx) => {
    window.setTimeout(() => {
      notify?.(payload);
    }, idx * TEST_NOTIFICATION_STAGGER_MS);
  });
}

// Fires every transactional email Edge Function with the `debug: true` flag so
// each template lands in the signed-in user's own inbox. The three calls run
// in parallel — a failure on one doesn't block the others — and each send is
// reported via a toast naming the template + success/failure.
async function sendAllEmailPreviews(notify) {
  notify?.({
    category: 'system',
    variant: 'info',
    priority: 'low',
    icon: 'sparkles',
    title: 'Sending email previews',
    body: 'Welcome, invite, and support-report templates are being sent to your inbox.',
    dedupeKey: 'debug-emails-start',
  });

  const targets = [
    { label: 'Welcome',        run: () => sendWelcomeEmail({ debug: true }) },
    { label: 'Invite',         run: () => sendInviteDebug() },
    { label: 'Support report', run: () => sendSupportReport({
      subject: 'Template preview',
      description: 'Triggered from the Debug page → Send all email previews to me. This row exists only so the support-report template renders end-to-end.',
      debug: true,
    }) },
  ];

  await Promise.all(targets.map(async ({ label, run }) => {
    try {
      const { data, error } = await run();
      if (error) {
        notify?.({
          category: 'system',
          variant: 'error',
          priority: 'high',
          icon: 'alert',
          title: `${label} preview failed`,
          body: error.message || 'Unknown error',
          dedupeKey: `debug-email-${label}-error`,
        });
        return;
      }
      // Most functions return `email_status` in `data`. When it's anything
      // other than 'sent' the email didn't actually land — surface that so the
      // user doesn't go searching their inbox.
      const status = data?.email_status;
      if (status && status !== 'sent') {
        notify?.({
          category: 'system',
          variant: 'warning',
          priority: 'normal',
          icon: 'alert',
          title: `${label}: ${status}`,
          body: data?.email_error || 'See Edge Function logs for details.',
          dedupeKey: `debug-email-${label}-${status}`,
        });
        return;
      }
      notify?.({
        category: 'system',
        variant: 'success',
        priority: 'low',
        icon: 'sparkles',
        title: `${label} sent`,
        body: 'Check your inbox to preview the template.',
        dedupeKey: `debug-email-${label}-sent`,
      });
    } catch (err) {
      notify?.({
        category: 'system',
        variant: 'error',
        priority: 'high',
        icon: 'alert',
        title: `${label} preview crashed`,
        body: String(err?.message ?? err),
        dedupeKey: `debug-email-${label}-crash`,
      });
    }
  }));
}

const ACTIONS = [
  {
    id: 'clear-cache',
    title: 'Clear all cached data',
    body: "Wipes the renderer's module-level caches — signed download URLs and parsed pdf.js documents. Reopen any file afterwards to refetch.",
    cta: 'Clear caches',
    run: (notify) => clearAllCaches(notify),
  },
  {
    id: 'test-notifications',
    title: 'Send all test notifications',
    body: 'Fires one of every entry in TEST_NOTIFICATIONS so you can preview the toast stack + history rows for every category × priority × icon combo.',
    cta: 'Fire notifications',
    run: (notify) => sendAllTestNotifications(notify),
  },
  {
    id: 'email-previews',
    title: 'Send all email previews to me',
    body: 'Sends the welcome, invite, and support-report email templates to your own inbox so you can verify each layout end-to-end.',
    cta: 'Send previews',
    run: (notify) => sendAllEmailPreviews(notify),
  },
];

export default function Debug() {
  const { notify } = useNotifications();
  const { simulateUpdate, setSimulateUpdate, simulateKind, setSimulateKind, currentVersion, latestVersion } = useUpdates();
  const [busy, setBusy] = useState(null);

  const handleRun = async (action) => {
    setBusy(action.id);
    try {
      await action.run(notify);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="debug-page">
      <PageMasthead eyebrow="Developer" title="Debug">
        In-app developer aids. These previously lived in the native DEBUG menu
        and now run directly in the renderer.
      </PageMasthead>

      <div className="debug-actions">
        {/* Simulate-update toggle — forces the update badge + banner on without
            a real GitHub release (see UpdatesContext). */}
        <section className="debug-card">
          <div className="debug-card-text">
            <h2 className="debug-card-title">Simulate update available</h2>
            <p className="debug-card-body">
              Pretends a newer version is on GitHub so the sidebar update badge and
              the Updates banner light up — no real release needed.
              {simulateUpdate && latestVersion
                ? ` Currently faking v${latestVersion}${currentVersion ? ` (you’re on v${currentVersion})` : ''}.`
                : ''}
            </p>
          </div>
          <div className="debug-card-controls">
            {/* Bump kind — drives the simulated version (major/minor/patch) so
                the update pill + banner can be previewed in each release
                colour. Disabled while the simulation is off. */}
            <div
              className={`debug-segmented${simulateUpdate ? '' : ' is-disabled'}`}
              role="group"
              aria-label="Simulated update kind"
            >
              {['major', 'minor', 'patch'].map((k) => (
                <button
                  key={k}
                  type="button"
                  className={`debug-seg debug-seg-${k}${simulateKind === k ? ' is-active' : ''}`}
                  aria-pressed={simulateKind === k}
                  disabled={!simulateUpdate}
                  onClick={() => setSimulateKind(k)}
                >
                  {k.charAt(0).toUpperCase() + k.slice(1)}
                </button>
              ))}
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={simulateUpdate}
              className={`debug-switch${simulateUpdate ? ' is-on' : ''}`}
              onClick={() => setSimulateUpdate(!simulateUpdate)}
            >
              <span className="debug-switch-track"><span className="debug-switch-knob" /></span>
              <span className="debug-switch-label">{simulateUpdate ? 'On' : 'Off'}</span>
            </button>
          </div>
        </section>

        {ACTIONS.map((action) => (
          <section key={action.id} className="debug-card">
            <div className="debug-card-text">
              <h2 className="debug-card-title">{action.title}</h2>
              <p className="debug-card-body">{action.body}</p>
            </div>
            <button
              type="button"
              className="debug-card-btn"
              onClick={() => handleRun(action)}
              disabled={busy === action.id}
            >
              {busy === action.id ? 'Working…' : action.cta}
            </button>
          </section>
        ))}
      </div>
    </div>
  );
}
