// Review 20: strict picks, whitelist availability path, window units, date-by-ordinal, abbreviations, list numbers, arrival times, narrower lock-in guard.
import test from 'node:test';
import assert from 'node:assert/strict';
import { strictPick, pickSlot, isAvailabilityRequest, windowOf, requestedDay } from '../src/extract.js';
import { timeProblem, shownSlots } from '../src/timecheck.js';
import { checkOutboundRule } from '../src/guard.js';
import { makeEnv, makeClock, WED_10AM, newLead, say, agentTexts, fakeLlm, call, reply } from './helpers.js';

const TODAY = '2026-11-04';
const SERVICE_WORDS = ['cleaning', 'checkup', 'exam', 'new', 'patient'];
const SLOTS = ['2026-11-05T10:00', '2026-11-05T14:00', '2026-11-05T15:00'];

test('H2: only a whole-message pick books; negations, extra clauses and other people do not', () => {
  for (const t of ['the one at 2 doesn\'t work', 'not that one', 'anything but 2 pm', 'can\'t do the first one', 'yes and how much', 'yes but my son also needs one', 'for my wife', 'cancel', 'I want 2 appointments', 'take 3 people', 'no 2', 'yes please cancel it', 'ok book it for my wife', 'Thursday', 'Thursday?']) {
    assert.equal(strictPick(t, SLOTS), null, t);
    assert.equal(strictPick(t, [SLOTS[0]]), null, t);
  }
  for (const [t, want] of [['the one at 2', SLOTS[1]], ['ok 2', SLOTS[1]], ['the second one, please', SLOTS[1]], ['the earliest', SLOTS[0]], ['2 pm', SLOTS[1]], ['3', SLOTS[2]]]) assert.equal(strictPick(t, SLOTS), want, t);
  for (const t of ['yes', 'sure, book it', 'ok', 'that works', 'yes please', 'book it']) assert.equal(strictPick(t, [SLOTS[0]]), SLOTS[0], t);
  assert.equal(strictPick('sure, 2', [SLOTS[0]]), null);
  assert.equal(strictPick('yes', SLOTS), null); // several shown: the caller asks which
});

test('pickSlot never throws on non-strings, and "no 2" is not option 2', () => {
  for (const v of [null, undefined, 123, {}, []]) assert.equal(pickSlot(v, SLOTS), null);
  assert.equal(pickSlot('no 2', SLOTS), null);
});

test('H1: with one shown time, refusals, family and price questions do not book; the model gets them', async () => {
  for (const msg of ['not that one', 'yes and how much is it', 'yes but my son also needs one', 'ok book it for my wife', 'yes please cancel it']) {
    const env = makeEnv({ llm: fakeLlm([reply(call('qualify_lead', { service: 'checkup', urgency: 'routine' })), reply(call('check_calendar', { earliest_date: '2026-11-05', days: 3, limit: 6 })), reply(call('send_reply', { text: 'I have Thu Nov 5 at 10:00 AM open for a cleaning and checkup. Shall I book it?' }))]) });
    const l = await newLead(env, { message: 'I need a cleaning this week. It is for my daughter.' });
    const llm2 = fakeLlm([]);
    env.agent.llm = llm2;
    await say(env, l, msg);
    assert.equal(env.store.bookingForLead(l.id), null, msg);
  }
});

test('H1: a day alone after an offer lists that day, it does not book', async () => {
  const env = makeEnv();
  const l = await newLead(env, { message: 'Anything open Wednesday afternoon?' });
  await say(env, l, 'Thursday?');
  assert.equal(env.store.bookingForLead(l.id), null);
  assert.match(agentTexts(l).at(-1), /Thu, Nov 5/);
});

test('H3: the availability shortcut is a whitelist; any other content word goes to the model', () => {
  const no = ['Can I get in tomorrow, my tooth is killing me', 'tomorrow, I chipped a tooth', 'my crown fell off, can I come Friday', 'lost a filling, anything open tomorrow?', 'I want to book a root canal Friday', 'Friday, it is for dentures', 'Anything tomorrow for an extraction?', 'Friday morning, I am nervous and need sedation', 'I am pregnant, anything Friday?', 'anything friday? i take blood thinners', 'Tomorrow? I am allergic to latex', 'Friday, is there a wheelchair ramp?', 'Thursday, can I bring my service dog?', 'next week, I only have Medicaid', 'Anything open tomorrow for my mom and me', 'I would like an appointment next week for the baby', 'do you have anything tomorrow? Also can you text me', 'Thursday at 3 for a color', 'Anything open tomorrow? The IRS froze my bank account', 'Friday - we got a levy notice', 'Thursday, can you do payroll too', 'Anything tomorrow? I had a bad reaction to the last color', 'Are you open on Saturday?', 'Saturday or Sunday?', 'Monday through Wednesday?', 'Friday after work?', 'Anything open before my flight Friday?', 'I will be back in town after 3 weeks, anything open?'];
  for (const m of no) assert.equal(isAvailabilityRequest(m, TODAY, SERVICE_WORDS), false, m);
  for (const m of ['Anything open Monday?', 'Wednesday afternoon?', 'tomorrow?', 'Thursday at 9am', 'Looking for an exam sometime next week', 'I would like a cleaning next week please', 'What is your soonest opening?', 'Anything after 3 PM on Tuesday?']) assert.equal(isAvailabilityRequest(m, TODAY, SERVICE_WORDS), true, m);
});

