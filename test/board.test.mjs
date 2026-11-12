// Browser tests for the board (SCHED-4511..4514, plan R6) against a fake API.
// Any request to the course host fails the test: only the recording may ack for real.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { build } from '../scripts/build.mjs';
import { serveDir } from '../scripts/lib/static-server.mjs';
import { BASE_INCIDENTS, FAKE_API, createFakeNight } from './fake-api.mjs';

const SHA = '0123456789abcdef0123456789abcdef01234567';
let browser;
let server;
let distDir;

before(async () => {
  distDir = mkdtempSync(join(tmpdir(), 'board-test-'));
  build({ sha: SHA, api: FAKE_API, session: 'test-session', outDir: distDir });
  server = await serveDir(distDir);
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  await server?.close();
  rmSync(distDir, { recursive: true, force: true });
});

async function openBoard(night, { locale = 'en-NZ', timezoneId = 'Pacific/Auckland' } = {}) {
  const context = await browser.newContext({ locale, timezoneId });
  const courseCalls = [];
  await context.route('https://hq.mega.dev/**', (route) => {
    courseCalls.push(route.request().url());
    return route.abort();
  });
  await night.install(context);
  const page = await context.newPage();
  await page.goto(server.url);
  return { context, page, courseCalls };
}

const ids = (page) => page.getByTestId('incident-row').evaluateAll((rows) => rows.map((r) => r.dataset.id));

describe('loader and empty state (SCHED-4512)', () => {
  test('loader shows until the first answer, then rows in API order', async () => {
    const night = createFakeNight({ delayMs: 1000 });
    const { context, page, courseCalls } = await openBoard(night);
    assert.equal(await page.getByTestId('loader').isVisible(), true);
    await page.getByTestId('incident-row').first().waitFor();
    assert.equal(await page.getByTestId('loader').isVisible(), false);
    assert.deepEqual(await ids(page), BASE_INCIDENTS.map((i) => i.id));
    assert.equal(await page.getByTestId('empty').isVisible(), false);
    assert.deepEqual(courseCalls, []);
    await context.close();
  });

  test('an empty answer hides the loader and shows empty until rows arrive', async () => {
    const night = createFakeNight({ incidents: [] });
    const { context, page } = await openBoard(night);
    await page.getByTestId('empty').waitFor();
    assert.equal(await page.getByTestId('loader').isVisible(), false);
    assert.equal(await page.getByTestId('incident-row').count(), 0);
    night.setIncidents(BASE_INCIDENTS.slice(0, 2));
    await page.getByTestId('incident-row').first().waitFor({ timeout: 5000 });
    assert.equal(await page.getByTestId('empty').isVisible(), false);
    await context.close();
  });

  test('a failed first load keeps the loader with a retrying line, then loads', async () => {
    const night = createFakeNight({ failCalls: new Set([0]) });
    const { context, page } = await openBoard(night);
    await page.getByText('Could not load incidents. Retrying…').waitFor();
    assert.equal(await page.getByTestId('loader').isVisible(), true);
    await page.getByTestId('incident-row').first().waitFor({ timeout: 5000 });
    assert.equal(await page.getByTestId('loader').isVisible(), false);
    assert.equal(await page.locator('.status').textContent(), '');
    await context.close();
  });
});

describe('live list and refresh (SCHED-4511, SCHED-4513)', () => {
  test('a new incident appears at the top without a reload; old rows keep their nodes', async () => {
    const night = createFakeNight();
    const { context, page } = await openBoard(night);
    await page.getByTestId('incident-row').first().waitFor();
    await page.evaluate(() => {
      window.__firstRow = document.querySelector('[data-testid="incident-row"]');
      window.__reloaded = false;
      addEventListener('beforeunload', () => (window.__reloaded = true));
    });
    night.addIncident({ id: 'INC-9001', service: 'auth', region: 'eu-west', summary: 'new one', severity: 'sev1', openedAt: '2026-11-12T03:10:00.000Z' });
    await page.locator('[data-testid="incident-row"][data-id="INC-9001"]').waitFor({ timeout: 5000 });
    assert.equal((await ids(page))[0], 'INC-9001');
    assert.equal(await page.evaluate(() => window.__firstRow === document.querySelectorAll('[data-testid="incident-row"]')[1]), true);
    assert.equal(await page.evaluate(() => window.__reloaded), false);
    assert.equal(await page.getByTestId('loader').isVisible(), false);
    await context.close();
  });

  test('refreshes about every 2 s and never overlaps requests', async () => {
    const night = createFakeNight();
    const { context, page } = await openBoard(night);
    await page.getByTestId('incident-row').first().waitFor();
    const start = night.log.incidents.length;
    await page.waitForTimeout(7000);
    const made = night.log.incidents.length - start;
    assert.ok(made >= 3 && made <= 4, `expected 3 or 4 refreshes in 7 s, got ${made}`);
    await context.close();

    const slow = createFakeNight({ delayMs: 2500 });
    const second = await openBoard(slow);
    await second.page.waitForTimeout(7000);
    assert.equal(slow.log.maxInFlight, 1);
    await second.context.close();
  });

  test('a failed refresh keeps the rows, shows a status line, and moves nothing', async () => {
    const night = createFakeNight({ failCalls: new Set([2]) });
    const { context, page } = await openBoard(night);
    await page.getByTestId('incident-row').first().waitFor();
    const top = async () => (await page.getByTestId('incident-row').first().boundingBox()).y;
    const before = await top();
    await page.getByText(/Last update failed at/).waitFor({ timeout: 6000 });
    assert.equal(await top(), before);
    assert.equal(await page.getByTestId('incident-row').count(), BASE_INCIDENTS.length);
    await page.waitForFunction(() => document.querySelector('.status').textContent === '', null, { timeout: 5000 });
    assert.equal(await top(), before);
    await context.close();
  });
});

