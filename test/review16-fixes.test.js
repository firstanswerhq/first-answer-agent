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
