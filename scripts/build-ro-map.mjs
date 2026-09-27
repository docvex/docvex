// Rebuilds src/lib/roCountiesMap.json — Romania's 41 counties and București as
// SVG paths, for the Court files tab's map (components/CourtMap).
//
// The outlines are Natural Earth's admin-1 boundaries (public domain,
// naturalearthdata.com), 1:10m. Download the GeoJSON first:
//
//   curl -L -o ne_admin1.geojson https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_1_states_provinces.geojson
//   node scripts/build-ro-map.mjs ne_admin1.geojson
//
// Projection: equirectangular around 46°N (x scaled by cos 46°), fitted to a
// 1000-unit-wide viewBox, north up; points closer than 0.6 units dropped.
// Each county carries its plate code ("CJ", "B") and a label point — the
// centroid of its largest ring, with the two that overlap at the capital
// (Ilfov around București) nudged apart.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = process.argv[2];
if (!src) { console.error('usage: node scripts/build-ro-map.mjs <ne_10m_admin_1_states_provinces.geojson>'); process.exit(1); }

const all = JSON.parse(fs.readFileSync(src, 'utf8'));
const feats = (all.features || []).filter((f) => (f.properties.iso_a2 || f.properties.ISO_A2) === 'RO');
if (feats.length !== 42) { console.error(`expected 42 Romanian units, found ${feats.length}`); process.exit(1); }

const K = Math.cos((46 * Math.PI) / 180);
const rings = (g) => (g.type === 'Polygon' ? [g.coordinates] : g.coordinates).flat();
let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
for (const f of feats) for (const r of rings(f.geometry)) for (const [lon, lat] of r) {
  const x = lon * K; const y = -lat;
  minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
}
const W = 1000;
const S = W / (maxX - minX);
const H = Math.round((maxY - minY) * S);
const pt = ([lon, lat]) => [(lon * K - minX) * S, (-lat - minY) * S];
const r1 = (n) => Math.round(n * 10) / 10;

function ringPath(r) {
  const pts = r.map(pt);
  const kept = [pts[0]];
  for (const p of pts.slice(1)) {
    const q = kept[kept.length - 1];
    if (Math.hypot(p[0] - q[0], p[1] - q[1]) >= 0.6) kept.push(p);
  }
  return `M${kept.map((p) => `${r1(p[0])},${r1(p[1])}`).join('L')}Z`;
}
function centroid(r) {
  const pts = r.map(pt);
  let a = 0; let cx = 0; let cy = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i]; const [x1, y1] = pts[i + 1];
    const c = x0 * y1 - x1 * y0;
    a += c; cx += (x0 + x1) * c; cy += (y0 + y1) * c;
  }
  a /= 2;
  return { area: Math.abs(a), x: cx / (6 * a), y: cy / (6 * a) };
}

// Label nudges, in viewBox units, where the centroid is not where a reader
// looks: Ilfov surrounds București, so its label goes above the capital's.
const NUDGE = { IF: [0, -16], B: [0, 6] };

const counties = feats.map((f) => {
  const code = String(f.properties.iso_3166_2 || '').replace(/^RO-/, '');
  const rs = rings(f.geometry);
  const outer = (f.geometry.type === 'Polygon' ? [f.geometry.coordinates[0]] : f.geometry.coordinates.map((p) => p[0]))
    .map((r) => centroid(r)).sort((a, b) => b.area - a.area)[0];
  const [dx, dy] = NUDGE[code] || [0, 0];
  return { code, d: rs.map(ringPath).join(''), x: r1(outer.x + dx), y: r1(outer.y + dy) };
}).sort((a, b) => a.code.localeCompare(b.code));

const out = { source: 'Natural Earth admin-1, 1:10m (public domain)', w: W, h: H, counties };
const dest = path.join(here, '..', 'src', 'lib', 'roCountiesMap.json');
fs.writeFileSync(dest, JSON.stringify(out));
console.log(`wrote ${dest}: ${counties.length} units, ${W}×${H}, ${(fs.statSync(dest).size / 1024).toFixed(1)} KB`);
