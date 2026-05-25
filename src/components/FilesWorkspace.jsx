import React, { useEffect, useMemo, useRef, useState } from 'react';
import FileThumbnail from './FileThumbnail';
import { useMorphPill } from './useMorphPill';
import './FilesWorkspace.css';

// Files tab redesign — presentational File-Explorer workspace. All data
// and actions are supplied by the parent (ProjectFiles), which keeps the
// branch/sync logic; this component only paints the mockup:
//   window card → tab strip → toolbar → breadcrumb → tile/list canvas →
//   status bar, plus the slide-in "Publish for review" drawer.
//
// Vocabulary is deliberately plain (no git-speak): Team files / My drafts
// / Waiting for review / Removed; "Publish for review" = push.

// ── Inline icon set (Feather-style, currentColor) ─────────────────────
function Icon({ name, size = 16, strokeWidth = 1.8, className = '' }) {
  const p = {
    width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
    stroke: 'currentColor', strokeWidth, strokeLinecap: 'round',
    strokeLinejoin: 'round', className, 'aria-hidden': 'true',
  };
  switch (name) {
    case 'folder': return <svg {...p}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>;
    case 'users': return <svg {...p}><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></svg>;
    case 'edit-pen': return <svg {...p}><path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>;
    case 'clock': return <svg {...p}><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>;
    case 'trash': return <svg {...p}><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6M14 11v6" /><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" /></svg>;
    case 'cloud': return <svg {...p}><path d="M17.5 19a5.5 5.5 0 0 0 .5-10.97 7 7 0 1 0-13.4 3.5A4.5 4.5 0 0 0 6.5 19z" /></svg>;
    case 'plus': return <svg {...p}><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>;
    case 'upload': return <svg {...p}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></svg>;
    case 'move': return <svg {...p}><polyline points="5 9 2 12 5 15" /><polyline points="9 5 12 2 15 5" /><polyline points="15 19 12 22 9 19" /><polyline points="19 9 22 12 19 15" /><line x1="2" y1="12" x2="22" y2="12" /><line x1="12" y1="2" x2="12" y2="22" /></svg>;
    case 'send': return <svg {...p}><line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" /></svg>;
    case 'search': return <svg {...p}><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>;
    case 'chev-left': return <svg {...p}><polyline points="15 18 9 12 15 6" /></svg>;
    case 'chev-right': return <svg {...p}><polyline points="9 18 15 12 9 6" /></svg>;
    case 'chev-up': return <svg {...p}><polyline points="18 15 12 9 6 15" /></svg>;
    case 'chev-down': return <svg {...p}><polyline points="6 9 12 15 18 9" /></svg>;
    case 'grid': return <svg {...p}><rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="3" y="14" width="7" height="7" /><rect x="14" y="14" width="7" height="7" /></svg>;
    case 'list': return <svg {...p}><line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" /><line x1="3" y1="6" x2="3.01" y2="6" /><line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" /></svg>;
    case 'home': return <svg {...p}><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><polyline points="9 22 9 12 15 12 15 22" /></svg>;
    case 'close': return <svg {...p}><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>;
    case 'inbox': return <svg {...p}><polyline points="22 12 16 12 14 15 10 15 8 12 2 12" /><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" /></svg>;
    case 'open': return <svg {...p}><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" /></svg>;
    case 'folder-plus': return <svg {...p}><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /><line x1="12" y1="11" x2="12" y2="17" /><line x1="9" y1="14" x2="15" y2="14" /></svg>;
    default: return null;
  }
}

// Folder icon. `filled` paints a solid folder — used when the folder has
// contents; the outline variant marks an empty folder at a glance.
function FolderGlyph({ filled = false, size = 42 }) {
  return (
    <svg
      className={`fx-folder-glyph${filled ? ' is-filled' : ''}`}
      width={size} height={size} viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor" strokeWidth={filled ? 1 : 1.4}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
    >
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}

const STATUS_LABEL = { new: 'New', edited: 'Edited', deleted: 'Removed', waiting: 'Awaiting review', synced: '' };

// Tile-zoom bounds (px, the grid's min column width). Below the threshold
// the tile grid gives way to the list view.
const FX_MIN_TILE = 96;
const FX_MAX_TILE = 320;
const FX_LIST_THRESHOLD = 128;

// File-type → category for the colored ext-label glyph (from the design).
function extCategory(ext) {
  const e = (ext || '').toLowerCase();
  if (e === 'pdf') return 'pdf';
  if (['doc', 'docx', 'odt', 'pages'].includes(e)) return 'doc';
  if (['xls', 'xlsx', 'csv', 'numbers'].includes(e)) return 'xls';
  if (['ppt', 'pptx', 'key'].includes(e)) return 'ppt';
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(e)) return 'zip';
  // Adobe source files are NOT browser-viewable images — give them their
  // own badge so they don't read as previewable pictures.
  if (e === 'psd') return 'psd';
  if (e === 'ai') return 'ai';
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'heic', 'bmp', 'tif', 'tiff'].includes(e)) return 'img';
  if (['mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v'].includes(e)) return 'vid';
  if (['txt', 'md', 'rtf', 'log'].includes(e)) return 'txt';
  return 'gen';
}
const EXT_GLYPH_LABEL = { pdf: 'PDF', doc: 'DOC', xls: 'XLS', ppt: 'PPT', zip: 'ZIP', img: 'IMG', vid: 'MP4', txt: 'TXT', psd: 'PSD', ai: 'AI', gen: 'FILE' };

