// WHERE EACH LETTER IS, as the recogniser saw it.
//
// PaddleOCR reads a line with a CTC model: the line's crop is squeezed to 48px
// high and the model answers one guess per column step ("timestep"); a letter is
// emitted where its run of columns starts. PaddleOCR's own `return_word_box`
// turns those column indices back into positions on the picture. The `paddleocr`
// package decodes the same output but throws the columns away, so this patches
// its (exported) RecognitionService to keep them:
//   · padRecognitionTensor → how wide the line was in the model's input
//     (`resizedWidth`) and how wide the input is (`targetWidth`, padding after);
//   · ctcLabelDecode       → the first and last timestep of every emitted letter;
//   · processBox           → each letter's centre mapped back through the line's
//     quad (the crop is a perspective cut of `box.points`), as `charPos`:
//     [{ ch, x, y }] in the picture's pixels.
// Lines whose crop was stood up (taller than wide — the package turns those a
// quarter) get no positions: the text runs the other way in them.
import { RecognitionService } from 'paddleocr';

// A point inside the quad, at (u along the top edge, v down), bilinearly — the
// perspective cut is close enough to bilinear over one line.
function inQuad(pts, u, v) {
  const top = { x: pts[0].x + (pts[1].x - pts[0].x) * u, y: pts[0].y + (pts[1].y - pts[0].y) * u };
  const bot = { x: pts[3].x + (pts[2].x - pts[3].x) * u, y: pts[3].y + (pts[2].y - pts[3].y) * u };
  return { x: top.x + (bot.x - top.x) * v, y: top.y + (bot.y - top.y) * v };
}

export function patchCharPositions() {
  const P = RecognitionService?.prototype;
  if (!P || P.__dvCharPos) return;
  P.__dvCharPos = true;
  const pad = P.padRecognitionTensor;
  P.padRecognitionTensor = function padWithGeometry(tensor, resizedWidth, height, targetWidth) {
    this.__dvGeom = { resizedWidth, targetWidth };
    return pad.call(this, tensor, resizedWidth, height, targetWidth);
  };
  const decode = P.ctcLabelDecode;
  P.ctcLabelDecode = function decodeWithColumns(logits, sequenceLength, numClasses, runtimeOptions, charWhiteSet) {
    // The same greedy decoding as the package's, keeping the columns.
    const dict = runtimeOptions.charactersDictionary;
    const withBlank = dict[0] === '' || dict[0] === 'blank';
    const chars = [];
    let last = -1;
    for (let t = 0; t < sequenceLength; t += 1) {
      let best = -Infinity; let idx = 0;
      const off = t * numClasses;
      for (let i = 0; i < numClasses; i += 1) { const v = logits[off + i]; if (v > best) { best = v; idx = i; } }
      if (idx === last) { if (idx !== 0 && chars.length) chars[chars.length - 1].t1 = t; continue; }
      last = idx;
      if (idx === 0) continue;
      const ch = dict[withBlank ? idx : idx - 1] || '';
      if (charWhiteSet && !charWhiteSet.has(ch) && ch !== ' ') continue;
      chars.push({ ch, t0: t, t1: t });
    }
    this.__dvChars = { chars, sequenceLength };
    return decode.call(this, logits, sequenceLength, numClasses, runtimeOptions, charWhiteSet);
  };
  const processBox = P.processBox;
  P.processBox = async function processBoxWithPositions(task, runtimeOptions) {
    this.__dvGeom = null; this.__dvChars = null;
    const result = await processBox.call(this, task, runtimeOptions);
    try {
      const geom = this.__dvGeom; const dec = this.__dvChars;
      const pts = task?.box?.points;
      if (result && geom && dec && Array.isArray(pts) && pts.length === 4 && !runtimeOptions?.reverseText) {
        const w = Math.max(Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y), Math.hypot(pts[2].x - pts[3].x, pts[2].y - pts[3].y));
        const h = Math.max(Math.hypot(pts[3].x - pts[0].x, pts[3].y - pts[0].y), Math.hypot(pts[2].x - pts[1].x, pts[2].y - pts[1].y));
        if (h / Math.max(1, w) < 1.5) {
          const step = geom.targetWidth / dec.sequenceLength;   // input px per timestep
          const flip = !!result.textlineOrientation?.rotated;
          result.charPos = dec.chars.map(({ ch, t0, t1 }) => {
            let u = (((t0 + t1 + 1) / 2) * step) / geom.resizedWidth;
            u = Math.min(1, Math.max(0, flip ? 1 - u : u));
            const p = inQuad(pts, u, 0.5);
            return { ch, x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100 };
          });
        }
      }
    } catch { /* the line is still read; it just has no letter positions */ }
    this.__dvGeom = null; this.__dvChars = null;
    return result;
  };
}
