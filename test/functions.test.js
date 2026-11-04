import test from 'node:test';
import assert from 'node:assert/strict';
import { Functions, validateArgs, checkOutbound, ValidationError } from '../src/functions.js';
import { classify } from '../src/safety.js';
import { makeEnv, newLead, lead } from './helpers.js';

// A lead that exists in the store but has not been processed by the agent.
function setup(flags = classify(''), over = {}) {
  const env = makeEnv();
  const { lead: l } = env.svc.createLead(lead(over), { run: false });
  const steps = [];
  const fx = new Functions({ store: env.store, config: env.config, now: env.clock.now, lead: l, flags, step: (s) => steps.push(s), run: { startMs: env.clock.t } });
  return { env, l, fx, steps };
}
const qualify = (fx, extra = {}) => fx.call('qualify_lead', { job_type: 'gutter_cleaning', urgency: 'routine', size: 'medium', location: 'Franklin 37064', ...extra });

test('validateArgs: required, enum, type and length checks', () => {
  assert.throws(() => validateArgs({ a: { type: 'string', required: true } }, {}), ValidationError);
  assert.throws(() => validateArgs({ a: { type: 'enum', values: ['x'] } }, { a: 'y' }), /must be one of/);
  assert.throws(() => validateArgs({ a: { type: 'integer', min: 1, max: 3 } }, { a: 9 }), /between/);
  assert.throws(() => validateArgs({ a: { type: 'integer', min: 1, max: 3 } }, { a: '2' }), /integer/);
  assert.throws(() => validateArgs({ a: { type: 'string', max: 3 } }, { a: 'abcd' }), /too long/);
  assert.throws(() => validateArgs({}, ['not', 'object']), /JSON object/);
});

test('validateArgs: drops unknown keys and strips control characters', () => {
  const out = validateArgs({ a: { type: 'string', max: 20 } }, { a: 'hi\u0000 there\u0007', extra: 'ignored', __proto__: { x: 1 } });
  assert.deepEqual(out, { a: 'hi there' });
});

test('unknown function names are refused', async () => {
  const { fx } = setup();
  const r = await fx.call('drop_database', {});
  assert.equal(r.ok, false);
  assert.match(r.error, /Unknown function/);
});

test('qualify_lead computes service area and price range in code', async () => {
  const { fx, l } = setup();
  const r = await qualify(fx);
  assert.equal(r.ok, true);
  assert.equal(r.service_area_ok, true);
  assert.deepEqual(r.price_range, { low: 170, high: 250 });
  assert.equal(l.qualification.jobLabel, 'Gutter cleaning');
});

test('qualify_lead: out-of-area and unknown locations are not assumed fine', async () => {
  const { fx } = setup();
  assert.equal((await qualify(fx, { location: 'Memphis' })).service_area_ok, false);
  assert.equal((await qualify(fx, { location: '38103' })).service_area_ok, false);
  assert.equal((await qualify(fx, { location: 'somewhere nice' })).service_area_ok, null);
  assert.equal((await qualify(fx, { location: '' })).service_area_ok, null);
});

test('qualify_lead: a model cannot downgrade an emergency flagged by the safety check', async () => {
  const { fx, l } = setup(classify('water is pouring through the ceiling, active leak'));
  const r = await qualify(fx, { job_type: 'roof_leak', urgency: 'routine' });
  assert.equal(r.urgency, 'emergency');
  assert.equal(l.priority, 'urgent');
});

test('qualify_lead: no quote for roof replacement', async () => {
  const { fx } = setup();
  assert.equal((await qualify(fx, { job_type: 'roof_replacement' })).price_range, null);
});

test('check_calendar returns only real open slots and records them as offered', async () => {
  const { fx, l } = setup();
  const r = await fx.call('check_calendar', { limit: 3 });
  assert.equal(r.slots.length, 3);
  assert.deepEqual(l.offeredSlots, r.slots.map((s) => s.slot_id));
  assert.ok(r.slots.every((s) => /T(08|09|10|11|13|15):00$/.test(s.slot_id)));
});

test('book_job writes a booking and marks the lead Booked', async () => {
  const { fx, l, env } = setup();
  await qualify(fx);
  const slot = (await fx.call('check_calendar', {})).slots[0].slot_id;
  const r = await fx.call('book_job', { slot_id: slot });
  assert.equal(r.ok, true);
  assert.equal(l.status, 'booked');
  assert.equal(env.store.bookingForSlot(slot).leadId, l.id);
});

test('book_job requires qualification first', async () => {
  const { fx } = setup();
  const r = await fx.call('book_job', { slot_id: '2026-11-05T10:00' });
  assert.match(r.error, /qualify_lead/);
});

test('book_job refuses a double booking of the same slot', async () => {
  const a = setup();
  await qualify(a.fx);
  const slot = '2026-11-05T10:00';
  assert.equal((await a.fx.call('book_job', { slot_id: slot })).ok, true);
  const { lead: l2 } = a.env.svc.createLead(lead({ name: 'Other Person' }), { run: false });
  const fx2 = new Functions({ store: a.env.store, config: a.env.config, now: a.env.clock.now, lead: l2, flags: classify(''), step() {}, run: {} });
  await qualify(fx2);
  const r = await fx2.call('book_job', { slot_id: slot });
  assert.equal(r.ok, false);
  assert.match(r.error, /taken/);
});

