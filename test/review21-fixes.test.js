// Review 21 + probe 9: clock times with a weekday, deduped shown slots, thanks never books, bare-hour questions, same-day alternatives,
// insurance plus scheduling, unconfirmed model bookings, price for unlisted treatments.
import test from 'node:test';
import assert from 'node:assert/strict';
import { strictPick, asksOtherTime, requestedDay, bareHourOf } from '../src/extract.js';
import { shownSlots, timeProblem } from '../src/timecheck.js';
const O = { today: '2026-11-04', openOn: () => new Set(Array.from({ length: 10 }, (_, h) => `${String(h + 8).padStart(2, '0')}:00`)), anyOpen: () => true, nearest: () => [] };
import { checkOutboundRule } from '../src/guard.js';
import { makeEnv, newLead, say, agentTexts, fakeLlm, call, reply } from './helpers.js';

const TODAY = '2026-11-04';
const THU = ['2026-11-05T10:00', '2026-11-05T14:00', '2026-11-05T15:00'];

test('N1: a weekday with a clock time books only when that exact time was shown', () => {
  assert.equal(strictPick('Thursday at 10am', THU), THU[0]);
  assert.equal(strictPick('Thursday at 2', THU), THU[1]);
  for (const t of ['Thursday at 9am', 'Thursday at 4pm', 'Thursday at 11', 'Thursday 9:30', 'Thursday at 10:30']) assert.equal(strictPick(t, THU), null, t);
  assert.equal(strictPick('Thursday at 4pm', [THU[0]]), null);
});

test('N1: an unshown Thursday time is answered as "open, want me to book it?", never booked', async () => {
  const env = makeEnv();
  const l = await newLead(env, { message: 'Anything open Thursday afternoon?' });
  await say(env, l, 'Thursday at 4pm');
  assert.equal(env.store.bookingForLead(l.id), null);
  assert.match(agentTexts(l).at(-1), /Thursday at 4:00 PM is open\. Want me to book it\?/);
  await say(env, l, 'yes');
  assert.equal(env.store.bookingForLead(l.id)?.slot_id, '2026-11-05T16:00');
});

test('N2: one distinct shown time repeated by the model is still one time; a yes books it', () => {
  assert.deepEqual(shownSlots('I have Thu Nov 5 at 10:00 AM. Thursday at 10 AM works well. Shall I book Thursday at 10:00 AM?', O), ['2026-11-05T10:00']);
  assert.equal(strictPick('yes', [...new Set(['2026-11-05T10:00', '2026-11-05T10:00'])]), '2026-11-05T10:00');
});

test('N3: thanks, complaints and "first thing" are never a pick', () => {
  for (const t of ['thanks', 'thank you', 'ok thanks', 'second one is bad', 'first thing in the morning', 'the first one is too early', 'thx']) {
    assert.equal(strictPick(t, [THU[0]]), null, t);
    assert.equal(strictPick(t, THU), null, t);
  }
  for (const t of ['yes', 'ok', 'sure', 'yes please', 'that works', 'sounds good']) assert.equal(strictPick(t, [THU[0]]), THU[0], t);
});

test('N4: a bare hour is a question about another time', () => {
  for (const t of ['can you do 4 instead', 'how about 4', 'what about 3', 'could we do 11 instead?']) assert.ok(asksOtherTime(t, THU), t);
  assert.deepEqual(bareHourOf('how about 4'), { hour: 16, minute: 0 });
});

test('N4: a model that books a time the customer only asked about is rejected; the rules ask first', async () => {
  const env = makeEnv({ llm: fakeLlm([
    reply(call('qualify_lead', { service: 'checkup', urgency: 'routine' })),
    reply(call('check_calendar', { earliest_date: '2026-11-05', days: 2, limit: 6 })),
    reply(call('book_appointment', { slot_id: '2026-11-05T16:00' })),
    reply(call('send_reply', { text: 'You are booked for Thursday at 4:00 PM.' })),
  ]) });
  const l = await newLead(env, { message: 'Is Thursday at 4pm possible? It is for my daughter.' });
  assert.equal(env.store.bookingForLead(l.id), null);
  assert.ok(agentTexts(l).every((t) => !/booked for Thursday/i.test(t)), agentTexts(l).join('|'));
  assert.ok(env.agent.fallbackReasons()['tool_rejected:unconfirmed_booking'] >= 1);
});

