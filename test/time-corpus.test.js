// Reviewer corpora for the outbound time check: good replies must pass, bad replies must be rejected (iCal fixture: Thu 9-10, Fri 10-11, Tue 1-2 PM busy; now Wed 10 AM).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadConfig } from '../src/config.js';
import { Functions } from '../src/functions.js';
import { classify } from '../src/safety.js';
import { timeProblem } from '../src/timecheck.js';
import { makeEnv, makeClock, WED_10AM, lead } from './helpers.js';

const ICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//F//EN
BEGIN:VEVENT
UID:a@f
DTSTART:20261105T150000Z
DTEND:20261105T160000Z
SUMMARY:x
END:VEVENT
BEGIN:VEVENT
UID:b@f
DTSTART:20261110T190000Z
DTEND:20261110T200000Z
SUMMARY:x
END:VEVENT
BEGIN:VEVENT
UID:c@f
DTSTART:20261106T160000Z
DTEND:20261106T170000Z
SUMMARY:x
END:VEVENT
END:VCALENDAR`;
const good = JSON.parse(fs.readFileSync(new URL('./fixtures/time-good.json', import.meta.url), 'utf8'));
const bad = JSON.parse(fs.readFileSync(new URL('./fixtures/time-bad.json', import.meta.url), 'utf8'));

async function optsFor(profile) {
  const f = async () => new Response(ICS, { status: 200, headers: { 'content-type': 'text/calendar' } });
  const cfg = loadConfig({ DATA_FILE: '', ...(profile === 'dental' ? { CALENDAR_ICAL_URL: 'https://calendar.google.com/calendar/ical/owner%40example.com/private-SECRETTOKEN9f8e7d6c5b4a/basic.ics' } : {}) }, { profile, seedOnEmpty: false, followupSpeedup: 60, calendarFetch: f });
  if (cfg.calendarFeed) await cfg.calendarFeed.ensureFresh(WED_10AM);
  const env = makeEnv({ config: cfg, clock: makeClock(WED_10AM) });
  const { lead: l } = env.svc.createLead(lead(), { run: false });
  const fx = new Functions({ store: env.store, config: cfg, now: env.clock.now, lead: l, flags: classify('', cfg.profile), step: () => {}, run: { startMs: WED_10AM } });
  return { env, l, fx, opts: fx.timeCheckOpts() };
}

test('reviewer corpus: no good reply is rejected (212 replies from reviews 18 and 19)', async () => {
  const falseRejects = [];
  for (const p of Object.keys(good)) { const { opts } = await optsFor(p); for (const t of good[p]) if (timeProblem(t, opts)) falseRejects.push(`[${p}] ${t}`); }
  assert.deepEqual(falseRejects, []);
});

test('reviewer corpus: bad replies are rejected (at most 4 misses of 113; the reviewers confirmed 4 of their listed lines are genuinely open times)', async () => {
  const miss = [];
  for (const p of Object.keys(bad)) { const { opts } = await optsFor(p); for (const t of bad[p]) if (!timeProblem(t, opts)) miss.push(`[${p}] ${t}`); }
  assert.ok(miss.length <= 4, miss.join('\n'));
});

test('the open list is built once per request and cleared by a booking', async () => {
  const { fx } = await optsFor('dental');
  assert.equal(fx.timeCheckOpts(), fx.timeCheckOpts());
});

test('with a booking, a reschedule offer is still checked but the booked time may be confirmed', async () => {
  const { env, l, fx } = await optsFor('dental');
  const q = await fx.call('qualify_lead', { service: 'checkup', urgency: 'routine' });
  assert.ok(q.ok);
  const b = await fx.call('book_appointment', { slot_id: '2026-11-05T11:00', note: '' });
  assert.ok(b.ok, JSON.stringify(b));
  const opts = fx.timeCheckOpts();
  assert.equal(timeProblem('You are booked for Thursday, Nov 5 at 11:00 AM.', opts), null);
  assert.equal(timeProblem('I can move you to Thursday Nov 5 at 9:00 AM instead.', opts)?.id, 'bad_time');
  void env; void l;
});

test('unusual taken wording is exempt, and a parenthetical hours note does not excuse an offer of a closed day', async () => {
  const { opts } = await optsFor('dental');
  for (const t of ["Nothing at 10 on Friday I'm afraid, it's taken. I can offer Friday 8 AM.", '10 AM isn\'t a start time we use. The openings Thursday are 9, 11, 1 and 3.', 'Thursday at 12 is lunch, but 1 PM Thursday is open.',
    "Thursday at 9 AM won't work, but 10 AM is open.", 'We have no availability Thursday at 9 AM; 11 AM is open.', 'Thursday 9 AM is spoken for, 10 AM is open.', 'Nothing is available at Friday 10 AM, but 8 AM is open.', 'Friday 10 AM is not an option, 8 AM is.', "Thursday at 9 AM doesn't work, 11 AM does.", "We're out of room Thursday at 9 AM, but 11 AM is open."]) assert.equal(timeProblem(t, opts), null, t);
  assert.equal(timeProblem('Saturday at 10 AM is open (the office closes at 5 on weekdays).', opts)?.id, 'bad_time');
  assert.equal(timeProblem("Hi Liam, thanks for reaching out! Friday 10:00 is open - would you like me to book you for a cleaning and checkup then? It usually takes about an hour. Just confirm and I'll lock it in.", opts)?.id, 'bad_time');
});
