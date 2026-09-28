import React, { useMemo, useState } from 'react';
import { ItemGlyph, FolderOrBinGlyph } from '../components/FilesWorkspace';
import { extCategory } from '../components/fileGlyph';
import { useNotify } from '../context/NotificationsContext';
import { useUpdates } from '../context/UpdatesContext';
import { clearThumbnailCache } from '../lib/thumbnailEngine';
import { clearPdfCache } from '../lib/pdfCache';
import { clearDocxRenders } from '../lib/docxRenderCache';
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
import Tooltip from '../components/Tooltip';
import { REF_GROUPS, REF_CATALOGUE, findAllLegalRefs, refKindName, scanRefPatterns } from '../lib/lawRefs';
import { setWorkspaceSimulation, workspaceSimulation } from '../lib/workspaceItems';
import RuleOptions from '../components/RuleOptions';
import { AI_PROVIDERS, AI_SURFACES, AI_TASKS, AI_FUNCTIONS, AI_LOCAL, AI_PRIVACY, AI_INTRO, allAiUses } from '../lib/aiInventory';
import LegalDetectionArchive from './DebugLegalArchive';
import AiSettings from './DebugAiSettings';
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
  void clearDocxRenders();
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
  { title: 'DocVex files', exts: ['dvc'] },
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
                label={ext === 'dvc' ? 'Data collection (.dvc)' : ext ? `.${ext}` : '(no extension)'}
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

// ── Romanian legal references — the detector catalogue ─────────────────────
// Every identifier lib/lawRefs recognises in Romanian legal text — acts, court
// files, fiscal codes, land-registry entries, the phrases that announce a
// legal basis — with the regex that finds each, the wording it answers to, and
// what the AI layer does with it. A tester at the top runs the WHOLE detector
// over any pasted text; each entry's examples run that entry's own patterns,
// so what a pattern does and does not catch can be read straight off the page.

const REF_VIA = {
  shape: { label: 'Regex · shape alone', tip: 'The pattern is distinctive enough on its own — no keyword needed.' },
  keyword: { label: 'Regex · keyword required', tip: 'The digits mean nothing without their keyword — it is part of the pattern.' },
  context: { label: 'Context cue', tip: 'Not an identifier — a phrase that tells the AI one is about to follow.' },
};

// The default tester text: one paragraph that trips most of the catalogue.
const REF_SAMPLE = 'În temeiul art. 12 alin. (1) lit. b) din Legea nr. 24/2000, republicată, '
  + 'EXEMPLU CONS S.R.L., J40/123/2026, CUI RO12345678, cont IBAN RO49AAAA1B31007593840000, '
  + 'reprezentată prin administrator, identificat cu C.I. seria RX nr. 456789, CNP 1850101123456, '
  + 'a formulat contestație împotriva Deciziei civile nr. 100/2024 pronunțate de Tribunalul București '
  + 'în dosarul nr. 1.234/3/2023, coroborat cu art. 1349 C.civ. și Decizia CCR nr. 458/2020. '
  + 'Imobil înscris în Cartea Funciară nr. 54321, nr. cadastral 123, cod CAEN 6201, cod COR 261103. '
  + 'Vezi și Cauza C-131/12 și Hotărârea CEDO în cauza Popescu contra României, potrivit GDPR.';

// `text` with its hits lit: a mark per hit, tagged with the hit's kind (the
// full name on hover) when `tag` is on.
function RefMarked({ text, hits, tag = false }) {
  const out = [];
  let last = 0;
  hits.forEach((h, i) => {
    if (h.start > last) out.push(<React.Fragment key={`t${i}`}>{text.slice(last, h.start)}</React.Fragment>);
    out.push(
      <Tooltip key={`m${i}`} content={refKindName(h.kind)}>
        <mark className="debug-ref-mark">
          {text.slice(h.start, h.end)}
          {tag ? <span className="debug-ref-tag">{h.kind}</span> : null}
        </mark>
      </Tooltip>,
    );
    last = h.end;
  });
  if (last < text.length) out.push(<React.Fragment key="tail">{text.slice(last)}</React.Fragment>);
  return <span className="debug-ref-text">{out}</span>;
}

