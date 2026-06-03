import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import FileThumbnail from './FileThumbnail';
import { useMorphPill } from './useMorphPill';
import { usePaneChromeSlot, usePaneChromePortalEl } from '../context/PaneChromeContext';
import './FilesWorkspace.css';

// Platform hint for the search shortcut chip (⌘F on macOS, Ctrl F elsewhere).
const isMacPlatform = typeof navigator !== 'undefined' && /Mac|iP(hone|ad|od)/.test(navigator.platform || '');

// Files tab — presentational File-Explorer workspace. All data and actions
// are supplied by the parent (ProjectFiles), which owns the local-folder
// logic; this component only paints:
//   window card → tab strip → toolbar → breadcrumb → tile/list canvas →
//   status bar.
//
// Two tabs (deliberately plain vocabulary):
//   • My drafts        — the files in your local project folder.
//   • Recently deleted — a recycle bin; deleted files wait here for 30 days
//                        then auto-delete. Each item shows a countdown pill.

// ── Inline icon set (Feather-style, currentColor) ─────────────────────
function Icon({ name, size = 16, strokeWidth = 1.8, className = '' }) {
  const p = {
    width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
    stroke: 'currentColor', strokeWidth, strokeLinecap: 'round',
    strokeLinejoin: 'round', className, 'aria-hidden': 'true',
  };
  switch (name) {
    case 'folder': return <svg {...p}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>;
    case 'edit-pen': return <svg {...p}><path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>;
    case 'trash': return <svg {...p}><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6M14 11v6" /><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" /></svg>;
    case 'restore': return <svg {...p}><polyline points="1 4 1 10 7 10" /><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" /></svg>;
    case 'plus': return <svg {...p}><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>;
    case 'upload': return <svg {...p}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></svg>;
    case 'search': return <svg {...p}><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>;
    case 'chev-left': return <svg {...p}><polyline points="15 18 9 12 15 6" /></svg>;
    case 'chev-right': return <svg {...p}><polyline points="9 18 15 12 9 6" /></svg>;
    case 'chev-up': return <svg {...p}><polyline points="18 15 12 9 6 15" /></svg>;
    case 'chev-down': return <svg {...p}><polyline points="6 9 12 15 18 9" /></svg>;
    case 'home': return <svg {...p}><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><polyline points="9 22 9 12 15 12 15 22" /></svg>;
    case 'close': return <svg {...p}><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>;
    case 'inbox': return <svg {...p}><polyline points="22 12 16 12 14 15 10 15 8 12 2 12" /><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" /></svg>;
    case 'open': return <svg {...p}><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" /></svg>;
    case 'folder-plus': return <svg {...p}><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /><line x1="12" y1="11" x2="12" y2="17" /><line x1="9" y1="14" x2="15" y2="14" /></svg>;
    case 'select': return <svg {...p}><polyline points="9 11 12 14 22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" /></svg>;
    case 'clock': return <svg {...p}><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>;
    case 'undo': return <svg {...p}><polyline points="9 14 4 9 9 4" /><path d="M20 20v-7a4 4 0 0 0-4-4H4" /></svg>;
    case 'redo': return <svg {...p}><polyline points="15 14 20 9 15 4" /><path d="M4 20v-7a4 4 0 0 1 4-4h12" /></svg>;
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

// Glyph for a folder-kind item: the Recycle bin entry gets the trash icon;
// every other folder gets the folder glyph.
function FolderOrBinGlyph({ item, size = 42 }) {
  if (item.binEntry) {
    return <span className="fx-bin-glyph"><Icon name="trash" size={Math.round(size * 0.92)} strokeWidth={1.6} /></span>;
  }
  return <FolderGlyph filled={!item.empty} size={size} />;
}

const STATUS_LABEL = { deleted: 'In bin', synced: '' };

// Tile-zoom bounds (px, the grid's min column width). Below the threshold
// the tile grid gives way to the list view. The threshold is also the
// DEFAULT tile size — i.e. tiles start at the smallest size before the list
// view kicks in, and Ctrl+scroll zooms up from there.
const FX_MIN_TILE = 68;
const FX_MAX_TILE = 320;
const FX_LIST_THRESHOLD = 96;

// File-type → category for the colored ext-label glyph (from the design).
function extCategory(ext) {
  const e = (ext || '').toLowerCase();
  if (e === 'pdf') return 'pdf';
  if (['doc', 'docx', 'odt', 'pages'].includes(e)) return 'doc';
  if (['xls', 'xlsx', 'csv', 'numbers'].includes(e)) return 'xls';
  if (['ppt', 'pptx', 'key'].includes(e)) return 'ppt';
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(e)) return 'zip';
  if (e === 'psd') return 'psd';
  if (e === 'ai') return 'ai';
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'heic', 'bmp', 'tif', 'tiff'].includes(e)) return 'img';
  if (['mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v'].includes(e)) return 'vid';
  if (['txt', 'md', 'rtf', 'log'].includes(e)) return 'txt';
  return 'gen';
}
const EXT_GLYPH_LABEL = { pdf: 'PDF', doc: 'DOC', xls: 'XLS', ppt: 'PPT', zip: 'ZIP', img: 'IMG', vid: 'MP4', txt: 'TXT', psd: 'PSD', ai: 'AI', gen: 'FILE' };

