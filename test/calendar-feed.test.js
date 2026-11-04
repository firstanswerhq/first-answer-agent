// Connect a real calendar: read-only Google Calendar feed, fallback, privacy, and the customer's calendar file.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, withProfile } from '../src/config.js';
import { CalendarFeed, validateFeedUrl, parseIcs, FeedConfigError } from '../src/icalfeed.js';
import { listSlots, openSlots, feedFor } from '../src/calendar.js';
import { escapeText, fold, buildIcs, googleCalendarUrl } from '../src/ics.js';
import { instantOfLocal, localString } from '../src/tz.js';
import { loadProfile } from '../src/profile.js';
import { Store } from '../src/store.js';
import { startServer, post, makeClock, WED_10AM, lead } from './helpers.js';

const FIX = path.join(import.meta.dirname, 'fixtures', 'ics');
const fx = (n) => fs.readFileSync(path.join(FIX, n), 'utf8');
const SECRET = 'SECRETTOKEN9f8e7d6c5b4a';
const URL_OK = `https://calendar.google.com/calendar/ical/owner%40example.com/private-${SECRET}/basic.ics`;
const TZ = 'America/Chicago';

const respond = (text, init = {}) => new Response(text, { status: 200, headers: { 'content-type': 'text/calendar' }, ...init });
function mockFetch(handler) {
  const f = async (url, opts) => { f.calls.push({ url: String(url), opts }); return typeof handler === 'function' ? handler(String(url), opts, f.calls.length) : handler; };
  f.calls = [];
  return f;
}
const cfgWith = (ics, { env = {}, over = {}, fetchImpl } = {}) => {
  const f = fetchImpl || mockFetch(() => respond(ics));
  const cfg = loadConfig({ DATA_FILE: '', CALENDAR_ICAL_URL: URL_OK, ...env }, { seedOnEmpty: false, followupSpeedup: 60, calendarFetch: f, ...over });
  cfg.fetchMock = f;
  return cfg;
};
const statusOf = async (cfg, id, now = WED_10AM) => {
  await cfg.calendarFeed.ensureFresh(now);
  const s = listSlots(new Store(), cfg, now, id.slice(0, 10), 1).find((x) => x.slot_id === id);
  return s?.status;
};

// ---------------------------------------------------------------- startup validation
test('feed URL: only https on exactly calendar.google.com is accepted; messages never repeat the address', () => {
  assert.ok(validateFeedUrl(URL_OK).startsWith('https://calendar.google.com/'));
  const bad = [
    `http://calendar.google.com/calendar/ical/x/private-${SECRET}/basic.ics`,
    `https://evil.example.com/calendar/ical/x/private-${SECRET}/basic.ics`,
    `https://calendar.google.com.evil.com/private-${SECRET}/basic.ics`,
    `https://evil.com/calendar.google.com/private-${SECRET}`,
    `https://calendar.google.com@evil.com/private-${SECRET}/basic.ics`,
    `https://user:${SECRET}@calendar.google.com/calendar/ical/x/basic.ics`,
    `https://www.calendar.google.com/private-${SECRET}/basic.ics`,
    `https://calendar.google.com:8443/private-${SECRET}/basic.ics`,
    `file:///etc/passwd?${SECRET}`, `ftp://calendar.google.com/${SECRET}`, `not a url ${SECRET}`, '',
  ];
  for (const b of bad) {
    assert.throws(() => validateFeedUrl(b), (e) => e instanceof FeedConfigError && !e.message.includes(SECRET) && !/evil|etc\/passwd/.test(e.message), b);
    if (b) assert.throws(() => loadConfig({ DATA_FILE: '', CALENDAR_ICAL_URL: b }), (e) => !String(e.message).includes(SECRET), b);
  }
});

