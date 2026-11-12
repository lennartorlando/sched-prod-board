// Records the board in use: a main take (en-NZ, Pacific/Auckland) with a clean ack and an
// ack under a shift, then a short take (de-DE, Europe/Berlin). Writes the MP4, stills and a
// run record of every moment (offsets from the video's start) and every ack reply.
//
// usage:
//   node scripts/record.mjs --rehearse --out <dir>     local build + fake API; sends nothing to the course
//   node scripts/record.mjs --live <board url> --out <dir>   real board; sends two real acks
//
// The pointer and the click ring in the video are drawn by this script, not by the board.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { REPO, build } from './build.mjs';
import { serveDir } from './lib/static-server.mjs';
import { BASE_INCIDENTS, FAKE_API, createFakeNight } from '../test/fake-api.mjs';

const VIEW = { width: 1280, height: 1080 };
const MAIN = { name: 'main', locale: 'en-NZ', timezoneId: 'Pacific/Auckland' };
const SECOND = { name: 'berlin', locale: 'de-DE', timezoneId: 'Europe/Berlin' };
const STABLE_ID = 'INC-4925'; // the one openedAt that does not move between page loads

const argv = process.argv.slice(2);
const rehearse = argv.includes('--rehearse');
const liveUrl = argv.includes('--live') ? argv[argv.indexOf('--live') + 1] : null;
const outDir = resolve(argv[argv.indexOf('--out') + 1] ?? 'recordings');
if (!rehearse && !liveUrl) throw new Error('record: pass --rehearse or --live <url>');
rmSync(outDir, { recursive: true, force: true });
mkdirSync(join(outDir, 'stills'), { recursive: true });

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const mmss = (ms) => {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

// Recording-only overlay: a pointer that follows the mouse, a ring on each press, and an
// observer that reports every change of the top row to this script.
function overlay() {
  if (window.top !== window) return;
  const install = () => {
    const ns = 'http://www.w3.org/2000/svg';
    const pointer = document.createElementNS(ns, 'svg');
    pointer.setAttribute('viewBox', '0 0 24 24');
    pointer.setAttribute('width', '26');
    pointer.setAttribute('height', '26');
    pointer.style.cssText = 'position:fixed;left:0;top:0;pointer-events:none;z-index:2147483647;transform:translate(-100px,-100px)';
    const arrow = document.createElementNS(ns, 'path');
    arrow.setAttribute('d', 'M3 2l7 19 2.5-7.5L20 11z');
    arrow.setAttribute('fill', '#111');
    arrow.setAttribute('stroke', '#fff');
    arrow.setAttribute('stroke-width', '1.5');
    pointer.append(arrow);
    const ring = document.createElement('div');
    ring.style.cssText = 'position:fixed;width:30px;height:30px;margin:-15px 0 0 -15px;border:3px solid #e8590c;border-radius:50%;pointer-events:none;z-index:2147483646;opacity:0';
    document.documentElement.append(pointer, ring);
    addEventListener('mousemove', (e) => (pointer.style.transform = `translate(${e.clientX - 3}px,${e.clientY - 2}px)`), true);
    addEventListener('mousedown', (e) => {
      ring.style.left = `${e.clientX}px`;
      ring.style.top = `${e.clientY}px`;
      ring.style.transition = 'none';
      ring.style.opacity = '1';
      setTimeout(() => {
        ring.style.transition = 'opacity 0.8s';
        ring.style.opacity = '0';
      }, 400);
    }, true);
    const list = document.querySelector('[data-testid="incident-list"]');
    let top = null;
    new MutationObserver(() => {
      const first = list.firstElementChild?.dataset.id ?? null;
      if (first && first !== top) {
        const prev = top;
        top = first;
        window.__recEvent({ type: 'top', id: first, prev });
      }
    }).observe(list, { childList: true });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install);
  else install();
}

async function take(browser, spec, url, { fake, main }) {
  const dir = join(outDir, spec.name);
  const context = await browser.newContext({
    locale: spec.locale,
    timezoneId: spec.timezoneId,
    viewport: VIEW,
    recordVideo: { dir, size: VIEW },
  });
  const record = { ...spec, events: [], acks: [], consoleAcks: [], courseCalls: [] };
  if (fake) {
    await fake.install(context);
    await context.route('https://hq.mega.dev/**', (route) => {
      record.courseCalls.push(route.request().url().replace(/([?&]t=)[^&]+/, '$1<masked>'));
      return route.abort();
    });
  }
  let t0 = 0;
  const waiters = [];
  const at = () => Date.now() - t0;
  const mark = (type, extra = {}) => {
    const event = { t: at(), type, ...extra };
    record.events.push(event);
    console.log(`${spec.name} ${mmss(event.t)} ${type} ${JSON.stringify(extra)}`);
    return event;
  };
  await context.exposeBinding('__recEvent', (_source, ev) => {
    const event = mark(ev.prev ? 'arrival' : 'first-top', { id: ev.id, prev: ev.prev });
    waiters.splice(0).forEach((resolveWaiter) => resolveWaiter(event));
  });
  await context.addInitScript(overlay);

  const page = await context.newPage();
  t0 = Date.now();
  record.t0 = new Date(t0).toISOString();
  page.on('response', async (res) => {
    if (!/\/ack\?/.test(res.url())) return;
    const t = at();
    try {
      record.acks.push({ t, status: res.status(), reply: await res.json() });
    } catch {
      record.acks.push({ t, status: res.status(), reply: null });
    }
  });
  page.on('console', (msg) => {
    if (msg.type() === 'info' && msg.text().startsWith('ack ')) {
      const [, id, ackedAt, receipt] = msg.text().split(' ');
      record.consoleAcks.push({ t: at(), id, ackedAt, receipt });
    }
  });
  const nextArrival = (timeout = 30000) =>
    new Promise((resolveWaiter, reject) => {
      const timer = setTimeout(() => reject(new Error('no arrival in time')), timeout);
      waiters.push((event) => {
        clearTimeout(timer);
        resolveWaiter(event);
      });
    });

  await page.goto(url, { waitUntil: 'domcontentloaded' });
  mark('page', { loaderVisible: await page.getByTestId('loader').isVisible() });
  await page.getByTestId('incident-row').first().waitFor({ timeout: 15000 });
  const baseIds = await page.getByTestId('incident-row').evaluateAll((rows) => rows.map((r) => r.dataset.id));
  mark('first-rows', { count: baseIds.length, loaderVisible: await page.getByTestId('loader').isVisible() });
  record.sha = await page.locator('meta[name="build"]').getAttribute('content');
  const stable = page.locator(`[data-testid="incident-row"][data-id="${STABLE_ID}"] time`);
  if (await stable.count()) {
    record.stable = { id: STABLE_ID, t: at(), text: (await stable.textContent()).trim(), datetime: await stable.getAttribute('datetime') };
    mark('stable-row', record.stable);
  }

  if (!main) {
    await sleep(12000);
  } else {
    // Watch two arrivals.
    await nextArrival();
    await nextArrival();

    // Clean ack: a locator click, which waits for the row to hold still and targets it by id.
    await sleep(1200);
    const cleanId = await page.getByTestId('incident-row').first().getAttribute('data-id');
    const cleanButton = page.locator(`[data-testid="incident-row"][data-id="${cleanId}"] [data-testid="ack"]`);
    const cb = await cleanButton.boundingBox();
    await page.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2, { steps: 20 });
    mark('clean-click', { id: cleanId });
    await cleanButton.click();
    await page.locator(`[data-testid="incident-row"][data-id="${cleanId}"] [data-testid="acked"]`).waitFor({ timeout: 10000 });
    mark('clean-acked', { id: cleanId });

    // Ack under a shift: rest the pointer on the newest row's Ack, then click those same
    // screen coordinates just after the next incident lands on top.
    let shift = null;
    for (let attempt = 1; attempt <= 3 && !shift; attempt += 1) {
      const anchor = await nextArrival();
      await sleep(Math.max(0, 6500 - (at() - anchor.t)));
      const intended = await page.getByTestId('incident-row').first().getAttribute('data-id');
      const button = page.locator(`[data-testid="incident-row"][data-id="${intended}"] [data-testid="ack"]`);
      const box = await button.boundingBox();
      const x = Math.round(box.x + box.width / 2);
      const y = Math.round(box.y + box.height / 2);
      await page.mouse.move(x, y, { steps: 20 });
      const underAtRest = await page.evaluate(([px, py]) => document.elementFromPoint(px, py)?.closest('[data-testid="incident-row"]')?.dataset.id, [x, y]);
      const rest = mark('pointer-rests', { intended, underPointer: underAtRest, x, y });
      const arrival = await nextArrival(20000);
      await sleep(120);
      const underAtClick = await page.evaluate(([px, py]) => document.elementFromPoint(px, py)?.closest('[data-testid="incident-row"]')?.dataset.id, [x, y]);
      if (underAtClick === intended) {
        mark('shift-missed', { intended, underAtClick });
        continue;
      }
      const footer = await page.getByTestId('build-sha').boundingBox();
      const click = mark('shift-click', { intended, underPointer: underAtClick, arrival: arrival.id, msAfterArrival: at() - arrival.t, footerOnScreen: !!footer && footer.y + footer.height <= VIEW.height });
      const acksBefore = record.acks.length;
      await page.mouse.click(x, y);
      await page.locator(`[data-testid="incident-row"][data-id="${underAtClick}"] [data-testid="acked"]`).waitFor({ timeout: 10000 });
      const acked = mark('shift-acked', { id: underAtClick });
      const reply = record.acks.slice(acksBefore).find((a) => a.reply)?.reply ?? null;
      shift = { intended, ackedId: reply?.id ?? null, arrival: arrival.id, restT: rest.t, arrivalT: arrival.t, clickT: click.t, ackedT: acked.t, footerOnScreen: click.footerOnScreen };
    }
    record.shift = shift;
    record.clean = { id: cleanId, ...record.events.find((e) => e.type === 'clean-acked') };

    // Keep watching: arrivals continue, marks stay, no reload.
    await sleep(30000);
    record.after = await page.evaluate(() => ({
      rows: document.querySelectorAll('[data-testid="incident-row"]').length,
      acked: [...document.querySelectorAll('[data-testid="acked"]')].map((m) => m.closest('[data-testid="incident-row"]').dataset.id),
    }));
    mark('watch-end', record.after);
  }

  mark('end');
  await context.close();
  record.webm = await page.video().path();
  return record;
}

