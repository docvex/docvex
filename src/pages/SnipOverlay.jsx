import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { recognizeCanvas, OCR_MAX_EDGE } from '../lib/ocr';
import { useNotifications } from '../context/NotificationsContext';
import './SnipOverlay.css';

// Full-screen "Extract text from screen" overlay — opened from the system
// tray's "Extract text" item. The main process freezes the desktop by
// screenshotting the cursor's display (desktopCapturer) and opening this
// window over it with the shot in the query (?snip=1&shot=<temp png path>).
// The user drags a rectangle over the frozen image; the crop goes through the
// SAME OCR pipeline as the Doc Viewer's lasso tool (lib/ocr.js → doc-ai Edge
// Function), and the result lands in a copyable panel. Esc cancels anywhere.

export default function SnipOverlay() {
  const [params] = useSearchParams();
  const shot = params.get('shot');
  const shotUrl = shot ? `localfile://local/${encodeURIComponent(shot)}` : null;
  const { notify } = useNotifications();

  const imgRef = useRef(null);
  // Selection rectangle in viewport px: null | { x1, y1, x2, y2 }.
  const [sel, setSel] = useState(null);
  const [dragging, setDragging] = useState(false);
  // 'select' → 'working' → 'done' | 'error'
  const [phase, setPhase] = useState('select');
  const [text, setText] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [copied, setCopied] = useState(false);

  const closeWindow = useCallback(() => { window.close(); }, []);

  // Esc cancels at any phase.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') closeWindow(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [closeWindow]);

  const rectOf = (s) => s && {
    x: Math.min(s.x1, s.x2),
    y: Math.min(s.y1, s.y2),
    w: Math.abs(s.x2 - s.x1),
    h: Math.abs(s.y2 - s.y1),
  };

  const runOcr = useCallback(async (s) => {
    const img = imgRef.current;
    const r = rectOf(s);
    if (!img || !r || r.w < 8 || r.h < 8) { setSel(null); return; }
    setPhase('working');
    try {
      // Viewport → screenshot-pixel coords (the shot is captured at the
      // display's physical resolution; the <img> fills the window 1:1 in CSS
      // px, so the ratio is the display's scale factor).
      const scaleX = img.naturalWidth / img.clientWidth;
      const scaleY = img.naturalHeight / img.clientHeight;
      const sx = r.x * scaleX;
      const sy = r.y * scaleY;
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
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
      const result = await recognizeCanvas(canvas);
      if (!result) {
        setErrorMsg('No readable text in the selection.');
        setPhase('error');
        return;
      }
      setText(result);
      setPhase('done');
      // Record the extract in the Activity feed / log, like the Doc Viewer's
      // lasso tool (silent — the result panel is the in-window feedback).
      notify?.({
        category: 'file',
        variant: 'success',
        icon: 'sparkles',
        title: 'Text extracted',
        body: 'New extract from a screen capture.',
        silent: true,
        payload: { activity: { action: 'extract-text', fileName: 'Screen capture' } },
      });
    } catch (e) {
      setErrorMsg(String(e?.message || 'Text recognition failed.'));
      setPhase('error');
    }
  }, [notify]);

  // Drag-to-select on the frozen shot.
  const onMouseDown = (e) => {
    if (phase !== 'select' || e.button !== 0) return;
    setSel({ x1: e.clientX, y1: e.clientY, x2: e.clientX, y2: e.clientY });
    setDragging(true);
  };
  const onMouseMove = (e) => {
    if (!dragging) return;
    setSel((s) => (s ? { ...s, x2: e.clientX, y2: e.clientY } : s));
  };
  const onMouseUp = () => {
    if (!dragging) return;
    setDragging(false);
    runOcr(sel);
  };

  const copyText = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch { /* clipboard unavailable */ }
  };

  const reset = () => { setSel(null); setText(''); setErrorMsg(''); setPhase('select'); };

  const r = rectOf(sel);

  return (
    <div
      className={`snip-root${phase === 'select' ? ' is-selecting' : ''}`}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
    >
      {/* The frozen desktop. crossOrigin so the crop canvas isn't tainted
          (the localfile handler sends CORS headers). */}
      {shotUrl && <img ref={imgRef} className="snip-shot" src={shotUrl} alt="" draggable={false} crossOrigin="anonymous" />}

      {/* Selection rectangle — the giant box-shadow dims everything else. */}
      {r && r.w > 0 && r.h > 0 && (
        <div
          className={`snip-rect${phase === 'working' ? ' is-working' : ''}`}
          style={{ left: r.x, top: r.y, width: r.w, height: r.h }}
        />
      )}
      {/* Before a drag starts, dim the whole screen lightly. */}
      {!r && phase === 'select' && <div className="snip-scrim" />}

      {phase === 'select' && (
        <div className="snip-hint">Drag to select the text to extract · Esc to cancel</div>
      )}
      {phase === 'working' && (
        <div className="snip-hint"><span className="snip-spinner" />Reading text…</div>
      )}

      {(phase === 'done' || phase === 'error') && (
        <div className="snip-panel" onMouseDown={(e) => e.stopPropagation()}>
          <div className="snip-panel-head">{phase === 'done' ? 'Extracted text' : 'Couldn’t extract'}</div>
          {phase === 'done'
            ? <textarea className="snip-text" value={text} readOnly />
            : <div className="snip-error">{errorMsg}</div>}
          <div className="snip-actions">
            {phase === 'done' && (
              <button type="button" className="snip-btn is-primary" onClick={copyText}>
                {copied ? 'Copied ✓' : 'Copy text'}
              </button>
            )}
            <button type="button" className="snip-btn" onClick={reset}>Select again</button>
            <button type="button" className="snip-btn" onClick={closeWindow}>Done</button>
          </div>
        </div>
      )}
    </div>
  );
}
