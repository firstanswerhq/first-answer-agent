// Review 16: narrower handoff claims, billing fast path, off-topic, emergency top-up, change-claim false rejects.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { claimsHandoff } from '../src/functions.js';

test('handoff claim: 40 natural replies never trigger, real claims do', () => {
  const no = JSON.parse(fs.readFileSync(new URL('./fixtures/handoff-no-claim.json', import.meta.url), 'utf8'));
  for (const t of no) assert.equal(claimsHandoff(t), false, t);
  for (const t of ["I've flagged your account for a teammate to review the charge and follow up with you.", "I've flagged your request for a manager.", "I have passed this to our team and a teammate will follow up with you.", "I've forwarded this to a team member who will contact you.", "I've escalated this to a manager.", "I have notified a teammate about this.", 'A teammate will review your request and reach out soon.', "I've sent this to our front desk."]) assert.equal(claimsHandoff(t), true, t);
  assert.equal(claimsHandoff('A teammate will follow up. Which day works for a cleaning?'), false, 'a booking question in the same text');
});

import { classify } from '../src/safety.js';
import { makeEnv, newLead, fakeLlm, agentTexts, profileCfg } from './helpers.js';
test('billing fast path: refund questions and tax refunds do not fire the angry-customer path', () => {
  for (const t of ['How long until my refund arrives? I filed in February.', 'Will I get a bigger refund if I itemize?', 'I want a refund on my tax return', 'Can you help me file for my federal refund?', 'I overpaid my taxes, can you help me get a refund?', 'when will I get my tax refund', 'Do you offer refunds?', 'Can I get a refund of the deposit if I cancel?', 'What is your refund policy?']) assert.equal(classify(t).complaint, false, t);
  for (const t of ['Do you offer refunds?', 'What is your refund policy?']) assert.equal(classify(t).handoff, true, t);
  for (const t of ['I want a refund on my tax return', 'How long until my refund arrives?']) assert.equal(classify(t).handoff, false, t);
  for (const t of ['We were charged double for the visit last week', 'My card was charged again today for the same appointment', 'You charged us twice for the tax prep', 'I was overcharged', 'There is an unauthorized charge on my card', 'I want to dispute the charge', 'I want my money back', 'I demand a refund', 'refund me']) assert.equal(classify(t).complaint, true, t);
});

import { isOffTopic } from '../src/safety.js';
test('off-topic is narrow and profile-aware: on-topic messages are never flagged', () => {
  const C = [
    ['dental', 'Do you treat sports injuries? My son chipped a tooth playing football.'], ['dental', 'Do you make custom mouthguards for football?'],
    ['dental', 'What can I eat after a tooth extraction? Any soft food recipes?'], ['dental', 'What can I eat after whitening?'],
    ['dental', 'Can you recommend a good dentist near Brentwood for my kid?'], ['dental', 'Can you recommend a good electric toothbrush? '],
    ['dental', 'My son plays basketball and knocked a tooth loose, do you see kids?'], ['dental', 'Is the weather going to close the office tomorrow?'],
    ['dental', 'Do you do sports whitening for a hockey player?'], ['dental', 'I grind my teeth when I do Python homework, do you make night guards?'],
    ['dental', 'How do I translate this insurance form?'], ['dental', 'My score on the dental plan is low, what coverage do I have?'],
    ['dental', 'Can you suggest a good time near lunch for an exam?'], ['salon', 'Can you recommend a good color near the roots for a blonde balayage?'],
    ['salon', 'Can you recommend a good shampoo? I have dry hair'], ['salon', 'Can you recommend a good stylist near me for curly hair?'],
    ['salon', 'Is there a good pizza place near you for lunch after my appointment?'], ['salon', 'I have a wedding Saturday, can I get an updo? The weather is rainy so frizz-proof please'],
    ['accounting', 'Can you recommend a good bookkeeping software near your recommended list?'], ['accounting', 'Can you recommend a good CPA near Brentwood for my LLC?'],
    ['accounting', 'Do you handle bitcoin and crypto taxes?'], ['accounting', 'I sold some crypto this year, can you prepare the return?'],
    ['accounting', 'Do you prepare returns for professional football players?'], ['accounting', 'Do you do a sports betting winnings return? I won big on football'],
    ['accounting', 'Can you write a letter to the IRS for me?'], ['accounting', 'I need a resume tax deduction question... job search expenses'],
    ['accounting', 'I need help with my essay on tax law, can you tutor? '], ['accounting', 'Can you help me with the school homework tax credit?'],
  ];
  for (const [n, m] of C) assert.equal(isOffTopic(m, profileCfg(n).profile), false, `${n}: ${m}`);
  for (const n of ['dental', 'salon', 'accounting']) {
    for (const m of ['What is a good recipe for chili?', 'Who won the football game last night?', 'Can you recommend a good plumber near Nashville?', 'Write me a poem about the ocean', 'Tell me a joke', 'Can you help with my Python homework?', 'Help me write a cover letter']) assert.equal(isOffTopic(m, profileCfg(n).profile), true, `${n}: ${m}`);
  }
});

test('off-topic badge: lead summary carries the flag and the dashboard renders "Outside scope" in list and detail', async () => {
  const env = makeEnv({ llm: null });
  const l = await newLead(env, { message: 'Do you have a banana bread recipe?' });
  const { summary } = await import('../src/service.js');
  assert.equal(summary(l, env.store).offTopic, true);
  const js = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.equal((js.match(/Outside scope/g) || []).length >= 2, true);
  const ok = await newLead(env, { name: 'Pat Two', phone: '(615) 555-0133', message: 'Is the weather going to close the office tomorrow?' });
  assert.equal(summary(ok, env.store).offTopic, false);
});

import { loadConfig } from '../src/config.js';
test('emergency holds path: the safety note and phone appear once and never contradict a booking question', async () => {
  const config = loadConfig({ DATA_FILE: '', EMERGENCY_HOLDS: '1' }, { profile: 'dental', seedOnEmpty: false, followupSpeedup: 60 });
  const phone = config.business.phone;
  const note = config.profile.urgency.safetyNote;
  const txt = (c) => ({ status: 200, json: { choices: [{ finish_reason: 'stop', message: { content: c } }] } });
  const cases = [
    [`I am so sorry you are in pain. ${note} A teammate will follow up with you directly.`, 'note only'],
    [`I am so sorry about the pain. Please call us at ${phone} and a teammate will follow up with you directly.`, 'phone only'],
    ['Which weekday works best for you to come in?', 'booking question'],
    [`I am sorry you are in pain. ${note} You can also call us at ${phone} and a teammate will follow up.`, 'both'],
  ];
  for (const [reply, label] of cases) {
    const env = makeEnv({ llm: fakeLlm([txt(reply)]), config });
    const l = await newLead(env, { message: "My face is swelling and I can't open my mouth." });
    const all = agentTexts(l).join(' | ');
    const digits = all.replace(/\D/g, '');
    assert.equal((digits.match(new RegExp(phone.replace(/\D/g, ''), 'g')) || []).length, 1, `${label}: phone once in ${all}`);
    assert.equal((all.match(/call 911/gi) || []).length, 1, `${label}: 911 once in ${all}`);
    assert.doesNotMatch(all, /Which weekday works/, label);
  }
});