// Colored ext-label badge — shown for files with no real preview, matching
// the Claude design mock (PDF red, DOC blue, XLS green, …). Passed to
// FileThumbnail as its `glyph`, so it only appears when no thumbnail loads.
function ExtGlyph({ ext }) {
  const cat = extCategory(ext);
  return <span className={`fx-glyph fx-glyph-${cat}`}>{EXT_GLYPH_LABEL[cat]}</span>;
}

const TAB_DEFS = [
  { id: 'team',   label: 'Team files',        icon: 'users' },
  { id: 'drafts', label: 'My drafts',         icon: 'edit-pen' },
  { id: 'review', label: 'Waiting for review', icon: 'clock' },
  { id: 'trash',  label: 'Removed',           icon: 'trash' },
];

// Per-tab status-dot colour (shown instead of a count when the tab has
// items). Team files is the baseline → no dot.
const TAB_DOT_STATUS = { drafts: 'changes', review: 'waiting', trash: 'deleted' };

// Right-click menu for a file / folder item. Falsy entries collapse via
// useMorphPill's filter, so "Open file location" only appears when the
// item has a real on-disk path (local files + local subfolders).
function itemMenuItems(item, { onOpen, onEdit, onRename, onProperties, onOpenLocation, onDelete, canEdit }) {
  const isFolder = item.kind === 'folder';
  const localPath = isFolder
    ? item._dir?.path
    : (item._isCloud === false ? item._raw?.path : null);
  if (isFolder) {
    return [
      { key: 'open', label: 'Open', onClick: () => onOpen?.(item) },
      // Rename is a write, and only on-disk (local) folders can be renamed —
      // Team-tab folders are derived from cloud folder_path and read-only.
      canEdit && localPath && { key: 'rename', label: 'Rename', onClick: () => onRename?.(item) },
      localPath && { key: 'loc', label: 'Open file location', onClick: () => onOpenLocation?.(item) },
    ];
  }
  return [
    { key: 'open',   label: 'Open',               onClick: () => onOpen?.(item) },
    // Rename + Delete are writes — gated like the toolbar buttons.
    canEdit && { key: 'rename', label: 'Rename',  onClick: () => onRename?.(item) },
    { key: 'props',  label: 'Properties',         onClick: () => onProperties?.(item) },
    localPath && { key: 'loc', label: 'Open file location', onClick: () => onOpenLocation?.(item) },
    canEdit && {
      key: 'delete', label: 'Delete', danger: true,
      onClick: () => onDelete?.(item),
      confirm: {
        title: 'Delete this file?',
        message: item._isCloud
          ? `“${item.name}” will be removed from the team’s files once you publish for review.`
          : `“${item.name}” will be hidden from your drafts. The file stays on your computer.`,
        confirmLabel: 'Delete',
        cancelLabel: 'Cancel',
      },
    },
  ];
}

