// Review 10 fixes: bounded parsing, old series, monthly/yearly repeats, zone names, stale-while-error, unchecked dates.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { parseIcs } from '../src/icalfeed.js';
import { listSlots, calendarLabel } from '../src/calendar.js';
import { localString } from '../src/tz.js';
import { Store } from '../src/store.js';
import { calendarNotices, calendarBadge } from '../public/calnotes.js';
import { startServer, makeClock, WED_10AM } from './helpers.js';

const TZ = 'America/Chicago';
const URL_OK = 'https://calendar.google.com/calendar/ical/x/private-TOKENZZ/basic.ics';
const cal = (...events) => ['BEGIN:VCALENDAR', 'VERSION:2.0', ...events.flat(), 'END:VCALENDAR'].join('\r\n');
const ev = (uid, dtstart, dtend, extra = []) => ['BEGIN:VEVENT', `UID:${uid}`, dtstart, dtend, ...extra, 'END:VEVENT'];
const chi = (d, t) => `${d}T${t}`;
const WIN = { tz: TZ, from: Date.UTC(2026, 10, 1), to: Date.UTC(2027, 2, 1) };
const starts = (text, win = WIN) => parseIcs(text, win).blocks.map((b) => localString(b.start, TZ));

// ---- S1 / S2
test('S1: 300 old daily, weekly and monthly series parse in well under a second', () => {
  const events = [];
  for (let i = 0; i < 300; i += 1) {
    const day = 1 + (i % 28);
    const dd = String(day).padStart(2, '0');
    const f = ['DAILY', 'WEEKLY', 'MONTHLY'][i % 3];
    events.push(ev(`old${i}`, `DTSTART;TZID=America/Chicago:2012010${1 + (i % 9)}T090000`, `DTEND;TZID=America/Chicago:2012010${1 + (i % 9)}T100000`, [`RRULE:FREQ=${f}`]));
    void dd;
  }
  const t0 = Date.now();
  const { blocks } = parseIcs(cal(...events), { tz: TZ, from: Date.UTC(2026, 10, 1), to: Date.UTC(2026, 11, 1) });
  assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0} ms`);
  assert.ok(blocks.length > 100);
});

test('S1: a pathological calendar fails safe with too_complex instead of freezing', () => {
  const events = [];
  for (let i = 0; i < 2100; i += 1) events.push(ev(`e${i}`, 'DTSTART:20261105T150000Z', 'DTEND:20261105T160000Z', ['RRULE:FREQ=DAILY']));
  assert.throws(() => parseIcs(cal(...events), WIN), /too_complex/);
  const few = [ev('d', 'DTSTART:20261105T150000Z', 'DTEND:20261105T160000Z', ['RRULE:FREQ=DAILY;COUNT=999999'])];
  assert.ok(parseIcs(cal(...few), WIN).blocks.length > 100);
  const tiny = [ev('x', 'DTSTART:20261105T150000Z', 'DTEND:20261105T160000Z', ['RRULE:FREQ=DAILY'])];
  assert.throws(() => parseIcs(cal(...tiny), { ...WIN, cpuMs: -1 }), /too_complex/);
});

test('S2: a daily series that started years ago still blocks today', () => {
  const t = cal(ev('d', 'DTSTART;TZID=America/Chicago:20130101T090000', 'DTEND;TZID=America/Chicago:20130101T100000', ['RRULE:FREQ=DAILY']));
  const s = starts(t, { tz: TZ, from: Date.UTC(2026, 10, 4), to: Date.UTC(2026, 10, 8) });
  assert.deepEqual(s, ['2026-11-04T09:00', '2026-11-05T09:00', '2026-11-06T09:00', '2026-11-07T09:00']);
});

test('S2: COUNT and INTERVAL stay exact after the jump', () => {
  const t = cal(
    ev('a', 'DTSTART;TZID=America/Chicago:20261001T090000', 'DTEND;TZID=America/Chicago:20261001T100000', ['RRULE:FREQ=DAILY;INTERVAL=3;COUNT=10']),
    ev('b', 'DTSTART;TZID=America/Chicago:20260901T140000', 'DTEND;TZID=America/Chicago:20260901T150000', ['RRULE:FREQ=WEEKLY;BYDAY=TU,TH;COUNT=12']));
  const s = starts(t, { tz: TZ, from: Date.UTC(2026, 9, 25), to: Date.UTC(2027, 0, 1) });
  // a: Oct 1,4,...,28 (10 days: k=0..9 -> Oct 1..Oct 28); b: Sep 1,3,8,10,15,17,22,24,29,Oct 1,6,8 (12)
  assert.deepEqual(s.filter((x) => x.endsWith('09:00')), ['2026-10-25T09:00', '2026-10-28T09:00']);
  assert.deepEqual(s.filter((x) => x.endsWith('14:00')), []);
});

// ---- S3
test('S3: monthly by day-of-month, by ordinal weekday, and last weekday', () => {
  const win = { tz: TZ, from: Date.UTC(2026, 9, 1), to: Date.UTC(2027, 1, 1) };
  const dom = starts(cal(ev('m', 'DTSTART;TZID=America/Chicago:20250115T100000', 'DTEND;TZID=America/Chicago:20250115T110000', ['RRULE:FREQ=MONTHLY'])), win);
  assert.deepEqual(dom, ['2026-10-15T10:00', '2026-11-15T10:00', '2026-12-15T10:00', '2027-01-15T10:00']);
  const first = starts(cal(ev('t', 'DTSTART;TZID=America/Chicago:20250102T130000', 'DTEND;TZID=America/Chicago:20250102T140000', ['RRULE:FREQ=MONTHLY;BYDAY=1TH'])), win);
  assert.deepEqual(first, ['2026-10-01T13:00', '2026-11-05T13:00', '2026-12-03T13:00', '2027-01-07T13:00']);
  const last = starts(cal(ev('l', 'DTSTART;TZID=America/Chicago:20250131T130000', 'DTEND;TZID=America/Chicago:20250131T140000', ['RRULE:FREQ=MONTHLY;BYDAY=-1FR'])), win);
  assert.deepEqual(last, ['2026-10-30T13:00', '2026-11-27T13:00', '2026-12-25T13:00', '2027-01-29T13:00']);
  const monthEnd = starts(cal(ev('e', 'DTSTART;TZID=America/Chicago:20250131T090000', 'DTEND;TZID=America/Chicago:20250131T100000', ['RRULE:FREQ=MONTHLY;BYMONTHDAY=-1'])), win);
  assert.deepEqual(monthEnd, ['2026-10-31T09:00', '2026-11-30T09:00', '2026-12-31T09:00', '2027-01-31T09:00']);
});

test('S3: monthly INTERVAL, COUNT and UNTIL; yearly with and without BYMONTH', () => {
  const win = { tz: TZ, from: Date.UTC(2026, 0, 1), to: Date.UTC(2028, 0, 1) };
  const q = starts(cal(ev('q', 'DTSTART;TZID=America/Chicago:20260110T100000', 'DTEND;TZID=America/Chicago:20260110T110000', ['RRULE:FREQ=MONTHLY;INTERVAL=3;COUNT=3'])), win);
  assert.deepEqual(q, ['2026-01-10T10:00', '2026-04-10T10:00', '2026-07-10T10:00']);
  const u = starts(cal(ev('u', 'DTSTART;TZID=America/Chicago:20260110T100000', 'DTEND;TZID=America/Chicago:20260110T110000', ['RRULE:FREQ=MONTHLY;UNTIL=20260315T000000Z'])), win);
  assert.deepEqual(u, ['2026-01-10T10:00', '2026-02-10T10:00', '2026-03-10T10:00']);
  const y = starts(cal(ev('y', 'DTSTART;TZID=America/Chicago:20200704T100000', 'DTEND;TZID=America/Chicago:20200704T110000', ['RRULE:FREQ=YEARLY'])), win);
  assert.deepEqual(y, ['2026-07-04T10:00', '2027-07-04T10:00']);
  const y2 = starts(cal(ev('z', 'DTSTART;TZID=America/Chicago:20200101T100000', 'DTEND;TZID=America/Chicago:20200101T110000', ['RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=4TH'])), win);
  assert.deepEqual(y2, ['2026-11-26T10:00', '2027-11-25T10:00']);
});

test('S3: rules that are still unsupported are counted, not hidden', () => {
  const t = cal(ev('h', 'DTSTART:20261105T150000Z', 'DTEND:20261105T160000Z', ['RRULE:FREQ=HOURLY;COUNT=5']), ev('s', 'DTSTART:20261106T150000Z', 'DTEND:20261106T160000Z', ['RRULE:FREQ=MONTHLY;BYDAY=MO,TU;BYSETPOS=1']));
  const { stats, blocks } = parseIcs(t, WIN);
  assert.equal(stats.unsupported, 2);
  assert.equal(blocks.length, 2, 'the first occurrence still blocks');
  const notes = calendarNotices({ calendar: { configured: true, connected: true, unsupportedRules: 2, warnings: 0 } });
  assert.match(notes, /Some repeating events in the connected calendar are not supported and may not block time\./);
});

// ---- S4
test('S4: Windows and US/ zone names map to the right IANA zone', () => {
  const mk = (tzid) => cal(ev('w', `DTSTART;TZID=${tzid}:20261105T090000`, `DTEND;TZID=${tzid}:20261105T100000`));
  assert.deepEqual(starts(mk('Eastern Standard Time')), ['2026-11-05T08:00']);
  assert.deepEqual(starts(mk('Central Standard Time')), ['2026-11-05T09:00']);
  assert.deepEqual(starts(mk('Mountain Standard Time')), ['2026-11-05T10:00']);
  assert.deepEqual(starts(mk('Pacific Standard Time')), ['2026-11-05T11:00']);
  assert.deepEqual(starts(mk('US/Eastern')), ['2026-11-05T08:00']);
  assert.equal(parseIcs(mk('Eastern Standard Time'), WIN).stats.warnings, 0);
});

test('S4: an unknown zone name blocks both readings and is counted as a warning', () => {
  const t = cal(ev('u', 'DTSTART;TZID=Mars/Olympus_Mons:20261105T090000', 'DTEND;TZID=Mars/Olympus_Mons:20261105T100000'));
  const { blocks, stats } = parseIcs(t, WIN);
  assert.equal(stats.warnings, 1);
  assert.deepEqual(blocks.map((b) => localString(b.start, TZ)).sort(), ['2026-11-05T03:00', '2026-11-05T09:00']);
  assert.match(calendarNotices({ calendar: { configured: true, connected: true, warnings: 1, unsupportedRules: 0 } }), /could not be read exactly/);
});

// ---- S5 / S6 through the real config
const respond = (text, init = {}) => new Response(text, { status: 200, ...init });
function feedCfg(handler) {
  const f = async () => handler();
  return loadConfig({ DATA_FILE: '', CALENDAR_ICAL_URL: URL_OK }, { seedOnEmpty: false, calendarFetch: f });
}
const THU9 = cal(ev('t', 'DTSTART:20261105T150000Z', 'DTEND:20261105T160000Z'));
const slotStatus = (cfg, id, now) => listSlots(new Store(), cfg, now, id.slice(0, 10), 1).find((x) => x.slot_id === id)?.status;

test('S5: a failed refresh keeps the last good data for 15 minutes, flagged stale, then falls back', async () => {
  let fail = false;
  const cfg = feedCfg(() => (fail ? respond('x', { status: 500 }) : respond(THU9)));
  const feed = cfg.calendarFeed;
  await feed.ensureFresh(WED_10AM);
  assert.equal(calendarLabel(cfg), 'Connected Google Calendar (read-only)');
  fail = true;
  const t5 = WED_10AM + 5 * 60_000;
  await feed.ensureFresh(t5);
  const st = feed.status();
  assert.deepEqual([st.connected, st.stale, st.lastError, st.staleMinutes], [true, true, 'http_error', 5]);
  assert.equal(slotStatus(cfg, '2026-11-05T09:00', t5), 'busy', 'still blocks while stale');
  assert.equal(calendarLabel(cfg), 'Connected Google Calendar (read-only, last updated 5 min ago)');
  assert.match(calendarBadge({ calendar: st }), /updated 5 min ago/);
  assert.match(calendarNotices({ calendar: st }), /id="calStale"/);
  await feed.ensureFresh(WED_10AM + 16 * 60_000);
  assert.deepEqual([feed.status().connected, feed.status().stale], [false, false]);
  assert.equal(calendarLabel(cfg), 'Demo calendar');
  assert.equal(slotStatus(cfg, '2026-11-05T09:00', WED_10AM + 16 * 60_000), 'open');
});

test('S5: the agent timeline names the stale age and the API reports it', async () => {
  let fail = false;
  const cfg = feedCfg(() => (fail ? respond('x', { status: 500 }) : respond(THU9)));
  let now = WED_10AM;
  const s = await startServer({ config: cfg, now: () => now });
  try {
    await cfg.calendarFeed.ensureFresh(now);
    fail = true; now += 4 * 60_000;
    const cal1 = await (await fetch(s.base + '/api/calendar')).json();
    assert.deepEqual([cal1.calendar.connected, cal1.calendar.stale, cal1.calendar.staleMinutes, cal1.calendar.lastError], [true, true, 4, 'http_error']);
    const h = await (await fetch(s.base + '/api/health')).json();
    assert.deepEqual([h.calendar.connected, h.calendar.stale], [true, true]);
  } finally { await s.stop(); }
});

test('S6: dates beyond the range that was read are "not checked": never offered, never booked, never shown as checked', async () => {
  const cfg = feedCfg(() => respond(THU9));
  const s = await startServer({ config: cfg, now: makeClock(WED_10AM).now });
  try {
    await cfg.calendarFeed.ensureFresh(WED_10AM);
    assert.equal(slotStatus(cfg, '2027-06-01T10:00', WED_10AM), 'unchecked');
    assert.equal(slotStatus(cfg, '2026-12-10T10:00', WED_10AM), 'open');
    const far = await (await fetch(s.base + '/api/calendar?start=2027-06-01')).json();
    assert.ok(far.days.every((d) => d.checked === false));
    assert.ok(far.days.flatMap((d) => d.slots).every((x) => x.status === 'unchecked'));
    const near = await (await fetch(s.base + '/api/calendar')).json();
    assert.ok(near.days.every((d) => d.checked === true));
    const { Functions } = await import('../src/functions.js');
    const { classify } = await import('../src/safety.js');
    const { makeEnv, lead } = await import('./helpers.js');
    const env = makeEnv({ config: cfg, clock: makeClock(WED_10AM) });
    const { lead: l } = env.svc.createLead(lead(), { run: false });
    const f = new Functions({ store: env.store, config: cfg, now: env.clock.now, lead: l, flags: classify('', cfg.profile), step: () => {}, run: { startMs: WED_10AM } });
    await f.call('qualify_lead', { service: 'checkup', urgency: 'routine' });
    const out = await f.call('check_calendar', { days: 7, limit: 3, earliest_date: '2027-06-01' });
    assert.equal(out.slots.length, 0);
    const b = await f.call('book_appointment', { slot_id: '2027-06-01T10:00' });
    assert.equal(b.ok, false);
    assert.match(b.error, /not been checked/);
  } finally { await s.stop(); }
});

// ---- review 11: EXDATE bomb
const exLine = (n, step = 1) => 'EXDATE;TZID=America/Chicago:' + Array.from({ length: n }, (_, i) => { const d = new Date(Date.UTC(2013, 0, 1 + i * step)); return d.toISOString().slice(0, 10).replace(/-/g, '') + 'T090000'; }).join(',');
const bombEvent = (lines) => ev('b', 'DTSTART;TZID=America/Chicago:20130101T090000', 'DTEND;TZID=America/Chicago:20130101T100000', ['RRULE:FREQ=DAILY', ...lines]);

test('EXDATE bomb: 100k dates on one line and 40k over many lines parse in under a second', () => {
  for (const lines of [[exLine(100_000)], Array.from({ length: 400 }, (_, i) => exLine(100).replace(/2013/g, String(2014 + (i % 3))))]) {
    const t0 = Date.now();
    const out = parseIcs(cal(bombEvent(lines)), { tz: TZ, from: Date.UTC(2026, 10, 1), to: Date.UTC(2026, 10, 30) });
    assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0} ms`);
    assert.ok(out.blocks.length >= 28, 'over the cap the EXDATEs are ignored: the series blocks every day (never less)');
    if (lines.length > 1) assert.ok(out.stats.warnings >= 1);
  }
});

