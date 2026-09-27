// Writes landing/home/upload.html — the page a phone opens from the Files tab's
// "Any connection" QR code (docvex.ro/upload.html?t=<token>). It is the SAME
// page the desktop app serves over the local network (src/lib/phoneUploadPage),
// in its cloud mode: files go to the `phone-upload` Edge Function's signed
// upload URLs. Run after changing the page, then `npm run site:deploy`.
//
//   node scripts/build-upload-page.mjs

import { writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SUPABASE_URL = 'https://pntxlvhkqfryyyxlqytr.supabase.co';
// The publishable key the website already ships (landing/home/supabase.js).
const ANON = 'sb_publishable_2JXDUwP4MFAk9t78UELKpA_99CImHfW';

// The icons first, so the page carries the Files tab's current set.
execFileSync(process.execPath, [join(root, 'scripts', 'build-phone-glyphs.mjs')], { stdio: 'inherit' });
const glyphsTmp = join(root, 'node_modules', '.cache', 'phone-upload-glyphs.mjs');
await build({ entryPoints: [join(root, 'src', 'lib', 'phoneUploadGlyphs.js')], bundle: true, format: 'esm', platform: 'node', outfile: glyphsTmp, logLevel: 'error' });
const { PHONE_GLYPHS, PHONE_GLYPH_CATS, PHONE_GLYPH_CSS } = await import(pathToFileURL(glyphsTmp).href + `?t=${Date.now()}`);

const tmp = join(root, 'node_modules', '.cache', 'phone-upload-page.mjs');
await build({ entryPoints: [join(root, 'src', 'lib', 'phoneUploadPage.js')], bundle: true, format: 'esm', platform: 'node', outfile: tmp, logLevel: 'error' });
const { phoneUploadPage } = await import(pathToFileURL(tmp).href);
const html = phoneUploadPage({ mode: 'cloud', fn: `${SUPABASE_URL}/functions/v1/phone-upload`, anon: ANON, glyphs: { icons: PHONE_GLYPHS, cats: PHONE_GLYPH_CATS, css: PHONE_GLYPH_CSS } });
await writeFile(join(root, 'landing', 'home', 'upload.html'), html, 'utf8');
console.log('wrote landing/home/upload.html');
