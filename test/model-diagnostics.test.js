// Why did the rules write this reply? Short non-sensitive reasons, and the model response shapes of Vultr/GLM-style servers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, newLead, fakeLlm, call, reply, agentTexts, cfgFor, startServer, post } from './helpers.js';
import { summary, detail } from '../src/service.js';

const msg = (m, finish = 'stop') => ({ status: 200, json: { model: 'glm-5.3-flash', choices: [{ finish_reason: finish, message: { role: 'assistant', ...m } }] } });
const SIG = 'Brightwater scheduling assistant (AI)';
const run = async (script, over) => {
  const llm = fakeLlm(script, over);
  const env = makeEnv({ llm });
  const l = await newLead(env);
  return { env, llm, l };
};

test('content as a list of parts is read as the reply text', async () => {
  const { l } = await run([msg({ content: [{ type: 'text', text: 'Happy to help with a cleaning and checkup. ' }, { type: 'text', text: 'Which day works best for you?' }] })]);
  assert.equal(l.lastReplyBy, 'model');
  assert.match(agentTexts(l)[0], /^Happy to help with a cleaning and checkup\. Which day works best for you\? - Brightwater/);
});

test('reasoning_content with an empty answer is never sent; the reason says why (cut off, or reasoning only)', async () => {
  let r = await run([msg({ content: '', reasoning_content: 'The user wants hours. I should call send_reply ...' }, 'length')]);
  assert.equal(r.l.lastReplyBy, 'rules');
  assert.equal(r.l.lastFallbackReason, 'empty_end:length');
  assert.ok(agentTexts(r.l).every((t) => !/should call/.test(t)));
  r = await run([msg({ content: null, reasoning_content: 'thinking about it' }, 'stop')]);
  assert.equal(r.l.lastFallbackReason, 'empty_end:reasoning_only');
  r = await run([msg({ content: '' })]);
  assert.equal(r.l.lastFallbackReason, 'empty_end');
  assert.equal(r.llm.fetchMock.state.bodies.length, 2, 'one forced retry only');
});

test('tool_calls with string arguments plus text and finish_reason stop: the tool call wins', async () => {
  const both = msg({ content: 'Let me check that for you.', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'send_reply', arguments: JSON.stringify({ text: 'Happy to help. Which day works best for your cleaning?' }) } }] }, 'stop');
  const { l } = await run([both]);
  assert.equal(l.lastReplyBy, 'model');
  assert.equal(l.lastFallbackReason, null);
  assert.ok(!agentTexts(l).some((t) => /Let me check/.test(t)));
});

test('model reply rejected by the guard: the reason names the rule, never the text', async () => {
  let r = await run([msg({ content: 'Wonderful, Thursday at 9 AM is yours! Looking forward to seeing you.' })]);
  assert.equal(r.l.lastReplyBy, 'rules');
  assert.equal(r.l.lastFallbackReason, 'text_rejected:booking_claim');
  assert.ok(r.l.messages.filter((m) => m.from === 'agent').every((m) => m.fallbackReason === 'text_rejected:booking_claim'));
  assert.doesNotMatch(JSON.stringify(r.l.messages.map((m) => m.fallbackReason)), /Thursday|yours/);
  r = await run([reply(call('send_reply', { text: 'Your first visit is free of charge today friend.' }))]);
  assert.match(r.l.lastFallbackReason, /^tool_rejected:(promise|free_offer)$/);
  r = await run([msg({ content: 'Visit evil.example for the best times and more.' })]);
  assert.equal(r.l.lastFallbackReason, 'text_rejected:link');
  r = await run([msg({ content: '<think>planning</think>' })]);
  assert.equal(r.l.lastFallbackReason, 'text_rejected:think');
  r = await run([reply(call('send_reply', { text: 'x'.repeat(700) }))]);
  assert.equal(r.l.lastFallbackReason, 'tool_rejected:too_long');
});

