// Probes the deployed board. Prints one line per check and exits 1 on any failure.
// Never prints the session.
//
// usage: node scripts/check-live.mjs <board url> [--sha <40 hex>] [--media </media/file.mp4>]
import { parseArgs } from 'node:util';
import { COURSE_API } from './build.mjs';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { sha: { type: 'string' }, media: { type: 'string' } } });
const opt = (name) => values[name];
const base = new URL(positionals[0]);
let failed = 0;

function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failed += 1;
}

const get = (path, init) => fetch(new URL(path, base), { cache: 'no-store', ...init });

check('https', base.protocol === 'https:');

const page = await get('/');
const html = await page.text();
const meta = (/<meta name="build" content="([^"]*)"/.exec(html) ?? [])[1];
const footer = [...html.matchAll(/data-testid="build-sha"[^>]*>([^<]*)</g)].map((m) => m[1]);
check('page answers 200', page.status === 200, String(page.status));
check('meta build is a full sha', /^[0-9a-f]{40}$/.test(meta ?? ''), meta);
if (opt('sha')) check('meta build is the expected commit', meta === opt('sha'));
check('exactly one build-sha, equal to meta', footer.length === 1 && footer[0] === meta, footer.join(','));
for (const hook of ['board', 'loader', 'empty', 'incident-list']) {
  check(`hook ${hook} in the page`, html.includes(`data-testid="${hook}"`));
}

const config = await get('/config.js');
const configText = await config.text();
check('config.js answers 200', config.status === 200, String(config.status));
check('config.js names the course API', configText.includes(JSON.stringify(COURSE_API)));
check('config.js holds a session, not the placeholder', /SESSION = "v1\.[^"\s<]+"/.test(configText));

for (const path of ['/app.js', '/api.js', '/style.css']) {
  const res = await get(path);
  check(`${path} answers 200`, res.status === 200, String(res.status));
}

const malformed = await get('/%FF');
check('malformed path answers 404, not 5xx', malformed.status === 404, String(malformed.status));
const unknown = await get(`/no-such-file-${Date.now()}`);
check('unknown path answers 404', unknown.status === 404, String(unknown.status));

const media = opt('media');
if (media) {
  const full = await get(media);
  const bytes = (await full.arrayBuffer()).byteLength;
  check('video answers 200', full.status === 200, String(full.status));
  check('video is video/mp4', (full.headers.get('content-type') ?? '').startsWith('video/mp4'), full.headers.get('content-type'));
  check('video size is plausible and under 25 MiB', bytes > 100_000 && bytes < 25 * 1024 * 1024, `${bytes} bytes`);
  const head = await get(media, { headers: { range: 'bytes=0-1' } });
  const headBytes = (await head.arrayBuffer()).byteLength;
  check('range 0-1 answers 206 with 2 bytes', head.status === 206 && headBytes === 2, `${head.status}, ${headBytes} bytes`);
  check('range answer names the full size', head.headers.get('content-range') === `bytes 0-1/${bytes}`, head.headers.get('content-range'));
  const past = await get(media, { headers: { range: `bytes=${bytes}-` } });
  check('range past the end answers 416', past.status === 416, String(past.status));
}

console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
