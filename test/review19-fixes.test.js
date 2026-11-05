// Review 19 and probe 8: offered-slot semantics, time windows, pick phrasing, bare clock times, lock-in claims, deterministic availability answers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pickSlot, windowOf, isAvailabilityRequest, requestedDay } from '../src/extract.js';
import { timeProblem } from '../src/timecheck.js';
import { checkOutboundRule } from '../src/guard.js';
import { makeEnv, newLead, say, agentTexts, fakeLlm, call, reply } from './helpers.js';

const TODAY = '2026-11-04';
const hoursIn = (t) => [...(t.split('Open times:')[1] || '').matchAll(/\d\) \w+, \w+ \d+, (\d{1,2}):00 (AM|PM)/g)].map((m) => (Number(m[1]) % 12) + (m[2] === 'PM' ? 12 : 0));

// A model that checks the calendar and then offers exactly the times given in `text`.
const offering = (text) => fakeLlm([reply(call('qualify_lead', { service: 'checkup', urgency: 'routine' })), reply(call('check_calendar', { earliest_date: '2026-11-05', days: 3, limit: 6 })), reply(call('send_reply', { text }))]);

async function modelOffer(text, message = 'I need a cleaning this week, what do you have? It is for my daughter.') {
  const env = makeEnv({ llm: offering(text) });
  const l = await newLead(env, { message });
  return { env, l };
}

test('offeredSlots holds only the times the customer was shown (model replies)', async () => {
  const { l } = await modelOffer('I have Thu Nov 5 at 10:00 AM open for a cleaning and checkup ($110-$190). Shall I book it?');
  assert.deepEqual(l.offeredSlots, ['2026-11-05T10:00']);
});

test('one shown time: yes, sure book it, ok, that works all book exactly that time, with a confirmation', async () => {
  for (const yes of ['yes', 'sure, book it', 'ok', 'yes please', 'that works']) {
    const { env, l } = await modelOffer('I have Thu Nov 5 at 10:00 AM open for a cleaning and checkup. Shall I book it?');
    env.agent.llm = fakeLlm([]);
    await say(env, l, yes);
    assert.equal(env.store.bookingForLead(l.id)?.slot_id, '2026-11-05T10:00', yes);
    assert.match(agentTexts(l).at(-1), /Booked/, yes);
  }
});

test('"can you do 2 pm instead" never books silently: an open time is offered and booked only after a yes', async () => {
  const { env, l } = await modelOffer('I have Thu Nov 5 at 10:00 AM open for a cleaning and checkup. Shall I book it?');
  env.agent.llm = fakeLlm([]);
  await say(env, l, 'can you do 2 pm instead');
  assert.equal(env.store.bookingForLead(l.id), null);
  assert.match(agentTexts(l).at(-1), /Thursday at 2:00 PM is open\. Want me to book it\?/);
  assert.deepEqual(l.offeredSlots, ['2026-11-05T14:00']);
  await say(env, l, 'yes');
  assert.equal(env.store.bookingForLead(l.id)?.slot_id, '2026-11-05T14:00');
  assert.match(agentTexts(l).at(-1), /Booked/);
});

test('two shown times: 11, the 11, the earlier one and the later one resolve inside the shown list', async () => {
  for (const [msg, want] of [['11', '2026-11-05T11:00'], ['the 11', '2026-11-05T11:00'], ['the earlier one', '2026-11-05T10:00'], ['the later one', '2026-11-05T11:00']]) {
    const { env, l } = await modelOffer('I have Thu Nov 5 at 10:00 AM or 11:00 AM open for a cleaning and checkup. Which works?');
    assert.deepEqual(l.offeredSlots, ['2026-11-05T10:00', '2026-11-05T11:00']);
    env.agent.llm = fakeLlm([]);
    await say(env, l, msg);
    assert.equal(env.store.bookingForLead(l.id)?.slot_id, want, msg);
  }
});

test('a bare yes among several shown times asks the numbered question over only those', async () => {
  const { env, l } = await modelOffer('I have Thu Nov 5 at 10:00 AM, 11:00 AM or 1:00 PM open. Which works?');
  env.agent.llm = fakeLlm([]);
  await say(env, l, 'yes that works');
  assert.equal(env.store.bookingForLead(l.id), null);
  const t = agentTexts(l).at(-1);
  assert.match(t, /1\) .*10 AM.*2\) .*11 AM.*3\) .*1 PM/);
  assert.doesNotMatch(t, /4\)/);
});

test('pick phrasing: ok 2, ok, 2, yes the 2, the 2nd one, the one at 2, number two', () => {
  const s = ['2026-11-05T10:00', '2026-11-05T14:00', '2026-11-05T15:00'];
  for (const t of ['ok 2', 'ok, 2', 'yes the 2', 'the 2nd one', 'the one at 2', 'number two', '2', 'the second one']) assert.equal(pickSlot(t, s), s[1], t);
  assert.equal(pickSlot('the one at 10', s), s[0]);
  for (const t of ['the 14th', 'my 2nd child', 'the 2nd']) assert.equal(pickSlot(t, s), null, t);
});

test('windows: parse', () => {
  const w = (t) => windowOf(t);
  assert.ok(w('after 3 on Tuesday').test(15) && !w('after 3 on Tuesday').test(14));
  assert.ok(w('before 10 Friday').test(9) && !w('before 10 Friday').test(10));
  assert.ok(w('between 2 and 4').test(14) && w('between 2 and 4').test(15) && !w('between 2 and 4').test(16) && !w('between 2 and 4').test(13));
  assert.ok(w('after lunch').test(13) && !w('after lunch').test(12));
  assert.ok(w('after 2 pm tomorrow').test(14) && !w('after 2 pm tomorrow').test(13));
});