// Colored ext-label badge — shown for files with no real preview.
function ExtGlyph({ ext }) {
  const cat = extCategory(ext);
  return <span className={`fx-glyph fx-glyph-${cat}`}>{EXT_GLYPH_LABEL[cat]}</span>;
}

// Countdown pill for a bin item — "Deletes in N days" (turns red near the
// end of the 30-day retention). Driven by item.deletesInDays.
function CountdownPill({ days, className = '' }) {
  if (days === null || days === undefined) return null;
  const label = days <= 0 ? 'Deletes today' : `Deletes in ${days} ${days === 1 ? 'day' : 'days'}`;
  const urgent = days <= 3;
  return (
    <span className={`fx-countdown-pill${urgent ? ' is-urgent' : ''} ${className}`.trim()} title={label}>
      <Icon name="clock" size={11} />
      <span>{label}</span>
    </span>
  );
}

// Right-click menu for a file / folder item. Tab-aware: in the bin, items
// offer Restore + Delete forever; in drafts, the usual Open / Rename /
// Properties / Open-file-location / Delete. Falsy entries collapse via
// useMorphPill's filter.
function itemMenuItems(item, { tab, onOpen, onRename, onProperties, onOpenLocation, onDelete, onRestore, onEmptyBin, canEdit, selectMode, isMultiSelected, bulkCount, onBulkDelete }) {
  // The Recycle bin entry opens the bin; when it holds files it can also be
  // emptied (permanent delete of everything inside).
  if (item.binEntry) {
    const entries = [{ key: 'open', label: 'Open recycle bin', onClick: () => onOpen?.(item) }];
    if (item.binCount > 0) {
      entries.push({
        key: 'empty',
        label: 'Empty recycle bin',
        danger: true,
        onClick: () => onEmptyBin?.(),
        confirm: {
          title: 'Empty the recycle bin?',
          message: `All ${item.binCount} file${item.binCount === 1 ? '' : 's'} in the bin will be permanently deleted from your computer. This can’t be undone.`,
          confirmLabel: 'Empty bin',
          cancelLabel: 'Cancel',
        },
      });
    }
    return entries;
  }
  const isFolder = item.kind === 'folder';
  const isBin = tab === 'trash';
  const localPath = isFolder ? item._dir?.path : item._raw?.path;
  const bulk = Boolean(isMultiSelected && bulkCount > 1);
  const subject = bulk ? `${bulkCount} items` : (isFolder ? `“${item.name}” and everything inside it` : `“${item.name}”`);

  if (isBin) {
    // Bin items: open (read in place), restore to the folder, or delete forever.
    return [
      { key: 'open', label: 'Open', onClick: () => onOpen?.(item) },
      { key: 'restore', label: 'Restore', onClick: () => onRestore?.(item) },
      {
        key: 'delete', label: bulk ? `Delete ${bulkCount} forever` : 'Delete forever', danger: true,
        onClick: () => (bulk ? onBulkDelete?.() : onDelete?.(item)),
        confirm: {
          title: bulk ? `Permanently delete ${bulkCount} items?` : 'Permanently delete this file?',
          message: `${subject} will be permanently deleted from your computer. This can’t be undone.`,
          confirmLabel: bulk ? `Delete ${bulkCount}` : 'Delete forever',
          cancelLabel: 'Cancel',
        },
      },
    ];
  }

  const deleteEntry = canEdit && {
    key: 'delete',
    label: bulk ? `Delete ${bulkCount} items` : (isFolder ? 'Delete folder' : 'Delete'),
    danger: true,
    onClick: () => (bulk ? onBulkDelete?.() : onDelete?.(item)),
    confirm: {
      title: bulk ? `Delete ${bulkCount} items?` : (isFolder ? 'Delete this folder?' : 'Delete this file?'),
      message: isFolder
        ? `${subject} will be deleted from your computer.`
        : `${subject} will be moved to Recently deleted. It stays recoverable for 30 days.`,
      confirmLabel: bulk ? `Delete ${bulkCount}` : 'Delete',
      cancelLabel: 'Cancel',
    },
  };

  if (isFolder) {
    return [
      { key: 'open', label: 'Open', onClick: () => onOpen?.(item) },
      !bulk && canEdit && localPath && { key: 'rename', label: 'Rename', onClick: () => onRename?.(item) },
      localPath && { key: 'loc', label: 'Open file location', onClick: () => onOpenLocation?.(item) },
      deleteEntry,
    ];
  }
  return [
    { key: 'open',   label: 'Open',               onClick: () => onOpen?.(item) },
    !bulk && canEdit && { key: 'rename', label: 'Rename',  onClick: () => onRename?.(item) },
    { key: 'props',  label: 'Properties',         onClick: () => onProperties?.(item) },
    localPath && { key: 'loc', label: 'Open file location', onClick: () => onOpenLocation?.(item) },
    deleteEntry,
  ];
}

