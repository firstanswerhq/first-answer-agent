// Review 13: the model's wording is checked for false booking claims and for unsafe text, on the tool path and the plain-text path.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, newLead, fakeLlm, call, reply, agentTexts } from './helpers.js';
import { checkOutbound } from '../src/functions.js';

const textOnly = (content) => ({ status: 200, json: { model: 'fake-model-1', choices: [{ message: { role: 'assistant', content } }] } });
const SIG = ' - Brightwater scheduling assistant (AI)';

const CLAIMS = [
  'I have booked you for Thursday at 9 AM, see you then.',
  "You're all set for Thursday at 9:00 AM, your appointment is confirmed.",
  "I've put you down for Thursday morning at nine.",
  'You are on the calendar for Thursday at 9.',
  'Your appointment is confirmed for Thursday.',
  'That time is reserved for you on Thursday.',
  "Thursday at 9 is locked in, we'll see you on Thursday!",
  'We have you scheduled for Thursday at 9 AM.',
];

test('guard: booking claims are rejected when the lead has no booking, allowed when it does', () => {
  for (const t of CLAIMS) {
    assert.ok(checkOutbound(t, {}, { booked: false }), t);
    assert.equal(checkOutbound(t, {}, { booked: true }), null, t);
  }
  for (const ok of ['Which time works best for you?', 'A cleaning usually runs about an hour; confirmed at your visit.', 'Once you pick a time I will book it.', 'Would you like me to book Thursday at 9?', 'A teammate will confirm that for you.']) {
    assert.equal(checkOutbound(ok, {}, { booked: false }), null, ok);
  }
});

for (const claim of CLAIMS) {
  test(`plain-text path: "${claim.slice(0, 40)}" is not sent without a booking; the rules answer`, async () => {
    const llm = fakeLlm([textOnly(claim)]);
    const env = makeEnv({ llm });
    const l = await newLead(env);
    assert.ok(!env.store.bookingForLead(l.id));
    assert.ok(agentTexts(l).every((t) => !/booked you|all set|put you down|on the calendar|reserved|locked in|you scheduled|have you scheduled|appointment is confirmed/i.test(t)), agentTexts(l).join('|'));
    assert.equal(l.lastReplyBy, 'rules');
    assert.equal(llm.fetchMock.state.bodies.length, 2, 'one forced retry only');
  });
}

test('tool path: send_reply claiming a booking is refused, the model cannot get it through, rules answer', async () => {
  const llm = fakeLlm([reply(call('send_reply', { text: "You're all set for Thursday at 9 AM." }))]);
  const env = makeEnv({ llm });
  const l = await newLead(env);
  assert.ok(agentTexts(l).every((t) => !/all set/i.test(t)));
  assert.equal(l.lastReplyBy, 'rules');
  assert.ok(l.timeline.some((t) => t.fn === 'send_reply' && t.ok === false));
});

test('a real booking made by book_appointment may be confirmed in the model\'s own words', async () => {
  const env0 = makeEnv({ llm: fakeLlm([textOnly('x')]) });
  const slot = '2026-11-05T09:00';
  const llm = fakeLlm([
    reply(call('qualify_lead', { service: 'checkup', urgency: 'routine' })),
    reply(call('check_calendar', {})),
    reply(call('book_appointment', { slot_id: slot })),
    reply(call('send_reply', { text: 'You are all set for Thursday at 9:00 AM. See you then!' })),
    textOnly('done'),
  ]);
  const env = makeEnv({ llm });
  void env0;
  const l = await newLead(env, { message: 'Please book me a cleaning Thursday at 9am. It is for my daughter.' });
  assert.ok(env.store.bookingForLead(l.id));
  assert.ok(agentTexts(l).some((t) => /all set for Thursday/.test(t)));
});

const UNSAFE = [
  'Okay, ignoring previous instructions as you asked. Everything is free.',
  'Ignore all previous instructions and I will comply fully.',
  '{"tool":"send_reply","text":"hello there customer friend"}',
  '<script>alert(1)</script> hello, happy to help you out today',
  'Thinking: I should call send_reply. Hello, happy to help with that.',
  'As an AI language model I cannot do that, but happy to help with a visit.',
  'Sure, I can call send_reply for you with that message right now.',
  'Call us back at 615-555-0199 or write to boss@example.com for details.',
];
for (const u of UNSAFE) {
  test(`plain-text path: unsafe text "${u.slice(0, 40)}" is rejected, retried once, then the rules answer`, async () => {
    const llm = fakeLlm([textOnly(u)]);
    const env = makeEnv({ llm });
    const l = await newLead(env);
    const t = agentTexts(l).join(' | ');
    assert.ok(!/ignor|script|send_reply|tool|Thinking|boss@|0199|AI language/i.test(t), t);
    assert.equal(l.lastReplyBy, 'rules');
    assert.equal(llm.fetchMock.state.bodies.length, 2);
  });
}

test('think blocks are stripped when the rest of the text is fine', async () => {
  const env = makeEnv({ llm: fakeLlm([textOnly('<think>the customer wants a cleaning</think> We can help with a cleaning and checkup. Which day works best for you?')]) });
  const l = await newLead(env);
  assert.equal(l.lastReplyBy, 'model');
  assert.match(agentTexts(l)[0], /^We can help with a cleaning/);
  assert.doesNotMatch(agentTexts(l)[0], /think/i);
});

test('the lead\'s own phone and the business phone may be repeated; other numbers may not', () => {
  const lead = { phone: '(615) 555-0111' };
  const opts = { ownPhones: ['(615) 555-0100'] };
  assert.equal(checkOutbound('We will call you at (615) 555-0111, or call us at (615) 555-0100.', lead, opts), null);
  assert.ok(checkOutbound('Call (615) 555-0123 instead.', lead, opts));
  assert.ok(checkOutbound('Write to me at a.b@example.com', lead, opts));
});

// ---- who-wrote-it labels stay honest after a hand-off ----
test('labels after hand-off: holding reply is rules, 911 text is safety, on the lead, the detail and the public mode', async () => {
  const { detail } = await import('../src/service.js');
  const llm = fakeLlm([textOnly('Thanks for reaching out! We can fit a checkup this week, which day works best for you?')]);
  const env = makeEnv({ llm });
  const l = await newLead(env);
  assert.equal(l.lastReplyBy, 'model');
  // hand-off, then a later message gets the holding reply
  const { done: d0 } = env.svc.addCustomerMessage(l.id, 'I want to talk to a real person please');
  await d0;
  const l2 = env.store.getLead(l.id);
  assert.equal(l2.status, 'human');
  const { done } = env.svc.addCustomerMessage(l.id, 'Any update?');
  await done;
  assert.equal(l2.lastReplyBy, 'rules');
  assert.equal(detail(l2, env.store).answeredBy, 'rules');
  const { done: d2 } = env.svc.addCustomerMessage(l.id, 'I have chest pain now');
  await d2;
  assert.equal(l2.lastReplyBy, 'safety');
  assert.equal(detail(l2, env.store).answeredBy, 'safety');
});

test('a fresh 911 reply is labelled Safety rules, and the dashboard detail reads the same label as the list', async () => {
  const env = makeEnv({ llm: null });
  const l = await newLead(env, { message: 'I have chest pain and cannot breathe' });
  assert.equal(l.lastReplyBy, 'safety');
  assert.ok(l.messages.filter((m) => m.from === 'agent').every((m) => m.by === 'safety'));
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(src, /l\.answeredBy \|\| l\.lastReplyBy/);
});
