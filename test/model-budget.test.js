// Review 15 and final batch: total deadline, upstream call cap, tool_choice narrowing, length retry, thinking-off request fields.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, makeClock, newLead, fakeLlm, call, reply, agentTexts } from './helpers.js';
import { LlmClient } from '../src/llm.js';

const msg = (m, finish = 'stop') => ({ status: 200, json: { model: 'glm-5.3-flash', choices: [{ finish_reason: finish, message: { role: 'assistant', ...m } }] } });
const GOOD = 'Happy to help. Which day works best for your cleaning?';

test('total deadline: once exceeded, no further upstream call and the rules answer with model_timeout', async () => {
  const clock = makeClock();
  let n = 0;
  const llm = fakeLlm([() => { n += 1; clock.advance(19000); return reply(call('qualify_lead', { service_id: 'checkup' })); }, () => { n += 1; return reply(call('send_reply', { text: GOOD })); }]);
  const env = makeEnv({ llm, clock });
  const l = await newLead(env);
  assert.equal(n, 1, 'the second model call never left the process');
  assert.equal(llm.fetchMock.state.bodies.length, 1);
  assert.equal(l.lastReplyBy, 'rules');
  assert.equal(l.lastFallbackReason, 'model_timeout');
  assert.ok(agentTexts(l).length >= 1);
});

test('per-call timeout is min(remaining, 12 s); retries respect the same budget', async () => {
  const seen = [];
  const llm = fakeLlm([{ status: 500, json: {} }], { retries: 5 });
  const orig = llm.request.bind(llm);
  llm.request = (p, b, m, t) => { seen.push(t); return orig(p, b, m, t); };
  const clock = makeClock();
  const budget = { startedAt: null, deadlineMs: 18000, calls: 0, maxCalls: 6, now: clock.now };
  await assert.rejects(() => llm.chat({ messages: [{ role: 'user', content: 'hi' }], tools: [], budget }), /HTTP 500|call limit/);
  assert.ok(seen.every((t) => t <= 12000));
  assert.ok(budget.calls <= 6);
  clock.advance(17000);
  const t0 = seen.length;
  const b2 = { startedAt: clock.t - 17000, deadlineMs: 18000, calls: 0, maxCalls: 6, now: clock.now };
  await assert.rejects(() => llm.chat({ messages: [], tools: [], budget: b2 }), /HTTP 500|call limit|deadline/);
  assert.ok(seen[t0] <= 1000, `remaining time caps the call: ${seen[t0]}`);
});

test('call cap: never more than 6 upstream calls per inquiry', async () => {
  const llm = fakeLlm([reply(call('send_reply', { text: 'x'.repeat(700) }))]);
  const env = makeEnv({ llm });
  await newLead(env);
  assert.ok(llm.fetchMock.state.bodies.length <= 6);
});

test('a 400 that does not mention tool_choice does not change tool_choice', async () => {
  const script = [msg({ content: '' }), { status: 400, json: {}, body: 'invalid request: messages' }];
  const llm = fakeLlm(script);
  const env = makeEnv({ llm });
  const l = await newLead(env);
  assert.equal(llm.toolChoiceSupport, 'object');
  assert.equal(l.lastReplyBy, 'rules');
});

test('finish_reason length with no answer: one retry with a larger max_tokens and a request to be brief', async () => {
  const script = [msg({ content: '', reasoning_content: 'thinking...' }, 'length'), (b) => reply(call('send_reply', { text: GOOD }))];
  const llm = fakeLlm(script);
  const env = makeEnv({ llm });
  const l = await newLead(env);
  const bodies = llm.fetchMock.state.bodies;
  assert.equal(bodies[0].max_tokens, 2000);
  assert.equal(bodies[1].max_tokens, 4000);
  assert.match(JSON.stringify(bodies[1].messages.at(-1)), /2-4 short sentences/);
  assert.equal(l.lastReplyBy, 'model');
});

test('first request asks the server to skip long thinking; a 400 naming the field drops it for the process', async () => {
  const script = [(b) => (b.chat_template_kwargs ? { status: 400, json: {}, body: 'Unknown field chat_template_kwargs' } : reply(call('send_reply', { text: GOOD })))];
  const llm = fakeLlm(script);
  const env = makeEnv({ llm });
  const l = await newLead(env);
  const bodies = llm.fetchMock.state.bodies;
  assert.deepEqual(bodies[0].chat_template_kwargs, { enable_thinking: false });
  assert.equal(bodies[0].reasoning_effort, 'low');
  assert.equal(bodies[1].chat_template_kwargs, undefined);
  assert.equal(bodies[1].reasoning_effort, 'low');
  assert.ok(llm.dropped.has('chat_template_kwargs'));
  assert.equal(l.lastReplyBy, 'model');
  const n = bodies.length;
  await newLead(env, { name: 'Second Person', phone: '(615) 555-0122' });
  assert.equal(llm.fetchMock.state.bodies[n].chat_template_kwargs, undefined, 'remembered');
});

test('non-HTTP internal errors read model_error:internal', async () => {
  const llm = fakeLlm([reply(call('send_reply', { text: GOOD }))]);
  llm.chat = async () => { throw new TypeError('boom'); };
  const env = makeEnv({ llm });
  const l = await newLead(env);
  assert.equal(l.lastFallbackReason, 'model_error:internal');
});
