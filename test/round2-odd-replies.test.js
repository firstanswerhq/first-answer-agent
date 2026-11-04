import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, newLead, say, agentTexts, profileCfg } from './helpers.js';

const ask = async (name, message) => {
  const env = makeEnv({ config: profileCfg(name) });
  const l = await newLead(env, { message });
  return { env, l, text: agentTexts(l).join(' | ') };
};

test('(a) "how long does a new patient exam take": answered from facts.duration once, no unasked price, no list of times yet', async () => {
  const { env, l, text } = await ask('dental', 'How long does a new patient exam usually take?');
  assert.match(text, /around an hour and a half/);
  assert.equal((text.match(/takes a little longer/g) || []).length, 1);
  assert.doesNotMatch(text, /\$\d/);
  assert.doesNotMatch(text, /Open times/);
  assert.match(text, /Would you like me to find a time for your new patient exam with X-rays\?/);
  assert.equal(l.status, 'replied');
  await say(env, l, 'yes please');
  assert.match(agentTexts(l).at(-1), /Open times: 1\)/, 'the offer follows when the customer says yes');
});

test('(a) a fact question together with booking words still gets the offer', async () => {
  const { text } = await ask('dental', 'How long does a cleaning take? I would like to book one this week.');
  assert.match(text, /about an hour/);
  assert.match(text, /Open times: 1\)/);
});

test('(b) LLC: starting one, or its annual report, is the business setup consultation, not a tax return', async () => {
  for (const m of ['Help me start an LLC', 'Can you prepare my LLC annual report and what does that cost?']) {
    const { text } = await ask('accounting', m);
    assert.match(text, /new business setup consultation/i, m);
    assert.doesNotMatch(text, /tax return/i, m);
  }
  const { text } = await ask('accounting', 'I need my LLC tax return done');
  assert.match(text, /tax return/i);
});

test('(c) hours and parking in one message are both answered (salon)', async () => {
  const { text } = await ask('salon', 'What are your hours and where do you park?');
  assert.match(text, /Tue-Fri 9 AM-6 PM/);
  assert.match(text, /free parking/);
});

test('(d) out of scope: banana bread, football and a cover letter are plainly outside what we help with', async () => {
  for (const m of ['Can you give me a recipe for banana bread?', 'Who won the football game last night?', 'Can you help me write a cover letter for a job application?']) {
    const { l, text } = await ask('dental', m);
    assert.match(text, /outside what I can help with/, m);
    assert.match(text, /book appointments|what would you like to book/i, m);
    assert.equal(l.status, 'replied', m);
  }
  const { text } = await ask('dental', 'Hello?');
  assert.doesNotMatch(text, /outside what I can help with/);
});

test('(e) a taken time: the three nearest open times that day, in time order', async () => {
  // Dental Tuesday 1 PM (open on the demo calendar): ask for the day with a booked 1 PM by booking it first
  const env = makeEnv({ config: profileCfg('dental') });
  const l1 = await newLead(env, { message: 'I need a cleaning Tuesday at 1pm' });
  await say(env, l1, '1'); // books Tuesday 1 PM
  assert.ok(env.store.bookingForLead(l1.id));
  const l2 = await newLead(env, { name: 'Other Person', message: 'Anything open Tuesday at 1pm for a cleaning?' });
  const t = agentTexts(l2)[0];
  assert.match(t, /Tuesday at 1:00 PM is already taken\./);
  const hours = [...t.matchAll(/(\d+):00 ([AP]M)-/g)].map((m) => (Number(m[1]) % 12) + (m[2] === 'PM' ? 12 : 0));
  assert.deepEqual(hours, [11, 14, 15]);
});
