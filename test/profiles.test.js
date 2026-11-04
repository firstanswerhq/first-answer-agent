import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadProfile, compileProfile, listProfiles, ProfileError, DEFAULT_PROFILE } from '../src/profile.js';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { seedSample } from '../src/seed.js';
import { toolDefs } from '../src/functions.js';
import { isRealSlot } from '../src/calendar.js';
import { PROFILE_NAMES, profileCfg, makeEnv, makeClock, WED_10AM, fakeLlm, reply, call, startServer, post, say, agentTexts, fnNames } from './helpers.js';

const root = path.resolve(import.meta.dirname, '..');
const scenario = (cfg, id) => cfg.profile.scenarios.find((s) => s.id === id);
const run = async (env, lead) => { const { lead: l, done } = env.svc.createLead(lead); await done; return l; };

test('three profiles ship, in clearly different businesses, and the default is one of them', () => {
  assert.deepEqual(PROFILE_NAMES, ['accounting', 'dental', 'salon']);
  assert.ok(PROFILE_NAMES.includes(DEFAULT_PROFILE));
  assert.equal(loadConfig({}).profile.id, DEFAULT_PROFILE, 'BUSINESS_PROFILE unset means the default');
  assert.equal(loadConfig({ BUSINESS_PROFILE: 'salon' }).business.name, 'Willow & Oak Hair Studio');
  const names = new Set(PROFILE_NAMES.map((n) => loadProfile(n).business.name));
  assert.equal(names.size, 3);
});

test('profile loading rejects unknown, unsafe and malformed profiles with a clear message', () => {
  assert.throws(() => loadProfile('nope'), /was not found in config\/profiles/);
  assert.throws(() => loadProfile('../package'), /not a valid profile name/);
  assert.throws(() => loadProfile('a/b'), /not a valid profile name/);
  const good = JSON.parse(fs.readFileSync(path.join(root, 'config', 'profiles', 'dental.json'), 'utf8'));
  const bad = (mut) => { const c = structuredClone(good); mut(c); return () => compileProfile(c); };
  assert.throws(bad((c) => { c.services = []; }), ProfileError);
  assert.throws(bad((c) => { c.services[1].id = c.services[0].id; }), /duplicate service id/);
  assert.throws(bad((c) => { c.services[0].price = { low: 9, high: 1 }; }), /low <= high/);
  assert.throws(bad((c) => { c.hours.starts['1'] = ['23:00']; }), /fit inside hours.open/);
  assert.throws(bad((c) => { c.business.tz = 'Mars/Base'; }), /time zone/);
  assert.throws(bad((c) => { c.urgency.emergencyPhrases = ['(unclosed']; }), /bad pattern/);
  assert.throws(bad((c) => { delete c.wording.noQuote; }), /wording.noQuote/);
  assert.doesNotThrow(bad(() => {}));
});