function LawRefCatalogue() {
  const [sample, setSample] = useState(REF_SAMPLE);
  const sampleHits = useMemo(() => findAllLegalRefs(sample), [sample]);
  return (
    <section className="debug-icons debug-refs">
      <div className="debug-icons-head">
        <div>
          <h2 className="debug-card-title">Legal references — the detector catalogue</h2>
          <p className="debug-card-body">
            Every identifier the app recognises in Romanian legal text (lib/lawRefs): what it is,
            the regex that finds it, the wording it rides on, and what the AI does with it.
            Entries marked <em>live</em> are already wired into the Word preview and the
            Legislation / Court files / CAEN tabs; the rest are detection only, for the
            surfaces that will use them.
          </p>
        </div>
      </div>

      {/* The tester: the whole detector, over any text. */}
      <div className="debug-ref-tester">
        <textarea
          className="debug-ref-input"
          rows={4}
          value={sample}
          onChange={(e) => setSample(e.target.value)}
          spellCheck={false}
          aria-label="Text to run the detectors over"
        />
        <p className="debug-icons-count">
          {sampleHits.length} reference{sampleHits.length === 1 ? '' : 's'} found — hover a mark for its kind.
        </p>
        <p className="debug-ref-result"><RefMarked text={sample} hits={sampleHits} tag /></p>
      </div>

      {REF_GROUPS.map((g) => {
        const entries = REF_CATALOGUE.filter((e) => e.group === g.id);
        if (!entries.length) return null;
        return (
          <div key={g.id} className="debug-icons-group">
            <h3 className="debug-icons-file">{g.id}. {g.name} <span>{entries.length}</span></h3>
            <div className="debug-ref-list">
              {entries.map((e) => (
                <article key={e.id} className="debug-ref">
                  <header className="debug-ref-head">
                    <h4 className="debug-ref-name">{e.name}</h4>
                    <Tooltip content={REF_VIA[e.via]?.tip || ''}>
                      <span className={`debug-ref-pill is-${e.via}`}>{REF_VIA[e.via]?.label || e.via}</span>
                    </Tooltip>
                    {e.live ? (
                      <Tooltip content="Already marked in the Word preview / followable in the source tabs">
                        <span className="debug-ref-pill is-live">Live in the app</span>
                      </Tooltip>
                    ) : null}
                    <span className="debug-ref-kind">{e.id}</span>
                  </header>
                  <p className="debug-ref-what">{e.what}</p>
                  {e.ai ? <p className="debug-ref-ai"><span>AI</span>{e.ai}</p> : null}
                  <div className="debug-ref-phrases">
                    {e.phrases.map((p) => <code key={p}>{p}</code>)}
                  </div>
                  <ul className="debug-ref-examples">
                    {e.examples.map((ex) => (
                      <li key={ex}><RefMarked text={ex} hits={scanRefPatterns(ex, e.res, e.id)} /></li>
                    ))}
                  </ul>
                  <details className="debug-ref-pattern">
                    <summary>{e.res.length === 1 ? 'The pattern' : `The ${e.res.length} patterns, tried in order`}</summary>
                    {e.res.map((re, i) => <code key={i}>/{re.source}/{re.flags}</code>)}
                  </details>
                </article>
              ))}
            </div>
          </div>
        );
      })}
    </section>
  );
}

// THE AI INVENTORY (lib/aiInventory) — every AI the app reaches, three ways:
// by SERVICE (provider → Edge Function → its uses), by SURFACE (where in the
// app each use lives) and by TASK (what it does — the axis the planned merge
// runs along: a task done on two or more surfaces is marked as a candidate).
const AI_VIEWS = { label: 'View', options: [{ id: 'service', label: 'By service' }, { id: 'surface', label: 'By surface' }, { id: 'task', label: 'By task' }] };

