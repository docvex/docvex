// BARCODES AND QR CODES in a picture — read locally, nothing sent anywhere.
// ZXing's pure-JavaScript decoder (`@zxing/library`, lazy-imported: paid only
// when Barcode is pressed). It finds ONE code per pass, so every code found is
// blanked out and the picture read again, until nothing more is found (at most
// MAX_CODES) — a trade-register extract carries a Code 128, a receipt a QR
// code, an invoice both.
//
//   decodeLuminance(lum, w, h, { only }) → [{ format, text, box }]   (pure: testable in Node)
//   readBarcodes(img, { only })          → the same, from an <img> / canvas on screen
//   describeQr(text)                     → what a QR code's text IS (a link, a Wi-Fi
//                                          network, a contact, a payment…)
//
// `only: 'qr'` (the QR code quick action) reads QR codes alone, and also reads
// the picture INVERTED — a light code on a dark ground, which a plain pass
// misses — since it is not also hunting for every 1-D format.
//
// `box` is the code's place, normalised 0…1 on the picture ({ x, y, w, h }).

const MAX_EDGE = 2000;
const MAX_CODES = 8;

let zx = null;
const load = () => (zx ||= import('@zxing/library').catch((e) => { zx = null; throw e; }));

const FORMAT_NAMES = {
  QR_CODE: 'QR code', DATA_MATRIX: 'Data Matrix', AZTEC: 'Aztec', PDF_417: 'PDF417',
  CODE_128: 'Code 128', CODE_39: 'Code 39', CODE_93: 'Code 93', CODABAR: 'Codabar', ITF: 'ITF',
  EAN_13: 'EAN-13', EAN_8: 'EAN-8', UPC_A: 'UPC-A', UPC_E: 'UPC-E', RSS_14: 'GS1 DataBar', RSS_EXPANDED: 'GS1 DataBar Expanded',
};

/** Every code in a grey picture (`lum`: one byte per pixel, w × h). */
export async function decodeLuminance(lum, w, h, { only = null, inverted = false } = {}) {
  const Z = await load();
  const hints = new Map();
  hints.set(Z.DecodeHintType.TRY_HARDER, true);
  if (only === 'qr') hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, [Z.BarcodeFormat.QR_CODE]);
  const reader = new Z.MultiFormatReader();
  reader.setHints(hints);
  const work = new Uint8ClampedArray(lum);
  const out = [];
  for (let n = 0; n < MAX_CODES; n++) {
    let res = null;
    try {
      const bmp = new Z.BinaryBitmap(new Z.HybridBinarizer(new Z.RGBLuminanceSource(work, w, h)));
      res = reader.decodeWithState(bmp);
    } catch { res = null; }
    reader.reset();
    if (!res) break;
    const pts = (res.getResultPoints() || []).map((p) => [p.getX(), p.getY()]);
    const xs = pts.map((p) => p[0]); const ys = pts.map((p) => p[1]);
    let x0 = Math.min(...xs); let x1 = Math.max(...xs); let y0 = Math.min(...ys); let y1 = Math.max(...ys);
    // A 1-D code's points lie on one line across it: its height is not in
    // them, so the blank (and the box) is grown to a band around that line.
    const wide = x1 - x0; const tall = y1 - y0;
    const padX = Math.max(8, wide * 0.08); const padY = Math.max(8, tall * 0.12, wide * (tall < wide * 0.2 ? 0.25 : 0));
    x0 = Math.max(0, Math.floor(x0 - padX)); x1 = Math.min(w, Math.ceil(x1 + padX));
    y0 = Math.max(0, Math.floor(y0 - padY)); y1 = Math.min(h, Math.ceil(y1 + padY));
    const format = Z.BarcodeFormat[res.getBarcodeFormat()];
    const text = res.getText();
    if (!out.some((c) => c.text === text && c.format === (FORMAT_NAMES[format] || format))) {
      out.push({ format: FORMAT_NAMES[format] || String(format), text, box: { x: x0 / w, y: y0 / h, w: (x1 - x0) / w, h: (y1 - y0) / h } });
    }
    // Blank it and look again.
    for (let y = y0; y < y1; y++) work.fill(255, y * w + x0, y * w + x1);
  }
  // A light QR code on a dark ground: read the picture inverted too.
  if (only === 'qr' && !out.length && !inverted) {
    const inv = new Uint8ClampedArray(lum.length);
    for (let i = 0; i < lum.length; i++) inv[i] = 255 - lum[i];
    return decodeLuminance(inv, w, h, { only, inverted: true });
  }
  return out;
}

