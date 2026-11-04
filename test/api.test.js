import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { seedSample } from '../src/seed.js';
import { startServer, post, cfgFor, lead, makeClock, WED_10AM } from './helpers.js';

const j = async (r) => ({ status: r.status, body: await r.json() });
const settle = (s) => Promise.all([...s.agent.chains.values()]);

test('GET /api/health reports mode, model, version and uptime without secrets', async () => {
  const s = await startServer();
  try {
    const { status, body } = await j(await fetch(s.base + '/api/health'));
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.mode, 'offline');
    assert.equal(body.model, null);
    assert.match(body.version, /^\d+\.\d+\.\d+$/);
    assert.equal(typeof body.uptimeSec, 'number');
    assert.equal(body.token, undefined);
    assert.ok(!Object.keys(body).some((k) => /^(key|secret|apikey)/i.test(k)));
  } finally { await s.stop(); }
});

test('POST /api/leads: valid lead is accepted, agent answers, reply time is measured', async () => {
  const s = await startServer();
  try {
    const r = await post(s.base, '/api/leads', lead());
    const { status, body } = await j(r);
    assert.equal(status, 202);
    assert.match(body.id, /^L-[0-9a-f]{8}$/);
    assert.ok(body.token.length >= 32);
    await settle(s);
    const d = await j(await fetch(`${s.base}/api/leads/${body.id}`));
    assert.equal(d.body.lead.status, 'replied');
    assert.equal(typeof d.body.lead.replyTimeSec, 'number');
    assert.ok(d.body.lead.timeline.length >= 5);
    assert.equal(d.body.lead.token, undefined, 'the public token is never sent to the dashboard');
  } finally { await s.stop(); }
});

test('POST /api/leads: validation rejects bad input', async () => {
  const s = await startServer();
  try {
    for (const bad of [{}, lead({ name: '' }), lead({ phone: '123' }), lead({ phone: 'call me maybe' }), lead({ message: '' }), lead({ message: 'x'.repeat(1001) }), lead({ name: 'n'.repeat(81) }), { ...lead(), name: 42 }, []]) {
      const r = await post(s.base, '/api/leads', bad);
      assert.equal(r.status, 400, JSON.stringify(bad).slice(0, 60));
      assert.ok((await r.json()).error);
    }
    assert.equal(s.store.leads.length, 0);
  } finally { await s.stop(); }
});

test('POST /api/leads: malformed JSON and oversized bodies are rejected cleanly', async () => {
  const s = await startServer();
  try {
    assert.equal((await post(s.base, '/api/leads', '{nope')).status, 400);
    assert.equal((await post(s.base, '/api/leads', JSON.stringify({ ...lead(), message: 'y'.repeat(20000) }))).status, 413);
  } finally { await s.stop(); }
});

test('POST /api/leads: unknown sources are normalized to Other and html is stored as inert text', async () => {
  const s = await startServer();
  try {
    const r = await j(await post(s.base, '/api/leads', lead({ source: '<script>alert(1)</script>', name: '<b>Bob</b>' })));
    await settle(s);
    const l = s.store.getLead(r.body.id);
    assert.equal(l.source, 'Other');
    assert.equal(l.name, '<b>Bob</b>', 'stored verbatim; the UI escapes on render');
  } finally { await s.stop(); }
});

test('rate limiting: the public lead endpoint returns 429 after the configured burst', async () => {
  const config = cfgFor();
  config.limits.leadRate = { windowMs: 60_000, max: 3 };
  const s = await startServer({ config });
  try {
    const codes = [];
    for (let i = 0; i < 5; i += 1) codes.push((await post(s.base, '/api/leads', lead({ message: 'need work' }))).status);
    assert.deepEqual(codes, [202, 202, 202, 429, 429]);
    const r = await post(s.base, '/api/leads', lead());
    assert.ok(r.headers.get('retry-after'));
  } finally { await s.stop(); }
});

test('customer-reply continues the conversation and books through the API', async () => {
  const s = await startServer();
  try {
    const { body } = await j(await post(s.base, '/api/leads', lead()));
    await settle(s);
    const r = await post(s.base, `/api/leads/${body.id}/customer-reply`, { text: 'The first one works', token: body.token });
    assert.equal(r.status, 202);
    await settle(s);
    const d = await j(await fetch(`${s.base}/api/leads/${body.id}`));
    assert.equal(d.body.lead.status, 'booked');
    assert.ok(d.body.lead.booking);
    assert.equal((await post(s.base, `/api/leads/${body.id}/customer-reply`, { text: '', token: body.token })).status, 400);
    assert.equal((await post(s.base, '/api/leads/L-deadbeef/customer-reply', { text: 'hi', token: 'x'.repeat(32) })).status, 404);
    assert.equal((await post(s.base, '/api/leads/not-an-id/customer-reply', { text: 'hi', token: 'x'.repeat(32) })).status, 404);
  } finally { await s.stop(); }
});

