// In-memory bus for an in-app file drag. HTML5 drag-and-drop only exposes
// `dataTransfer` *data* in the drop event (dragover/dragenter see only the
// MIME `types`), so a drop target can't preview what's being dragged while the
// pointer is still moving. Since every split pane runs in the SAME JS context
// (one React app, multiple MemoryRouters in one document), a module-level
// singleton lets the drag source publish the rich item models (name +
// descriptor + path) and any target read them live during dragover.
//
// This is a *preview/affordance* channel only — the authoritative payload still
// rides on `dataTransfer` (so plain file moves work), and the drop handler
// falls back to the bus only if the serialized payload is missing.

let dragged = null;

export function setDraggedFiles(items) {
  dragged = Array.isArray(items) && items.length ? items : null;
}

export function clearDraggedFiles() {
  dragged = null;
}

export function getDraggedFiles() {
  return dragged;
}