test('config: no URL means no feed anywhere; CALENDAR_PROFILE defaults to dental; unknown profile stops startup', () => {
  assert.equal(loadConfig({ DATA_FILE: '' }).calendarFeed, null);
  assert.equal(cfgWith('').calendarFeed.profile, 'dental');
  assert.equal(cfgWith('', { env: { CALENDAR_PROFILE: 'salon' } }).calendarFeed.profile, 'salon');
  assert.throws(() => cfgWith('', { env: { CALENDAR_PROFILE: 'nope' } }), /CALENDAR_PROFILE/);
});

test('the feed applies to ONE profile only; other profiles keep their demo calendar', async () => {
  const cfg = cfgWith(fx('allday.ics'));
  await cfg.calendarFeed.ensureFresh(WED_10AM);
  assert.ok(feedFor(cfg));
  const salon = withProfile(cfg, loadProfile('salon'));
  assert.equal(feedFor(salon), null);
  const noEvent = listSlots(new Store(), salon, WED_10AM, '2026-11-06', 1);
  assert.ok(noEvent.length > 0 && noEvent.every((s) => s.status !== 'busy'));
  const dental = listSlots(new Store(), cfg, WED_10AM, '2026-11-06', 1);
  assert.ok(dental.every((s) => s.status === 'busy'), 'Friday is blocked by the all-day event');
});

// ---------------------------------------------------------------- fixtures
test('UTC event blocks the matching local slot only', async () => {
  const cfg = cfgWith(fx('utc.ics'));
  assert.equal(await statusOf(cfg, '2026-11-05T09:00'), 'busy'); // 15:00Z = 9:00 CST
  assert.equal(await statusOf(cfg, '2026-11-05T08:00'), 'open');
  assert.equal(await statusOf(cfg, '2026-11-05T10:00'), 'open');
  assert.equal(cfg.calendarFeed.status().eventsLoaded, 1);
});

test('TZID event is converted to the business time zone', async () => {
  const cfg = cfgWith(fx('tzid.ics'));
  assert.equal(await statusOf(cfg, '2026-11-05T10:00'), 'busy'); // 11:00 Eastern = 10:00 Central
  assert.equal(await statusOf(cfg, '2026-11-05T11:00'), 'open');
});

test('all-day event (VALUE=DATE) blocks the whole local day', async () => {
  const cfg = cfgWith(fx('allday.ics'));
  assert.equal(await statusOf(cfg, '2026-11-06T08:00'), 'busy');
  assert.equal(await statusOf(cfg, '2026-11-06T11:00'), 'busy');
  const slots = listSlots(new Store(), cfg, WED_10AM, '2026-11-05', 1);
  assert.ok(slots.every((s) => s.status !== 'busy'), 'Thursday is untouched');
});

test('weekly RRULE with BYDAY, COUNT and EXDATE', async () => {
  const cfg = cfgWith(fx('weekly-exdate.ics'));
  assert.equal(await statusOf(cfg, '2026-11-09T13:00'), 'busy'); // Mon
  assert.equal(await statusOf(cfg, '2026-11-12T13:00'), 'busy'); // Thu
  assert.equal(await statusOf(cfg, '2026-11-05T13:00'), 'open', 'EXDATE removes this Thursday');
  assert.equal(await statusOf(cfg, '2026-11-19T13:00'), 'busy', '6th occurrence');
  assert.equal(await statusOf(cfg, '2026-11-23T13:00'), 'open', 'COUNT=6 ended the series');
  assert.equal(await statusOf(cfg, '2026-11-10T13:00'), 'open', 'Tuesday is not in BYDAY');
});

test('cancelled and transparent events are not busy', async () => {
  const c = cfgWith(fx('cancelled.ics'));
  assert.equal(await statusOf(c, '2026-11-05T14:00'), 'open');
  const t = cfgWith(fx('transparent.ics'));
  assert.equal(await statusOf(t, '2026-11-05T15:00'), 'open');
});

test('floating time with DURATION is read in the business zone', async () => {
  const cfg = cfgWith(fx('floating-duration.ics'));
  assert.equal(await statusOf(cfg, '2026-11-05T16:00'), 'busy');
  assert.equal(await statusOf(cfg, '2026-11-05T15:00'), 'open');
});

