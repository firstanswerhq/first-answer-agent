import test from 'node:test';
import assert from 'node:assert/strict';
import { Notifier, MAX_ALERTS_PER_HOUR } from '../src/notify.js';
import { Agent } from '../src/agent.js';
import { LeadService } from '../src/service.js';
import { Store } from '../src/store.js';
import { cfgFor, makeClock, WED_10AM, lead as leadInput, startServer, fakeLlm, call, reply } from './helpers.js';

const fakeTransport = (over = {}) => {
  const t = async (url, opts) => { t.calls.push({ url, opts }); if (over.throw) throw over.throw; if (over.hang) return new Promise((_r, rej) => opts.signal.addEventListener('abort', () => rej(Object.assign(new Error('x'), { name: 'AbortError' })))); return { ok: over.status ? over.status < 300 : true, status: over.status || 200 }; };
  t.calls = [];
  return t;
};
const quiet = () => {};

function build(notifierOpts, llm = null) {
  const clock = makeClock(WED_10AM, 5);
  const store = new Store();
  const config = cfgFor();
  const notifier = new Notifier({ now: clock.now, log: quiet, ...notifierOpts });
  const agent = new Agent({ store, config, llm, now: clock.now, notifier });
  const svc = new LeadService({ store, agent, config, now: clock.now });
  return { store, agent, svc, notifier, clock };
}
const angry = { message: 'This is the THIRD time I have called and I want a refund!!!', name: 'Pat Holloway', phone: '(615) 555-0118' };
const run = async (env, over = angry, opts = {}) => { const { lead, done } = env.svc.createLead(leadInput(over), opts); await done; await env.agent.settled(); return lead; };

