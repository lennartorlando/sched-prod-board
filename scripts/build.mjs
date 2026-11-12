// Builds dist/ from app/: stamps the commit sha into the page and writes config.js.
// The session reaches only the built config.js, never git.
//
// usage: node scripts/build.mjs --sha <40 hex> --session-file <path> [--api <https url>] [--out <dir>]
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const COURSE_API = 'https://hq.mega.dev/challenges/show-me-when/api';
export const SHA_PLACEHOLDER = '__BUILD_SHA__';

export function assertSession(value, source = 'session') {
  if (!value || /\s/.test(value) || value.includes('<')) {
    throw new Error(`build: ${source} is empty, spans several lines or is a placeholder`);
  }
  return value;
}

// A real course session, as start-challenge hands it out (v1.<payload>.<signature>).
export function readSession(file) {
  const value = assertSession(readFileSync(file, 'utf8').trim(), file);
  if (!/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) throw new Error(`build: ${file} does not hold a course session`);
  return value;
}

export function build({ sha, api, session, outDir, appDir = join(REPO, 'app') }) {
  if (!/^[0-9a-f]{40}$/.test(sha ?? '')) throw new Error('build: sha must be a full 40-character git sha');
  if (!/^https:\/\/\S+$/.test(api ?? '')) throw new Error('build: api must be an https URL');
  assertSession(session);

  const index = readFileSync(join(appDir, 'index.html'), 'utf8');
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

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    options: { sha: { type: 'string' }, api: { type: 'string', default: COURSE_API }, 'session-file': { type: 'string' }, out: { type: 'string', default: join(REPO, 'dist') } },
  });
  const outDir = resolve(values.out);
  build({ sha: values.sha, api: values.api, session: readSession(values['session-file']), outDir });
  console.log(`built ${outDir} for ${values.sha}`);
}
