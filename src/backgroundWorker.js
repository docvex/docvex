// THE BACKGROUND HELPER — an Electron utility process (its own Node process)
// that does the work which used to block the main process, and with it every
// window: the project index (synchronous SQLite, whole-folder reconciles,
// hashing large files) and reading legacy .doc files (a CPU-bound parse in JS).
//
// main.js forks it on first use (see `backgroundHelper` there) and talks to it
// over the parent port:
//   → { type: 'init', userDataDir }
//   → { type: 'call', id, method, arg }        a project-index method, or
//                                              'extractDoc' ({ path })
//   ← { type: 'result', id, result }
//   ← { type: 'broadcast', channel, payload }  the index's events for windows
//   ← { type: 'projectDir', dir }              a folder to serve over localfile://
//   → { type: 'close' }  ← { type: 'closed' }  flush and stop before quit
// Messages on one port arrive in order, so a `projectDir` the index announced
// while answering a call always reaches main before that call's result.
import { createProjectIndexService } from './projectIndex/index.js';

const port = process.parentPort;
let service = null;

async function extractDoc({ path } = {}) {
  if (typeof path !== 'string' || !path) return { error: 'no_path' };
  try {
    const { default: WordExtractor } = await import('word-extractor');
    const doc = await new WordExtractor().extract(path);
    return { text: (doc.getBody() || '').trim() };
  } catch (err) {
    return { error: String(err?.message || err) };
  }
}

async function call(method, arg) {
  if (method === 'extractDoc') return extractDoc(arg);
  if (!service) return { ok: false, error: 'not_initialised' };
  const fn = service[method];
  if (typeof fn !== 'function' || method.startsWith('_')) return { ok: false, error: `unknown_method:${method}` };
  return fn(arg);
}

port.on('message', async (e) => {
  const msg = e.data || {};
  if (msg.type === 'init') {
    if (service) return;
    service = createProjectIndexService({
      userDataDir: msg.userDataDir,
      broadcast: (channel, payload) => port.postMessage({ type: 'broadcast', channel, payload }),
      onProjectDir: (dir) => port.postMessage({ type: 'projectDir', dir }),
    });
    return;
  }
  if (msg.type === 'call') {
    let result;
    try { result = await call(msg.method, msg.arg); } catch (err) {
      result = { ok: false, error: err?.message || String(err) };
    }
    try { port.postMessage({ type: 'result', id: msg.id, result }); } catch (err) {
      // An answer that can't be cloned across processes — say so rather
      // than leaving the caller waiting.
      port.postMessage({ type: 'result', id: msg.id, result: { ok: false, error: `unclonable_result:${err?.message || err}` } });
    }
    return;
  }
  if (msg.type === 'close') {
    try { service?.close(); } catch { /* quitting anyway */ }
    service = null;
    port.postMessage({ type: 'closed' });
  }
});
