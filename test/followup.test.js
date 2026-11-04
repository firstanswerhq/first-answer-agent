import test from 'node:test';
import assert from 'node:assert/strict';
import { FollowupScheduler } from '../src/followups.js';
import { makeEnv, newLead, say, agentTexts } from './helpers.js';

const sched = (env) => new FollowupScheduler({ store: env.store, agent: env.agent, now: env.clock.now });

test('follow-up timer really fires and posts a message when the customer stays quiet', async () => {
  const env = makeEnv();
  const l = await newLead(env);
  const s = sched(env);
  assert.equal(await s.tick(), 0, 'not due yet');
  env.clock.advance(31_000); // 30 min on the 60x demo clock
  assert.equal(await s.tick(), 1);
  const msgs = agentTexts(l);
  assert.equal(msgs.length, 2);
  assert.match(msgs[1], /still want me to hold/);
  assert.equal(l.messages.at(-1).followup, true);
  assert.equal(env.store.followups[0].status, 'fired');
  assert.ok(l.timeline.some((t) => t.kind === 'followup' && /fired/.test(t.title)));
});

test('follow-up is cancelled when the customer replies first', async () => {
  const env = makeEnv();
  const l = await newLead(env);
  env.clock.advance(5_000);
  await say(env, l, 'The second one works');
  env.clock.advance(60_000);
  assert.equal(await sched(env).tick(), 0);
  assert.equal(env.store.followups.find((f) => f.reason === 'customer replied' || f.reason === 'booked').status, 'cancelled');
});

test('a follow-up never fires for a lead that was handed to a human', async () => {
  const env = makeEnv();
  const l = await newLead(env, { message: 'need some work done' });
  l.status = 'human';
  env.clock.advance(60_000);
  await sched(env).tick();
  const before = agentTexts(l).length;
  assert.equal(agentTexts(l).length, before);
  assert.equal(env.store.followups.find((f) => f.status !== 'cancelled'), undefined);
});

test('a follow-up fires only once', async () => {
  const env = makeEnv();
  await newLead(env);
  env.clock.advance(120_000);
  const s = sched(env);
  assert.equal(await s.tick(), 1);
  assert.equal(await s.tick(), 0);
});

test('scheduler start/stop is safe to call repeatedly', () => {
  const env = makeEnv();
  const s = sched(env);
  s.start(); s.start(); s.stop(); s.stop();
  assert.equal(s.timer, null);
});

test('a follow-up fires exactly once even when ticks overlap while the lead queue is busy', async () => {
  const env = makeEnv();
  const l = await newLead(env);
  env.clock.advance(31_000);
  const s = sched(env);
  let release;
  const gate = new Promise((r) => { release = r; });
  env.agent.chains.set(l.id, gate); // the lead's queue is busy (e.g. a slow model run)
  const t1 = s.tick();
  const t2 = s.tick();
  const t3 = s.tick();
  assert.equal(await Promise.race([t2, t3]), 0, 'later ticks see the follow-up as already queued');
  release();
  await Promise.all([t1, t2, t3]);
  assert.equal(agentTexts(l).filter((t) => /still want me to hold/.test(t)).length, 1);
  assert.equal(env.store.followups[0].status, 'fired');
});

test('fireFollowup ignores a follow-up that is no longer pending', async () => {
  const env = makeEnv();
  const l = await newLead(env);
  const fu = env.store.followups[0];
  await env.agent.fireFollowup(fu);
  const count = agentTexts(l).length;
  await env.agent.fireFollowup(fu);
  await env.agent.fireFollowup(fu);
  assert.equal(agentTexts(l).length, count);
});