test('public thread needs the secret token and exposes messages only', async () => {
  const s = await startServer();
  try {
    const { body } = await j(await post(s.base, '/api/leads', lead()));
    await settle(s);
    assert.equal((await fetch(`${s.base}/api/public/leads/${body.id}`)).status, 404);
    assert.equal((await fetch(`${s.base}/api/public/leads/${body.id}?token=wrong`)).status, 404);
    const ok = await j(await fetch(`${s.base}/api/public/leads/${body.id}?token=${body.token}`));
    assert.equal(ok.status, 200);
    assert.equal(ok.body.messages.length, 2);
    assert.equal(ok.body.timeline, undefined);
    assert.equal(ok.body.qualification, undefined);
    const m = await post(s.base, `/api/public/leads/${body.id}/messages`, { token: body.token, text: 'first one' });
    assert.equal(m.status, 202);
    assert.equal((await post(s.base, `/api/public/leads/${body.id}/messages`, { token: 'nope', text: 'x' })).status, 404);
  } finally { await s.stop(); }
});

test('POST /api/simulate runs each fictional scenario through the agent', async () => {
  const s = await startServer();
  try {
    const list = await j(await fetch(s.base + '/api/scenarios'));
    assert.ok(list.body.length >= 5);
    const statuses = {};
    for (const sc of list.body) {
      const r = await j(await post(s.base, '/api/simulate', { scenario: sc.id }));
      assert.equal(r.status, 202, sc.id);
      await settle(s);
      statuses[sc.id] = s.store.getLead(r.body.id).status;
    }
    assert.equal(statuses.urgent, 'human');
    assert.equal(statuses.angry, 'human');
    assert.equal(statuses.injection, 'human');
    assert.equal(statuses.price_question, 'replied');
    assert.equal(statuses.vague, 'replied');
    assert.equal((await post(s.base, '/api/simulate', { scenario: 'nope' })).status, 400);
  } finally { await s.stop(); }
});

test('GET /api/calendar shows real bookings and open slots for a week (Mon-Sat)', async () => {
  const s = await startServer({ now: makeClock(WED_10AM).now });
  try {
    const { body } = await j(await post(s.base, '/api/leads', lead()));
    await settle(s);
    await post(s.base, `/api/leads/${body.id}/customer-reply`, { text: 'first', token: body.token });
    await settle(s);
    const cal = await j(await fetch(s.base + '/api/calendar'));
    assert.equal(cal.body.start, '2026-11-02');
    assert.equal(cal.body.days.length, 6);
    const all = cal.body.days.flatMap((d) => d.slots);
    assert.equal(all.filter((x) => x.status === 'booked').length, 1);
    assert.ok(all.some((x) => x.status === 'open'));
    assert.equal((await j(await fetch(s.base + '/api/calendar?start=2026-11-16'))).body.start, '2026-11-16');
    assert.equal((await j(await fetch(s.base + '/api/calendar?start=garbage'))).body.start, '2026-11-02');
  } finally { await s.stop(); }
});

test('GET /api/metrics is computed from stored leads only', async () => {
  const s = await startServer();
  try {
    assert.equal((await j(await fetch(s.base + '/api/metrics'))).body.avgReplySec, null);
    await post(s.base, '/api/leads', lead());
    await post(s.base, '/api/leads', lead({ name: 'Angry Al', message: 'This is unacceptable, I want a refund' }));
    await settle(s);
    const m = (await j(await fetch(s.base + '/api/metrics'))).body;
    assert.equal(m.totalLeads, 2);
    assert.equal(m.answered, 2);
    assert.equal(m.human, 1);
    assert.equal(m.booked, 0);
    assert.equal(m.chart.length, 2);
    assert.equal(m.liveLeads, 2);
  } finally { await s.stop(); }
});

test('seed: loads a believable sample day with bookings, replies and human handoffs; live runs append', async () => {
  const config = cfgFor({ seedOnEmpty: true });
  const s = await startServer({ config });
  try {
    const leads = (await j(await fetch(s.base + '/api/leads'))).body.leads;
    assert.ok(leads.length >= 6 && leads.length <= 8);
    const st = new Set(leads.map((l) => l.status));
    for (const x of ['replied', 'booked', 'human']) assert.ok(st.has(x), x);
    assert.ok(leads.every((l) => l.seed));
    await post(s.base, '/api/leads', lead());
    await settle(s);
    const m = (await j(await fetch(s.base + '/api/metrics?scope=live'))).body;
    assert.equal(m.totalLeads, 1);
    assert.equal((await j(await fetch(s.base + '/api/metrics?scope=all'))).body.totalLeads, leads.length + 1);
  } finally { await s.stop(); }
});

