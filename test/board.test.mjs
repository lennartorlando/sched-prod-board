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
  test('an answer without an incident list counts as a failed refresh', async () => {
    const night = createFakeNight({ malformedCalls: new Set([2]) });
    const { context, page } = await openBoard(night);
    await page.getByTestId('incident-row').first().waitFor();
    await page.getByText(/Last update failed at/).waitFor({ timeout: 6000 });
    assert.equal(await page.getByTestId('incident-row').count(), BASE_INCIDENTS.length);
    assert.equal(await page.getByTestId('empty').isVisible(), false);
    await context.close();
  });

  test('rows the API drops leave the list; an empty answer shows empty', async () => {
    const night = createFakeNight();
    const { context, page } = await openBoard(night);
    await page.getByTestId('incident-row').first().waitFor();
    night.setIncidents(BASE_INCIDENTS.slice(1));
    await page.locator('[data-testid="incident-row"][data-id="INC-2662"]').waitFor({ state: 'detached', timeout: 5000 });
    assert.equal(await page.getByTestId('incident-row').count(), BASE_INCIDENTS.length - 1);
    night.setIncidents([]);
    await page.getByTestId('empty').waitFor({ timeout: 5000 });
    assert.equal(await page.getByTestId('incident-row').count(), 0);
    await context.close();
  });

  test('a tab coming back fetches at once, never beside a pending request', async () => {
    const slow = createFakeNight({ delayMs: 1500 });
    const { context, page } = await openBoard(slow);
    await page.getByTestId('incident-row').first().waitFor();
    const comeBack = () =>
      page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
        document.dispatchEvent(new Event('visibilitychange'));
      });
    await page.waitForFunction(() => true);
    const before = slow.log.incidents.length;
    await page.waitForTimeout(600); // the next request is now pending in its 1.5 s delay
    await comeBack();
    await page.waitForTimeout(3000);
    assert.equal(slow.log.maxInFlight, 1);
    assert.ok(slow.log.incidents.length - before <= 2, 'a visibility event must not start a second chain');
    await context.close();

    const fast = createFakeNight();
    const second = await openBoard(fast);
    await second.page.getByTestId('incident-row').first().waitFor();
    await second.page.waitForTimeout(300);
    const count = fast.log.incidents.length;
    await second.page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await second.page.waitForTimeout(400);
    assert.equal(fast.log.incidents.length, count + 1, 'expected one fetch right after the tab came back');
    await second.context.close();
  });

  test('a request pending for 10 s is reported while the loader stays', async () => {
    const night = createFakeNight({ delayMs: 11500 });
    const { context, page } = await openBoard(night);
    await page.getByText('Still waiting for incidents…').waitFor({ timeout: 11000 });
    assert.equal(await page.getByTestId('loader').isVisible(), true);
    await page.getByTestId('incident-row').first().waitFor({ timeout: 5000 });
    assert.equal(await page.locator('.status').textContent(), '');
    assert.equal(night.log.maxInFlight, 1);
    await context.close();
  });
});

