// The build refuses what would ship a wrong page or a missing session (plan R6, R9).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build, readSession } from '../scripts/build.mjs';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const API = 'https://fake-api.test/api';
const tmp = () => mkdtempSync(join(tmpdir(), 'build-test-'));

test('the starter placeholder session is refused before anything is written', () => {
  const out = join(tmp(), 'dist');
  assert.throws(() => build({ sha: SHA, api: API, session: '<session from start-challenge>', outDir: out }), /placeholder/);
});

test('a session file that holds no course session is refused', () => {
  const dir = tmp();
  writeFileSync(join(dir, 'empty.txt'), '\n');
  writeFileSync(join(dir, 'other.txt'), 'not-a-session\n');
  assert.throws(() => readSession(join(dir, 'empty.txt')), /empty/);
  assert.throws(() => readSession(join(dir, 'other.txt')), /does not hold a course session/);
  writeFileSync(join(dir, 'real.txt'), 'v1.eyJhIjoiYiJ9.c2lnbmF0dXJl\n');
  assert.equal(readSession(join(dir, 'real.txt')), 'v1.eyJhIjoiYiJ9.c2lnbmF0dXJl');
  rmSync(dir, { recursive: true, force: true });
});

test('a short sha and a page without both sha slots are refused', () => {
  const app = tmp();
  writeFileSync(join(app, 'index.html'), '<meta name="build" content="__BUILD_SHA__">');
  assert.throws(() => build({ sha: 'abc1234', api: API, session: 's', outDir: join(tmp(), 'd') }), /40-character/);
  assert.throws(() => build({ sha: SHA, api: API, session: 's', outDir: join(tmp(), 'd'), appDir: app }), /expected 2 build sha slots/);
  rmSync(app, { recursive: true, force: true });
});
