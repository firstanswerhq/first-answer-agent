import test from 'node:test';
import assert from 'node:assert/strict';
import { cfgFor, startServer, post, lead } from './helpers.js';

const limits = (over) => ({ ...cfgFor().limits, ...over });

test('rate limit: blank and invalid submissions never use up the allowance', async () => {
  const s = await startServer({ config: cfgFor({ limits: limits({ leadRate: { windowMs: 60_000, max: 3 } }) }) });
  try {
    for (let i = 0; i < 12; i += 1) assert.equal((await post(s.base, '/api/leads', {})).status, 400);
    const codes = [];
    for (let i = 0; i < 4; i += 1) codes.push((await post(s.base, '/api/leads', lead())).status);
    assert.deepEqual(codes, [202, 202, 202, 429]);
  } finally { await s.stop(); }
});

test('rate limit: the hourly allowance is per business profile, and simulate buttons have their own', async () => {
  const s = await startServer({ config: cfgFor({ limits: limits({ leadRateHour: { windowMs: 3_600_000, max: 2 }, leadRate: { windowMs: 60_000, max: 50 } }) }) });
  try {
    const withProfile = (p, b) => post(s.base, '/api/leads', b, { 'x-profile': p });
    assert.equal((await withProfile('dental', lead())).status, 202);
    assert.equal((await withProfile('dental', lead())).status, 202);
    assert.equal((await withProfile('dental', lead())).status, 429);
    assert.equal((await withProfile('salon', lead())).status, 202, 'salon has its own allowance');
    assert.equal((await withProfile('accounting', lead())).status, 202);
    for (let i = 0; i < 3; i += 1) assert.equal((await post(s.base, '/api/simulate', { scenario: 'price_question' }, { 'x-profile': 'dental' })).status, 202, 'simulate does not spend the real allowance');
  } finally { await s.stop(); }
});

test('rate limit: simulate has its own small cap', async () => {
  const s = await startServer({ config: cfgFor({ limits: limits({ simRate: { windowMs: 60_000, max: 2 } }) }) });
  try {
    const codes = [];
    for (let i = 0; i < 3; i += 1) codes.push((await post(s.base, '/api/simulate', { scenario: 'price_question' })).status);
    assert.deepEqual(codes, [202, 202, 429]);
    assert.equal((await post(s.base, '/api/leads', lead())).status, 202, 'real inquiries are unaffected');
  } finally { await s.stop(); }
});

test('rate limit: defaults are judge-friendly (20 accepted per hour per visitor, 60 per address)', () => {
  const l = cfgFor().limits;
  assert.equal(l.leadRateHour.max, 20);
  assert.equal(l.leadIpHour.max, 60);
});