test('H4: "after 3 weeks" and other units are not clock windows', () => {
  for (const t of ['after 3 weeks', 'after 10 days', 'before 3 months', 'after 2 visits', 'after 5 minutes', 'after 2 weeks']) assert.equal(windowOf(t), null, t);
  assert.ok(windowOf('after 3 pm'));
});

test('H5: "Thursday the 12th" resolves by date; a weekday that does not match the date is not guessed', () => {
  assert.equal(requestedDay('Anything open Thursday the 12th?', TODAY).date, '2026-11-12');
  assert.equal(requestedDay('Monday the 10th?', TODAY), null);
});

const open = { '2026-11-05': ['08:00', '10:00', '11:00', '14:00'], '2026-11-06': ['08:00'] };
const o = { today: TODAY, openOn: (d) => new Set(open[d] || []), anyOpen: (hm) => Object.values(open).some((a) => a.includes(hm)), nearest: 'x' };

test('M1: abbreviations with periods keep their day; numeric dates resolve', () => {
  for (const t of ['Thurs. at 1 PM is open', 'Fri. at 2:00 PM works', 'Thu, Nov. 5 at 1:00 PM is open', '11/5 at 1pm is open', 'Sept. 3 at 1 PM is open']) assert.equal(timeProblem(t, o)?.id, 'bad_time', t);
  for (const t of ['Thurs. at 10 AM is open', 'Thu, Nov. 5 at 11:00 AM is open', '11/5 at 2pm is open']) assert.equal(timeProblem(t, o), null, t);
});

test('M2: "open at", by text, through a link, bare numbers in lists, spelled minutes and midday are checked', () => {
  for (const t of ['Thursday is open at 12 PM.', 'We are open at 12 PM on Thursday.', 'I can book you for Thursday at 12 PM by text if you like.', 'Thursday at 12 PM through our online link works.', 'Thursday at 10 works, or 12.', 'Friday at 9 and 12 are open.', 'Thursday: 10, 11 or 12.', 'Thursday morning: 8, 9, 10, 11 or 12.', 'Thursday at 10 and also 1.', 'Thursday at nine thirty works.', 'Friday at midday.', 'Thursday midnight.']) assert.equal(timeProblem(t, o)?.id, 'bad_time', t);
  for (const t of ['Reply by 5 PM to hold Thursday at 10 AM.', 'We open at 8 AM and close at 5 PM.', 'Thursday: 10, 11 or 2.']) assert.equal(timeProblem(t, o), null, t);
});

test('M3: arrival and finish times are not offers; the lock-in guard is narrow', () => {
  for (const t of ['Thursday 10:00 AM is open. Please arrive at 9:45 AM.', 'Thursday 10:00 AM is open. Come in 15 minutes early (9:45 AM) to fill out forms.', 'Please arrive about 10 minutes early, around 9:45 AM, for your Thursday 10 AM visit.', 'Thursday at 11:00 AM is open, finishing around 12:15 PM.']) assert.equal(timeProblem(t, o), null, t);
  const opts = { model: true, booked: false };
  const lead = { messages: [] };
  for (const t of ['Please reserve your spot by replying yes.', 'You can reserve your appointment by texting us.', 'Tax season fills up, so reserve your time soon.', 'I can hold this spot for you. Want that?', 'We will hold your documents securely.', 'Please hold your questions for the appointment.']) assert.equal(checkOutboundRule(t, lead, opts), null, t);
  for (const t of ["I'll lock it in for you.", "I'm holding that for you.", "I've reserved that time for you.", 'Your slot is held.']) assert.equal(checkOutboundRule(t, lead, opts)?.id, 'booking_claim', t);
});

test('M4: an offer with a hedge still records the shown slot', () => {
  const s = shownSlots('Thursday at 10 AM is open (we are here until 5 PM). Shall I book it?', o);
  assert.deepEqual(s, ['2026-11-05T10:00']);
});

test('M5: "how about 9" with offers on several days asks which day', async () => {
  const env = makeEnv();
  const l = await newLead(env, { message: 'Anything open this week?' });
  l.offeredSlots = ['2026-11-05T10:00', '2026-11-06T08:00', '2026-11-09T08:00'];
  await say(env, l, 'how about 9 am instead');
  assert.equal(env.store.bookingForLead(l.id), null);
  assert.match(agentTexts(l).at(-1), /Which day did you mean/);
});

test('labels: availability lookups and picks are counted as rule-handled, not as fallbacks', async () => {
  const env = makeEnv({ clock: makeClock(WED_10AM, 1000) });
  const l = await newLead(env, { message: 'Anything open Monday?' });
  await say(env, l, 'the first one');
  assert.deepEqual(env.agent.fallbackReasons(), {});
  assert.deepEqual(env.agent.ruleHandled(), { availability_lookup: 1, offer_pick: 1 });
  assert.equal(l.lastFallbackReason, 'offer_pick');
});
