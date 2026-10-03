import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import FileThumbnail from './FileThumbnail';
import { ExtGlyph, extCategory } from './fileGlyph';
import Tooltip from './Tooltip';
import { useMorphPill } from './useMorphPill';
import { usePaneChromeSlot, usePaneChromePortalEl } from '../context/PaneChromeContext';
import { useAuth } from '../context/AuthContext';
import { setDraggedFiles, clearDraggedFiles, getDraggedFiles } from '../lib/fileDragBus';
import { toLayoutPx } from '../lib/appZoom';
import { isSearchableFile, searchContents } from '../lib/fileContentSearch';
import { aiSearchFiles } from '../lib/aiFileSearch';
import { FOLDER_COLOR_PRESETS, loadFolderColors, persistFolderColors } from '../lib/folderColors';
import { useMiniGlowSpot } from '../lib/pointerSpots';
import { registerHoverSpot } from '../lib/pointer';
import MiniHeaderFade from './MiniHeaderFade';
import { BarPicker } from './LegalBar';
import { openedAt, markOpened, subscribeOpened } from '../lib/recentFiles';
import { prepareDocViewerFile } from '../lib/platform';
import './LegalBar.css';
import './FilesWorkspace.css';

// Platform hint for the search shortcut chip (⌘F on macOS, Ctrl F elsewhere).
const isMacPlatform = typeof navigator !== 'undefined' && /Mac|iP(hone|ad|od)/.test(navigator.platform || '');

// ── Dropped-folder traversal ───────────────────────────────────────────
// A plain `dataTransfer.files` read can't see inside a dropped folder — a
// directory only expands through the webkitGetAsEntry() FileSystem API.
// These helpers walk every dropped entry (files AND directory trees) and
// return a flat list of { file, relPath } so folder drops import with their
// nested structure intact (matching the <input webkitdirectory> path).
function readEntryFile(entry) {
  return new Promise((resolve) => entry.file((f) => resolve(f), () => resolve(null)));
}
function readAllDirEntries(reader) {
  // readEntries() yields at most ~100 entries per call — pump until empty.
  return new Promise((resolve) => {
    const all = [];
    const pump = () => reader.readEntries(
      (batch) => { if (!batch.length) { resolve(all); return; } all.push(...batch); pump(); },
      () => resolve(all),
    );
    pump();
  });
}
async function walkEntry(entry, prefix, out) {
  if (!entry) return;
  if (entry.isFile) {
    const f = await readEntryFile(entry);
    if (f) out.push({ file: f, relPath: prefix ? `${prefix}/${f.name}` : f.name });
  } else if (entry.isDirectory) {
    const dirPrefix = prefix ? `${prefix}/${entry.name}` : entry.name;
    const children = await readAllDirEntries(entry.createReader());
    for (const child of children) await walkEntry(child, dirPrefix, out);
  }
}
// Resolve a drop's DataTransfer into [{ file, relPath }]. The entry objects
// must be grabbed synchronously (the item list is invalid after the event),
// so collect them up front, then traverse asynchronously.
async function collectDropEntries(dataTransfer) {
  const out = [];
  const items = dataTransfer?.items;
  if (items && items.length && typeof items[0]?.webkitGetAsEntry === 'function') {
    const entries = [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].kind !== 'file') continue;
      const entry = items[i].webkitGetAsEntry();
      if (entry) entries.push(entry);
    }
    if (entries.length) {
      for (const entry of entries) await walkEntry(entry, '', out);
      return out;
    }
  }
  // Fallback (no entry API): plain files only — folders are unreadable here.
  const files = dataTransfer?.files;
  if (files) for (const f of files) out.push({ file: f, relPath: f.name });
  return out;
}

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
// Exported so surfaces that borrow the Files chrome — the Doc Viewer's
// fill-from-a-picture picker — draw from the SAME glyph set. A second copy
// would drift on the first icon either side changed.
export function Icon({ name, size = 16, strokeWidth = 1.8, className = '', filled = false }) {
  const p = {
    width: size, height: size, viewBox: '0 0 24 24', fill: filled ? 'currentColor' : 'none',
    stroke: 'currentColor', strokeWidth, strokeLinecap: 'round',
    strokeLinejoin: 'round', className, 'aria-hidden': 'true',
  };
  switch (name) {
    // A party to the case — used by "Add identity".
    case 'identity':
      return (
        <svg {...p}>
          <circle cx="12" cy="8" r="3.4" />
          <path d="M5.5 19.5a6.5 6.5 0 0 1 13 0" />
        </svg>
      );
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
    case 'copy': return <svg {...p}><rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>;
    case 'paste': return <svg {...p}><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" /><rect x="8" y="2" width="8" height="4" rx="1" ry="1" /></svg>;
    case 'cut': return <svg {...p}><circle cx="6" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><line x1="20" y1="4" x2="8.12" y2="15.88" /><line x1="14.47" y1="14.48" x2="20" y2="20" /><line x1="8.12" y1="8.12" x2="12" y2="12" /></svg>;
    case 'refresh': return <svg {...p}><polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" /><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" /></svg>;
    case 'sparkles': return <svg {...p}><path d="M12 3l1.7 4.6L18 9l-4.3 1.4L12 15l-1.7-4.6L6 9l4.3-1.4z" /><path d="M5 15l.9 2.3L8 18l-2.1.7L5 21l-.9-2.3L2 18l2.1-.7z" /></svg>;
    case 'file-doc': return <svg {...p}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="8" y1="9" x2="10" y2="9" /><line x1="8" y1="13" x2="16" y2="13" /><line x1="8" y1="17" x2="16" y2="17" /></svg>;
    case 'file-slides': return <svg {...p}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><rect x="8" y="12" width="8" height="5" rx="1" /></svg>;
    case 'file-sheet': return <svg {...p}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="8" y1="12" x2="16" y2="12" /><line x1="8" y1="16" x2="16" y2="16" /><line x1="12" y1="11" x2="12" y2="17" /></svg>;
    case 'file-pdf': return <svg {...p}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><path d="M8.5 13.5h1a1 1 0 0 0 0-2h-1z" /><path d="M8.5 11.5v4" /><path d="M12.5 11.5v4h1a1.2 1.2 0 0 0 1.2-1.2v-1.6a1.2 1.2 0 0 0-1.2-1.2z" /></svg>;
    case 'categories': return <svg {...p}><rect x="3" y="3" width="18" height="6" rx="1.5" /><rect x="3" y="13" width="18" height="6" rx="1.5" /></svg>;
    case 'grid': return <svg {...p}><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></svg>;
    case 'list': return <svg {...p}><line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" /><line x1="3" y1="6" x2="3.01" y2="6" /><line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" /></svg>;
    case 'image': return <svg {...p}><rect x="3" y="3" width="18" height="18" rx="2" ry="2" /><circle cx="8.5" cy="8.5" r="1.5" /><polyline points="21 15 16 10 5 21" /></svg>;
    default: return null;
  }
}

// Folder icon. `filled` paints a solid folder — used when the folder has
// contents; the outline variant marks an empty folder at a glance.
function FolderGlyph({ filled = false, size = 42, color }) {
  return (
    <svg
      className={`fx-folder-glyph${filled ? ' is-filled' : ''}`}
      width={size} height={size} viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor" strokeWidth={filled ? 1 : 1.4}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
      // A picked folder colour overrides the accent the CSS paints by default.
      style={color ? { color } : undefined}
    >
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}

// A FILLED trash can — shown for the Recycle bin entry when it holds at least
// one file, so a glance reads "the bin has something in it". The empty bin uses
// the outline trash icon instead.
function FullBinGlyph({ size = 42 }) {
  return (
    <svg className="fx-bin-full" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      {/* handle */}
      <path d="M9.5 5V4.4A1.4 1.4 0 0 1 10.9 3h2.2A1.4 1.4 0 0 1 14.5 4.4V5"
        fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      {/* lid */}
      <rect x="3.4" y="5.2" width="17.2" height="2.1" rx="1.05" fill="currentColor" />
      {/* filled can body */}
      <path d="M5.6 8.4h12.8l-0.9 11.1A2 2 0 0 1 15.5 21.4H8.5a2 2 0 0 1-2-1.9z" fill="currentColor" />
    </svg>
  );
}

// Glyph for a folder-kind item: the Recycle bin entry gets the trash icon —
// FILLED when it holds files, outline when empty; a folder probed as a
// WhatsApp export (it CONTAINS a chat transcript — see isWhatsAppExport) gets
// the WhatsApp mark like the export zips do; every other folder gets the
// folder glyph (optionally a custom colour).
// Exported alongside ItemThumbnail: a surface borrowing the Files tiles needs
// the folder glyph too, or its folders come out as generic documents.
export function FolderOrBinGlyph({ item, size = 42, color }) {
  if (item.binEntry) {
    const s = Math.round(size * 0.92);
    const full = item.binCount > 0;
    return (
      <span className={`fx-bin-glyph${full ? ' is-full' : ''}`}>
        {full ? <FullBinGlyph size={s} /> : <Icon name="trash" size={s} strokeWidth={1.6} />}
      </span>
    );
  }
  if (item.isWhatsApp) {
    return (
      <WithWhatsAppBadge>
        <FolderGlyph filled={!item.empty} size={size} color={color} />
      </WithWhatsAppBadge>
    );
  }
  return <FolderGlyph filled={!item.empty} size={size} color={color} />;
}

// Swatch row shown at the top of a folder's right-click menu — pick a colour
// for the folder icon (or "Default" to clear it).
function FolderColorRow({ current, onPick }) {
  const active = current || null;
  return (
    <div className="fx-color-row" role="group" aria-label="Folder colour">
      {FOLDER_COLOR_PRESETS.map((c) => (
        <Tooltip key={c.id} content={c.label}>
          <button
            type="button"
            className={`fx-color-swatch${active === c.value ? ' is-active' : ''}${c.value ? '' : ' is-default'}`}
            style={c.value ? { '--sw': c.value } : undefined}
            aria-label={c.label}
            aria-pressed={active === c.value}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); onPick(c.value); }}
          >
            {c.value ? null : <Icon name="close" size={12} strokeWidth={2} />}
          </button>
        </Tooltip>
      ))}
    </div>
  );
}

// Right-click menu header for a recognised WhatsApp export (and the folder
// colour-swatch row when it's an editable folder). Returns undefined when
// neither applies, so the menu has no header.
function whatsappMenuHeader(item, isFolder, canEdit, folderColor, onSetColor) {
  // Only the zip/loose-file exports get the WhatsApp header — never folders.
  const isWa = isWhatsAppExport(item) && !isFolder;
  const showColors = isFolder && !item.binEntry && canEdit;
  if (!isWa && !showColors) return undefined;
  return (closeMenu) => (
    <>
      {isWa && (
        <div className="fx-wa-menu-head">
          <span className="fx-wa-menu-head-mark">{WhatsAppMark}</span>
          <span className="fx-wa-menu-head-text">
            <span className="fx-wa-menu-head-title">WhatsApp chat export</span>
            <span className="fx-wa-menu-head-sub">Open to read the conversation</span>
          </span>
        </div>
      )}
      {showColors && (
        <FolderColorRow current={folderColor} onPick={(v) => { onSetColor?.(item.id, v); closeMenu(); }} />
      )}
    </>
  );
}

const STATUS_LABEL = { deleted: 'In bin', synced: '' };

// Tile-zoom bounds (px, the grid's min column width). Below the threshold
// the tile grid gives way to the list view. The threshold is also the
// DEFAULT tile size — i.e. tiles start at the smallest size before the list
// view kicks in, and Ctrl+scroll zooms up from there.
// Slider floor. Raised one step (was 68) to drop the smallest/most-cramped
// notch from the icon-size slider.
const FX_MIN_TILE = 70;
const FX_MAX_TILE = 320;
// Below this the tile grid gives way to the list view. Raised by 2 slider steps
// (4px) so the list view spans two extra notches at its large end (see
// listRowVars — those top steps grow the rows more aggressively).
const FX_LIST_THRESHOLD = 100;

// Toolbar "Categorize" view — when on, items are grouped into these coarse
// buckets, each rendered as its own labelled section (in this order). Keep in
// sync with `itemCat` in FilesWorkspace. Sections with no items are skipped.
const FX_GROUPS = [
  { key: 'trash', label: 'Trash', icon: 'trash' },
  { key: 'folders', label: 'Folders & compressed folders', icon: 'folder' },
  { key: 'media', label: 'Media', icon: 'image' },
  { key: 'office', label: 'Office documents', icon: 'file-doc' },
  { key: 'other', label: 'Other files', icon: 'inbox' },
];

// extCategory + ExtGlyph moved to fileGlyph.jsx — they're the app's ONE
// file-icon style now, shared with the sidebar / Activity / project list via
// glyphForFile(). Imported at the top of this file.

// A WhatsApp "Export chat" produces a .zip — or, extracted, a folder —
// holding the transcript + media. ProjectFiles probes the CONTENTS in the
// main process and stamps `item.isWhatsApp` (true/false), so recognition
// survives a rename. Items that can't be probed (cloud rows, a probe
// still in flight) leave the flag undefined and fall back to the old
// filename heuristic.
function isWhatsAppExport(item) {
  if (item?.isWhatsApp !== undefined) return item.isWhatsApp === true;
  return item?.ext === 'zip' && /whatsapp/i.test(item?.name || '');
}

const WhatsAppMark = (
  <svg className="fx-glyph-wa-logo" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M12 2a10 10 0 0 0-8.6 15l-1.3 4.8 4.9-1.3A10 10 0 1 0 12 2zm0 18.2a8.2 8.2 0 0 1-4.2-1.2l-.3-.2-2.9.8.8-2.8-.2-.3A8.2 8.2 0 1 1 12 20.2zm4.6-6.1c-.3-.1-1.5-.7-1.7-.8s-.4-.1-.6.1-.7.8-.8 1-.3.2-.5.1a6.7 6.7 0 0 1-2-1.2 7.4 7.4 0 0 1-1.4-1.7c-.1-.3 0-.4.1-.5l.4-.5.3-.4v-.4l-.8-1.9c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 2.9 2.9 0 0 0-.9 2.2 5 5 0 0 0 1.1 2.7 11.5 11.5 0 0 0 4.4 3.9c2.6 1 2.6.7 3.1.6a2.6 2.6 0 0 0 1.7-1.2 2.1 2.1 0 0 0 .1-1.2c-.1-.1-.3-.2-.5-.3z" />
  </svg>
);

// Recognised WhatsApp conversation (a .zip export, a loose exported .txt, …) —
// shows ONLY the WhatsApp logo on its brand green (no zip/type icon, no morph),
// so the file reads as a WhatsApp conversation at a glance. See .fx-glyph-whatsapp.
function WhatsAppMorphGlyph() {
  return (
    <span className="fx-glyph fx-glyph-icon fx-glyph-whatsapp">
      {WhatsAppMark}
    </span>
  );
}

// Previously wrapped a recognised WhatsApp file/folder glyph with a persistent
// green corner pill. The pill was removed per request — recognition still drives
// the hover tooltip, right-click header, and "open conversation" action, but the
// glyph itself is no longer marked. Kept as a pass-through so the call sites
// (file + folder glyphs) don't need to branch.
function WithWhatsAppBadge({ children }) {
  return <>{children}</>;
}

// Resolve a file's fallback glyph: the WhatsApp mark for recognised export
// zips, otherwise the extension badge. Exported — the doc-viewer's open-files
// sidebar renders its tiles with the same glyph so both surfaces match.
export function ItemGlyph({ item }) {
  // Anything recognised as a WhatsApp conversation (a .zip export, a loose
  // exported .txt, etc.) uses the same vertical-push glyph: a zipped folder at
  // rest that slides up on hover to reveal the WhatsApp logo from below.
  if (isWhatsAppExport(item)) return <WhatsAppMorphGlyph />;
  return <ExtGlyph ext={item.ext} />;
}

// Real file thumbnail (poster / video slideshow / type glyph). Video files get
// a centred play button layered over the poster so they read as playable at a
// glance — in both tile and list views (it's %-sized off the thumb). The badge
// is CSS-hidden when no real poster resolved (the type-glyph badge — which
// already shows its own play triangle — is showing). See .fx-video-play in
// FilesWorkspace.css.
// Word / Excel / PowerPoint / PDF → the brand colour of the stripe drawn down
// the left edge of the file's preview (Office: fileGlyph's OFFICE_SPECS
// colours; PDF: a muted brick red — Acrobat's own #E1251B shouted), so a rendered page still says what it is.
const OFFICE_STRIPE = { doc: '#185ABD', xls: '#107C41', ppt: '#C43E1C', pdf: '#B5473F' };
export function officeStripe(item) {
  if (!item || item.kind === 'folder' || item.binEntry) return undefined;
  const c = OFFICE_STRIPE[extCategory(item.ext)];
  return c ? { '--fx-office': c } : undefined;
}

export function ItemThumbnail({ item }) {
  const isVideo = extCategory(item.ext) === 'vid';
  return (
    <>
      <FileThumbnail descriptor={item.descriptor} glyph={<ItemGlyph item={item} />} />
      {/* Extension pill — CSS reveals it only when the tile fell back to the
          GENERIC document glyph (no thumbnail and no type icon of its own), so
          an unknown format still says what it is. */}
      {item.ext ? <span className="fx-ext-pill" aria-hidden="true">{String(item.ext).toUpperCase()}</span> : null}
      {isVideo ? (
        <span className="fx-video-play" aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <path d="M8 5.14v13.72a1 1 0 0 0 1.53.85l10.78-6.86a1 1 0 0 0 0-1.7L9.53 4.29A1 1 0 0 0 8 5.14z" fill="currentColor" />
          </svg>
        </span>
      ) : null}
    </>
  );
}

// Countdown pill for a bin item — "Deletes in N days" (turns red near the
// end of the 30-day retention). Driven by item.deletesInDays.
function CountdownPill({ days, className = '' }) {
  if (days === null || days === undefined) return null;
  const label = days <= 0 ? 'Deletes today' : `Deletes in ${days} ${days === 1 ? 'day' : 'days'}`;
  const urgent = days <= 3;
  return (
    <Tooltip content={label}>
      <span className={`fx-countdown-pill${urgent ? ' is-urgent' : ''} ${className}`.trim()}>
        <Icon name="clock" size={11} />
        <span>{label}</span>
      </span>
    </Tooltip>
  );
}

// Circular progress for a trashed item: the ring fills with ELAPSED time over
// the 30-day retention, with the days-left number in the centre. Turns red in
// the final stretch. Driven by item.deletesInDays.
function CountdownRing({ days, total = 30, size = 34, className = '' }) {
  if (days === null || days === undefined) return null;
  const left = Math.max(0, days);
  const elapsed = Math.min(1, Math.max(0, (total - left) / total));
  const urgent = left <= 3;
  const stroke = 3;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <span className={`fx-countdown-ring${urgent ? ' is-urgent' : ''} ${className}`.trim()} style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--border)" strokeWidth={stroke} />
        <circle
          cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeWidth={stroke}
          strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - elapsed)}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
    </span>
  );
}