// ── Inline name input (rename + new-folder draft) ─────────────────────
function InlineNameInput({ initial = '', placeholder, onCommit, onCancel, className = '' }) {
  const [value, setValue] = useState(initial);
  const ref = useRef(null);
  const doneRef = useRef(false);
  useEffect(() => {
    const el = ref.current;
    if (el) { el.focus(); el.select(); }
  }, []);
  const finish = (fn) => { if (doneRef.current) return; doneRef.current = true; fn(); };
  const commit = () => finish(() => {
    const v = value.trim();
    if (v) onCommit(v); else onCancel();
  });
  const cancel = () => finish(() => onCancel());
  return (
    <input
      ref={ref}
      className={`fx-inline-input ${className}`}
      type="text"
      value={value}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
      }}
      onBlur={commit}
    />
  );
}

// ── Tile ──────────────────────────────────────────────────────────────
function Tile({ item, tab, selected, onSelect, onOpen, onRename, onProperties, onOpenLocation, onDelete, onRestore, onEmptyBin, canEdit, selectMode, isMultiSelected, bulkCount, onBulkDelete, renaming, onCommitName, onCancelName }) {
  const isFolder = item.kind === 'folder';
  const status = item.status || 'synced';
  const morph = useMorphPill({
    hoverContent: item.name,
    menuItems: itemMenuItems(item, { tab, onOpen, onRename, onProperties, onOpenLocation, onDelete, onRestore, onEmptyBin, canEdit, selectMode, isMultiSelected, bulkCount, onBulkDelete }),
  });
  if (renaming) {
    return (
      <div className={`fx-tile${isFolder ? ' is-folder' : ''} is-renaming`}>
        <span className="fx-tile-thumb">
          {isFolder ? <FolderGlyph filled={!item.empty} /> : <FileThumbnail descriptor={item.descriptor} glyph={<ExtGlyph ext={item.ext} />} />}
        </span>
        <span>
          <InlineNameInput className="fx-tile-name" initial={item.name} onCommit={(name) => onCommitName(name)} onCancel={onCancelName} />
        </span>
      </div>
    );
  }
  return (
    <>
      <button
        type="button"
        className={`fx-tile${isFolder ? ' is-folder' : ''}${selected ? ' is-selected' : ''}${status === 'deleted' ? ' is-deleted' : ''}`}
        onClick={(e) => onSelect(item, e)}
        onDoubleClick={() => onOpen(item)}
        onMouseMove={morph.handleMouseMove}
        onMouseLeave={morph.handleMouseLeave}
        onContextMenu={(e) => { e.stopPropagation(); morph.handleContextMenu(e); }}
      >
        {/* Bin items show a deletion countdown pill; drafts carry no ribbon. */}
        {tab === 'trash' && <CountdownPill days={item.deletesInDays} className="fx-tile-countdown" />}
        <span className="fx-tile-thumb">
          {isFolder ? <FolderOrBinGlyph item={item} /> : <FileThumbnail descriptor={item.descriptor} glyph={<ExtGlyph ext={item.ext} />} />}
        </span>
        <span>
          <span className="fx-tile-name">{item.name}</span>
        </span>
      </button>
      {morph.node}
    </>
  );
}

// New-folder draft tile — a folder placeholder whose name is an inline input.
function NewFolderTile({ onCommit, onCancel }) {
  return (
    <div className="fx-tile is-folder is-renaming">
      <span className="fx-tile-thumb"><FolderGlyph filled={false} /></span>
      <span>
        <InlineNameInput className="fx-tile-name" placeholder="new folder" onCommit={onCommit} onCancel={onCancel} />
      </span>
    </div>
  );
}

// ── List row ──────────────────────────────────────────────────────────
function Row({ item, tab, selected, onSelect, onOpen, onRename, onProperties, onOpenLocation, onDelete, onRestore, onEmptyBin, canEdit, selectMode, isMultiSelected, bulkCount, onBulkDelete, renaming, onCommitName, onCancelName }) {
  const isFolder = item.kind === 'folder';
  const status = item.status || 'synced';
  const isBin = tab === 'trash';
  const morph = useMorphPill({
    hoverContent: item.name,
    menuItems: itemMenuItems(item, { tab, onOpen, onRename, onProperties, onOpenLocation, onDelete, onRestore, onEmptyBin, canEdit, selectMode, isMultiSelected, bulkCount, onBulkDelete }),
  });
  if (renaming) {
    return (
      <div className="fx-list-row is-renaming">
        <span className="fx-list-name">
          <span className="fx-list-thumb">
            {isFolder ? <FolderGlyph filled={!item.empty} size={20} /> : <FileThumbnail descriptor={item.descriptor} glyph={<ExtGlyph ext={item.ext} />} />}
          </span>
          <InlineNameInput className="fx-name" initial={item.name} onCommit={(name) => onCommitName(name)} onCancel={onCancelName} />
        </span>
        <span /><span /><span />
      </div>
    );
  }
  return (
    <>
      <button
        type="button"
        className={`fx-list-row${selected ? ' is-selected' : ''}${status === 'deleted' ? ' is-deleted' : ''}`}
        onClick={(e) => onSelect(item, e)}
        onDoubleClick={() => onOpen(item)}
        onMouseMove={morph.handleMouseMove}
        onMouseLeave={morph.handleMouseLeave}
        onContextMenu={(e) => { e.stopPropagation(); morph.handleContextMenu(e); }}
      >
        <span className="fx-list-name">
          <span className="fx-list-thumb">
            {isFolder ? <FolderOrBinGlyph item={item} size={20} /> : <FileThumbnail descriptor={item.descriptor} glyph={<ExtGlyph ext={item.ext} />} />}
          </span>
          <span className="fx-name">{item.name}</span>
        </span>
        <span className="fx-list-muted">{item.modifiedLabel || '—'}</span>
        <span className="fx-list-muted">{isFolder ? 'Folder' : (item.ext ? item.ext.toUpperCase() : 'File')}</span>
        <span className="fx-list-muted">{item.sizeLabel || '—'}</span>
      </button>
      {morph.node}
    </>
  );
}

