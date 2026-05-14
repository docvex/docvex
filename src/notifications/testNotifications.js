// Sample notification payloads — one per real notify() callsite in the
// codebase, plus the per-priority + per-category coverage that's useful
// for visual QA. Triggered from "DEBUG → Send all test notifications" in
// the menu bar. Each gets a unique id-bearing `dedupeKey` so they don't
// dedupe against each other or against real notifications already in the
// user's history.
//
// Order is chosen so the toast stack tells a coherent visual story when
// viewed end-to-end:
//   1. Quiet routine events (auth, system) first to set the baseline
//   2. Then category lifecycle successes (project, member, file, role)
//   3. Then high-priority info/success (update available, update ready)
//   4. Finally errors and critical failures so the stack ends on the
//      "things that need attention" signal
//
// Stagger interval is tuned to give the toast slide-in animation time to
// breathe (220ms toast animation) without making the full set take an
// unreasonable amount of time to land in the history.

import { NOTIFICATION_CATEGORIES } from '../lib/notifications';

const C = NOTIFICATION_CATEGORIES;

// 200ms between each notify() call. With ~18 entries the full set
// finishes landing in ~3.6 seconds. MAX_ACTIVE_TOASTS (3) caps how many
// appear at once; the rest queue and slide in as the visible ones dismiss.
export const TEST_NOTIFICATION_STAGGER_MS = 200;

// Unique dedupeKey suffix per session so repeated DEBUG → Send fires don't
// coalesce on the second invocation. Date.now() per import is fine —
// the file is loaded once per session.
const SESSION_SUFFIX = `t-${Date.now()}`;

export const TEST_NOTIFICATIONS = Object.freeze([
  // ── Auth (low-priority routine identity events) ─────────────────────
  {
    category: C.AUTH,
    variant: 'success',
    priority: 'low',
    icon: 'log-in',
    title: 'Signed in as Alice Smith',
    dedupeKey: `test-signin-${SESSION_SUFFIX}`,
  },
  {
    category: C.AUTH,
    variant: 'info',
    priority: 'low',
    icon: 'log-out',
    title: 'Signed out',
    dedupeKey: `test-signout-${SESSION_SUFFIX}`,
  },
  {
    category: C.AUTH,
    variant: 'info',
    priority: 'low',
    icon: 'edit',
    title: 'Profile updated',
    dedupeKey: `test-profile-${SESSION_SUFFIX}`,
  },

  // ── System (DEBUG-class low-priority background events) ──────────────
  {
    category: C.SYSTEM,
    variant: 'info',
    priority: 'low',
    icon: 'sparkles',
    title: 'Cache cleared',
    body: 'Signed URLs + PDF documents dropped. Reopen any file to refetch.',
    dedupeKey: `test-cache-${SESSION_SUFFIX}`,
  },

  // ── Project lifecycle ────────────────────────────────────────────────
  {
    category: C.PROJECT,
    variant: 'success',
    icon: 'folder-plus',
    title: 'Project "Demo Project" created',
    dedupeKey: `test-project-created-${SESSION_SUFFIX}`,
  },
  {
    category: C.PROJECT,
    variant: 'success',
    icon: 'edit',
    title: 'Project updated',
    dedupeKey: `test-project-updated-${SESSION_SUFFIX}`,
  },
  {
    category: C.PROJECT,
    variant: 'success',
    icon: 'check',
    title: 'Joined "Marketing Site"',
    body: 'Welcome aboard — you now have access.',
    dedupeKey: `test-project-joined-${SESSION_SUFFIX}`,
  },

  // ── Member + invitation lifecycle ────────────────────────────────────
  {
    category: C.MEMBER,
    variant: 'success',
    icon: 'envelope',
    title: 'Invitation sent',
    body: 'Email delivered to bob@example.com.',
    dedupeKey: `test-invite-sent-${SESSION_SUFFIX}`,
  },
  {
    category: C.MEMBER,
    variant: 'success',
    icon: 'envelope-off',
    title: 'Invitation revoked',
    dedupeKey: `test-invite-revoked-${SESSION_SUFFIX}`,
  },
  {
    category: C.MEMBER,
    variant: 'success',
    icon: 'user-minus',
    title: 'Member removed',
    body: 'Charlie Davis',
    dedupeKey: `test-member-removed-${SESSION_SUFFIX}`,
  },
  {
    category: C.MEMBER,
    variant: 'warning',
    icon: 'envelope-off',
    title: 'Invitation created — email not delivered',
    body: 'RESEND_API_KEY not configured on the server.',
    dedupeKey: `test-invite-no-email-${SESSION_SUFFIX}`,
  },

  // ── File lifecycle ───────────────────────────────────────────────────
  {
    category: C.FILE,
    variant: 'success',
    icon: 'trash',
    title: 'File deleted',
    body: 'proposal-v3.pdf',
    dedupeKey: `test-file-deleted-${SESSION_SUFFIX}`,
  },
  {
    category: C.FILE,
    variant: 'error',
    icon: 'upload',
    title: 'Upload failed',
    body: 'huge-video.mp4: Network timeout after 30s.',
    dedupeKey: `test-upload-failed-${SESSION_SUFFIX}`,
  },
  {
    category: C.FILE,
    variant: 'error',
    icon: 'file-x',
    title: 'Unsupported file type',
    body: '2 files skipped. Allowed: PDF, image, video, text.',
    dedupeKey: `test-file-rejected-${SESSION_SUFFIX}`,
  },

  // ── Role ─────────────────────────────────────────────────────────────
  {
    category: C.ROLE,
    variant: 'success',
    icon: 'trash',
    title: 'Custom role deleted',
    body: 'Designer',
    dedupeKey: `test-role-deleted-${SESSION_SUFFIX}`,
  },

  // ── Update lifecycle (high-priority) ─────────────────────────────────
  {
    category: C.UPDATE,
    variant: 'info',
    priority: 'high',
    icon: 'download',
    title: 'Update available v5.1.0',
    body: 'A newer version of docvex is ready to download.',
    dedupeKey: `test-update-available-${SESSION_SUFFIX}`,
  },
  {
    category: C.UPDATE,
    variant: 'success',
    priority: 'high',
    icon: 'download',
    title: 'Update ready to install',
    body: 'Restart docvex to apply v5.1.0.',
    dedupeKey: `test-update-ready-${SESSION_SUFFIX}`,
  },

  // ── Support ──────────────────────────────────────────────────────────
  {
    category: C.SUPPORT,
    variant: 'success',
    icon: 'send',
    title: 'Report sent',
    body: 'Support will reply by email.',
    dedupeKey: `test-support-sent-${SESSION_SUFFIX}`,
  },

  // ── Critical failures (highest priority — should land last in the
  //    history-page "Critical" tab and pop the most attention as toasts) ─
  {
    category: C.UPDATE,
    variant: 'error',
    priority: 'critical',
    title: 'Update error',
    body: 'The auto-updater reported a problem. Check your connection and retry.',
    dedupeKey: `test-update-error-${SESSION_SUFFIX}`,
  },
  {
    category: C.AUTH,
    variant: 'error',
    priority: 'critical',
    title: 'Could not delete account',
    body: 'The server rejected the request. Try again or contact support.',
    dedupeKey: `test-account-delete-error-${SESSION_SUFFIX}`,
  },
]);