function AiUseRow({ u, showSurface = true, showFn = true }) {
  const pv = AI_PROVIDERS.find((p) => p.id === u.provider);
  return (
    <li className="debug-ai-use">
      <div className="debug-ai-use-head">
        <code className="debug-ai-id">{u.id}</code>
        {u.isNew ? <span className="debug-ai-pill is-new">new</span> : null}
        {showSurface ? <span className="debug-ai-pill">{AI_SURFACES[u.surface]?.name || u.surface}</span> : null}
        <span className="debug-ai-pill is-task">{AI_TASKS[u.task] || u.task}</span>
        {showFn ? <span className="debug-ai-pill is-fn" style={{ '--tone': pv?.tone }}>{u.fn}</span> : null}
        {u.model ? <span className="debug-ai-model">{u.model}</span> : null}
      </div>
      <p className="debug-ai-what">{u.what}</p>
    </li>
  );
}

function AiInventory() {
  const [view, setView] = useState('service');
  const uses = useMemo(() => allAiUses(), []);
  const groups = useMemo(() => {
    const by = (key) => {
      const m = new Map();
      for (const u of uses) { if (!m.has(u[key])) m.set(u[key], []); m.get(u[key]).push(u); }
      return m;
    };
    return { surface: by('surface'), task: by('task') };
  }, [uses]);
  return (
    <section className="debug-icons debug-ai">
      <div className="debug-icons-head">
        <div>
          <h2 className="debug-card-title">AI inventory — every AI the app uses</h2>
          <p className="debug-card-body">{AI_INTRO}</p>
        </div>
        <RuleOptions field={AI_VIEWS} value={view} onPick={setView} />
      </div>
      <p className="debug-icons-count">
        {AI_PROVIDERS.length} {AI_PROVIDERS.length === 1 ? 'service' : 'services'} · {AI_FUNCTIONS.length} functions · {uses.length} uses · {Object.keys(AI_SURFACES).length} surfaces.
        Kept as data in lib/aiInventory.js — update it when an AI use is added, moved or removed.
      </p>

      {view === 'service' && AI_PROVIDERS.map((pv) => (
        <div key={pv.id} className="debug-ai-provider">
          <div className="debug-ai-provider-head">
            <span className="debug-ai-dot" style={{ '--tone': pv.tone }} />
            <h3 className="debug-ai-provider-name">{pv.name}</h3>
            <span className="debug-ai-provider-role">{pv.role}</span>
            <code className="debug-ai-key">{pv.key}</code>
          </div>
          <p className="debug-ai-note">{pv.privacy}</p>
          {pv.warning ? <p className="debug-ai-note is-warn">{pv.warning}</p> : null}
          {AI_FUNCTIONS.filter((f) => f.provider === pv.id).map((f) => (
            <div key={f.id} className="debug-ai-fn">
              <div className="debug-ai-fn-head">
                <code className="debug-ai-fn-id">{f.id}</code>
                <span className="debug-ai-fn-title">{f.title}</span>
                {(f.models || []).map((m) => <span key={m} className="debug-ai-model">{m}</span>)}
              </div>
              {f.note ? <p className="debug-ai-note">{f.note}</p> : null}
              <ul className="debug-ai-uses">
                {f.uses.map((u) => <AiUseRow key={u.id} u={{ ...u, fn: f.id, provider: f.provider }} showFn={false} />)}
              </ul>
            </div>
          ))}
        </div>
      ))}

      {view === 'surface' && [...groups.surface.entries()].map(([sid, list]) => (
        <div key={sid} className="debug-ai-fn">
          <div className="debug-ai-fn-head">
            <span className="debug-ai-fn-title">{AI_SURFACES[sid]?.name || sid}</span>
            {AI_SURFACES[sid]?.route ? <code className="debug-ai-fn-id">{AI_SURFACES[sid].route}</code> : null}
            <span className="debug-ai-count">{list.length} {list.length === 1 ? 'use' : 'uses'} · {new Set(list.map((u) => u.fn)).size} {new Set(list.map((u) => u.fn)).size === 1 ? 'function' : 'functions'}</span>
          </div>
          <ul className="debug-ai-uses">{list.map((u) => <AiUseRow key={`${u.fn}:${u.id}`} u={u} showSurface={false} />)}</ul>
        </div>
      ))}

      {view === 'task' && [...groups.task.entries()].map(([tid, list]) => {
        const surfaces = [...new Set(list.map((u) => u.surface))];
        return (
          <div key={tid} className="debug-ai-fn">
            <div className="debug-ai-fn-head">
              <span className="debug-ai-fn-title">{AI_TASKS[tid] || tid}</span>
              <span className="debug-ai-count">{list.length} {list.length === 1 ? 'use' : 'uses'} on {surfaces.length} {surfaces.length === 1 ? 'surface' : 'surfaces'}</span>
              {surfaces.length > 1 ? (
                <Tooltip content={`Done separately on: ${surfaces.map((s) => AI_SURFACES[s]?.name || s).join(', ')}`}>
                  <span className="debug-ai-pill is-merge">merge candidate</span>
                </Tooltip>
              ) : null}
            </div>
            <ul className="debug-ai-uses">{list.map((u) => <AiUseRow key={`${u.fn}:${u.id}`} u={u} />)}</ul>
          </div>
        );
      })}

      <div className="debug-ai-fn">
        <div className="debug-ai-fn-head"><span className="debug-ai-fn-title">Features that use no AI service — they run on the computer</span></div>
        <ul className="debug-ai-uses">
          {AI_LOCAL.map((l) => (
            <li key={l.name} className="debug-ai-use">
              <div className="debug-ai-use-head"><span className="debug-ai-id is-plain">{l.name}</span><span className="debug-ai-pill is-local">local</span></div>
              <p className="debug-ai-what">{l.what}</p>
            </li>
          ))}
        </ul>
      </div>

      <p className="debug-ai-privacy"><b>Privacy.</b> {AI_PRIVACY}</p>
    </section>
  );
}

