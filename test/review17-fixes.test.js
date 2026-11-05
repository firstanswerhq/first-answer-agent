// Review 17: billing questions are not disputes, change claims with an existing booking, sports words are not off-topic by themselves.
import test from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../src/safety.js';
import { checkOutboundRule } from '../src/guard.js';

test('billing fast path: price questions do not fire, real disputes do', () => {
  for (const t of ['Will I be charged extra for long hair?', 'Will I be charged again if I reschedule?', 'Am I charged extra for a deposit?', 'How much will I be billed again next month for the retainer?']) assert.equal(classify(t).complaint, false, t);
  for (const t of ['We were charged double for the visit last week', 'My card was charged again today for the same appointment', 'You charged us twice for the tax prep', 'I was billed twice', 'I am disputing the charge', 'you charged me extra']) assert.equal(classify(t).complaint, true, t);
});

test('with an existing booking, "was updated / has been changed" claims about the appointment are rejected; business statements pass', () => {
  const o = { model: true, booked: true, booking: { slot_id: '2026-11-05T09:00' } };
  for (const t of ['Your appointment was updated to Tuesday at 1 PM.', "I've updated your session time to 11 AM.", 'Your slot has been changed to Saturday.']) assert.equal(checkOutboundRule(t, {}, o)?.id, 'booking_change', t);
  for (const t of ['Our hours changed this fall.', 'Our prices were updated this year.']) assert.equal(checkOutboundRule(t, {}, o), null, t);
});

import { makeEnv, makeClock, newLead, fakeLlm, call, reply, agentTexts, profileCfg } from './helpers.js';
test('the model escalating "recommend a plumber near me" does not hand off; another cause still does', async () => {
  const stub = () => fakeLlm([reply(call('escalate_to_human', { reason: 'not a dental request' })), { status: 200, json: { choices: [{ finish_reason: 'stop', message: { content: 'I am a dental office, so I cannot recommend a plumber, but I can help you book a visit.' } }] } }]);
  const a = await newLead(makeEnv({ llm: stub() }), { message: 'Can you recommend a good plumber near me? near Nashville' });
  assert.notEqual(a.status, 'human');
  assert.equal(a.offTopic, true);
  assert.ok(agentTexts(a).length >= 1);
  const b = await newLead(makeEnv({ llm: stub() }), { message: 'Do you have a banana bread recipe? I also have a tooth emergency, severe pain' });
  assert.equal(b.status, 'human');
});

import { isOffTopic } from '../src/safety.js';
test('a sport word alone is not off-topic; scores, schedules and betting are', () => {
  const d = profileCfg('dental').profile; const sa = profileCfg('salon').profile;
  for (const [p, t] of [[d, 'Can kids who play soccer get fluoride treatments?'], [d, 'Do you treat TMJ pain from clenching during football practice?'], [sa, 'Do you do kids cuts? My son has a baseball game tomorrow.'], [d, 'Do you make custom mouthguards for football?']]) assert.equal(isOffTopic(t, p), false, t);
  for (const t of ['Who won the football game last night?', 'What were the NFL scores this weekend?', 'Any good odds on the basketball playoffs?']) assert.equal(isOffTopic(t, d), true, t);
});

test('a question-only reply to a scheduling request is non-final: nudge, then calendar times; other clarifying replies pass', async () => {
  const txt = (c) => ({ status: 200, json: { choices: [{ finish_reason: 'stop', message: { content: c } }] } });
  const Q = 'Quick question so I book the right visit: is this your first time at our office?';
  const llm = fakeLlm([txt(Q), reply(call('send_reply', { text: 'I have Thursday at 9 AM, 10 AM or 11 AM open. Is this your first visit with us?' }))]);
  const l = await newLead(makeEnv({ llm }), { message: 'I need an exam Thursday at 9am. It is for my daughter.' });
  const all = agentTexts(l).join(' | ');
  assert.match(all, /9 AM, 10 AM or 11 AM/);
  assert.doesNotMatch(all, /^Quick question/);
  assert.match(JSON.stringify(llm.fetchMock.state.bodies[1].messages.at(-1)), /Call check_calendar/);
  // a non-scheduling message keeps its clarifying question
  const llm2 = fakeLlm([txt('Happy to help. Are you asking about our services or about parking?')]);
  const l2 = await newLead(makeEnv({ llm: llm2 }), { message: 'I have a question' });
  assert.equal(l2.lastReplyBy, 'model');
  // reply with times and a question is fine
  const llm3 = fakeLlm([txt('Thursday at 9 AM is taken, but I have 10 AM or 11 AM. Which works?')]);
  const l3 = await newLead(makeEnv({ llm: llm3 }), { message: 'Can I get an exam Thursday at 9am? It is for my son.' });
  assert.equal(l3.lastReplyBy, 'model');
});

