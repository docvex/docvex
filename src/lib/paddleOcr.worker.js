// PaddleOCR, OFF the window's main thread (lib/paddleOcr). Reading a picture is
// seconds of WebAssembly work; run where the page runs, the whole window froze
// for that long — for every picture the Files tab's AI scan went through. Here
// the window only draws the picture and hands its pixels over.
//
// Messages in:  { id, base, image: { width, height, data: Uint8Array } }
// Messages out: { id, ok: true, results: [{ text, confidence, box }] }
//               { id, ok: false, error }
import * as ort from 'onnxruntime-web/wasm';
import { PaddleOcrService } from 'paddleocr';
import { patchCharPositions } from './paddleCharPos';

// Each letter's position as the recogniser saw it (lib/paddleCharPos).
patchCharPositions();

let enginePromise = null;

async function readBytes(url) {
  try {
    const res = await fetch(url);
    if (res.ok) return await res.arrayBuffer();
  } catch { /* try XHR */ }
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url);
    xhr.responseType = 'arraybuffer';
    xhr.onload = () => (xhr.status === 200 || (xhr.status === 0 && xhr.response) ? resolve(xhr.response) : reject(new Error(`HTTP ${xhr.status}`)));
    xhr.onerror = () => reject(new Error('unreadable'));
    xhr.send();
  });
}

function engine(base) {
  if (!enginePromise) {
    enginePromise = (async () => {
      ort.env.wasm.wasmPaths = `${base}ort/`;
      // Threads need SharedArrayBuffer, which only a cross-origin-isolated page has.
      ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
      const [det, rec, dict] = await Promise.all([
        readBytes(`${base}paddle/det.onnx`),
        readBytes(`${base}paddle/rec.onnx`),
        readBytes(`${base}paddle/dict.txt`).then((b) => new TextDecoder().decode(b)),
      ]);
      return PaddleOcrService.createInstance({
        ort,
        modelPreset: 'PP-OCRv6_small',
        detection: { modelBuffer: det },
        // PaddleOCR's own `use_space_char`: the space is the list's last class.
        recognition: { modelBuffer: rec, charactersDictionary: [...dict.replace(/\r/g, '').replace(/\n+$/, '').split('\n'), ' '] },
      });
    })().catch((err) => { enginePromise = null; throw err; });
  }
  return enginePromise;
}

self.onmessage = async ({ data }) => {
  const { id, base, image } = data || {};
  try {
    const ocr = await engine(base);
    const res = await ocr.recognize(image, { ordering: { sortByReadingOrder: true, sameLineThresholdRatio: 0.5 } });
    const results = (res || []).map((r) => ({ text: r.text, confidence: r.confidence, box: r.box, charPos: r.charPos || null }));
    self.postMessage({ id, ok: true, results });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err?.message || err) });
  }
};