test('daily RRULE with INTERVAL and UNTIL; RECURRENCE-ID moves one instance', () => {
  const ics = [
    'BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:d@x', 'DTSTART;TZID=America/Chicago:20261105T090000', 'DTEND;TZID=America/Chicago:20261105T100000',
    'RRULE:FREQ=DAILY;INTERVAL=2;UNTIL=20261111T235959Z', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:d@x', 'RECURRENCE-ID;TZID=America/Chicago:20261107T090000', 'DTSTART;TZID=America/Chicago:20261107T150000', 'DTEND;TZID=America/Chicago:20261107T160000', 'END:VEVENT',
    'END:VCALENDAR'].join('\r\n');
  const from = Date.UTC(2026, 10, 1); const to = Date.UTC(2027, 0, 1);
  const { blocks } = parseIcs(ics, { tz: TZ, from, to });
  const local = blocks.map((b) => localString(b.start, TZ));
  assert.deepEqual(local, ['2026-11-05T09:00', '2026-11-07T15:00', '2026-11-09T09:00', '2026-11-11T09:00']);
});

test('weekly recurrence keeps its local time across the daylight saving change', () => {
  const ics = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:w@x', 'DTSTART;TZID=America/Chicago:20261023T100000', 'DTEND;TZID=America/Chicago:20261023T110000', 'RRULE:FREQ=WEEKLY;COUNT=4', 'END:VEVENT', 'END:VCALENDAR'].join('\n');
  const { blocks } = parseIcs(ics, { tz: TZ, from: Date.UTC(2026, 9, 1), to: Date.UTC(2027, 0, 1) });
  assert.deepEqual(blocks.map((b) => localString(b.start, TZ)), ['2026-10-23T10:00', '2026-10-30T10:00', '2026-11-06T10:00', '2026-11-13T10:00']);
});

test('malformed and non-calendar content is a parse error and falls back', async () => {
  for (const body of [fx('malformed.ics'), fx('not-ics.html'), '']) {
    const cfg = cfgWith(body);
    await cfg.calendarFeed.ensureFresh(WED_10AM);
    const s = cfg.calendarFeed.status();
    assert.equal(s.connected, false);
    assert.equal(s.lastError, 'parse_error');
    assert.equal(await statusOf(cfg, '2026-11-05T09:00'), 'open', 'demo calendar is used');
  }
});

test('an empty but valid calendar is connected with zero events', async () => {
  const cfg = cfgWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n');
  await cfg.calendarFeed.ensureFresh(WED_10AM);
  assert.deepEqual([cfg.calendarFeed.status().connected, cfg.calendarFeed.status().eventsLoaded], [true, 0]);
});

test('oversized feed (over 2 MB) is refused, by header and by streaming', async () => {
  const big = `BEGIN:VCALENDAR\r\n${'X-PAD:' + 'a'.repeat(1000) + '\r\n'.repeat(1)}`.repeat(2500) + 'END:VCALENDAR\r\n';
  assert.ok(big.length > 2 * 1024 * 1024);
  const cfg = cfgWith(big);
  await cfg.calendarFeed.ensureFresh(WED_10AM);
  assert.equal(cfg.calendarFeed.status().lastError, 'too_large');
  const byHeader = cfgWith('', { fetchImpl: mockFetch(() => respond('BEGIN:VCALENDAR\r\nEND:VCALENDAR', { headers: { 'content-length': String(3 * 1024 * 1024) } })) });
  await byHeader.calendarFeed.ensureFresh(WED_10AM);
  assert.equal(byHeader.calendarFeed.status().lastError, 'too_large');
});

// ---------------------------------------------------------------- fetching
test('fetch: cached for 60 seconds, then refreshed; requests only the configured address, no redirects followed blindly', async () => {
  const cfg = cfgWith(fx('utc.ics'));
  const f = cfg.fetchMock;
  await cfg.calendarFeed.ensureFresh(WED_10AM);
  await cfg.calendarFeed.ensureFresh(WED_10AM + 59_000);
  assert.equal(f.calls.length, 1);
  await cfg.calendarFeed.ensureFresh(WED_10AM + 61_000);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].url, URL_OK);
  assert.equal(f.calls[0].opts.redirect, 'manual');
  assert.ok(f.calls[0].opts.signal, 'a timeout signal is attached');
});