// Rehearsal only: does Chrome's scroll anchoring hold the rows still once the list is scrolled?
async function scrollProbe(browser, url) {
  const many = Array.from({ length: 30 }, (_, i) => ({ ...BASE_INCIDENTS[i % BASE_INCIDENTS.length], id: `INC-${5000 + i}` }));
  const fake = createFakeNight({ incidents: many, arrivalEveryMs: 3000 });
  const context = await browser.newContext({ viewport: VIEW });
  await fake.install(context);
  await context.route('https://hq.mega.dev/**', (route) => route.abort());
  const page = await context.newPage();
  await page.goto(url);
  await page.getByTestId('incident-row').first().waitFor();
  const probe = async (scrollY) => {
    await page.evaluate((y) => window.scrollTo(0, y), scrollY);
    await sleep(300);
    const row = page.locator('[data-testid="incident-row"][data-id="INC-5010"]');
    const before = (await row.boundingBox()).y;
    const count = await page.getByTestId('incident-row').count();
    await page.waitForFunction((n) => document.querySelectorAll('[data-testid="incident-row"]').length > n, count, { timeout: 10000 });
    await sleep(100);
    return { scrollY, moved: Math.round((await row.boundingBox()).y - before) };
  };
  const result = [await probe(0), await probe(300)];
  await context.close();
  return result;
}

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: 'inherit' });
}
function probe(file) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration', '-of', 'json', file], { encoding: 'utf8' });
  const json = JSON.parse(out);
  return { width: json.streams[0].width, height: json.streams[0].height, duration: Number(json.format.duration) };
}
function still(video, ms, name) {
  const file = join(outDir, 'stills', `${name}-${mmss(ms).replace(':', 'm')}s.png`);
  ffmpeg(['-ss', (ms / 1000).toFixed(3), '-i', video, '-frames:v', '1', '-update', '1', file]);
  return file;
}

