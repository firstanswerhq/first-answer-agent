import test from 'node:test';
import assert from 'node:assert/strict';
import { localNow, isOpenNow, isRealSlot, listSlots, openSlots, slotLabel, mondayOf, addDays, isValidDate } from '../src/calendar.js';
import { Store } from '../src/store.js';
import { cfgFor, WED_10AM, WED_11PM, SUN_10AM } from './helpers.js';

const cfg = cfgFor();

test('localNow converts to business time (CST)', () => {
  assert.equal(localNow(WED_10AM, cfg.business.tz), '2026-11-04T10:00');
  assert.equal(localNow(WED_11PM, cfg.business.tz), '2026-11-04T23:00');
});

test('isOpenNow follows business hours', () => {
  assert.equal(isOpenNow('2026-11-04T10:00', cfg.hours), true);
  assert.equal(isOpenNow('2026-11-04T23:00', cfg.hours), false);
  assert.equal(isOpenNow('2026-11-08T10:00', cfg.hours), false, 'closed Sunday');
  assert.equal(isOpenNow('2026-11-07T09:30', cfg.hours), true, 'open Saturday morning');
  assert.equal(isOpenNow('2026-11-07T13:00', cfg.hours), false);
});

test('isRealSlot rejects anything outside the configured windows', () => {
  assert.equal(isRealSlot('2026-11-05T10:00', cfg.hours), true);
  for (const bad of ['2026-11-05T07:00', '2026-11-05T12:00', '2026-11-05T22:00', '2026-11-08T10:00', '2026-02-30T10:00', 'tomorrow', '', null, '2026-11-05T10:30']) {
    assert.equal(isRealSlot(bad, cfg.hours), false, String(bad));
  }
});

test('listSlots marks past, booked and open windows from the real store', () => {
  const store = new Store();
  store.bookings.push({ slot_id: '2026-11-05T10:00', status: 'confirmed', leadId: 'x', name: 'A', jobLabel: 'J' });
  const slots = listSlots(store, cfg, WED_10AM, '2026-11-04', 2);
  const by = Object.fromEntries(slots.map((s) => [s.slot_id, s.status]));
  assert.equal(by['2026-11-04T08:00'], 'past');
  assert.equal(by['2026-11-04T10:00'], 'past');
  assert.equal(by['2026-11-04T13:00'], 'open', 'at least 2 hours of notice');
  assert.equal(by['2026-11-05T10:00'], 'booked');
});

test('openSlots skips Sundays and respects the limit', () => {
  const store = new Store();
  const slots = openSlots(store, cfg, SUN_10AM, undefined, 7, 3);
  assert.equal(slots.length, 3);
  assert.ok(slots.every((s) => !s.slot_id.startsWith('2026-11-08')));
});

test('date helpers', () => {
  assert.equal(mondayOf('2026-11-04'), '2026-11-02');
  assert.equal(mondayOf('2026-11-08'), '2026-11-02');
  assert.equal(addDays('2026-11-30', 1), '2026-12-01');
  assert.equal(isValidDate('2026-02-29'), false);
  assert.match(slotLabel('2026-11-05T13:00'), /Thu, Nov 5, 1:00 PM-3:00 PM/);
});