test('fetch: concurrent callers share one request', async () => {
  const f = mockFetch(async () => { await new Promise((r) => setTimeout(r, 20)); return respond(fx('utc.ics')); });
  const cfg = cfgWith('', { fetchImpl: f });
  await Promise.all([1, 2, 3, 4].map(() => cfg.calendarFeed.ensureFresh(WED_10AM)));
  assert.equal(f.calls.length, 1);
});

test('fetch: a redirect to another host is never followed; a redirect within calendar.google.com is', async () => {
  const evil = mockFetch(() => new Response(null, { status: 302, headers: { location: `https://evil.example.com/steal?${SECRET}` } }));
  const cfg = cfgWith('', { fetchImpl: evil });
  await cfg.calendarFeed.ensureFresh(WED_10AM);
  assert.equal(evil.calls.length, 1, 'the second host was not contacted');
  assert.equal(cfg.calendarFeed.status().lastError, 'bad_redirect');
  const http = mockFetch(() => new Response(null, { status: 301, headers: { location: 'http://calendar.google.com/x' } }));
  const c2 = cfgWith('', { fetchImpl: http });
  await c2.calendarFeed.ensureFresh(WED_10AM);
  assert.equal(c2.calendarFeed.status().lastError, 'bad_redirect');
  const ok = mockFetch((u, _o, n) => (n === 1 ? new Response(null, { status: 302, headers: { location: '/calendar/ical/moved/basic.ics' } }) : respond(fx('utc.ics'))));
  const c3 = cfgWith('', { fetchImpl: ok });
  await c3.calendarFeed.ensureFresh(WED_10AM);
  assert.equal(c3.calendarFeed.status().connected, true);
  assert.equal(ok.calls[1].url, 'https://calendar.google.com/calendar/ical/moved/basic.ics');
});

test('fetch: timeout, HTTP error and network error give short codes without the address', async () => {
  const hang = mockFetch((_u, opts) => new Promise((_res, rej) => opts.signal.addEventListener('abort', () => rej(Object.assign(new Error(`aborted ${URL_OK}`), { name: 'AbortError' })))));
  const feed = new CalendarFeed({ url: URL_OK, profile: 'dental', tz: TZ, fetchImpl: hang, timeoutMs: 40 });
  await feed.ensureFresh(WED_10AM);
  assert.equal(feed.status().lastError, 'timeout');
  const e403 = cfgWith('', { fetchImpl: mockFetch(() => respond('no', { status: 403 })) });
  await e403.calendarFeed.ensureFresh(WED_10AM);
  assert.equal(e403.calendarFeed.status().lastError, 'http_error');
  const net = cfgWith('', { fetchImpl: mockFetch(() => { throw new TypeError(`fetch failed for ${URL_OK}`); }) });
  await net.calendarFeed.ensureFresh(WED_10AM);
  assert.equal(net.calendarFeed.status().lastError, 'network');
  for (const c of [feed, e403.calendarFeed, net.calendarFeed]) {
    const dump = JSON.stringify(c.status()) + JSON.stringify(c) + String(c.lastError);
    assert.ok(!dump.includes(SECRET));
  }
});

