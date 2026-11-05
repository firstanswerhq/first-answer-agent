// The banner reflects the model honestly but does not flap on one slow call; a background re-check restores it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, makeClock, WED_10AM, newLead, agentTexts, fakeLlm, call, reply } from './helpers.js';

const TIMEOUT = () => { throw new Error('Inference deadline reached'); };

test('one model failure keeps the model banner; three in a row show backup mode; a success resets', async () => {
  const env = makeEnv({ llm: fakeLlm([]) });
  const a = env.agent;
  a.noteModel(true);
  a.noteModel(false, new Error('Inference deadline reached'));
  assert.equal(a.status().mode, 'model');
  assert.equal(a.status().label, 'AI model');
  assert.equal(a.status().lastError, 'Inference deadline reached');
  assert.equal(a.status().consecutiveModelFailures, 1);
  a.noteModel(false, new Error('x')); a.noteModel(false, new Error('x'));
  assert.equal(a.status().mode, 'offline');
  assert.match(a.status().label, /unreachable/);
  a.noteModel(true);
  assert.equal(a.status().mode, 'model');
  assert.equal(a.status().consecutiveModelFailures, 0);
});

test('a model that never answered and failed once is shown as unreachable', () => {
  const env = makeEnv({ llm: fakeLlm([]) });
  env.agent.noteModel(false, new Error('boom'));
  assert.match(env.agent.status().label, /unreachable/);
  assert.equal(env.agent.status().modelVerified, false);
});

test('a real timed-out reply is still labeled as written by the rules, while the banner stays on the model', async () => {
  const clock = makeClock(WED_10AM, 1000);
  const env = makeEnv({ clock, llm: fakeLlm([]) });
  env.agent.noteModel(true);
  env.agent.llm = fakeLlm([() => { clock.advance(25000); return reply(call('qualify_lead', { service: 'checkup', urgency: 'routine' })); }]);
  const l = await newLead(env, { message: 'My daughter needs a cleaning sometime. Thanks.' });
  assert.ok(agentTexts(l).length);
  assert.equal(l.messages.filter((m) => m.from === 'agent').at(-1).by, 'rules');
  assert.equal(env.agent.status().mode, 'model');
});

test('maybeRecheck probes after a failure or 10 idle minutes, never when healthy; the probe does not count as a run', async () => {
  const clock = makeClock(WED_10AM, 0);
  let pings = 0;
  const llm = { configured: true, model: 'm', ping: async () => { pings += 1; return { model: 'm' }; } };
  const env = makeEnv({ clock, llm });
  const a = env.agent;
  a.llm = llm;
  a.noteModel(true);
  assert.equal(await a.maybeRecheck(), null); assert.equal(pings, 0);
  clock.advance(11 * 60_000);
  assert.equal(await a.maybeRecheck(), true); assert.equal(pings, 1);
  a.noteModel(false, new Error('x')); a.noteModel(false, new Error('x')); a.noteModel(false, new Error('x'));
  assert.equal(a.status().mode, 'offline');
  assert.equal(await a.maybeRecheck(), true);
  assert.equal(a.status().mode, 'model');
  assert.equal(a.stats.modelRuns, 0);
  assert.equal(a.modelRunStamps.length, 0);
});