describe('ack (SCHED-4511)', () => {
  test('acks the clicked row with the latest cursor and keeps the mark through refreshes', async () => {
    const night = createFakeNight();
    const { context, page } = await openBoard(night);
    await page.getByTestId('incident-row').first().waitFor();
    await page.waitForTimeout(2500);
    const row = page.locator('[data-testid="incident-row"][data-id="INC-4640"]');
    await row.getByTestId('ack').click();
    await row.getByTestId('acked').waitFor();
    assert.equal(night.log.acks.length, 1);
    assert.equal(night.log.acks[0].id, 'INC-4640');
    const latestCursor = `cursor-${night.log.incidents.length - 1}`;
    assert.equal(night.log.acks[0].cursor, latestCursor);
    assert.equal(await row.getByTestId('ack').count(), 0);
    assert.equal(await page.getByTestId('acked').count(), 1);
    night.addIncident({ id: 'INC-9002', service: 'auth', region: 'eu-west', summary: 'pushes rows down', severity: 'sev1', openedAt: '2026-11-12T03:20:00.000Z' });
    await page.locator('[data-testid="incident-row"][data-id="INC-9002"]').waitFor({ timeout: 5000 });
    assert.equal(await row.getByTestId('acked').count(), 1);
    assert.equal(await page.getByTestId('acked').count(), 1);
    await context.close();
  });

  test('a failed ack leaves the button enabled with an error and no mark', async () => {
    const night = createFakeNight({ failAck: true });
    const { context, page } = await openBoard(night);
    const row = page.locator('[data-testid="incident-row"][data-id="INC-1778"]');
    await row.getByTestId('ack').click();
    await row.getByRole('alert').waitFor();
    assert.equal(await row.getByTestId('ack').isEnabled(), true);
    assert.equal(await page.getByTestId('acked').count(), 0);
    await context.close();
  });
});

describe('local times (SCHED-4514)', () => {
  // INC-2662 in the fake night opens at 2026-11-12T03:03:00.000Z, the issue's example.
  const cases = [
    { locale: 'de-DE', timezoneId: 'Europe/Berlin', expect: [/12\.11\./, /04:03/] },
    { locale: 'en-NZ', timezoneId: 'Pacific/Auckland', expect: [/12\/11/, /0?4:03\s?pm/i] },
    { locale: 'en-US', timezoneId: 'America/New_York', expect: [/11\/11/, /10:03\s?PM/i] },
    { locale: 'hu-HU', timezoneId: 'Europe/Budapest', expect: [/^12\D+11\D/, /04:03/] },
    { locale: 'lt-LT', timezoneId: 'Europe/Vilnius', expect: [/^12\D+11\D/, /05:03/] },
  ];
  for (const c of cases) {
    test(`${c.locale} in ${c.timezoneId}`, async () => {
      const night = createFakeNight();
      const { context, page } = await openBoard(night, c);
      const time = page.locator('[data-testid="incident-row"][data-id="INC-2662"] time');
      await time.waitFor();
      const text = (await time.textContent()).trim();
      for (const pattern of c.expect) assert.match(text, pattern, `${c.locale}: "${text}"`);
      assert.equal(await time.getAttribute('datetime'), '2026-11-12T03:03:00.000Z');
      await context.close();
    });
  }
});

describe('build and safety (plan R6)', () => {
  test('meta build equals the single build-sha element and the stamped sha', async () => {
    const night = createFakeNight();
    const { context, page } = await openBoard(night);
    assert.equal(await page.locator('meta[name="build"]').getAttribute('content'), SHA);
    assert.equal(await page.getByTestId('build-sha').count(), 1);
    assert.equal((await page.getByTestId('build-sha').textContent()).trim(), SHA);
    await context.close();
  });

  test('summaries render as text, never as markup', async () => {
    const night = createFakeNight({
      incidents: [{ id: 'INC-6666', service: 'auth', region: 'eu-west', summary: '<img src=x onerror="window.__xss=1">', severity: 'sev1', openedAt: '2026-11-12T03:03:00.000Z' }],
    });
    const { context, page } = await openBoard(night);
    const row = page.locator('[data-testid="incident-row"][data-id="INC-6666"]');
    await row.waitFor();
    assert.equal(await row.locator('img').count(), 0);
    assert.match(await row.locator('.what').textContent(), /<img src=x/);
    assert.equal(await page.evaluate(() => window.__xss), undefined);
    await context.close();
  });
});
