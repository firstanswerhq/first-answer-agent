import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, makeClock, fakeLlm, reply, startServer, cfgFor, WED_10AM } from './helpers.js';
import { LlmClient } from '../src/llm.js';

const ok = (model = 'glm-test') => ({ status: 200, json: { model, choices: [{ message: { role: 'assistant', content: 'OK' } }] } });

test('a configured key alone is not "verified": /api/health says modelVerified only after a real call succeeds', async () => {
  const llm = fakeLlm([ok()]);
  const s = await startServer({ llm, now: makeClock(WED_10AM).now });
  try {
    let h = await (await fetch(`${s.base}/api/health`)).json();
    assert.equal(h.inferenceConfigured, true);
    assert.equal(h.modelVerified, false, 'a key that has never been used proves nothing');
    assert.equal(await s.agent.probeModel(), true);
    h = await (await fetch(`${s.base}/api/health`)).json();
    assert.equal(h.modelVerified, true);
    assert.equal(h.mode, 'model');
    assert.equal(s.agent.status().modelRuns, 0, 'the test call is not a customer run');
    assert.equal(llm.fetchMock.state.bodies[0].messages[0].content.includes('OK'), true);
    assert.equal(llm.fetchMock.state.bodies[0].tools, undefined, 'no customer data, no tools');
  } finally { await s.stop(); }
});

test('a wrong key is reported as not verified, with the reason, and the demo falls back to offline rules', async () => {
  const llm = fakeLlm([{ status: 401, json: {} }]);
  const s = await startServer({ llm, now: makeClock(WED_10AM).now });
  try {
    assert.equal(await s.agent.probeModel(), false);
    const h = await (await fetch(`${s.base}/api/health`)).json();
    assert.equal(h.modelVerified, false);
    assert.equal(h.mode, 'offline');
    assert.match(h.lastError, /HTTP 401/);
    assert.ok(!JSON.stringify(h).includes('test-key'));
  } finally { await s.stop(); }
});

test('no key or forced offline: probe makes no network call and nothing is verified', async () => {
  const none = makeEnv({ llm: new LlmClient({ key: '', url: 'https://example.invalid/v1', model: 'm', fetchImpl: async () => { throw new Error('no network expected'); } }) });
  assert.equal(await none.agent.probeModel(), null);
  const llm = fakeLlm([ok()]);
  const forced = makeEnv({ llm, config: cfgFor({ forceOffline: true }) });
  assert.equal(await forced.agent.probeModel(), null);
  assert.equal(llm.fetchMock.state.calls.length, 0);
  assert.equal(forced.agent.status().modelVerified, false);
});

void reply;
