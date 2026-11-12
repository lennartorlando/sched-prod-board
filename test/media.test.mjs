// The /media/* handler answers byte ranges over the assets binding (src/media.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/media.js';

const FILE = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
const env = {
  ASSETS: {
    async fetch(request) {
      assert.equal(request.headers.get('range'), null, 'the handler must not pass Range to the assets binding');
      if (new URL(request.url).pathname === '/media/clip.mp4') {
        return new Response(FILE, { status: 200, headers: { 'content-type': 'video/mp4', etag: '"v1"' } });
      }
      return new Response('not found', { status: 404 });
    },
  },
};

const get = (path, headers = {}) => worker.fetch(new Request(`https://board.test${path}`, { headers }), env);

test('a closed range answers 206 with exactly those bytes', async () => {
  const res = await get('/media/clip.mp4', { range: 'bytes=0-1' });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-range'), 'bytes 0-1/10');
  assert.equal(res.headers.get('accept-ranges'), 'bytes');
  assert.equal(res.headers.get('content-type'), 'video/mp4');
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), new Uint8Array([0, 1]));
});

test('an open-ended range answers the rest of the file', async () => {
  const res = await get('/media/clip.mp4', { range: 'bytes=5-' });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-range'), 'bytes 5-9/10');
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), new Uint8Array([5, 6, 7, 8, 9]));
});

test('a suffix range answers the last bytes', async () => {
  const res = await get('/media/clip.mp4', { range: 'bytes=-3' });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-range'), 'bytes 7-9/10');
});

test('a range past the end answers 416', async () => {
  const res = await get('/media/clip.mp4', { range: 'bytes=20-' });
  assert.equal(res.status, 416);
  assert.equal(res.headers.get('content-range'), 'bytes */10');
});

test('no Range header answers the whole file with 200', async () => {
  const res = await get('/media/clip.mp4');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('accept-ranges'), 'bytes');
  assert.equal((await res.arrayBuffer()).byteLength, 10);
});

test('a missing file keeps the assets 404', async () => {
  const res = await get('/media/nope.mp4', { range: 'bytes=0-1' });
  assert.equal(res.status, 404);
});