const browser = await chromium.launch();
let server = null;
let url = liveUrl;
let fake = null;
if (rehearse) {
  const dist = join(REPO, 'dist-rehearsal');
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();
  build({ sha, api: FAKE_API, session: 'rehearsal-session', outDir: dist });
  server = await serveDir(dist);
  url = server.url;
}

const run = { mode: rehearse ? 'rehearsal' : 'live', url, startedAt: new Date().toISOString(), takes: {} };
try {
  fake = rehearse ? createFakeNight({ arrivalEveryMs: 9000 }) : null;
  run.takes.main = await take(browser, MAIN, url, { fake, main: true });
  const fakeSecond = rehearse ? createFakeNight({ arrivalEveryMs: 9000 }) : null;
  run.takes.berlin = await take(browser, SECOND, url, { fake: fakeSecond, main: false });
  if (rehearse) run.scrollAnchoring = await scrollProbe(browser, url);
} finally {
  await browser.close();
  await server?.close();
}

// Video: each take to H.264, then joined, main first, index at the front.
const parts = [];
for (const name of ['main', 'berlin']) {
  const mp4 = join(outDir, `${name}.mp4`);
  ffmpeg(['-i', run.takes[name].webm, '-vf', 'setpts=PTS-STARTPTS', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '22', '-preset', 'medium', '-an', mp4]);
  run.takes[name].mp4 = probe(mp4);
  parts.push(mp4);
}
const list = join(outDir, 'parts.txt');
writeFileSync(list, parts.map((p) => `file '${p}'`).join('\n') + '\n');
const final = join(outDir, 'step1.mp4');
ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', final]);
run.video = { file: final, ...probe(final), bytes: statSync(final).size };

