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
  const l = await newLead(makeEnv({ llm }), { message: 'I need an exam Thursday at 9am' });
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
  const l3 = await newLead(makeEnv({ llm: llm3 }), { message: 'Can I get an exam Thursday at 9am?' });
  assert.equal(l3.lastReplyBy, 'model');
});

test('system prompt: scheduling requests get check_calendar and times first; unrelated or product questions are not escalations', async () => {
  const llm = fakeLlm([reply(call('send_reply', { text: 'Happy to help. I have Thursday at 9 AM or 10 AM. Which works?' }))]);
  await newLead(makeEnv({ llm }), { message: 'I need an exam Thursday at 9am' });
  const sys = llm.fetchMock.state.bodies[0].messages[0].content;
  assert.match(sys, /FIRST calling check_calendar/);
  assert.match(sys, /call 911 or go to the ER/);
  assert.match(sys, /NOT an escalation/);
  assert.match(sys, /Do NOT call escalate_to_human for plainly unrelated/);
});