export default function Debug() {
  const { notify } = useNotify();
  const { session } = useAuth();
  const { selectedProject } = useSelectedProject();
  const { simulateUpdate, setSimulateUpdate, simulateKind, setSimulateKind, currentVersion, latestVersion } = useUpdates();
  const [busy, setBusy] = useState(null);
  const [simItems, setSimItems] = useState(workspaceSimulation);
  const toggleSimItems = () => { const next = !simItems; setWorkspaceSimulation(next); setSimItems(next); };

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

        {/* Sample items in the sidebar's Legislation list, to look at the
            dropdown without opening anything (lib/workspaceItems). */}
        <section className="debug-card">
          <div className="debug-card-text">
            <h2 className="debug-card-title">Simulate items in the Legislation list</h2>
            <p className="debug-card-body">
              Adds sample acts, CAEN classes, a court file and companies to the
              sidebar's Legislation dropdown, after any real ones. Picking one only
              marks it; closing one only removes it.
            </p>
          </div>
          <div className="debug-card-controls">
            <button
              type="button"
              role="switch"
              aria-checked={simItems}
              className={`debug-switch${simItems ? ' is-on' : ''}`}
              onClick={toggleSimItems}
            >
              <span className="debug-switch-track"><span className="debug-switch-knob" /></span>
              <span className="debug-switch-label">{simItems ? 'On' : 'Off'}</span>
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

      <AiSettings />
      <AiInventory />
      <LegalDetectionArchive />
      <LawRefCatalogue />
      <FileTypeIcons />
    </div>
  );
}
