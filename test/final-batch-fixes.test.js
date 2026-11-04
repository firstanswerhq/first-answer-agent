// Final batch (Nov 4): urgent replies always carry the safety note and phone; handoff claims; out-of-scope alerts; rules quality; health counts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { Notifier } from '../src/notify.js';
import { Agent } from '../src/agent.js';
import { LeadService } from '../src/service.js';
import { Store } from '../src/store.js';
import { makeEnv, makeClock, newLead, fakeLlm, call, reply, agentTexts, PROFILE_NAMES, cfgFor, profileCfg, lead as leadInput } from './helpers.js';

const holdCfg = (name) => loadConfig({ DATA_FILE: '', EMERGENCY_HOLDS: '1' }, { profile: name, seedOnEmpty: false, followupSpeedup: 60 });
const BAD = reply(call('send_reply', { text: 'Great, you are booked for Thursday at 9 AM. See you then!' }));

test('urgent message: whatever the model does, the customer gets the safety note and the business phone', async () => {
  for (const name of PROFILE_NAMES) {
    const config = holdCfg(name);
    const msgText = { dental: "My face is swelling and I can't open my mouth.", salon: 'I have a chemical burn on my scalp from the color, I need help right now', accounting: 'I got an IRS notice and the deadline is today, this is urgent' }[name] || 'This is an emergency, urgent';
    for (const script of [[BAD], [{ status: 500, json: {} }], [{ status: 200, json: { choices: [{ finish_reason: 'stop', message: { content: '' } }] } }]]) {
      const env = makeEnv({ llm: fakeLlm(script), config });
      const l = await newLead(env, { message: msgText });
      const all = agentTexts(l).join(' | ');
      assert.ok(l.status === 'human', `${name}: handed to a person`);
      const note = config.profile.urgency.safetyNote.slice(0, 24);
      assert.ok(all.includes(note) || /911/.test(all), `${name}: safety note in "${all}"`);
      assert.ok(all.replace(/\D/g, '').includes(config.business.phone.replace(/\D/g, '')), `${name}: phone in "${all}"`);
      assert.doesNotMatch(all, /^Thanks, [A-Za-z]+, I have received your message and a teammate will follow up shortly\.[^|]*$/);
    }
  }
});

const txt = (c) => ({ status: 200, json: { choices: [{ finish_reason: 'stop', message: { content: c } }] } });

test('a model reply that says a teammate has it hands the inquiry to a person (the claim becomes true)', async () => {
  for (const claim of ["Thanks for the details. I've flagged this for a teammate to review and follow up with you directly.", 'I have passed this to our team and a teammate will follow up with you about it.']) {
    const env = makeEnv({ llm: fakeLlm([txt(claim)]) });
    const l = await newLead(env, { message: 'Can you explain what happens at a first visit?' });
    assert.equal(l.lastReplyBy, 'model', claim);
    assert.equal(l.status, 'human', claim);
    assert.ok(l.humanReason, claim);
    assert.equal(l.timeline.filter((t) => /Flagged for a person/.test(t.title)).length, 1, 'escalated once');
  }
  // a plain answer does not escalate
  const env = makeEnv({ llm: fakeLlm([txt('Our hours are Monday to Thursday 8 AM to 5 PM. Which day works for a cleaning?')]) });
  const l = await newLead(env, { message: 'What are your hours?' });
  assert.notEqual(l.status, 'human');
});

test('billing disputes, refunds and double charges are handled in code, never by the model', async () => {
  for (const m of ['You charged me twice for my last visit.', 'I want to dispute the charge on my card.', 'We were charged double for the visit last week.', 'My card was charged again today for the same appointment.', 'I want a refund for the visit.', 'I was overcharged on my last bill and nobody will fix it. Get me a manager.']) {
    const llm = fakeLlm([txt('Sure!')]);
    const env = makeEnv({ llm });
    const l = await newLead(env, { message: m });
    assert.equal(llm.fetchMock.state.bodies.length, 0, m);
    assert.equal(l.status, 'human', m);
    assert.equal(l.lastReplyBy, 'safety', m);
  }
  const env = makeEnv({ llm: fakeLlm([txt('Sure!')]) });
  const l = await newLead(env, { message: 'when will I get my tax refund' });
  assert.notEqual(l.lastReplyBy, 'safety');
});