/** Every code in a picture on screen (an <img> or a canvas). */
export async function readBarcodes(img, opts = {}) {
  const w0 = img.naturalWidth || img.width; const h0 = img.naturalHeight || img.height;
  if (!w0 || !h0) throw new Error('The picture hasn’t loaded yet.');
  const k = Math.min(1, MAX_EDGE / Math.max(w0, h0));
  const w = Math.max(1, Math.round(w0 * k)); const h = Math.max(1, Math.round(h0 * k));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;
  const lum = new Uint8ClampedArray(w * h);
  for (let i = 0, j = 0; j < lum.length; i += 4, j++) lum[j] = (px[i] * 299 + px[i + 1] * 587 + px[i + 2] * 114) / 1000;
  return decodeLuminance(lum, w, h, opts);
}

// What a QR code's text is, read by the conventions phones use:
// { type, label, fields: [[name, value]], url? } — `url` when it can be opened.
export function describeQr(text) {
  const t = String(text || '').trim();
  const kv = (body) => {
    const out = {};
    // WIFI:T:WPA;S:name;P:pass;; — values may escape ; , : \ with a backslash.
    body.replace(/([A-Z]+):((?:\\.|[^;])*);?/gi, (_, k, v) => { out[k.toUpperCase()] = v.replace(/\\(.)/g, '$1'); return ''; });
    return out;
  };
  if (/^https?:\/\//i.test(t)) return { type: 'link', label: 'Link', fields: [], url: t };
  if (/^www\./i.test(t)) return { type: 'link', label: 'Link', fields: [], url: `https://${t}` };
  if (/^WIFI:/i.test(t)) {
    const f = kv(t.slice(5));
    return { type: 'wifi', label: 'Wi-Fi network', fields: [['Network', f.S || ''], ['Password', f.P || ''], ['Security', f.T || (f.P ? 'WPA' : 'Open')]].filter((x) => x[1]) };
  }
  if (/^mailto:/i.test(t)) return { type: 'email', label: 'Email', fields: [['To', decodeURIComponent(t.slice(7).split('?')[0])]], url: t };
  if (/^MATMSG:/i.test(t)) { const f = kv(t.slice(7)); return { type: 'email', label: 'Email', fields: [['To', f.TO || ''], ['Subject', f.SUB || ''], ['Message', f.BODY || '']].filter((x) => x[1]), url: f.TO ? `mailto:${f.TO}` : '' }; }
  if (/^tel:/i.test(t)) return { type: 'phone', label: 'Phone number', fields: [['Number', t.slice(4)]], url: t };
  if (/^(smsto|sms):/i.test(t)) { const [, n, m] = t.split(':'); return { type: 'sms', label: 'Text message', fields: [['To', n || ''], ['Message', m || '']].filter((x) => x[1]) }; }
  if (/^geo:/i.test(t)) { const [lat, lon] = t.slice(4).split(/[,?]/); return { type: 'place', label: 'Place', fields: [['Coordinates', `${lat}, ${lon}`]], url: `https://www.google.com/maps?q=${lat},${lon}` }; }
  if (/^BEGIN:VCARD/i.test(t)) {
    const line = (k) => (t.match(new RegExp(`^${k}(?:;[^:\n]*)?:(.*)$`, 'im')) || [])[1]?.trim() || '';
    const n = line('FN') || line('N').split(';').filter(Boolean).reverse().join(' ');
    return { type: 'contact', label: 'Contact', fields: [['Name', n], ['Organisation', line('ORG').replace(/;/g, ' ')], ['Phone', line('TEL')], ['Email', line('EMAIL')], ['Address', line('ADR').replace(/;+/g, ' ').trim()]].filter((x) => x[1]) };
  }
  if (/^MECARD:/i.test(t)) { const f = kv(t.slice(7)); return { type: 'contact', label: 'Contact', fields: [['Name', (f.N || '').split(',').reverse().join(' ').trim()], ['Phone', f.TEL || ''], ['Email', f.EMAIL || ''], ['Address', f.ADR || '']].filter((x) => x[1]) }; }
  if (/^BEGIN:VEVENT|^BEGIN:VCALENDAR/i.test(t)) {
    const line = (k) => (t.match(new RegExp(`^${k}(?:;[^:\n]*)?:(.*)$`, 'im')) || [])[1]?.trim() || '';
    return { type: 'event', label: 'Calendar event', fields: [['Event', line('SUMMARY')], ['Starts', line('DTSTART')], ['Ends', line('DTEND')], ['Where', line('LOCATION')]].filter((x) => x[1]) };
  }
  // The EPC (SEPA credit transfer) code European invoices carry.
  if (/^BCD\r?\n/.test(t)) {
    const l = t.split(/\r?\n/);
    return { type: 'payment', label: 'Bank transfer (SEPA)', fields: [['Beneficiary', l[5] || ''], ['IBAN', l[6] || ''], ['BIC', l[4] || ''], ['Amount', (l[7] || '').replace(/^([A-Z]{3})(.*)$/, '$2 $1')], ['Reference', l[9] || l[10] || '']].filter((x) => x[1]) };
  }
  return { type: 'text', label: 'Text', fields: [] };
}
