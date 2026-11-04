// Offers are numbered, so a bare number must pick that option (review 11).
import test from 'node:test';
import assert from 'node:assert/strict';
import { pickSlot } from '../src/extract.js';
import { makeEnv, newLead, say, makeClock, WED_10AM } from './helpers.js';

const slots = ['2026-11-05T10:00', '2026-11-05T11:00', '2026-11-05T13:00'];
const id = (t) => pickSlot(t, slots) ?? null;

test('pickSlot: bare numbers and number phrases choose the matching offer', () => {
  for (const t of ['1', '1)', '1.', ' 1 ', '#1', 'number 1', 'option 1', 'no. 1', '1 please', 'I will take 1', 'I will take #1', 'the first one']) assert.equal(id(t), slots[0], t);
  for (const t of ['2', '2)', '2.', 'number 2', '#2', 'I will take 2', 'I will take number 2', '2 please', 'the second one', 'Option 2 thanks']) assert.equal(id(t), slots[1], t);
  for (const t of ['3', '3)', 'number 3', 'I will take 3', 'the third one']) assert.equal(id(t), slots[2], t);
});

test('pickSlot: numbers that are not choices are left alone', () => {
  assert.equal(id('4'), null, 'only three were offered');
  assert.notEqual(id('I will take 2 pm'), slots[1], '2 pm is a time');
  assert.notEqual(id('1 PM'), slots[0], '1 PM is a time, not option 1');
  assert.equal(id('what about 11?'), null);
});

test('end to end: replying "2" books the second offered time', async () => {
  const env = makeEnv({ clock: makeClock(WED_10AM, 5) });
  const l = await newLead(env, {});
  const offered = [...l.offeredSlots];
  assert.ok(offered.length >= 2);
  await say(env, l, '2');
  const b = env.store.bookingForLead(l.id);
  assert.ok(b, 'a booking exists');
  assert.equal(b.slot_id, offered[1]);
});

test('ordinals that are dates, children or phrases are not choices; clear choices still are', () => {
  for (const t of ['the 2nd', 'November 2nd', 'Are you open on the 2nd?', 'my 2nd child', 'my second child', 'a second opinion', 'wait a second', 'Is the second floor accessible?',
    'the 1st', 'my 1st visit', 'it is my first time', 'the 3rd of December', 'I have a third child', 'give me one second', 'I have two kids']) {
    assert.equal(id(t), null, t);
  }
  const cases = [['the first one', 0], ['first option', 0], ['option 1', 0], ['the second one', 1], ['second option', 1], ['option two', 1], ['#2', 1], ['number 2', 1], ['I will take 2', 1], ['the third one', 2], ['third option', 2], ['3', 2], ['second', 1], ['I will take the third', 2], ['one', 0], ['The first one works for me', 0]];
  for (const [t, i] of cases) assert.equal(id(t), slots[i], t);
});
