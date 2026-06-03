import { useCallback, useRef, useState } from 'react';

// Lightweight undo/redo stack for async, side-effecting file operations.
//
// Each "action" carries its own forward (`redo`) and inverse (`undo`)
// thunks plus a human `label`. Both thunks are async and may mutate the
// action's own closure state between calls — e.g. a trashed file's
// `stored` name changes every time it's re-trashed, and a restore hands
// back a possibly-suffixed path, so the closures keep the latest
// identifiers around for the next round-trip.
//
// A thunk resolves to `false` to signal it failed (the underlying fs op
// errored); the manager then drops the action instead of leaving a
// dead entry on the opposite stack. A single in-flight guard prevents
// overlapping undo/redo while an fs operation is still running.
export function useUndoRedo() {
  const undoRef = useRef([]);
  const redoRef = useRef([]);
  const busyRef = useRef(false);
  // Refs don't trigger re-renders, but the buttons read canUndo / labels —
  // bump a counter whenever the stacks change so the UI re-paints.
  const [, force] = useState(0);
  const sync = useCallback(() => force((n) => n + 1), []);

  const pushAction = useCallback((action) => {
    if (!action || typeof action.undo !== 'function' || typeof action.redo !== 'function') return;
    undoRef.current.push(action);
    redoRef.current = [];   // a fresh action invalidates the redo branch
    sync();
  }, [sync]);

  const clear = useCallback(() => {
    undoRef.current = [];
    redoRef.current = [];
    sync();
  }, [sync]);

  const undo = useCallback(async () => {
    if (busyRef.current) return null;
    const action = undoRef.current[undoRef.current.length - 1];
    if (!action) return null;
    busyRef.current = true;
    try {
      const ok = await action.undo();
      undoRef.current.pop();
      if (ok !== false) redoRef.current.push(action);  // failed inverse → discard
      sync();
      return { ok: ok !== false, label: action.label };
    } finally {
      busyRef.current = false;
    }
  }, [sync]);

  const redo = useCallback(async () => {
    if (busyRef.current) return null;
    const action = redoRef.current[redoRef.current.length - 1];
    if (!action) return null;
    busyRef.current = true;
    try {
      const ok = await action.redo();
      redoRef.current.pop();
      if (ok !== false) undoRef.current.push(action);
      sync();
      return { ok: ok !== false, label: action.label };
    } finally {
      busyRef.current = false;
    }
  }, [sync]);

  return {
    pushAction,
    clear,
    undo,
    redo,
    canUndo: undoRef.current.length > 0,
    canRedo: redoRef.current.length > 0,
    undoLabel: undoRef.current[undoRef.current.length - 1]?.label || '',
    redoLabel: redoRef.current[redoRef.current.length - 1]?.label || '',
  };
}