test('seed is idempotent and force re-seeds from scratch', async () => {
  const store = new Store();
  const config = cfgFor();
  assert.equal(await seedSample(store, config), true);
  const n = store.leads.length;
  assert.equal(await seedSample(store, config), false);
  assert.equal(store.leads.length, n);
  assert.equal(await seedSample(store, config, { force: true }), true);
  assert.equal(store.leads.length, n);
});

test('static pages, security headers and 404 handling', async () => {
  const s = await startServer();
  try {
    for (const p of ['/', '/lead', '/app.js', '/app.css', '/design-base.css']) assert.equal((await fetch(s.base + p)).status, 200, p);
    const r = await fetch(s.base + '/');
    assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('x-powered-by'), null);
    assert.equal((await fetch(s.base + '/api/nope')).status, 404);
  } finally { await s.stop(); }
});

test('store: snapshot is written atomically and reloads; a corrupt file does not crash startup', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-'));
  const file = path.join(dir, 'state.json');
  const a = new Store({ file, debounceMs: 1 });
  a.addLead({ id: 'L-00000001', messages: [], timeline: [] });
  await a.flush();
  assert.ok(fs.existsSync(file));
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), []);
  assert.equal(new Store({ file }).leads.length, 1);
  fs.writeFileSync(file, '{broken');
  const b = new Store({ file });
  assert.equal(b.leads.length, 0);
  assert.ok(fs.readdirSync(dir).some((f) => f.includes('corrupt')));
});

test('store: keeps the lead list bounded', () => {
  const st = new Store();
  for (let i = 0; i < 12; i += 1) st.addLead({ id: `L-${i}`, messages: [], timeline: [] }, 10);
  assert.equal(st.leads.length, 10);
});

test('deploy script: valid bash, no hard-coded secrets, firewall 22/80, 2-minute timer, env file from variables', async () => {
  const { execFileSync } = await import('node:child_process');
  const file = path.join(cfgFor().root, 'deploy', 'cloud-init.sh');
  execFileSync('bash', ['-n', file]);
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /REPO_URL="\$\{REPO_URL:-https:\/\/github\.com\/firstanswerhq\/first-answer-agent\}"/);
  assert.match(text, /ufw allow 22\/tcp/);
  assert.match(text, /ufw allow 80\/tcp/);
  assert.match(text, /OnUnitActiveSec=2min/);
  assert.match(text, /\/etc\/first-answer-agent\.env/);
  assert.match(text, /VULTR_INFERENCE_KEY="\$\(q "\$VULTR_INFERENCE_KEY"\)"/);
  assert.doesNotMatch(text, /(sk-|vultr_[a-z0-9]{12,}|[A-Z0-9]{32,})/);
  assert.doesNotMatch(text, /VULTR_INFERENCE_KEY="[^$"]+/);
});

