// A scripted night for the incident API, served by Playwright request interception.
// Used by the board tests and by the recording rehearsal; it never reaches the course.

export const FAKE_API = 'https://fake-api.test/challenges/show-me-when/api';

export const BASE_INCIDENTS = [
  { id: 'INC-2662', service: 'payments', region: 'us-east', summary: 'cancel button times out', severity: 'sev2', openedAt: '2026-11-12T03:03:00.000Z' },
  { id: 'INC-4640', service: 'exports', region: 'eu-west', summary: 'webhook retries piling up', severity: 'sev3', openedAt: '2026-11-12T02:55:30.136Z' },
  { id: 'INC-1778', service: 'notifications', region: 'us-east', summary: 'calendar push rejected', severity: 'sev3', openedAt: '2026-11-12T02:49:01.775Z' },
  { id: 'INC-9387', service: 'exports', region: 'ap-southeast', summary: 'cancel button times out', severity: 'sev3', openedAt: '2026-11-12T02:42:07.182Z' },
  { id: 'INC-2522', service: 'auth', region: 'eu-central', summary: 'payment confirmations slow', severity: 'sev3', openedAt: '2026-11-12T02:34:45.599Z' },
  { id: 'INC-2166', service: 'exports', region: 'us-west', summary: 'double booking on rebook', severity: 'sev3', openedAt: '2026-11-12T02:27:52.034Z' },
  { id: 'INC-8617', service: 'reminders', region: 'eu-west', summary: 'slot times off by one hour', severity: 'sev2', openedAt: '2026-11-12T02:20:28.746Z' },
  { id: 'INC-4925', service: 'sessions', region: 'ap-southeast', summary: 'session · ilse · studio · auckland · 04:03 on the sheet', severity: 'sev3', openedAt: '2026-11-11T03:11:00.000Z' },
];

const SUMMARIES = ['cancel button times out', 'webhook retries piling up', 'calendar push rejected', 'slot times off by one hour'];
const SERVICES = ['payments', 'exports', 'auth', 'reminders'];

/**
 * options:
 *   incidents     starting list, newest first (default BASE_INCIDENTS)
 *   arrivalEveryMs  add a new incident at the top this often, counted from the first incidents call
 *   delayMs       delay every incidents answer
 *   failCalls     set of incidents call numbers (0-based) that answer 500
 *   failAck       ack answers 500
 */
export function createFakeNight(options = {}) {
  let incidents = [...(options.incidents ?? BASE_INCIDENTS)];
  const log = { incidents: [], acks: [], maxInFlight: 0 };
  let inFlight = 0;
  let calls = 0;
  let firstCallAt = null;
  let arrivals = 0;

  function addIncident(incident) {
    incidents = [incident, ...incidents];
  }

  function arrive(now) {
    if (!options.arrivalEveryMs || firstCallAt === null) return;
    const due = Math.floor((now - firstCallAt) / options.arrivalEveryMs);
    while (arrivals < due) {
      arrivals += 1;
      addIncident({
        id: `INC-${7000 + arrivals}`,
        service: SERVICES[arrivals % SERVICES.length],
        region: 'eu-west',
        summary: SUMMARIES[arrivals % SUMMARIES.length],
        severity: arrivals % 2 ? 'sev1' : 'sev2',
        openedAt: new Date(firstCallAt + arrivals * options.arrivalEveryMs).toISOString(),
      });
    }
  }

  async function handle(route) {
    const url = new URL(route.request().url());
    const headers = { 'access-control-allow-origin': '*' };
    if (url.pathname.endsWith('/incidents')) {
      const n = calls++;
      inFlight += 1;
      log.maxInFlight = Math.max(log.maxInFlight, inFlight);
      const now = Date.now();
      if (firstCallAt === null) firstCallAt = now;
      log.incidents.push({ at: now, since: url.searchParams.get('since'), t: url.searchParams.get('t') });
      if (options.delayMs) await new Promise((done) => setTimeout(done, options.delayMs));
      arrive(Date.now());
      inFlight -= 1;
      if (options.failCalls?.has(n)) {
        await route.fulfill({ status: 500, headers, contentType: 'text/plain', body: 'fake failure' });
        return;
      }
      await route.fulfill({
        status: 200,
        headers,
        contentType: 'application/json',
        body: JSON.stringify({ updatedAt: new Date().toISOString(), incidents, cursor: `cursor-${n}` }),
      });
      return;
    }
    if (url.pathname.endsWith('/ack')) {
      const id = url.searchParams.get('id');
      log.acks.push({ at: Date.now(), id, cursor: url.searchParams.get('cursor') });
      if (options.failAck) {
        await route.fulfill({ status: 500, headers, contentType: 'text/plain', body: 'fake ack failure' });
        return;
      }
      await route.fulfill({
        status: 200,
        headers,
        contentType: 'application/json',
        body: JSON.stringify({ id, ackedAt: new Date().toISOString(), receipt: `fake-receipt-${log.acks.length}-${id}` }),
      });
      return;
    }
    await route.fulfill({ status: 404, headers, body: 'not found' });
  }

  return {
    log,
    addIncident,
    setIncidents(next) {
      incidents = [...next];
    },
    set failAck(value) {
      options.failAck = value;
    },
    async install(target) {
      await target.route(`${FAKE_API}/**`, handle);
    },
  };
}