describe('ack with a confirm (SCHED-4511, product step two)', () => {
  const rowOf = (page, id) => page.locator(`[data-testid="incident-row"][data-id="${id}"]`);
  const confirmAck = async (page, id) => {
    await rowOf(page, id).getByTestId('ack').click();
    await page.getByTestId('confirm').waitFor();
    await page.getByTestId('confirm-ack').click();
  };

  test('Ack opens a confirm that names the incident and sends nothing', async () => {
    const night = createFakeNight();
    const { context, page } = await openBoard(night);
    await rowOf(page, 'INC-4640').getByTestId('ack').click();
    const bar = page.getByTestId('confirm');
    await bar.waitFor();
    assert.match(await bar.textContent(), /INC-4640/);
    assert.match(await page.getByTestId('confirm-ack').textContent(), /INC-4640/);
    assert.equal(await rowOf(page, 'INC-4640').evaluate((li) => li.classList.contains('is-confirming')), true);
    await page.waitForTimeout(500);
    assert.equal(night.log.acks.length, 0);
    assert.equal(await page.getByTestId('acked').count(), 0);
    await context.close();
  });

  test('confirm-ack acks the named incident with the latest cursor and keeps the mark', async () => {
    const night = createFakeNight();
    const { context, page } = await openBoard(night);
    await page.getByTestId('incident-row').first().waitFor();
    await page.waitForTimeout(2500);
    await confirmAck(page, 'INC-4640');
    await rowOf(page, 'INC-4640').getByTestId('acked').waitFor();
    assert.equal(night.log.acks.length, 1);
    assert.equal(night.log.acks[0].id, 'INC-4640');
    assert.equal(night.log.acks[0].cursor, night.log.acks[0].lastServed);
    assert.notEqual(night.log.acks[0].cursor, 'cursor-0');
    assert.equal(await page.getByTestId('confirm').isVisible(), false);
    assert.equal(await rowOf(page, 'INC-4640').getByTestId('ack').count(), 0);
    night.addIncident({ id: 'INC-9002', service: 'auth', region: 'eu-west', summary: 'pushes rows down', severity: 'sev1', openedAt: '2026-11-12T03:20:00.000Z' });
    await rowOf(page, 'INC-9002').waitFor({ timeout: 5000 });
    assert.equal(await page.getByTestId('acked').count(), 1);
    assert.equal(await rowOf(page, 'INC-4640').getByTestId('acked').count(), 1);
    await context.close();
  });

  test('a new incident moving the rows between the two clicks still acks the named incident', async () => {
    const night = createFakeNight();
    const { context, page } = await openBoard(night);
    const button = rowOf(page, 'INC-2662').getByTestId('ack');
    const box = await button.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.getByTestId('confirm').waitFor();
    night.addIncident({ id: 'INC-9003', service: 'auth', region: 'eu-west', summary: 'lands on top', severity: 'sev1', openedAt: '2026-11-12T03:21:00.000Z' });
    await rowOf(page, 'INC-9003').waitFor({ timeout: 5000 });
    const under = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest('[data-testid="incident-row"]')?.dataset.id, [box.x + box.width / 2, box.y + box.height / 2]);
    assert.equal(under, 'INC-9003', 'the new row is now where the first click was');
    assert.match(await page.getByTestId('confirm').textContent(), /INC-2662/);
    await page.getByTestId('confirm-ack').click();
    await rowOf(page, 'INC-2662').getByTestId('acked').waitFor();
    assert.deepEqual(night.log.acks.map((a) => a.id), ['INC-2662']);
    assert.equal(await rowOf(page, 'INC-9003').getByTestId('acked').count(), 0);
    await context.close();
  });

  test('Cancel and Escape close the confirm and send nothing', async () => {
    const night = createFakeNight();
    const { context, page } = await openBoard(night);
    await rowOf(page, 'INC-1778').getByTestId('ack').click();
    await page.getByTestId('confirm-cancel').click();
    assert.equal(await page.getByTestId('confirm').isVisible(), false);
    await rowOf(page, 'INC-1778').getByTestId('ack').click();
    await page.getByTestId('confirm').waitFor();
    await page.keyboard.press('Escape');
    assert.equal(await page.getByTestId('confirm').isVisible(), false);
    assert.equal(await rowOf(page, 'INC-1778').evaluate((li) => li.classList.contains('is-confirming')), false);
    await page.waitForTimeout(300);
    assert.equal(night.log.acks.length, 0);
    await context.close();
  });

  test('a second Ack while the confirm is open names the new incident only', async () => {
    const night = createFakeNight();
    const { context, page } = await openBoard(night);
    await rowOf(page, 'INC-4640').getByTestId('ack').click();
    await rowOf(page, 'INC-1778').getByTestId('ack').click();
    const text = await page.getByTestId('confirm').textContent();
    assert.match(text, /INC-1778/);
    assert.doesNotMatch(text, /INC-4640/);
    await page.getByTestId('confirm-ack').click();
    await rowOf(page, 'INC-1778').getByTestId('acked').waitFor();
    assert.deepEqual(night.log.acks.map((a) => a.id), ['INC-1778']);
    assert.equal(await page.getByTestId('confirm').count(), 1);
    await context.close();
  });

  test('a failed ack keeps the confirm open with one error; a retry acks', async () => {
    const night = createFakeNight({ failAck: true });
    const { context, page } = await openBoard(night);
    await confirmAck(page, 'INC-1778');
    const bar = page.getByTestId('confirm');
    await bar.getByRole('alert').filter({ hasText: 'Ack failed' }).waitFor();
    assert.equal(await page.getByTestId('confirm-ack').isEnabled(), true);
    assert.equal(await page.getByTestId('acked').count(), 0);
    await page.getByTestId('confirm-ack').click();
    await page.waitForFunction(() => !document.querySelector('[data-testid="confirm-ack"]').disabled);
    assert.equal(await bar.getByRole('alert').count(), 1, 'a second failure replaces the note, never stacks it');
    night.failAck = false;
    await page.getByTestId('confirm-ack').click();
    await rowOf(page, 'INC-1778').getByTestId('acked').waitFor();
    assert.equal(await bar.isVisible(), false);
    assert.equal(night.log.acks.length, 3);
    await context.close();
  });

  test('an acked incident keeps its mark when its row leaves and comes back', async () => {
    const night = createFakeNight();
    const { context, page } = await openBoard(night);
    const row = rowOf(page, 'INC-4640');
    await confirmAck(page, 'INC-4640');
    await row.getByTestId('acked').waitFor();
    night.setIncidents(BASE_INCIDENTS.filter((i) => i.id !== 'INC-4640'));
    await row.waitFor({ state: 'detached', timeout: 5000 });
    night.setIncidents(BASE_INCIDENTS);
    await row.waitFor({ timeout: 5000 });
    assert.equal(await row.getByTestId('acked').count(), 1);
    assert.equal(await row.getByTestId('ack').count(), 0);
    assert.equal(night.log.acks.length, 1);
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
