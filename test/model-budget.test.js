import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, fakeLlm, call, reply, cfgFor, lead } from './helpers.js';

const happy = () => [
  reply(call('qualify_lead', { job_type: 'gutter_cleaning', urgency: 'routine', size: 'medium', location: 'Franklin 37064' })),
  reply(call('check_calendar', { limit: 3 })),
  (body) => {
    const tool = body.messages.filter((m) => m.role === 'tool').map((m) => JSON.parse(m.content));
    const slots = tool.find((t) => t.slots).slots;
    return reply(call('send_reply', { text: `Gutter cleaning is typically $170-$250. I can come ${slots[0].label}. Does that work?` }));
  },
  reply(),
];
const inf = (over) => cfgFor({ inference: { ...cfgFor().inference, ...over } });

test('per-visitor model cap: one visitor gets rules after their quota, another visitor still gets the model', async () => {
  const llm = fakeLlm([...happy(), ...happy(), ...happy(), ...happy(), ...happy(), ...happy()]);
  const env = makeEnv({ llm, config: inf({ maxRunsPerIpPerHour: 2 }) });
  const modes = [];
  for (let i = 0; i < 3; i += 1) {
    const { lead: l, done } = env.svc.createLead(lead({ name: `Greedy ${i}` }), { ipKey: 'greedy' });
    await done;
    modes.push(l.lastRunMode);
    if (i === 2) assert.ok(l.timeline.some((t) => /per-visitor hourly model-call cap/.test(t.title)));
  }
  assert.deepEqual(modes, ['model', 'model', 'offline']);
  const { lead: other, done } = env.svc.createLead(lead({ name: 'Other' }), { ipKey: 'someone-else' });
  await done;
  assert.equal(other.lastRunMode, 'model');
  assert.equal(env.agent.status().mode, 'model', 'the global badge stays truthful while only one visitor is capped');
});

test('the visitor cap window slides: after an hour the visitor gets the model again', async () => {
  const llm = fakeLlm(Array.from({ length: 4 }, happy).flat());
  const env = makeEnv({ llm, config: inf({ maxRunsPerIpPerHour: 1 }) });
  const a = env.svc.createLead(lead(), { ipKey: 'v' }); await a.done;
  const b = env.svc.createLead(lead(), { ipKey: 'v' }); await b.done;
  assert.equal(b.lead.lastRunMode, 'offline');
  env.clock.advance(3_600_001);
  const c = env.svc.createLead(lead(), { ipKey: 'v' }); await c.done;
  assert.equal(c.lead.lastRunMode, 'model');
});

test('the global cap is reserved when a run starts, so concurrent runs cannot overshoot it', async () => {
  // Stateless responder so interleaved concurrent runs each get a sensible answer.
  const responder = (body) => {
    const tool = body.messages.filter((m) => m.role === 'tool').map((m) => JSON.parse(m.content));
    if (!tool.length) return reply(call('qualify_lead', { job_type: 'gutter_cleaning', urgency: 'routine', size: 'medium', location: 'Franklin 37064' }));
    if (!tool.some((t) => t.slots)) return reply(call('check_calendar', { limit: 3 }));
    if (tool.length < 3) return reply(call('send_reply', { text: `Gutter cleaning is typically $170-$250. I can come ${tool.find((t) => t.slots).slots[0].label}. Does that work?` }));
    return reply();
  };
  const llm = fakeLlm([responder]);
  const env = makeEnv({ llm, config: inf({ maxRunsPerHour: 2 }) });
  const runs = Array.from({ length: 6 }, (_, i) => env.svc.createLead(lead({ name: `P${i}` }), { ipKey: `ip${i}` }));
  await Promise.all(runs.map((r) => r.done));
  const modelRuns = runs.filter((r) => r.lead.lastRunMode === 'model').length;
  assert.equal(modelRuns, 2);
});

test('when the global cap is reached the badge and health say so instead of "Live model"', async () => {
  const llm = fakeLlm(Array.from({ length: 6 }, happy).flat());
  const env = makeEnv({ llm, config: inf({ maxRunsPerHour: 1 }) });
  assert.equal(env.agent.status().label, 'Live model');
  const a = env.svc.createLead(lead()); await a.done;
  const st = env.agent.status();
  assert.equal(st.mode, 'offline');
  assert.equal(st.model, null);
  assert.equal(st.quotaReached, true);
  assert.match(st.label, /quota reached/);
  env.clock.advance(3_600_001);
  assert.equal(env.agent.status().label, 'Live model');
});
