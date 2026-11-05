import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeEnv, newLead, fakeLlm, call, reply, cfgFor, startServer, post, lead as leadInput } from './helpers.js';
import { summary, isSimulatedSource } from '../src/service.js';

const root = cfgFor().root;
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

test('system prompt never tells the model to hide that messages are simulated, and requires AI disclosure', async () => {
  const llm = fakeLlm([reply(call('qualify_lead', { service: 'checkup', urgency: 'routine' })), reply()]);
  await newLead(makeEnv({ llm }), { message: 'I would like a checkup next week. It is for my daughter.' });
  const prompt = llm.fetchMock.state.bodies[0].messages[0].content;
  assert.doesNotMatch(prompt, /do not mention that|hide|conceal/i);
  assert.match(prompt, /never imply that a message was sent to a real phone or email/i);
  assert.match(prompt, /first reply[^.]*AI/i);
});

test('copy: no "real calendar" claims and no instant-reply claim in UI, profiles or README', () => {
  const files = ['README.md', 'public/app.js', 'public/lead.html', 'public/lead.js', 'config/profiles/dental.json', 'config/profiles/salon.json', 'config/profiles/accounting.json', 'src/functions.js'];
  for (const f of files) {
    const t = read(f).replace('## Connect a real calendar', ''); // the one section that explains the optional, read-only connection
    assert.doesNotMatch(t, /real calendar|real open times|real booking rules|real open appointment/i, f);
    assert.doesNotMatch(t, /replies right away/i, f);
  }
  assert.match(read('public/lead.html'), /usually in under 10 seconds/);
  assert.match(read('public/lead.html'), /Nothing is texted or emailed/);
});

test('README: token note says 12,000 to 15,000, never 4,800; call and text sources are described as simulated; handoff is a real phone alert', () => {
  const t = read('README.md');
  assert.doesNotMatch(t, /4,800|4800/);
  assert.match(t, /12,000 to 15,000 input tokens/);
  assert.match(t, /website form is the only real intake channel/i);
  assert.match(t, /Real phone alert plus dashboard status/);
});

test('package.json and README share the exact one-line description', () => {
  const d = JSON.parse(read('package.json')).description;
  assert.equal(d, 'An AI front desk for any small business: answers web inquiries, checks a demo calendar, books appointments and hands tricky cases to a person. Runs on Vultr.');
  assert.ok(read('README.md').includes(d));
});

test('Text message and Phone call sources are marked simulated in summaries, the detail API and the UI code', async () => {
  assert.ok(isSimulatedSource('Phone call') && isSimulatedSource('Text message') && !isSimulatedSource('Website form'));
  const env = makeEnv();
  const l = await newLead(env, { source: 'Phone call' });
  assert.equal(summary(l, env.store).sourceSimulated, true);
  const w = await newLead(env, { source: 'Website form' });
  assert.equal(summary(w, env.store).sourceSimulated, false);
  assert.match(read('public/app.js'), /simulated source/);
});

test('cloud-init passes NTFY_TOPIC and DASHBOARD_URL through with no real values', () => {
  const t = read('deploy', 'cloud-init.sh');
  assert.match(t, /NTFY_TOPIC="\$\{NTFY_TOPIC:-\}"/);
  assert.match(t, /DASHBOARD_URL="\$\{DASHBOARD_URL:-\}"/);
  assert.match(t, /NTFY_TOPIC="\$\(q "\$NTFY_TOPIC"\)"/);
  assert.match(t, /DASHBOARD_URL="\$\(q "\$DASHBOARD_URL"\)"/);
});

test('README: no unverified price claim, and the seed command line is not a stray paragraph', () => {
  const t = read('README.md');
  assert.doesNotMatch(t, /cent or two/i);
  assert.doesNotMatch(t, /\n `npm run seed`/);
  assert.match(t, /small fraction of a dollar at list prices/);
});
