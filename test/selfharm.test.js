import test from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../src/safety.js';
import { makeEnv, newLead, fakeLlm, agentTexts, PROFILE_NAMES, profileCfg } from './helpers.js';

const POSITIVE = [
  'I do not want to be alive anymore',
  "I don't want to live anymore",
  'I don’t want to live',
  'dont want to be alive',
  'I am thinking about ending it all',
  'I want to end my life',
  'I am going to kill myself',
  'thinking of killing myself tonight',
  'kil myself',
  'everyone would be better off without me',
  'there is no reason to go on',
  'I want to die',
  'i wanna die',
  'I feel suicidal',
  'I keep wanting to hurt myself',
  "I can't go on like this",
  'I want to take my own life',
  'no point in living anymore',
];
const SAFE = [
  'I could just die of embarrassment, I forgot my last appointment',
  'We are killing it this quarter and need payroll help',
  'I am dying to get an appointment this week',
  'We need end of life planning documents reviewed',
  'My haircut is killing me, the style is so heavy',
  'I want to die laughing at that joke, anyway can I book a trim',
  'I do not want to live far from the office, is parking nearby?',
  'The tooth is killing me, can I come in today',
  'I want to end the subscription to my old bookkeeper',
  'That deadline is going to kill my schedule',
  'I would love to live in a house with a better smile, whitening please',
  'Estate planning and end-of-life paperwork for my parents',
  'I cannot go on Thursday, how about Friday?',
  'My old accountant made me want to scream',
];

test('self-harm wording, direct and indirect, is flagged as an emergency (988 reply path)', () => {
  assert.ok(POSITIVE.length >= 12);
  for (const t of POSITIVE) { const f = classify(t); assert.ok(f.selfHarm && f.medical, `missed: ${t}`); }
});

test('ordinary figures of speech and business wording are not flagged', () => {
  assert.ok(SAFE.length >= 12);
  for (const t of SAFE) { const f = classify(t); assert.ok(!f.selfHarm, `false positive: ${t}`); }
});

for (const name of PROFILE_NAMES) {
  test(`[${name}] indirect self-harm wording gets the 988 reply and a handoff without calling the model`, async () => {
    const llm = fakeLlm([{ throw: new Error('model must not be called') }]);
    const env = makeEnv({ llm, config: profileCfg(name) });
    const l = await newLead(env, { message: 'I do not want to be alive anymore' });
    assert.equal(llm.fetchMock.state.calls.length, 0);
    assert.match(agentTexts(l)[0], /988/);
    assert.match(agentTexts(l)[0], /911/);
    assert.equal(l.status, 'human');
  });
}

test('post-handoff emergency: details show urgent priority, reply is signed as AI, and a second alert is reported as already sent', async () => {
  const sent = [];
  const { Notifier } = await import('../src/notify.js');
  const env = makeEnv();
  env.agent.notifier = new Notifier({ topic: 't', transport: async (u, o) => { sent.push(o.headers.Priority); return { ok: true, status: 200 }; }, now: env.clock.now, log: () => {} });
  const { say } = await import('./helpers.js');
  const l = await newLead(env, { message: 'I want a refund, this service was terrible' });
  await say(env, l, 'He cannot breathe, my son is turning blue'); await env.agent.settled();
  assert.match(agentTexts(l).at(-1), /\(AI\)$/);
  assert.equal(l.priority, 'urgent');
  await say(env, l, 'Please hurry, he is not breathing'); await env.agent.settled();
  assert.equal(sent.length, 2);
  assert.ok(l.timeline.some((t) => t.title === 'Already alerted, not sent again'));
  assert.match(await (await import('node:fs')).promises.readFile(new URL('../public/app.js', import.meta.url), 'utf8'), /l\.priority === 'urgent' \? 'urgent' : q\.urgency/);
});
