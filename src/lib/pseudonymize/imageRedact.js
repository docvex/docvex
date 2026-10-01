// Pseudonymisation for PICTURES (security fix, 2026-10-01). Text is masked by
// the vault before it leaves the computer; a picture sent to the AI used to go
// as it was — an ID card's CNP, an invoice's IBAN, a contract's names readable
// by anyone who saw the request. Now, when a call is masked, every picture in
// it is read HERE first (PaddleOCR, lib/paddleOcr — nothing leaves the
// machine), each line is masked by the same vault as the text, and a line
// holding an identifier is PAINTED OVER with its masked wording: a white band
// over the line, the line written again with its tokens ("CNP [CNP_07]").
// The AI reads the token like any printed text and the answer is re-identified
// as every masked answer is (lib/projectAi `restored`), so the feature keeps
// working and the value itself never goes out.
//
// Best effort, and said so: what the local reader misses (a faint stamp, hand
// writing, a line it reads wrongly) is not covered, and a face, a signature or
// a photo is not text at all. A picture that cannot be read or decoded here is
// NOT sent (fail closed) — the caller gets `image_redaction_failed`.

const isBase64Image = (v) => v && typeof v === 'object' && v.type === 'image'
  && v.source && v.source.type === 'base64' && typeof v.source.data === 'string';

const hasImages = (v) => {
  if (Array.isArray(v)) return v.some(hasImages);
  if (v && typeof v === 'object') return isBase64Image(v) || Object.values(v).some(hasImages);
  return false;
};

async function decode(b64, mediaType) {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const bitmap = await createImageBitmap(new Blob([bytes], { type: mediaType || 'image/jpeg' }));
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext('2d').drawImage(bitmap, 0, 0);
  bitmap.close?.();
  return canvas;
}

// One line, covered and written again: rotated with the line, the band a little
// larger than its box, the text shrunk to fit the band's length.
function paintLine(ctx, line, text) {
  const pad = Math.max(2, line.thick * 0.18);
  const w = line.along + pad * 2;
  const h = line.thick + pad * 2;
  ctx.save();
  ctx.translate(line.cx, line.cy);
  ctx.rotate((line.angle * Math.PI) / 180);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(-w / 2, -h / 2, w, h);
  let size = Math.max(8, line.thick * 0.82);
  ctx.font = `${size}px Arial, sans-serif`;
  const measured = ctx.measureText(text).width;
  if (measured > line.along) {
    size = Math.max(6, size * (line.along / measured));
    ctx.font = `${size}px Arial, sans-serif`;
  }
  ctx.fillStyle = '#000000';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  ctx.fillText(text, 0, 0, w);
  ctx.restore();
}

/**
 * A canvas with every identifier the vault recognises painted over with its
 * token. Answers how many lines were covered.
 * @returns {Promise<number>}
 */
export async function redactCanvas(canvas, vault, maskOpts) {
  const { readLines } = await import('../paddleOcr');
  const lines = await readLines(canvas);
  const ctx = canvas.getContext('2d');
  let covered = 0;
  for (const line of lines) {
    const out = vault.mask(line.text, maskOpts);
    if (out !== line.text) { paintLine(ctx, line, out); covered += 1; }
  }
  return covered;
}

async function redactBlock(block, vault, maskOpts) {
  const mediaType = block.source.media_type || 'image/jpeg';
  const canvas = await decode(block.source.data, mediaType);
  const covered = await redactCanvas(canvas, vault, maskOpts);
  if (!covered) return block;
  const type = mediaType === 'image/png' ? 'image/png' : 'image/jpeg';
  const url = canvas.toDataURL(type, 0.92);
  return { ...block, source: { ...block.source, media_type: type, data: url.slice(url.indexOf(',') + 1) } };
}

async function walk(v, vault, maskOpts) {
  if (Array.isArray(v)) {
    const out = [];
    for (const x of v) out.push(await walk(x, vault, maskOpts));
    return out;
  }
  if (isBase64Image(v)) return redactBlock(v, vault, maskOpts);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = await walk(x, vault, maskOpts);
    return out;
  }
  return v;
}

/**
 * A request body with every base64 picture redacted. Throws
 * `image_redaction_failed` when a picture cannot be read here — the caller
 * then sends nothing.
 */
export async function redactImagesInBody(body, vault, maskOpts) {
  if (!hasImages(body)) return body;
  try {
    return await walk(body, vault, maskOpts);
  } catch (err) {
    const e = new Error('image_redaction_failed');
    e.cause = err;
    throw e;
  }
}

export { hasImages };
