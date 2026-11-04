// Fixes from the live batch of Nov 4: plain business questions answered from the profile, clinical and medication questions
// handed to a person with a reason, a taken time said plainly, and natural wording. All offline, no model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, newLead, say, agentTexts, profileCfg, makeClock, WED_10AM } from './helpers.js';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { compileProfile } from '../src/profile.js';
import fs from 'node:fs';
import path from 'node:path';

const envFor = (name, over = {}) => makeEnv({ config: profileCfg(name, over) });
const ask = async (name, message, over) => {
  const env = envFor(name, over);
  const l = await newLead(env, { message });
  return { env, l, text: agentTexts(l).join(' | ') };
};

test('dental: office hours, Saturday, parking, walk-ins and exam length get real answers from the profile', async () => {
  let r = await ask('dental', 'What are your office hours?');
  assert.match(r.text, /Mon-Thu 8 AM-5 PM, Fri 8 AM-noon/);
  assert.doesNotMatch(r.text, /^Hi \w+, thanks for reaching out to Brightwater Family Dental\. Happy to help: what would you like/, 'not the bare booking prompt');
  assert.match(r.text, /book/i, 'still offers to book');
  assert.equal(r.l.status, 'replied');
  r = await ask('dental', 'Can I get an appointment this Saturday morning?');
  assert.match(r.text, /closed on Saturdays/);
  r = await ask('dental', 'Where do I park when I come to the office? Is there a lot?');
  assert.match(r.text, /free parking in the lot/);
  r = await ask('dental', 'Do you do walk-ins? Also how long does an exam take?');
  assert.match(r.text, /by appointment/);
  assert.match(r.text, /about an hour/);
});

test('salon and accounting answer the same questions from their own profile (salon is open Saturday)', async () => {
  let r = await ask('salon', 'Are you open on Saturday?');
  assert.match(r.text, /open on Saturdays from 9:00 AM to 3:00 PM/);
  r = await ask('salon', 'What are your hours?');
  assert.match(r.text, /Tue-Fri 9 AM-6 PM, Sat 9 AM-3 PM/);
  r = await ask('accounting', 'Do you have a Saturday appointment?');
  assert.match(r.text, /closed on Saturdays/);
  r = await ask('accounting', 'How long does the first meeting take? And is there parking?');
  assert.match(r.text, /30 to 45 minutes/);
  assert.match(r.text, /parking behind the office/);
});

test('a fact the profile does not state is never invented: a person will confirm', async () => {
  const raw = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'config', 'profiles', 'dental.json'), 'utf8'));
  delete raw.facts;
  const config = loadConfig({ DATA_FILE: '' }, { seedOnEmpty: false, followupSpeedup: 60, profile: compileProfile(raw) });
  const env = makeEnv({ config });
  const l = await newLead(env, { message: 'Where do I park? Is there a lot?' });
  const t = agentTexts(l).join(' ');
  assert.match(t, /teammate will confirm/);
  assert.doesNotMatch(t, /free parking|lot next to/i);
  assert.equal(l.status, 'replied', 'low priority: not a hand-off');
  assert.match(l.confirmNeeded, /parking/);
  assert.equal(env.store.followups.filter((f) => f.status === 'pending').length, 1);
});

test('a fact question together with a service still gets the offer, with the fact first', async () => {
  const r = await ask('dental', 'I need a cleaning and checkup. Is there parking, and what are your hours?');
  assert.match(r.text, /free parking/);
  assert.match(r.text, /Open times: 1\)/);
  assert.ok(r.text.indexOf('parking') < r.text.indexOf('Open times'));
});

test('medication, dose and clinical questions go to a person with a clear reason (dental)', async () => {
  for (const m of [
    'Can you tell me if the amoxicillin I take affects my crown, and what dose I should take for the infection?',
    'Is it safe to take ibuprofen before my cleaning?',
  ]) {
    const { l, text } = await ask('dental', m);
    assert.equal(l.status, 'human', m);
    assert.match(text, /cannot advise on medications, doses/, m);
    assert.match(text, /dental team/, m);
    assert.doesNotMatch(text, /Open times/, m);
    assert.match(l.humanReason, /medications, doses and medical history/, m);
  }
});

