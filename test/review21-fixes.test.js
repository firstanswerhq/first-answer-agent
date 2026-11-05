// Review 21 + probe 9: clock times with a weekday, deduped shown slots, thanks never books, bare-hour questions, same-day alternatives,
// insurance plus scheduling, unconfirmed model bookings, price for unlisted treatments.
import test from 'node:test';
import assert from 'node:assert/strict';
import { strictPick, asksOtherTime, requestedDay, bareHourOf } from '../src/extract.js';
import { shownSlots, timeProblem } from '../src/timecheck.js';
const O = { today: '2026-11-04', openOn: () => new Set(Array.from({ length: 10 }, (_, h) => `${String(h + 8).padStart(2, '0')}:00`)), anyOpen: () => true, nearest: () => [] };
import { checkOutboundRule } from '../src/guard.js';
import { Notifier } from '../src/notify.js';
import { Agent } from '../src/agent.js';
import { LeadService } from '../src/service.js';
import { Store } from '../src/store.js';
import { cfgFor, makeClock, WED_10AM, lead as leadInput } from './helpers.js';
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

test('Live: insurance alone says a teammate will confirm, is flagged, and sends no owner alert', async () => {
  const sent = [];
  const env = makeEnv({ notifier: { alert: async (lead, a) => { sent.push(a); return { status: 'sent' }; } } });
  const l = await newLead(env, { message: 'Do you take Delta Dental insurance?' });
  await env.agent.settled();
  assert.match(agentTexts(l).at(-1), /teammate there will confirm/);
  assert.match(l.confirmNeeded || '', /insurance/i);
  assert.equal(sent.length, 0);
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

// A real Notifier with a counting transport: it WOULD record an alert if one were sent (the angry-customer case proves that).
function alertEnv() {
  const calls = [];
  const transport = async (url, opts) => { calls.push({ url, opts }); return { ok: true, status: 200 }; };
  const clock = makeClock(WED_10AM, 5);
  const store = new Store();
  const config = cfgFor();
  const notifier = new Notifier({ now: clock.now, log: () => {}, topic: 't', transport });
  const agent = new Agent({ store, config, llm: null, now: clock.now, notifier });
  const svc = new LeadService({ store, agent, config, now: clock.now });
  const run = async (message) => { const { lead, done } = svc.createLead(leadInput({ message }), {}); await done; await agent.settled(); return lead; };
  return { calls, run };
}

test('M3: the alert harness is not vacuous (an angry customer does alert)', async () => {
  const { calls, run } = alertEnv();
  await run('This is the THIRD time I have called and I want a refund!!!');
  assert.equal(calls.length, 1);
});

test('M3/M2: insurance and payment-fact questions flag a teammate and never alert (real Notifier)', async () => {
  for (const m of ['Do you take Delta Dental insurance?', 'Do you take Delta Dental insurance? Anything open Friday?', 'What forms of payment do you accept?', 'Do you offer payment plans or financing?', 'Do you take cash or cards?', 'Is there a warranty on your work?', 'Do you have a sliding scale?']) {
    const { calls, run } = alertEnv();
    const l = await run(m);
    assert.equal(calls.length, 0, m);
    assert.ok(l.confirmNeeded, m);
    assert.equal(l.status, 'replied', m);
    assert.match(agentTexts(l).at(-1), /teammate/, m);
  }
  const { calls, run } = alertEnv();
  const l = await run('What forms of payment do you accept? Anything open Friday?');
  assert.match(agentTexts(l).at(-1), /Fri, Nov 6/);
  assert.equal(calls.length, 0);
});

test('H1: strictPick is an allowlist over the whole message (curly apostrophes, missing apostrophes, verbs, conditionals)', () => {
  const bad = ['2 pm doesn\u2019t work', '2 pm doesnt work', '2 pm wont work', 'cant do 2 pm', 'cant make 2 pm', 'dont book 2 pm', 'dont do 2 pm', 'cannot do 2 pm', 'impossible at 2 pm', '2 pm unavailable', '2 pm is booked', '2 pm is taken', '2 pm is busy', '2 pm conflicts', '2 pm clashes', 'I have work at 2 pm', '2 pm is out', 'neither 2 pm', '2 pm is a problem', 'skip 2 pm', 'skip the first one', 'pass on 2 pm', 'avoid 2 pm', 'forget the first one', 'ignore the first one', 'first one out', 'the first one doesnt work for me', 'first one isnt available to me', '2 pm unless it rains', '2 pm only if you take insurance', 'I can do Thursday at 10 if my ride shows', '2 pm if possible', '2 pm maybe', '2 pm I guess', 'wrong, 2 pm'];
  for (const t of bad) { assert.equal(strictPick(t, THU), null, t); assert.equal(strictPick(t, [THU[1]]), null, t); }
  for (const [t, w] of [['the one at 2', THU[1]], ['ok 2', THU[1]], ['the second one, please', THU[1]], ['the earliest', THU[0]], ['2 pm', THU[1]], ['3', THU[2]], ['Thursday at 2', THU[1]]]) assert.equal(strictPick(t, THU), w, t);
});

test('H1: a refused time is never booked end to end', async () => {
  for (const msg of ['2 pm doesn\u2019t work', '2 pm wont work', 'skip the first one', '2 pm unless it rains']) {
    const env = makeEnv();
    const l = await newLead(env, { message: 'Anything open Thursday?' });
    await say(env, l, msg);
    assert.equal(env.store.bookingForLead(l.id), null, msg);
  }
});

test('M1: polite yeses book the one shown time; bare thanks does not', () => {
  for (const t of ['yes thank you', 'Yes, thank you!', 'yes thanks', 'Yes, that works for me', 'That works, thanks', 'perfect thanks', 'sounds great', 'that would be great', 'Yes that is fine', "that's fine", 'yes that time works', 'Yes, book me please', 'Ok, book that for me', 'book me in', 'See you then', 'sounds good see you then', 'great, thanks', 'Awesome', 'Yes let\u2019s do it', 'confirm']) assert.equal(strictPick(t, [THU[0]]), THU[0], t);
  for (const t of ['thanks', 'thank you', 'ok thanks', 'please']) assert.equal(strictPick(t, [THU[0]]), null, t);
});

test('LOW: explicit booking requests book an open exact time; "Book it" first with nothing offered does not', async () => {
  for (const msg of ['Please book me Thursday at 9am', 'Book me Friday at 8am', 'Thursday 9am works for me, go ahead and book']) {
    const env = makeEnv();
    const l = await newLead(env, { message: msg });
    assert.ok(env.store.bookingForLead(l.id), msg);
  }
  const env = makeEnv();
  const l = await newLead(env, { message: 'Book it' });
  assert.equal(env.store.bookingForLead(l.id), null);
});

test('LOW: a taken Friday time lists Friday times; when none are left it says so honestly', async () => {
  const env = makeEnv();
  for (let i = 0; i < 4; i += 1) { const o = await newLead(env, { name: `P${i} Test`, phone: `(615) 555-01${10 + i}`, message: 'Anything open Friday?' }); await say(env, o, 'the first one'); }
  const l = await newLead(env, { message: 'Anything open Thursday?' });
  await say(env, l, 'Friday at 8am');
  const t = agentTexts(l).at(-1);
  assert.match(t, /Friday at 8:00 AM is already taken\. Nothing else is open on Friday, so here are the nearest times on other days\./);
  assert.doesNotMatch(t, /1\) Fri/);
});
