// Deploys the board from a clean commit and proves the live page shows that commit.
//
// usage: node scripts/deploy.mjs [--media <dir with .mp4 files>]
//   SESSION_FILE  default ../private/session.txt (outside this repo, git-ignored by the workspace)
//   BOARD_URL     default https://sched-prod-board.orlando-x.workers.dev
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { COURSE_API, REPO, build, readSession } from './build.mjs';

const BOARD_URL = process.env.BOARD_URL ?? 'https://sched-prod-board.orlando-x.workers.dev';
const SESSION_FILE = resolve(process.env.SESSION_FILE ?? join(REPO, '..', 'private', 'session.txt'));
const PROVE_SHA256 = 'bc0bbd32e1227260d51e4746a9213f311f5353d2a5c486b061d39cf7dfd427f7';
const MAX_ASSET_BYTES = 25 * 1024 * 1024;

const git = (...args) => execFileSync('git', args, { cwd: REPO, encoding: 'utf8' }).trim();
const fail = (message) => {
  console.error(`deploy: ${message}`);
  process.exit(1);
};

const { values } = parseArgs({ options: { media: { type: 'string' } } });
const mediaDir = values.media ? resolve(values.media) : null;

if (git('status', '--porcelain')) fail('the working tree is not clean; commit first, so the sha names what ships');
const prove = createHash('sha256').update(readFileSync(join(REPO, '.github/workflows/prove.yml'))).digest('hex');
if (prove !== PROVE_SHA256) fail('.github/workflows/prove.yml differs from the starter');

const sha = git('rev-parse', 'HEAD');
const dist = join(REPO, 'dist');
build({ sha, api: COURSE_API, session: readSession(SESSION_FILE), outDir: dist });

if (mediaDir) {
  mkdirSync(join(dist, 'media'), { recursive: true });
  for (const name of readdirSync(mediaDir).filter((n) => n.endsWith('.mp4'))) {
    const size = statSync(join(mediaDir, name)).size;
    if (size >= MAX_ASSET_BYTES) fail(`${name} is ${size} bytes, over the 25 MiB asset limit`);
    cpSync(join(mediaDir, name), join(dist, 'media', name));
    console.log(`media: ${name} (${size} bytes)`);
  }
}

console.log(`deploying ${sha}`);
const out = execFileSync(join(REPO, 'node_modules/.bin/wrangler'), ['deploy'], { cwd: REPO, encoding: 'utf8' });
for (const line of out.split('\n')) if (/Version ID|https:\/\/|Uploaded|Deployed/.test(line)) console.log(`wrangler: ${line.trim()}`);

let live = '';
for (let attempt = 1; attempt <= 15; attempt += 1) {
  const res = await fetch(`${BOARD_URL}/?deploy-check=${Date.now()}`, { cache: 'no-store' });
  live = (/<meta name="build" content="([0-9a-f]{40})"/.exec(await res.text()) ?? [])[1] ?? '';
  if (res.ok && live === sha) break;
  await new Promise((done) => setTimeout(done, 2000));
}
if (live !== sha) fail(`live page shows ${live || 'no sha'}, expected ${sha}`);
console.log(`live: ${BOARD_URL} shows ${sha}`);
