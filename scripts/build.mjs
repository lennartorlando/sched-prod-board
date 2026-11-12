// Builds dist/ from app/: stamps the commit sha into the page and writes config.js.
// The session reaches only the built config.js, never git.
//
// usage: node scripts/build.mjs --sha <40 hex> --api <https url> --session-file <path> [--out <dir>]
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const SHA_PLACEHOLDER = '__BUILD_SHA__';

export function readSession(file) {
  const value = readFileSync(file, 'utf8').trim();
  if (!value || /\s/.test(value) || value.includes('<')) {
    throw new Error(`build: ${file} does not hold a session (empty, several lines or a placeholder)`);
  }
  return value;
}

export function build({ sha, api, session, outDir, appDir = join(REPO, 'app') }) {
  if (!/^[0-9a-f]{40}$/.test(sha ?? '')) throw new Error('build: sha must be a full 40-character git sha');
  if (!/^https:\/\/\S+$/.test(api ?? '')) throw new Error('build: api must be an https URL');
  if (!session || /\s/.test(session) || session.includes('<')) throw new Error('build: missing or placeholder session');

  const indexPath = join(appDir, 'index.html');
  const index = readFileSync(indexPath, 'utf8');
  const slots = index.split(SHA_PLACEHOLDER).length - 1;
  if (slots !== 2) throw new Error(`build: expected 2 build sha slots in index.html, found ${slots}`);

  rmSync(outDir, { recursive: true, force: true });
  cpSync(appDir, outDir, { recursive: true });
  writeFileSync(join(outDir, 'index.html'), index.replaceAll(SHA_PLACEHOLDER, sha));
  writeFileSync(
    join(outDir, 'config.js'),
    '// Written by scripts/build.mjs for one deploy. Not in git.\n' +
      `export const API = ${JSON.stringify(api)};\n` +
      `export const SESSION = ${JSON.stringify(session)};\n`,
  );
  return outDir;
}

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) out[argv[i].replace(/^--/, '')] = argv[i + 1];
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const a = args(process.argv.slice(2));
  const outDir = resolve(a.out ?? join(REPO, 'dist'));
  build({ sha: a.sha, api: a.api, session: readSession(a['session-file']), outDir });
  console.log(`built ${outDir} for ${a.sha}`);
}