test('fetch: after a failure the demo calendar is used, and it recovers on the next successful read', async () => {
  let fail = true;
  const f = mockFetch(() => (fail ? respond('x', { status: 500 }) : respond(fx('utc.ics'))));
  const cfg = cfgWith('', { fetchImpl: f });
  assert.equal(await statusOf(cfg, '2026-11-05T09:00'), 'open');
  assert.equal(cfg.calendarFeed.status().connected, false);
  fail = false;
  assert.equal(await statusOf(cfg, '2026-11-05T09:00', WED_10AM + 31_000), 'busy');
  assert.equal(cfg.calendarFeed.status().connected, true);
  fail = true;
  assert.equal(await statusOf(cfg, '2026-11-05T09:00', WED_10AM + 100_000), 'busy', 'a short outage keeps the last good read (flagged stale)');
  assert.equal(cfg.calendarFeed.status().stale, true);
  assert.equal(await statusOf(cfg, '2026-11-05T09:00', WED_10AM + 31_000 + 16 * 60_000), 'open', 'after 15 minutes of failures it drops back to the demo calendar');
  assert.equal(cfg.calendarFeed.status().connected, false);
});

// ---------------------------------------------------------------- app behavior
const get = async (base, p) => (await fetch(base + p)).json();
const settle = (s) => Promise.all([...s.agent.chains.values()]);

const WED_ALLDAY = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:w@x', 'DTSTART;VALUE=DATE:20261104', 'DTEND;VALUE=DATE:20261105', 'SUMMARY:SECRET TITLE away', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');

test('agent: connected calendar is used, named in the timeline, and offered times skip busy blocks', async () => {
  const cfg = cfgWith(WED_ALLDAY);
  const s = await startServer({ config: cfg, now: makeClock(WED_10AM).now });
  try {
    const { id } = await (await post(s.base, '/api/leads', lead())).json();
    await settle(s);
    const d = (await get(s.base, `/api/leads/${id}`)).lead;
    const dump = JSON.stringify(d.timeline);
    assert.match(dump, /Checked the calendar \(Connected Google Calendar \(read-only\)\)/);
    assert.ok(!/Demo calendar/.test(dump));
    const said = d.messages.filter((m) => m.from === 'agent').map((m) => m.text).join(' ');
    assert.match(said, /Thu, Nov 5/, 'times come from the next free day');
    assert.ok(!/Wed, Nov 4/.test(said), 'the busy day is not offered');
    assert.ok(!/SECRET TITLE/.test(JSON.stringify(d)));
  } finally { await s.stop(); }
});

test('agent: with the feed down the timeline says Demo calendar and never claims a connection', async () => {
  const cfg = cfgWith('', { fetchImpl: mockFetch(() => respond('x', { status: 500 })) });
  const s = await startServer({ config: cfg, now: makeClock(WED_10AM).now });
  try {
    const { id } = await (await post(s.base, '/api/leads', lead())).json();
    await settle(s);
    const d = (await get(s.base, `/api/leads/${id}`)).lead;
    const dump = JSON.stringify(d.timeline);
    assert.match(dump, /Checked the calendar \(Demo calendar\)/);
    assert.ok(!/Connected Google Calendar/.test(dump));
  } finally { await s.stop(); }
});

test('agent: a busy slot cannot be booked even if the model asks for it, a free one can', async () => {
  const { Functions } = await import('../src/functions.js');
  const { classify } = await import('../src/safety.js');
  const { makeEnv } = await import('./helpers.js');
  const cfg = cfgWith(fx('utc.ics'));
  const env = makeEnv({ config: cfg, clock: makeClock(WED_10AM) });
  const { lead: l } = env.svc.createLead(lead(), { run: false });
  const f = new Functions({ store: env.store, config: cfg, now: env.clock.now, lead: l, flags: classify('', cfg.profile), step: () => {}, run: { startMs: WED_10AM } });
  await f.call('qualify_lead', { service: 'checkup', urgency: 'routine' });
  const busy = await f.call('book_appointment', { slot_id: '2026-11-05T09:00' });
  assert.equal(busy.ok, false);
  assert.match(busy.error, /no longer available/);
  assert.equal(env.store.bookings.length, 0);
  const free = await f.call('book_appointment', { slot_id: '2026-11-05T10:00' });
  assert.equal(free.ok, true);
});