for (const name of PROFILE_NAMES) {
  test(`[${name}] price question: qualifies, offers real times with the profile's price wording, schedules a follow-up, books on reply`, async () => {
    const cfg = profileCfg(name);
    const env = makeEnv({ config: cfg });
    const l = await run(env, scenario(cfg, 'price_question').lead);
    assert.equal(l.status, 'replied');
    assert.deepEqual(fnNames(l), ['qualify_lead', 'check_calendar', 'send_reply', 'schedule_followup']);
    const svc = cfg.services.find((x) => x.id === l.qualification.service);
    assert.ok(svc, 'a service from this profile was recognized');
    const text = agentTexts(l)[0];
    if (svc.price) assert.match(text, new RegExp(`\\$${svc.price.low}-\\$${svc.price.high}`)); else assert.ok(text.includes(cfg.wording.noQuote));
    assert.ok(text.includes(cfg.business.agentName));
    assert.equal(l.offeredSlots.length, 3);
    assert.ok(l.offeredSlots.every((s) => isRealSlot(s, cfg.hours)));
    await say(env, l, 'The first one works');
    assert.equal(l.status, 'booked');
    assert.match(agentTexts(l).at(-1), new RegExp(`Booked, .*${cfg.wording.bookedAfter.slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  });

  test(`[${name}] urgent situation is handed to a person, flagged urgent, with the profile's safety note and no calendar slot`, async () => {
    const cfg = profileCfg(name);
    const env = makeEnv({ config: cfg });
    const l = await run(env, scenario(cfg, 'urgent').lead);
    assert.equal(l.status, 'human');
    assert.equal(l.priority, 'urgent');
    assert.ok(agentTexts(l)[0].includes(cfg.profile.urgency.safetyNote));
    assert.equal(env.store.bookingForLead(l.id), null);
    assert.ok(l.timeline.some((t) => t.fn === 'escalate_to_human' && t.args?.priority === 'urgent'));
  });

  test(`[${name}] angry customer and prompt injection are escalated, never booked, never given a price or a promise`, async () => {
    const cfg = profileCfg(name);
    const env = makeEnv({ config: cfg });
    const angry = await run(env, scenario(cfg, 'angry').lead);
    assert.equal(angry.status, 'human');
    assert.ok(!fnNames(angry).includes('book_appointment') && !fnNames(angry).includes('check_calendar'));
    const inj = await run(env, scenario(cfg, 'injection').lead);
    assert.equal(inj.status, 'human');
    assert.equal(env.store.bookings.length, 0);
    assert.doesNotMatch(agentTexts(inj).join(' '), /\$1\b|system prompt|free/i);
    assert.ok(inj.timeline.some((t) => t.kind === 'guard' && /injection/i.test(t.title)));
  });

  test(`[${name}] after-hours request is answered but offered only real in-hours times; vague message gets one question`, async () => {
    const cfg = profileCfg(name);
    const env = makeEnv({ config: cfg });
    const late = await run(env, scenario(cfg, 'after_hours').lead);
    assert.equal(late.status, 'replied');
    assert.match(agentTexts(late)[0], /business hours/);
    assert.ok(late.offeredSlots.every((s) => isRealSlot(s, cfg.hours)));
    assert.equal(env.store.bookingForLead(late.id), null);
    const vague = await run(env, scenario(cfg, 'vague').lead);
    assert.equal(vague.status, 'replied');
    assert.ok(agentTexts(vague)[0].includes(cfg.wording.askService.replace(/\?$/, '')));
    assert.equal(env.store.followups.filter((f) => f.leadId === vague.id && f.status === 'pending').length, 1);
  });

  test(`[${name}] the profile's always-human topics and out-of-scope services escalate`, async () => {
    const cfg = profileCfg(name);
    const env = makeEnv({ config: cfg });
    const topic = cfg.profile.alwaysHuman[0];
    const phrase = topic.phrases[0].trim();
    const l = await run(env, { name: 'Topic Test', phone: '(615) 555-0190', source: 'Website form', message: `Question about ${phrase} before I book.` });
    assert.equal(l.status, 'human', `${name}: ${phrase}`);
    assert.match(l.humanReason, new RegExp(topic.label.slice(0, 15)));
    const oos = await run(env, { name: 'Scope Test', phone: '(615) 555-0191', source: 'Website form', message: `Do you offer ${cfg.profile.outOfScope[0]}?` });
    assert.equal(oos.status, 'human');
  });

  test(`[${name}] sample day: believable leads across Replied, Booked and Needs a Human, all on real calendar slots`, async () => {
    const cfg = profileCfg(name);
    const store = new Store();
    const clock = makeClock(WED_10AM);
    await seedSample(store, cfg, { realNow: clock.now() });
    assert.equal(store.leads.length, cfg.profile.seed.length);
    const statuses = new Set(store.leads.map((l) => l.status));
    for (const s of ['replied', 'booked', 'human']) assert.ok(statuses.has(s), `${name} sample has ${s}`);
    assert.ok(store.bookings.every((b) => isRealSlot(b.slot_id, cfg.hours)), 'every sample booking is on a real slot');
    assert.equal(new Set(store.bookings.map((b) => b.slot_id)).size, store.bookings.length, 'no double bookings');
    assert.ok(store.bookings.filter((b) => b.kind === 'existing').length >= 3);
    assert.ok(store.bookings.every((b) => b.sample));
  });

  test(`[${name}] model path: prompt, tool definitions and qualify enum all come from the profile`, async () => {
    const cfg = profileCfg(name);
    const llm = fakeLlm([reply(call('qualify_lead', { service: cfg.services[0].id, urgency: 'routine' })), reply()]);
    const env = makeEnv({ llm, config: cfg });
    await run(env, scenario(cfg, 'price_question').lead);
    const body = llm.fetchMock.state.bodies[0];
    const prompt = body.messages[0].content;
    assert.ok(prompt.includes(cfg.business.name) && prompt.includes(cfg.business.description));
    for (const svc of cfg.services) assert.ok(prompt.includes(svc.id) && prompt.includes(svc.label), svc.id);
    assert.ok(prompt.includes(cfg.profile.urgency.safetyNote));
    assert.ok(prompt.includes(cfg.hours.text));
    const qualify = body.tools.find((t) => (t.function || t).name === 'qualify_lead');
    const props = (qualify.function || qualify).parameters.properties;
    assert.deepEqual(props.service.enum, [...cfg.services.map((x) => x.id), 'other']);
    assert.equal('location' in props, false, 'no location for a business without a service area');
    assert.equal(toolDefs(cfg).length, 6);
  });

  test(`[${name}] API: /api/config carries the profile and its scenarios, and simulate runs each one`, async () => {
    const cfg = profileCfg(name);
    const s = await startServer({ config: cfg });
    try {
      const c = await (await fetch(s.base + '/api/config')).json();
      assert.equal(c.profile, name);
      assert.equal(c.business.name, cfg.business.name);
      assert.equal(c.services.length, cfg.services.length);
      assert.equal(c.hoursText, cfg.hours.text);
      assert.equal(c.wording.formPlaceholder, cfg.wording.formPlaceholder);
      assert.equal(c.serviceArea, null);
      const list = await (await fetch(s.base + '/api/scenarios')).json();
      assert.deepEqual(list.map((x) => x.id), cfg.profile.scenarios.map((x) => x.id));
      for (const sc of list) {
        const r = await post(s.base, '/api/simulate', { scenario: sc.id });
        assert.equal(r.status, 202, sc.id);
      }
    } finally { await s.stop(); }
  });
}

test('nothing in the code, UI, profiles, scripts or docs assumes one trade', () => {
  const banned = /\b(roof(ing|er|s)?|gutters?|plumb(er|ing)?|hvac|harbor lane|home[- ]service|handyman|contractor)\b/i;
  const files = [];
  const walk = (dir) => { for (const f of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, f.name); if (f.isDirectory()) { if (!['node_modules', '.git', 'screenshots'].includes(f.name)) walk(p); } else if (/\.(js|html|css|json|sh|py|md|example)$/.test(f.name) && f.name !== 'package-lock.json') files.push(p); } };
  for (const d of ['src', 'public', 'config', 'scripts', 'deploy']) walk(path.join(root, d));
  files.push(path.join(root, 'README.md'), path.join(root, 'package.json'), path.join(root, '.env.example'));
  for (const f of files) {
    const hit = fs.readFileSync(f, 'utf8').match(banned);
    assert.equal(hit, null, `${path.relative(root, f)} mentions "${hit?.[0]}"`);
  }
});

test('the offline engine never leaks wording from another profile', async () => {
  const foreign = { dental: /dentist|dental|tooth|teeth/i, salon: /hair|stylist|salon/i, accounting: /\btax(es)?\b|\birs\b|bookkeeping/i };
  for (const name of PROFILE_NAMES) {
    const cfg = profileCfg(name);
    const env = makeEnv({ config: cfg });
    for (const sc of cfg.profile.scenarios) {
      const l = await run(env, sc.lead);
      const said = agentTexts(l).join(' ');
      for (const other of PROFILE_NAMES.filter((n) => n !== name)) assert.doesNotMatch(said, foreign[other], `${name}/${sc.id} mentions ${other}`);
    }
  }
});
