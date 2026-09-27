// Face matching — is the person on an identity document the person in a photo?
//
// Used by the Files tab's AI scan (lib/dataCollections): the photo on an
// identity document the scan recognised (a Romanian CI, a passport…) is
// compared with every face in the project's pictures, and a picture showing the
// same person joins that person's Data collection, with a confidence score.
//
// EVERYTHING HAPPENS ON THIS COMPUTER. A face is biometric data — under the
// GDPR a special category — so none of this goes to an AI service: detection,
// alignment and the 128-number description of a face are computed locally by
// @vladmandic/face-api (TensorFlow.js; models copied into public/faces/ by
// scripts/copy-face-assets.mjs), and the descriptions are kept only in this
// machine's AI data (facet `faces`), never in the project folder. Only the
// RESULT — "photo X shows the holder of document Y, 87%" — is written into the
// collection.
//
// A match is a LEAD, not an identification: two people can look alike, and an
// ID photo is small, old and printed. The score says how alike the two faces
// are; the collection shows both faces side by side for a person to judge.
import { getAiFacet, saveAiFacet, stampFor } from './aiData';
import { readLocalBlob } from './localFolder';

// The detector's floor: below this it is more likely not a face at all.
const MIN_FACE_SCORE = 0.5;
// A picture is read at most this big on its long edge — enough for a small
// face in a group photo, and what keeps a 12 MP phone photo quick.
const MAX_EDGE = 1600;
// Bumped when what is stored per picture changes.
const FACES_VERSION = 1;

function facesBaseUrl() {
  const base = (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.BASE_URL) || './';
  return new URL(`${base.replace(/\/?$/, '/')}faces/`, window.location.href).href;
}

// XHR, not fetch: packaged Electron serves the app from file://, where fetch is
// refused and XHR is not (the OCR engine's models are read the same way).
function xhr(url, type) {
  return new Promise((resolve, reject) => {
    const r = new XMLHttpRequest();
    r.open('GET', url);
    r.responseType = type;
    r.onload = () => (r.response && (r.status === 200 || r.status === 0) ? resolve(r.response) : reject(new Error(`HTTP ${r.status}`)));
    r.onerror = () => reject(new Error('read failed'));
    r.send();
  });
}

let apiPromise = null;
function loadFaceApi() {
  if (!apiPromise) {
    apiPromise = (async () => {
      const faceapi = await import('@vladmandic/face-api');
      try { await faceapi.tf.setBackend('webgl'); } catch { /* the CPU backend then */ }
      await faceapi.tf.ready();
      const base = facesBaseUrl();
      const load = async (net, name) => {
        const manifest = await xhr(`${base}${name}-weights_manifest.json`, 'json');
        const groups = Array.isArray(manifest) ? manifest : [manifest];
        const specs = groups.flatMap((g) => g.weights);
        const buffers = await Promise.all(groups.flatMap((g) => g.paths).map((p) => xhr(`${base}${p}`, 'arraybuffer')));
        const total = buffers.reduce((n, b) => n + b.byteLength, 0);
        const joined = new Uint8Array(total);
        let at = 0;
        for (const b of buffers) { joined.set(new Uint8Array(b), at); at += b.byteLength; }
        net.loadFromWeightMap(faceapi.tf.io.decodeWeights(joined.buffer, specs));
      };
      await load(faceapi.nets.ssdMobilenetv1, 'ssd_mobilenetv1_model');
      await load(faceapi.nets.faceLandmark68Net, 'face_landmark_68_model');
      await load(faceapi.nets.faceRecognitionNet, 'face_recognition_model');
      return faceapi;
    })();
    apiPromise.catch(() => { apiPromise = null; });
  }
  return apiPromise;
}

async function decodeAt(path) {
  const blob = await readLocalBlob(path);
  if (!blob) throw new Error('unreadable');
  return createImageBitmap(blob);
}

// The picture drawn upright at ≤ MAX_EDGE, turned by `turns` quarter-turns.
function canvasOf(bitmap, turns = 0) {
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const side = turns % 2 === 1;
  const c = document.createElement('canvas');
  c.width = side ? h : w; c.height = side ? w : h;
  const ctx = c.getContext('2d');
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate((turns * Math.PI) / 2);
  ctx.drawImage(bitmap, -w / 2, -h / 2, w, h);
  return c;
}

// A box found on a turned canvas, back in the picture's own 0…1 coordinates.
function unturnBox(b, cw, ch, turns) {
  let { x, y, width: w, height: h } = b;
  x /= cw; y /= ch; w /= cw; h /= ch;
  for (let t = 0; t < turns; t += 1) {
    // Undo one clockwise quarter-turn: (x, y) → (y, 1 − x − w).
    [x, y, w, h] = [y, 1 - x - w, h, w];
  }
  return { x: +x.toFixed(4), y: +y.toFixed(4), w: +w.toFixed(4), h: +h.toFixed(4) };
}

async function detect(faceapi, canvas, turns) {
  const found = await faceapi
    .detectAllFaces(canvas, new faceapi.SsdMobilenetv1Options({ minConfidence: MIN_FACE_SCORE }))
    .withFaceLandmarks()
    .withFaceDescriptors();
  return found.map((f) => ({
    box: unturnBox(f.detection.box, canvas.width, canvas.height, turns),
    score: +f.detection.score.toFixed(3),
    descriptor: Array.from(f.descriptor, (v) => +v.toFixed(5)),
  }));
}

