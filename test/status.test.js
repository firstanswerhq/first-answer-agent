import test from 'node:test';
import assert from 'node:assert/strict';
import { isWorking } from '../public/status.js';

test('dashboard: an alert step after Done does not make the inquiry look like it is still working', () => {
  const done = { status: 'human', timeline: [{ kind: 'received' }, { kind: 'done' }, { kind: 'alert' }] };
  assert.equal(isWorking(done), false);
  assert.equal(isWorking({ status: 'human', timeline: [{ kind: 'received' }, { kind: 'function' }, { kind: 'alert' }] }), true);
  assert.equal(isWorking({ status: 'new', timeline: [] }), true);
  assert.equal(isWorking({ status: 'replied', timeline: [{ kind: 'done' }, { kind: 'followup' }] }), false);
});
