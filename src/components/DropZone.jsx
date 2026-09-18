import React, { useRef, useState } from 'react';
import './DropZone.css';

// The import surface from the Timeline's first step, made shareable so the
// Playbook uses the SAME one rather than a copy that would drift from it. Same
// markup, same `cto-` classes, same behaviour: a dashed accent panel that
// highlights on drag-over, an Import button proxying to a hidden native input,
// and a compact row it collapses into once there is something to show under it.
//
// `children` render INSIDE the zone, below the header row — which is how the
// Timeline puts its picked-files grid there, and it is still a live drop target
// while they are showing.

export const UploadGlyph = (props) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="M17 8l-5-5-5 5" /><path d="M12 3v12" />
  </svg>
);

export default function DropZone({
  title,
  sub,
  buttonLabel = 'Import',
  // The Timeline deliberately passes none — every file type is pickable there,
  // because one it cannot read still anchors the story by its name. A surface
  // that can only act on some formats should say so here.
  accept,
  multiple = true,
  disabled = false,
  compact = false,
  onFiles,
  zoneRef,
  children,
}) {
  const inputRef = useRef(null);
  const [dragOver, setDragOver] = useState(false);
  return (
    <div
      ref={zoneRef}
      className={`cto-dropzone${dragOver ? ' is-dragover' : ''}${compact ? ' is-compact' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        if (!disabled) onFiles?.(e.dataTransfer?.files);
      }}
    >
      <span className="cto-drop-ico"><UploadGlyph width="26" height="26" /></span>
      {/* display:contents while expanded (layout identical to the plain row);
          becomes a stacked text column in the compact row. */}
      <div className="cto-drop-copy">
        <div className="cto-drop-title">{title}</div>
        <div className="cto-drop-sub">{sub}</div>
      </div>
      <button type="button" className="cto-btn-accent" onClick={() => inputRef.current?.click()} disabled={disabled}>
        {buttonLabel}
      </button>
      <input
        ref={inputRef}
        type="file"
        multiple={multiple}
        accept={accept}
        className="cto-file-input"
        onChange={(e) => {
          const picked = e.target.files;
          // Reset so re-picking the same file fires onChange again.
          e.target.value = '';
          onFiles?.(picked);
        }}
      />
      {children}
    </div>
  );
}
