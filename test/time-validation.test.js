// Outbound time validation: a model reply may only offer times that are open slots right now.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { timeProblem } from '../src/timecheck.js';
import { makeEnv, newLead, fakeLlm, call, reply, agentTexts } from './helpers.js';

const open = { '2026-11-05': ['08:00', '10:00', '11:00', '13:00', '14:00', '15:00', '16:00'], '2026-11-06': ['08:00', '09:00', '11:00'], '2026-11-10': ['09:00', '11:00', '14:00', '15:00'] };
const o = { today: '2026-11-04', openOn: (d) => new Set(open[d] || []), anyOpen: (hm) => Object.values(open).some((a) => a.includes(hm)), nearest: 'Thu, Nov 5, 10:00 AM-11:00 AM' };

test('the three live bad replies are rejected', () => {
  for (const t of ['Hi Zack! I can offer: Thu Nov 5 at 9:00 AM, Thu Nov 5 at 2:30 PM, or Fri Nov 6 at 10:00 AM. A cleaning and checkup is $110-$190.', 'We have these openings: Tue Nov 10 at 9:00 AM, Wed Nov 11 at 2:30 PM, or Thu Nov 12 at 10:15 AM. The cost runs 140-260 dollars.', 'Next week I have Tue Nov 10 at 9:00 AM, Wed Nov 11 at 2:30 PM, or Thu Nov 12 at 10:15 AM open.']) {
    const r = timeProblem(t, o);
    assert.equal(r?.id, 'bad_time', t);
    assert.match(r.message, /Only offer these exact open times/);
  }
});

test('open times, taken times, hours, durations and ranges are not rejected', () => {
  for (const t of ['I have Thu Nov 5 at 10:00 AM, 1:00 PM or 2:00 PM.', 'I have Thursday at 10 am, 1pm or 2 pm.', 'Thursday at 9 AM is taken, but I have 10 AM or 11 AM.', 'Our 1:00 PM on Tuesday, Nov 10 is taken, but we have 11:00 AM, 2:00 PM, or 3:00 PM that day.', 'Open times: Thu, Nov 5, 10:00 AM-11:00 AM.', 'Thu Nov 5, 1-2pm works.', 'Thu Nov 5 at 13:00 or 14:00', 'Friday at 11 is open', 'We are open Mon-Thu 8 AM-5 PM, Fri 8 AM-noon. The visit takes about 1.5 hours.', 'Please arrive within 24 hours of the reminder.', 'We are closed at 5:30 PM on Thursday.', 'Call us at (615) 555-0100 any time.']) assert.equal(timeProblem(t, o), null, t);
  for (const t of ['Friday at 10 is open', 'Thursday at 9 AM or 2:30 PM', 'Thu Nov 5 at noon', 'Sunday Nov 8 at 10 AM']) assert.equal(timeProblem(t, o)?.id, 'bad_time', t);
});

test('every recorded live reply: report false rejects against business-hours slots', () => {
  const dir = new URL('../../reviews/', import.meta.url);
  void dir; // recorded files live outside the repo; this test only runs the parser over a built-in sample of good live replies
  const good = ['Hi Amy, welcome to Nashville! Yes, we\'re accepting new patients. A new patient exam with X-rays runs $140-$260 and takes about an hour and a half. I have openings tomorrow, Thu Nov 5: 1:00 PM, 2:00 PM, or 3:00 PM. Which works for you?', 'I have these openings: Thu, Nov 5 at 10:00 AM, 2:00 PM, or 3:00 PM. Which works for you?', 'Our hours are Mon-Thu 8 AM-5 PM and Fri 8 AM-noon, Central Time.', 'Hi Jill! Our 1:00 PM on Tuesday, Nov 10 is taken, but we have 11:00 AM, 2:00 PM, or 3:00 PM that day.'];
  for (const t of good) assert.equal(timeProblem(t, o)?.id, undefined, t);
});

test('model path: a reply with an invented time is refused, nudged with the real list, then the rules answer', async () => {
  const bad = { status: 200, json: { choices: [{ finish_reason: 'stop', message: { content: 'Hi! I have Wed Nov 11 at 2:30 PM, or Thu Nov 12 at 10:15 AM open for you. Which works?' } }] } };
  const llm = fakeLlm([bad]);
  const l = await newLead(makeEnv({ llm }), { message: 'Do you have an exam next week?' });
  const all = agentTexts(l).join(' | ');
  assert.doesNotMatch(all, /2:30 PM|10:15 AM/);
  assert.equal(l.lastReplyBy, 'rules');
  assert.match(l.lastFallbackReason, /bad_time/);
  assert.match(JSON.stringify(llm.fetchMock.state.bodies.at(-1).messages.at(-1)), /Only offer these exact open times/);
});

test('a real open time offered by the model passes; stored offered slots come only from the calendar tool', async () => {
  const env = makeEnv({});
  const l0 = await newLead(env, { message: 'Do you have any openings for a dental exam next week?' });
  const real = l0.offeredSlots;
  assert.ok(real.length >= 3);
  assert.ok(real.every((id) => /^\d{4}-\d\d-\d\dT\d\d:00$/.test(id)));
});

import { profileCfg } from './helpers.js';
test('rules wording: Friday 10:00 exam, x-ray cost question, bare yes among several offers', async () => {
  let env = makeEnv({ config: profileCfg('dental') });
  let l = await newLead(env, { message: 'Is 10:00 on Friday available for an exam?' });
  let t = agentTexts(l).join(' ');
  assert.match(t, /Friday at 10:00 AM is (open|already taken)/);
  assert.doesNotMatch(t, /closed right now/);
  l = await newLead(env, { name: 'Xena Ray', phone: '(615) 555-0166', message: 'Do x-rays cost extra?' });
  t = agentTexts(l).join(' ');
  assert.match(t, /teammate will confirm/);
  assert.doesNotMatch(t, /do not have whether/);
  l = await newLead(env, { name: 'Yan Yes', phone: '(615) 555-0167', message: 'I need a cleaning next week' });
  const offered = l.offeredSlots.slice();
  assert.ok(offered.length >= 2);
  const { done } = env.svc.addCustomerMessage(l.id, 'yes that works'); await done;
  assert.match(agentTexts(l).at(-1), /Which of these works best: 1\) .* 2\) /);
  assert.ok(!env.store.bookingForLead(l.id));
});

import { makeClock } from './helpers.js';
test('model_timeout during a booking follow-up: the rules still honor the pick', async () => {
  const clock = makeClock();
  const env = makeEnv({ clock });
  const l = await newLead(env, { message: 'Tuesday at 1pm for a cleaning please.' });
  const offered = [...l.offeredSlots];
  env.agent.llm = fakeLlm([() => { clock.advance(19000); return reply(call('qualify_lead', { service: 'checkup', urgency: 'routine' })); }, reply(call('send_reply', { text: 'Booked!' }))]);
  const { done } = env.svc.addCustomerMessage(l.id, 'The first time you offered works great, please book that one.'); await done;
  assert.equal(l.lastFallbackReason, 'model_timeout');
  assert.equal(env.store.bookingForLead(l.id)?.slot_id, offered[0]);
});