// Short "time remaining" label for a trashed item.
function countdownLabel(days) {
  if (days === null || days === undefined) return '';
  if (days <= 0) return 'Deletes today';
  return `${days} ${days === 1 ? 'day' : 'days'} left`;
}

// Hover-tooltip content for a trashed item: a time-remaining chip (bg matches
// the urgency of the countdown ring) followed by the file name.
function trashHoverContent(item) {
  const days = item.deletesInDays;
  const urgent = (days ?? 99) <= 3;
  return (
    <span className="fx-hover-rich">
      <span className={`fx-hover-countdown${urgent ? ' is-urgent' : ''}`}>{countdownLabel(days)}</span>
      <span className="fx-hover-name">{item.name}</span>
    </span>
  );
}

// (The rich WhatsApp hover pill — badge + "recognised as WhatsApp convo"
// note — was removed; WhatsApp files show the standard name pill like every
// other file. The right-click MENU header keeps its WhatsApp treatment via
// whatsappMenuHeader.)

// Right-click menu for a file / folder item. Tab-aware: in the bin, items
// offer Restore + Delete forever; in drafts, the usual Open / Rename /
// Properties / Open-file-location / Delete. Falsy entries collapse via
// useMorphPill's filter.
function itemMenuItems(item, { tab, onOpen, onOpenContent, onRename, onProperties, onOpenLocation, onDelete, onRestore, onEmptyBin, canEdit, selectMode, isMultiSelected, bulkCount, onBulkDelete, onCopy, onCut, onIncoming, incomingCount = 0 }) {
  // A file a phone sent that is WAITING to be let in (ProjectFiles
  // incomingItems): its own decisions, and nothing that would treat it as a
  // project file before it is one.
  if (item.incoming) {
    return [
      { key: 'accept', label: 'Accept — add to this folder', onClick: () => onIncoming?.(item, 'accept') },
      {
        key: 'reject',
        label: 'Reject',
        danger: true,
        onClick: () => onIncoming?.(item, 'reject'),
        confirm: {
          count: 1,
          subtitle: 'Not added to the project',
          title: 'Reject this file?',
          message: `“${item.name}” will be deleted from this computer. Your phone still has it.`,
          confirmLabel: 'Reject',
          cancelLabel: 'Cancel',
        },
      },
      { key: 'props', label: 'Properties', onClick: () => onProperties?.(item) },
    ];
  }
  // The Recycle bin entry opens the bin; when it holds files it can also be
  // emptied (permanent delete of everything inside).
  if (item.binEntry) {
    // The Trash entry's menu is intentionally just two actions: open it, or
    // empty it (the latter only when it actually holds something).
    const entries = [{ key: 'open', label: 'Open', onClick: () => onOpen?.(item) }];
    if (item.binCount > 0) {
      entries.push({
        key: 'empty',
        label: 'Empty',
        danger: true,
        onClick: () => onEmptyBin?.(),
        confirm: {
          count: item.binCount,
          subtitle: 'Permanent · can’t be undone',
          title: `Delete ${item.binCount} file${item.binCount === 1 ? '' : 's'}?`,
          message: `${item.binCount} item${item.binCount === 1 ? '' : 's'} in the trash will be permanently deleted — this can’t be undone.`,
          confirmLabel: 'Empty trash',
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
          count: bulk ? bulkCount : 1,
          subtitle: 'Permanent · can’t be undone',
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
    // No confirmation: a delete only moves to the Trash (recoverable for 30
    // days, and undoable). Only emptying the Trash asks first.
    onClick: () => (bulk ? onBulkDelete?.() : onDelete?.(item)),
  };

  if (isFolder) {
    return [
      { key: 'open', label: 'Open', onClick: () => onOpen?.(item) },
      // "Open" now browses any folder; a WhatsApp export's reconstructed
      // conversation moves to this dedicated entry.
      item.isWhatsApp && { key: 'open-content', label: 'Open conversation', onClick: () => onOpenContent?.(item) },
      !bulk && canEdit && localPath && { key: 'rename', label: 'Rename', onClick: () => onRename?.(item) },
      localPath && { key: 'loc', label: 'Open file location', onClick: () => onOpenLocation?.(item) },
      deleteEntry,
    ];
  }
  const isArchive = extCategory(item.ext) === 'zip';
  return [
    { key: 'open',   label: 'Open',               onClick: () => onOpen?.(item) },
    // A compressed file can be unpacked and browsed in place (zip extracts to a
    // sibling folder; other formats open in the OS archiver).
    isArchive && { key: 'open-content', label: 'Extract contents', onClick: () => onOpenContent?.(item) },
    !bulk && canEdit && { key: 'rename', label: 'Rename',  onClick: () => onRename?.(item) },
    canEdit && onCopy && { key: 'copy', label: bulk ? `Copy ${bulkCount} items` : 'Copy', onClick: () => onCopy?.(item) },
    canEdit && onCut && { key: 'cut', label: bulk ? `Cut ${bulkCount} items` : 'Cut', onClick: () => onCut?.(item) },
    { key: 'props',  label: 'Properties',         onClick: () => onProperties?.(item) },
    localPath && { key: 'loc', label: 'Open file location', onClick: () => onOpenLocation?.(item) },
    deleteEntry,
  ];
}

// Files show their name like Explorer's "hide extensions" mode: the label under
// the icon is just the base name, and a rename edits only the base — the
// extension is re-attached on commit so the file format is never changed by
// accident. Folders have no extension. `ext` keeps its leading dot.
function splitNameExt(name) {
  const n = String(name || '');
  const i = n.lastIndexOf('.');
  // No dot, a leading-dot dotfile (".gitignore"), or a trailing dot → no ext.
  if (i <= 0 || i === n.length - 1) return { base: n, ext: '' };
  return { base: n.slice(0, i), ext: n.slice(i) };
}
function displayBaseName(item) {
  if (!item || item.kind === 'folder') return item?.name || '';
  return splitNameExt(item.name).base || item.name;
}
// The name as shown on a tile / row: the base name, then the extension in a
// quieter span (the rename field still edits only the base — see renamedName).
function DisplayName({ item }) {
  const base = displayBaseName(item);
  if (!item || item.kind === 'folder' || item.binEntry) return base;
  const { ext } = splitNameExt(item.name);
  return <>{base}{ext && <span className="fx-name-ext">{ext}</span>}</>;
}
function joinBaseExt(base, originalName) {
  const { ext } = splitNameExt(originalName);
  const b = String(base || '').trim();
  if (!ext) return b;
  return b.toLowerCase().endsWith(ext.toLowerCase()) ? b : b + ext;
}
// The new name to commit from a rename input — folders pass through, files get
// their original extension re-attached.
function renamedName(item, typed) {
  return item.kind === 'folder' ? typed : joinBaseExt(typed, item.name);
}

// ── Inline name input (rename + new-folder draft) ─────────────────────
function InlineNameInput({ initial = '', placeholder, onCommit, onCancel, className = '', selectBaseName = false }) {
  const [value, setValue] = useState(initial);
  const ref = useRef(null);
  const doneRef = useRef(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    // For a named file, pre-select just the base name (before the extension) so
    // typing replaces the name but keeps the ".docx" the user chose.
    const dot = selectBaseName ? initial.lastIndexOf('.') : -1;
    if (dot > 0) el.setSelectionRange(0, dot);
    else el.select();
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

// The download mark on a waiting phone file — a click lets it in.
function IncomingMark() {
  return (
    <span className="fx-incoming-mark" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M12 4v11" /><path d="m7 10 5 5 5-5" /><path d="M5 20h14" /></svg>
    </span>
  );
}

// A file tile to the letter of the Files tab's, for other surfaces (the Import
// window's arrivals): the same markup and classes, the thumbnail and the name,
// without the menus, selection or drag. `children` rides in the thumb (a
// progress ring, a mark). Put it in an `.fx-grid` for the Files tab's layout.
export function FileTile({ item, className = '', onClick, onDoubleClick, children }) {
  return (
    <button type="button" className={`fx-tile${className ? ` ${className}` : ''}`} onClick={onClick} onDoubleClick={onDoubleClick}>
      <span className="fx-tile-thumb" data-office={officeStripe(item) ? '' : undefined} style={officeStripe(item)}>
        <ItemThumbnail item={item} />
        {children}
      </span>
      <span>
        <span className="fx-tile-name"><DisplayName item={item} /></span>
      </span>
    </button>
  );
}

// ── Tile ──────────────────────────────────────────────────────────────
// The EXTRACTED-TEXT mark: the file's text has been read out of it (a
// picture's or a scan's text, a recording's captions) and is kept.
function TextMark() {
  return (
    <span className="fx-text-mark" aria-label="Has extracted text">
      <svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
        <path d="M3.5 4h9M8 4v8.5M5.5 12.5h5" />
      </svg>
    </span>
  );
}

// The AI-AT-WORK mark: a spinning ring in the thumbnail's bottom-RIGHT corner
// while the AI is writing this file (main.js docViewerState `busy`) — also
// when the viewer was closed meanwhile, since the work goes on in the
// background and this is the only place that shows it.
function AiBusyMark() {
  return (
    <span className="fx-ai-busy" role="status" aria-label="The AI is writing this file">
      <span className="fx-ai-busy-spin" aria-hidden="true" />
    </span>
  );
}

// PORTRAIT PHOTOS get a taller thumbnail: the box's height/width follows the
// picture's own shape, CLAMPED between the tile's usual landscape proportion
// (0.58 — the minimum, so landscape tiles are unchanged) and 4:3 portrait (a
// phone photo shown whole; anything taller, a screenshot, is fitted inside).
// Read off the thumbnail as it loads (it keeps the picture's orientation), and
// remembered per file so a tile scrolled out and back doesn't jump.
const THUMB_AR_MIN = 0.58;
const THUMB_AR_MAX = 4 / 3;
const thumbAspects = new Map();   // item id → clamped height / width
export function usePhotoAspect(item) {
  const isPhoto = item.kind === 'file' && extCategory(item.ext) === 'img';
  const key = item.id;
  const ref = useRef(null);
  const [ar, setAr] = useState(() => (isPhoto ? thumbAspects.get(key) : undefined));
  useEffect(() => {
    const el = ref.current;
    if (!el || !isPhoto) return undefined;
    const read = (img) => {
      if (!img || img.tagName !== 'IMG' || !img.naturalWidth || !img.naturalHeight) return;
      const r = Math.round(Math.min(THUMB_AR_MAX, Math.max(THUMB_AR_MIN, img.naturalHeight / img.naturalWidth)) * 1000) / 1000;
      thumbAspects.set(key, r);
      setAr((prev) => (prev === r ? prev : r));
    };
    const onLoad = (e) => read(e.target);
    // Load events don't bubble, but they do pass through their ancestors'
    // capture phase — one listener on the box hears whichever <img> the
    // thumbnail engine ends up drawing.
    el.addEventListener('load', onLoad, true);
    const img = el.querySelector('img');
    if (img?.complete) read(img);
    return () => el.removeEventListener('load', onLoad, true);
  }, [key, isPhoto]);
  return { ref, style: ar ? { '--fx-thumb-ar': ar } : null };
}

const Tile = React.memo(function Tile({ item, tab, selected, onSelect, onOpen, onOpenContent, onRename, onProperties, onOpenLocation, onDelete, onRestore, onEmptyBin, canEdit, selectMode, isMultiSelected, bulkCount, onBulkDelete, onCopy, onCut, onIncoming, incomingCount, renaming, onCommitName, onCancelName, draggable, beginItemDrag, endItemDrag, onFolderDragOver, onFolderDragLeave, onFolderDrop, dropFolderId, cutPaths, folderColors, onSetColor }) {
  const isFolder = item.kind === 'folder';
  const status = item.status || 'synced';
  const isDropTarget = isFolder && dropFolderId === item.id;
  const isBinDrop = item.binEntry && isDropTarget;
  const isCut = !isFolder && cutPaths?.has(item._raw?.path);
  const folderColor = isFolder && !item.binEntry ? folderColors?.[item.id] : undefined;
  const aspect = usePhotoAspect(item);
  const morph = useMorphPill({
    // WhatsApp files use the SAME plain name pill as every other file (the
    // old rich "recognised as WhatsApp convo" hover pill was removed).
    hoverContent: item.incoming ? `${item.name} — from your phone. Click to add it` : tab === 'trash' && !item.binEntry ? trashHoverContent(item) : item.name,
    menuItems: itemMenuItems(item, { tab, onOpen, onOpenContent, onRename, onProperties, onOpenLocation, onDelete, onRestore, onEmptyBin, canEdit, selectMode, isMultiSelected, bulkCount, onBulkDelete, onCopy: isFolder ? null : onCopy, onCut: isFolder ? null : onCut, onIncoming, incomingCount }),
    // WhatsApp exports get a "recognised as WhatsApp convo" header; folders get
    // a colour-swatch row atop their menu (both shown if it's a WhatsApp folder).
    menuHeader: whatsappMenuHeader(item, isFolder, canEdit, folderColor, onSetColor),
  });
  if (renaming) {
    return (
      <div className={`fx-tile${isFolder ? ' is-folder' : ''} is-renaming`}>
        <span className="fx-tile-thumb" data-office={officeStripe(item) ? "" : undefined} style={officeStripe(item)}>
          {isFolder ? <FolderOrBinGlyph item={item} color={folderColor} /> : <ItemThumbnail item={item} />}
        </span>
        <span>
          <InlineNameInput className="fx-tile-name" initial={displayBaseName(item)} onCommit={(name) => onCommitName(renamedName(item, name))} onCancel={onCancelName} />
        </span>
      </div>
    );
  }
  return (
    <>
      <button
        type="button"
        data-fx-id={item.id}
        className={`fx-tile${isFolder ? ' is-folder' : ''}${selected ? ' is-selected' : ''}${status === 'deleted' ? ' is-deleted' : ''}${isDropTarget ? ' is-droptarget' : ''}${isBinDrop ? ' is-bindrop' : ''}${isCut ? ' is-cut' : ''}${item.incoming ? ' is-incoming' : ''}${item.pending ? ' is-pending' : ''}`}
        aria-busy={item.pending ? true : undefined}
        onClick={(e) => (item.incoming ? onIncoming?.(item, 'accept') : onSelect(item, e))}
        onDoubleClick={(e) => { if (!item.incoming) onOpen(item, e); }}
        onMouseMove={morph.handleMouseMove}
        onMouseLeave={morph.handleMouseLeave}
        onContextMenu={(e) => { e.stopPropagation(); morph.handleContextMenu(e); }}
        draggable={draggable && !item.binEntry && !item.incoming && !item.pending ? true : undefined}
        onDragStart={draggable && !item.binEntry && !item.incoming && !item.pending ? (e) => beginItemDrag?.(item, e) : undefined}
        onDragEnd={draggable && !item.binEntry ? () => endItemDrag?.() : undefined}
        onDragOver={isFolder ? (e) => onFolderDragOver?.(item, e) : undefined}
        onDragLeave={isFolder ? () => onFolderDragLeave?.(item) : undefined}
        onDrop={isFolder ? (e) => onFolderDrop?.(item, e) : undefined}
      >
        {/* Bin items show a circular elapsed-time countdown; drafts carry no ribbon. */}
        {tab === 'trash' && <CountdownRing days={item.deletesInDays} size={20} className="fx-tile-countdown" />}
        <span ref={aspect.ref} className="fx-tile-thumb" data-office={officeStripe(item) ? "" : undefined} style={aspect.style ? { ...(officeStripe(item) || {}), ...aspect.style } : officeStripe(item)}>
          {isFolder ? <FolderOrBinGlyph item={item} color={folderColor} /> : <ItemThumbnail item={item} />}
          {item.hasText && <TextMark />}
          {item.aiBusy && <AiBusyMark />}
          {item.incoming && <IncomingMark />}
        </span>
        <span>
          <span className="fx-tile-name">
            <DisplayName item={item} />
            {/* The Recycle bin entry shows how many items are inside —
                inline, right of the label (not a corner badge). */}
            {item.binEntry && item.binCount > 0 && <span className="fx-bin-count is-inline">{item.binCount}</span>}
          </span>
        </span>
      </button>
      {morph.node}
    </>
  );
});

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

// New-file draft tile — a generic-file placeholder whose name (with extension,
// e.g. "Proposal.docx") is an inline input. The input pre-selects the base name
// so you can type a new name right away.
function NewFileTile({ onCommit, onCancel }) {
  return (
    <div className="fx-tile is-renaming">
      <span className="fx-tile-thumb"><ExtGlyph ext="" /></span>
      <span>
        <InlineNameInput className="fx-tile-name" initial="Untitled" selectBaseName placeholder="new file" onCommit={onCommit} onCancel={onCancel} />
      </span>
    </div>
  );
}

// ── List row ──────────────────────────────────────────────────────────
const Row = React.memo(function Row({ item, tab, selected, onSelect, onOpen, onOpenContent, onRename, onProperties, onOpenLocation, onDelete, onRestore, onEmptyBin, canEdit, selectMode, isMultiSelected, bulkCount, onBulkDelete, onCopy, onCut, onIncoming, incomingCount, renaming, onCommitName, onCancelName, draggable, beginItemDrag, endItemDrag, onFolderDragOver, onFolderDragLeave, onFolderDrop, dropFolderId, cutPaths, folderColors, onSetColor }) {
  const isFolder = item.kind === 'folder';
  const status = item.status || 'synced';
  const isBin = tab === 'trash';
  const isDropTarget = isFolder && dropFolderId === item.id;
  const isBinDrop = item.binEntry && isDropTarget;
  const isCut = !isFolder && cutPaths?.has(item._raw?.path);
  const folderColor = isFolder && !item.binEntry ? folderColors?.[item.id] : undefined;
  const morph = useMorphPill({
    // WhatsApp files use the SAME plain name pill as every other file.
    hoverContent: item.incoming ? `${item.name} — from your phone. Click to add it` : isBin && !item.binEntry ? trashHoverContent(item) : item.name,
    menuItems: itemMenuItems(item, { tab, onOpen, onOpenContent, onRename, onProperties, onOpenLocation, onDelete, onRestore, onEmptyBin, canEdit, selectMode, isMultiSelected, bulkCount, onBulkDelete, onCopy: isFolder ? null : onCopy, onCut: isFolder ? null : onCut, onIncoming, incomingCount }),
    menuHeader: whatsappMenuHeader(item, isFolder, canEdit, folderColor, onSetColor),
  });
  if (renaming) {
    return (
      <div className="fx-list-row is-renaming">
        <span className="fx-list-name">
          <span className="fx-list-thumb" data-office={officeStripe(item) ? "" : undefined} style={officeStripe(item)}>
            {isFolder ? <FolderGlyph filled={!item.empty} size={20} color={folderColor} /> : <ItemThumbnail item={item} />}
          </span>
          <InlineNameInput className="fx-name" initial={displayBaseName(item)} onCommit={(name) => onCommitName(renamedName(item, name))} onCancel={onCancelName} />
        </span>
        <span /><span /><span />
      </div>
    );
  }
  return (
    <>
      <button
        type="button"
        data-fx-id={item.id}
        className={`fx-list-row${isBin ? ' is-bin' : ''}${selected ? ' is-selected' : ''}${status === 'deleted' ? ' is-deleted' : ''}${isDropTarget ? ' is-droptarget' : ''}${isBinDrop ? ' is-bindrop' : ''}${isCut ? ' is-cut' : ''}${item.incoming ? ' is-incoming' : ''}${item.pending ? ' is-pending' : ''}`}
        aria-busy={item.pending ? true : undefined}
        onClick={(e) => (item.incoming ? onIncoming?.(item, 'accept') : onSelect(item, e))}
        onDoubleClick={(e) => { if (!item.incoming) onOpen(item, e); }}
        onMouseMove={morph.handleMouseMove}
        onMouseLeave={morph.handleMouseLeave}
        onContextMenu={(e) => { e.stopPropagation(); morph.handleContextMenu(e); }}
        draggable={draggable && !item.binEntry && !item.incoming && !item.pending ? true : undefined}
        onDragStart={draggable && !item.binEntry && !item.incoming && !item.pending ? (e) => beginItemDrag?.(item, e) : undefined}
        onDragEnd={draggable && !item.binEntry ? () => endItemDrag?.() : undefined}
        onDragOver={isFolder ? (e) => onFolderDragOver?.(item, e) : undefined}
        onDragLeave={isFolder ? () => onFolderDragLeave?.(item) : undefined}
        onDrop={isFolder ? (e) => onFolderDrop?.(item, e) : undefined}
      >
        <span className="fx-list-name">
          {isBin && <CountdownRing days={item.deletesInDays} size={18} className="fx-row-countdown" />}
          <span className="fx-list-thumb" data-office={officeStripe(item) ? "" : undefined} style={officeStripe(item)}>
            {isFolder ? <FolderOrBinGlyph item={item} size={20} color={folderColor} /> : <ItemThumbnail item={item} />}
            {item.hasText && <TextMark />}
            {item.aiBusy && <AiBusyMark />}
              {item.incoming && <IncomingMark />}
          </span>
          <span className="fx-name">
            <DisplayName item={item} />
            {/* Bin count pill INSIDE the name span so it hugs the label text
                (the span stretches flex:1 — a sibling pill would be pushed to
                the column's far edge, next to the Date column). */}
            {item.binEntry && item.binCount > 0 && <span className="fx-bin-count is-inline">{item.binCount}</span>}
          </span>
        </span>
        <span className="fx-list-muted">{item.modifiedLabel || '—'}</span>
        <span className="fx-list-muted">{item.binEntry ? 'Trash' : isFolder ? 'Folder' : (item.ext ? item.ext.toUpperCase() : 'File')}</span>
        <span className="fx-list-muted">{item.sizeLabel || '—'}</span>
      </button>
      {morph.node}
    </>
  );
});

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

// New-file draft row — a file placeholder whose name (with extension) is an
// inline input.
function NewFileRow({ onCommit, onCancel }) {
  return (
    <div className="fx-list-row is-renaming">
      <span className="fx-list-name">
        <span className="fx-list-thumb"><ExtGlyph ext="" /></span>
        <InlineNameInput className="fx-name" initial="Untitled" selectBaseName placeholder="new file" onCommit={onCommit} onCancel={onCancel} />
      </span>
      <span /><span /><span />
    </div>
  );
}

// ── Main workspace ────────────────────────────────────────────────────
// The Files page's buttons that take the sidebar-tab hover / selected look
// (the footer's — the mini header keeps its own).
const FILES_TAB_BUTTONS = '.fx-tb-btn';

// Which file an "opened" record is about: its path on disk, else its id.
const openKeyOf = (item) => item?._raw?.path || item?.path || item?.id || '';

// The header's Sort dropdown.
const FX_SORTS = [
  { id: 'name', label: 'Name A – Z' },
  { id: 'name-desc', label: 'Name Z – A' },
  { id: 'newest', label: 'Newest first' },
  // The files opened most recently on this device first (lib/recentFiles).
  { id: 'recent', label: 'Recently opened' },
  { id: 'oldest', label: 'Oldest first' },
  { id: 'largest', label: 'Largest first' },
  { id: 'smallest', label: 'Smallest first' },
  { id: 'type', label: 'Type' },
];

// The Files mini header, with its own PINNED state. It lives here, not in
// FilesWorkspace, because a pin / unpin used to be FilesWorkspace state — and
// every flip re-rendered the whole page, every tile of the grid included, right
// as the bar started its fade: that re-render is what made the header's motion
// stutter. Now only the bar re-renders (`children`, the toolbar, is the same
// element, so React skips it). The scroll is measured at most once a frame.
// Pinned = the bar is ACTUALLY stuck at the top (its rect reaches the
// scroller's top + the sticky gap), so the surface doesn't appear early while
// the masthead is still scrolling away.
function FilesPathbar({ getScroller, enabled, deps, children }) {
  useMiniGlowSpot(); // the .mini-glow bar's spotlight (lib/pointerSpots)
  const [pinned, setPinned] = useState(false);
  const barRef = useRef(null);
  useEffect(() => {
    const el = getScroller();
    if (!el || !enabled) { setPinned(false); return undefined; }
    let raf = 0;
    const measure = () => {
      raf = 0;
      const bar = barRef.current;
      setPinned(!!bar && (bar.getBoundingClientRect().top - el.getBoundingClientRect().top) <= 8);
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(measure); };
    measure();
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => { el.removeEventListener('scroll', onScroll); if (raf) cancelAnimationFrame(raf); };
  // `deps` re-attach the listener when the page's layout changes underneath.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, ...deps]);
  return (
    <>
      <MiniHeaderFade visible={pinned} />
      <div ref={barRef} className={`fx-pathbar mini-glow${pinned ? ' is-pinned' : ''}`}>{children}</div>
    </>
  );
}

// ── Windowed grid / list ───────────────────────────────────────────────
// A project folder can hold thousands of files, and a tile per file in the
// DOM (a thumbnail, a morph pill, listeners each) made opening and scrolling
// a large folder slow. VirtualCells draws only the rows in and near the
// viewport, with a spacer above and below standing in for the rest, and is
// otherwise the same markup: ONE `.fx-grid` (or `.fx-list`) holding the rows
// on show, so every CSS rule, gap and margin applies exactly as before and a
// tile scrolling from one edge of the window to the other stays mounted.
//
// Rows are fixed per layout but not all the same height (a two-line name
// makes its row taller), so each drawn row is MEASURED (the distance between
// the first cells of consecutive rows) and remembered; a row never drawn is
// taken to be the average. The column count is worked out the way the CSS
// `repeat(auto-fill, …)` would, and pinned on the grid inline so the two can
// never disagree. Each block registers itself (`registry`) so the page can
// scroll an off-screen item into view and the rubber band can select items
// that aren't drawn — both from the computed positions.
const VIRTUAL_OVERSCAN = 900;   // px drawn beyond the window, above and below
const VIRTUAL_PIN_SPAN = 120;   // furthest a pinned row may stretch the window
// Placeholders for the "new folder" / "new file" drafts, which sit among the
// cells like any item.
const NEW_FOLDER_CELL = { id: '__fx-new-folder', __cell: 'new-folder' };
const NEW_FILE_CELL = { id: '__fx-new-file', __cell: 'new-file' };

function VirtualCells({ cells, renderCell, mode, tileSize, registry, blockKey, pinnedRef, onRenderedRef, onCols, getScroller }) {
  const isTiles = mode === 'tiles';
  const topRef = useRef(null);
  const bodyRef = useRef(null);
  const [width, setWidth] = useState(0);
  const [range, setRange] = useState({ start: 0, end: 24 });
  const [measureTick, setMeasureTick] = useState(0);
  // Measured row pitches (row height + the gap under it), per layout.
  const metaRef = useRef({ key: '', heights: new Map(), avg: 0, rowGap: isTiles ? 6.4 : 0, colGap: 6.4, padL: 0, padR: 0 });
  const meta = metaRef.current;
  const cols = isTiles ? Math.max(1, Math.floor((Math.max(0, width) + meta.colGap) / (tileSize + meta.colGap))) : 1;
  const layoutKey = `${mode}:${cols}:${tileSize}`;
  if (meta.key !== layoutKey) { meta.key = layoutKey; meta.heights = new Map(); meta.avg = 0; }
  const rows = Math.ceil(cells.length / cols);
  // Before anything is measured: roughly a tile (thumb + padding + a line of
  // name) or a list row. Replaced by the average of what has been measured.
  const estimate = meta.avg || (isTiles ? tileSize * 0.58 + 44 + meta.rowGap : 30);
  const offsets = useMemo(() => {
    const o = new Float64Array(rows + 1);
    let acc = 0;
    for (let r = 0; r < rows; r += 1) {
      o[r] = acc;
      const h = meta.heights.get(r);
      acc += h != null ? h : estimate;
    }
    o[rows] = acc;
    return o;
  }, [rows, layoutKey, measureTick, estimate]); // eslint-disable-line react-hooks/exhaustive-deps
  const idIndex = useMemo(() => {
    const m = new Map();
    cells.forEach((c, i) => { if (c && c.id != null) m.set(c.id, i); });
    return m;
  }, [cells]);

  // Latest values for the listeners and the registry, without re-binding.
  const live = useRef({});
  live.current = { offsets, rows, cols, idIndex, range, isTiles, tileSize };

  // First row whose bottom is below `y` (offsets are in block px).
  const rowAt = (o, n, y) => {
    let lo = 0; let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (o[mid + 1] > y) hi = mid; else lo = mid + 1;
    }
    return lo;
  };
  const computeRange = () => {
    const top = topRef.current;
    if (!top) return;
    const { offsets: o, rows: n, cols: c, idIndex: ix } = live.current;
    const r = top.getBoundingClientRect();
    const y0 = toLayoutPx(0 - r.top) - VIRTUAL_OVERSCAN;
    const y1 = toLayoutPx(window.innerHeight - r.top) + VIRTUAL_OVERSCAN;
    let start = Math.min(n, rowAt(o, n, y0));
    let end = rowAt(o, n, y1);
    if (end >= n) end = n - 1;
    if (end < start - 1) end = start - 1;
    // Keep the row of anything being renamed or dragged drawn (an input that
    // unmounts loses its text; a drag source that unmounts never ends).
    for (const id of pinnedRef?.current || []) {
      const i = ix.get(id);
      if (i == null) continue;
      const pr = Math.floor(i / c);
      if (end < start) { start = pr; end = pr; }   // nothing else of this block is drawn
      else if (pr < start && start - pr <= VIRTUAL_PIN_SPAN) start = pr;
      else if (pr > end && pr - end <= VIRTUAL_PIN_SPAN) end = pr;
    }
    setRange((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
  };
  const computeRef = useRef(computeRange);
  computeRef.current = computeRange;

  // Width (→ columns) and anything that changes the drawn rows' size.
  useEffect(() => {
    const body = bodyRef.current;
    if (!body || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => setMeasureTick((t) => t + 1));
    ro.observe(body);
    return () => ro.disconnect();
  }, []);
  // Scrolling anywhere (the page scroller, or whatever holds the Files page
  // when it is embedded) and resizing the window move the window of rows.
  useEffect(() => {
    let raf = 0;
    const onMove = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; computeRef.current(); }); };
    document.addEventListener('scroll', onMove, { capture: true, passive: true });
    window.addEventListener('resize', onMove);
    return () => {
      document.removeEventListener('scroll', onMove, { capture: true });
      window.removeEventListener('resize', onMove);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  // After every commit: read the width and the drawn rows' heights, then the
  // window. Reads only (the state updates re-render before paint), and it
  // settles: a second pass measures what the first already recorded.
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const cs = getComputedStyle(body);
    meta.padL = parseFloat(cs.paddingLeft) || 0;
    meta.padR = parseFloat(cs.paddingRight) || 0;
    if (isTiles) {
      meta.colGap = parseFloat(cs.columnGap) || 0;
      meta.rowGap = parseFloat(cs.rowGap) || 0;
    } else {
      meta.rowGap = 0;
    }
    const w = body.clientWidth - meta.padL - meta.padR;
    if (Math.abs(w - width) > 0.5) { setWidth(w); return; }
    const { start, end } = range;
    const shown = end >= start ? Math.min(cells.length, (end + 1) * cols) - start * cols : 0;
    if (shown > 0 && body.children.length === shown) {
      const tops = [];
      for (let r = start; r <= end; r += 1) {
        const el = body.children[(r - start) * cols];
        if (!el) break;
        tops.push(el.getBoundingClientRect().top);
      }
      const bottom = body.getBoundingClientRect().bottom;
      let changed = false;
      for (let i = 0; i < tops.length; i += 1) {
        const h = toLayoutPx(i + 1 < tops.length ? tops[i + 1] - tops[i] : bottom - tops[i]) + (i + 1 < tops.length ? 0 : meta.rowGap);
        if (!(h > 0)) continue;
        const old = meta.heights.get(start + i);
        if (old == null || Math.abs(old - h) > 0.5) { meta.heights.set(start + i, h); changed = true; }
      }
      if (changed) {
        let sum = 0;
        for (const h of meta.heights.values()) sum += h;
        meta.avg = meta.heights.size ? sum / meta.heights.size : 0;
        setMeasureTick((t) => t + 1);
        return;
      }
    }
    computeRange();
    onRenderedRef?.current?.();
  });

  useEffect(() => { if (isTiles) onCols?.(cols); }, [isTiles, cols, onCols]);

  // What the page asks of a block: scroll one of its items into view, and
  // which items a rectangle (canvas px) touches — drawn or not.
  const api = useRef(null);
  api.current = {
    scrollToId(id) {
      const { idIndex: ix, offsets: o, cols: c } = live.current;
      const i = ix.get(id);
      if (i == null) return false;
      const body = bodyRef.current;
      const top = topRef.current;
      const find = () => {
        try { return body?.querySelector(`[data-fx-id="${CSS.escape(String(id))}"]`) || null; } catch { return null; }
      };
      const el = find();
      if (el) { el.scrollIntoView({ block: 'nearest' }); return true; }
      const scroller = getScroller?.();
      if (!scroller || !top) return true;
      // Bring its row roughly into view from the computed layout, then let
      // the browser place it exactly once it is drawn.
      const r = Math.floor(i / c);
      const sr = scroller.getBoundingClientRect();
      const rowTop = top.getBoundingClientRect().top - sr.top + o[r];
      const rowH = o[r + 1] - o[r];
      scroller.scrollTop += rowTop < 0 ? rowTop - sr.height / 3 : rowTop + rowH - sr.height + sr.height / 3;
      requestAnimationFrame(() => requestAnimationFrame(() => find()?.scrollIntoView({ block: 'nearest' })));
      return true;
    },
    hitTest(rect, canvasRect) {
      const top = topRef.current;
      const body = bodyRef.current;
      if (!top || !body) return [];
      const { offsets: o, rows: n, cols: c, isTiles: tiles, tileSize: t } = live.current;
      const oy = toLayoutPx(top.getBoundingClientRect().top - canvasRect.top);
      const ox = toLayoutPx(body.getBoundingClientRect().left - canvasRect.left) + meta.padL;
      const y0 = rect.y - oy;
      const y1 = rect.y + rect.h - oy;
      const out = [];
      for (let r = rowAt(o, n, y0); r < n && o[r] < y1; r += 1) {
        if (o[r + 1] - meta.rowGap <= y0) continue;
        for (let k = 0; k < c; k += 1) {
          const cell = cells[r * c + k];
          if (!cell) break;
          if (cell.__cell) continue;
          const x = tiles ? ox + k * (t + meta.colGap) : ox;
          const w = tiles ? t : width;
          if (x < rect.x + rect.w && x + w > rect.x) out.push(cell.id);
        }
      }
      return out;
    },
  };
  useEffect(() => {
    if (!registry) return undefined;
    registry.set(blockKey, api);
    return () => { if (registry.get(blockKey) === api) registry.delete(blockKey); };
  }, [registry, blockKey]);

  const { start, end } = range;
  const first = Math.min(cells.length, start * cols);
  const last = end >= start ? Math.min(cells.length, (end + 1) * cols) : first;
  const topH = offsets[Math.min(start, rows)] || 0;
  const bottomH = Math.max(0, (offsets[rows] || 0) - (offsets[Math.min(rows, end + 1)] || 0));
  const style = isTiles ? { gridTemplateColumns: `repeat(${cols}, var(--fx-tile, 134.4px))` } : undefined;
  return (
    <>
      <div ref={topRef} className="fx-vspacer" style={{ height: topH }} aria-hidden="true" />
      <div ref={bodyRef} className={isTiles ? 'fx-grid' : 'fx-list'} style={style} data-fx-vbody="">
        {cells.slice(first, last).map(renderCell)}
      </div>
      <div className="fx-vspacer" style={{ height: bottomH }} aria-hidden="true" />
    </>
  );
}

export default function FilesWorkspace({
  projectId,
  // Versions-style hero for the top of the canvas: { eyebrow, access, title,
  // kicker }. Scrolls away with the file grid; a compact bar fades in once it's
  // past. Null hides both (e.g. the recycle-bin tab).
  masthead,
  summaryText,
  // In-panel mode: 'drafts' (the project folder) or 'trash' (the recycle bin,
  // entered by opening the bin folder). There is no tab strip — one panel.
  tab,
  canEdit,
  hasLocalFolder,
  onPickFolder,      // () => void — ask the user for the project's folder (it
                     //   went missing, or belongs to another project)
  pickFolderCopy,    // { title, body, button } — what that prompt says
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
  renameTargetPath,       // path of a just-created file to auto-select + rename
  onRenameTargetConsumed, // () => void — clear the request once it's applied
  selectTargetPath,       // path of a just-created file/FOLDER to auto-select (no rename)
  onSelectTargetConsumed, // () => void — clear the request once it's applied
  // actions
  onOpen, onOpenContent, onRename, onDelete, onRestore, onNewFolder,
  // Several items at once (multi-select, a drop of several on the Trash):
  // (items) => void. One batch, one notification; falls back to onDelete /
  // onRestore per item when not given.
  onDeleteMany, onRestoreMany, onNewFile, onCreateTypedFile, onAddHighlightsSample, onUpload, onUploadFolder, onOpenLocation,
  // A waiting phone file (item.incoming): (item, 'accept' | 'reject').
  onIncoming,
  onEmptyBin,
  onRefresh,         // () => void — re-list the folder (toolbar refresh button)
  onDebugSeedTrash,  // DEV-only — seed the bin with staggered-expiry dummy items
  onOpenDirectory,   // () => void — open the current folder in the OS file manager
  onDropFiles,       // ([{ file, relPath }]) => void — drag-and-drop import,
                     //   folders included (relPath carries nested structure)
  onPasteItems,      // (items) => void — paste COPIED files into the current folder
  onPasteCut,        // (items) => void — paste CUT files (move) into the current folder
  onMoveItems,       // (items, targetFolder) => void — drag files onto a folder to move
  onMoveToCrumb,     // (crumb, items) => void — drag files onto a breadcrumb folder to move
  // undo / redo (footer)
  onUndo, onRedo, canUndo, canRedo, undoLabel, redoLabel,
}) {
  useMiniGlowSpot(); // the .mini-glow bar's spotlight (lib/pointerSpots)
  const isBin = tab === 'trash';
  // Tile zoom — driven by Ctrl+scroll over the canvas. Zoom out far enough
  // and the grid collapses into the list view; zoom back in and the tiles
  // return. The INITIAL view honors Settings → "Default file view": 'list'
  // seeds the zoomed-out (list) size, 'grid' the default tile size.
  // Per-user persistence of the view controls (icon-size slider + categorize
  // toggle) so they survive leaving and re-entering the Files tab. Falls back to
  // the Settings "Default file view" for the size, ungrouped for categorize.
  const { session } = useAuth();
  const viewPrefsKey = `docvex.filesView.${session?.user?.id || '_anon'}`;
  const savedViewPrefs = useMemo(() => {
    try { return JSON.parse(localStorage.getItem(viewPrefsKey) || 'null') || {}; }
    catch { return {}; }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewPrefsKey]);
  const [tileSize, setTileSize] = useState(() => (
    typeof savedViewPrefs.tileSize === 'number'
      ? Math.max(FX_MIN_TILE, Math.min(FX_MAX_TILE, savedViewPrefs.tileSize))
      : FX_LIST_THRESHOLD
  ));
  const view = tileSize < FX_LIST_THRESHOLD ? 'list' : 'tiles';
  // List-view row density follows the slider. The standard range grows gently;
  // the TOP TWO steps (the two notches just below the tile threshold) bump up
  // much harder so they read as a distinct "large" list size. Published as CSS
  // vars on the canvas and consumed by .fx-list-row / .fx-list-thumb.
  const listRowVars = useMemo(() => {
    if (view !== 'list') return null;
    const idx = Math.round((tileSize - FX_MIN_TILE) / 2);            // 0 … top
    const topIdx = Math.round((FX_LIST_THRESHOLD - 2 - FX_MIN_TILE) / 2);
    const fromTop = topIdx - idx;                                    // 0 = largest step
    // Only the thumbnail icon + row height scale with the slider — the file-name
    // text stays a fixed size (see .fx-list-row font-size).
    let thumb = 19 + idx * 0.7;
    let pad = 4.5 + idx * 0.25;
    if (fromTop === 1) { thumb += 5; pad += 1.8; }
    if (fromTop === 0) { thumb += 12; pad += 4; }
    return {
      '--fx-row-thumb': `${thumb}px`,
      '--fx-row-pad': `${pad}px`,
    };
  }, [view, tileSize]);
  const [query, setQuery] = useState('');
  // Selection — `multiSel` (a Set of ids) is the single source of truth.
  // Plain click selects one; Ctrl/Cmd+click toggles; Shift+click extends a
  // range from the anchor. The "Select" button (selectMode) makes plain
  // clicks additive for mouse-only / touch use. `anchorId` is the pivot for
  // Shift-range selection.
  const [multiSel, setMultiSel] = useState(() => new Set());
  const [anchorId, setAnchorId] = useState(null);
  const [selectMode, setSelectMode] = useState(false);
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  // "Categorize" toolbar toggle — when on, the flat grid/list is split into
  // labelled category sections (folders incl. compressed archives, pictures &
  // videos, Office docs, the Recycle bin, then everything else) stacked
  // vertically. Off → one flat list (the default).
  const [grouped, setGrouped] = useState(() => savedViewPrefs.grouped === true);
  // The header's Sort dropdown (FX_SORTS) — kept with the other view controls.
  const [sortBy, setSortBy] = useState(() => (FX_SORTS.some((o) => o.id === savedViewPrefs.sortBy) ? savedViewPrefs.sortBy : 'name'));
  // Persist the view controls whenever they change (debounced naturally by React
  // batching) so the next visit to Files restores the same size + categorize state.
  useEffect(() => {
    try { localStorage.setItem(viewPrefsKey, JSON.stringify({ tileSize, grouped, sortBy })); }
    catch { /* storage full / blocked — non-critical */ }
  }, [viewPrefsKey, tileSize, grouped, sortBy]);
  const [propsItem, setPropsItem] = useState(null);
  // Pointer-anchored "this is a compressed file" prompt — { item, x, y } in
  // viewport px (null coords = no pointer, e.g. opened with Enter → centred).
  const [archivePrompt, setArchivePrompt] = useState(null);
  const [dragOver, setDragOver] = useState(false);   // OS file drag over the canvas
  const [clipboard, setClipboard] = useState(null);  // { mode: 'copy'|'cut', items: [{ name, path }] }
  const [dropFolderId, setDropFolderId] = useState(null); // folder hovered during a move drag
  const [dropCrumb, setDropCrumb] = useState(null);  // breadcrumb path hovered during a move drag
  // Per-folder icon colour (localStorage-backed, keyed by project + folder id).
  const [folderColors, setFolderColors] = useState(() => loadFolderColors(projectId));
  useEffect(() => { setFolderColors(loadFolderColors(projectId)); }, [projectId]);
  const setFolderColor = (folderId, value) => {
    setFolderColors((cur) => {
      const next = { ...cur };
      if (value) next[folderId] = value; else delete next[folderId];
      persistFolderColors(projectId, next);
      return next;
    });
  };
  const createMenuRef = useRef(null);
  const canvasRef = useRef(null);
  const pageRef = useRef(null);   // root, used to scope shortcuts to this pane
  // The Files buttons wear the app sidebar's tab look (FilesWorkspace.css →
  // FILES_TAB_BUTTONS): a hover / selected fill that brightens where the
  // pointer is. The button under the cursor gets its own --item-spot-x/y, as
  // the Sidebar's tabs do — by the app's one pointer (lib/pointer), which
  // judges by the element under the pointer, so it reaches the toolbar even
  // when it is portalled into the window chrome, outside this page's element.
  useEffect(() => registerHoverSpot(FILES_TAB_BUTTONS), []);
  const searchRef = useRef(null);
  const actionsRef = useRef({});  // latest copy/paste handlers for the key listener
  const kbdRef = useRef({});      // latest selection/nav handlers for the key listener

  // Watch the PAGE scroll position to drive the masthead scroll-away (the whole
  // Files page scrolls as one, like the other personal tabs — the sticky nav
  // strip then carries the title once the hero scrolls off). Falls back to the
  // canvas scroller if the page scroller isn't found (e.g. embedded contexts).
  const pageScroller = () => pageRef.current?.closest('.sv-single-scroll') || canvasRef.current;
  const scrollToTop = () => pageScroller()?.scrollTo({ top: 0, behavior: 'smooth' });

  // The windowed blocks (VirtualCells) of whatever view is on show, by key —
  // how an off-screen item is scrolled to and how the rubber band selects
  // items that aren't drawn.
  const getScroller = useCallback(() => pageRef.current?.closest('.sv-single-scroll') || null, []);
  const vRegistryRef = useRef(new Map());
  // Items whose row must stay drawn: the one being renamed, the ones dragged.
  const pinnedRef = useRef(new Set());
  const dragPinRef = useRef([]);
  // Called by every block after it commits — the rubber band repaints then,
  // so rows drawn mid-drag show the selection too.
  const onRenderedRef = useRef(null);
  // Columns of the grid on show (the same for every block — one width), for
  // arrow-key Up / Down.
  const colsRef = useRef(1);
  const onCols = useCallback((c) => { colsRef.current = c; }, []);
  // Scroll an item into view, drawn or not.
  const scrollToItem = (id) => {
    for (const ref of vRegistryRef.current.values()) {
      if (ref.current?.scrollToId(id)) return;
    }
    try { canvasRef.current?.querySelector(`[data-fx-id="${CSS.escape(String(id))}"]`)?.scrollIntoView({ block: 'nearest' }); } catch { /* CSS.escape unsupported */ }
  };

  // Inline name editing (Electron has no window.prompt).
  const [renamingId, setRenamingId] = useState(null);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [creatingFile, setCreatingFile] = useState(false);
  const requestRename = (item) => { if (item) { setCreatingFolder(false); setCreatingFile(false); setRenamingId(item.id); } };
  const requestNewFolder = () => { setRenamingId(null); setCreatingFile(false); setCreatingFolder(true); };
  const requestNewFile = () => { setRenamingId(null); setCreatingFolder(false); setCreatingFile(true); };
  const commitRename = (item, name) => { setRenamingId(null); onRename?.(item, name); };
  const cancelRename = () => setRenamingId(null);

  // Parent created a file and wants it renamed (not opened): once the new file
  // appears in the listing, select it and drop straight into rename mode — the
  // inline input auto-focuses and selects the name text. Re-runs as `items`
  // updates so it catches the file after the post-write refetch lands.
  useEffect(() => {
    if (!renameTargetPath) return;
    const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    const target = norm(renameTargetPath);
    const match = (items || []).find((it) => it?._raw?.path && norm(it._raw.path) === target);
    if (!match) return; // not listed yet — this effect re-runs when items change
    setCreatingFolder(false);
    setCreatingFile(false);
    setMultiSel(new Set([match.id]));
    setAnchorId(match.id);
    setRenamingId(match.id);
    onRenameTargetConsumed?.();
    requestAnimationFrame(() => scrollToItem(match.id));
  }, [renameTargetPath, items]); // eslint-disable-line react-hooks/exhaustive-deps

  // Parent made something and wants it SELECTED but not opened — the folder an
  // archive was just extracted into. Unlike the rename request above this
  // searches folders as well as files, and stops at selection: no rename mode,
  // no navigation. Re-runs as the listing updates so it catches the folder
  // once the post-extract refetch lands.
  useEffect(() => {
    if (!selectTargetPath) return;
    const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    const target = norm(selectTargetPath);
    if (!target) return;
    const match = [...(folders || []), ...(items || [])]
      .find((it) => it && norm(it._dir?.path || it._raw?.path) === target);
    if (!match) return;  // not listed yet — this effect re-runs when they change
    setMultiSel(new Set([match.id]));
    setAnchorId(match.id);
    onSelectTargetConsumed?.();
    requestAnimationFrame(() => scrollToItem(match.id));
  }, [selectTargetPath, folders, items]); // eslint-disable-line react-hooks/exhaustive-deps
  const commitNewFolder = (name) => { setCreatingFolder(false); onNewFolder?.(name); };
  const cancelNewFolder = () => setCreatingFolder(false);
  const commitNewFile = (name) => { setCreatingFile(false); onNewFile?.(name); };
  const cancelNewFile = () => setCreatingFile(false);

  // Write actions (rename / import / new folder) are only offered in the
  // My-drafts tab — the bin is restore / delete-forever only.
  const menuEditable = !isBin && canEdit;

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

  // Ctrl/Cmd+C copies the selection; Ctrl/Cmd+V pastes into the current folder.
  // Scoped to the focused pane and suppressed while typing in an input so it
  // doesn't hijack normal text copy/paste.
  useEffect(() => {
    const onKey = (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = (e.key || '').toLowerCase();
      if (k !== 'c' && k !== 'v' && k !== 'x') return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      // Don't clobber a real text selection (let the browser copy that).
      if (k === 'c' && window.getSelection && String(window.getSelection())) return;
      const pane = pageRef.current?.closest('.sv-pane');
      if (pane && !pane.classList.contains('is-focused')) return;
      const a = actionsRef.current;
      if (k === 'c' && a.hasCopyable) { e.preventDefault(); a.copySelection(); }
      else if (k === 'x' && a.canCut) { e.preventDefault(); a.cutSelection(); }
      else if (k === 'v' && a.canPaste) { e.preventDefault(); a.pasteHere(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Explorer-style keys (Delete / F2 / Enter / Backspace / Ctrl+A / arrows /
  // Home / End / Escape). Scoped to the focused pane; suppressed while typing.
  useEffect(() => {
    const onKey = (e) => {
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const pane = pageRef.current?.closest('.sv-pane');
      if (pane && !pane.classList.contains('is-focused')) return;
      const k = kbdRef.current;
      switch (e.key) {
        case 'Delete':
          if (k.hasSelection) { e.preventDefault(); k.deleteSelection(); }
          break;
        case 'F2':
          if (k.menuEditable && k.oneSelected) { e.preventDefault(); k.renameSelected(); }
          break;
        case 'Enter':
          if (k.oneSelected) { e.preventDefault(); k.openSelected(); }
          break;
        case 'Backspace':
          if (k.canUp) { e.preventDefault(); k.onUp(); }
          break;
        case 'Escape':
          if (k.hasSelection) { e.preventDefault(); k.clearSelection(); }
          break;
        case 'a': case 'A':
          if (e.ctrlKey || e.metaKey) { e.preventDefault(); k.selectAll(); }
          break;
        case 'ArrowUp': case 'ArrowDown': case 'ArrowLeft': case 'ArrowRight': case 'Home': case 'End':
          if (!e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); k.navigateSelection(e.key, e.shiftKey); }
          break;
        default:
          break;
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
    description: isBin
      ? 'Deleted files are removed for good after 30 days.'
      : summaryText,
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

  // Close the Create-new-file menu on outside click / Esc.
  useEffect(() => {
    if (!createMenuOpen) return undefined;
    const onDoc = (e) => { if (!createMenuRef.current?.contains(e.target)) setCreateMenuOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setCreateMenuOpen(false); };
    window.addEventListener('mousedown', onDoc);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('mousedown', onDoc); window.removeEventListener('keydown', onKey); };
  }, [createMenuOpen]);

  const q = query.trim().toLowerCase();
  const matches = (name) => !q || (name || '').toLowerCase().includes(q);
  // Case-insensitive, number-aware name sort ("file2" before "file10").
  const byName = (a, b) => (a.name || '').localeCompare(b.name || '', undefined, { numeric: true, sensitivity: 'base' });
  // Coarse category of an item, for the "Categorize" section view: the Recycle
  // bin entry → trash; folders + compressed archives → folders; images, video
  // and audio (+ design files) → media; Office docs (Word / Excel / PowerPoint
  // / PDF) → office; everything else → other. Keep in sync with FX_GROUPS.
  const itemCat = (f) => {
    if (f.binEntry) return 'trash';
    if (f.kind === 'folder') return 'folders';
    const c = extCategory(f.ext);
    if (c === 'zip') return 'folders';
    if (c === 'img' || c === 'vid' || c === 'aud' || c === 'psd' || c === 'ai') return 'media';
    if (c === 'doc' || c === 'xls' || c === 'ppt' || c === 'pdf') return 'office';
    return 'other';
  };
  // One flat ordering (no Folders/Files category split): the Recycle bin entry
  // first, then folders A→Z, then files A→Z.
  const binFolders = useMemo(
    () => (folders || []).filter((f) => f.binEntry && matches(f.name)),
    [folders, q], // eslint-disable-line react-hooks/exhaustive-deps
  );
  // The header's Sort: folders are ordered among themselves and files among
  // themselves (folders still come first, as in Explorer); anything equal
  // falls back to the name. Waiting phone files always lead the files.
  // A file being opened re-orders the list under "Recently opened".
  const [openedTick, setOpenedTick] = useState(0);
  useEffect(() => (sortBy === 'recent' ? subscribeOpened(() => setOpenedTick((n) => n + 1)) : undefined), [sortBy]);
  const sortCmp = useMemo(() => {
    const t = (x) => Number(x.sortTime) || 0;
    const o = (x) => openedAt(openKeyOf(x));
    const z = (x) => Number(x.sortSize) || 0;
    const ext = (x) => String(x.ext || '').toLowerCase();
    switch (sortBy) {
      case 'name-desc': return (a, b) => byName(b, a);
      case 'newest': return (a, b) => t(b) - t(a) || byName(a, b);
      case 'oldest': return (a, b) => t(a) - t(b) || byName(a, b);
      // Opened most recently first; never-opened ones after, newest first.
      case 'recent': return (a, b) => o(b) - o(a) || t(b) - t(a) || byName(a, b);
      case 'largest': return (a, b) => z(b) - z(a) || byName(a, b);
      case 'smallest': return (a, b) => z(a) - z(b) || byName(a, b);
      case 'type': return (a, b) => ext(a).localeCompare(ext(b)) || byName(a, b);
      default: return byName;
    }
  }, [sortBy, openedTick]); // eslint-disable-line react-hooks/exhaustive-deps
  const shownFolders = useMemo(
    () => (folders || []).filter((f) => !f.binEntry && matches(f.name)).sort(sortBy === 'type' ? byName : sortCmp),
    [folders, q, sortCmp], // eslint-disable-line react-hooks/exhaustive-deps
  );
  // Compressed archives (zip / rar / 7z / tar / gz) are "compressed folders" —
  // arrange them with the folders: they sort to the FRONT of the file list so,
  // rendered right after the real folders, they sit next to them. Within each
  // group (archives, then plain files) it's still A→Z.
  const isArchiveItem = (f) => extCategory(f.ext) === 'zip';
  const shownItems = useMemo(
    () => (items || []).filter((f) => matches(f.name)).sort((a, b) => {
      const ia = a.incoming ? 0 : 1;
      const ib = b.incoming ? 0 : 1;
      if (ia !== ib) return ia - ib;
      // By name, archives stand next to the folders; any other order is the
      // order asked for.
      if (sortBy === 'name') {
        const aa = isArchiveItem(a) ? 0 : 1;
        const bb = isArchiveItem(b) ? 0 : 1;
        if (aa !== bb) return aa - bb;
      }
      return sortCmp(a, b);
    }),
    [items, q, sortCmp], // eslint-disable-line react-hooks/exhaustive-deps
  );
  // Bin → folders → files, in render order. Drives both the grid/list and the
  // Shift-range selection axis.
  const displayFolders = useMemo(() => [...binFolders, ...shownFolders], [binFolders, shownFolders]);

  // ── Content search ──────────────────────────────────────────────────────
  // A query matches two ways: by NAME (instant, the filter above) and by
  // CONTENT (has to read the files). The two result sets are kept disjoint —
  // a file whose name already matched isn't scanned or listed twice — and the
  // content pass runs in the background so typing never waits on a PDF parse.
  // [{ item, snippet }] — the snippet is the text around the match (literal
  // search) or the model's one-line reason (AI search).
  const [contentHits, setContentHits] = useState([]);
  const [contentScanning, setContentScanning] = useState(false);
  const [contentError, setContentError] = useState('');
  // ── AI section ──────────────────────────────────────────────────────────
  // Its own category beside the literal passes, and it only runs when ASKED:
  // an AI search costs a request (and uploads picture stills — see
  // lib/visualThumb.js), so it's a button in the section, not something every
  // keystroke fires. Results are tagged with the query they answer so a stale
  // set can't sit under a query it has nothing to do with.
  const [aiHits, setAiHits] = useState([]);
  const [aiScanning, setAiScanning] = useState(false);
  const [aiError, setAiError] = useState('');
  const [aiRanFor, setAiRanFor] = useState('');
  // The query a run was STARTED for, set whether or not it succeeded. `aiRanFor`
  // only records successes, so gating the auto-run on it would retry a failing
  // query forever.
  const [aiAttemptedFor, setAiAttemptedFor] = useState('');
  // { done, total } while the one-time description pass runs (lib/aiFileIndex),
  // null otherwise. Only ever non-null for files this folder hasn't described
  // yet, so it shows on the first search and rarely again.
  const [aiIndexing, setAiIndexing] = useState(null);
  const aiAbortRef = useRef(null);
  // The first AI search on a device asks for informed consent: it's the only
  // feature here that sends a matter's contents off the machine, so the user
  // gets told exactly what leaves before any of it does. Once granted the
  // button runs directly — a firm shouldn't have to re-read the notice on
  // every search.
  const [aiConsentOpen, setAiConsentOpen] = useState(false);
  const [aiConsented, setAiConsented] = useState(() => {
    try { return localStorage.getItem('docvex.aiSearchConsent') === '1'; } catch { return false; }
  });
  const acceptAiConsent = () => {
    try { localStorage.setItem('docvex.aiSearchConsent', '1'); } catch { /* ignore */ }
    setAiConsented(true);
    setAiConsentOpen(false);
    runAiSearch();
  };

  // Typing invalidates whatever the AI last answered.
  useEffect(() => {
    aiAbortRef.current?.abort();
    aiAbortRef.current = null;
    setAiHits([]);
    setAiScanning(false);
    setAiError('');
    setAiRanFor('');
    setAiAttemptedFor('');
    setAiIndexing(null);
  }, [q]);

  const runAiSearch = async () => {
    if (!q || aiScanning) return;
    const controller = new AbortController();
    aiAbortRef.current = controller;
    setAiAttemptedFor(q);
    setAiScanning(true);
    setAiError('');
    setAiHits([]);
    setAiIndexing(null);
    // Everything but folders: an image can only be judged by looking at it, so
    // unreadable-as-text formats are exactly what this pass is for. Files
    // already listed under "By name" are skipped — they're above.
    const candidates = (itemsRef.current || []).filter((f) => (
      f && f.kind !== 'folder' && f._raw?.path && !(f.name || '').toLowerCase().includes(q)
    )).map((f) => ({ item: f, file: f._raw }));
    const byPath = new Map(candidates.map((c) => [c.file.path, c.item]));
    try {
      const { matches, error } = await aiSearchFiles({
        query: q,
        files: candidates.map((c) => c.file),
        // The masthead title is the project's own name — context for what the
        // folder is about.
        projectName: masthead?.title || '',
        signal: controller.signal,
        // Reported only while files are being described for the first time.
        onProgress: (p) => { if (!controller.signal.aborted) setAiIndexing(p.done >= p.total ? null : p); },
      });
      if (controller.signal.aborted) return;
      if (error) { setAiError(typeof error === 'string' ? error : 'AI search failed.'); return; }
      setAiHits(matches.map((m) => ({ item: byPath.get(m.file.path), snippet: m.why })).filter((h) => h.item));
      setAiRanFor(q);
    } catch (err) {
      if (!controller.signal.aborted) setAiError(err?.message || 'AI search failed.');
    } finally {
      if (!controller.signal.aborted) { setAiScanning(false); setAiIndexing(null); }
    }
  };

  // Once the user has consented, AI search stops being a thing they press: the
  // pitch and its Enable button are gone and each query just runs, alongside
  // the two literal passes. Read through a ref because runAiSearch is rebuilt
  // every render and would otherwise re-fire this effect endlessly.
  const runAiRef = useRef(null);
  runAiRef.current = runAiSearch;
  useEffect(() => {
    if (!aiConsented || q.length < 2) return undefined;
    if (aiAttemptedFor === q || aiScanning) return undefined;
    // Longer than the literal pass's debounce: this one costs a request, so it
    // waits until the typing has actually stopped.
    const t = setTimeout(() => runAiRef.current?.(), 650);
    return () => clearTimeout(t);
  }, [q, aiConsented, aiAttemptedFor, aiScanning]);

  // `items` is rebuilt every render, so it can't be an effect dependency —
  // this value-equal string can.
  const itemsKey = useMemo(() => (items || []).map((f) => f.id).join('|'), [items]);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  useEffect(() => {
    // One character matches nearly everything; scanning a folder for it is
    // pure waste. The debounce keeps mid-word keystrokes from starting scans
    // that are immediately abandoned.
    if (q.length < 2) { setContentHits([]); setContentScanning(false); setContentError(''); return undefined; }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      // Files whose NAME already matched are shown in the section above — they
      // aren't scanned again here, so the two sections stay disjoint. The AI
      // pass considers every file (an image can only match by name/type), the
      // literal pass only what it can actually read: documents whose text we
      // can extract, plus recordings that already carry a transcript from the
      // Doc Viewer's captions.
      const candidates = (itemsRef.current || []).filter((f) => (
        f && f.kind !== 'folder' && f._raw?.path
        && !(f.name || '').toLowerCase().includes(q)
        && isSearchableFile(f._raw)
      )).map((f) => ({ item: f, file: f._raw }));
      if (!candidates.length) { setContentHits([]); setContentError(''); return; }
      setContentHits([]);
      setContentError('');
      setContentScanning(true);
      const byPath = new Map(candidates.map((c) => [c.file.path, c.item]));
      try {
        await searchContents(candidates.map((c) => c.file), q, {
          signal: controller.signal,
          // Append as they land so the section fills in progressively.
          onHit: (file, snippet) => {
            if (controller.signal.aborted) return;
            const item = byPath.get(file.path);
            if (!item) return;
            setContentHits((prev) => (prev.some((h) => h.item === item) ? prev : [...prev, { item, snippet }]));
          },
        });
      } catch (err) {
        if (!controller.signal.aborted) setContentError(err?.message || 'Search failed.');
      } finally {
        if (!controller.signal.aborted) setContentScanning(false);
      }
    }, 320);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [q, itemsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const searching = q.length > 0;
  // While searching the AI section is always rendered (it holds its own run
  // button), so a search never falls through to the "no matches" empty state.
  const totalShown = displayFolders.length + shownItems.length
    + (searching ? contentHits.length + aiHits.length + 1 : 0);

  // Category sections for the "Categorize" view — every displayed item bucketed
  // by itemCat, in FX_GROUPS order, empty sections dropped. The folders section
  // naturally lists real folders before archives (they come first in the union)
  // and each bucket keeps its A→Z order. Only built when grouping is on.
  const groups = useMemo(() => {
    if (!grouped) return [];
    const all = [...displayFolders, ...shownItems];
    return FX_GROUPS
      .map((g) => ({ ...g, items: all.filter((f) => itemCat(f) === g.key) }))
      .filter((g) => g.items.length > 0);
  }, [grouped, displayFolders, shownItems]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // PRELOADING: a file that is pointed at (held for a moment) or selected is
  // handed to the Doc Viewer to get ready (lib/platform prepareDocViewerFile →
  // main → the viewer's prepareViewerFile), so the double-click that follows
  // opens a prepared file. Plain files of the project only — not folders, the
  // Trash, or files still waiting to be accepted from a phone.
  const prepareItem = useCallback((item) => {
    if (!item || item.kind === 'folder' || item.binEntry || item.incoming || item.isWhatsApp) return;
    if (tab === 'trash') return;
    const raw = item._raw;
    if (!raw?.path) return;
    prepareDocViewerFile({ path: raw.path, name: raw.name || item.name, mime: raw.mimeType || '' });
  }, [tab]);
  useEffect(() => { if (selectedItem) prepareItem(selectedItem); }, [selectedItem, prepareItem]);
  const prepRef = useRef({ itemById, prepareItem, timer: 0, id: null });
  prepRef.current.itemById = itemById;
  prepRef.current.prepareItem = prepareItem;
  useEffect(() => {
    const st = prepRef.current;
    // Delegated, so the memoised tiles and rows need nothing new. A pointer
    // passing over the grid prepares nothing: only one that rests 250ms.
    const onOver = (e) => {
      const el = e.target?.closest?.('[data-fx-id]');
      const id = el && canvasRef.current?.contains(el) ? el.getAttribute('data-fx-id') : null;
      if (id === st.id) return;
      st.id = id;
      clearTimeout(st.timer);
      if (!id) return;
      st.timer = setTimeout(() => st.prepareItem(st.itemById.get(id)), 250);
    };
    document.addEventListener('mouseover', onOver);
    return () => { document.removeEventListener('mouseover', onOver); clearTimeout(st.timer); };
  }, []);

  // Visible order — the axis for Shift-range selection. In the categorize view
  // it follows the section layout so a range drag tracks what the eye sees;
  // otherwise the flat bin → folders → files order.
  const orderedIds = useMemo(
    () => {
      // Must mirror RENDER order — it's the axis Shift-range selection walks.
      if (searching) {
        return [...displayFolders, ...shownItems, ...contentHits.map((h) => h.item), ...aiHits.map((h) => h.item)]
          .map((f) => f.id);
      }
      return (grouped ? groups.flatMap((g) => g.items) : [...displayFolders, ...shownItems]).map((f) => f.id);
    },
    [searching, contentHits, aiHits, grouped, groups, displayFolders, shownItems],
  );

  // Click selection. Modifiers compose like Windows File Explorer:
  //   • plain          → select just this item (re-clicking KEEPS it selected;
  //                      empty-canvas click is what clears — see the canvas
  //                      onClick — matching Explorer)
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
    // Plain click — single select (Explorer keeps it selected on re-click;
    // clicking empty canvas is what clears).
    setMultiSel(new Set([id]));
    setAnchorId(id);
  };

  const clearSelection = () => { setMultiSel(new Set()); setAnchorId(null); };

  // Click-away deselect, WINDOW-wide. The canvas's own handler only covers the
  // grid's own row, so a click on the masthead, the page margin or anywhere
  // else on screen used to leave a file selected. Bound at the document instead
  // of stretching an invisible layer over the app: a real full-screen element
  // would have to swallow the click to see it, breaking everything under it.
  // Anything actionable is exempt — a toolbar button, a menu entry, a rename
  // input — since those operate ON the selection and must not lose it first.
  useEffect(() => {
    if (!multiSel.size) return undefined;   // nothing to clear — don't listen
    const onDocClick = (e) => {
      const t = e.target;
      if (!t || typeof t.closest !== 'function') return;
      if (t.closest('.fx-tile, .fx-list-row, button, a, input, textarea, select, [role="menuitem"], [contenteditable="true"]')) return;
      clearSelection();
    };
    // Bubble phase, so a tile's own onClick has already run and set the new
    // selection before this sees the event.
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, [multiSel.size]); // eslint-disable-line react-hooks/exhaustive-deps
  const exitSelectMode = () => { setSelectMode(false); clearSelection(); };
  const toggleSelectMode = () => {
    setSelectMode((on) => { if (on) clearSelection(); return !on; });
  };
  const bulkDelete = () => {
    if (!multiSelItems.length) return;
    if (onDeleteMany) onDeleteMany(multiSelItems);
    else multiSelItems.forEach((it) => onDelete?.(it));
    exitSelectMode();
  };
  const selectAll = () => { if (orderedIds.length) setMultiSel(new Set(orderedIds)); };

  // The press is heard DOCUMENT-wide (the latest handler through a ref, so it
  // sees the current selection and listing).
  const marqueeDownRef = useRef(null);
  useEffect(() => {
    const onDown = (e) => marqueeDownRef.current?.(e);
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  // ── Rubber-band selection (Windows Explorer / macOS Finder) ──────────────
  // A press ANYWHERE on the screen that is not something to press (a file, a
  // button, a field, a menu, the app sidebar, the title bar) and a drag draws
  // a translucent rectangle; every
  // tile / row it touches is selected as it grows. Ctrl/Cmd toggles what it
  // touches against the selection there was; Shift adds to it; plain replaces
  // it. Near the scroller's top or bottom edge the page scrolls on its own and
  // the rectangle follows (its corners are kept in CANVAS coordinates, which
  // move with the content). A press that never moves is an ordinary click —
  // the window-wide click-away still clears — while the click that ENDS a drag
  // is swallowed, so letting go keeps what was selected.
  // PERFORMANCE — the drag costs nothing React-side: no state is set until the
  // mouse is let go. The rectangle is ONE element made for the drag and moved
  // by transform (fixed, contained). What it touches is worked out from the
  // LAYOUT, not the DOM: the grid is windowed (VirtualCells), so most items
  // aren't drawn, and each block answers from its computed rows and columns
  // (hitTest) — a few reads a frame, before anything is written. Items outside
  // the windowed blocks (the search's content hits) are measured once when
  // the drag starts. What the rectangle touches is painted by toggling
  // `is-selected` on the items that ARE drawn, only where it changes (rows
  // drawn mid-drag, as it auto-scrolls, are painted as they arrive); and the
  // selection is handed to React on release (setMultiSel).
  // (Setting state every frame re-rendered the whole Files page and every tile
  // per mouse move, then forced a layout to measure them all again.)
  // Is there a character of text under the point? (The caret lands on the
  // nearest text even in empty space, so the character's own box is checked.)
  const pressOnText = (x, y) => {
    let node = null; let offset = 0;
    try {
      if (document.caretPositionFromPoint) { const p = document.caretPositionFromPoint(x, y); if (p) { node = p.offsetNode; offset = p.offset; } }
      else if (document.caretRangeFromPoint) { const r = document.caretRangeFromPoint(x, y); if (r) { node = r.startContainer; offset = r.startOffset; } }
    } catch { return false; }
    if (!node || node.nodeType !== Node.TEXT_NODE || !node.nodeValue?.trim()) return false;
    const range = document.createRange();
    for (const i of [offset - 1, offset]) {
      if (i < 0 || i >= node.nodeValue.length) continue;
      range.setStart(node, i); range.setEnd(node, i + 1);
      for (const rc of range.getClientRects()) if (x >= rc.left && x <= rc.right && y >= rc.top && y <= rc.bottom) return true;
    }
    return false;
  };
  const onCanvasMouseDown = (e) => {
    if (e.button !== 0 || bgMorph.isMenuOpen) return;
    const t = e.target;
    if (!t || typeof t.closest !== 'function') return;
    if (t.closest('.fx-tile, .fx-list-row, .fx-list-head, button, a, input, textarea, select, label, [role="menuitem"], [role="menu"], [role="dialog"], [contenteditable="true"], .fx-drop-overlay, .sidebar, .tb-bar, .tooltip, .lg-menu, .sd-drawer')) return;
    // A press ON TEXT is the start of a text selection, not of a box.
    if (pressOnText(e.clientX, e.clientY)) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const scroller = pageScroller();
    const cr0 = canvas.getBoundingClientRect();
    const st0 = scroller ? scroller.scrollTop : 0;
    const x0 = e.clientX; const y0 = e.clientY;
    const start = { x: toLayoutPx(x0 - cr0.left), y: toLayoutPx(y0 - cr0.top) };
    const mode = (e.ctrlKey || e.metaKey) ? 'toggle' : e.shiftKey ? 'add' : 'replace';
    const base = mode === 'replace' ? new Set() : new Set(multiSel);
    const idOf = new Map(orderedIds.map((id) => [String(id), id]));
    let last = { x: x0, y: y0 };
    let active = false;
    let frame = 0;
    let scrollFrame = 0;
    let statics = null;    // [{ id, x, y, w, h }] — boxes in canvas px, outside the windowed blocks
    let drawn = null;      // [{ el, id }] — the items drawn right now
    let drawnStale = true; // a block committed since `drawn` was read
    let side = null;       // the app sidebar's rect (it doesn't scroll)
    let box = null;        // the marquee element
    // Where the canvas is now: it only moves with the page's scroll.
    const canvasTop = () => cr0.top - ((scroller ? scroller.scrollTop : 0) - st0);
    const readDrawn = () => {
      drawn = [];
      canvas.querySelectorAll('[data-fx-id]').forEach((el) => {
        const id = idOf.get(el.getAttribute('data-fx-id'));
        if (id != null) drawn.push({ el, id });
      });
      drawnStale = false;
    };
    const begin = () => {
      statics = [];
      canvas.querySelectorAll('[data-fx-id]').forEach((el) => {
        if (el.closest('[data-fx-vbody]')) return;
        const id = idOf.get(el.getAttribute('data-fx-id'));
        if (id == null) return;
        const r = el.getBoundingClientRect();
        statics.push({
          id,
          x: toLayoutPx(r.left - cr0.left), y: toLayoutPx(r.top - cr0.top),
          w: toLayoutPx(r.width), h: toLayoutPx(r.height),
        });
      });
      // Rows drawn while dragging (auto-scroll) get painted on arrival.
      onRenderedRef.current = () => { drawnStale = true; if (!frame) frame = requestAnimationFrame(update); };
      const sr = document.querySelector('.sidebar')?.getBoundingClientRect();
      if (sr && sr.width) side = { x: toLayoutPx(sr.left), y: toLayoutPx(sr.top), w: toLayoutPx(sr.width), h: toLayoutPx(sr.height) };
      box = document.createElement('div');
      box.className = 'fx-marquee';
      box.setAttribute('aria-hidden', 'true');
      document.body.appendChild(box);
      document.body.classList.add('fx-marqueeing');
    };
    // The selection the rectangle makes: `base` with what it touches.
    const selectionFor = (rect, canvasRect) => {
      const next = new Set(base);
      const touch = (id) => {
        if (mode === 'toggle' && base.has(id)) next.delete(id); else next.add(id);
      };
      statics.forEach((it) => {
        if (it.x < rect.x + rect.w && it.x + it.w > rect.x && it.y < rect.y + rect.h && it.y + it.h > rect.y) touch(it.id);
      });
      for (const ref of vRegistryRef.current.values()) {
        for (const id of ref.current?.hitTest(rect, canvasRect) || []) touch(id);
      }
      return next;
    };
    let lastSel = null;
    const update = () => {
      frame = 0;
      // READ (layout is clean at the start of a frame)…
      const top = canvasTop();
      const cur = { x: toLayoutPx(last.x - cr0.left), y: toLayoutPx(last.y - top) };
      const rect = {
        x: Math.min(start.x, cur.x), y: Math.min(start.y, cur.y),
        w: Math.abs(cur.x - start.x), h: Math.abs(cur.y - start.y),
      };
      // What it touches (the blocks read their own rects) and what is drawn,
      // while layout is still clean…
      const next = selectionFor(rect, { left: cr0.left, top });
      if (drawnStale) readDrawn();
      // …then only write.
      const m = { x: toLayoutPx(cr0.left) + rect.x, y: toLayoutPx(top) + rect.y, w: rect.w, h: rect.h };
      box.style.transform = `translate(${m.x}px, ${m.y}px)`;
      box.style.width = `${m.w}px`;
      box.style.height = `${m.h}px`;
      // The app sidebar stays ON TOP of the rectangle: its rounded shape is
      // cut out of it (an even-odd clip path in the rectangle's coordinates).
      let clip = '';
      if (side) {
        const sx = side.x - m.x; const sy = side.y - m.y; const sw = side.w; const sh = side.h;
        if (sx < m.w && sx + sw > 0 && sy < m.h && sy + sh > 0) {
          const r = Math.min(9.6, sw / 2, sh / 2);
          clip = `path(evenodd, 'M0 0 H${m.w} V${m.h} H0 Z `
            + `M${sx + r} ${sy} H${sx + sw - r} A${r} ${r} 0 0 1 ${sx + sw} ${sy + r} V${sy + sh - r} A${r} ${r} 0 0 1 ${sx + sw - r} ${sy + sh} `
            + `H${sx + r} A${r} ${r} 0 0 1 ${sx} ${sy + sh - r} V${sy + r} A${r} ${r} 0 0 1 ${sx + r} ${sy} Z')`;
        }
      }
      if (box.style.clipPath !== clip) box.style.clipPath = clip;
      drawn.forEach((it) => {
        const on = next.has(it.id);
        if (on !== it.el.classList.contains('is-selected')) it.el.classList.toggle('is-selected', on);
      });
      lastSel = next;
    };
    // Auto-scroll while the pointer is near (or past) the scroller's edge.
    const autoScroll = () => {
      scrollFrame = 0;
      if (!active || !scroller) return;
      const r = scroller.getBoundingClientRect();
      const EDGE = 36;
      let dy = 0;
      if (last.y < r.top + EDGE) dy = -Math.ceil((r.top + EDGE - last.y) / 3);
      else if (last.y > r.bottom - EDGE) dy = Math.ceil((last.y - (r.bottom - EDGE)) / 3);
      if (dy) {
        scroller.scrollTop += Math.max(-40, Math.min(40, dy));
        if (!frame) frame = requestAnimationFrame(update);
        scrollFrame = requestAnimationFrame(autoScroll);
      }
    };
    // A wheel scroll mid-drag moves the canvas under the rectangle too.
    const onScroll = () => { if (active && !frame) frame = requestAnimationFrame(update); };
    const move = (ev) => {
      last = { x: ev.clientX, y: ev.clientY };
      if (!active) {
        if (Math.abs(ev.clientX - x0) < 4 && Math.abs(ev.clientY - y0) < 4) return;
        active = true;
        begin();
      }
      ev.preventDefault();
      if (!frame) frame = requestAnimationFrame(update);
      if (!scrollFrame) scrollFrame = requestAnimationFrame(autoScroll);
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      scroller?.removeEventListener('scroll', onScroll);
      if (frame) cancelAnimationFrame(frame);
      if (scrollFrame) cancelAnimationFrame(scrollFrame);
      if (!active) return;
      onRenderedRef.current = null;
      update();
      box?.remove();
      document.body.classList.remove('fx-marqueeing');
      // Now React: the selection on screen becomes the state.
      const sel = lastSel || new Set(base);
      setMultiSel(sel);
      const firstHit = orderedIds.find((id) => sel.has(id) && !base.has(id));
      if (firstHit != null) setAnchorId(firstHit);
      // The click this release produces must not reach the click-away.
      const swallow = (ce) => { ce.stopPropagation(); };
      window.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    scroller?.addEventListener('scroll', onScroll, { passive: true });
  };
  marqueeDownRef.current = onCanvasMouseDown;

  // Grid column count (1 in list view) — the windowed grid's own count (it
  // sets the columns itself), so arrow Up/Down move by a true row.
  const getColumns = () => (view === 'list' ? 1 : Math.max(1, colsRef.current || 1));

  // Arrow-key navigation, Explorer-style. Plain arrows move the single
  // selection; Shift+arrow extends the range from the anchor. Up/Down step a
  // full row in grid view; Home/End jump to the first/last item.
  const navigateSelection = (key, shift) => {
    const ids = orderedIds;
    if (!ids.length) return;
    const cols = getColumns();
    let cur = anchorId != null ? ids.indexOf(anchorId) : -1;
    if (cur < 0 && multiSel.size) cur = ids.indexOf([...multiSel][multiSel.size - 1]);
    let target;
    if (cur < 0) {
      target = (key === 'ArrowUp' || key === 'ArrowLeft' || key === 'End') ? ids.length - 1 : 0;
    } else if (key === 'ArrowRight') target = cur + 1;
    else if (key === 'ArrowLeft') target = cur - 1;
    else if (key === 'ArrowDown') target = cur + cols;
    else if (key === 'ArrowUp') target = cur - cols;
    else if (key === 'Home') target = 0;
    else if (key === 'End') target = ids.length - 1;
    else target = cur;
    if (target < 0 || target >= ids.length) {
      // Up/Down clamp to the ends; Left/Right past an edge is a no-op.
      if (key === 'ArrowDown' || key === 'ArrowUp') target = Math.max(0, Math.min(ids.length - 1, target));
      else return;
    }
    const targetId = ids[target];
    if (shift && anchorId != null) {
      const a = ids.indexOf(anchorId);
      const [lo, hi] = a <= target ? [a, target] : [target, a];
      setMultiSel(new Set(ids.slice(lo, hi + 1)));
    } else {
      setMultiSel(new Set([targetId]));
      setAnchorId(targetId);
    }
    // The target may be far off-screen and not drawn at all: scrolled to from
    // the computed layout (VirtualCells), then placed exactly once drawn.
    requestAnimationFrame(() => scrollToItem(targetId));
  };

  // Opening an archive can't do what "open" normally does — there's nothing to
  // preview inside a .zip — so it asks first, in a card pinned to the pointer.
  // Every open path funnels through here (double-click, the menu's "Open", the
  // toolbar button, Enter), so the prompt can't be bypassed by one of them.
  // The bin is excluded: a trashed archive has no live path to extract to. So
  // is a recognised WhatsApp export — it's a .zip, but double-clicking it has
  // always opened the reconstructed conversation, which IS a useful preview.
  const openItem = (item, e) => {
    if (tab !== 'trash' && item && item.kind !== 'folder' && !isWhatsAppExport(item)
        && item._raw?.path && extCategory(item.ext) === 'zip') {
      setArchivePrompt({ item, x: e?.clientX ?? null, y: e?.clientY ?? null });
      return;
    }
    if (tab !== 'trash' && item && !item.incoming) markOpened(openKeyOf(item));
    onOpen?.(item);
  };

  // Latest handlers/state for the global key listener (avoids re-binding it).
  kbdRef.current = {
    hasSelection: multiSel.size > 0,
    oneSelected: !!selectedItem,
    canUp,
    menuEditable,
    deleteSelection: bulkDelete,
    renameSelected: () => { if (selectedItem) requestRename(selectedItem); },
    openSelected: () => { if (selectedItem) openItem(selectedItem); },
    selectAll,
    clearSelection,
    navigateSelection,
    onUp: () => onUp?.(),
  };

  // ── Clipboard (copy / paste) + drag-to-move ─────────────────────────────
  // `clipboard` holds copied file descriptors [{ name, path }]; it survives
  // folder navigation (this component stays mounted) so you can copy in one
  // folder and paste in another. Copy/paste + move are drafts-only.
  const fileItemsFrom = (list) => list.filter((it) => it && it.kind !== 'folder' && it._raw?.path).map((it) => ({ name: it.name, path: it._raw.path }));
  const pickedForClipboard = () => fileItemsFrom(multiSelItems.length ? multiSelItems : (selectedItem ? [selectedItem] : []));
  const copySelection = () => {
    if (!menuEditable) return;
    const picked = pickedForClipboard();
    if (picked.length) setClipboard({ mode: 'copy', items: picked });
  };
  const cutSelection = () => {
    if (!menuEditable || !onMoveItems) return;
    const picked = pickedForClipboard();
    if (picked.length) setClipboard({ mode: 'cut', items: picked });
  };
  const pasteHere = () => {
    if (!clipboard?.items?.length) return;
    if (clipboard.mode === 'cut') {
      if (onPasteCut) onPasteCut(clipboard.items);
      setClipboard(null); // a cut is consumed by the paste
    } else if (onPasteItems) {
      onPasteItems(clipboard.items);
    }
  };
  // Context-menu copy/cut act on the right-clicked item — or the whole
  // selection when that item is part of it.
  const itemsForContext = (item) => fileItemsFrom(multiSel.has(item.id) && multiSelItems.length > 1 ? multiSelItems : [item]);
  const copyItem = (item) => { if (!menuEditable) return; const picked = itemsForContext(item); if (picked.length) setClipboard({ mode: 'copy', items: picked }); };
  const cutItem = (item) => { if (!menuEditable || !onMoveItems) return; const picked = itemsForContext(item); if (picked.length) setClipboard({ mode: 'cut', items: picked }); };
  const canPaste = !!clipboard?.items?.length && (clipboard.mode === 'cut' ? !!onPasteCut : !!onPasteItems);

  // Right-click on empty canvas → a morph menu with Paste / Import / Create /
  // Open directory (drafts only). "Import" is a single action (import files);
  // "Create" expands an inline submenu mirroring the footer Create button
  // (New folder, Add identity, Document).
  const bgMorph = useMorphPill({
    // No hover tooltip precedes this one, so there's nothing to morph FROM —
    // the scale-up just made the menu look like it took 220ms to appear.
    instant: true,
    hoverContent: '',
    menuItems: [
      menuEditable && canPaste && { key: 'paste', label: clipboard?.items?.length > 1 ? `Paste ${clipboard.items.length} items` : 'Paste', onClick: () => pasteHere() },
      menuEditable && { key: 'import', label: 'Import', onClick: () => onUpload?.() },
      menuEditable && {
        key: 'create',
        label: 'Create',
        submenu: [
          { key: 'newfolder', label: <><Icon name="folder-plus" className="fx-icon" /> New folder</>, onClick: () => requestNewFolder() },
          // One entry, no type: the file is created without an extension and
          // becomes Word / PowerPoint / Excel / PDF from what the user asks for.
          onCreateTypedFile && { key: 'document', label: <><Icon name="file-doc" className="fx-icon" /> Document</>, onClick: () => onCreateTypedFile('auto') },
          // A PDF is made FROM a document: opening it asks which one to convert.
          onCreateTypedFile && { key: 'pdf', label: <><Icon name="file-pdf" className="fx-icon" /> PDF</>, onClick: () => onCreateTypedFile('pdf') },
        ].filter(Boolean),
      },
      onOpenDirectory && { key: 'opendir', label: 'Open directory', onClick: () => onOpenDirectory() },
    ],
  });
  actionsRef.current = { copySelection, cutSelection, pasteHere, hasCopyable: menuEditable && (multiSel.size > 0 || !!selectedItem), canCut: menuEditable && !!onMoveItems && (multiSel.size > 0 || !!selectedItem), canPaste };

  // ── Background right-click (New folder / Import) ────────────────────────
  // Bound to the DOCUMENT, so a right-click anywhere in the window opens it.
  // Element-scoped versions kept leaving dead zones: the canvas is one track of
  // a grid and only as wide as the file content, and .fx-page is capped at
  // --content-max-width, so on a wide window the gutter beside the content had
  // no handler at all.
  //
  // Right-clicking again while it's open just re-anchors it — handleContextMenu
  // rewrites the position, it doesn't toggle — so the menu follows the pointer
  // rather than needing to be dismissed first.
  //
  // Three exemptions, and they're all load-bearing:
  //   • tiles / rows      — they have their own item menus. They stop
  //                         propagation natively too, so this rarely even sees
  //                         them; the check is belt and braces.
  //   • the menu itself   — it's portalled to <body>, i.e. OUTSIDE React's root
  //                         container, so its events do reach this listener.
  //                         Without this, right-clicking a menu entry would
  //                         re-open the menu on top of itself.
  //   • text fields       — keep the platform's own editing menu.
  // The handler is read through a ref, refreshed every render. Binding
  // bgMorph.handleContextMenu directly would freeze the closure from whichever
  // render registered the listener, so a SECOND right-click ran against stale
  // menu state — which is what made the reopened menu come up broken.
  const bgMenuRef = useRef(null);
  bgMenuRef.current = bgMorph.handleContextMenu;
  useEffect(() => {
    if (!menuEditable) return undefined;
    const onMenu = (e) => {
      const t = e.target;
      if (!t || typeof t.closest !== 'function') return;
      if (t.closest('.project-files-morph-pill, .fx-tile, .fx-list-row, input, textarea, [contenteditable="true"]')) return;
      // Only THIS page's background: never the app sidebar, the title bar, a
      // drawer, a tooltip / menu or a dialog — they are not the Files page.
      if (t.closest('.sidebar, .tb-bar, .sd-drawer, .tooltip, .lg-menu, [role="dialog"], [role="menu"]')) return;
      // The page's own scroller (the empty space around the grid included).
      const page = pageRef.current?.closest('.sv-single-scroll') || pageRef.current;
      if (page && !page.contains(t)) return;
      bgMenuRef.current?.(e);
    };
    document.addEventListener('contextmenu', onMenu);
    return () => document.removeEventListener('contextmenu', onMenu);
  }, [menuEditable]); // eslint-disable-line react-hooks/exhaustive-deps

  // On-disk path of an item — files carry it on `_raw`, folders on `_dir`.
  const itemDiskPath = (it) => it?._raw?.path || it?._dir?.path || null;

  // The id set being dragged — the current selection if the grabbed item is
  // part of it, else just that item. Both files AND folders can be dragged to
  // move (the Recycle bin entry can't); file-only consumers (chat/AI) skip the
  // folders by kind.
  const dragPayloadFor = (item) => {
    const inSel = multiSel.has(item.id);
    const base = inSel ? multiSelItems : [item];
    return base.filter((it) => it && !it.binEntry && itemDiskPath(it));
  };

  // Drag source — file/folder tiles/rows publish a docvex payload that a folder
  // or breadcrumb (→ move) and a chat composer (→ attach) can read. Drafts only.
  const beginItemDrag = (item, e) => {
    if (!menuEditable) return;
    // Normalise to a flat { name, path, kind } shape — every drop consumer
    // reads a top-level `d.path`; `kind` lets a move recreate a folder while
    // file-only consumers (chat / AI composers) drop the folders.
    const rich = dragPayloadFor(item);
    const picked = rich.map((it) => ({ name: it.name, path: itemDiskPath(it), kind: it.kind === 'folder' ? 'folder' : 'file' }));
    if (!picked.length) { e.preventDefault(); return; }
    // The grid is windowed: keep the dragged items' rows drawn while the page
    // scrolls under the drag, or the source would unmount and the drag never
    // end (dragend fires on the source element).
    dragPinRef.current = [item.id, ...rich.map((it) => it.id)];
    pinnedRef.current = new Set([...pinnedRef.current, ...dragPinRef.current]);
    // Publish the rich models (descriptor + name + kind) so drop targets can
    // preview the drag live (dragover can't read dataTransfer data).
    setDraggedFiles(rich.map((it) => ({ name: it.name, path: itemDiskPath(it), kind: it.kind === 'folder' ? 'folder' : 'file', descriptor: it.descriptor })));
    try {
      e.dataTransfer.setData('application/x-docvex-files', JSON.stringify({ items: picked }));
      e.dataTransfer.setData('text/plain', picked.map((p) => p.name).join('\n'));
      e.dataTransfer.effectAllowed = 'copyMove';
    } catch { /* setData can throw in odd states */ }
  };
  const endItemDrag = () => { dragPinRef.current = []; clearDraggedFiles(); };

  // True when `target` is `folderPath` itself or sits inside it — blocks
  // dropping a folder onto itself or into one of its own descendants.
  const isSelfOrDescendant = (target, folderPath) => {
    if (!target || !folderPath) return false;
    return target === folderPath || target.startsWith(`${folderPath}/`) || target.startsWith(`${folderPath}\\`);
  };
  // Map a serialized drag item back to the { name, kind, _raw|_dir } shape the
  // move handlers expect.
  const dropItemFromData = (d) => (d.kind === 'folder'
    ? { name: d.name, kind: 'folder', _dir: { path: d.path } }
    : { name: d.name, kind: 'file', _raw: { path: d.path } });

  // Folder drop target — moving dragged files/folders into that folder.
  const dragHasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('application/x-docvex-files');
  // Reconstruct a serialized drag item into the { name, kind, _raw|_dir } shape
  // the delete handler reads (path AND name on the inner object).
  const deleteItemFromData = (d) => (d.kind === 'folder'
    ? { name: d.name, kind: 'folder', _dir: { path: d.path, name: d.name } }
    : { name: d.name, kind: 'file', _raw: { path: d.path, name: d.name } });
  const onFolderDragOver = (folder, e) => {
    // The Recycle bin entry is a drop target for delete: drop files/folders on
    // it to move them to the trash.
    if (folder.binEntry) {
      if (!onDelete || !dragHasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (dropFolderId !== folder.id) setDropFolderId(folder.id);
      return;
    }
    if (!onMoveItems || !dragHasFiles(e)) return;
    // Don't accept a folder dropped onto itself / its own descendants — the
    // live payload comes from the drag bus since dragover can't read dataTransfer.
    const targetPath = folder._dir?.path;
    const dragged = getDraggedFiles();
    if (dragged && dragged.some((d) => d.kind === 'folder' && isSelfOrDescendant(targetPath, d.path))) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dropFolderId !== folder.id) setDropFolderId(folder.id);
  };
  const onFolderDragLeave = (folder) => { setDropFolderId((cur) => (cur === folder.id ? null : cur)); };
  const onFolderDrop = (folder, e) => {
    // Drop on the Recycle bin entry → delete (move each dragged item to trash).
    if (folder.binEntry) {
      if (!onDelete || !dragHasFiles(e)) return;
      e.preventDefault();
      setDropFolderId(null);
      let data = null;
      try { data = JSON.parse(e.dataTransfer.getData('application/x-docvex-files')); } catch { /* malformed */ }
      const toDelete = (data?.items || []).filter((d) => d?.path).map(deleteItemFromData);
      if (onDeleteMany && toDelete.length > 1) onDeleteMany(toDelete);
      else toDelete.forEach((it) => onDelete(it));
      return;
    }
    if (!onMoveItems || !dragHasFiles(e)) return;
    e.preventDefault();
    setDropFolderId(null);
    let data = null;
    try { data = JSON.parse(e.dataTransfer.getData('application/x-docvex-files')); } catch { /* malformed */ }
    const targetPath = folder._dir?.path;
    const items = (data?.items || [])
      .filter((d) => d?.path)
      .filter((d) => !(d.kind === 'folder' && isSelfOrDescendant(targetPath, d.path)))
      .map(dropItemFromData);
    if (items.length) onMoveItems(items, folder);
  };

  // Breadcrumb drop target — moving dragged files into an ancestor folder by
  // dropping on its crumb. The current (last) crumb is skipped (no-op).
  const onCrumbDragOver = (crumb, isLast, e) => {
    if (!onMoveToCrumb || isLast || !dragHasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dropCrumb !== crumb.path) setDropCrumb(crumb.path);
  };
  const onCrumbDragLeave = (crumb) => { setDropCrumb((cur) => (cur === crumb.path ? null : cur)); };
  const onCrumbDrop = (crumb, isLast, e) => {
    if (!onMoveToCrumb || isLast || !dragHasFiles(e)) return;
    e.preventDefault();
    setDropCrumb(null);
    let data = null;
    try { data = JSON.parse(e.dataTransfer.getData('application/x-docvex-files')); } catch { /* malformed */ }
    const items = (data?.items || []).filter((d) => d?.path).map(dropItemFromData);
    if (items.length) onMoveToCrumb(crumb, items);
  };

  // Common props every Tile/Row needs.
  // PERFORMANCE — Tile and Row are memoised, so a selection change, a drop
  // target moving or a menu opening redraws only the tiles it concerns instead
  // of every tile in a folder of thousands. For that the props below must keep
  // their identity between renders: every handler goes through a stable
  // wrapper that calls the LATEST one (the ref is refreshed each render, so a
  // click still runs against the current selection and listing, exactly as an
  // unmemoised tile did), and the per-item values are narrowed to what that
  // tile actually shows. A handler that is ABSENT stays absent (null), since
  // the menus decide whether to offer Copy / Cut / Tag by its presence.
  const itemLatestRef = useRef(null);
  itemLatestRef.current = {
    onIncoming,
    onSelect,
    onOpen: openItem,
    onOpenContent,
    onRename: requestRename,
    onOpenLocation, onDelete, onRestore, onEmptyBin,
    onBulkDelete: bulkDelete,
    onCopy: copyItem,
    onCut: cutItem,
    beginItemDrag,
    endItemDrag,
    onFolderDragOver,
    onFolderDragLeave,
    onFolderDrop,
    onSetColor: setFolderColor,
    commitRename,
    cancelRename,
  };
  const itemFns = useMemo(() => {
    const via = (k) => (...args) => itemLatestRef.current[k]?.(...args);
    return {
      onIncoming: via('onIncoming'),
      onSelect: via('onSelect'),
      onOpen: via('onOpen'),
      onOpenContent: via('onOpenContent'),
      onRename: via('onRename'),
      onOpenLocation: via('onOpenLocation'),
      onDelete: via('onDelete'),
      onRestore: via('onRestore'),
      onEmptyBin: via('onEmptyBin'),
      onBulkDelete: via('onBulkDelete'),
      onCopy: via('onCopy'),
      onCut: via('onCut'),
      beginItemDrag: via('beginItemDrag'),
      endItemDrag: via('endItemDrag'),
      onFolderDragOver: via('onFolderDragOver'),
      onFolderDragLeave: via('onFolderDragLeave'),
      onFolderDrop: via('onFolderDrop'),
      onSetColor: via('onSetColor'),
      commitRename: via('commitRename'),
      cancelRename: via('cancelRename'),
    };
  }, []);
  // Files currently "cut" to the clipboard render dimmed (Explorer-style).
  // Built once per clipboard, not per render, so the tiles' memo holds.
  const cutPaths = useMemo(
    () => (clipboard?.mode === 'cut' ? new Set(clipboard.items.map((i) => i.path)) : null),
    [clipboard],
  );
  const itemCommon = {
    tab,
    onIncoming: itemFns.onIncoming,
    incomingCount: (items || []).filter((i) => i.incoming).length,
    onSelect: itemFns.onSelect,
    onOpen: itemFns.onOpen,
    onOpenContent: itemFns.onOpenContent,
    onRename: itemFns.onRename,
    onProperties: setPropsItem,
    onOpenLocation: itemFns.onOpenLocation,
    onDelete: itemFns.onDelete,
    onRestore: itemFns.onRestore,
    onEmptyBin: itemFns.onEmptyBin,
    canEdit: menuEditable,
    selectMode,
    onBulkDelete: itemFns.onBulkDelete,
    onCopy: onPasteItems ? itemFns.onCopy : null,
    onCut: onMoveItems ? itemFns.onCut : null,
    // Drag-to-move: file items are draggable; non-bin folders accept drops.
    draggable: menuEditable,
    beginItemDrag: itemFns.beginItemDrag,
    endItemDrag: itemFns.endItemDrag,
    onFolderDragOver: itemFns.onFolderDragOver,
    onFolderDragLeave: itemFns.onFolderDragLeave,
    onFolderDrop: itemFns.onFolderDrop,
    // Per-folder icon colour map + setter (for the right-click colour swatches).
    folderColors,
    onSetColor: itemFns.onSetColor,
    cutPaths,
  };

  // One item → a Tile / Row, with the shared selection + rename wiring. Used by
  // both the flat grid/list and the per-section grids/lists in categorize mode.
  // The selection count only matters to a SELECTED item's menu ("Delete 3
  // items"), and the drop target only to the folder under the drag, so every
  // other tile is handed the same values and its memo holds. Only the tile
  // being renamed gets a commit handler of its own.
  const bulkCount = multiSelItems.length;
  const perItem = (f) => {
    const sel = multiSel.has(f.id);
    const renaming = renamingId === f.id;
    return {
      selected: sel,
      isMultiSelected: sel,
      bulkCount: sel ? bulkCount : 0,
      dropFolderId: dropFolderId === f.id ? dropFolderId : null,
      renaming,
      onCommitName: renaming ? (name) => itemFns.commitRename(f, name) : undefined,
      onCancelName: itemFns.cancelRename,
    };
  };
  const renderTile = (f) => (
    <Tile key={f.id} item={f} {...perItem(f)} {...itemCommon} />
  );
  const renderRow = (f) => (
    <Row key={f.id} item={f} {...perItem(f)} {...itemCommon} />
  );
  // One cell of a windowed block: an item, or the new-folder / new-file draft.
  const renderCell = (c) => {
    if (c === NEW_FOLDER_CELL) {
      return view === 'tiles'
        ? <NewFolderTile key={c.id} onCommit={commitNewFolder} onCancel={cancelNewFolder} />
        : <NewFolderRow key={c.id} onCommit={commitNewFolder} onCancel={cancelNewFolder} />;
    }
    if (c === NEW_FILE_CELL) {
      return view === 'tiles'
        ? <NewFileTile key={c.id} onCommit={commitNewFile} onCancel={cancelNewFile} />
        : <NewFileRow key={c.id} onCommit={commitNewFile} onCancel={cancelNewFile} />;
    }
    return view === 'tiles' ? renderTile(c) : renderRow(c);
  };
  // The flat view's cells, in render order: the Recycle bin, the drafts,
  // folders, files. Memoised so the windowed block's index holds.
  const flatCells = useMemo(() => [
    ...binFolders,
    ...(creatingFolder ? [NEW_FOLDER_CELL] : []),
    ...(creatingFile ? [NEW_FILE_CELL] : []),
    ...shownFolders,
    ...shownItems,
  ], [binFolders, creatingFolder, creatingFile, shownFolders, shownItems]);
  const nameCells = useMemo(() => [...displayFolders, ...shownItems], [displayFolders, shownItems]);
  // The item being renamed keeps its row drawn (plus any being dragged).
  pinnedRef.current = new Set([renamingId, ...dragPinRef.current].filter((x) => x != null));
  const vProps = {
    renderCell,
    mode: view,
    tileSize,
    registry: vRegistryRef.current,
    pinnedRef,
    onRenderedRef,
    onCols,
    getScroller,
  };

  const emptyHint = {
    drafts: 'No files in your folder yet. Add or import files and they’ll show up here.',
    trash: 'Files you delete wait in the trash for 30 days before they’re removed for good.',
  }[tab];

  // List view shows its column header INSIDE the window chrome (same bar/section
  // as the search), aligned with the full-bleed rows below — so it renders only
  // when the list is actually populated.
  // Graph and Insights take the canvas's place (both read the AI scan).
  const showListHead = view === 'list' && hasLocalFolder && !loading && (totalShown > 0 || creatingFolder || creatingFile);

  // Folder toolbar — nav + breadcrumb + search (+ the list column header in
  // list view). Rendered INTO the window chrome's row-2 slot when available
  // (one merged bar); falls back to an in-page pathbar row if there's no chrome.
  const toolbar = (
    <>
      <div className={"fx-chrome-tools"}>
        <div className="fx-pathbar-nav">
          {onRefresh && (
            <Tooltip content="Refresh"><button onClick={() => onRefresh()}><Icon name="refresh" size={14} /></button></Tooltip>
          )}
          <Tooltip content="Back"><button onClick={() => onBack?.()} disabled={!canBack}><Icon name="chev-left" size={14} /></button></Tooltip>
          <Tooltip content="Forward"><button disabled><Icon name="chev-right" size={14} /></button></Tooltip>
        </div>
        <nav className="fx-crumbs" aria-label="Folder path">
          {(crumbs || []).map((cr, i) => {
            const isLast = i === crumbs.length - 1;
            // Every crumb carries a glyph for the surface it points at: the
            // Recycle bin gets its trash can; the root and every directory a
            // folder (the root's is filled, matching the Files-tab tiles).
            const crumbIcon = cr.path === '__bin' ? 'trash' : 'folder';
            return (
              <React.Fragment key={cr.path ?? i}>
                {i > 0 && <Icon name="chev-right" size={12} className="fx-crumb-sep" />}
                <Tooltip content={cr.label}>
                  <button
                    type="button"
                    className={`fx-crumb${i === 0 ? ' is-root' : ''}${isLast ? ' is-current' : ''}${dropCrumb === cr.path && !isLast ? ' is-droptarget' : ''}`}
                    onClick={isLast ? undefined : () => onCrumb?.(cr.path)}
                    onDragOver={(e) => onCrumbDragOver(cr, isLast, e)}
                    onDragLeave={() => onCrumbDragLeave(cr)}
                    onDrop={(e) => onCrumbDrop(cr, isLast, e)}
                  >
                    {/* Every crumb glyph uses the FILLED variant — folders
                        included (no hollow icons); Trash matches the Files
                        tab's bin glyph, tinted gray. */}
                    <Icon name={crumbIcon} size={i === 0 ? 16 : 14} className={`fx-crumb-icon${crumbIcon === 'trash' ? ' is-trash' : ''}`} filled />
                    <span className="fx-crumb-label">{cr.label}</span>
                  </button>
                </Tooltip>
              </React.Fragment>
            );
          })}
        </nav>
        <div style={{ flex: 1 }} />
        {/* Icon-size slider — drives the same tileSize as Ctrl+scroll zoom
            (smallest size flips to the list view). Sits just left of search. */}
        <Tooltip content="Icon size">
          <div className="fx-size-slider">
            <span className="fx-size-dot fx-size-dot-sm" aria-hidden="true" />
            <input
              type="range"
              className="fx-size-range"
              min={FX_MIN_TILE}
              max={FX_MAX_TILE}
              step={2}
              value={tileSize}
              onChange={(e) => setTileSize(Number(e.target.value))}
              aria-label="Icon size"
            />
            <span className="fx-size-dot fx-size-dot-lg" aria-hidden="true" />
          </div>
        </Tooltip>
        {/* Grid ⇄ list toggle — the icon reflects the CURRENT view and flips
            with it. Drives the same tileSize the slider / Ctrl+scroll use:
            the list side snaps to the smallest step, the grid side to the
            default tile size. Sits beside the categorize button. */}
        <Tooltip content={view === 'list' ? 'Switch to grid view' : 'Switch to list view'}>
          <button
            type="button"
            className="fx-cat-btn fx-view-btn"
            aria-label={view === 'list' ? 'Switch to grid view' : 'Switch to list view'}
            onClick={() => setTileSize(view === 'list' ? FX_LIST_THRESHOLD : FX_MIN_TILE)}
          >
            {/* Filled + accent, matching the file glyphs in the thumbs below —
                the view switch reads as part of the same icon family rather
                than a stroked outlier. */}
            <Icon name={view === 'list' ? 'list' : 'grid'} size={14} filled />
          </button>
        </Tooltip>
        {/* Sort — the order of folders and files (FX_SORTS); the app's own
            dropdown (LegalBar's BarPicker, standing on its own). */}
        <div className="fx-sort">
          <BarPicker solo label="Sort" options={FX_SORTS} value={sortBy} onChange={setSortBy} />
        </div>
        {/* Categorize — split the listing into labelled category sections
            (folders & archives, media, Office docs, the Recycle bin, then
            other files) stacked vertically. Toggle. Available in the Recycle
            bin too — trashed items bucket by the same type categories. */}
        <Tooltip content={grouped ? 'Show as one list' : 'Group by category'}>
          <button
            type="button"
            className={`fx-cat-btn${grouped ? ' is-active' : ''}`}
            aria-label="Group by category"
            aria-pressed={grouped}
            onClick={() => setGrouped((v) => !v)}
          >
            {/* Filled + accent (the folder colour) when active. */}
            <Icon name="categories" size={14} filled={grouped} />
          </button>
        </Tooltip>
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
            <Tooltip content="Clear search">
              <button
                type="button"
                className="fx-search-clear"
                aria-label="Clear search"
                onClick={() => { setQuery(''); searchRef.current?.focus(); }}
              >
                <Icon name="close" size={13} strokeWidth={2} />
              </button>
            </Tooltip>
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
    <div
      className="fx-page"
      ref={pageRef}
      // No handlers here: the background right-click menu and the click-away
      // deselect are both bound at the document (see the effects above), so
      // neither is limited to this element's box.
    >
      {chromeSlotEl && createPortal(toolbar, chromeSlotEl)}
      {/* Masthead — Versions-style hero (the page is chromeless on /files, so
          this is the page title). The whole page scrolls, so it simply scrolls
          away; the sticky nav strip below carries the title once it's gone. */}
      {masthead && (
        <header className="fx-masthead">
          <div className="fx-mh-eyebrow">
            <span>{masthead.eyebrow}</span>
            {masthead.access && <span className="fx-mh-muted">· {masthead.access}</span>}
          </div>
          <h1 className="fx-mh-title">{masthead.title}</h1>
          {masthead.kicker && <p className="fx-mh-kicker">{masthead.kicker}</p>}
        </header>
      )}
      <div className="fx-window">
        {!chromeSlotEl && (
          <>
            <FilesPathbar getScroller={pageScroller} enabled={!!masthead} deps={[hasLocalFolder, loading, view]}>{toolbar}</FilesPathbar>
          </>
        )}

        {/* Canvas */}
        <div
          className={`fx-canvas${dragOver ? ' fx-canvas--drag' : ''}`}
          ref={canvasRef}
          style={{ '--fx-tile': `${tileSize}px`, ...(listRowVars || {}) }}
          onClick={(e) => {
            // A click anywhere in the canvas dismisses the background menu — the
            // grid/list fills the canvas, so empty-area clicks land on it, not
            // the canvas node.
            if (bgMorph.isMenuOpen) bgMorph.closeMenu();
            // Deselection isn't handled here — the document-level click-away
            // above covers the whole window, this row included.
          }}
          // No onContextMenu here — .fx-page owns the background menu so it
          // covers the whole surface, not just this grid track.
          onDragEnter={onDropFiles ? (e) => { if (Array.from(e.dataTransfer?.types || []).includes('Files')) { e.preventDefault(); setDragOver(true); } } : undefined}
          onDragOver={onDropFiles ? (e) => { if (Array.from(e.dataTransfer?.types || []).includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; if (!dragOver) setDragOver(true); } } : undefined}
          onDragLeave={onDropFiles ? (e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDragOver(false); } : undefined}
          onDrop={onDropFiles ? (e) => { e.preventDefault(); setDragOver(false); const dt = e.dataTransfer; collectDropEntries(dt).then((entries) => { if (entries.length) onDropFiles(entries); }); } : undefined}
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
              // The project's folder is found by its project file; this asks
              // for it only when it isn't where this machine last had it.
              <div className="fx-empty">
                <Icon name="folder" className="fx-icon" strokeWidth={1.2} />
                <h3>{pickFolderCopy?.title || 'Connect a folder to start'}</h3>
                <p>{pickFolderCopy?.body || 'Pick a folder on your computer — that’s where this project’s files live.'}</p>
                <button className="fx-btn-primary" onClick={() => onPickFolder?.()}><Icon name="folder" size={14} /> {pickFolderCopy?.button || 'Choose folder'}</button>
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
          ) : (totalShown === 0 && !contentScanning && !creatingFolder && !creatingFile) ? (
            // While the content pass is still running there may yet be hits —
            // claiming "no matches" and then filling in behind it would be a lie.
            <div className="fx-empty">
              <Icon name={isBin ? 'trash' : 'inbox'} className="fx-icon" strokeWidth={1.2} />
              <h3>{q ? 'No matches' : (isBin ? 'Trash is empty' : 'Nothing here yet')}</h3>
              <p>{q ? `Nothing matches “${query}” by name or content.` : emptyHint}</p>
            </div>
          ) : searching ? (
            // Search view — two labelled sections, using the Categorize view's
            // section chrome so a divider means the same thing everywhere.
            // Name matches first (they're instant); content matches below,
            // filling in as the background scan reads each file.
            <div className="fx-cat-groups">
              {(displayFolders.length + shownItems.length) > 0 && (
                <section className="fx-cat-section">
                  <div className="fx-cat-head">
                    <Icon name="a" className="fx-cat-head-ico" size={13} />
                    <span className="fx-cat-head-label">By name</span>
                    <span className="fx-cat-head-count">{displayFolders.length + shownItems.length}</span>
                  </div>
                  <VirtualCells key={`search:${view}`} blockKey="search" cells={nameCells} {...vProps} />
                </section>
              )}
              {(contentHits.length > 0 || contentScanning || contentError) && (
                <section className="fx-cat-section">
                  <div className="fx-cat-head">
                    <Icon name="search" className="fx-cat-head-ico" size={13} />
                    <span className="fx-cat-head-label">By content</span>
                    <span className="fx-cat-head-count">{contentHits.length}</span>
                    {contentScanning && <span className="fx-cat-head-spinner" aria-label="Searching file contents" />}
                  </div>
                  {contentError && <p className="fx-hit-error">{contentError}</p>}
                  {/* Always a vertical list, whatever the tile/list view is
                      set to: each row pairs the file with the snippet that
                      explains WHY it matched, which a tile grid has no room
                      for. */}
                  <div className="fx-hits">
                    {contentHits.map(({ item, snippet }) => (
                      <HitRow
                        key={item.id}
                        item={item}
                        snippet={snippet}
                        highlight={q}
                        fallback="Match found in this file."
                        selected={multiSel.has(item.id)}
                        onSelect={onSelect}
                        onOpen={openItem}
                      />
                    ))}
                  </div>
                </section>
              )}

              {/* ── AI ── Its own category, and it only runs when asked: the
                  request costs money and uploads picture stills, so it waits
                  for the button rather than firing on every keystroke. */}
              <section className="fx-cat-section">
                <div className="fx-cat-head">
                  <Icon name="sparkles" className="fx-cat-head-ico" size={13} />
                  <span className="fx-cat-head-label">AI search</span>
                  {aiRanFor === q && <span className="fx-cat-head-count">{aiHits.length}</span>}
                  {aiScanning && <span className="fx-cat-head-spinner" aria-label="Searching with AI" />}
                </div>
                {aiError && <p className="fx-hit-error">{aiError}</p>}
                {/* The pitch is a one-time thing: after consent the section
                    just shows results, so this only renders while AI search
                    hasn't been enabled yet. */}
                {!aiConsented && !aiScanning && (
                  <div className="fx-ai-cta">
                    <h4 className="fx-ai-cta-title">
                      <Icon name="sparkles" className="fx-ai-cta-ico" size={19} filled />
                      <span>AI Search</span>
                    </h4>
                    <p className="fx-ai-cta-desc">
                      Finds what “{query}” describes — reading the documents and{' '}
                      <strong>looking at the pictures and video</strong>.
                    </p>
                    <button
                      type="button"
                      className="fx-ai-run"
                      onClick={() => (aiConsented ? runAiSearch() : setAiConsentOpen(true))}
                    >
                      <span>Enable</span>
                    </button>
                  </div>
                )}
                {/* The description pass is the one-time cost, so it's named as
                    such — "reading" a folder for the twentieth time would look
                    like the search is slow when it's actually the index being
                    built for files that have never been read. */}
                {aiScanning && (
                  <p className="fx-ai-hint">
                    {aiIndexing
                      ? `Reading new files — ${aiIndexing.done} of ${aiIndexing.total}. Only happens once per file.`
                      : 'Searching…'}
                  </p>
                )}
                {/* Between the keystroke and the debounce firing there's a
                    beat with nothing to show — say so rather than flashing
                    "nothing matches" at a search that hasn't run yet. */}
                {aiConsented && !aiScanning && aiAttemptedFor !== q && !aiError && (
                  <p className="fx-ai-hint">Waiting for you to finish typing…</p>
                )}
                {aiRanFor === q && !aiScanning && aiHits.length === 0 && !aiError && (
                  <p className="fx-ai-hint">Nothing in this folder matches that.</p>
                )}
                {aiHits.length > 0 && (
                  <div className="fx-hits">
                    {aiHits.map(({ item, snippet }) => (
                      <HitRow
                        key={item.id}
                        item={item}
                        snippet={snippet}
                        fallback="Matches your request."
                        selected={multiSel.has(item.id)}
                        onSelect={onSelect}
                        onOpen={openItem}
                      />
                    ))}
                  </div>
                )}
              </section>
            </div>
          ) : grouped ? (
            // Categorize view — one labelled section per category, stacked
            // vertically. New-item drafts sit in a leading block; each section
            // renders its bucket as a grid (tiles) or rows (list).
            <div className="fx-cat-groups">
              {(creatingFolder || creatingFile) && (
                view === 'tiles' ? (
                  <div className="fx-grid">
                    {creatingFolder && <NewFolderTile onCommit={commitNewFolder} onCancel={cancelNewFolder} />}
                    {creatingFile && <NewFileTile onCommit={commitNewFile} onCancel={cancelNewFile} />}
                  </div>
                ) : (
                  <div className="fx-list">
                    {creatingFolder && <NewFolderRow onCommit={commitNewFolder} onCancel={cancelNewFolder} />}
                    {creatingFile && <NewFileRow onCommit={commitNewFile} onCancel={cancelNewFile} />}
                  </div>
                )
              )}
              {groups.map((g) => (
                <section className="fx-cat-section" key={g.key}>
                  <div className="fx-cat-head">
                    <Icon name={g.icon} className="fx-cat-head-ico" size={13} />
                    <span className="fx-cat-head-label">{g.label}</span>
                    {/* No count on the Trash divider — its tile already says how
                        many items it holds. */}
                    {g.key !== 'trash' && <span className="fx-cat-head-count">{g.items.length}</span>}
                  </div>
                  <VirtualCells key={`${g.key}:${view}`} blockKey={`group:${g.key}`} cells={g.items} {...vProps} />
                </section>
              ))}
            </div>
          ) : view === 'tiles' ? (
            // One flat grid — no Folders/Files category heads. Order: the
            // Recycle bin first, the new-folder draft, then folders A→Z, then
            // files A→Z.
            <VirtualCells key="flat:tiles" blockKey="flat" cells={flatCells} {...vProps} />
          ) : (
            <VirtualCells key="flat:list" blockKey="flat" cells={flatCells} {...vProps} />
          )}
        </div>

        {/* Bottom action bar — file operations on the left, item count on the
            right. My drafts shows the full toolset; the bin shows
            Open / Restore / Delete-forever. */}
        <div className="fx-bottombar mini-glow">
          <div className="fx-bottombar-actions">
            {(onUndo || onRedo) && (
              <>
                <Tooltip content={canUndo ? `Undo ${undoLabel}` : 'Nothing to undo'}>
                  <button
                    className="fx-tb-btn fx-tb-icon"
                    disabled={!canUndo}
                    onClick={() => onUndo?.()}
                  >
                    <Icon name="undo" className="fx-icon" />
                  </button>
                </Tooltip>
                <Tooltip content={canRedo ? `Redo ${redoLabel}` : 'Nothing to redo'}>
                  <button
                    className="fx-tb-btn fx-tb-icon"
                    disabled={!canRedo}
                    onClick={() => onRedo?.()}
                  >
                    <Icon name="redo" className="fx-icon" />
                  </button>
                </Tooltip>
                <div className="fx-tb-sep" />
              </>
            )}
            {!isBin ? (
              <>
                {/* Single "Create" button — New folder, Identity, Document. */}
                <div className="fx-menu-wrap" ref={createMenuRef}>
                  <Tooltip content="Create a folder or a new document">
                    <button
                      className="fx-tb-btn"
                      disabled={!canEdit}
                      onClick={() => setCreateMenuOpen((v) => !v)}
                    >
                      <Icon name="plus" className="fx-icon" />
                      <span>Create</span>
                      <Icon name="chev-up" className="fx-caret" />
                    </button>
                  </Tooltip>
                  {createMenuOpen && (
                    <div className="fx-menu is-up fx-create-menu" role="menu">
                      <button onClick={() => { setCreateMenuOpen(false); requestNewFolder(); }}>
                        <Icon name="folder-plus" className="fx-icon" /> New folder
                      </button>
                      {onCreateTypedFile && (
                        // One entry, no type: the file is created without an
                        // extension and becomes Word / PowerPoint / Excel / PDF
                        // from what the user asks for when they open it.
                        <button onClick={() => { setCreateMenuOpen(false); onCreateTypedFile('auto'); }}>
                          <Icon name="file-doc" className="fx-icon" /> Document
                        </button>
                      )}
                      {/* A PDF is made FROM a document: opening it asks which
                          one to convert. */}
                      {onCreateTypedFile && (
                        <button onClick={() => { setCreateMenuOpen(false); onCreateTypedFile('pdf'); }}>
                          <Icon name="file-pdf" className="fx-icon" /> PDF
                        </button>
                      )}
                    </div>
                  )}
                </div>
                <button className="fx-tb-btn" disabled={!canEdit} onClick={() => onUpload?.()}>
                  <Icon name="upload" className="fx-icon" /><span>Import</span>
                </button>
                {onAddHighlightsSample && (
                  <Tooltip content="Add a Word document showing every highlight the file viewer draws — laws, codes, CAEN codes, CUIs, cross-references and empty fields">
                    <button className="fx-tb-btn" disabled={!canEdit} onClick={() => onAddHighlightsSample()}>
                      <Icon name="file-doc" className="fx-icon" /><span>Highlights sample</span>
                    </button>
                  </Tooltip>
                )}
                <div className="fx-tb-sep" />
                <button className="fx-tb-btn" disabled={!selectedItem} onClick={(e) => selectedItem && openItem(selectedItem, e)}>
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
                {(onPasteItems || onMoveItems) && (
                  <>
                    <div className="fx-tb-sep" />
                    <Tooltip content="Copy (Ctrl+C)">
                      <button
                        className="fx-tb-btn"
                        disabled={!canEdit || (multiSel.size === 0 && !selectedItem)}
                        onClick={copySelection}
                      >
                        <Icon name="copy" className="fx-icon" /><span>Copy{multiSel.size > 1 ? ` (${multiSel.size})` : ''}</span>
                      </button>
                    </Tooltip>
                    {onMoveItems && (
                      <Tooltip content="Cut (Ctrl+X)">
                        <button
                          className="fx-tb-btn"
                          disabled={!canEdit || (multiSel.size === 0 && !selectedItem)}
                          onClick={cutSelection}
                        >
                          <Icon name="cut" className="fx-icon" /><span>Cut{multiSel.size > 1 ? ` (${multiSel.size})` : ''}</span>
                        </button>
                      </Tooltip>
                    )}
                    <Tooltip content="Paste (Ctrl+V)">
                      <button
                        className="fx-tb-btn"
                        disabled={!canEdit || !canPaste}
                        onClick={pasteHere}
                      >
                        <Icon name="paste" className="fx-icon" /><span>Paste{clipboard?.items?.length > 1 ? ` (${clipboard.items.length})` : ''}</span>
                      </button>
                    </Tooltip>
                  </>
                )}
              </>
            ) : (
              <>
                <button className="fx-tb-btn" disabled={!selectedItem} onClick={(e) => selectedItem && openItem(selectedItem, e)}>
                  <Icon name="open" className="fx-icon" /><span>Open</span>
                </button>
                <button
                  className="fx-tb-btn"
                  disabled={multiSelItems.length === 0}
                  onClick={() => { if (onRestoreMany) onRestoreMany(multiSelItems); else multiSelItems.forEach((it) => onRestore?.(it)); exitSelectMode(); }}
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
                {onDebugSeedTrash && (
                  <>
                    <div className="fx-tb-sep" />
                    <Tooltip content="DEV: spawn items expiring in 30/25/20/15/10/5/3/2/1 days">
                      <button className="fx-tb-btn" onClick={() => onDebugSeedTrash()}>
                        <Icon name="clock" className="fx-icon" /><span>Seed test items</span>
                      </button>
                    </Tooltip>
                  </>
                )}
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
            {/* No ambient file/folder tally — the masthead kicker carries the
                counts; the footer only reports an active selection. */}
            {multiSel.size > 0 && <span>{multiSel.size} selected</span>}
          </div>
        </div>

        {/* Background right-click menu (Import / New folder) — portalled. */}
        {bgMorph.node}
      </div>


      {aiConsentOpen && (
        <AiConsentModal onAccept={acceptAiConsent} onCancel={() => setAiConsentOpen(false)} />
      )}
      {propsItem && <PropertiesModal item={propsItem} onClose={() => setPropsItem(null)} />}
      {archivePrompt && (
        <ArchivePrompt
          item={archivePrompt.item}
          x={archivePrompt.x}
          y={archivePrompt.y}
          onExtract={() => { const it = archivePrompt.item; setArchivePrompt(null); onOpenContent?.(it); }}
          onClose={() => setArchivePrompt(null)}
        />
      )}
    </div>
  );
}

// ── AI search consent ──────────────────────────────────────────────────
// Shown before the FIRST AI search on a device. Everything else in the Files
// page is local — this is the one action that sends a matter's contents to a
// third party, and the people using this app owe their clients an answer about
// that, so the notice is specific rather than a vague "AI may be used".
function AiConsentModal({ onAccept, onCancel }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div
      className="fx-consent-scrim"
      role="presentation"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div className="fx-consent" role="dialog" aria-modal="true" aria-labelledby="fx-consent-title">
        <h3 id="fx-consent-title" className="fx-consent-title">AI search sends this folder’s contents to Anthropic</h3>
        <p className="fx-consent-lead">
          Every other part of the Files page works on your machine alone. This one doesn’t —
          answering “find what I’m describing” means something has to read the files.
        </p>
        <ul className="fx-consent-list">
          <li><strong>Text from documents.</strong> A short excerpt of each readable file (Word, PDF, Excel, text) — about 700 characters.</li>
          <li><strong>Pictures and video frames.</strong> Downscaled, re-compressed stills. Small, but a person could still recognise a face or an ID card in one.</li>
          <li><strong>Filenames</strong> of everything in this folder.</li>
        </ul>
        <p className="fx-consent-note">
          <strong>Each file is read once.</strong> What comes back is a one-line description of what
          the file is, saved on this computer. Later searches are matched against those descriptions,
          so a document’s text and a photo’s image leave your machine a single time, not on every
          search. A file you edit is read again.
        </p>
        <p className="fx-consent-note">
          It goes to Anthropic’s business API, whose terms exclude your data from training their
          models. It is held about 30 days for abuse monitoring, then deleted. Nothing is sent
          unless you press the button, and nothing leaves for a normal (non-AI) search.
        </p>
        <p className="fx-consent-note">
          Consider whether the client material in this folder is something you may send to a
          processor outside your firm before continuing.
        </p>
        <div className="fx-consent-actions">
          <button type="button" className="fx-consent-btn" onClick={onCancel}>Cancel</button>
          <button type="button" className="fx-consent-btn is-primary" onClick={onAccept} autoFocus>
            I understand — search
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Search-hit row ─────────────────────────────────────────────────────
// One result in the "By content" / "AI" lists: the file on the left, the
// evidence on the right. `highlight` marks the searched text inside the
// snippet — only the literal pass passes it, since an AI reason is the model's
// own words and won't contain the query verbatim.
function HitRow({ item, snippet, highlight, fallback, selected, onSelect, onOpen }) {
  return (
    <div
      className={`fx-hit${selected ? ' is-selected' : ''}`}
      data-fx-id={item.id}
      onClick={(e) => onSelect(item, e)}
      onDoubleClick={(e) => onOpen(item, e)}
      role="button"
      tabIndex={-1}
    >
      <span className="fx-hit-thumb"><ItemThumbnail item={item} /></span>
      <span className="fx-hit-name" title={item.name}>{item.name}</span>
      <span className="fx-hit-snippet" title={snippet || ''}>
        {snippet ? <Marked text={snippet} needle={highlight} /> : fallback}
      </span>
    </div>
  );
}

// Wrap every case-insensitive occurrence of `needle` in <mark>. Split rather
// than innerHTML: the snippet is file content, so it must never be parsed as
// markup. A missing/empty needle renders the text unchanged.
function Marked({ text, needle }) {
  const q = (needle || '').trim();
  if (!q) return text;
  const lower = String(text).toLowerCase();
  const target = q.toLowerCase();
  const out = [];
  let at = 0;
  for (;;) {
    const found = lower.indexOf(target, at);
    if (found < 0) break;
    if (found > at) out.push(text.slice(at, found));
    out.push(<mark className="fx-hit-mark" key={found}>{text.slice(found, found + target.length)}</mark>);
    at = found + target.length;
  }
  if (!out.length) return text;
  if (at < text.length) out.push(text.slice(at));
  return out;
}

// ── Compressed-file prompt ─────────────────────────────────────────────
// Opening an archive has no useful default: a .zip unpacks into a sibling
// folder we then browse, anything else is handed to the OS archiver (see
// local-folder:extract-archive in main). So the double-click asks, in a card
// pinned to the pointer rather than a centred dialog — the answer belongs next
// to the file you just hit.
function ArchivePrompt({ item, x, y, onExtract, onClose }) {
  const cardRef = useRef(null);
  const isZip = /^zip$/i.test(item.ext || '');
  // Hidden until measured: the card has to know its own size before it can be
  // flipped away from a screen edge, and a visible jump would be worse.
  const [pos, setPos] = useState(x == null || y == null ? 'center' : null);

  useLayoutEffect(() => {
    const el = cardRef.current;
    if (!el || x == null || y == null) return;
    // Clamp in VIEWPORT px (what clientX and getBoundingClientRect speak),
    // then convert once — under the Settings display-scale the two spaces
    // differ, and left/top are layout px.
    const M = 12;                       // keep this much clear of every edge
    const { width: w, height: h } = el.getBoundingClientRect();
    let left = x + 8;
    let top = y + 8;
    if (left + w > window.innerWidth - M) left = x - w - 8;   // flip left
    if (top + h > window.innerHeight - M) top = y - h - 8;    // flip above
    setPos({ left: toLayoutPx(Math.max(M, left)), top: toLayoutPx(Math.max(M, top)) });
  }, [x, y]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const style = pos === 'center' || pos == null
    ? undefined
    : { left: `${pos.left}px`, top: `${pos.top}px` };

  return (
    <div className="fx-arch-scrim" role="presentation" onMouseDown={onClose}>
      <div
        ref={cardRef}
        className={`fx-arch${pos === 'center' ? ' is-centered' : ''}${pos == null ? ' is-measuring' : ''}`}
        style={style}
        role="dialog"
        aria-label="Compressed file"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="fx-arch-head">
          <span className="fx-arch-glyph"><ExtGlyph ext={item.ext} /></span>
          <div className="fx-arch-heading">
            <h4>Compressed file</h4>
            <p className="fx-arch-name" title={item.name}>{item.name}</p>
          </div>
        </div>
        <p className="fx-arch-body">
          {isZip
            ? 'There’s nothing to preview inside an archive. Extract it to a folder here — you can undo it afterwards.'
            : 'There’s nothing to preview inside an archive. DocVex can’t unpack this format, so it opens in your system’s archiver.'}
        </p>
        <div className="fx-arch-actions">
          <button type="button" className="fx-arch-btn" onClick={onClose}>Close</button>
          <button type="button" className="fx-arch-btn is-primary" onClick={onExtract} autoFocus>
            {isZip ? 'Extract files' : 'Open in archiver'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Properties dialog ──────────────────────────────────────────────────
// Read-only inspector for a single file / folder, built from the item model
// the workspace already has (no extra fetch).
function PropertiesModal({ item, onClose }) {
  const isFolder = item.kind === 'folder';
  const typeLabel = item.binEntry
    ? 'Trash'
    : isFolder
    ? 'Folder'
    : (item.ext ? `${item.ext.toUpperCase()} file` : 'File');
  const location = isFolder
    ? (item._dir?.path || item.path || '')
    : (item._raw?.path || '');
  const statusLabel = STATUS_LABEL[item.status] || 'Up to date';
  const rows = [
    ['Name', item.name],
    ['Type', typeLabel],
    item.sizeLabel && ['Size', item.sizeLabel],
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
          {isFolder ? <FolderGlyph filled={!item.empty} /> : <ItemThumbnail item={item} />}
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