test('N4: a model booking after an explicit request still works', async () => {
  const env = makeEnv({ llm: fakeLlm([
    reply(call('qualify_lead', { service: 'checkup', urgency: 'routine' })),
    reply(call('check_calendar', { earliest_date: '2026-11-05', days: 2, limit: 6 })),
    reply(call('book_appointment', { slot_id: '2026-11-05T09:00' })),
    reply(call('send_reply', { text: 'You are all set for Thursday at 9:00 AM.' })),
  ]) });
  const l = await newLead(env, { message: 'Please book me a cleaning Thursday at 9am. It is for my daughter.' });
  assert.equal(env.store.bookingForLead(l.id)?.slot_id, '2026-11-05T09:00');
});

test('N5: after a rejected time, the same day comes first (rules fallback)', async () => {
  const env = makeEnv();
  const l = await newLead(env, { message: 'Anything open Wednesday afternoon?' });
  await say(env, l, "the one at 2pm doesn't work");
  const t = agentTexts(l).at(-1);
  assert.match(t, /Wed, Nov 4/);
  assert.doesNotMatch(t, /2:00 PM-3:00 PM/);
  assert.doesNotMatch(t, /Thu, Nov 5/);
});

test('Live: insurance plus a scheduling ask answers the times, flags the insurance, and sends no owner alert', async () => {
  const sent = [];
  const env = makeEnv({ notifier: { alert: async (lead, a) => { sent.push(a); return { status: 'sent' }; } } });
  const l = await newLead(env, { message: 'Do you take Delta Dental insurance? Anything open Friday?' });
  await env.agent.settled();
  const t = agentTexts(l).at(-1);
  assert.match(t, /Fri, Nov 6/);
  assert.match(t, /insurance/i);
  assert.match(t, /teammate/i);
  assert.equal(l.status, 'replied');
  assert.match(l.confirmNeeded || '', /insurance/i);
  assert.equal(sent.length, 0);
});

test('Live: insurance alone is still a hand-off to a person', async () => {
  const env = makeEnv();
  const l = await newLead(env, { message: 'Do you take Delta Dental insurance?' });
  assert.equal(l.status, 'human');
});

test('L1/L2: "a week from Friday", "Thursday the 12", weekday/date mismatch', () => {
  assert.equal(requestedDay('a week from Friday', TODAY).date, '2026-11-13');
  assert.equal(requestedDay('Thursday the 12', TODAY).date, '2026-11-12');
  assert.equal(requestedDay('Thursday 11/6', TODAY), null);
});

test('L3: "not full", "quarter to ten", "1p" in model replies', () => {
  assert.deepEqual(shownSlots('Thursday at quarter to ten is open.', O), []);
  assert.deepEqual(shownSlots('Thursday at 1p works.', O), ['2026-11-05T13:00']);
  assert.equal(timeProblem('The calendar is not full on Thursday at 10 AM.', O), null);
});

test('L4: "I have held the 10 AM slot for you" is a booking claim', () => {
  assert.equal(checkOutboundRule('I have held the 10 AM slot for you.', { messages: [] }, { model: true, booked: false })?.id, 'booking_claim');
  assert.equal(checkOutboundRule('I can hold this spot for you. Want that?', { messages: [] }, { model: true, booked: false })?.id, undefined);
});

test('L5: no cleaning price for a root canal; a teammate confirms the cost', async () => {
  const env = makeEnv();
  const l = await newLead(env, { message: 'I need a root canal, anything Friday?' });
  const t = agentTexts(l).at(-1);
  assert.doesNotMatch(t, /\$\d/);
  assert.match(t, /teammate will confirm the cost/);
  assert.match(t, /Fri, Nov 6/);
  assert.ok(l.confirmNeeded);
});

test('L5: a requested Friday time that is taken lists Friday alternatives first, not Thursday', async () => {
  const env = makeEnv();
  const o = await newLead(env, { name: 'Other Person', message: 'Anything open Friday?' });
  await say(env, o, 'the first one');
  assert.equal(env.store.bookingForLead(o.id)?.slot_id, '2026-11-06T08:00');
  const l = await newLead(env, { message: 'Anything open Thursday?' });
  await say(env, l, 'Friday at 8am');
  const t = agentTexts(l).at(-1);
  assert.match(t, /Friday at 8:00 AM is already taken/);
  assert.match(t, /1\) Fri, Nov 6/);
  assert.doesNotMatch(t, /Thu, Nov 5/);
});
