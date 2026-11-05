// Review 13 items 5-8: honest answers for facts the profile does not have, time requests, handoff coverage and copy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, newLead, say, agentTexts, profileCfg, makeClock, WED_10AM, WED_11PM } from './helpers.js';
import { factAnswers } from '../src/facts.js';
import { requestedClock, partOfDay, pastDay, requestedDay } from '../src/extract.js';
import { alertCategory } from '../src/agent.js';
import { classify } from '../src/safety.js';

const ask = async (name, message, over = {}, clock) => {
  const env = makeEnv({ config: profileCfg(name, over), ...(clock ? { clock } : {}) });
  const l = await newLead(env, { message });
  return { env, l, text: agentTexts(l).join(' | ') };
};

// ---- 5. facts ----
test('unknown questions are acknowledged: a teammate will confirm, low priority, no hand-off and no phone alert', async () => {
  for (const m of ['What is your address?', 'Is the office open on Thanksgiving?', 'Do you accept credit cards?', 'Is there a pharmacy near you?', 'Is the building wheelchair accessible?']) {
    const { l, text } = await ask('dental', m);
    assert.match(text, /teammate will confirm/, m);
    assert.equal(l.status, 'replied', m);
    assert.ok(l.confirmNeeded, m);
    assert.equal(l.ownerAlertedAt, undefined, m);
    assert.ok(!l.timeline.some((t) => t.kind === 'alert'), m);
  }
});

test('a specific insurance plan goes to the front desk', async () => {
  const { l, text } = await ask('dental', 'Do you take Delta Dental?');
  assert.equal(l.status, 'replied');
  assert.ok(l.confirmNeeded);
  assert.match(text, /front desk/);
});

test('"Centennial Park" is not a parking question; real parking questions still are', async () => {
  assert.equal(factAnswers('I live near Centennial Park, I need a cleaning', profileCfg('dental')).any, false);
  for (const m of ['Where do I park?', 'Is there parking?', 'Can I park near the entrance?']) assert.ok(factAnswers(m, profileCfg('dental')).answers.length, m);
});

test('"how long does a tax return take" does not get the intro-meeting length', async () => {
  const { text } = await ask('accounting', 'How long does a tax return take?');
  assert.doesNotMatch(text, /30 to 45 minutes/);
  assert.match(text, /teammate will confirm/);
  const r = await ask('accounting', 'How long is the first meeting?');
  assert.match(r.text, /30 to 45 minutes/);
});

test('"are you open now / today" is answered from the hours and the clock in the business time zone', async () => {
  let r = await ask('dental', 'Are you open right now?'); // Wednesday 10:00 AM Central
  assert.match(r.text, /Yes, we are open right now, until 5:00 PM today/);
  r = await ask('dental', 'Are you open now?', {}, makeClock(WED_11PM));
  assert.match(r.text, /closed for the day/);
  r = await ask('dental', 'Are you open today?', {}, makeClock(Date.UTC(2026, 10, 8, 16, 0, 0))); // Sunday
  assert.match(r.text, /closed today/);
  r = await ask('dental', 'Are you open now?', {}, makeClock(Date.UTC(2026, 10, 4, 12, 0, 0))); // 6 AM Central
  assert.match(r.text, /Not yet\. We open at 8:00 AM today/);
});

test('"I work weekends" is not turned into a pair of closed-day statements, and a real weekend question is one sentence', async () => {
  assert.equal(factAnswers('I work weekends so evenings are hard.', profileCfg('dental')).any, false);
  const a = factAnswers('Are you open on weekends?', profileCfg('dental')).answers[0];
  assert.match(a, /^We are closed on Saturdays and Sundays\./);
});

test('walk-in text does not promise to fit anyone in', async () => {
  const { text } = await ask('dental', 'Do you do walk-ins?');
  assert.doesNotMatch(text, /fit you in|as soon as we can/);
  assert.match(text, /by appointment/);
});