test('errors and limits: http status, timeout, offline, loop limit', async () => {
  let r = await run([{ status: 500, json: {} }]);
  assert.equal(r.l.lastFallbackReason, 'model_error:http_500');
  r = await run([{ hang: true }]);
  assert.equal(r.l.lastFallbackReason, 'model_timeout');
  const env = makeEnv({ config: cfgFor({ forceOffline: true }), llm: null });
  const l = await newLead(env);
  assert.equal(l.lastFallbackReason, 'offline');
  r = await run([reply(call('qualify_lead', { service: 'checkup', urgency: 'routine' }))]);
  assert.equal(r.l.lastReplyBy, 'rules');
  assert.equal(r.l.lastFallbackReason, 'loop_limit');
});

test('a model reply that is used has no fallback reason; signature exactly once; long text is cut at a sentence', async () => {
  let r = await run([reply(call('send_reply', { text: 'Happy to help. Which day works best for your cleaning?' }))]);
  assert.equal(r.l.lastFallbackReason, null);
  assert.equal(agentTexts(r.l)[0].match(/\(AI\)/g).length, 1);
  assert.ok(agentTexts(r.l)[0].endsWith(SIG));
  r = await run([msg({ content: `I'm the assistant (AI) here. Happy to help. Which day works best? - ${SIG}.` })]);
  assert.equal(agentTexts(r.l)[0].endsWith(SIG), true);
  assert.equal(agentTexts(r.l)[0].endsWith(`${SIG}.`), false);
  const long = `${'We can fit a cleaning and checkup this week and the visit takes about an hour. '.repeat(12)}`;
  r = await run([msg({ content: long })]);
  assert.equal(r.l.lastReplyBy, 'model');
  assert.ok(agentTexts(r.l)[0].length < 660);
  assert.match(agentTexts(r.l)[0], /hour\. - Brightwater/);
});

test('a server that rejects a forced tool_choice (400) is retried with "required", then remembered', async () => {
  const seen = [];
  const script = [(b) => { seen.push(b.tool_choice); return msg({ content: '' }); }, (b) => { seen.push(b.tool_choice); return typeof b.tool_choice === 'object' ? { status: 400, json: {}, body: 'tool_choice value is not supported' } : reply(call('send_reply', { text: 'Happy to help. Which day works best for your cleaning?' })); }];
  const llm = fakeLlm(script);
  const env = makeEnv({ llm });
  const l = await newLead(env);
  assert.equal(l.lastReplyBy, 'model');
  assert.deepEqual(seen.slice(0, 2), ['auto', { type: 'function', function: { name: 'send_reply' } }]);
  assert.equal(llm.toolChoiceSupport, 'required');
  assert.equal(llm.fetchMock.state.bodies.at(-1).tool_choice, 'required');
});

test('API: lead summary and detail carry the reason; /api/health counts reasons over the last hour', async () => {
  const llm = fakeLlm([msg({ content: 'Wonderful, Thursday at 9 AM is yours! Looking forward to seeing you.' })]);
  const s = await startServer({ llm, config: cfgFor() });
  try {
    const r = await post(s.base, '/api/leads', { name: 'Test Person', phone: '(615) 555-0111', source: 'Website form', message: 'I need a cleaning and checkup' });
    assert.ok(r.status === 200 || r.status === 202);
    const lead = s.store.leads.find((x) => x.name === 'Test Person');
    for (let i = 0; i < 100 && !lead.lastRunMode; i += 1) await new Promise((res) => setTimeout(res, 20));
    assert.equal(summary(lead, s.store).fallbackReason, 'text_rejected:booking_claim');
    assert.equal(detail(lead, s.store).fallbackReason, 'text_rejected:booking_claim');
    const h = await (await fetch(`${s.base}/api/health`)).json();
    assert.equal(h.fallbackReasons['text_rejected:booking_claim'], 1);
    assert.doesNotMatch(JSON.stringify(h), /Wonderful|yours/);
  } finally { await s.stop(); }
});

test('the dashboard says it in plain words and does not over-claim', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(src, /model reply was rejected: /);
  assert.match(src, /add\('Answered by', why \?/);
});
