import React, { useEffect, useMemo, useState } from 'react';
import { loadIconCatalogue } from '../lib/iconCatalogue';
import { ItemGlyph, FolderOrBinGlyph } from '../components/FilesWorkspace';
import { extCategory } from '../components/fileGlyph';
import { useNotifications } from '../context/NotificationsContext';
import { useUpdates } from '../context/UpdatesContext';
import { clearThumbnailCache } from '../lib/thumbnailEngine';
import { clearPdfCache } from '../lib/pdfCache';
import { clearAiFileIndex } from '../lib/aiFileIndex';
import { clearAiSearchAnswers } from '../lib/aiSearchCache';
import { sendInviteDebug } from '../lib/projects';
import { sendSupportReport } from '../lib/support';
import { sendWelcomeEmail } from '../lib/sendWelcome';
import { insertDebugBriefs, removeDebugBriefs } from '../lib/legalFeed';
import { runLegalFeedSync } from '../lib/legalFeedSync';
import { TEST_NOTIFICATIONS, TEST_NOTIFICATION_STAGGER_MS, buildFileTestNotifications } from '../notifications/testNotifications';
import { useSelectedProject } from '../context/SelectedProjectContext';
import { useAuth } from '../context/AuthContext';
import { localFolderApi } from '../lib/localFolder';
import { readProjectsDir } from '../lib/projectsDir';
import PageMasthead from '../components/PageMasthead';
import './Debug.css';

// In-app developer tools. These used to live in the native "DEBUG" menu that
// the main process built (and which fired the actions over IPC). The menu has
// been removed, so the actions now run directly here in the renderer — no IPC
// round-trip needed since everything they touch (caches, notify(), Edge
// Functions) is already renderer-side.

// Wipes the renderer's module-level caches (resolved thumbnails in
// thumbnailEngine.js, parsed pdf.js docs in pdfCache.js) and toasts so
// there's feedback.
function clearAllCaches(notify) {
  clearThumbnailCache();
  clearPdfCache();
  // The AI caches are on disk, not in memory — dropping them means the next AI
  // search re-describes the folder, so this costs real money to undo.
  clearAiFileIndex();
  clearAiSearchAnswers();
  notify?.({
    category: 'system',
    variant: 'info',
    priority: 'low',
    icon: 'sparkles',
    title: 'Cache cleared',
    body: 'Thumbnails, PDF documents and the AI file index dropped. The next AI search re-reads the folder.',
    dedupeKey: 'debug-cache-cleared',
  });
}