const main = run.takes.main;
const berlinStart = Math.round(main.mp4.duration * 1000);
run.stills = {};
if (main.clean?.t) run.stills.clean = still(final, main.clean.t + 400, 'clean-acked');
if (main.shift) {
  run.stills.rest = still(final, main.shift.arrivalT - 300, 'shift-rest');
  run.stills.click = still(final, main.shift.clickT, 'shift-click');
  run.stills.acked = still(final, main.shift.ackedT + 400, 'shift-acked');
  run.evidence = {
    at: mmss(main.shift.ackedT + 999), // first whole second with the mark on screen
    intended: main.shift.intended,
    acked: main.shift.ackedId,
  };
  run.stills.at = still(final, (Math.floor((main.shift.ackedT + 999) / 1000)) * 1000, 'evidence-at');
}
if (main.stable) run.stills.stableMain = still(final, main.stable.t + 500, 'stable-auckland');
if (run.takes.berlin.stable) {
  run.takes.berlin.stable.tInVideo = berlinStart + run.takes.berlin.stable.t;
  run.stills.stableBerlin = still(final, run.takes.berlin.stable.tInVideo + 500, 'stable-berlin');
}

writeFileSync(join(outDir, 'run.json'), JSON.stringify(run, null, 2));
const masked = JSON.parse(JSON.stringify(run), (key, value) =>
  key === 'receipt' && typeof value === 'string' ? `${value.slice(0, 6)}…` : value,
);
writeFileSync(join(outDir, 'run.masked.json'), JSON.stringify(masked, null, 2));
console.log(`video ${final} ${run.video.width}x${run.video.height} ${run.video.duration.toFixed(1)}s ${run.video.bytes} bytes`);
console.log(`shift ${JSON.stringify(run.evidence ?? null)} clean ${main.clean?.id ?? 'none'}`);
if (run.scrollAnchoring) console.log(`scroll anchoring ${JSON.stringify(run.scrollAnchoring)}`);
if (main.courseCalls?.length || run.takes.berlin.courseCalls?.length) {
  console.error('record: a rehearsal request reached for the course host');
  process.exit(1);
}