test('no secrets or env files are tracked or present in the repo tree', () => {
  const root = cfgFor().root;
  const gi = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
  assert.match(gi, /^\.env/m);
  assert.match(gi, /^data\//m);
  for (const f of ['.env', '.env.local']) assert.equal(fs.existsSync(path.join(root, f)), false);
});

test('customer-reply requires the per-lead token; wrong or missing token is a 404 and changes nothing', async () => {
  const s = await startServer();
  try {
    const { body } = await j(await post(s.base, '/api/leads', lead()));
    await settle(s);
    const before = s.store.getLead(body.id).messages.length;
    assert.equal((await post(s.base, `/api/leads/${body.id}/customer-reply`, { text: 'hijack' })).status, 404);
    assert.equal((await post(s.base, `/api/leads/${body.id}/customer-reply`, { text: 'hijack', token: 'wrong' })).status, 404);
    assert.equal(s.store.getLead(body.id).messages.length, before);
    const viaHeader = await post(s.base, `/api/leads/${body.id}/customer-reply`, { text: 'first one' }, { 'X-Lead-Token': body.token });
    assert.equal(viaHeader.status, 202);
  } finally { await s.stop(); }
});

test('lead list and detail mask phone numbers for live leads; sample leads and the demo token stay open', async () => {
  const clock = makeClock(WED_10AM);
  const store = new Store();
  const config = cfgFor();
  await seedSample(store, config, { realNow: clock.now() });
  const s = await startServer({ store, config, now: clock.now });
  try {
    const { body } = await j(await post(s.base, '/api/leads', lead({ phone: '(615) 555-0188' })));
    await settle(s);
    const list = (await j(await fetch(s.base + '/api/leads'))).body.leads;
    const live = list.find((l) => l.id === body.id);
    assert.equal(live.phone, '(***) ***-0188');
    assert.ok(!JSON.stringify(list.filter((l) => !l.seed)).includes('555-0188'));
    const det = (await j(await fetch(`${s.base}/api/leads/${body.id}`))).body.lead;
    assert.equal(det.phone, '(***) ***-0188');
    assert.equal(det.demoToken, undefined);
    assert.equal(det.token, undefined);
    const seedLead = list.find((l) => l.seed);
    assert.match(seedLead.phone, /^\(615\) 555-01/);
    const seedDet = (await j(await fetch(`${s.base}/api/leads/${seedLead.id}`))).body.lead;
    assert.ok(seedDet.demoToken);
    const r = await post(s.base, `/api/leads/${seedLead.id}/customer-reply`, { text: 'Thanks', token: seedDet.demoToken });
    assert.equal(r.status, 202);
  } finally { await s.stop(); }
});

test('simulate returns a token that unlocks role-play for that simulated lead only', async () => {
  const s = await startServer();
  try {
    const a = await j(await post(s.base, '/api/simulate', { scenario: 'price_question' }));
    const b = await j(await post(s.base, '/api/simulate', { scenario: 'price_question' }));
    await settle(s);
    assert.equal((await post(s.base, `/api/leads/${a.body.id}/customer-reply`, { text: 'first', token: b.body.token })).status, 404);
    assert.equal((await post(s.base, `/api/leads/${a.body.id}/customer-reply`, { text: 'first', token: a.body.token })).status, 202);
  } finally { await s.stop(); }
});

test('TRUST_PROXY: off by default, parsed from the environment, and rate limits follow X-Forwarded-For only when on', async () => {
  const { loadConfig, parseTrustProxy } = await import('../src/config.js');
  assert.equal(parseTrustProxy(undefined), false);
  assert.equal(parseTrustProxy(''), false);
  assert.equal(parseTrustProxy('0'), false);
  assert.equal(parseTrustProxy('1'), 1);
  assert.equal(parseTrustProxy('true'), 1);
  assert.equal(parseTrustProxy('2'), 2);
  assert.equal(parseTrustProxy('garbage'), false);
  assert.equal(loadConfig({ TRUST_PROXY: '1' }).trustProxy, 1);
  const hit = async (s, ip) => (await post(s.base, '/api/leads', lead({ message: 'need work' }), { 'X-Forwarded-For': ip })).status;
  const off = await startServer({ config: cfgFor({ limits: { ...cfgFor().limits, leadRate: { windowMs: 60_000, max: 1 } } }) });
  try { assert.equal(await hit(off, '1.1.1.1'), 202); assert.equal(await hit(off, '2.2.2.2'), 429, 'header ignored: same client'); } finally { await off.stop(); }
  const on = await startServer({ config: cfgFor({ trustProxy: 1, limits: { ...cfgFor().limits, leadRate: { windowMs: 60_000, max: 1 } } }) });
  try { assert.equal(await hit(on, '1.1.1.1'), 202); assert.equal(await hit(on, '2.2.2.2'), 202, 'different forwarded clients'); assert.equal(await hit(on, '2.2.2.2'), 429); } finally { await on.stop(); }
});

test('read rate limit default leaves room for normal dashboard polling behind a shared address', async () => {
  const { loadConfig } = await import('../src/config.js');
  assert.ok(loadConfig({}).limits.readRate.max >= 1200);
});

test('metrics: default scope excludes simulated sample leads; measured median reports live runs only', async () => {
  const config = cfgFor({ seedOnEmpty: true });
  const s = await startServer({ config });
  try {
    const empty = (await j(await fetch(s.base + '/api/metrics'))).body;
    assert.equal(empty.scope, 'live');
    assert.equal(empty.totalLeads, 0);
    assert.equal(empty.medianReplySec, null);
    assert.equal(empty.measured.answered, 0);
    assert.equal(empty.measured.medianSec, null);
    assert.equal(empty.today.answered, 0, 'sample leads never count toward today');
    assert.ok(empty.sampleLeads >= 6, 'sample leads exist but are reported separately');
    await post(s.base, '/api/leads', lead());
    await settle(s);
    const m = (await j(await fetch(s.base + '/api/metrics'))).body;
    assert.equal(m.measured.answered, 1);
    assert.equal(m.measured.rules.answered, 1);
    assert.equal(m.measured.model.answered, 0);
    assert.equal(typeof m.measured.medianSec, 'number');
    const all = (await j(await fetch(s.base + '/api/metrics?scope=all'))).body;
    assert.ok(all.answered > m.answered);
    assert.equal(all.measured.answered, 1, 'measured stats never include the sample day');
  } finally { await s.stop(); }
});