// ── Tile ──────────────────────────────────────────────────────────────
function Tile({ item, selected, onSelect, onOpen, onEdit, onRename, onProperties, onOpenLocation, onDelete, canEdit }) {
  const isFolder = item.kind === 'folder';
  const status = item.status || 'synced';
  // Cursor-following pill shows the FULL name on hover; right-click morphs
  // it into the Open / Edit / Rename / Properties / Open-file-location /
  // Delete menu.
  const morph = useMorphPill({
    hoverContent: item.name,
    menuItems: itemMenuItems(item, { onOpen, onEdit, onRename, onProperties, onOpenLocation, onDelete, canEdit }),
  });
  return (
    <>
      <button
        type="button"
        className={`fx-tile${isFolder ? ' is-folder' : ''}${selected ? ' is-selected' : ''}${status === 'deleted' ? ' is-deleted' : ''}${status === 'waiting' ? ' is-waiting' : ''}`}
        onClick={() => onSelect(item)}
        onDoubleClick={() => onOpen(item)}
        onMouseMove={morph.handleMouseMove}
        onMouseLeave={morph.handleMouseLeave}
        // stopPropagation so the canvas's background menu doesn't also fire.
        onContextMenu={(e) => { e.stopPropagation(); morph.handleContextMenu(e); }}
      >
        {!isFolder && status !== 'synced' && (
          <span className={`fx-ribbon is-${status}`}>{STATUS_LABEL[status]}</span>
        )}
        <span className="fx-tile-thumb">
          {isFolder ? <FolderGlyph filled={!item.empty} /> : <FileThumbnail descriptor={item.descriptor} glyph={<ExtGlyph ext={item.ext} />} />}
        </span>
        <span>
          <span className="fx-tile-name">{item.name}</span>
          <span className="fx-tile-meta">
            <span>{item.sizeLabel}</span>
            {item.modifiedLabel && <><span className="fx-mdot" /><span>{item.modifiedLabel}</span></>}
          </span>
        </span>
      </button>
      {/* Portalled — kept a SIBLING of the button (not a child) so menu
          clicks don't bubble through the React tree into onSelect. */}
      {morph.node}
    </>
  );
}

// ── List row ──────────────────────────────────────────────────────────
function Row({ item, selected, onSelect, onOpen, onEdit, onRename, onProperties, onOpenLocation, onDelete, canEdit }) {
  const isFolder = item.kind === 'folder';
  const status = item.status || 'synced';
  const morph = useMorphPill({
    hoverContent: item.name,
    menuItems: itemMenuItems(item, { onOpen, onEdit, onRename, onProperties, onOpenLocation, onDelete, canEdit }),
  });
  return (
    <>
      <button
        type="button"
        className={`fx-list-row${selected ? ' is-selected' : ''}${status === 'deleted' ? ' is-deleted' : ''}`}
        onClick={() => onSelect(item)}
        onDoubleClick={() => onOpen(item)}
        onMouseMove={morph.handleMouseMove}
        onMouseLeave={morph.handleMouseLeave}
        onContextMenu={(e) => { e.stopPropagation(); morph.handleContextMenu(e); }}
      >
        <span className="fx-list-name">
          <span className="fx-list-thumb">
            {isFolder ? <FolderGlyph filled={!item.empty} size={20} /> : <FileThumbnail descriptor={item.descriptor} glyph={<ExtGlyph ext={item.ext} />} />}
          </span>
          <span className="fx-name">{item.name}</span>
        </span>
        <span className={`fx-list-status is-${status}`}>
          {status !== 'synced' && <span className="fx-mdot" style={{ background: 'currentColor', width: 6, height: 6, borderRadius: '50%' }} />}
          {STATUS_LABEL[status] || 'Up to date'}
        </span>
        <span className="fx-list-muted">{item.author || '—'}</span>
        <span className="fx-list-muted">{item.modifiedLabel || '—'}</span>
        <span className="fx-list-muted">{item.sizeLabel || ''}</span>
      </button>
      {morph.node}
    </>
  );
}