// Fires one of every entry in TEST_NOTIFICATIONS, staggered 200ms apart so the
// toast stack animates in cleanly. When a project is selected and its local
// folder lists real files, the FILE-category samples are replaced by a full
// per-action set (create / import / edit / … / captions / export) built from
// the user's own files — so the Activity tab's per-file grouping previews
// with real names. Falls back to the static set when no files resolve.
async function sendAllTestNotifications(notify, { selectedProject, userId } = {}) {
  let fileNotifs = [];
  if (selectedProject?.id) {
    try {
      const { path } = await localFolderApi.projectDir(
        selectedProject.id,
        selectedProject.name,
        readProjectsDir(userId) || undefined,
      );
      if (path) {
        const { files } = await localFolderApi.listAll(path);
        const usable = (files || []).filter((f) => f?.name && !f.name.startsWith('.docvex'));
        fileNotifs = buildFileTestNotifications(usable, {
          projectId: selectedProject.id,
          projectName: selectedProject.name || null,
        });
      }
    } catch { /* folder unavailable (web / no folder) — static set below */ }
  }
  const staticSet = fileNotifs.length > 0
    ? TEST_NOTIFICATIONS.filter((p) => p.category !== 'file')
    : TEST_NOTIFICATIONS;
  [...fileNotifs, ...staticSet].forEach((payload, idx) => {
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

// Inserts sample briefs into `legal_updates` so the Newsletter feed and its
// sidebar "new" pill can be exercised without the real legal-ai ingest
// pipeline. RLS gates the write on is_app_admin() — non-admins get an error
// toast. The companion sweep removes everything with a `debug-` slug.
async function generateTestBriefs(notify) {
  const { data, error } = await insertDebugBriefs({ count: 3 });
  notify?.(error
    ? {
        category: 'system', variant: 'error', priority: 'high', icon: 'alert',
        title: 'Couldn’t generate briefs',
        body: `${error.message || error} (app admins only — the insert is RLS-gated).`,
        dedupeKey: 'debug-briefs-error',
      }
    : {
        category: 'system', variant: 'success', priority: 'low', icon: 'sparkles',
        title: 'Test briefs published',
        body: `${data?.length || 0} sample briefs added — check the Newsletter tab and its sidebar pill.`,
        dedupeKey: 'debug-briefs-ok',
      });
}

async function sweepTestBriefs(notify) {
  const { count, error } = await removeDebugBriefs();
  notify?.(error
    ? {
        category: 'system', variant: 'error', priority: 'high', icon: 'alert',
        title: 'Couldn’t remove test briefs',
        body: error.message || String(error),
        dedupeKey: 'debug-briefs-sweep-error',
      }
    : {
        category: 'system', variant: 'info', priority: 'low', icon: 'trash',
        title: 'Test briefs removed',
        body: `${count} debug brief${count === 1 ? '' : 's'} deleted from the feed.`,
        dedupeKey: 'debug-briefs-sweep-ok',
      });
}

// The Newsletter's real source, tried without consequences: this app walks the
// newest Monitorul Oficial issues and the legal-feed-sync function answers with
// what it WOULD keep, skip or reject — nothing is written and nothing is
// summarised (one screening call is made). The full answer goes to the console.
async function dryRunLegalFeed(notify) {
  try {
    const res = await runLegalFeedSync({ dryRun: true });
    // eslint-disable-next-line no-console
    console.log('[legal-feed-sync] dry run', res);
    const r = res?.reports?.[0];
    notify?.({
      category: 'system', variant: res?.ok ? 'success' : 'warning', priority: 'low', icon: 'sparkles',
      title: res?.skipped ? `Legal feed dry run skipped (${res.skipped})` : 'Legal feed dry run',
      body: r
        ? `Issues to nr. ${r.issuesTo}: ${r.records} acts read, ${r.new ?? 0} new, ${r.skippedByRules ?? 0} skipped by rules, ${r.relevant ?? 0} relevant. Details in the console.`
        : 'Nothing to report — see the console.',
      dedupeKey: 'debug-legal-feed-dry',
    });
  } catch (err) {
    notify?.({
      category: 'system', variant: 'error', priority: 'high', icon: 'alert',
      title: 'Legal feed dry run failed',
      body: String(err?.message || err),
      dedupeKey: 'debug-legal-feed-dry-error',
    });
  }
}

const ACTIONS = [
  {
    id: 'legal-feed-dry',
    title: 'Legal feed: dry run',
    body: 'Reads the newest Monitorul Oficial issues from legislatie.just.ro (desktop app only) and asks the legal-feed-sync function what it would add to the Newsletter. Writes nothing. App admins only.',
    cta: 'Dry run',
    run: (notify) => dryRunLegalFeed(notify),
  },
  {
    id: 'generate-briefs',
    title: 'Generate test briefs',
    body: 'Publishes 3 sample legal briefs into the Newsletter feed (slugs prefixed debug-) so the feed and the sidebar "new brief" pill can be previewed. App admins only.',
    cta: 'Generate briefs',
    run: (notify) => generateTestBriefs(notify),
  },
  {
    id: 'sweep-briefs',
    title: 'Remove test briefs',
    body: 'Deletes every debug-generated brief (slug starting with debug-) from the Newsletter feed. App admins only.',
    cta: 'Remove briefs',
    run: (notify) => sweepTestBriefs(notify),
  },
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
    body: 'Fires one of every notification kind. File notifications use the real files from the selected project’s folder (one per action — created, imported, edited, trashed, extracted, captioned…), so the Activity tab previews with your own documents.',
    cta: 'Fire notifications',
    run: (notify, ctx) => sendAllTestNotifications(notify, ctx),
  },
  {
    id: 'email-previews',
    title: 'Send all email previews to me',
    body: 'Sends the welcome, invite, and support-report email templates to your own inbox so you can verify each layout end-to-end.',
    cta: 'Send previews',
    run: (notify) => sendAllEmailPreviews(notify),
  },
];

// Every file-type icon the Files tab (and the sidebar's open-files list) can
// paint, drawn by the REAL components (ItemGlyph / FolderOrBinGlyph), grouped
// the way extCategory groups extensions. Keep FILE_TYPES in step with
// extCategory in components/fileGlyph.jsx when a format is added there.
const FILE_TYPES = [
  { title: 'PDF', exts: ['pdf'] },
  { title: 'Word', exts: ['doc', 'docx', 'docm', 'dot', 'dotx', 'dotm', 'rtf', 'odt', 'pages'] },
  { title: 'Excel', exts: ['xls', 'xlsx', 'xlsm', 'xlsb', 'xlt', 'xltx', 'xltm', 'csv', 'ods', 'numbers'] },
  { title: 'PowerPoint', exts: ['ppt', 'pptx', 'pptm', 'pps', 'ppsx', 'ppsm', 'pot', 'potx', 'potm', 'odp', 'key'] },
  { title: 'Images', exts: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'heic', 'bmp', 'tif', 'tiff', 'psd', 'ai'] },
  { title: 'Video', exts: ['mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v'] },
  { title: 'Audio', exts: ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'flac', 'opus', 'wma', 'aif', 'aiff'] },
  { title: 'Text', exts: ['txt', 'md', 'log'] },
  { title: 'Archives', exts: ['zip', 'rar', '7z', 'tar', 'gz'] },
  { title: 'DocVex records', exts: ['dvx', 'identity-org'] },
  { title: 'Anything else', exts: ['xyz', ''] },
];
const SPECIAL_TYPES = [
  { label: 'Folder (empty)', folder: { kind: 'folder', name: 'Folder', empty: true } },
  { label: 'Folder (with files)', folder: { kind: 'folder', name: 'Folder', empty: false } },
  { label: 'WhatsApp folder', folder: { kind: 'folder', name: 'Chat', empty: false, isWhatsApp: true } },
  { label: 'Trash (empty)', folder: { kind: 'folder', name: 'Trash', binEntry: true, binCount: 0 } },
  { label: 'Trash (full)', folder: { kind: 'folder', name: 'Trash', binEntry: true, binCount: 3 } },
  { label: 'WhatsApp export (.zip)', file: { kind: 'file', name: 'WhatsApp Chat.zip', ext: 'zip', isWhatsApp: true } },
];