test('system prompt: scheduling requests get check_calendar and times first; unrelated or product questions are not escalations', async () => {
  const llm = fakeLlm([reply(call('send_reply', { text: 'Happy to help. I have Thursday at 9 AM or 10 AM. Which works?' }))]);
  await newLead(makeEnv({ llm }), { message: 'I need an exam Thursday at 9am. It is for my daughter.' });
  const sys = llm.fetchMock.state.bodies[0].messages[0].content;
  assert.match(sys, /FIRST calling check_calendar/);
  assert.match(sys, /call 911 or go to the ER/);
  assert.match(sys, /NOT an escalation/);
  assert.match(sys, /Do NOT call escalate_to_human for plainly unrelated/);
});

import { pickSlot } from '../src/extract.js';
const SLOTS = ['2026-11-10T11:00', '2026-11-10T14:00', '2026-11-10T15:00'];
test('pickSlot: natural ways to point at an offered time', () => {
  const at = (t) => pickSlot(t, SLOTS)?.slice(11);
  assert.equal(at('The first time you offered works great, please book that one.'), '11:00');
  assert.equal(at('yes the first one'), '11:00');
  assert.equal(at('the 3pm please'), '15:00');
  assert.equal(at('the earliest one'), '11:00');
  assert.equal(at('book the second'), '14:00');
  assert.equal(at('the last one'), '15:00');
  assert.equal(at('the 2 pm one'), '14:00');
  assert.equal(at('11 works'), '11:00');
  assert.equal(at('Tuesday at 2'), '14:00');
  assert.equal(pickSlot('that one', [SLOTS[1]]), SLOTS[1]);
  assert.equal(pickSlot('book that', [SLOTS[1]]), SLOTS[1]);
  for (const t of ['sure', 'yes', 'ok', 'the 2nd of the month', 'November 2nd', 'my 2nd child needs one', 'this is my first time at a dentist', 'that one', 'Thursday at 2']) assert.equal(pickSlot(t, SLOTS), null, t);
  assert.equal(pickSlot('the first one', []), null, 'nothing offered yet');
  assert.equal(pickSlot('yes', [SLOTS[0]]), SLOTS[0], 'a single offer and a plain yes');
});

test('probe 5: the model claims a booking without calling book_appointment; the picked time is booked through the guarded path', async () => {
  for (const [msg, hour] of [['The first time you offered works great, please book that one.', '11:00'], ['yes the first one', '11:00'], ['the 3pm please', '15:00'], ['the earliest one', '11:00'], ['book the second', '14:00']]) {
    const env = makeEnv({});
    const l = await newLead(env, { message: 'Tuesday at 1pm for a cleaning please.' });
    assert.ok(l.offeredSlots?.length >= 3, 'times were offered');
    const idx = { '11:00': l.offeredSlots.findIndex((id) => id.endsWith('11:00')), '14:00': 1, '15:00': l.offeredSlots.findIndex((id) => id.endsWith('15:00')) };
    void idx;
    const offered = [...l.offeredSlots];
    env.agent.llm = fakeLlm([{ status: 200, json: { choices: [{ finish_reason: 'stop', message: { content: "You're all set! Your cleaning is booked. See you soon!" } }] } }]);
    const { done } = env.svc.addCustomerMessage(l.id, msg); await done;
    const b = env.store.bookingForLead(l.id);
    assert.ok(b, `booked for: ${msg}`);
    const want = /3pm/.test(msg) ? offered.find((id) => id.slice(11, 13) === '15') : /second/.test(msg) ? offered[1] : offered[0];
    assert.equal(b.slot_id, want, msg);
    assert.equal(env.store.liveBookings().filter((x) => x.leadId === l.id).length, 1);
    assert.match(agentTexts(l).at(-1), /Booked|booked/);
  }
});

test('booking claim without a clear pick is still refused and the rules ask which time', async () => {
  for (const msg of ['sure', 'the 2nd of the month']) {
    const env = makeEnv({});
    const l = await newLead(env, { message: 'Tuesday at 1pm for a cleaning please.' });
    env.agent.llm = fakeLlm([{ status: 200, json: { choices: [{ finish_reason: 'stop', message: { content: "You're all set! Your cleaning is booked. See you soon!" } }] } }]);
    const { done } = env.svc.addCustomerMessage(l.id, msg); await done;
    assert.ok(!env.store.bookingForLead(l.id), msg);
  }
  // nothing offered yet
  const env = makeEnv({ llm: fakeLlm([{ status: 200, json: { choices: [{ finish_reason: 'stop', message: { content: "You're all set! Your cleaning is booked." } }] } }]) });
  const l = await newLead(env, { message: 'the first one please' });
  assert.ok(!env.store.bookingForLead(l.id));
});
