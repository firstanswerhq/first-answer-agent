// Probe 7 replay: a short reply that chooses one of the offered times books it (or asks which one) and never asks the visit type again.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeEnv, newLead, say, agentTexts, fakeLlm } from './helpers.js';

const rec = JSON.parse(fs.readFileSync(new URL('./fixtures/probe7-followups.json', import.meta.url), 'utf8'));
const EXPECT = { 'the first one': 0, 'earliest please': 0, 'option 2': 1, 'the second one': 1, 'the last one': 2 };

async function replay(r, llm = null) {
  const env = makeEnv();
  const l = await newLead(env, { message: r.first });
  env.agent.llm = llm;
  l.offeredSlots = [...r.offers];
  l.messages.push({ from: 'agent', by: 'model', text: r.offerText, ts: env.clock.now() });
  await say(env, l, r.followup);
  return { env, l };
}

for (const r of rec.filter((x) => x.offers.length)) {
  test(`probe 7 follow-up "${r.followup}" picks the right offered time without a model call`, async () => {
    const llm = fakeLlm([]);
    const { env, l } = await replay(r, llm);
    const last = agentTexts(l).at(-1);
    assert.doesNotMatch(last, /which (?:visit|type)|what would you like to (?:come in|book)|cleaning, an exam/i);
    if (r.followup in EXPECT) {
      assert.equal(env.store.bookingForLead(l.id)?.slot_id, r.offers[EXPECT[r.followup]], last);
      assert.match(last, /Booked/);
      assert.match(last, /different visit|reply here/i, 'the confirmation names the service and invites a correction');
    } else {
      // "sure, book it" with three offered times: ask which one, with the numbered list
      assert.equal(env.store.bookingForLead(l.id), null);
      assert.match(last, /Which of these works best: 1\)/);
    }
    assert.equal(llm.fetchMock.state.bodies.length, 0, 'no model call');
  });
}

test('a lone offered time plus "yes" or "book it" books it', async () => {
  const r = rec.find((x) => x.followup === 'sure, book it');
  const { env, l } = await replay({ ...r, offers: [r.offers[0]], followup: 'sure, book it' });
  assert.equal(env.store.bookingForLead(l.id)?.slot_id, r.offers[0]);
});

test('the two follow-ups that had no times: the first reply now carries real open times', async () => {
  for (const msg of ['Do you have a Wednesday afternoon?', 'Anything sometime Monday?', 'Do you have something tomorrow?', 'Can I come in Thursday at 9am?', 'Anything after 3 on Tuesday?']) {
    const l = await newLead(makeEnv(), { message: msg });
    const t = agentTexts(l).at(-1);
    assert.match(t, /\d{1,2}:\d\d (?:AM|PM)/, `${msg} -> ${t}`);
    assert.doesNotMatch(t, /what would you like to book/i, msg);
  }
});

test('time windows: afternoon, after 3, before 10 and mornings list open times inside the window', async () => {
  const hours = (t) => [...t.matchAll(/(\d{1,2}):00 (AM|PM)/g)].map((m) => (Number(m[1]) % 12) + (m[2] === 'PM' ? 12 : 0));
  const cases = [['Do you have a Wednesday afternoon?', (h) => h >= 12], ['Anything after 3 on Tuesday?', (h) => h >= 15], ['Anything before 10 on Friday?', (h) => h < 10], ['Do you do mornings?', (h) => h < 12]];
  for (const [msg, ok] of cases) {
    const l = await newLead(makeEnv(), { message: msg });
    const t = agentTexts(l).at(-1);
    const open = t.split('Open times:')[1] || '';
    const hs = hours(open);
    assert.ok(hs.length && ok(hs[0]), `${msg} -> ${t}`);
  }
});

test('bad_time through send_reply behaves like the text path: rules reply with real times, no holding message, no escalation', async () => {
  const { call, reply } = await import('./helpers.js');
  const badReply = () => reply(call('send_reply', { text: 'I have Wed Nov 11 at 2:30 PM or Thu Nov 12 at 10:15 AM open. Which works?' }));
  const llm = fakeLlm([reply(call('qualify_lead', { service: 'checkup', urgency: 'routine' })), badReply(), badReply(), badReply(), badReply()]);
  const l = await newLead(makeEnv({ llm }), { message: 'Do you have an exam next week?' });
  const all = agentTexts(l).join(' | ');
  assert.doesNotMatch(all, /2:30 PM|10:15 AM|teammate will follow/);
  assert.match(agentTexts(l).at(-1), /Open times: 1\)/);
  assert.notEqual(l.status, 'human');
});
