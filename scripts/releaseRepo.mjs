// The PUBLIC GitHub repo that holds DocVex's releases (installers, update
// feed). Kept apart from the source repo so the source can be private: the
// Windows updater (update.electronjs.org), the macOS self-updater and the
// website's download page all read releases anonymously. One file,
// release-repo.json at the repo root, read by the app, forge.config.js and
// every release script.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { owner, name } = JSON.parse(readFileSync(join(root, 'release-repo.json'), 'utf8'));
export const RELEASE_OWNER = owner;
export const RELEASE_NAME = name;
export const RELEASE_REPO_URL = `https://github.com/${owner}/${name}`;