test('allergy and product questions go to a person (salon); what-do-I-owe and should-I-file go to a person (accounting)', async () => {
  let { l, text } = await ask('salon', 'I am allergic to ammonia. Is it safe to use your lightener on my scalp?');
  assert.equal(l.status, 'human');
  assert.match(text, /Allergy, ingredient and product-safety questions go to our stylists/);
  ({ l, text } = await ask('accounting', 'Should I file an amended return, and what do I owe?'));
  assert.equal(l.status, 'human');
  assert.match(text, /what you owe, whether you should file/);
  ({ l, text } = await ask('accounting', 'How much do I owe the IRS for 2024?'));
  assert.equal(l.status, 'human');
});

test('ordinary messages are still answered, not handed off (no false positives)', async () => {
  for (const [name, m] of [
    ['dental', 'I need to bring my 7 year old son in for his first checkup.'],
    ['dental', 'Can I take my daughter in on Thursday for a cleaning?'],
    ['dental', 'I would like to ask about teeth whitening. Can I book a consultation?'],
    ['salon', 'I want a haircut and a blowout this week.'],
    ['accounting', 'I need help with my personal tax return.'],
  ]) {
    const { l } = await ask(name, m);
    assert.equal(l.status, 'replied', m);
  }
});

test('insurance handoff says why', async () => {
  const { l, text } = await ask('dental', 'Do you take Delta Dental insurance? Not sure what my copay would be.');
  assert.equal(l.status, 'human');
  assert.match(text, /Insurance and billing questions go to our front desk/);
});

test('wording: a service with no quote reads as a sentence, not "Label: text"', async () => {
  const { text } = await ask('dental', 'I would like to ask about teeth whitening. Can I book a consultation?');
  assert.doesNotMatch(text, /Whitening consultation: We will go over/);
  assert.match(text, /Happy to help with your whitening consultation\. We will go over the cost with you at your visit\./);
});

// ---- a taken time is said plainly, then the nearest open times that day, then others ----
const ICS_THU_9 = fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'ics', 'utc.ics'), 'utf8'); // Thu Nov 5, 9:00-10:00 Central busy
const feedEnv = async () => {
  const f = async () => new Response(ICS_THU_9, { status: 200, headers: { 'content-type': 'text/calendar' } });
  const config = loadConfig({ DATA_FILE: '', CALENDAR_ICAL_URL: 'https://calendar.google.com/calendar/ical/o%40example.com/private-x/basic.ics' }, { seedOnEmpty: false, followupSpeedup: 60, calendarFetch: f });
  return makeEnv({ config, clock: makeClock(WED_10AM) });
};

test('busy requested time: "Thursday at 9:00 AM is already taken", nearest open times that day come first', async () => {
  const env = await feedEnv();
  const l = await newLead(env, { message: 'Can I come in Thursday at 9am for a cleaning?' });
  const t = agentTexts(l)[0];
  assert.match(t, /Thursday at 9:00 AM is already taken\./);
  assert.ok(t.indexOf('already taken') < t.indexOf('Open times'));
  const offers = [...t.matchAll(/\d\) ([A-Za-z]{3}, [A-Za-z]{3} \d+, [\d:]+ [AP]M)/g)].map((m) => m[1]);
  assert.equal(offers.length, 3);
  assert.match(offers[0], /Thu, Nov 5, 10:00 AM/, 'closest to 9 AM on that day first');
  assert.ok(offers.every((o) => !/9:00 AM-/.test(o)), 'the taken window is never offered');
  assert.deepEqual(l.offeredSlots.slice(0, 1), ['2026-11-05T10:00'], 'option numbers match what was shown');
  // picking option 1 books that window
  await say(env, l, '1');
  assert.equal(l.status, 'booked');
});

test('open requested time is confirmed as open; same request with no feed (demo calendar)', async () => {
  const { text } = await ask('dental', 'Can I come in Thursday at 9am for a cleaning?');
  assert.match(text, /Thursday at 9:00 AM is open\./);
  assert.match(text, /Open times: 1\) Thu, Nov 5, 9:00 AM/);
});

test('a time we do not start appointments at is said plainly too', async () => {
  const { text } = await ask('dental', 'Can I come in Thursday at 12pm for a cleaning?');
  assert.match(text, /We do not start appointments at 12:00 PM on Thursday\./);
});
