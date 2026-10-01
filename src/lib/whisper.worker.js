// Speech-to-text ON THIS COMPUTER (lib/transcribe): OpenAI's Whisper model
// (multilingual — Romanian included), run by transformers.js on ONNX Runtime
// Web (WebAssembly, single-threaded), OFF the window's main thread. Reading a
// recording is minutes of WebAssembly work; on the window's own thread the
// whole window would freeze for it.
//
// Nothing leaves the machine: the model files are served from the app itself
// (public/models/, put there by scripts/copy-whisper-assets.mjs on install) and
// remote model loading is switched OFF — the library never contacts
// huggingface.co or a CDN at runtime.
//
// Messages in:  { id, base, model, audio: Float32Array (16 kHz mono) }
// Messages out: { id, type: 'progress', progress }            (model loading)
//               { id, ok: true, text, chunks: [{ timestamp: [s, e], text }] }
//               { id, ok: false, error }
import { env, pipeline } from '@huggingface/transformers';

let pipePromise = null;
let pipeKey = '';

// fetch() where it works; XHR where it doesn't (a build loaded from file://
// refuses fetch of a local file, XHR still reads it) — handed to the library
// as its fetch, so the model files load either way.
async function localFetch(url, init) {
  try {
    const res = await fetch(url, init);
    return res;
  } catch { /* try XHR */ }
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', String(url));
    xhr.responseType = 'arraybuffer';
    xhr.onload = () => {
      const ok = xhr.status === 200 || (xhr.status === 0 && xhr.response);
      resolve(new Response(ok ? xhr.response : null, { status: ok ? 200 : (xhr.status || 404) }));
    };
    xhr.onerror = () => reject(new Error('unreadable'));
    xhr.send();
  });
}

function configure(base) {
  env.allowRemoteModels = false;              // never huggingface.co
  env.allowLocalModels = true;
  env.localModelPath = `${base}models/`;
  env.useBrowserCache = false;                // the files are already local
  env.useWasmCache = false;
  env.fetch = localFetch;
  const onnx = env.backends?.onnx;
  if (onnx?.wasm) {
    // The runtime's WebAssembly, copied beside the models — never the CDN
    // default transformers.js would otherwise use.
    onnx.wasm.wasmPaths = `${base}models/ort/`;
    // Threads need SharedArrayBuffer, which only a cross-origin-isolated page has.
    onnx.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
    onnx.wasm.proxy = false;
  }
}

function transcriber(base, model, id) {
  const key = `${base}|${model}`;
  if (!pipePromise || pipeKey !== key) {
    pipeKey = key;
    configure(base);
    pipePromise = pipeline('automatic-speech-recognition', model, {
      device: 'wasm',
      // 8-bit weights (…_quantized.onnx): the files copy-whisper-assets.mjs fetches.
      dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' },
      progress_callback: (p) => {
        if (p && (p.status === 'progress' || p.status === 'ready')) {
          self.postMessage({ id, type: 'progress', progress: { file: p.file, loaded: p.loaded, total: p.total, status: p.status } });
        }
      },
    }).catch((err) => { pipePromise = null; throw err; });
  }
  return pipePromise;
}

self.onmessage = async ({ data }) => {
  const { id, base, model, audio } = data || {};
  try {
    const asr = await transcriber(base, model, id);
    const out = await asr(audio, {
      task: 'transcribe',                     // never translate — keep the spoken language
      return_timestamps: true,
      chunk_length_s: 30,
      stride_length_s: 5,
    });
    const chunks = Array.isArray(out?.chunks) ? out.chunks.map((c) => ({
      timestamp: Array.isArray(c?.timestamp) ? c.timestamp : [null, null],
      text: String(c?.text ?? ''),
    })) : [];
    self.postMessage({ id, ok: true, text: String(out?.text ?? ''), chunks });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err?.message || err) });
  }
};