// ── Publish drawer ────────────────────────────────────────────────────
function PublishDrawer({ open, onClose, changes, adminNames, sending, progress, onSend }) {
  const [title, setTitle] = useState('');
  const [desc, setDesc] = useState('');
  const [picked, setPicked] = useState(() => new Set());

  // Re-seed the picked set whenever the drawer opens with a fresh change list.
  useEffect(() => {
    if (open) setPicked(new Set(changes.map((c) => c.id)));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (id) => setPicked((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const tagFor = (s) => (s === 'new' ? 'New' : s === 'edited' ? 'Edited' : s === 'deleted' ? 'Removed' : '');
  const count = picked.size;

  const handleSend = async () => {
    if (count === 0 || sending) return;
    const res = await onSend(Array.from(picked), title.trim(), desc.trim());
    if (!res?.error) { setTitle(''); setDesc(''); onClose(); }
  };

  return (
    <>
      <div className={`fx-scrim${open ? ' is-open' : ''}`} onClick={sending ? undefined : onClose} />
      <aside className={`fx-drawer${open ? ' is-open' : ''}`} role="dialog" aria-label="Send for review" aria-hidden={!open}>
        <div className="fx-drawer-head">
          <div>
            <h2>Send your changes for review</h2>
            <p>Your team will see these changes and either approve them or send them back. Nothing goes live until they say yes.</p>
          </div>
          <button className="fx-drawer-close" onClick={onClose} aria-label="Close" disabled={sending}>
            <Icon name="close" size={16} />
          </button>
        </div>
        <div className="fx-drawer-body">
          <div className="fx-drawer-section">
            <div className="fx-drawer-label">What's changing</div>
            <input
              className="fx-drawer-input" type="text" value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Update brand assets for Q1 launch"
            />
          </div>
          <div className="fx-drawer-section">
            <div className="fx-drawer-label">A note for your team (optional)</div>
            <textarea
              className="fx-drawer-textarea" value={desc}
              onChange={(e) => setDesc(e.target.value)}
              placeholder="Anything they should know?"
            />
          </div>
          <div className="fx-drawer-section">
            <div className="fx-drawer-label">{count} {count === 1 ? 'change' : 'changes'} included</div>
            {changes.length === 0 && <p style={{ fontSize: 12.5, color: 'var(--text-muted)', margin: 0 }}>Nothing to send right now.</p>}
            {changes.map((c) => (
              <label key={c.id} className="fx-change-row">
                <input type="checkbox" checked={picked.has(c.id)} onChange={() => toggle(c.id)} />
                <span className="fx-name">{c.name}</span>
                {tagFor(c.status) && <span className={`fx-tag is-${c.status}`}>{tagFor(c.status)}</span>}
              </label>
            ))}
          </div>
        </div>
        <div className="fx-drawer-foot" style={{ position: 'relative' }}>
          {sending && (
            <span className="fx-drawer-progress" aria-hidden="true">
              <span
                className={`fx-drawer-progress-fill${progress && progress.total > 0 ? '' : ' is-indeterminate'}`}
                style={progress && progress.total > 0 ? { width: `${Math.min(100, Math.round((progress.current / progress.total) * 100))}%` } : undefined}
              />
            </span>
          )}
          <div className="fx-summary">
            {adminNames ? <>Will notify <strong style={{ color: 'var(--text-secondary)' }}>{adminNames}</strong>.</> : 'Your team admins will be notified.'}
          </div>
          <button className="fx-btn-ghost" onClick={onClose} disabled={sending}>Cancel</button>
          <button className="fx-btn-primary" onClick={handleSend} disabled={count === 0 || sending}>
            <Icon name="send" size={14} />
            {sending ? 'Sending…' : 'Send for review'}
          </button>
        </div>
      </aside>
    </>
  );
}

// ── Main workspace ────────────────────────────────────────────────────
export default function FilesWorkspace({
  projectName,
  summaryText,
  tab,
  onTabChange,
  counts,
  draftDot,
  branch,            // { state, title, detail, workspaceLabel }
  canEdit,
  hasLocalFolder,
  onPickFolder,
  // Local-folder selector (the directory on this computer where drafts live)
  hasLocalFolderApi,
  localFolder,
  onFolderChange,
  folderEditable,
  // team folder navigation
  crumbs,            // [{ label, path }] — last is current
  onCrumb,           // (path) => void
  onBack, onUp, canBack, canUp,
  // data for the active tab
  folders,           // folder items (team tab only)
  items,             // file items
  loading,
  // actions
  onOpen, onEdit, onRename, onMove, onDelete, onNewFolder, onUpload, onGetUpdates, onOpenLocation,
  // publish
  draftChanges, adminNames, publishing, publishProgress, onPublish,
  // team edit mode
  onRevertEdits,
}) {
  // Tile zoom — driven by Ctrl+scroll over the canvas. There's no separate
  // Tiles/List toggle: zoom out far enough and the grid collapses into the
  // list view; zoom back in and the tiles return.
  const [tileSize, setTileSize] = useState(176);
  const view = tileSize < FX_LIST_THRESHOLD ? 'list' : 'tiles';
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  const [publishOpen, setPublishOpen] = useState(false);
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  // Team-files edit mode. The Team tab is a read-only view of the main
  // branch by default — the action-bar footer + the IN-EDIT-MODE pill are
  // hidden until the user opts in. `editClosing` keeps both mounted for one
  // exit-animation beat after leaving, so the footer/pill animate OUT (the
  // reverse of their entrance) instead of vanishing. `editUiActive` is the
  // "should the edit chrome be on screen" flag (entering, active, or exiting).
  const [teamEditMode, setTeamEditMode] = useState(false);
  const [editClosing, setEditClosing] = useState(false);
  const editCloseTimer = useRef(null);
  const editUiActive = teamEditMode || editClosing;
  const enterEditMode = () => {
    if (editCloseTimer.current) { clearTimeout(editCloseTimer.current); editCloseTimer.current = null; }
    setEditClosing(false);
    setTeamEditMode(true);
  };
  const leaveEditMode = () => {
    if (!teamEditMode) return;
    setTeamEditMode(false);
    setEditClosing(true);
    if (editCloseTimer.current) clearTimeout(editCloseTimer.current);
    editCloseTimer.current = setTimeout(() => { setEditClosing(false); editCloseTimer.current = null; }, 320);
  };
  useEffect(() => () => { if (editCloseTimer.current) clearTimeout(editCloseTimer.current); }, []);
  // Item whose Properties dialog is open (or null). Built entirely from
  // the item model, so no parent round-trip is needed.
  const [propsItem, setPropsItem] = useState(null);
  const newMenuRef = useRef(null);
  const canvasRef = useRef(null);

  // Right-click on empty canvas → a morph menu with Import / New folder.
  // No hoverContent + we only wire handleContextMenu (not mouse-move), so
  // there's no hover pill on the background — just the menu on right-click.
  const bgMorph = useMorphPill({
    hoverContent: '',
    menuItems: [
      canEdit && { key: 'import', label: 'Import files', onClick: () => onUpload?.() },
      canEdit && { key: 'newfolder', label: 'Make new folder', onClick: () => onNewFolder?.() },
    ],
  });

  // Clear selection + drop team edit mode when the tab changes (edit mode
  // is meaningful only on the Team tab). The whole view swaps on a tab
  // change, so reset instantly — no exit animation here.
  useEffect(() => {
    setSelectedId(null);
    setTeamEditMode(false);
    setEditClosing(false);
    if (editCloseTimer.current) { clearTimeout(editCloseTimer.current); editCloseTimer.current = null; }
  }, [tab]);

  // Escape closes the Properties dialog.
  useEffect(() => {
    if (!propsItem) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setPropsItem(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [propsItem]);

  // Ctrl+scroll over the canvas zooms the tiles. `{ passive: false }` so we
  // can preventDefault and suppress the browser's own ctrl+wheel page zoom.
  // Scroll up → bigger tiles; scroll down → smaller, and once it drops below
  // FX_LIST_THRESHOLD the view flips to the list automatically.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return undefined;
    const onWheel = (e) => {
      if (!e.ctrlKey || !e.deltaY) return; // ignore non-zoom / zero-delta ticks
      e.preventDefault();
      setTileSize((prev) => {
        const next = prev - Math.sign(e.deltaY) * 14;
        return Math.max(FX_MIN_TILE, Math.min(FX_MAX_TILE, next));
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // Close the New menu on outside click / Esc.
  useEffect(() => {
    if (!newMenuOpen) return undefined;
    const onDoc = (e) => { if (!newMenuRef.current?.contains(e.target)) setNewMenuOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setNewMenuOpen(false); };
    window.addEventListener('mousedown', onDoc);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('mousedown', onDoc); window.removeEventListener('keydown', onKey); };
  }, [newMenuOpen]);

  const q = query.trim().toLowerCase();
  const matches = (name) => !q || (name || '').toLowerCase().includes(q);
  const shownFolders = useMemo(() => (folders || []).filter((f) => matches(f.name)), [folders, q]); // eslint-disable-line react-hooks/exhaustive-deps
  const shownItems = useMemo(() => (items || []).filter((f) => matches(f.name)), [items, q]); // eslint-disable-line react-hooks/exhaustive-deps
  const totalShown = shownFolders.length + shownItems.length;

  const selectedItem = useMemo(
    () => [...(folders || []), ...(items || [])].find((f) => f.id === selectedId) || null,
    [folders, items, selectedId],
  );
  const onSelect = (item) => setSelectedId((prev) => (prev === item.id ? null : item.id));

  const draftCount = counts?.drafts || 0;
  const reviewCount = counts?.review || 0;
  // Three independent toolbar signals — a user can be behind main AND have
  // unpublished drafts AND have an open request at the same time, so each
  // CTA renders on its own flag rather than a single dominant state. Fall
  // back to the legacy single `state` for any caller that doesn't pass the
  // booleans.
  const hasUnpublished = (branch?.hasChanges ?? branch?.state === 'changes') && draftCount > 0;
  const isBehind = branch?.behind ?? branch?.state === 'behind';
  const isAwaiting = branch?.waiting ?? branch?.state === 'waiting';

  const emptyHint = {
    team: 'No files in this project yet. Click Upload to add the first one.',
    drafts: 'No files in your folder yet. Add or upload files and they\'ll show up here.',
    review: "You haven't sent anything for review. When you do, it waits here until the team responds.",
    trash: 'No removed files. Anything you delete waits here until you publish for review.',
  }[tab];

  return (
    <div className="fx-page">
      <div className="fx-page-head">
        <div>
          <h1>Files</h1>
          <p className="fx-sub">{summaryText}</p>
        </div>
        {hasLocalFolderApi && tab !== 'team' && (
          <div className="fx-folder-bar">
            <Icon name="folder" className="fx-folder-bar-icon" />
            <input
              className="fx-folder-input"
              type="text"
              value={localFolder || ''}
              onChange={folderEditable ? (e) => onFolderChange?.(e.target.value) : undefined}
              readOnly={!folderEditable}
              spellCheck={false}
              placeholder={folderEditable
                ? 'C:\\Users\\you\\Documents\\project-files'
                : 'Choose a folder on your computer'}
              title={localFolder || 'No folder selected'}
            />
            <button type="button" className="fx-folder-browse" onClick={() => onPickFolder?.()}>
              {hasLocalFolder ? 'Change…' : 'Browse…'}
            </button>
          </div>
        )}
      </div>

      <div className="fx-window">
        {/* Tab strip */}
        <div className="fx-tabs" role="tablist">
          {TAB_DEFS.map((t) => {
            const c = counts?.[t.id] || 0;
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                className={`fx-tab${active ? ' is-active' : ''}`}
                onClick={() => onTabChange(t.id)}
                role="tab" aria-selected={active}
              >
                <Icon name={t.icon} className="fx-icon" />
                <span>{t.label}</span>
                {/* Status dot (not a count): amber = you have drafts,
                    indigo = waiting for review, red = removed. Team files
                    is the baseline and carries no dot. */}
                {c > 0 && TAB_DOT_STATUS[t.id] && (
                  <span className={`fx-tab-status-dot is-${TAB_DOT_STATUS[t.id]}`} aria-hidden="true" />
                )}
              </button>
            );
          })}
          {/* Branch-state pill intentionally NOT shown here — the same
              state lives in the bottom status bar; keeping it off the top
              keeps the tab strip clean. */}
        </div>

        {/* Pathbar — breadcrumb + search + the primary CTA / view toggle.
            File operations live in the bottom action bar. */}
        <div
          className="fx-pathbar"
          // Cursor-following spotlight: write the pointer position (local to
          // the bar) into --spot-x/--spot-y; the ::before glow reads them.
          onMouseMove={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            e.currentTarget.style.setProperty('--spot-x', `${e.clientX - r.left}px`);
            e.currentTarget.style.setProperty('--spot-y', `${e.clientY - r.top}px`);
          }}
        >
          <div className="fx-pathbar-nav">
            <button title="Back" onClick={() => onBack?.()} disabled={!canBack}><Icon name="chev-left" size={14} /></button>
            <button title="Forward" disabled><Icon name="chev-right" size={14} /></button>
            <button title="Up one level" onClick={() => onUp?.()} disabled={!canUp}><Icon name="chev-up" size={14} /></button>
          </div>
          {(crumbs || []).map((cr, i) => {
            const isLast = i === crumbs.length - 1;
            return (
              <React.Fragment key={cr.path ?? i}>
                {i > 0 && <span className="fx-pathbar-sep">›</span>}
                <button
                  type="button"
                  className={`fx-crumb${isLast ? ' is-current' : ''}`}
                  onClick={isLast ? undefined : () => onCrumb?.(cr.path)}
                >
                  {i === 0 && <Icon name="home" className="fx-icon" />} {cr.label}
                </button>
              </React.Fragment>
            );
          })}
          <div style={{ flex: 1 }} />
          <div className="fx-search">
            <Icon name="search" size={14} />
            <input placeholder="Search this folder" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          {tab === 'team' ? (
            // Team files is the read-only view of the main branch. "Edit"
            // enters edit mode (reveals the action-bar footer + the
            // IN-EDIT-MODE pill); once editing, Edit is replaced by Apply
            // (publish the changes) and Revert (discard them).
            editUiActive ? (
              <>
                <button
                  className="fx-tb-btn"
                  onClick={() => { onRevertEdits?.(); leaveEditMode(); }}
                >
                  <Icon name="chev-left" className="fx-icon" />
                  <span>Revert</span>
                </button>
                <button
                  className="fx-tb-btn is-primary"
                  onClick={() => setPublishOpen(true)}
                >
                  <Icon name="send" className="fx-icon" />
                  <span>Apply</span>
                </button>
              </>
            ) : (
              <button className="fx-tb-btn is-primary" onClick={enterEditMode}>
                <Icon name="edit-pen" className="fx-icon" />
                <span>Edit</span>
              </button>
            )
          ) : (
            <>
              {/* Behind main is the priority action — pull before you
                  publish to avoid stacking work on a stale base. Rendered
                  first and given its own (update-hued) treatment so it
                  doesn't read as a second copy of the cognac Publish CTA. */}
              {isBehind && (
                <button className="fx-tb-btn is-update" onClick={() => onGetUpdates?.()} disabled={!hasLocalFolder}>
                  <Icon name="cloud" className="fx-icon" />
                  <span>Get team updates</span>
                </button>
              )}
              {hasUnpublished && (
                <button className="fx-tb-btn is-primary" onClick={() => setPublishOpen(true)}>
                  <Icon name="send" className="fx-icon" />
                  <span>Publish for review</span>
                  <span className="fx-count">{draftCount}</span>
                </button>
              )}
              {isAwaiting && (
                <button className="fx-tb-btn is-waiting" onClick={() => onTabChange('review')}>
                  <Icon name="clock" className="fx-icon" />
                  <span>Awaiting review ({reviewCount})</span>
                </button>
              )}
            </>
          )}
        </div>

        {/* IN EDIT MODE pill — sits directly under the pathbar on the Team
            tab while editing, making the direct-to-main state unmistakable.
            Kept mounted through the closing beat so it animates back out. */}
        {tab === 'team' && editUiActive && (
          <div className={`fx-editmode-row${editClosing ? ' is-closing' : ''}`}>
            <span className="fx-editmode-pill">
              <span className="fx-editmode-dot" aria-hidden="true" />
              IN EDIT MODE
              <span className="fx-editmode-pill-sub">· editing the main branch directly</span>
            </span>
          </div>
        )}

        {/* Canvas */}
        <div
          className="fx-canvas"
          ref={canvasRef}
          style={{ '--fx-tile': `${tileSize}px` }}
          onClick={(e) => { if (e.target === e.currentTarget) setSelectedId(null); }}
          // Right-click on empty space (items stopPropagation their own
          // contextmenu) opens the Import / New-folder menu.
          onContextMenu={canEdit ? bgMorph.handleContextMenu : undefined}
        >
          {!hasLocalFolder && (tab === 'drafts' || tab === 'trash') ? (
            <div className="fx-empty">
              <Icon name="folder" className="fx-icon" strokeWidth={1.2} />
              <h3>Connect a folder to start editing</h3>
              <p>Pick a folder on your computer — that's where your drafts live before you publish them for the team.</p>
              <button className="fx-btn-primary" onClick={() => onPickFolder?.()}><Icon name="folder" size={14} /> Choose folder</button>
            </div>
          ) : loading ? (
            <div className="fx-empty"><p>Loading…</p></div>
          ) : totalShown === 0 ? (
            <div className="fx-empty">
              <Icon name="inbox" className="fx-icon" strokeWidth={1.2} />
              <h3>{q ? 'No matches' : 'Nothing here yet'}</h3>
              <p>{q ? `No files match “${query}”.` : emptyHint}</p>
            </div>
          ) : view === 'tiles' ? (
            <>
              {shownFolders.length > 0 && (
                <>
                  <div className="fx-section-head"><h2>Folders</h2><span className="fx-count">{shownFolders.length}</span></div>
                  <div className="fx-grid">
                    {shownFolders.map((f) => (
                      <Tile key={f.id} item={f} selected={selectedId === f.id} onSelect={onSelect} onOpen={onOpen} onEdit={onEdit} onRename={onRename} onProperties={setPropsItem} onOpenLocation={onOpenLocation} onDelete={onDelete} canEdit={canEdit} />
                    ))}
                  </div>
                </>
              )}
              {shownItems.length > 0 && (
                <>
                  <div className="fx-section-head"><h2>Files</h2><span className="fx-count">{shownItems.length}</span></div>
                  <div className="fx-grid">
                    {shownItems.map((f) => (
                      <Tile key={f.id} item={f} selected={selectedId === f.id} onSelect={onSelect} onOpen={onOpen} onEdit={onEdit} onRename={onRename} onProperties={setPropsItem} onOpenLocation={onOpenLocation} onDelete={onDelete} canEdit={canEdit} />
                    ))}
                  </div>
                </>
              )}
            </>
          ) : (
            <div className="fx-list">
              <div className="fx-list-head">
                <div>Name</div><div>Status</div><div>Last edited by</div><div>When</div><div>Size</div>
              </div>
              {[...shownFolders, ...shownItems].map((f) => (
                <Row key={f.id} item={f} selected={selectedId === f.id} onSelect={onSelect} onOpen={onOpen} onEdit={onEdit} onRename={onRename} onProperties={setPropsItem} onOpenLocation={onOpenLocation} onDelete={onDelete} canEdit={canEdit} />
              ))}
            </div>
          )}
        </div>

        {/* Bottom action bar — file operations on the left, item count +
            branch state on the right. On the Team tab it only appears in
            edit mode (sliding up on enter, back down on exit); the read-only
            main view shows no footer otherwise. */}
        {(tab !== 'team' || editUiActive) && (
        <div className={`fx-bottombar${tab === 'team' ? (editClosing ? ' fx-anim-out' : ' fx-anim-in') : ''}`}>
          <div className="fx-bottombar-actions">
            <div className="fx-menu-wrap" ref={newMenuRef}>
              <button className="fx-tb-btn" disabled={!canEdit} onClick={() => setNewMenuOpen((v) => !v)}>
                <Icon name="plus" className="fx-icon" />
                <span>New</span>
                <Icon name="chev-up" className="fx-caret" />
              </button>
              {newMenuOpen && (
                <div className="fx-menu is-up" role="menu">
                  <button onClick={() => { setNewMenuOpen(false); onNewFolder?.(); }}>
                    <Icon name="folder-plus" className="fx-icon" /> New folder
                  </button>
                  <button onClick={() => { setNewMenuOpen(false); onUpload?.(); }}>
                    <Icon name="upload" className="fx-icon" /> Add files…
                  </button>
                </div>
              )}
            </div>
            <button className="fx-tb-btn" disabled={!canEdit} onClick={() => onUpload?.()}>
              <Icon name="upload" className="fx-icon" /><span>Upload</span>
            </button>
            <div className="fx-tb-sep" />
            <button className="fx-tb-btn" disabled={!selectedItem} onClick={() => selectedItem && onOpen?.(selectedItem)}>
              <Icon name="open" className="fx-icon" /><span>Open</span>
            </button>
            <button className="fx-tb-btn" disabled={!selectedItem || !canEdit} onClick={() => selectedItem && onRename?.(selectedItem)}>
              <Icon name="edit-pen" className="fx-icon" /><span>Rename</span>
            </button>
            <button className="fx-tb-btn" disabled={!selectedItem || !canEdit} onClick={() => selectedItem && onDelete?.(selectedItem)}>
              <Icon name="trash" className="fx-icon" /><span>Delete</span>
            </button>
          </div>
          <div className="fx-bottombar-status">
            <span>{totalShown} {totalShown === 1 ? 'item' : 'items'}</span>
            {selectedItem && <span>· 1 selected</span>}
            {branch && (
              <span className={`fx-sb-pill is-${branch.state}`}>
                <span className="fx-dot" />
                <span>{branch.title}</span>
              </span>
            )}
          </div>
        </div>
        )}

        <PublishDrawer
          open={publishOpen}
          onClose={() => setPublishOpen(false)}
          changes={draftChanges || []}
          adminNames={adminNames}
          sending={publishing}
          progress={publishProgress}
          onSend={onPublish}
        />

        {/* Background right-click menu (Import / New folder) — portalled. */}
        {bgMorph.node}
      </div>

      {propsItem && <PropertiesModal item={propsItem} onClose={() => setPropsItem(null)} />}
    </div>
  );
}

// ── Properties dialog ──────────────────────────────────────────────────
// Read-only inspector for a single file / folder, built from the item
// model the workspace already has (no extra fetch).
function PropertiesModal({ item, onClose }) {
  const isFolder = item.kind === 'folder';
  const typeLabel = isFolder
    ? 'Folder'
    : (item.ext ? `${item.ext.toUpperCase()} file` : 'File');
  const location = isFolder
    ? (item._dir?.path || item.path || '')
    : (item._isCloud ? (item._raw?.folder_path || 'Project root') : (item._raw?.path || ''));
  const statusLabel = STATUS_LABEL[item.status] || 'Up to date';
  const rows = [
    ['Name', item.name],
    ['Type', typeLabel],
    !isFolder && item.sizeLabel && ['Size', item.sizeLabel],
    item.modifiedLabel && ['Modified', item.modifiedLabel],
    ['Status', statusLabel],
    !isFolder && item.author && ['Edited by', item.author],
    location && ['Location', location, true],
  ].filter(Boolean);
  return (
    <div className="fx-props-scrim" role="presentation" onClick={onClose}>
      <div className="fx-props" role="dialog" aria-label="Properties" onClick={(e) => e.stopPropagation()}>
        <div className="fx-props-head">
          <h3>Properties</h3>
          <button className="fx-drawer-close" onClick={onClose} aria-label="Close">
            <Icon name="close" size={16} />
          </button>
        </div>
        <div className="fx-props-thumb">
          {isFolder ? <FolderGlyph filled={!item.empty} /> : <FileThumbnail descriptor={item.descriptor} glyph={<ExtGlyph ext={item.ext} />} />}
        </div>
        <dl className="fx-props-list">
          {rows.map(([label, value, isPath]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd className={isPath ? 'fx-props-path' : undefined}>{value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