test('EXDATE under the cap still removes exactly those days, with many occurrences', () => {
  const t = cal(ev('x', 'DTSTART;TZID=America/Chicago:20200101T090000', 'DTEND;TZID=America/Chicago:20200101T100000', ['RRULE:FREQ=DAILY', 'EXDATE;TZID=America/Chicago:20261105T090000,20261106T090000', 'EXDATE;VALUE=DATE:20261107']));
  const s = starts(t, { tz: TZ, from: Date.UTC(2026, 10, 4), to: Date.UTC(2026, 10, 10) });
  assert.deepEqual(s, ['2026-11-04T09:00', '2026-11-08T09:00', '2026-11-09T09:00']);
});

test('an over-long line is dropped, not parsed', () => {
  const t = cal(ev('l', 'DTSTART:20261105T150000Z', 'DTEND:20261105T160000Z', ['DESCRIPTION:' + 'x'.repeat(500_000)]));
  assert.equal(parseIcs(t, WIN).blocks.length, 1);
});

// ---- review 11: hostile zone names only mark their own event
test('TZID=constructor / __proto__ / toString: only that event is flagged, the rest of the feed loads', async () => {
  for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', '__defineGetter__']) {
    const t = cal(
      ev('bad', `DTSTART;TZID=${name}:20261105T090000`, `DTEND;TZID=${name}:20261105T100000`),
      ev('good', 'DTSTART:20261106T150000Z', 'DTEND:20261106T160000Z'));
    const { blocks, stats } = parseIcs(t, WIN);
    assert.equal(stats.warnings, 1, name);
    assert.ok(blocks.some((b) => localString(b.start, TZ) === '2026-11-06T09:00'), `${name}: the good event still blocks`);
    assert.ok(blocks.some((b) => localString(b.start, TZ) === '2026-11-05T09:00'), `${name}: the odd event still blocks (business-zone reading)`);
  }
  const cfg = feedCfg(() => respond(cal(ev('bad', 'DTSTART;TZID=constructor:20261105T090000', 'DTEND;TZID=constructor:20261105T100000'))));
  await cfg.calendarFeed.ensureFresh(WED_10AM);
  const st = cfg.calendarFeed.status();
  assert.deepEqual([st.connected, st.lastError, st.warnings], [true, null, 1]);
});