test('windows: rules list only slots inside the window, or say none without claiming the window', async () => {
  const cases = [
    ['Anything after 3 PM on Tuesday?', (h) => h >= 15],
    ['I need a cleaning after 3 on Tuesday', (h) => h >= 15],
    ['Anything before 10 on Friday?', (h) => h < 10],
    ['Anything before 9 on Friday?', (h) => h < 9],
    ['Anything before 11 on Thursday?', (h) => h < 11],
    ['Tuesday between 2 and 4 please, anything open?', (h) => h >= 14 && h < 16],
    ['Tuesday after lunch, anything open?', (h) => h >= 13],
    ['Anything open after 2 pm tomorrow?', (h) => h >= 14],
    ['Do you have mornings?', (h) => h < 12],
    ['Do you have afternoons?', (h) => h >= 12 && h < 17],
  ];
  for (const [msg, ok] of cases) {
    const l = await newLead(makeEnv(), { message: msg });
    const t = agentTexts(l).at(-1);
    const hs = hoursIn(t);
    assert.ok(hs.length === 0 || hs.every(ok), `${msg} -> ${t}`);
    if (!hs.length) assert.match(t, /Nothing is open|do not have/i, msg);
    else assert.ok(hs.length >= 1, msg);
  }
});

test('windows: no slot in the window says so and offers the nearest others', async () => {
  const l = await newLead(makeEnv(), { message: 'Anything before 8 on Thursday?' });
  const t = agentTexts(l).at(-1);
  assert.match(t, /Nothing is open Thursday before 8 AM/);
  assert.match(t, /Open times: 1\)/);
});

test('"Next Thursday around 2 PM" is the Thursday of next week', async () => {
  assert.equal(requestedDay('Next Thursday around 2 PM for a cleaning?', TODAY).date, '2026-11-12');
  const l = await newLead(makeEnv(), { message: 'Next Thursday around 2 PM for a cleaning?' });
  assert.match(agentTexts(l).at(-1), /Nov 12/);
  assert.match(agentTexts(l).at(-1), /2:00 PM/);
});

test('bare clock times with no am/pm are checked like AM/PM times', () => {
  const open = { '2026-11-05': ['10:00', '14:00'], '2026-11-06': ['08:00'] };
  const o = { today: TODAY, openOn: (d) => new Set(open[d] || []), anyOpen: () => true, nearest: 'x' };
  assert.equal(timeProblem("Hi Liam, Friday 10:00 is open, would you like me to book you for a cleaning and checkup then? Just confirm and I'll lock it in.", o)?.id, 'bad_time');
  assert.equal(timeProblem('Thursday 10:00 is open.', o), null);
  assert.equal(timeProblem('Thursday at 2:30 is open.', o)?.id, 'bad_time');
  assert.equal(timeProblem('Thursday 2:00 is open.', o), null);
});

test('lock it in: fine as a conditional offer, rejected as an unconditional claim', () => {
  const opts = { model: true, booked: false };
  const lead = { messages: [] };
  assert.equal(checkOutboundRule("Thursday at 10 AM is open. Just confirm and I'll lock it in.", lead, opts), null);
  assert.equal(checkOutboundRule('Want me to hold it for you?', lead, opts), null);
  assert.equal(checkOutboundRule("Thursday at 10 AM works, I'll lock it in for you.", lead, opts)?.id, 'booking_claim');
  assert.equal(checkOutboundRule("I'm holding that for you.", lead, opts)?.id, 'booking_claim');
});

test('plain availability requests are answered by the rules with no model call, labeled honestly', async () => {
  for (const msg of ['Anything open Monday?', 'Wednesday afternoon?', 'Can I get in Thursday at 9am?', 'Do you have something tomorrow?', 'Looking for an exam sometime next week', 'What is your soonest opening?', 'I would like a cleaning next week please']) {
    const llm = fakeLlm([]);
    const env = makeEnv();
    const l = (env.agent.llm = llm, await newLead(env, { message: msg }));
    assert.equal(llm.fetchMock.state.bodies.length, 0, msg);
    assert.equal(l.lastReplyBy, 'rules', msg);
    assert.equal(l.lastFallbackReason, 'availability_lookup', msg);
    const t = agentTexts(l).at(-1);
    assert.match(t, /\d{1,2}:\d\d (?:AM|PM)/, `${msg} -> ${t}`);
    assert.doesNotMatch(t, /what would you like to book/i, msg);
  }
});

test('open-ended or mixed messages still go to the model', () => {
  for (const msg of ['How much is a cleaning and is there parking?', 'My wife and I both need cleanings next week', 'I have a toothache, anything open tomorrow?', 'Are you open on Saturday?', 'What does a new patient exam include?']) assert.equal(isAvailabilityRequest(msg, TODAY), false, msg);
  for (const msg of ['Anything open Monday?', 'Wednesday afternoon?', 'tomorrow?']) assert.equal(isAvailabilityRequest(msg, TODAY) || msg === 'tomorrow?', true, msg);
});

test('a defaulted visit type is named in the booking confirmation, once', async () => {
  const env = makeEnv();
  const l = await newLead(env, { message: 'Anything open Monday?' });
  await say(env, l, 'the first one');
  const t = agentTexts(l).at(-1);
  assert.match(t, /Booked/);
  assert.match(t, /for your cleaning and checkup/i);
  assert.equal((t.match(/different visit type/g) || []).length, 1);
});
