// Records the board in use: a main take (en-NZ, Pacific/Auckland) with a clean ack and an
// ack under a shift, then a short take (de-DE, Europe/Berlin). Writes the MP4, stills and a
// run record of every moment (offsets from the video's start) and every ack reply.
//
// usage:
//   node scripts/record.mjs --rehearse [--step 2] [--fail-shift-ack] [--out <dir>] [--private <dir>]
//       local build + fake API; sends nothing to the course
//   node scripts/record.mjs --live <board url> [--step 2] [--out <dir>] [--private <dir>]
//       the real board; sends two real acks
//
// --out gets the shareable files (step1.mp4, stills, run.masked.json); --private gets the full
// run record and every ack reply the moment it arrives (acks.jsonl). Neither folder may exist
// with files in it; nothing is ever deleted. The pointer and the click ring in the video are
// drawn by this script, not by the board.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { REPO, build } from './build.mjs';
import { serveDir } from './lib/static-server.mjs';
import { BASE_INCIDENTS, FAKE_API, createFakeNight } from '../test/fake-api.mjs';

const VIEW = { width: 1280, height: 1080 };
const MAIN = { name: 'main', locale: 'en-NZ', timezoneId: 'Pacific/Auckland' };
const SECOND = { name: 'berlin', locale: 'de-DE', timezoneId: 'Europe/Berlin' };
const STABLE_ID = 'INC-4925'; // the one openedAt that does not move between page loads
const REST_AFTER_ARRIVAL_MS = 6500; // arrivals come every 8 to 11 s; rest the pointer before the next

