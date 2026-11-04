// Wording a business owner or customer reads: no jargon, no internal names, no overclaims, no nested parentheses.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeEnv, makeClock, newLead, agentTexts, profileCfg, PROFILE_NAMES, WED_10AM, WED_11PM, cfgFor, startServer } from './helpers.js';

const root = cfgFor().root;
const JARGON = /sales-ops|inference key|deterministic|calendar store|price book|FORCE_OFFLINE|America\/Chicago|\bOffline rules mode\b|answers in seconds|Typical range for this/i;

test('UI files and profiles contain none of the jargon, raw settings names or overclaims', () => {
  const files = [...fs.readdirSync(path.join(root, 'public')).filter((f) => /\.(js|html)$/.test(f)).map((f) => path.join('public', f)), ...fs.readdirSync(path.join(root, 'config', 'profiles')).map((f) => path.join('config', 'profiles', f))];
  for (const f of files) {
    const text = fs.readFileSync(path.join(root, f), 'utf8');
    const m = text.match(f.startsWith('config') ? new RegExp(JARGON.source.replace('|America\\/Chicago', ''), 'i') : JARGON); // a profile must name its time zone
    assert.equal(m, null, `${f} contains "${m?.[0]}"`);
  }
});

for (const name of PROFILE_NAMES) {
  test(`${name}: every demo scenario reads cleanly (no jargon, no nested parentheses, no "0 ms", no timeline leaks)`, async () => {
    for (const hour of [WED_10AM, WED_11PM]) {
      const env = makeEnv({ clock: makeClock(hour), config: profileCfg(name) });
      for (const sc of env.config.profile.scenarios) {
        const l = await newLead(env, { ...sc.lead });
        const texts = [...agentTexts(l), ...l.timeline.map((t) => `${t.title} ${t.detail || ''}`)];
        for (const t of texts) {
          assert.equal(t.match(JARGON), null, `${name}/${sc.id}: "${t}"`);
          assert.ok(!/\([^()]*\([^()]*\)[^()]*\)/.test(t), `${name}/${sc.id}: nested parentheses in "${t}"`);
          assert.ok(!/in 0 ms|0 milliseconds/.test(t), `${name}/${sc.id}: "${t}"`);
        }
        for (const t of agentTexts(l)) {
          assert.ok(!/call you at this number/.test(t));
          assert.ok(/ - .+ \(AI\)$/.test(t), 'every reply is signed as an AI');
        }
      }
    }
  });
}

test('the lead form page title names the business, and the lead form offers customer-friendly sources', async () => {
  const html = fs.readFileSync(path.join(root, 'public', 'lead.html'), 'utf8');
  assert.doesNotMatch(html, /First Answer/);
  assert.doesNotMatch(html, /Google Ads|Website form/);
  assert.match(html, /Google search/);
  assert.match(html, /Friend or family/);
  const js = fs.readFileSync(path.join(root, 'public', 'lead.js'), 'utf8');
  assert.match(js, /\$\{c\.business\.name\} - Contact us/);
  assert.doesNotMatch(js, /milliseconds/);
});

test('the shipped profiles describe the assistant without a speed claim, and each has its own cast of people', () => {
  const casts = [];
  for (const name of PROFILE_NAMES) {
    const p = makeEnv({ config: profileCfg(name) }).config.profile;
    assert.doesNotMatch(p.wording.formIntro, /seconds/i);
    assert.match(p.wording.formIntro, /AI/);
    casts.push(new Set([...p.scenarios.map((s) => s.lead.name), ...p.seed.map((s) => s.lead.name)]));
  }
  for (let i = 0; i < casts.length; i += 1) for (let j = i + 1; j < casts.length; j += 1) {
    const shared = [...casts[i]].filter((n) => casts[j].has(n));
    assert.deepEqual(shared, [], `profiles ${PROFILE_NAMES[i]} and ${PROFILE_NAMES[j]} share people`);
  }
});

test('the salon does not hand off "I want orange highlights" but does for "my hair turned orange"', async () => {
  const env = makeEnv({ clock: makeClock(WED_10AM), config: profileCfg('salon') });
  const fine = await newLead(env, { message: 'I would like some copper and orange highlights, can I book color?' });
  assert.notEqual(fine.status, 'human');
  const bad = await newLead(env, { message: 'My hair turned orange after my last color, can you fix it?' });
  assert.equal(bad.status, 'human');
});

test('time-sensitive tax notices are labeled by what they are, not as an unclassified request', async () => {
  const env = makeEnv({ clock: makeClock(WED_10AM), config: profileCfg('accounting') });
  const sc = env.config.profile.scenarios.find((s) => s.id === 'urgent');
  const l = await newLead(env, { ...sc.lead });
  assert.equal(l.priority, 'urgent');
  assert.match(l.qualification.serviceLabel, /notice/i);
  assert.notEqual(l.qualification.serviceLabel, 'Unclassified request');
  const salon = makeEnv({ clock: makeClock(WED_10AM), config: profileCfg('salon') });
  const s2 = await newLead(salon, { ...salon.config.profile.scenarios.find((s) => s.id === 'urgent').lead });
  assert.notEqual(s2.qualification.serviceLabel, 'Unclassified request');
});

test('the dashboard config carries the customer word and the lead form works end to end with the new sources', async () => {
  const s = await startServer({ config: profileCfg('dental') });
  try {
    const c = await (await fetch(`${s.base}/api/config`)).json();
    assert.equal(c.business.customerWord, 'patient');
    const r = await fetch(`${s.base}/api/leads`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Pat Doe', phone: '(615) 555-0144', message: 'I need a cleaning and checkup', source: 'Friend or family' }) });
    assert.equal(r.status, 202);
    await Promise.all([...s.agent.chains.values()]);
    const list = await (await fetch(`${s.base}/api/leads`)).json();
    assert.equal(list.leads.find((l) => l.name === 'Pat Doe').source, 'Friend or family');
  } finally { await s.stop(); }
});

test('README keeps live-proof claims out and uses plain language', () => {
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  assert.doesNotMatch(readme, /verified live|answers? in seconds|sales-ops|calendar store|price book|inference key|deterministic/i);
  assert.match(readme, /Real vs simulated/);
  assert.match(readme, /Switch business/);
  assert.match(readme, /Freeze the demo/);
  assert.match(readme, /Make it yours/);
  assert.doesNotMatch(readme, /PLACEHOLDER/);
});