// New-folder draft row — a folder placeholder whose name is an inline input.
function NewFolderRow({ onCommit, onCancel }) {
  return (
    <div className="fx-list-row is-renaming">
      <span className="fx-list-name">
        <span className="fx-list-thumb"><FolderGlyph filled={false} size={20} /></span>
        <InlineNameInput className="fx-name" placeholder="new folder" onCommit={onCommit} onCancel={onCancel} />
      </span>
      <span /><span /><span />
    </div>
  );
}

// ── Main workspace ────────────────────────────────────────────────────
export default function FilesWorkspace({
  summaryText,
  // In-panel mode: 'drafts' (the project folder) or 'trash' (the recycle bin,
  // entered by opening the bin folder). There is no tab strip — one panel.
  tab,
  canEdit,
  hasLocalFolder,
  onPickFolder,      // web only — Electron auto-binds the project directory
  hasLocalFolderApi,
  folderError,       // Electron — project-directory resolution failed
  onRetryFolder,
  // folder navigation
  crumbs,            // [{ label, path }] — last is current
  onCrumb,           // (path) => void
  onBack, onUp, canBack, canUp,
  // data for the active mode
  folders,           // folder items (drafts only; includes the Recycle bin entry)
  items,             // file items
  loading,
  // actions
  onOpen, onRename, onDelete, onRestore, onNewFolder, onUpload, onUploadFolder, onOpenLocation,
  onEmptyBin,
  onOpenDirectory,   // () => void — open the current folder in the OS file manager
  onDropFiles,       // (FileList) => void — drag-and-drop import (drafts only)
  // undo / redo (footer)
  onUndo, onRedo, canUndo, canRedo, undoLabel, redoLabel,
}) {
  const isBin = tab === 'trash';
  // Tile zoom — driven by Ctrl+scroll over the canvas. Zoom out far enough
  // and the grid collapses into the list view; zoom back in and the tiles
  // return.
  const [tileSize, setTileSize] = useState(FX_LIST_THRESHOLD);
  const view = tileSize < FX_LIST_THRESHOLD ? 'list' : 'tiles';
  const [query, setQuery] = useState('');
  // Selection — `multiSel` (a Set of ids) is the single source of truth.
  // Plain click selects one; Ctrl/Cmd+click toggles; Shift+click extends a
  // range from the anchor. The "Select" button (selectMode) makes plain
  // clicks additive for mouse-only / touch use. `anchorId` is the pivot for
  // Shift-range selection.
  const [multiSel, setMultiSel] = useState(() => new Set());
  const [anchorId, setAnchorId] = useState(null);
  const [selectMode, setSelectMode] = useState(false);
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const [propsItem, setPropsItem] = useState(null);
  const [dragOver, setDragOver] = useState(false);   // OS file drag over the canvas
  const newMenuRef = useRef(null);
  const canvasRef = useRef(null);
  const pageRef = useRef(null);   // root, used to scope shortcuts to this pane
  const searchRef = useRef(null);

  // Inline name editing (Electron has no window.prompt).
  const [renamingId, setRenamingId] = useState(null);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const requestRename = (item) => { if (item) { setCreatingFolder(false); setRenamingId(item.id); } };
  const requestNewFolder = () => { setRenamingId(null); setCreatingFolder(true); };
  const commitRename = (item, name) => { setRenamingId(null); onRename?.(item, name); };
  const cancelRename = () => setRenamingId(null);
  const commitNewFolder = (name) => { setCreatingFolder(false); onNewFolder?.(name); };
  const cancelNewFolder = () => setCreatingFolder(false);

  // Write actions (rename / import / new folder) are only offered in the
  // My-drafts tab — the bin is restore / delete-forever only.
  const menuEditable = !isBin && canEdit;

  // Right-click on empty canvas → a morph menu with Import / New folder /
  // Open directory (drafts only).
  const bgMorph = useMorphPill({
    hoverContent: '',
    menuItems: [
      menuEditable && { key: 'import', label: 'Import files', onClick: () => onUpload?.() },
      menuEditable && { key: 'importfolder', label: 'Import folder', onClick: () => onUploadFolder?.() },
      menuEditable && { key: 'newfolder', label: 'Make new folder', onClick: () => requestNewFolder() },
      onOpenDirectory && { key: 'opendir', label: 'Open directory', onClick: () => onOpenDirectory() },
    ],
  });

  // Clear selection + inline edits when the tab changes.
  useEffect(() => {
    setMultiSel(new Set());
    setAnchorId(null);
    setSelectMode(false);
    setRenamingId(null);
    setCreatingFolder(false);
  }, [tab]);

  // Escape closes the Properties dialog.
  useEffect(() => {
    if (!propsItem) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setPropsItem(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [propsItem]);

  // Ctrl/Cmd+F focuses the folder search — but only for the SELECTED window.
  // In split view every Files pane shares this global listener, so we gate on
  // the pane's focus state: fire only when this instance lives in the focused
  // `.sv-pane` (or in single-window mode, where there's no `.sv-pane` at all).
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
        const pane = pageRef.current?.closest('.sv-pane');
        if (pane && !pane.classList.contains('is-focused')) return;
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Deselect any selected file(s) when this pane loses focus — selection should
  // only persist in the active window. Watches the pane's `is-focused` class;
  // single-window mode (no `.sv-pane`) has no unfocus concept, so it's skipped.
  useEffect(() => {
    const pane = pageRef.current?.closest('.sv-pane');
    if (!pane || typeof MutationObserver === 'undefined') return undefined;
    const obs = new MutationObserver(() => {
      if (!pane.classList.contains('is-focused')) {
        setMultiSel((prev) => (prev.size ? new Set() : prev));
        setAnchorId(null);
      }
    });
    obs.observe(pane, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, []);

  // Publish the live description into the window chrome (top bar), and grab its
  // row-2 portal slot so the folder toolbar (nav + breadcrumb + search) renders
  // INTO the chrome — merging into one bar — instead of a separate in-page row.
  usePaneChromeSlot({
    description: isBin ? 'Deleted files are removed for good after 30 days.' : summaryText,
  });
  const chromeSlotEl = usePaneChromePortalEl();

  // Ctrl+scroll over the canvas zooms the tiles.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return undefined;
    const onWheel = (e) => {
      if (!e.ctrlKey || !e.deltaY) return;
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
  // Case-insensitive, number-aware name sort ("file2" before "file10").
  const byName = (a, b) => (a.name || '').localeCompare(b.name || '', undefined, { numeric: true, sensitivity: 'base' });
  // One flat ordering (no Folders/Files category split): the Recycle bin
  // entry first, then folders A→Z, then files A→Z.
  const binFolders = useMemo(
    () => (folders || []).filter((f) => f.binEntry && matches(f.name)),
    [folders, q], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const shownFolders = useMemo(
    () => (folders || []).filter((f) => !f.binEntry && matches(f.name)).sort(byName),
    [folders, q], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const shownItems = useMemo(
    () => (items || []).filter((f) => matches(f.name)).sort(byName),
    [items, q], // eslint-disable-line react-hooks/exhaustive-deps
  );
  // Bin → folders → files, in render order. Drives both the grid/list and the
  // Shift-range selection axis.
  const displayFolders = useMemo(() => [...binFolders, ...shownFolders], [binFolders, shownFolders]);
  const totalShown = displayFolders.length + shownItems.length;

  const itemById = useMemo(() => {
    const m = new Map();
    for (const f of (folders || [])) m.set(f.id, f);
    for (const f of (items || [])) m.set(f.id, f);
    return m;
  }, [folders, items]);

  const multiSelItems = useMemo(
    () => [...multiSel].map((id) => itemById.get(id)).filter(Boolean),
    [multiSel, itemById],
  );

  // A single selection drives the Open / Rename / Properties affordances.
  const selectedItem = multiSel.size === 1 ? (itemById.get([...multiSel][0]) || null) : null;

  // Visible order (bin, folders, files) — the axis for Shift-range selection.
  const orderedIds = useMemo(
    () => [...displayFolders, ...shownItems].map((f) => f.id),
    [displayFolders, shownItems],
  );

  // Click selection. Modifiers compose like a native file explorer:
  //   • plain          → select just this item (click again to deselect)
  //   • Ctrl/Cmd+click → toggle this item in/out of the selection
  //   • Shift+click    → select the range from the anchor to this item
  //   • selectMode on  → plain clicks behave additively (toggle)
  const onSelect = (item, e) => {
    const id = item.id;
    const additive = (e && (e.ctrlKey || e.metaKey)) || selectMode;
    const range = Boolean(e && e.shiftKey);
    if (range && anchorId != null) {
      const a = orderedIds.indexOf(anchorId);
      const b = orderedIds.indexOf(id);
      if (a !== -1 && b !== -1) {
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        const slice = orderedIds.slice(lo, hi + 1);
        setMultiSel((prev) => {
          const base = (additive ? new Set(prev) : new Set());
          slice.forEach((x) => base.add(x));
          return base;
        });
        return;
      }
    }
    if (additive) {
      setMultiSel((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id); else next.add(id);
        return next;
      });
      setAnchorId(id);
      return;
    }
    // Plain click — single select; clicking the sole selection clears it.
    setMultiSel((prev) => (prev.size === 1 && prev.has(id) ? new Set() : new Set([id])));
    setAnchorId(id);
  };

  const clearSelection = () => { setMultiSel(new Set()); setAnchorId(null); };
  const exitSelectMode = () => { setSelectMode(false); clearSelection(); };
  const toggleSelectMode = () => {
    setSelectMode((on) => { if (on) clearSelection(); return !on; });
  };
  const bulkDelete = () => {
    multiSelItems.forEach((it) => onDelete?.(it));
    exitSelectMode();
  };

  // Common props every Tile/Row needs.
  const itemCommon = {
    tab,
    onSelect, onOpen,
    onRename: requestRename,
    onProperties: setPropsItem,
    onOpenLocation, onDelete, onRestore, onEmptyBin,
    canEdit: menuEditable,
    selectMode,
    bulkCount: multiSelItems.length,
    onBulkDelete: bulkDelete,
  };

  const emptyHint = {
    drafts: 'No files in your folder yet. Add or import files and they’ll show up here.',
    trash: 'Recently deleted is empty. Files you delete wait here for 30 days before they’re removed for good.',
  }[tab];

  // List view shows its column header INSIDE the window chrome (same bar/section
  // as the search), aligned with the full-bleed rows below — so it renders only
  // when the list is actually populated.
  const showListHead = view === 'list' && hasLocalFolder && !loading && (totalShown > 0 || creatingFolder);

  // Folder toolbar — nav + breadcrumb + search (+ the list column header in
  // list view). Rendered INTO the window chrome's row-2 slot when available
  // (one merged bar); falls back to an in-page pathbar row if there's no chrome.
  const toolbar = (
    <>
      <div className="fx-chrome-tools">
        <div className="fx-pathbar-nav">
          <button title="Back" onClick={() => onBack?.()} disabled={!canBack}><Icon name="chev-left" size={14} /></button>
          <button title="Forward" disabled><Icon name="chev-right" size={14} /></button>
          <button title="Up one level" onClick={() => onUp?.()} disabled={!canUp}><Icon name="chev-up" size={14} /></button>
        </div>
        <nav className="fx-crumbs" aria-label="Folder path">
          {(crumbs || []).map((cr, i) => {
            const isLast = i === crumbs.length - 1;
            return (
              <React.Fragment key={cr.path ?? i}>
                {i > 0 && <Icon name="chev-right" size={12} className="fx-crumb-sep" />}
                <button
                  type="button"
                  className={`fx-crumb${i === 0 ? ' is-root' : ''}${isLast ? ' is-current' : ''}`}
                  onClick={isLast ? undefined : () => onCrumb?.(cr.path)}
                  title={cr.label}
                >
                  {i === 0 && <Icon name="folder" size={13} className="fx-crumb-icon" />}
                  <span className="fx-crumb-label">{cr.label}</span>
                </button>
              </React.Fragment>
            );
          })}
        </nav>
        <div style={{ flex: 1 }} />
        <div className={`fx-search${query ? ' is-active' : ''}`}>
          <Icon name="search" size={15} className="fx-search-glyph" />
          <input
            ref={searchRef}
            placeholder="Search this folder"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape' && query) { e.stopPropagation(); setQuery(''); } }}
          />
          {query ? (
            <button
              type="button"
              className="fx-search-clear"
              title="Clear search"
              aria-label="Clear search"
              onClick={() => { setQuery(''); searchRef.current?.focus(); }}
            >
              <Icon name="close" size={13} strokeWidth={2} />
            </button>
          ) : (
            <span className="fx-search-kbd">
              <kbd>{isMacPlatform ? '⌘' : 'Ctrl'}</kbd>
              <span className="fx-search-kbd-plus">+</span>
              <kbd>F</kbd>
            </span>
          )}
        </div>
      </div>
      {showListHead && (
        <div className="fx-list-head fx-list-head--chrome">
          <div>Name</div><div>Date</div><div>Type</div><div>Size</div>
        </div>
      )}
    </>
  );

  return (
    <div className="fx-page" ref={pageRef}>
      {chromeSlotEl && createPortal(toolbar, chromeSlotEl)}
      <div className="fx-window">
        {!chromeSlotEl && <div className="fx-pathbar">{toolbar}</div>}

        {/* Canvas */}
        <div
          className={`fx-canvas${dragOver ? ' fx-canvas--drag' : ''}`}
          ref={canvasRef}
          style={{ '--fx-tile': `${tileSize}px` }}
          onClick={(e) => { if (e.target === e.currentTarget) clearSelection(); }}
          onContextMenu={menuEditable ? bgMorph.handleContextMenu : undefined}
          onDragEnter={onDropFiles ? (e) => { if (Array.from(e.dataTransfer?.types || []).includes('Files')) { e.preventDefault(); setDragOver(true); } } : undefined}
          onDragOver={onDropFiles ? (e) => { if (Array.from(e.dataTransfer?.types || []).includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; if (!dragOver) setDragOver(true); } } : undefined}
          onDragLeave={onDropFiles ? (e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDragOver(false); } : undefined}
          onDrop={onDropFiles ? (e) => { e.preventDefault(); setDragOver(false); const files = e.dataTransfer?.files; if (files && files.length) onDropFiles(files); } : undefined}
        >
          {dragOver && (
            <div className="fx-drop-overlay" aria-hidden="true">
              <div className="fx-drop-overlay-card">
                <Icon name="upload" size={28} strokeWidth={1.6} />
                <strong>Drop to copy here</strong>
                <span>Files are copied into this folder</span>
              </div>
            </div>
          )}
          {!hasLocalFolder ? (
            onPickFolder ? (
              // Web — no ambient project directory; the user grants a folder.
              <div className="fx-empty">
                <Icon name="folder" className="fx-icon" strokeWidth={1.2} />
                <h3>Connect a folder to start</h3>
                <p>Pick a folder on your computer — that’s where this project’s files live.</p>
                <button className="fx-btn-primary" onClick={() => onPickFolder?.()}><Icon name="folder" size={14} /> Choose folder</button>
              </div>
            ) : folderError ? (
              // Electron — resolving the project directory failed (most often
              // the main process needs a restart to pick up the handler).
              <div className="fx-empty">
                <Icon name="folder" className="fx-icon" strokeWidth={1.2} />
                <h3>Couldn’t open the project folder</h3>
                <p>{folderError} If you just updated the app, fully restart it.</p>
                {onRetryFolder && <button className="fx-btn-primary" onClick={() => onRetryFolder()}>Try again</button>}
              </div>
            ) : (
              // Electron — the project directory is resolving (auto-bound).
              <div className="fx-empty"><p>Setting up the project folder…</p></div>
            )
          ) : loading ? (
            <div className="fx-empty"><p>Loading…</p></div>
          ) : (totalShown === 0 && !creatingFolder) ? (
            <div className="fx-empty">
              <Icon name={isBin ? 'trash' : 'inbox'} className="fx-icon" strokeWidth={1.2} />
              <h3>{q ? 'No matches' : (isBin ? 'Nothing in the bin' : 'Nothing here yet')}</h3>
              <p>{q ? `No files match “${query}”.` : emptyHint}</p>
            </div>
          ) : view === 'tiles' ? (
            // One flat grid — no Folders/Files category heads. Order: the
            // Recycle bin first, the new-folder draft, then folders A→Z, then
            // files A→Z.
            <div className="fx-grid">
              {binFolders.map((f) => (
                <Tile key={f.id} item={f} selected={multiSel.has(f.id)} isMultiSelected={multiSel.has(f.id)} renaming={renamingId === f.id} onCommitName={(name) => commitRename(f, name)} onCancelName={cancelRename} {...itemCommon} />
              ))}
              {creatingFolder && <NewFolderTile onCommit={commitNewFolder} onCancel={cancelNewFolder} />}
              {shownFolders.map((f) => (
                <Tile key={f.id} item={f} selected={multiSel.has(f.id)} isMultiSelected={multiSel.has(f.id)} renaming={renamingId === f.id} onCommitName={(name) => commitRename(f, name)} onCancelName={cancelRename} {...itemCommon} />
              ))}
              {shownItems.map((f) => (
                <Tile key={f.id} item={f} selected={multiSel.has(f.id)} isMultiSelected={multiSel.has(f.id)} renaming={renamingId === f.id} onCommitName={(name) => commitRename(f, name)} onCancelName={cancelRename} {...itemCommon} />
              ))}
            </div>
          ) : (
            <div className="fx-list">
              {binFolders.map((f) => (
                <Row key={f.id} item={f} selected={multiSel.has(f.id)} isMultiSelected={multiSel.has(f.id)} renaming={renamingId === f.id} onCommitName={(name) => commitRename(f, name)} onCancelName={cancelRename} {...itemCommon} />
              ))}
              {creatingFolder && <NewFolderRow onCommit={commitNewFolder} onCancel={cancelNewFolder} />}
              {shownFolders.map((f) => (
                <Row key={f.id} item={f} selected={multiSel.has(f.id)} isMultiSelected={multiSel.has(f.id)} renaming={renamingId === f.id} onCommitName={(name) => commitRename(f, name)} onCancelName={cancelRename} {...itemCommon} />
              ))}
              {shownItems.map((f) => (
                <Row key={f.id} item={f} selected={multiSel.has(f.id)} isMultiSelected={multiSel.has(f.id)} renaming={renamingId === f.id} onCommitName={(name) => commitRename(f, name)} onCancelName={cancelRename} {...itemCommon} />
              ))}
            </div>
          )}
        </div>

        {/* Bottom action bar — file operations on the left, item count on the
            right. My drafts shows the full toolset; the bin shows
            Open / Restore / Delete-forever. */}
        <div className="fx-bottombar">
          <div className="fx-bottombar-actions">
            {(onUndo || onRedo) && (
              <>
                <button
                  className="fx-tb-btn fx-tb-icon"
                  title={canUndo ? `Undo ${undoLabel}` : 'Nothing to undo'}
                  disabled={!canUndo}
                  onClick={() => onUndo?.()}
                >
                  <Icon name="undo" className="fx-icon" />
                </button>
                <button
                  className="fx-tb-btn fx-tb-icon"
                  title={canRedo ? `Redo ${redoLabel}` : 'Nothing to redo'}
                  disabled={!canRedo}
                  onClick={() => onRedo?.()}
                >
                  <Icon name="redo" className="fx-icon" />
                </button>
                <div className="fx-tb-sep" />
              </>
            )}
            {!isBin ? (
              <>
                <div className="fx-menu-wrap" ref={newMenuRef}>
                  <button className="fx-tb-btn" disabled={!canEdit} onClick={() => setNewMenuOpen((v) => !v)}>
                    <Icon name="plus" className="fx-icon" />
                    <span>New</span>
                    <Icon name="chev-up" className="fx-caret" />
                  </button>
                  {newMenuOpen && (
                    <div className="fx-menu is-up" role="menu">
                      <button onClick={() => { setNewMenuOpen(false); requestNewFolder(); }}>
                        <Icon name="folder-plus" className="fx-icon" /> New folder
                      </button>
                      <button onClick={() => { setNewMenuOpen(false); onUpload?.(); }}>
                        <Icon name="upload" className="fx-icon" /> Add files…
                      </button>
                      <button onClick={() => { setNewMenuOpen(false); onUploadFolder?.(); }}>
                        <Icon name="folder" className="fx-icon" /> Add folder…
                      </button>
                    </div>
                  )}
                </div>
                <button className="fx-tb-btn" disabled={!canEdit} onClick={() => onUpload?.()}>
                  <Icon name="upload" className="fx-icon" /><span>Import</span>
                </button>
                <div className="fx-tb-sep" />
                <button className="fx-tb-btn" disabled={!selectedItem} onClick={() => selectedItem && onOpen?.(selectedItem)}>
                  <Icon name="open" className="fx-icon" /><span>Open</span>
                </button>
                <button className="fx-tb-btn" disabled={!selectedItem || !canEdit} onClick={() => selectedItem && requestRename(selectedItem)}>
                  <Icon name="edit-pen" className="fx-icon" /><span>Rename</span>
                </button>
                <button
                  className="fx-tb-btn"
                  disabled={!canEdit || multiSelItems.length === 0}
                  onClick={() => bulkDelete()}
                >
                  <Icon name="trash" className="fx-icon" />
                  <span>Delete{multiSelItems.length > 1 ? ` (${multiSelItems.length})` : ''}</span>
                </button>
              </>
            ) : (
              <>
                <button className="fx-tb-btn" disabled={!selectedItem} onClick={() => selectedItem && onOpen?.(selectedItem)}>
                  <Icon name="open" className="fx-icon" /><span>Open</span>
                </button>
                <button
                  className="fx-tb-btn"
                  disabled={multiSelItems.length === 0}
                  onClick={() => { multiSelItems.forEach((it) => onRestore?.(it)); exitSelectMode(); }}
                >
                  <Icon name="restore" className="fx-icon" /><span>Restore{multiSelItems.length > 1 ? ` (${multiSelItems.length})` : ''}</span>
                </button>
                <button
                  className="fx-tb-btn"
                  disabled={multiSelItems.length === 0}
                  onClick={() => bulkDelete()}
                >
                  <Icon name="trash" className="fx-icon" />
                  <span>Delete forever{multiSelItems.length > 1 ? ` (${multiSelItems.length})` : ''}</span>
                </button>
              </>
            )}
            <div className="fx-tb-sep" />
            <button
              className={`fx-tb-btn${selectMode ? ' is-active' : ''}`}
              onClick={toggleSelectMode}
              aria-pressed={selectMode}
            >
              <Icon name="select" className="fx-icon" /><span>{selectMode ? 'Done' : 'Select'}</span>
            </button>
          </div>
          <div className="fx-bottombar-status">
            <span>{totalShown} {totalShown === 1 ? 'item' : 'items'}</span>
            {multiSel.size > 0 && <span>· {multiSel.size} selected</span>}
          </div>
        </div>

        {/* Background right-click menu (Import / New folder) — portalled. */}
        {bgMorph.node}
      </div>

      {propsItem && <PropertiesModal item={propsItem} onClose={() => setPropsItem(null)} />}
    </div>
  );
}

// ── Properties dialog ──────────────────────────────────────────────────
// Read-only inspector for a single file / folder, built from the item model
// the workspace already has (no extra fetch).
function PropertiesModal({ item, onClose }) {
  const isFolder = item.kind === 'folder';
  const typeLabel = isFolder
    ? 'Folder'
    : (item.ext ? `${item.ext.toUpperCase()} file` : 'File');
  const location = isFolder
    ? (item._dir?.path || item.path || '')
    : (item._raw?.path || '');
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
