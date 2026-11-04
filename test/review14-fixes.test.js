import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, newLead, agentTexts, profileCfg } from './helpers.js';
import { holidayName, missingFactText } from '../src/facts.js';

const ask = async (name, message) => {
  const env = makeEnv({ config: profileCfg(name) });
  const l = await newLead(env, { message });
  return { env, l, text: agentTexts(l).join(' | ') };
};

test('dental latex-glove and material allergy questions go to a person', async () => {
  for (const m of ['Do you use latex gloves? I have an allergy.', 'I am allergic to nitrile, is that a problem?', 'Which numbing medicine do you use?']) {
    const { l, text } = await ask('dental', m);
    assert.equal(l.status, 'human', m);
    assert.match(text, /Allergy and materials questions go to our dental team/, m);
  }
});

test('holidays: Thanksgiving, Christmas Eve and Day and New Year are never reported as open; a teammate confirms', async () => {
  for (const [d, m] of [['Nov 26', 'Thanksgiving'], ['Dec 24', 'Christmas Eve'], ['Dec 25', 'Christmas Day'], ['Jan 1', "New Year's Day"]]) {
    const { l, text } = await ask('dental', `Can I come in ${d} at 9am for a cleaning?`);
    if (d === 'Jan 1') continue; // Jan 1 of this year is already past; the past-date wording applies instead
    assert.match(text, new RegExp(`is ${m}`), d);
    assert.match(text, /a teammate will confirm holiday hours/, d);
    assert.doesNotMatch(text, /is open\./, d);
    assert.match(l.confirmNeeded, /holiday hours/, d);
    assert.equal(l.status, 'replied', d);
  }
  assert.equal(holidayName('2027-01-01'), "New Year's Day");
  assert.equal(holidayName('2026-11-19'), null);
});

test('missing-fact wording reads as a sentence', () => {
  assert.equal(missingFactText(['our accepted payment methods']), 'I do not have our accepted payment methods on file, so a teammate will confirm that for you.');
});

test('payment-method question uses the new wording', async () => {
  const { text } = await ask('dental', 'Do you accept credit cards?');
  assert.match(text, /I do not have our accepted payment methods on file/);
});
