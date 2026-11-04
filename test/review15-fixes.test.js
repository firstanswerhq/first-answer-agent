// Review 15: change claims without a booking, glued times, free offers, dangling variants.
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkOutboundRule, calendarProblem } from '../src/guard.js';

const model = (t, o = {}) => checkOutboundRule(t, {}, { model: true, booked: false, ...o });

test('cancel/move/reschedule claims are rejected on every model reply, booking or not', () => {
  for (const t of ['Your appointment has been cancelled.', "I've canceled it for you.", "Done! I've moved your appointment to Friday at 9 AM.", 'No problem, you are now rescheduled for Thursday at 2 PM.']) {
    assert.equal(model(t)?.id, 'booking_change', t);
    assert.equal(model(t, { booked: undefined })?.id, 'booking_change', t);
  }
  for (const t of ['Our hours changed for the holiday, we are open 9 to 5.', 'We moved to a new building last year.', "I can't change it myself; a teammate will follow up."]) assert.equal(model(t), null, t);
});

test('calendar check accepts glued and alternate time spellings and parts of the day', () => {
  const ids = ['2026-11-05T13:00', '2026-11-05T09:00', '2026-11-05T14:00'];
  for (const t of ['1pm', '9am', '2pm', '1PM', '1:00PM', '1-2pm', '13:00', "one o'clock", 'Thursday morning is open', 'Thursday afternoon is open']) assert.equal(calendarProblem(t, ids), null, t);
  assert.equal(calendarProblem('Nothing useful here.', ids)?.id, 'no_times');
  assert.equal(calendarProblem('Call us in 5 minutes', ids)?.id, 'no_times');
  assert.equal(calendarProblem('noon works', ['2026-11-05T12:00']), null);
});

test('"free" is only an offer for a service', () => {
  for (const t of ['Our parking is free.', '1 PM and 2 PM are free.', 'That time is free if you want it.']) assert.equal(model(t), null, t);
  for (const t of ['Your cleaning is free.', 'The first visit will be free.', 'The exam is totally free.']) assert.ok(model(t), t);
});

test('dangling: hand-offs are fine, "what is open" without a time is not an answer', () => {
  for (const t of ['Hold on to your insurance card and bring it.', 'I will look into that and a teammate will follow up.', "I'll check with the dentist and get back to you."]) assert.equal(model(t), null, t);
  for (const t of ['Let me check what is open for you.', 'Let me see what I have and get back to you.']) assert.equal(model(t)?.id, 'dangling', t);
  assert.equal(model('Let me check. 2 PM is open on Thursday.'), null);
});
