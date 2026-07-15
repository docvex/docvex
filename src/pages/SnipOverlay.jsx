import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { recognizeCanvas, OCR_MAX_EDGE } from '../lib/ocr';
import { useNotifications } from '../context/NotificationsContext';
import { useAuth } from '../context/AuthContext';
import { useSelectedProject } from '../context/SelectedProjectContext';
import { readProjectsDir } from '../lib/projectsDir';
import { localFolderApi } from '../lib/localFolder';
import { saveOcrHistory } from '../lib/extractionHistory';
import { notifyFilesChanged } from '../lib/platform';
import './SnipOverlay.css';

// Full-screen "Extract text from screen" overlay — opened from the Extract
// Tool launcher's "New" button (tray → "Extract text" → /snip-panel). The
// main process freezes the desktop by screenshotting the target display(s)
// (desktopCapturer) and opening this window over each with the shot in the
// query (?snip=1&shot=<temp png path>&mode=<rect|free>).
//
// The frozen shot behaves like a screenshot that supports MULTIPLE
// selections: every completed drag (rectangle or free-form lasso) is OCR'd
// through the same pipeline as the Doc Viewer's lasso tool (lib/ocr.js →
// doc-ai Edge Function) and appended — thumbnail + extracted text — to a
// vertical list of floating cards in the TOP-LEFT of the screen. Past
// selections stay outlined on the shot with their number.
//
// Esc is the exit: with zero selections it closes the overlay outright; with
// selections it opens a centered modal — "Save to files" writes the full
// screenshot into the active project's local folder, named with the capture's
// date + time, and records every extract in that file's OCR history
// (lib/extractionHistory.js) so the Doc Viewer's Snippets panel lists them
// when the file is opened; "Discard" closes without saving.

const MODE_OPTIONS = [
  {
    id: 'rect',
    label: 'Rectangle',
    icon: (
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
        <rect x="4" y="6" width="16" height="12" rx="1.5" strokeDasharray="3.5 2.5" />
      </svg>
    ),
  },
  {
    id: 'free',
    label: 'Free-form',
    icon: (
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M7 15c-2.5-1.5-3-4.5-1-6.5S11 5 13 6.5s5 .5 6 2.5-1 5-3.5 5.5S9.5 16.5 7 15Z" strokeDasharray="3.5 2.5" />
      </svg>
    ),
  },
];

const THUMB_MAX = 160;

let extractSeq = 0;