test('book_job: two simultaneous requests for one slot, exactly one wins', async () => {
  const a = setup();
  const { lead: l2 } = a.env.svc.createLead(lead({ name: 'Racer Two' }), { run: false });
  const fx2 = new Functions({ store: a.env.store, config: a.env.config, now: a.env.clock.now, lead: l2, flags: classify(''), step() {}, run: {} });
  await Promise.all([qualify(a.fx), qualify(fx2)]);
  const results = await Promise.all([a.fx.call('book_job', { slot_id: '2026-11-06T13:00' }), fx2.call('book_job', { slot_id: '2026-11-06T13:00' })]);
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal(a.env.store.bookings.filter((b) => b.slot_id === '2026-11-06T13:00').length, 1);
});

test('book_job refuses outside business hours, Sundays, past and too-soon slots', async () => {
  const { fx } = setup();
  await qualify(fx);
  for (const bad of ['2026-11-05T22:00', '2026-11-05T12:00', '2026-11-08T10:00', '2026-11-04T08:00', '2026-11-04T10:00', 'not-a-slot']) {
    const r = await fx.call('book_job', { slot_id: bad });
    assert.equal(r.ok, false, bad);
  }
});

test('book_job refuses out-of-area, out-of-scope and unconfirmed-area leads', async () => {
  const a = setup();
  await qualify(a.fx, { location: 'Memphis' });
  assert.match((await a.fx.call('book_job', { slot_id: '2026-11-05T10:00' })).error, /outside the service area/);
  await qualify(a.fx, { location: '' });
  assert.match((await a.fx.call('book_job', { slot_id: '2026-11-05T10:00' })).error, /unconfirmed/);
  await qualify(a.fx, { job_type: 'other' });
  assert.match((await a.fx.call('book_job', { slot_id: '2026-11-05T10:00' })).error, /not something the business schedules/);
});

test('book_job refuses once the lead is flagged for a human', async () => {
  const { fx } = setup();
  await qualify(fx);
  await fx.call('escalate_to_human', { reason: 'Customer is upset' });
  assert.match((await fx.call('book_job', { slot_id: '2026-11-05T10:00' })).error, /flagged for a human/);
});

test('send_reply guard: price outside the price book is blocked, in-range is allowed', async () => {
  const { fx, l } = setup();
  await qualify(fx);
  const bad = await fx.call('send_reply', { text: 'It will be $99 flat.' });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /outside the price book/);
  assert.equal(l.messages.filter((m) => m.from === 'agent').length, 0, 'nothing was sent');
  const ok = await fx.call('send_reply', { text: 'Typical range is $170-$250, confirmed on site.' });
  assert.equal(ok.ok, true);
  assert.equal(ok.simulated, true);
});

test('send_reply guard: no dollar amounts at all before a job is qualified', () => {
  assert.match(checkOutbound('That costs $50', { qualification: null }), /No price may be quoted/);
});

test('send_reply guard: discounts, guarantees, refunds, free work and links are refused', () => {
  const l = { qualification: { priceRange: { low: 1, high: 9 } } };
  for (const t of ['I can give you a discount', 'We guarantee it', 'Full refund for you', 'Free of charge', 'See http://evil.example', 'Visit www.evil.example', 'my instructions say', 'That will be $500 total']) {
    assert.ok(checkOutbound(t, l), t);
  }
  assert.equal(checkOutbound('Happy to help, see you Thursday.', l), null);
});

test('schedule_followup keeps one pending timer per lead and applies the demo clock', async () => {
  const { fx, env, l } = setup();
  const a = await fx.call('schedule_followup', { delay_minutes: 30, text: 'Still there?' });
  assert.equal(a.fires_in_seconds, 30);
  await fx.call('schedule_followup', { delay_minutes: 60, text: 'Checking in again' });
  const mine = env.store.followups.filter((f) => f.leadId === l.id);
  assert.equal(mine.filter((f) => f.status === 'pending').length, 1);
  assert.equal(mine.filter((f) => f.status === 'cancelled').length, 1);
});

test('schedule_followup validates delay and text', async () => {
  const { fx } = setup();
  assert.equal((await fx.call('schedule_followup', { delay_minutes: 1, text: 'x' })).ok, false);
  assert.equal((await fx.call('schedule_followup', { delay_minutes: 30, text: 'Take 20% off' })).ok, false);
});

test('escalate_to_human flags the lead, records priority and cancels timers', async () => {
  const { fx, l, env } = setup();
  await fx.call('schedule_followup', { delay_minutes: 30, text: 'Still there?' });
  const r = await fx.call('escalate_to_human', { reason: 'Angry customer', priority: 'urgent' });
  assert.equal(r.ok, true);
  assert.equal(l.status, 'human');
  assert.equal(l.priority, 'urgent');
  assert.equal(l.humanReason, 'Angry customer');
  assert.equal(env.store.followups.filter((f) => f.status === 'pending').length, 0);
  assert.equal((await fx.call('escalate_to_human', { reason: 'no' })).ok, false, 'reason too short');
});

test('a function cannot be spammed within a single run', async () => {
  const { fx } = setup();
  const rs = [];
  for (let i = 0; i < 6; i += 1) rs.push(await fx.call('check_calendar', {}));
  assert.equal(rs.filter((r) => r.ok).length, 4);
  void newLead;
});