test('notify: posts to ntfy with title, priority, tags and a short body without the phone number', async () => {
  const transport = fakeTransport();
  const env = build({ topic: 'secret-topic', dashboardUrl: 'https://dash.example/inbox', transport });
  const l = await run(env);
  assert.equal(transport.calls.length, 1);
  const { url, opts } = transport.calls[0];
  assert.equal(url, 'https://ntfy.sh/secret-topic');
  assert.equal(opts.method, 'POST');
  assert.equal(opts.headers.Priority, 'high');
  assert.ok(opts.headers.Title && opts.headers.Tags);
  assert.match(opts.body, /Brightwater/);
  assert.match(opts.body, /Pat needs a person/);
  assert.doesNotMatch(opts.body, /Holloway|555|0118/);
  assert.match(opts.body, /https:\/\/dash\.example\/inbox/);
  assert.ok(l.timeline.some((t) => t.kind === 'alert' && t.ok && /Alert sent to the owner's phone/.test(t.title)));
});

test('notify: urgent leads use urgent priority', async () => {
  const transport = fakeTransport();
  const env = build({ topic: 't', transport });
  await run(env, { message: 'His front tooth was knocked out and he is bleeding', name: 'Dana Whitfield' });
  assert.equal(transport.calls[0].opts.headers.Priority, 'urgent');
});

test('notify: no topic means no network call and an honest "not configured" step', async () => {
  const transport = fakeTransport();
  const env = build({ transport });
  const l = await run(env);
  assert.equal(transport.calls.length, 0);
  assert.ok(l.timeline.some((t) => t.kind === 'alert' && /Alert not configured/.test(t.title)));
  assert.ok(!l.timeline.some((t) => /Alert sent/.test(t.title)));
});

test('notify: offline mode (tests, FORCE_OFFLINE) never uses the network even with a topic', async () => {
  const real = globalThis.fetch; let hit = 0; globalThis.fetch = async () => { hit += 1; return { ok: true }; };
  try {
    const env = build({ topic: 't', offline: true });
    const l = await run(env);
    assert.equal(hit, 0);
    assert.ok(!l.timeline.some((t) => /Alert sent/.test(t.title)));
    assert.ok(l.timeline.some((t) => t.kind === 'alert' && /not sent/.test(t.title)));
  } finally { globalThis.fetch = real; }
});

test('notify: a failing or hanging transport never blocks the reply and is recorded as a failure', async () => {
  for (const over of [{ throw: new Error('boom') }, { status: 500 }]) {
    const env = build({ topic: 't', transport: fakeTransport(over) });
    const l = await run(env);
    assert.ok(l.messages.some((m) => m.from === 'agent'));
    const a = l.timeline.find((t) => t.kind === 'alert');
    assert.equal(a.ok, false);
    assert.doesNotMatch(a.title, /Alert sent/);
  }
  // Reply is delivered before a hung alert finishes.
  const env = build({ topic: 't', transport: fakeTransport({ hang: true }) });
  const { lead, done } = env.svc.createLead(leadInput(angry));
  await done;
  assert.ok(lead.messages.some((m) => m.from === 'agent'), 'reply exists while the alert is still pending');
  assert.equal(env.agent.pendingAlerts.size, 1);
  await env.agent.settled();
  assert.equal(lead.timeline.find((t) => t.kind === 'alert').ok, false);
});

test('notify: at most one alert per lead, and at most 20 per hour overall', async () => {
  const transport = fakeTransport();
  const env = build({ topic: 't', transport });
  const l = await run(env);
  const again = env.svc.addCustomerMessage(l.id, 'I want to speak to a manager now');
  await again.done; await env.agent.settled();
  assert.equal(transport.calls.length, 1);
  for (let i = 0; i < MAX_ALERTS_PER_HOUR + 3; i += 1) await run(env, { ...angry, name: `Pat${i} Smith` }, { ipKey: `v${i}` });
  assert.equal(transport.calls.length, MAX_ALERTS_PER_HOUR);
  assert.equal(env.notifier.status().alertsLastHour, MAX_ALERTS_PER_HOUR);
  env.clock.advance(3_700_000);
  assert.equal(env.notifier.status().alertsLastHour, 0);
});

test('notify: model-chosen escalation alerts too, and sample data never does', async () => {
  const transport = fakeTransport();
  const llm = fakeLlm([reply(call('qualify_lead', { service: 'checkup', urgency: 'routine' })), reply(call('escalate_to_human', { reason: 'Customer wants a custom plan', priority: 'normal' })), reply(call('send_reply', { text: 'A teammate will follow up.' })), reply()]);
  const env = build({ topic: 't', transport }, llm);
  await run(env, { message: 'I would like a checkup and a custom payment plan', name: 'Lee Park' });
  assert.equal(transport.calls.length, 1);
  const seed = build({ topic: 't', transport });
  const { lead, done } = seed.svc.createLead(leadInput(angry), { seed: true, simulated: true }); await done; await seed.agent.settled();
  assert.equal(transport.calls.length, 1);
  assert.ok(!lead.timeline.some((t) => t.kind === 'alert'));
});

test('notify: /api/health shows configured and alertsLastHour but never the topic', async () => {
  const s = await startServer({ config: cfgFor({ notify: { topic: 'my-secret-topic', dashboardUrl: '', offline: true } }) });
  try {
    const h = await (await fetch(s.base + '/api/health')).json();
    assert.deepEqual(h.notify, { configured: true, alertsLastHour: 0 });
    assert.doesNotMatch(JSON.stringify(h), /my-secret-topic/);
  } finally { await s.stop(); }
});

test('notify: the alert never carries model-written text (email, street address) and only fixed category text', async () => {
  const transport = fakeTransport();
  const llm = fakeLlm([
    reply(call('qualify_lead', { service: 'checkup', urgency: 'routine' })),
    reply(call('escalate_to_human', { reason: 'Customer jane.doe@gmail.com at 123 Oak Street 37203 wants a custom plan', priority: 'normal' })),
    reply(call('send_reply', { text: 'A teammate will follow up.' })), reply(),
  ]);
  const env = build({ topic: 't', transport }, llm);
  await run(env, { message: 'I would like a checkup, reach me at jane.doe@gmail.com, 123 Oak Street', name: 'Jane Doe' });
  assert.equal(transport.calls.length, 1);
  const sent = JSON.stringify(transport.calls[0]);
  assert.doesNotMatch(sent, /jane\.doe|gmail|Oak|37203|Doe/);
  assert.match(transport.calls[0].opts.body, /Reason: Needs a person/);
  assert.match(transport.calls[0].opts.body, /Jane needs a person/);
});

test('notify: per-visitor cap of 3 an hour, separate from the global cap of 20', async () => {
  const transport = fakeTransport();
  const env = build({ topic: 't', transport });
  for (let i = 0; i < 5; i += 1) await run(env, { ...angry, name: `Pat${i} Smith` }, { ipKey: 'same-visitor' });
  assert.equal(transport.calls.length, 3);
  await run(env, angry, { ipKey: 'other-visitor' });
  assert.equal(transport.calls.length, 4);
  env.clock.advance(3_700_000);
  await run(env, angry, { ipKey: 'same-visitor' });
  assert.equal(transport.calls.length, 5);
});

test('notify: demo scenario (simulated) leads never send an alert and say so', async () => {
  const transport = fakeTransport();
  const env = build({ topic: 't', transport });
  const { lead, done } = env.svc.createLead(leadInput(angry), { simulated: true, ipKey: 'v' });
  await done; await env.agent.settled();
  assert.equal(transport.calls.length, 0);
  assert.ok(lead.timeline.some((t) => t.kind === 'alert' && /demo scenario/.test(t.title)));
  assert.ok(!lead.timeline.some((t) => /Alert sent/.test(t.title)));
});

test('notify: DASHBOARD_URL must be https', async () => {
  const transport = fakeTransport();
  const env = build({ topic: 't', transport, dashboardUrl: 'http://insecure.example/x' });
  await run(env);
  assert.doesNotMatch(transport.calls[0].opts.body, /insecure/);
});

test('notify: the response body is cancelled', async () => {
  let cancelled = false;
  const transport = async () => ({ ok: true, status: 200, body: { cancel() { cancelled = true; } } });
  const env = build({ topic: 't', transport });
  await run(env);
  assert.equal(cancelled, true);
});