test('health, config and calendar API: status flags and codes only, never the address or event titles', async () => {
  const cfg = cfgWith(fx('utc.ics'));
  const logs = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  for (const k of Object.keys(orig)) console[k] = (...a) => logs.push(a.map(String).join(' '));
  const s = await startServer({ config: cfg, now: makeClock(WED_10AM).now });
  try {
    await cfg.calendarFeed.ensureFresh(WED_10AM);
    const bodies = [];
    for (const p of ['/api/health', '/api/config', '/api/calendar', '/api/profiles', '/api/leads', '/api/metrics']) bodies.push(await (await fetch(s.base + p)).text());
    const health = JSON.parse(bodies[0]);
    assert.deepEqual(Object.keys(health.calendar).sort(), ['configured', 'connected', 'eventsLoaded', 'lastError', 'lastOk', 'stale', 'staleMinutes', 'unsupportedRules', 'warnings']);
    assert.equal(health.calendar.connected, true);
    assert.equal(health.calendar.eventsLoaded, 1);
    assert.match(health.calendar.lastOk, /^\d{4}-\d\d-\d\dT/);
    assert.equal(health.calendar.lastError, null);
    for (const b of bodies) {
      assert.ok(!b.includes(SECRET) && !b.includes('calendar.google.com/calendar/ical') && !b.includes('owner%40example.com'), 'no address');
      assert.ok(!/SECRET TITLE|root canal|private notes/.test(b), 'no event titles');
    }
    const cal = JSON.parse(bodies[2]);
    assert.equal(cal.calendar.connected, true);
    assert.equal(cal.calendar.notice, null);
    const thu = cal.days.find((d) => d.date === '2026-11-05');
    assert.deepEqual(thu.busy.map((b) => [b.start, b.end]), [['09:00', '10:00']]);
    assert.equal(thu.slots.find((x) => x.slot_id === '2026-11-05T09:00').status, 'busy');
  } finally {
    Object.assign(console, orig);
    await s.stop();
  }
  assert.ok(!logs.join('\n').includes(SECRET));
});

test('failure notice appears on the calendar API and in health; other profiles show no calendar notice', async () => {
  const cfg = cfgWith('', { fetchImpl: mockFetch(() => respond('nope', { status: 500 })) });
  const s = await startServer({ config: cfg, now: makeClock(WED_10AM).now });
  try {
    const cal = await get(s.base, '/api/calendar');
    assert.equal(cal.calendar.connected, false);
    assert.equal(cal.calendar.source, 'demo');
    assert.match(cal.calendar.notice, /demo calendar/);
    assert.ok(cal.days.every((d) => d.busy.length === 0));
    const health = await get(s.base, '/api/health');
    assert.deepEqual([health.calendar.connected, health.calendar.lastError, health.calendar.eventsLoaded, health.calendar.lastOk], [false, 'http_error', 0, null]);
    const salon = await get(s.base, '/api/calendar?profile=salon');
    assert.deepEqual([salon.calendar.configured, salon.calendar.notice], [false, null]);
    const sh = await get(s.base, '/api/health?profile=salon');
    assert.equal(sh.calendar.configured, false);
  } finally { await s.stop(); }
});

test('without CALENDAR_ICAL_URL nothing changes: demo calendar, no notice, health says not configured', async () => {
  const s = await startServer({ now: makeClock(WED_10AM).now });
  try {
    const cal = await get(s.base, '/api/calendar');
    assert.deepEqual([cal.calendar.source, cal.calendar.notice, cal.calendar.configured], ['demo', null, false]);
    assert.equal((await get(s.base, '/api/health')).calendar.connected, false);
  } finally { await s.stop(); }
});

test('booked demo appointments still block slots and show the customer name on a connected calendar', async () => {
  const cfg = cfgWith(fx('utc.ics'));
  const s = await startServer({ config: cfg, now: makeClock(WED_10AM).now });
  try {
    const { id, token } = await (await post(s.base, '/api/leads', lead({ name: 'Maria Booker' }))).json();
    await settle(s);
    await post(s.base, `/api/leads/${id}/customer-reply`, { text: 'The first one works', token });
    await settle(s);
    const cal = await get(s.base, '/api/calendar');
    const booked = cal.days.flatMap((d) => d.slots).filter((x) => x.status === 'booked');
    assert.equal(booked.length, 1);
    assert.equal(booked[0].booking.name, 'Maria Booker');
  } finally { await s.stop(); }
});