const { values } = parseArgs({
  options: {
    rehearse: { type: 'boolean', default: false },
    live: { type: 'string' },
    out: { type: 'string' },
    private: { type: 'string' },
    'fail-shift-ack': { type: 'boolean', default: false },
    step: { type: 'string', default: '1' }, // 2: the build with the confirm bar (product's step-two decision)
  },
});
if (values.rehearse === Boolean(values.live)) throw new Error('record: pass exactly one of --rehearse or --live <url>');
if (values['fail-shift-ack'] && !values.rehearse) throw new Error('record: --fail-shift-ack is for rehearsals only');
const mode = values.rehearse ? 'rehearsal' : 'live';
const step2 = values.step === '2';
if (!['1', '2'].includes(values.step)) throw new Error('record: --step is 1 or 2');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = resolve(values.out ?? join(REPO, 'recordings', `${mode}-${stamp}`));
const privateDir = resolve(values.private ?? (values.rehearse ? join(outDir, 'private') : join(REPO, '..', 'private', 'recordings', `${mode}-${stamp}`)));
for (const dir of [outDir, privateDir]) {
  if (existsSync(dir) && readdirSync(dir).length > 0) throw new Error(`record: ${dir} already holds files; pick a new folder`);
}
for (const dir of [join(outDir, 'stills'), join(outDir, 'parts'), privateDir]) mkdirSync(dir, { recursive: true });

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const mmss = (ms) => {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
const maskReceipt = (value) => (typeof value === 'string' ? `${value.slice(0, 6)}…` : value);

// The run record: full in privateDir, masked in outDir, saved after every ack and on any exit.
const run = { mode, startedAt: new Date().toISOString(), takes: {} };
const receipts = new Set();
function save() {
  writeFileSync(join(privateDir, 'run.json'), JSON.stringify(run, null, 2));
  const masked = JSON.stringify(run, (key, value) => (key === 'receipt' ? maskReceipt(value) : value), 2);
  for (const receipt of receipts) {
    if (masked.includes(receipt)) throw new Error('record: a full receipt reached the masked record');
  }
  writeFileSync(join(outDir, 'run.masked.json'), masked);
}

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
  const record = { ...spec, events: [], acks: [], consoleAcks: [], courseCalls: [] };
  run.takes[spec.name] = record;
  const context = await browser.newContext({
    locale: spec.locale,
    timezoneId: spec.timezoneId,
    viewport: VIEW,
    recordVideo: { dir: join(outDir, 'parts', spec.name), size: VIEW },
  });
  let page;
  try {
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

    page = await context.newPage();
    t0 = Date.now();
    record.t0 = new Date(t0).toISOString();
    // Every ack reply is written to disk the moment it is read, whatever happens later.
    page.on('response', async (res) => {
      if (!/\/ack\?/.test(res.url())) return;
      const t = at();
      const body = await res.text().catch(() => '');
      let reply = null;
      try {
        reply = JSON.parse(body);
      } catch {}
      if (typeof reply?.receipt === 'string') receipts.add(reply.receipt);
      const entry = { take: spec.name, t, status: res.status(), reply, body: reply ? undefined : body.slice(0, 500) };
      record.acks.push(entry);
      appendFileSync(join(privateDir, 'acks.jsonl'), `${JSON.stringify(entry)}\n`);
      console.log(`${spec.name} ${mmss(t)} ack-reply ${res.status()} ${reply?.id ?? '-'} ${maskReceipt(reply?.receipt) ?? '-'}`);
      save();
    });
    page.on('console', (msg) => {
      if (msg.type() === 'info' && msg.text().startsWith('ack ')) {
        const [, id, ackedAt, receipt] = msg.text().split(' ');
        if (receipt) receipts.add(receipt);
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
    const ackReply = () => page.waitForResponse((res) => /\/ack\?/.test(res.url()), { timeout: 15000 });
    const rowAt = (x, y) =>
      page.evaluate(([px, py]) => document.elementFromPoint(px, py)?.closest('[data-testid="incident-row"]')?.dataset.id ?? null, [x, y]);

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
    } else if (step2) {
      // Step two: every Ack goes through the confirm bar, which names the incident.
      const center = async (locator) => {
        const b = await locator.boundingBox();
        return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
      };
      const moveTo = async (locator) => {
        const p = await center(locator);
        await page.mouse.move(p.x, p.y, { steps: 20 });
        return p;
      };
      const confirmBar = page.getByTestId('confirm');
      const barText = async () => (await confirmBar.textContent()).replace(/\s+/g, ' ').trim();
      const confirmAndAck = async (id, label) => {
        await confirmBar.waitFor({ timeout: 5000 });
        const named = mark(`${label}-confirm`, { id, bar: await barText() });
        if (!named.bar.includes(id)) throw new Error(`record: the confirm names "${named.bar}", not ${id}`);
        await sleep(1500); // the viewer reads the bar
        await moveTo(page.getByTestId('confirm-ack'));
        const reply = ackReply();
        mark(`${label}-confirm-ack`, { id });
        await page.getByTestId('confirm-ack').click();
        const res = await reply;
        const body = await res.json().catch(() => null);
        if (!res.ok()) throw new Error(`record: the ${label} ack answered ${res.status()}`);
        await page.locator(`[data-testid="incident-row"][data-id="${id}"] [data-testid="acked"]`).waitFor({ timeout: 10000 });
        return { ...mark(`${label}-acked`, { id, ackedId: body?.id ?? null }), ackedId: body?.id ?? null, status: res.status() };
      };

      await nextArrival();
      await nextArrival();
      await sleep(1200);
      const cleanId = await page.getByTestId('incident-row').first().getAttribute('data-id');
      const cleanAck = page.locator(`[data-testid="incident-row"][data-id="${cleanId}"] [data-testid="ack"]`);
      await moveTo(cleanAck);
      mark('clean-click', { id: cleanId });
      await cleanAck.click();
      record.clean = { id: cleanId, ...(await confirmAndAck(cleanId, 'clean')) };
      save();

      for (let attempt = 1; attempt <= 3 && !record.shift; attempt += 1) {
        const anchor = await nextArrival();
        await sleep(Math.max(0, REST_AFTER_ARRIVAL_MS - (at() - anchor.t)));
        const intended = await page.getByTestId('incident-row').first().getAttribute('data-id');
        const { x, y } = await center(page.locator(`[data-testid="incident-row"][data-id="${intended}"] [data-testid="ack"]`));
        const waitArrival = nextArrival(20000);
        await page.mouse.move(x, y, { steps: 20 });
        const restedOn = await rowAt(x, y);
        const rest = mark('pointer-rests', { intended, restedOn, x, y });
        if (restedOn !== intended) {
          mark('rest-moved', { intended, restedOn });
          await waitArrival.catch(() => {});
          continue;
        }
        const arrival = await waitArrival;
        await sleep(120);
        const clicked = await rowAt(x, y);
        if (clicked === intended) {
          mark('shift-missed', { intended, clicked });
          continue;
        }
        const acksBefore = record.acks.length;
        const click = mark('shift-click', { intended, clicked, arrival: arrival.id, msAfterArrival: at() - arrival.t });
        await page.mouse.click(x, y);
        await confirmBar.waitFor({ timeout: 5000 });
        const named = mark('shift-confirm', { bar: await barText() });
        if (!named.bar.includes(clicked)) throw new Error(`record: the confirm names "${named.bar}", not ${clicked}`);
        await sleep(2000); // the viewer reads the wrong id
        await moveTo(page.getByTestId('confirm-cancel'));
        const cancel = mark('shift-cancel', { clicked });
        await page.getByTestId('confirm-cancel').click();
        await confirmBar.waitFor({ state: 'hidden', timeout: 5000 });
        await sleep(800);
        if (record.acks.length !== acksBefore) throw new Error('record: an ack went out before the confirm');
        const intendedAck = page.locator(`[data-testid="incident-row"][data-id="${intended}"] [data-testid="ack"]`);
        await moveTo(intendedAck);
        mark('intended-click', { id: intended });
        await intendedAck.click();
        const acked = await confirmAndAck(intended, 'intended');
        record.shift = { intended, restedOn, clicked, arrival: arrival.id, barNamed: clicked, restT: rest.t, arrivalT: arrival.t, clickT: click.t, confirmT: named.t, cancelT: cancel.t, ackedT: acked.t, ackedId: acked.ackedId };
        save();
      }

      await sleep(20000);
      record.after = await page.evaluate(() => ({
        rows: document.querySelectorAll('[data-testid="incident-row"]').length,
        acked: [...document.querySelectorAll('[data-testid="acked"]')].map((m) => m.closest('[data-testid="incident-row"]').dataset.id),
      }));
      mark('watch-end', record.after);
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
      const cleanReply = ackReply();
      mark('clean-click', { id: cleanId });
      await cleanButton.click();
      const cleanRes = await cleanReply;
      const cleanAck = await cleanRes.json().catch(() => null);
      await page.locator(`[data-testid="incident-row"][data-id="${cleanId}"] [data-testid="acked"]`).waitFor({ timeout: 10000 });
      record.clean = { id: cleanId, ackedId: cleanAck?.id ?? null, status: cleanRes.status(), ...mark('clean-acked', { id: cleanId, ackedId: cleanAck?.id ?? null }) };

      // Ack under a shift: rest the pointer on the newest row's Ack, then click those same
      // screen coordinates just after the next incident lands on top.
      for (let attempt = 1; attempt <= 3 && !record.shift; attempt += 1) {
        const anchor = await nextArrival();
        await sleep(Math.max(0, REST_AFTER_ARRIVAL_MS - (at() - anchor.t)));
        const intended = await page.getByTestId('incident-row').first().getAttribute('data-id');
        const box = await page.locator(`[data-testid="incident-row"][data-id="${intended}"] [data-testid="ack"]`).boundingBox();
        const x = Math.round(box.x + box.width / 2);
        const y = Math.round(box.y + box.height / 2);
        const waitArrival = nextArrival(20000); // registered before the move, so no arrival is missed
        await page.mouse.move(x, y, { steps: 20 });
        const restedOn = await rowAt(x, y);
        const rest = mark('pointer-rests', { intended, restedOn, x, y });
        if (restedOn !== intended) {
          mark('rest-moved', { intended, restedOn });
          await waitArrival.catch(() => {});
          continue;
        }
        const arrival = await waitArrival;
        await sleep(120);
        const underAtClick = await rowAt(x, y);
        if (underAtClick === intended) {
          mark('shift-missed', { intended, underAtClick });
          continue;
        }
        const footer = await page.getByTestId('build-sha').boundingBox();
        if (values['fail-shift-ack']) fake.failAck = true;
        const reply = ackReply();
        const click = mark('shift-click', { intended, underPointer: underAtClick, arrival: arrival.id, msAfterArrival: at() - arrival.t, footerOnScreen: !!footer && footer.y + footer.height <= VIEW.height });
        await page.mouse.click(x, y);
        const res = await reply;
        const shiftAck = await res.json().catch(() => null);
        if (!res.ok()) throw new Error(`record: the shift ack answered ${res.status()}`);
        await page.locator(`[data-testid="incident-row"][data-id="${underAtClick}"] [data-testid="acked"]`).waitFor({ timeout: 10000 });
        const acked = mark('shift-acked', { id: underAtClick, ackedId: shiftAck?.id ?? null });
        record.shift = { intended, restedOn, underPointer: underAtClick, ackedId: shiftAck?.id ?? null, arrival: arrival.id, restT: rest.t, arrivalT: arrival.t, clickT: click.t, ackedT: acked.t, footerOnScreen: click.footerOnScreen };
        save();
      }

      // Keep watching: arrivals continue, marks stay, no reload.
      await sleep(30000);
      record.after = await page.evaluate(() => ({
        rows: document.querySelectorAll('[data-testid="incident-row"]').length,
        acked: [...document.querySelectorAll('[data-testid="acked"]')].map((m) => m.closest('[data-testid="incident-row"]').dataset.id),
      }));
      mark('watch-end', record.after);
    }
    mark('end');
  } finally {
    await context.close(); // finalizes the video even when a step threw
    record.webm = page ? await page.video()?.path() : null;
    save();
  }
  return record;
}

// Rehearsal only: does Chrome's scroll anchoring hold the rows still once the list is scrolled?
async function scrollProbe(browser, url) {
  const many = Array.from({ length: 30 }, (_, i) => ({ ...BASE_INCIDENTS[i % BASE_INCIDENTS.length], id: `INC-${5000 + i}` }));
  const fake = createFakeNight({ incidents: many, arrivalEveryMs: 3000 });
  const context = await browser.newContext({ viewport: VIEW });
  try {
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
    return [await probe(0), await probe(300)];
  } finally {
    await context.close();
  }
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
let url = values.live;
try {
  let fake = null;
  let fakeSecond = null;
  if (values.rehearse) {
    const dist = join(REPO, 'dist-rehearsal');
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();
    build({ sha, api: FAKE_API, session: 'rehearsal-session', outDir: dist });
    server = await serveDir(dist);
    url = server.url;
    fake = createFakeNight({ arrivalEveryMs: 9000 });
    fakeSecond = createFakeNight({ arrivalEveryMs: 9000 });
  }
  run.url = url;
  await take(browser, MAIN, url, { fake, main: true });
  if (!step2) await take(browser, SECOND, url, { fake: fakeSecond, main: false });
  if (values.rehearse) run.scrollAnchoring = await scrollProbe(browser, url);
} finally {
  await browser.close();
  await server?.close();
  save();
}

// Video: each take to H.264, then joined, main first, index at the front.
const takeNames = Object.keys(run.takes); // main, then berlin in step one
const parts = [];
for (const name of takeNames) {
  const mp4 = join(outDir, 'parts', `${name}.mp4`);
  ffmpeg(['-i', run.takes[name].webm, '-vf', 'setpts=PTS-STARTPTS', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '22', '-preset', 'medium', '-an', mp4]);
  run.takes[name].mp4 = probe(mp4);
  parts.push(mp4);
}
const list = join(outDir, 'parts', 'parts.txt');
writeFileSync(list, parts.map((p) => `file '${p}'`).join('\n') + '\n');
const final = join(outDir, step2 ? 'step2.mp4' : 'step1.mp4');
ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', final]);
run.video = { file: final, ...probe(final), bytes: statSync(final).size };

const main = run.takes.main;
const firstSecondAfter = (ms) => Math.floor((ms + 999) / 1000) * 1000;
run.stills = {};
if (main.clean?.t) run.stills.clean = still(final, main.clean.t + 400, 'clean-acked');
if (main.shift && step2) {
  run.stills.rest = still(final, main.shift.arrivalT - 300, 'shift-rest');
  run.stills.confirm = still(final, main.shift.confirmT + 600, 'shift-confirm-names-clicked');
  run.stills.acked = still(final, main.shift.ackedT + 400, 'intended-acked');
  const atMs = firstSecondAfter(main.shift.confirmT); // the bar names the row the click landed on
  run.evidence = { at: mmss(atMs), intended: main.shift.intended, clicked: main.shift.clicked, barNamed: main.shift.barNamed, acked: main.shift.ackedId, ackedAt: mmss(firstSecondAfter(main.shift.ackedT)) };
  run.stills.at = still(final, atMs, 'evidence-at');
} else if (main.shift) {
  run.stills.rest = still(final, main.shift.arrivalT - 300, 'shift-rest');
  run.stills.click = still(final, main.shift.clickT + 150, 'shift-click');
  run.stills.acked = still(final, main.shift.ackedT + 400, 'shift-acked');
  const atMs = firstSecondAfter(main.shift.ackedT); // first whole second with the mark on screen
  run.evidence = { at: mmss(atMs), intended: main.shift.intended, acked: main.shift.ackedId };
  run.stills.at = still(final, atMs, 'evidence-at');
}
if (main.stable) run.stills.stableMain = still(final, main.stable.t + 500, 'stable-auckland');
const berlin = run.takes.berlin;
if (berlin?.stable) {
  berlin.stable.tInVideo = Math.round(main.mp4.duration * 1000) + berlin.stable.t;
  run.stills.stableBerlin = still(final, berlin.stable.tInVideo + 500, 'stable-berlin');
}
save();

console.log(`video ${final} ${run.video.width}x${run.video.height} ${run.video.duration.toFixed(1)}s ${run.video.bytes} bytes`);
console.log(`shift ${JSON.stringify(run.evidence ?? null)} clean ${main.clean?.id ?? 'none'}`);
if (run.scrollAnchoring) console.log(`scroll anchoring ${JSON.stringify(run.scrollAnchoring)}`);
if (main.courseCalls.length || berlin?.courseCalls.length) {
  console.error('record: a rehearsal request reached for the course host');
  process.exit(1);
}
