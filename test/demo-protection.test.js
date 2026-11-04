import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { seedSample } from '../src/seed.js';
import { FollowupScheduler } from '../src/followups.js';
import { startServer, post, cfgFor, lead, makeEnv, newLead, say, makeClock, WED_10AM } from './helpers.js';

const settle = (s) => Promise.all([...s.agent.chains.values()]);
const cap = (over) => cfgFor({ limits: { ...cfgFor().limits, ...over } });

test('eviction at the lead cap drops the oldest live lead and never a sample lead', async () => {
  const clock = makeClock(WED_10AM);
  const config = cap({ maxLeads: 10 });
  const env = makeEnv({ config, clock });
  await seedSample(env.store, config, { realNow: clock.now() });
  const seeds = env.store.leads.filter((l) => l.seed).map((l) => l.id);
  assert.equal(seeds.length, 8);
  for (let i = 0; i < 6; i += 1) await newLead(env, { name: `Live ${i}` });
  assert.equal(env.store.leads.length, 10);
  for (const id of seeds) assert.ok(env.store.getLead(id), 'sample lead still present');
  assert.ok(env.store.leads.some((l) => l.name === 'Live 5'));
  assert.ok(!env.store.leads.some((l) => l.name === 'Live 0'), 'oldest live lead evicted first');
  assert.ok(env.store.bookings.some((b) => b.sample && b.leadId), 'sample bookings kept');
});

test('visitor bookings expire after the TTL and free the slot; sample bookings stay', async () => {
  const clock = makeClock(WED_10AM);
  const config = cfgFor();
  const env = makeEnv({ config, clock });
  await seedSample(env.store, config, { realNow: clock.now() });
  const sampleBookings = env.store.bookings.filter((b) => b.status === 'confirmed').length;
  const l = await newLead(env);
  await say(env, l, 'The first one works');
  const b = env.store.bookingForLead(l.id);
  assert.ok(b);
  assert.equal(env.store.releaseExpired(clock.now() + config.limits.liveBookingTtlMs - 1000, config.limits.liveBookingTtlMs), 0);
  clock.advance(config.limits.liveBookingTtlMs + 60_000);
  const sched = new FollowupScheduler({ store: env.store, agent: env.agent, now: clock.now });
  await sched.tick();
  assert.equal(env.store.bookingForLead(l.id), null);
  assert.equal(env.store.bookingForSlot(b.slot_id), null, 'slot is free again');
  assert.equal(l.status, 'replied');
  assert.equal(env.store.bookings.filter((x) => x.status === 'confirmed').length, sampleBookings);
});

test('visitor bookings are capped overall and per visitor', async () => {
  const config = cap({ maxLiveBookings: 2, maxBookingsPerVisitor: 1 });
  const env = makeEnv({ config });
  const a = env.svc.createLead({ name: 'A One', phone: '(615) 555-0111', source: 'Website form', message: 'How much is a cleaning and checkup for an adult? I pay out of pocket.' }, { ipKey: 'ip1' });
  await a.done;
  await say(env, a.lead, 'first one');
  assert.ok(env.store.bookingForLead(a.lead.id));
  const a2 = env.svc.createLead({ name: 'A Two', phone: '(615) 555-0112', source: 'Website form', message: 'How much is a cleaning and checkup for an adult? I pay out of pocket.' }, { ipKey: 'ip1' });
  await a2.done;
  await say(env, a2.lead, 'first one');
  assert.equal(env.store.bookingForLead(a2.lead.id), null, 'same visitor cannot hold a second slot');
  const others = [];
  for (const ip of ['ip2', 'ip3']) {
    const x = env.svc.createLead({ name: `X ${ip}`, phone: '(615) 555-0113', source: 'Website form', message: 'How much is a cleaning and checkup for an adult? I pay out of pocket.' }, { ipKey: ip });
    await x.done;
    await say(env, x.lead, 'first one');
    others.push(x.lead);
  }
  assert.ok(env.store.bookingForLead(others[0].id));
  assert.equal(env.store.bookingForLead(others[1].id), null, 'overall visitor cap reached');
  assert.equal(env.store.liveBookings().length, 2);
});

test('POST /api/demo/reset restores the sample day, drops visitor leads, is rate limited and never touches model counters', async () => {
  const clock = makeClock(WED_10AM, 5);
  const config = cap({ resetCooldownMs: 0, resetRate: { windowMs: 3_600_000, max: 2 } });
  const store = new Store();
  const s = await startServer({ store, config, now: clock.now });
  try {
    for (let i = 0; i < 3; i += 1) await post(s.base, '/api/leads', lead({ name: `Visitor ${i}` }));
    await settle(s);
    const runsBefore = s.agent.modelRunStamps.length;
    const statsBefore = JSON.stringify(s.agent.stats);
    assert.ok(store.leads.some((l) => !l.seed));
    const r = await post(s.base, '/api/demo/reset', {});
    assert.equal(r.status, 200);
    assert.ok(store.leads.length >= 8 && store.leads.every((l) => l.seed));
    assert.equal(s.agent.modelRunStamps.length, runsBefore);
    assert.equal(JSON.stringify(s.agent.stats), statsBefore);
    assert.equal((await post(s.base, '/api/demo/reset', {})).status, 200);
    const third = await post(s.base, '/api/demo/reset', {});
    assert.equal(third.status, 429);
    assert.ok(third.headers.get('retry-after'));
  } finally { await s.stop(); }
});

test('POST /api/demo/reset has a cooldown between resets', async () => {
  const s = await startServer({ now: makeClock(WED_10AM).now });
  try {
    assert.equal((await post(s.base, '/api/demo/reset', {})).status, 200);
    assert.equal((await post(s.base, '/api/demo/reset', {})).status, 429);
  } finally { await s.stop(); }
});
