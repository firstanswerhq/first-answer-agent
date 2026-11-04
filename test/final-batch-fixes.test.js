// Final batch (Nov 4): urgent replies always carry the safety note and phone; handoff claims; out-of-scope alerts; rules quality; health counts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { makeEnv, makeClock, newLead, fakeLlm, call, reply, agentTexts, PROFILE_NAMES } from './helpers.js';

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
