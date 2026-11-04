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