// ---------------------------------------------------------------- customer calendar file
async function bookedLead(s, over = {}) {
  const { id, token } = await (await post(s.base, '/api/leads', lead(over))).json();
  await settle(s);
  await post(s.base, `/api/leads/${id}/customer-reply`, { text: 'The first one works', token });
  await settle(s);
  return { id, token };
}
const unfolded = (t) => t.replace(/\r\n[ \t]/g, '');

test('appointment.ics: valid RFC 5545 file for a booked lead, with token, headers and only public facts', async () => {
  const s = await startServer({ now: makeClock(WED_10AM).now });
  try {
    const { id, token } = await bookedLead(s, { name: 'Maria Booker', phone: '(615) 555-0142' });
    const r = await fetch(`${s.base}/api/public/leads/${id}/appointment.ics?token=${token}`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /^text\/calendar/);
    assert.match(r.headers.get('content-disposition'), /^attachment; filename="appointment\.ics"$/);
    const text = await r.text();
    assert.ok(text.startsWith('BEGIN:VCALENDAR\r\n') && text.endsWith('END:VCALENDAR\r\n'));
    assert.ok(!/(^|[^\r])\n/.test(text), 'every line ends with CRLF');
    for (const line of text.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75, line);
    const u = unfolded(text);
    assert.equal((u.match(/^BEGIN:VEVENT$/gm) || []).length, 1);
    assert.equal((u.match(/^END:VEVENT$/gm) || []).length, 1);
    for (const key of ['VERSION:2.0', 'PRODID:', 'UID:', 'DTSTAMP:', 'DTSTART:', 'DTEND:', 'SUMMARY:', 'DESCRIPTION:']) assert.ok(u.includes('\r\n' + key) || u.startsWith(key), key);
    assert.match(u, /DTSTAMP:20261104T160000Z/);
    const start = /DTSTART:(\d{8}T\d{6}Z)/.exec(u)[1]; const end = /DTEND:(\d{8}T\d{6}Z)/.exec(u)[1];
    assert.ok(end > start);
    const d = (await get(s.base, `/api/leads/${id}`)).lead;
    const slot = d.booking.slot_id;
    const ms = instantOfLocal(slot, TZ);
    assert.equal(start, new Date(ms).toISOString().replace(/[-:]|\.\d{3}/g, ''));
    assert.match(u, /SUMMARY:.+ at Brightwater Family Dental/);
    assert.match(u, /DESCRIPTION:Demo booking\./);
    assert.ok(!/Maria|Booker|555-0142/i.test(u), 'nothing private');
    // the lead page exposes the matching Google link
    const pub = await get(s.base, `/api/public/leads/${id}?token=${token}`);
    assert.ok(pub.appointment.googleUrl.startsWith('https://calendar.google.com/calendar/render?action=TEMPLATE&text='));
    assert.ok(pub.appointment.googleUrl.includes(`dates=${start}%2F${end}`) || pub.appointment.googleUrl.includes(`dates=${encodeURIComponent(start + '/' + end)}`));
    assert.ok(!/Maria|555-0142/.test(pub.appointment.googleUrl));
  } finally { await s.stop(); }
});

test('appointment.ics: needs the right token and a real booking', async () => {
  const s = await startServer({ now: makeClock(WED_10AM).now });
  try {
    const booked = await bookedLead(s);
    const other = await (await post(s.base, '/api/leads', lead({ message: 'Hello there, I want to know something' }))).json();
    await settle(s);
    const p = (id, q) => fetch(`${s.base}/api/public/leads/${id}/appointment.ics${q}`);
    assert.equal((await p(booked.id, '')).status, 404, 'no token');
    assert.equal((await p(booked.id, '?token=wrong')).status, 404);
    assert.equal((await p(booked.id, `?token=${other.token}`)).status, 404, 'another lead token');
    assert.equal((await p('L-deadbeef', `?token=${booked.token}`)).status, 404);
    const pub = await get(s.base, `/api/public/leads/${other.id}?token=${other.token}`);
    assert.equal(pub.appointment, null);
    assert.equal((await p(other.id, `?token=${other.token}`)).status, 404, 'a lead that is not booked gets no file');
    assert.equal((await p(booked.id, `?token=${booked.token}`)).status, 200);
  } finally { await s.stop(); }
});

