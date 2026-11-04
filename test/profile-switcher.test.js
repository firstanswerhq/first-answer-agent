// "Switch business": the shipped example profiles side by side on one server, isolated and safe for a public deploy.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, post, cfgFor, makeClock, WED_10AM, fakeLlm, profileCfg } from './helpers.js';
import { Store } from '../src/store.js';

const settle = async (s) => { for (const p of s.tenants ?? []) void p; await Promise.all([...s.agent.chains.values()]); };
const get = (base, p, headers = {}) => fetch(base + p, { headers });
const json = async (r) => r.json();

test('/api/profiles lists the shipped examples and marks the default (dental)', async () => {
  const s = await startServer({ now: makeClock(WED_10AM).now });
  try {
    const r = await json(await get(s.base, '/api/profiles'));
    assert.equal(r.default, 'dental');
    assert.equal(r.switcher, true);
    assert.deepEqual(r.profiles.map((p) => p.id).sort(), ['accounting', 'dental', 'salon']);
    for (const p of r.profiles) { assert.ok(p.name && p.tagline && /^#[0-9a-f]{6}$/i.test(p.accent)); }
    assert.ok(!JSON.stringify(r).match(/\/tmp|state\.json|config\/profiles/));
  } finally { await s.stop(); }
});

test('the x-profile header and ?profile= load that business: name, colors, services, scenarios and sample leads', async () => {
  const s = await startServer({ now: makeClock(WED_10AM).now, config: { ...cfgFor(), seedOnEmpty: true } });
  try {
    const def = await json(await get(s.base, '/api/config'));
    assert.equal(def.profile, 'dental');
    for (const [id, name] of [['salon', 'Willow & Oak Hair Studio'], ['accounting', 'Cedar Ridge Tax & Bookkeeping']]) {
      const viaHeader = await json(await get(s.base, '/api/config', { 'x-profile': id }));
      const viaQuery = await json(await get(s.base, `/api/config?profile=${id}`));
      for (const c of [viaHeader, viaQuery]) {
        assert.equal(c.profile, id);
        assert.equal(c.business.name, name);
        assert.notEqual(c.business.accent, def.business.accent);
        assert.notDeepEqual(c.services.map((x) => x.id), def.services.map((x) => x.id));
      }
      const leads = await json(await get(s.base, '/api/leads', { 'x-profile': id }));
      assert.equal(leads.leads.filter((l) => l.seed).length, 8, 'each profile has its own sample leads');
      const sc = await json(await get(s.base, '/api/scenarios', { 'x-profile': id }));
      assert.equal(sc.length, 6);
    }
    const dentalLeads = await json(await get(s.base, '/api/leads'));
    const salonNames = new Set((await json(await get(s.base, '/api/leads', { 'x-profile': 'salon' }))).leads.map((l) => l.name));
    assert.ok(!dentalLeads.leads.some((l) => salonNames.has(l.name)), 'no lead from one profile shows in another');
  } finally { await s.stop(); }
});

test('only the whitelist is accepted: no path input, no unknown names, no odd types', async () => {
  const s = await startServer({ now: makeClock(WED_10AM).now });
  try {
    for (const bad of ['../../etc/passwd', '..%2f..%2fpackage', 'DENTAL/../salon', 'nope', 'dental.json', '%00', 'a'.repeat(300), 'constructor', '__proto__', 'toString']) {
      const r = await get(s.base, `/api/config?profile=${bad}`);
      assert.equal(r.status, 400, bad);
      const hv = decodeURIComponent(bad).replace(/\0/g, '');
      if (hv) assert.equal((await get(s.base, '/api/config', { 'x-profile': hv })).status, 400, `header ${bad}`);
    }
    assert.equal((await get(s.base, '/api/config?profile[]=salon')).status, 400);
    assert.equal((await get(s.base, '/api/config?profile=Salon')).status, 200, 'case is normalized, still from the list');
    assert.equal((await get(s.base, '/api/config?profile=')).status, 200, 'empty means the default');
    // Only 3 state stores can ever exist, whatever is requested.
    for (let i = 0; i < 20; i += 1) await get(s.base, `/api/config?profile=x${i}`);
    assert.equal((await json(await get(s.base, '/api/profiles'))).profiles.length, 3);
  } finally { await s.stop(); }
});

test('profile state is isolated: leads, bookings, tokens and resets never cross over', async () => {
  const clock = makeClock(WED_10AM, 5);
  const s = await startServer({ now: clock.now, config: { ...cfgFor(), limits: { ...cfgFor().limits, resetCooldownMs: 0 } } });
  try {
    const lead = { name: 'Isolated Visitor', phone: '(615) 555-0188', message: 'I would like a haircut please', source: 'Facebook' };
    const created = await json(await post(s.base, '/api/leads', lead, { 'x-profile': 'salon' }));
    const salon = await s.tenant('salon');
    await Promise.all([...salon.agent.chains.values()]);
    assert.ok(salon.store.getLead(created.id));
    assert.equal(s.store.getLead(created.id), null, 'not in the default (dental) store');
    // The token only works in its own profile.
    assert.equal((await get(s.base, `/api/public/leads/${created.id}?token=${created.token}`, { 'x-profile': 'salon' })).status, 200);
    assert.equal((await get(s.base, `/api/public/leads/${created.id}?token=${created.token}`)).status, 404);
    assert.equal((await get(s.base, `/api/public/leads/${created.id}?token=${created.token}`, { 'x-profile': 'accounting' })).status, 404);
    assert.equal((await get(s.base, `/api/leads/${created.id}`)).status, 404);
    // Book in salon; the dental calendar is untouched.
    await post(s.base, `/api/public/leads/${created.id}/messages`, { token: created.token, text: 'The first one works for me.' }, { 'x-profile': 'salon' });
    await Promise.all([...salon.agent.chains.values()]);
    assert.ok(salon.store.bookingForLead(created.id));
    assert.equal(s.store.bookings.filter((b) => b.name === 'Isolated Visitor').length, 0);
    // Resetting the dental sample day leaves the salon lead alone, and the other way round.
    assert.equal((await post(s.base, '/api/demo/reset', {})).status, 200);
    assert.ok(salon.store.getLead(created.id));
    assert.equal((await post(s.base, '/api/demo/reset', {}, { 'x-profile': 'salon' })).status, 200);
    assert.ok(salon.store.getLead(created.id), 'visitor lead survives a reset in its own profile too');
    const cal = await json(await get(s.base, '/api/calendar', { 'x-profile': 'salon' }));
    assert.equal(cal.days.flatMap((d) => d.slots).filter((x) => x.status === 'booked').length > 0, true);
  } finally { await s.stop(); }
});

test('the model budget is shared across profiles, so switching cannot multiply it', async () => {
  const ok = (name, args, id) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
  const llm = fakeLlm([() => ({ status: 200, json: { model: 'm', choices: [{ message: { role: 'assistant', content: 'done' } }] } })]);
  const cfg = cfgFor({ inference: { ...cfgFor().inference, key: 'k', maxRunsPerHour: 2, model: 'fake-model-1' } });
  const s = await startServer({ llm, config: cfg, now: makeClock(WED_10AM, 5).now });
  try {
    for (const id of ['dental', 'salon', 'accounting', 'dental']) {
      await post(s.base, '/api/leads', { name: 'Budget Test', phone: '(615) 555-0111', message: 'hello there', source: 'Facebook' }, { 'x-profile': id });
      const t = await s.tenant(id);
      await Promise.all([...t.agent.chains.values()]);
    }
    assert.equal(s.shared.modelRunStamps.length, 2, 'two model runs in total across three profiles');
    assert.equal(llm.fetchMock.state.calls.length >= 1, true);
    const h = await json(await get(s.base, '/api/health', { 'x-profile': 'accounting' }));
    assert.equal(h.quotaReached, true);
  } finally { await s.stop(); }
  void ok;
});

test('state files are separate per profile and the switcher can be turned off', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-sw-'));
  const file = path.join(dir, 'state.json');
  const s = await startServer({ config: { ...cfgFor(), dataFile: file, seedOnEmpty: true }, store: new Store({ file }), now: makeClock(WED_10AM).now });
  try {
    await get(s.base, '/api/config?profile=salon');
    await s.tenant('salon');
  } finally { await s.stop(); }
  assert.ok(fs.existsSync(file));
  assert.ok(fs.existsSync(path.join(dir, 'state-salon.json')));
  assert.ok(!fs.existsSync(path.join(dir, 'state-accounting.json')), 'only profiles that were opened get a state file');
  fs.rmSync(dir, { recursive: true, force: true });

  const off = await startServer({ config: { ...cfgFor(), profileSwitcher: false }, now: makeClock(WED_10AM).now });
  try {
    const r = await json(await get(off.base, '/api/profiles'));
    assert.equal(r.switcher, false);
    assert.equal(r.profiles.length, 1);
    assert.equal((await get(off.base, '/api/config?profile=salon')).status, 400);
  } finally { await off.stop(); }
});

test('a deployment that runs its own custom profile keeps it as the default and still offers the shipped examples', async () => {
  const s = await startServer({ config: profileCfg('salon'), now: makeClock(WED_10AM).now });
  try {
    const r = await json(await get(s.base, '/api/profiles'));
    assert.equal(r.default, 'salon');
    assert.equal((await json(await get(s.base, '/api/config'))).profile, 'salon');
    assert.equal((await json(await get(s.base, '/api/config?profile=dental'))).profile, 'dental');
  } finally { await s.stop(); }
});

test('profile requests are rate limited like every other read', async () => {
  const s = await startServer({ config: { ...cfgFor(), limits: { ...cfgFor().limits, readRate: { windowMs: 60_000, max: 5 } } }, now: makeClock(WED_10AM).now });
  try {
    const codes = [];
    for (let i = 0; i < 8; i += 1) codes.push((await get(s.base, '/api/config?profile=salon')).status);
    assert.ok(codes.includes(429), codes.join());
  } finally { await s.stop(); }
});
void settle;