function FileTypeTile({ label, sub, children }) {
  return (
    <div className="debug-icon">
      <span className="debug-ftype-art fx-tile-thumb" style={{ '--fx-tile': '88px' }}>{children}</span>
      <span className="debug-icon-name">{label}</span>
      {sub && <span className="debug-icon-where">{sub}</span>}
    </div>
  );
}

function FileTypeIcons() {
  return (
    <section className="debug-icons">
      <div className="debug-icons-head">
        <div>
          <h2 className="debug-card-title">File type icons</h2>
          <p className="debug-card-body">
            Every icon a file or folder can wear in the Files tab, drawn by the
            real components, for each extension the app recognises.
          </p>
        </div>
      </div>
      <div className="debug-icons-group">
        <h3 className="debug-icons-file">Folders and special items</h3>
        <div className="debug-icons-grid">
          {SPECIAL_TYPES.map((t) => (
            <FileTypeTile key={t.label} label={t.label}>
              {t.folder ? <FolderOrBinGlyph item={t.folder} size={48} /> : <ItemGlyph item={t.file} />}
            </FileTypeTile>
          ))}
        </div>
      </div>
      {FILE_TYPES.map((g) => (
        <div key={g.title} className="debug-icons-group">
          <h3 className="debug-icons-file">{g.title} <span>{g.exts.length}</span></h3>
          <div className="debug-icons-grid">
            {g.exts.map((ext) => (
              <FileTypeTile
                key={ext || '(none)'}
                label={ext === 'identity-org' ? 'Organisation record' : ext === 'dvx' ? 'Person record (.dvx)' : ext ? `.${ext}` : '(no extension)'}
                sub={extCategory(ext)}
              >
                <ItemGlyph item={{ kind: 'file', name: ext ? `file.${ext}` : 'file', ext }} />
              </FileTypeTile>
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}

// Every icon in the app, read out of the source (lib/iconCatalogue) — what it
// is called in code, where it lives, and the comment written above it.
function IconCatalogue() {
  const [icons, setIcons] = useState(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  useEffect(() => {
    let alive = true;
    loadIconCatalogue()
      .then((list) => { if (alive) setIcons(list); })
      .catch((e) => { if (alive) setError(String(e?.message || e)); });
    return () => { alive = false; };
  }, []);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!icons || !q) return icons || [];
    return icons.filter((i) => `${i.name} ${i.file} ${i.note}`.toLowerCase().includes(q));
  }, [icons, query]);
  // Grouped by file, in source order.
  const groups = useMemo(() => {
    const m = new Map();
    for (const i of shown) {
      if (!m.has(i.file)) m.set(i.file, []);
      m.get(i.file).push(i);
    }
    return [...m.entries()];
  }, [shown]);

  return (
    <section className="debug-icons">
      <div className="debug-icons-head">
        <div>
          <h2 className="debug-card-title">All icons</h2>
          <p className="debug-card-body">
            Every icon in the app, found in the source code: its name in code,
            the file and line it lives on, and what the comment above it says.
            Icons drawn from runtime values show their fixed parts only.
          </p>
        </div>
        <input
          className="debug-icons-search"
          type="search"
          placeholder="Search icons"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {error && <p className="debug-card-body">Couldn’t read the icons: {error}</p>}
      {!icons && !error && <p className="debug-card-body">Reading the source…</p>}
      {icons && (
        <p className="debug-icons-count">
          {shown.length === icons.length ? `${icons.length} icons` : `${shown.length} of ${icons.length} icons`}
          {' '}in {groups.length} files
        </p>
      )}
      {groups.map(([file, list]) => (
        <div key={file} className="debug-icons-group">
          <h3 className="debug-icons-file">{file} <span>{list.length}</span></h3>
          <div className="debug-icons-grid">
            {list.map((i) => (
              <div key={i.id} className="debug-icon">
                {i.url
                  ? <img className="debug-icon-art" src={i.url} alt="" />
                  // Markup made from this app's own source, not user content.
                  : <span className="debug-icon-art" dangerouslySetInnerHTML={{ __html: i.html }} />}
                <span className="debug-icon-name">{i.name}</span>
                <span className="debug-icon-where">{i.line ? `line ${i.line}` : 'file'}</span>
                {i.note && <span className="debug-icon-note">{i.note}</span>}
              </div>
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}

export default function Debug() {
  const { notify } = useNotifications();
  const { session } = useAuth();
  const { selectedProject } = useSelectedProject();
  const { simulateUpdate, setSimulateUpdate, simulateKind, setSimulateKind, currentVersion, latestVersion } = useUpdates();
  const [busy, setBusy] = useState(null);

  const handleRun = async (action) => {
    setBusy(action.id);
    try {
      await action.run(notify, { selectedProject, userId: session?.user?.id || null });
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

      <FileTypeIcons />
      <IconCatalogue />
    </div>
  );
}