test('calendar file text escaping and line folding (RFC 5545)', () => {
  assert.equal(escapeText('a, b; c \\ d'), 'a\\, b\\; c \\\\ d');
  assert.equal(escapeText('x\r\nBEGIN:VEVENT\nATTENDEE:mailto:a@b.c'), 'x BEGIN:VEVENT ATTENDEE:mailto:a@b.c');
  assert.ok(!new RegExp('[\r\n\u2028\u2029\u0085]').test(escapeText('a\r\nb\u2028c\u2029d\u0085e\u0000f')));
  const long = fold('DESCRIPTION:' + '\u00e9'.repeat(100));
  for (const line of long.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75);
  assert.equal(long.replace(/\r\n /g, ''), 'DESCRIPTION:' + '\u00e9'.repeat(100), 'folding loses nothing and never splits a character');
});

test('calendar file and Google link are injection safe even with hostile business and service names', () => {
  const cfg = loadConfig({ DATA_FILE: '', BUSINESS_NAME: 'Evil, Inc;\r\nATTENDEE:mailto:x@evil.example\r\nBEGIN:VEVENT' }, { seedOnEmpty: false });
  const booking = { id: 'B-1\r\nX:1', slot_id: '2026-11-05T10:00', serviceLabel: 'Clean\r\nORGANIZER:mailto:a@evil.example', name: 'Eve\r\nBEGIN:VEVENT', leadId: 'L-1' };
  const ics = buildIcs(booking, cfg, WED_10AM);
  const u = unfolded(ics);
  assert.equal(u.split('\r\n').filter((l) => l === 'BEGIN:VEVENT').length, 1);
  assert.ok(!/^ATTENDEE|^ORGANIZER|^X:1/m.test(u), 'no injected property lines');
  assert.ok(!u.includes('Eve'), 'customer name is not used');
  assert.equal(u.split('\r\n').filter((l) => l.startsWith('SUMMARY:')).length, 1);
  assert.ok(ics.split('\r\n').every((l) => !/[\r\n]/.test(l)));
  const url = googleCalendarUrl(booking, cfg);
  assert.ok(url.startsWith('https://calendar.google.com/calendar/render?action=TEMPLATE&'));
  assert.ok(!/[\r\n ]/.test(url) && !/%0[AD]/i.test(url), 'no raw or encoded line breaks in the link');
  assert.ok(new URL(url).hostname === 'calendar.google.com');
});

test('calendar file uses LOCATION only when the profile has an address', () => {
  const cfg = loadConfig({ DATA_FILE: '' }, { seedOnEmpty: false });
  const b = { id: 'B-2', slot_id: '2026-11-05T10:00', serviceLabel: 'Cleaning' };
  assert.ok(!/LOCATION/.test(buildIcs(b, cfg, WED_10AM)));
  cfg.business.address = '12 Main St, Nashville, TN';
  assert.ok(unfolded(buildIcs(b, cfg, WED_10AM)).includes('LOCATION:12 Main St\\, Nashville\\, TN'));
});

test('tz helpers round trip through the daylight saving change', () => {
  assert.equal(new Date(instantOfLocal('2026-11-04T10:00', TZ)).toISOString(), '2026-11-04T16:00:00.000Z');
  assert.equal(new Date(instantOfLocal('2026-10-30T10:00', TZ)).toISOString(), '2026-10-30T15:00:00.000Z');
  assert.equal(localString(Date.UTC(2026, 10, 4, 16, 0), TZ), '2026-11-04T10:00');
});
