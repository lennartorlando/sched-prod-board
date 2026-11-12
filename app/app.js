import { ack, fetchIncidents } from './api.js';

const REFRESH_MS = 2000;
const STALL_MS = 10000; // a pending answer older than this is reported, never doubled

const list = document.querySelector('[data-testid="incident-list"]');
const loader = document.querySelector('[data-testid="loader"]');
const empty = document.querySelector('[data-testid="empty"]');
const status = document.querySelector('.status');

// --- Times in the viewer's zone and order (SCHED-4514) ---------------------

// EU member states. Some of their locales print month first through Intl (hu, lt);
// the plan asks for day before month in every EU locale.
const EU_REGIONS = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE',
  'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
]);

const stampFormat = new Intl.DateTimeFormat(undefined, {
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});
const clockFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });

function viewerRegion() {
  try {
    return new Intl.Locale(stampFormat.resolvedOptions().locale).maximize().region ?? '';
  } catch {
    return '';
  }
}

function monthComesFirst() {
  const types = stampFormat.formatToParts(new Date(Date.UTC(2026, 10, 12, 12))).map((p) => p.type);
  return types.indexOf('month') < types.indexOf('day');
}

const swapDayMonth = EU_REGIONS.has(viewerRegion()) && monthComesFirst();

function formatStamp(iso) {
  const parts = stampFormat.formatToParts(new Date(iso));
  if (swapDayMonth) {
    const d = parts.findIndex((p) => p.type === 'day');
    const m = parts.findIndex((p) => p.type === 'month');
    [parts[d], parts[m]] = [parts[m], parts[d]];
  }
  return parts.map((p) => p.value).join('');
}

// --- Rows, keyed by incident id (SCHED-4511) --------------------------------

const rows = new Map(); // incident id -> <li>
const acked = new Map(); // incident id -> ackedAt of the ack that succeeded

function cell(tag, className) {
  const el = document.createElement(tag);
  el.className = className;
  return el;
}

function createRow(incident) {
  const li = document.createElement('li');
  li.dataset.testid = 'incident-row';
  li.dataset.id = incident.id;
  const action = cell('span', 'action');
  const button = cell('button', 'ack');
  button.type = 'button';
  button.dataset.testid = 'ack';
  button.textContent = 'Ack';
  action.append(button);
  li.append(cell('span', 'id'), cell('span', 'sev'), cell('span', 'what'), cell('time', 'when'), action);
  return li;
}

function ackedMark(at) {
  const mark = cell('span', 'acked');
  mark.dataset.testid = 'acked';
  mark.textContent = `acked ${clockFormat.format(new Date(at))}`;
  return mark;
}

// The action cell follows `acked`: an acked incident shows its mark, also when its row is
// rebuilt; an Ack in flight or an error note is left alone.
function syncAction(li, id) {
  const at = acked.get(id);
  li.classList.toggle('is-acked', at !== undefined);
  const action = li.querySelector('.action');
  if (at !== undefined && !action.querySelector('[data-testid="acked"]')) action.replaceChildren(ackedMark(at));
}

function updateRow(li, incident) {
  const severity = /^sev\d$/.test(incident.severity) ? incident.severity : 'sev-other';
  li.className = `row ${severity}`;
  li.querySelector('.id').textContent = incident.id;
  li.querySelector('.sev').textContent = incident.severity;
  li.querySelector('.what').textContent = `${incident.service} · ${incident.region} · ${incident.summary}`;
  const time = li.querySelector('.when');
  time.dateTime = incident.openedAt;
  time.textContent = formatStamp(incident.openedAt);
  syncAction(li, incident.id);
}

// Newest first, in the API's order. Known rows keep their node (and their acked mark);
// only nodes out of place move, so a new incident is one insertion at the top.
function render(incidents) {
  const seen = new Set();
  incidents.forEach((incident, index) => {
    seen.add(incident.id);
    let li = rows.get(incident.id);
    if (!li) {
      li = createRow(incident);
      rows.set(incident.id, li);
    }
    updateRow(li, incident);
    const current = list.children[index];
    if (current !== li) list.insertBefore(li, current ?? null);
  });
  for (const [id, li] of rows) {
    if (!seen.has(id)) {
      li.remove();
      rows.delete(id);
    }
  }
  empty.hidden = incidents.length > 0;
}

// --- Ack (SCHED-4511) --------------------------------------------------------

async function takeIncident(li) {
  const id = li.dataset.id;
  const action = li.querySelector('.action');
  const button = action.querySelector('[data-testid="ack"]');
  button.disabled = true;
  button.textContent = 'Acking…';
  action.querySelector('.ack-error')?.remove();
  try {
    const reply = await ack(id);
    acked.set(id, reply.ackedAt ?? new Date().toISOString());
    syncAction(li, id);
  } catch (error) {
    console.error(error);
    button.disabled = false;
    button.textContent = 'Ack';
    const note = cell('span', 'ack-error');
    note.setAttribute('role', 'alert');
    note.textContent = 'Ack failed. Try again.';
    action.append(note);
  }
}

list.addEventListener('click', (event) => {
  const button = event.target.closest('[data-testid="ack"]');
  if (!button || button.disabled) return;
  takeIncident(button.closest('[data-testid="incident-row"]'));
});

// --- Loader and refresh (SCHED-4512, SCHED-4513) ----------------------------

let loaded = false;
let inFlight = false;
let lastUpdate = null;
let timer;

async function refresh() {
  if (inFlight) return;
  inFlight = true;
  clearTimeout(timer);
  const started = performance.now();
  const stall = setTimeout(() => {
    status.textContent = loaded
      ? `No update since ${clockFormat.format(lastUpdate)}. Waiting for the server…`
      : 'Still waiting for incidents…';
  }, STALL_MS);
  try {
    const page = await fetchIncidents();
    if (!Array.isArray(page?.incidents)) throw new Error('incidents: the answer holds no incident list');
    render(page.incidents);
    lastUpdate = new Date();
    if (!loaded) {
      loaded = true;
      loader.hidden = true;
    }
    status.textContent = '';
  } catch (error) {
    console.error(error);
    status.textContent = loaded
      ? `Last update failed at ${clockFormat.format(new Date())}. Retrying…`
      : 'Could not load incidents. Retrying…';
  } finally {
    clearTimeout(stall);
    inFlight = false;
    timer = setTimeout(refresh, Math.max(0, REFRESH_MS - (performance.now() - started)));
  }
}

// Background tabs run timers as rarely as once a minute; catch up when the board is seen again.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refresh();
});

refresh();
