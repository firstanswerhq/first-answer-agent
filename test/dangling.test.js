// A reply that only promises to look something up is not final (live probe 3, "Tuesday at 1pm for an exam").
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkOutboundRule, calendarProblem } from '../src/guard.js';
import { makeEnv, newLead, fakeLlm, call, reply, agentTexts, profileCfg, cfgFor } from './helpers.js';

const lead = { phone: '(615) 555-0111', name: 'Jude Test', qualification: { priceRange: { low: 140, high: 260 } } };
const M = { model: true, booked: false, ownPhones: ['(615) 555-0100'] };
const id = (t, o = M) => checkOutboundRule(t, lead, o)?.id ?? null;

const DANGLING = [
  "I'd be happy to set up a new patient exam with X-rays - let me check what's open around Tuesday at 1pm.",
  "Let me check the calendar for you.",
  "One moment while I look that up.",
  "Checking now, I'll be right back with times.",
  "Let me see what's open and get back to you.",
  "I will look at the schedule and see what we have.",
  "Just a moment, I am pulling up Tuesday.",
  "Give me a second to check on that.",
];
const GOOD = [
  "Tuesday at 1:00 PM is taken, but I have 11:00 AM, 2:00 PM or 3:00 PM that day. Which works?",
  "I have Thu 1 PM, 2 PM and 3 PM open. Let me know which you prefer.",
  "Let me know if Friday morning works better, and I will find a time.",
  "Let me check one thing: do you have dental insurance?",
  "Thursday at 9 is open. Want me to book it?",
  "Happy to help. Which day works best for your cleaning?",
  "We're open Mon-Thu 8 AM-5 PM. Let me know when you would like to come in.",
  "Tuesday at 1 PM is already taken.",
];

test('dangling promises with no answer are rejected as non-final', () => {
  for (const t of DANGLING) assert.equal(id(t), 'dangling', t);
});
test('real replies, including "let me know", are never rejected as dangling', () => {
  for (const t of GOOD) assert.notEqual(id(t), 'dangling', t);
  for (const t of GOOD) assert.equal(id(t), null, t);
});
test('the dangling check only applies to the model; the software\'s own texts are exempt', () => {
  assert.equal(id(DANGLING[1], { booked: true }), null);
});

test('after check_calendar the reply must carry an open time or say the asked time is taken', () => {
  const slots = ['2026-11-10T11:00', '2026-11-10T14:00', '2026-11-10T15:00'];
  assert.equal(calendarProblem('Happy to help with your exam! Let me know what works for you.', slots).id, 'no_times');
  assert.equal(calendarProblem('Tuesday at 1 PM is taken, but I have 11:00 AM, 2:00 PM and 3:00 PM.', slots), null);
  assert.equal(calendarProblem('I have 11, 2 or 3 that day.', slots), null);
  assert.equal(calendarProblem('Tuesday at 1 PM is already taken. Want a different day?', slots), null);
  assert.equal(calendarProblem('Your 8 year old is welcome; the visit is $140-$260. Nov 10 works.', slots).id, 'no_times');
  assert.equal(calendarProblem('anything', []), null);
});

const textOnly = (content) => ({ status: 200, json: { model: 'fake-model-1', choices: [{ message: { role: 'assistant', content } }] } });
const JUDE = "Hi Jude! I'd be happy to set up a new patient exam with X-rays - let me check what's open around Tuesday at 1pm.";

test('Jude: the model checks the calendar and ends with a promise; the retry also dangles; the rules give the taken-time answer', async () => {
  const env0 = makeEnv({ config: profileCfg('dental') });
  const l1 = await newLead(env0, { message: 'I need a cleaning Tuesday at 1pm' });
  const { done } = env0.svc.addCustomerMessage(l1.id, '1'); await done; // book Tue 1 PM on the shared store
  const llm = fakeLlm([
    reply(call('qualify_lead', { service: 'checkup', urgency: 'routine' })),
    reply(call('check_calendar', { earliest_date: '2026-11-10' })),
    textOnly(JUDE),
  ]);
  const env = makeEnv({ llm, store: env0.store, config: cfgFor() });
  const l = await newLead(env, { name: 'Jude Test', message: 'I would like Tuesday at 1pm for an exam please.' });
  const t = agentTexts(l).join(' | ');
  assert.doesNotMatch(t, /let me check/i);
  assert.match(t, /Tuesday at 1:00 PM is already taken/);
  assert.equal(l.lastReplyBy, 'rules');
  assert.equal(l.lastFallbackReason, 'text_rejected:dangling');
});

test('a model that dangles once and then answers properly after the nudge is used', async () => {
  const llm = fakeLlm([
    reply(call('qualify_lead', { service: 'checkup', urgency: 'routine' })),
    reply(call('check_calendar', {})),
    textOnly('Let me check what is open for you.'),
    reply(call('send_reply', { text: 'I have Thu 1:00 PM, 2:00 PM or 3:00 PM open. Which works for you?' })),
  ]);
  const env = makeEnv({ llm });
  const l = await newLead(env, { message: 'I need a cleaning' });
  assert.equal(l.lastReplyBy, 'model');
  assert.match(agentTexts(l)[0], /1:00 PM, 2:00 PM or 3:00 PM/);
  const last = llm.fetchMock.state.bodies.at(-1);
  assert.match(last.messages.at(-1).content, /already have the calendar results/);
});

test('send_reply after check_calendar with no times is refused (tool path), the model is told why and can fix it', async () => {
  const llm = fakeLlm([
    reply(call('qualify_lead', { service: 'checkup', urgency: 'routine' })),
    reply(call('check_calendar', {})),
    reply(call('send_reply', { text: 'Happy to help with your cleaning! Tell me what suits you.' })),
    reply(call('send_reply', { text: 'I have Thu 1:00 PM, 2:00 PM or 3:00 PM open. Which works for you?' })),
  ]);
  const env = makeEnv({ llm });
  const l = await newLead(env, { message: 'I need a cleaning' });
  assert.equal(l.lastReplyBy, 'model');
  assert.ok(l.timeline.some((t) => t.fn === 'send_reply' && t.ok === false && /actual open times/.test(JSON.stringify(t.result))));
  assert.match(agentTexts(l)[0], /1:00 PM, 2:00 PM or 3:00 PM/);
});

test('the prompt says not to assume a new patient and not to promise to check', async () => {
  const llm = fakeLlm([textOnly('x')]);
  const env = makeEnv({ llm });
  await newLead(env);
  const sys = llm.fetchMock.state.bodies[0].messages[0].content;
  assert.match(sys, /Say "new patient" only if they said they are new/);
  assert.match(sys, /Never write "let me check"/);
});