// The faces in one picture → [{ box, score, descriptor }]. Kept in the file's
// AI data (this machine only) and reused until the picture changes.
// `document`: an identity document — photographed sideways as often as not, so
// when upright finds no face the other three quarter-turns are tried.
export async function facesIn(file, { document = false, projectId } = {}) {
  const stamp = await stampFor(file.path);
  const saved = getAiFacet(file.path, 'faces', stamp);
  if (saved?.data?.v === FACES_VERSION && (!document || saved.data.turned || saved.data.faces.length)) return saved.data.faces;
  const faceapi = await loadFaceApi();
  const bitmap = await decodeAt(file.path);
  let faces = [];
  try {
    for (const turns of document ? [0, 1, 3, 2] : [0]) {
      faces = await detect(faceapi, canvasOf(bitmap, turns), turns);
      if (faces.length) break;
    }
  } finally {
    try { bitmap.close(); } catch { /* ignore */ }
  }
  const n = faces.length;
  saveAiFacet({ path: file.path, name: file.name, projectId }, 'faces', {
    data: {
      v: FACES_VERSION,
      turned: document,
      faces,
      text: n ? `${n} face${n === 1 ? '' : 's'} found. Compared on this computer only — nothing about a face is sent anywhere.` : 'No face found.',
    },
    engine: 'local',
    stamp,
  });
  return faces;
}

function distance(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i += 1) { const d = a[i] - b[i]; s += d * d; }
  return Math.sqrt(s);
}

// Distance → a 0…1 confidence. The recogniser's own "same person" line is a
// distance of 0.6; an ID photo is small and old, so the curve is centred
// stricter, at 0.5: 0.40 → 0.86, 0.45 → 0.70, 0.50 → 0.50, 0.55 → 0.30.
export function confidenceOf(d) {
  return 1 / (1 + Math.exp((d - 0.5) / 0.055));
}
export const MATCH_FLOOR = 0.5;
export function confidenceLabel(c) {
  if (c >= 0.85) return 'Strong match';
  if (c >= 0.65) return 'Likely match';
  return 'Possible match';
}

// The face on each identity document, and every picture face that matches it.
// `documents`: [{ path, name, rel, holder }]; `pictures`: [{ path, name, rel }].
// → { references: [{ rel, holder, box }], matches: [{ idRel, holder, rel, box,
//     idBox, confidence, distance, kind: 'photo' | 'document' }], errors }
export async function matchFaces(documents, pictures, { projectId, onProgress, isCancelled } = {}) {
  const references = [];
  const errors = [];
  for (const doc of documents) {
    if (isCancelled?.()) return { references, matches: [], errors };
    try {
      const faces = await facesIn(doc, { document: true, projectId });
      // The holder's photo is the biggest face on the document (a CI also
      // carries a small ghost copy of it).
      const main = faces.slice().sort((a, b) => (b.box.w * b.box.h) - (a.box.w * a.box.h))[0];
      if (main) references.push({ ...doc, box: main.box, descriptor: main.descriptor });
    } catch (err) { errors.push({ name: doc.name, error: err?.message || 'failed' }); }
  }
  if (!references.length) return { references: [], matches: [], errors };

  const matches = [];
  // Two identity documents of one person (a CI and a passport) link as well.
  for (let i = 0; i < references.length; i += 1) {
    for (let j = i + 1; j < references.length; j += 1) {
      const d = distance(references[i].descriptor, references[j].descriptor);
      const confidence = confidenceOf(d);
      if (confidence >= MATCH_FLOOR) {
        matches.push({ kind: 'document', idRel: references[i].rel, holder: references[i].holder, rel: references[j].rel, box: references[j].box, idBox: references[i].box, confidence: +confidence.toFixed(3), distance: +d.toFixed(4) });
      }
    }
  }
  const refRels = new Set(references.map((r) => r.rel));
  const others = pictures.filter((p) => !refRels.has(p.rel));
  for (let n = 0; n < others.length; n += 1) {
    if (isCancelled?.()) break;
    const pic = others[n];
    onProgress?.({ index: n, total: others.length, name: pic.name });
    let faces;
    try { faces = await facesIn(pic, { projectId }); } catch (err) { errors.push({ name: pic.name, error: err?.message || 'failed' }); continue; }
    for (const ref of references) {
      // The best face in the picture for this person — one match per picture.
      let best = null;
      for (const f of faces) {
        const d = distance(ref.descriptor, f.descriptor);
        if (!best || d < best.d) best = { d, f };
      }
      if (!best) continue;
      const confidence = confidenceOf(best.d);
      if (confidence < MATCH_FLOOR) continue;
      matches.push({ kind: 'photo', idRel: ref.rel, holder: ref.holder, rel: pic.rel, box: best.f.box, idBox: ref.box, confidence: +confidence.toFixed(3), distance: +best.d.toFixed(4) });
    }
  }
  return {
    references: references.map(({ rel, holder, box }) => ({ rel, holder, box })),
    matches: matches.sort((a, b) => b.confidence - a.confidence),
    errors,
  };
}