test('off-topic: dashboard flag only; it never creates or suppresses an owner alert', async () => {
  const run = async (message, script) => {
    const calls = [];
    const transport = async (url) => { calls.push(url); return { ok: true, status: 200 }; };
    const clock = makeClock();
    const store = new Store();
    const config = cfgFor();
    const notifier = new Notifier({ now: clock.now, log: () => {}, topic: 'test-topic', transport });
    const agent = new Agent({ store, config, llm: fakeLlm(script), now: clock.now, notifier });
    const svc = new LeadService({ store, agent, config, now: clock.now });
    const { lead, done } = svc.createLead(leadInput({ message }));
    await done; await agent.settled();
    return { lead, calls };
  };
  const answer = [txt('That is outside what I can help with. I can book a dental visit if you need one.')];
  for (const m of ['Do you have a banana bread recipe?', 'Who won the football game last night?', 'Can you recommend a good plumber near Nashville?']) {
    const a = await run(m, answer);
    assert.equal(a.calls.length, 0, `no alert created by off-topic alone: ${m}`);
    assert.equal(a.lead.offTopic, true, m);
    // the model asked for a person: that alert is not suppressed
    const b = await run(m, [reply(call('escalate_to_human', { reason: 'not something we do' })), txt('Passed along.')]);
    assert.equal(b.calls.length, 1, `model escalation still alerts: ${m}`);
  }
});

test('rules fallback: a vague "exam" with a day and time still answers the time and lists the nearest open ones', async () => {
  const env = makeEnv({ config: profileCfg('dental') });
  const l1 = await newLead(env, { message: 'I need a cleaning Thursday at 9am' });
  const { done } = env.svc.addCustomerMessage(l1.id, 'the 9 AM please'); await done;
  assert.equal(l1.status, 'booked');
  const l = await newLead(env, { name: 'Hank Test', phone: '(615) 555-0177', message: 'I need an exam. Can I come Thursday at 9am?' });
  const t = agentTexts(l).join(' | ');
  assert.match(t, /Thursday at 9:00 AM is already taken/);
  assert.match(t, /Open times: 1\).*2\).*3\)/);
  assert.doesNotMatch(t, /what would you like to book/);
});

test('rules fallback: ASAP says when we are open today and lists the next three open times', async () => {
  const env = makeEnv({ config: profileCfg('dental') });
  const l = await newLead(env, { message: 'I need an appointment as soon as possible, anything open today or tomorrow?' });
  const t = agentTexts(l).join(' | ');
  assert.match(t, /open right now, until 5:00 PM today/);
  assert.match(t, /Open times: 1\).*2\).*3\)/);
});

test('price check: approved ranges in any common spelling are accepted, others are not', async () => {
  const { checkOutboundRule } = await import('../src/guard.js');
  const lead = { qualification: { priceRange: { low: 110, high: 190 } } };
  const o = { model: true, booked: false };
  for (const t of ['A cleaning runs $110-$190.', 'A cleaning runs $110 to $190.', 'It is about $150.', 'Usually $110-190 depending on the visit.', 'Between 110 and 190 dollars.']) assert.equal(checkOutboundRule(t, lead, o), null, t);
  for (const t of ['A cleaning runs $250.', 'It is about $90.']) assert.equal(checkOutboundRule(t, lead, o)?.id, 'price', t);
});

test('health fallbackReasons counts one per fallback reply, the same unit as the lead details', async () => {
  const empty = { status: 200, json: { choices: [{ finish_reason: 'length', message: { content: '', reasoning_content: 'hmm' } }] } };
  const env = makeEnv({ llm: fakeLlm([empty]) });
  let detailCount = 0;
  for (let i = 0; i < 4; i += 1) {
    const l = await newLead(env, { name: `Person ${i}`, phone: `(615) 555-01${10 + i}`, message: 'I need a cleaning' });
    detailCount += l.messages.filter((m) => m.from === 'agent' && m.fallbackReason === 'empty_end:length').length;
  }
  assert.equal(env.agent.fallbackReasons()['empty_end:length'], detailCount);
  assert.ok(detailCount >= 4);
});
