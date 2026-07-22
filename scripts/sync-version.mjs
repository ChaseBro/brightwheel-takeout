// Verifies that the manifest's version comes from package.json.
//
// `manifest.ts` imports `../package.json` and uses `pkg.version` in
// defineManifest(), so a `npm version <patch|minor|major> --no-git-tag-version`
// followed by a `vite build` is enough to propagate. This script exists to make
// that guarantee explicit: it prints the current version, and (unless
// SKIP_BUILD=1) runs `vite build` and re-reads dist/manifest.json to confirm
// the built manifest carries the same version string.

import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const HERE = new URL('.', import.meta.url).pathname;
const EXT_ROOT = resolve(HERE, '..');

const pkg = JSON.parse(await fs.readFile(join(EXT_ROOT, 'package.json'), 'utf8'));
const version = pkg.version;
console.log(`package.json version: ${version}`);

if (process.env.SKIP_BUILD === '1') {
  console.log('SKIP_BUILD=1 set — not rebuilding.');
  process.exit(0);
}

console.log('Rebuilding extension to propagate version into dist/manifest.json…');
const build = spawnSync('npx', ['vite', 'build'], {
  cwd: EXT_ROOT,
  stdio: 'inherit',
});
if (build.status !== 0) {
  console.error('vite build failed.');
  process.exit(build.status ?? 1);
}

const manifestPath = join(EXT_ROOT, 'dist', 'manifest.json');
const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
if (manifest.version !== version) {
  console.error(
    `version mismatch: package.json ${version} but dist/manifest.json ${manifest.version}`
  );
  process.exit(1);
}
console.log(`dist/manifest.json version: ${manifest.version} — synced.`);