// ---- 6. time requests ----
test('requestedClock: bare numbers, noon, half past, and things that are not times', () => {
  assert.deepEqual(requestedClock('Thursday at 9'), { hour: 9, minute: 0 });
  assert.deepEqual(requestedClock('can I do Thursday 2'), { hour: 14, minute: 0 });
  assert.deepEqual(requestedClock('how about noon'), { hour: 12, minute: 0 });
  assert.deepEqual(requestedClock('half past 9 on Friday'), { hour: 9, minute: 30 });
  assert.deepEqual(requestedClock('at 10:30 am'), { hour: 10, minute: 30 });
  assert.equal(requestedClock('my 9 year old'), null);
  assert.equal(requestedClock('Thursday 5th'), null);
  assert.equal(requestedClock('at 9 people'), null);
  assert.equal(partOfDay('Thursday morning please'), 'morning');
});

test('bare "9", "noon" and "half past 9" are answered plainly', async () => {
  let r = await ask('dental', 'Can I come in Thursday at 9 for a cleaning?');
  assert.match(r.text, /Thursday at 9:00 AM is open\./);
  r = await ask('dental', 'Can I come in Thursday at noon for a cleaning?');
  assert.match(r.text, /We do not start appointments at 12:00 PM on Thursday\./);
  r = await ask('dental', 'Can I come Thursday half past 9 for a cleaning?');
  assert.match(r.text, /We start appointments on the hour, so 9:30 AM is not a start time\./);
});

test('"Thursday morning" offers the open morning times', async () => {
  const { text, l } = await ask('dental', 'I need a cleaning Thursday morning.');
  assert.match(text, /Here is what is open Thursday morning\./);
  assert.ok(l.offeredSlots.every((id) => id.startsWith('2026-11-05T') && Number(id.slice(11, 13)) < 12));
});

test('a past date and a time that already passed today are said plainly', async () => {
  let r = await ask('dental', 'Can I come in Nov 1 at 9am for a cleaning?');
  assert.match(r.text, /Sun, Nov 1 has already passed, so here are the next open times\./);
  r = await ask('dental', 'Can I come in today at 9am for a cleaning?'); // it is 10:00 AM
  assert.match(r.text, /Today at 9:00 AM has already passed\./);
  assert.match(r.text, /Open times: 1\)/);
});

test('past-date and day parsing helpers', () => {
  assert.equal(pastDay('Nov 1 at 9am', '2026-11-04'), '2026-11-01');
  assert.equal(pastDay('Nov 9', '2026-11-04'), null);
  assert.equal(pastDay('Thursday', '2026-11-04'), null);
  assert.equal(requestedDay('tomorrow please', '2026-11-04').date, '2026-11-05');
});

// ---- 7. handoffs ----
test('medication-with-procedure and diagnosis questions are handed off with their own wording', async () => {
  let r = await ask('dental', 'I take blood pressure meds, is that ok for a cleaning?');
  assert.equal(r.l.status, 'human');
  assert.match(r.text, /medications, doses/);
  r = await ask('dental', 'Is it normal for my gums to bleed?');
  assert.equal(r.l.status, 'human');
  assert.match(r.text, /cannot diagnose/);
  assert.doesNotMatch(r.text, /medications, doses/);
  r = await ask('salon', 'Do you use ammonia free color?');
  assert.equal(r.l.status, 'human');
  assert.match(r.text, /product-safety/);
});

test('alert categories name the kind of question, never the customer text', () => {
  const dental = profileCfg('dental').profile; const acc = profileCfg('accounting').profile; const salon = profileCfg('salon').profile;
  assert.equal(alertCategory(classify('Is it safe to take ibuprofen?', dental)), 'Medication or clinical question');
  assert.equal(alertCategory(classify('Is it normal for my gums to bleed?', dental)), 'Medication or clinical question');
  assert.equal(alertCategory(classify('What do I owe the IRS?', acc)), 'Tax or legal advice question');
  assert.equal(alertCategory(classify('Is the lightener safe, I have an allergy', salon)), 'Allergy or health question');
  assert.equal(alertCategory(classify('Do you take Delta Dental?', dental)), 'Insurance or billing question');
});

// ---- 8. copy ----
test('no "set up a payroll setup" duplication; starting an LLC is a business setup consultation, not a tax return', async () => {
  let r = await ask('accounting', 'I need help with payroll setup.');
  assert.doesNotMatch(r.text, /set up a payroll setup/i);
  assert.match(r.text, /payroll setup/i);
  r = await ask('accounting', 'Can you help me start an LLC?');
  assert.match(r.text, /new business setup consultation/i);
  assert.doesNotMatch(r.text, /tax return/i);
});