export default function SnipOverlay() {
  const [params] = useSearchParams();
  const shot = params.get('shot');
  const shotUrl = shot ? `localfile://local/${encodeURIComponent(shot)}` : null;
  // 'rect' (drag a rectangle) | 'free' (lasso) — switchable via the top pill.
  const initialMode = params.get('mode') || 'rect';
  const [mode, setMode] = useState(MODE_OPTIONS.some((m) => m.id === initialMode) ? initialMode : 'rect');
  // All-screens capture numbers each overlay (?w=1, 2, …). The saved
  // screenshot gets a " w<n>" suffix so every screen's capture + snippets
  // coexist in the project files.
  const winNo = params.get('w');
  const { notify } = useNotifications();
  const { session } = useAuth();
  const { selectedProjectId, selectedProject } = useSelectedProject();

  const imgRef = useRef(null);
  // Current drag: rectangle { x1, y1, x2, y2 } or lasso points [{ x, y }].
  const [sel, setSel] = useState(null);
  const [pts, setPts] = useState(null);
  const [dragging, setDragging] = useState(false);
  // Completed selections, oldest first:
  // { id, rect (viewport bbox), thumb (data URL), text, status, error }
  const [extracts, setExtracts] = useState([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  // Centered "Save or discard?" modal — the only exit UI. Opened by Esc when
  // there ARE selections; with zero selections Esc just closes everything.
  const [confirmOpen, setConfirmOpen] = useState(false);

  // Discards EVERY screen's overlay via main (snip:cancel destroys all snip
  // windows at once). Save/Discard close only THIS screen's overlay so the
  // other screens keep collecting selections.
  const closeAll = useCallback(() => {
    if (window.electronAPI?.snipCancel) window.electronAPI.snipCancel();
    else window.close();
  }, []);
  const closeThis = useCallback(() => { window.close(); }, []);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      if (confirmOpen) setConfirmOpen(false);
      else if (extracts.length === 0) closeAll();
      else setConfirmOpen(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [closeAll, confirmOpen, extracts.length]);

  const rectOf = (s) => s && {
    x: Math.min(s.x1, s.x2),
    y: Math.min(s.y1, s.y2),
    w: Math.abs(s.x2 - s.x1),
    h: Math.abs(s.y2 - s.y1),
  };

  const patchExtract = (id, patch) => {
    setExtracts((list) => list.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  };

  // Small preview for the sidebar / OCR history — the crop canvas downscaled.
  const thumbFrom = (canvas) => {
    const scale = Math.min(1, THUMB_MAX / Math.max(canvas.width, canvas.height));
    const t = document.createElement('canvas');
    t.width = Math.max(1, Math.round(canvas.width * scale));
    t.height = Math.max(1, Math.round(canvas.height * scale));
    t.getContext('2d').drawImage(canvas, 0, 0, t.width, t.height);
    return t.toDataURL('image/jpeg', 0.75);
  };

  // Register the crop as a new sidebar entry and OCR it. Selections queue
  // independently — a new drag can start while earlier ones are still reading.
  // `region` is the selection's geometry in the screenshot's NATURAL pixels —
  // saved with the OCR history so the Doc Viewer's "locate selection" feature
  // can highlight the region on the saved image when the snippet is clicked.
  const startExtract = useCallback(async (canvas, bboxRect, region) => {
    extractSeq += 1;
    const id = `x${extractSeq}-${Date.now()}`;
    setExtracts((list) => [...list, {
      id,
      rect: bboxRect,
      region,
      thumb: thumbFrom(canvas),
      text: '',
      status: 'working',
      error: '',
      createdAt: Date.now(),
    }]);
    try {
      const result = await recognizeCanvas(canvas);
      if (!result) patchExtract(id, { status: 'error', error: 'No readable text in the selection.' });
      else patchExtract(id, { status: 'done', text: result });
    } catch (e) {
      patchExtract(id, { status: 'error', error: String(e?.message || 'Text recognition failed.') });
    }
  }, []);

  // Crop the viewport rect out of the shot at physical resolution.
  const cropRect = useCallback((s) => {
    const img = imgRef.current;
    const r = rectOf(s);
    if (!img || !r || r.w < 8 || r.h < 8) { setSel(null); return; }
    // Viewport → screenshot-pixel coords (the shot is captured at the
    // display's physical resolution; the <img> fills the window 1:1 in CSS
    // px, so the ratio is the display's scale factor).
    const scaleX = img.naturalWidth / img.clientWidth;
    const scaleY = img.naturalHeight / img.clientHeight;
    const sw = r.w * scaleX;
    const sh = r.h * scaleY;
    // Downscale oversized crops — Claude resizes past ~1568px anyway.
    const out = Math.min(1, OCR_MAX_EDGE / Math.max(sw, sh));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(sw * out));
    canvas.height = Math.max(1, Math.round(sh * out));
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, r.x * scaleX, r.y * scaleY, sw, sh, 0, 0, canvas.width, canvas.height);
    setSel(null);
    startExtract(canvas, r, {
      kind: 'rect',
      x1: r.x * scaleX,
      y1: r.y * scaleY,
      x2: (r.x + r.w) * scaleX,
      y2: (r.y + r.h) * scaleY,
    });
  }, [startExtract]);

  // Free-form: crop the lasso's bounding box, clipped to the drawn path.
  // Outside-path pixels stay white so stray content around it doesn't OCR.
  const cropPath = useCallback((p) => {
    const img = imgRef.current;
    if (!img || !p || p.length < 3) { setPts(null); return; }
    const xs = p.map((q) => q.x);
    const ys = p.map((q) => q.y);
    const bx = Math.min(...xs);
    const by = Math.min(...ys);
    const bw = Math.max(...xs) - bx;
    const bh = Math.max(...ys) - by;
    if (bw < 8 || bh < 8) { setPts(null); return; }
    const scaleX = img.naturalWidth / img.clientWidth;
    const scaleY = img.naturalHeight / img.clientHeight;
    const sw = bw * scaleX;
    const sh = bh * scaleY;
    const out = Math.min(1, OCR_MAX_EDGE / Math.max(sw, sh));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(sw * out));
    canvas.height = Math.max(1, Math.round(sh * out));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.beginPath();
    p.forEach((q, i) => {
      const x = (q.x - bx) * scaleX * out;
      const y = (q.y - by) * scaleY * out;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.clip();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, bx * scaleX, by * scaleY, sw, sh, 0, 0, canvas.width, canvas.height);
    setPts(null);
    startExtract(canvas, { x: bx, y: by, w: bw, h: bh }, {
      kind: 'path',
      points: p.map((q) => ({ x: q.x * scaleX, y: q.y * scaleY })),
    });
  }, [startExtract]);

  // Pill mode switch clears any in-progress drag.
  const selectMode = (id) => {
    setMode(id);
    setSel(null);
    setPts(null);
    setDragging(false);
  };

  // Drag-to-select on the frozen shot ('free' draws a lasso, otherwise rect).
  // In all-screens mode the OTHER displays' overlays stay open — each screen
  // collects and saves its own selections independently.
  const onMouseDown = (e) => {
    if (saving || confirmOpen || e.button !== 0) return;
    if (mode === 'free') setPts([{ x: e.clientX, y: e.clientY }]);
    else setSel({ x1: e.clientX, y1: e.clientY, x2: e.clientX, y2: e.clientY });
    setDragging(true);
  };
  const onMouseMove = (e) => {
    if (!dragging) return;
    if (mode === 'free') setPts((p) => (p ? [...p, { x: e.clientX, y: e.clientY }] : p));
    else setSel((s) => (s ? { ...s, x2: e.clientX, y2: e.clientY } : s));
  };
  const onMouseUp = () => {
    if (!dragging) return;
    setDragging(false);
    if (mode === 'free') cropPath(pts);
    else cropRect(sel);
  };

  const removeExtract = (id) => setExtracts((list) => list.filter((e) => e.id !== id));

  const copyText = async (text) => {
    try { await navigator.clipboard.writeText(text); } catch { /* clipboard unavailable */ }
  };

  const working = extracts.some((e) => e.status === 'working');
  const doneExtracts = extracts.filter((e) => e.status === 'done' && e.text);

  // Save the full screenshot into the active project's local folder (named by
  // the capture's date + time) and record every extract in that file's OCR
  // history, then close.
  const saveAll = useCallback(async () => {
    const img = imgRef.current;
    if (!img || saving) return;
    setSaving(true);
    setSaveError('');
    try {
      if (!selectedProjectId) throw new Error('No active project — open a project first.');
      // Full-resolution PNG of the frozen shot.
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext('2d').drawImage(img, 0, 0);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('Could not encode the screenshot.');

      const now = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}.${pad(now.getMinutes())}.${pad(now.getSeconds())}`;
      // Multi-screen capture: suffix the screen number (w1, w2, …) so each
      // screen's screenshot + snippets can be saved side by side.
      const filename = `${stamp}${winNo ? ` w${winNo}` : ''}.png`;

      const userId = session?.user?.id;
      const { path: dir } = await localFolderApi.projectDir(
        selectedProjectId,
        selectedProject?.name,
        readProjectsDir(userId) || undefined,
      );
      if (!dir) throw new Error('The project has no local folder yet — open its Files tab once.');
      const res = await localFolderApi.writeFiles({ dir, files: [{ filename, blob }] });
      const savedPath = res?.results?.find((r) => r.ok)?.path;
      if (!savedPath) throw new Error(res?.results?.[0]?.error || res?.error || 'Could not write the file.');

      // OCR history for the saved file — newest first, like the Doc Viewer.
      // `region` + natW/natH make each snippet locatable: clicking it in the
      // Doc Viewer highlights the selection on the saved screenshot.
      if (doneExtracts.length) {
        saveOcrHistory(
          savedPath,
          [...doneExtracts].reverse().map((e) => ({
            id: e.id,
            thumb: e.thumb,
            text: e.text,
            createdAt: e.createdAt,
            region: e.region || null,
            natW: img.naturalWidth,
            natH: img.naturalHeight,
          })),
        );
      }
      notifyFilesChanged();
      notify?.({
        category: 'file',
        variant: 'success',
        icon: 'sparkles',
        title: 'Screenshot saved',
        body: `${filename} · ${doneExtracts.length} extract${doneExtracts.length === 1 ? '' : 's'}`,
        silent: true,
        payload: { activity: { action: 'extract-text', fileName: filename } },
      });
      // Only this screen's overlay closes — others may still be in use.
      closeThis();
    } catch (e) {
      setSaveError(String(e?.message || 'Saving failed.'));
      setSaving(false);
    }
  }, [saving, selectedProjectId, selectedProject?.name, session?.user?.id, doneExtracts, notify, closeThis, winNo]);

  const r = rectOf(sel);
  const lassoD = pts && pts.length > 1
    ? `M ${pts.map((q) => `${q.x} ${q.y}`).join(' L ')}${dragging ? '' : ' Z'}`
    : null;

  return (
    <div
      className="snip-root is-selecting"
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
    >
      {/* The frozen desktop. crossOrigin so the crop canvas isn't tainted
          (the localfile handler sends CORS headers). */}
      {shotUrl && <img ref={imgRef} className="snip-shot" src={shotUrl} alt="" draggable={false} crossOrigin="anonymous" />}

      {/* Current drag — rectangle (giant box-shadow dims outside) or lasso. */}
      {r && r.w > 0 && r.h > 0 && (
        <div className="snip-rect" style={{ left: r.x, top: r.y, width: r.w, height: r.h }} />
      )}
      {lassoD && (
        <svg className="snip-lasso" aria-hidden="true">
          <defs>
            <mask id="snip-lasso-cut">
              <rect width="100%" height="100%" fill="#fff" />
              <path d={lassoD} fill="#000" />
            </mask>
          </defs>
          <rect width="100%" height="100%" fill="rgba(0, 0, 0, 0.45)" mask="url(#snip-lasso-cut)" />
          <path className="snip-lasso-path" d={lassoD} />
        </svg>
      )}
      {/* Light dim while idle. */}
      {!r && !lassoD && <div className="snip-scrim" />}

      {/* Numbered outlines of the selections already made. */}
      {extracts.map((e, i) => (
        <div
          key={e.id}
          className={`snip-mark${e.status === 'working' ? ' is-working' : ''}`}
          style={{ left: e.rect.x, top: e.rect.y, width: e.rect.w, height: e.rect.h }}
        >
          <span className="snip-mark-badge">{i + 1}</span>
        </div>
      ))}

      {/* Top pill — capture modes + hint. */}
      <div className="snip-modebar" onMouseDown={(e) => e.stopPropagation()}>
        {MODE_OPTIONS.map((m) => (
          <button
            key={m.id}
            type="button"
            className={`snip-mode-btn${mode === m.id ? ' is-active' : ''}`}
            aria-pressed={mode === m.id}
            onClick={() => selectMode(m.id)}
          >
            {m.icon}
            {m.label}
          </button>
        ))}
        <span className="snip-modebar-sep" />
        <span className="snip-modebar-hint">
          {mode === 'free' ? 'Draw around each text area' : 'Drag over each text area'} · Esc when done
        </span>
      </div>

      {/* Top-left vertical list — every selection with its extracted text,
          floating cards with no panel chrome. Nothing shows until the first
          selection is made so the frozen shot starts uncovered. */}
      {extracts.length > 0 && (
        <div className="snip-list" onMouseDown={(e) => e.stopPropagation()}>
          {extracts.map((e, i) => (
            <div key={e.id} className="snip-entry">
              <div className="snip-entry-top">
                <span className="snip-entry-idx">{i + 1}</span>
                <img className="snip-entry-thumb" src={e.thumb} alt="" draggable={false} />
                <button type="button" className="snip-entry-x" aria-label="Remove selection" onClick={() => removeExtract(e.id)}>×</button>
              </div>
              {e.status === 'working' && (
                <div className="snip-entry-status"><span className="snip-spinner" />Reading text…</div>
              )}
              {e.status === 'error' && <div className="snip-error">{e.error}</div>}
              {e.status === 'done' && (
                <>
                  <div className="snip-entry-text">{e.text}</div>
                  <button type="button" className="snip-btn snip-entry-copy" onClick={() => copyText(e.text)}>Copy text</button>
                </>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Centered exit modal (Esc with selections) — save or discard. With
          zero selections Esc closes the overlay outright, no modal. */}
      {confirmOpen && (
        <div className="snip-confirm-scrim" onMouseDown={(e) => e.stopPropagation()}>
          <div className="snip-confirm" role="dialog" aria-modal="true" aria-label="Save selections">
            <div className="snip-confirm-title">Save your selections?</div>
            <div className="snip-confirm-body">
              {extracts.length} selection{extracts.length === 1 ? '' : 's'}
              {winNo ? ` on screen ${winNo}` : ''} — save the screenshot and its
              extracted text to the project files, or discard everything.
            </div>
            {saveError && <div className="snip-error">{saveError}</div>}
            <div className="snip-confirm-actions">
              <button
                type="button"
                className="snip-btn is-primary"
                disabled={saving || working}
                onClick={saveAll}
              >
                {saving ? 'Saving…' : working ? 'Reading…' : 'Save to files'}
              </button>
              <button type="button" className="snip-btn" onClick={closeThis}>
                {winNo ? 'Discard this screen' : 'Discard'}
              </button>
              <button type="button" className="snip-btn" onClick={() => setConfirmOpen(false)}>
                Keep selecting
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
