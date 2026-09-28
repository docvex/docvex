// Optimistic file operations for the Files tab.
//
// On a slow office machine (a spinning disk, antivirus scanning every write,
// a project folder on a network share) a rename or a delete can take a second
// or more to come back from the main process, and the grid used to sit on the
// old state until it did. Instead, every user-initiated change is recorded as
// a PENDING OP the moment it is made, and the grid is drawn from whatever the
// disk last said WITH the pending ops laid over it. The base listings are
// never edited by hand: rolling a failed op back is simply dropping it, and a
// listing that arrives mid-flight (the file watcher, a refetch, another
// window's broadcast) is overlaid like any other, so it can neither resurrect
// a file being deleted nor duplicate one being renamed.
//
// Every op is idempotent against the listing it is laid over — a remove of a
// path that is already gone does nothing, a move whose destination already
// exists does not add a second copy — which is what lets an op stay on until
// a listing taken AFTER the disk answered has landed, and then be dropped
// without the old state flashing back.
//
// Op shapes (all carry an `id`, stamped by the caller):
//   { type: 'remove', path, isDir }               — a file or folder going away
//   { type: 'move', from, to, isDir, entry }      — rename or move (entry = the
//                                                   listing row being moved)
//   { type: 'add', path, isDir, entry }           — a file or folder appearing
//   { type: 'trash-remove', stored }              — a Trash record going away
//                                                   (restored or purged)

// Paths are compared normalised: forward slashes, no trailing separator, and
// lower case (Windows paths are case-insensitive, and the renderer joins with
// '/' where main joins with '\').
export function normPath(p) {
  return String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

export function samePath(a, b) {
  return normPath(a) === normPath(b);
}

export function baseName(p) {
  const s = String(p || '').replace(/[\\/]+$/, '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i >= 0 ? s.slice(i + 1) : s;
}

export function parentOf(p) {
  const s = String(p || '').replace(/[\\/]+$/, '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i >= 0 ? s.slice(0, i) : '';
}

// Join with the separator the directory already uses, so an optimistic path
// reads like the one main will hand back.
export function joinPath(dir, ...parts) {
  const d = String(dir || '').replace(/[\\/]+$/, '');
  const sep = d.includes('\\') ? '\\' : '/';
  const rest = parts
    .filter((x) => x != null && x !== '')
    .map((x) => String(x).replace(/[\\/]+/g, sep).replace(/^[\\/]+|[\\/]+$/g, ''))
    .filter(Boolean);
  return [d, ...rest].join(sep);
}

// True when `p` is `root` itself or anything under it.
function isUnder(p, root) {
  const a = normPath(p);
  const b = normPath(root);
  return a === b || a.startsWith(`${b}/`);
}

// Re-root a path that lives under `from` onto `to`, keeping its tail as written.
function reroot(p, from, to) {
  const tail = String(p).slice(String(from).replace(/[\\/]+$/, '').length);
  return `${String(to).replace(/[\\/]+$/, '')}${tail}`;
}

const has = (arr, path) => arr.some((e) => samePath(e.path, path));

// One directory's listing ({ files, dirs }) with the pending ops applied.
// Rows the ops put there carry `_pending: true` so the grid can dim them.
export function applyOpsToListing(listing, dir, ops) {
  let files = listing?.files || [];
  let dirs = listing?.dirs || [];
  if (!ops || ops.length === 0) return { files, dirs };
  const here = normPath(dir);
  files = files.slice();
  dirs = dirs.slice();
  for (const op of ops) {
    if (op.type === 'remove') {
      if (op.isDir) dirs = dirs.filter((e) => !samePath(e.path, op.path));
      else files = files.filter((e) => !samePath(e.path, op.path));
    } else if (op.type === 'move') {
      const drop = (arr) => arr.filter((e) => !samePath(e.path, op.from));
      if (op.isDir) dirs = drop(dirs); else files = drop(files);
      if (normPath(parentOf(op.to)) === here) {
        const arr = op.isDir ? dirs : files;
        if (!has(arr, op.to)) arr.push({ ...(op.entry || {}), name: baseName(op.to), path: op.to, _pending: true });
      }
    } else if (op.type === 'add') {
      if (normPath(parentOf(op.path)) !== here) continue;
      const arr = op.isDir ? dirs : files;
      if (!has(arr, op.path)) arr.push({ ...(op.entry || {}), name: baseName(op.path), path: op.path, _pending: true });
    }
  }
  return { files, dirs };
}

// The recursive file listing (files only, full paths) with the ops applied.
// `skipRemoves` leaves deletions out — used for the sidecar reconcile, so a
// file whose delete then FAILS still has the id it had.
export function applyOpsToAll(files, ops, { skipRemoves = false } = {}) {
  let list = files || [];
  if (!ops || ops.length === 0) return list;
  for (const op of ops) {
    if (op.type === 'remove') {
      if (skipRemoves) continue;
      list = list.filter((f) => !(op.isDir ? isUnder(f.path, op.path) : samePath(f.path, op.path)));
    } else if (op.type === 'move') {
      const moved = [];
      const kept = [];
      for (const f of list) {
        const hit = op.isDir ? isUnder(f.path, op.from) : samePath(f.path, op.from);
        if (!hit) { kept.push(f); continue; }
        const path = op.isDir ? reroot(f.path, op.from, op.to) : op.to;
        moved.push({ ...f, path, name: baseName(path) });
      }
      if (moved.length === 0) continue;
      // The destination may already be listed (the disk got there first).
      list = [...kept, ...moved.filter((m) => !has(kept, m.path))];
    } else if (op.type === 'add') {
      if (op.isDir || has(list, op.path)) continue;
      list = [...list, { ...(op.entry || {}), name: baseName(op.path), path: op.path, _pending: true }];
    }
  }
  return list;
}

// The Trash listing with restored / purged records taken out.
export function applyOpsToTrash(items, ops) {
  if (!ops || ops.length === 0) return items || [];
  const gone = new Set(ops.filter((o) => o.type === 'trash-remove').map((o) => o.stored));
  if (gone.size === 0) return items || [];
  return (items || []).filter((t) => !gone.has(t.stored));
}

// Every path an in-flight op is touching (both ends of a move), normalised —
// the handlers refuse a second destructive action on any of them.
export function pendingPaths(ops) {
  const set = new Set();
  for (const op of ops || []) {
    if (op.type === 'remove') set.add(normPath(op.path));
    else if (op.type === 'move') { set.add(normPath(op.from)); set.add(normPath(op.to)); }
    else if (op.type === 'add') set.add(normPath(op.path));
  }
  return set;
}
