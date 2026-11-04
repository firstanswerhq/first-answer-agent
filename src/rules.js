// Offline rules engine. It follows the SAME path as the model: qualify, check the
// calendar, reply, book, schedule a follow-up, escalate. It calls the very same
// guarded functions. Deterministic, no network.
import { detectService, detectLocation, wantsOutsideHours, pickSlot, slotCandidates, declinesSlots } from './extract.js';
import { firstName, money } from './util.js';
import { slotLabel, addDays, dateOf, localNow, isOpenNow } from './calendar.js';

const SIGN = (config) => ` - ${config.business.agentName} (AI)`;

export async function runRules(ctx, fx, trigger) {
  const { lead, config, flags } = ctx;
  const biz = config.business.name;
  const wording = config.wording;
  const urgency = config.profile.urgency;
  const first = firstName(lead.name);
  const customerText = lead.messages.filter((m) => m.from === 'customer').map((m) => m.text).join('\n');
  const latest = [...lead.messages].reverse().find((m) => m.from === 'customer')?.text || '';
  const reply = (text) => fx.call('send_reply', { text: text + SIGN(config) });
  const escalate = (reason, priority = 'normal') => fx.call('escalate_to_human', { reason, priority });

  // 1. Hard stops that need a person.
  if (lead.status === 'human') return;
  if (flags.injection) {
    await reply('I can only help with scheduling and questions about our services, so I have passed your message to a teammate who will follow up.');
    await escalate('Message contained instructions aimed at the agent (possible prompt injection); held for human review.');
    return;
  }
  if (flags.complaint) {
    await reply(`${first}, I am sorry about this experience. I am not the right one to fix it, so I have asked the owner to call you personally.`);
    await escalate('Complaint or angry customer; the owner should call personally.');
    return;
  }

  // 2. Qualify from everything the customer has said.
  let service = detectService(customerText, config);
  if (lead.qualification?.service && lead.qualification.service !== 'other' && service === 'other') service = lead.qualification.service;
  let loc = detectLocation(customerText, config);
  if (!loc.known && lead.qualification?.location) loc = { text: lead.qualification.location, known: true, inArea: lead.qualification.serviceAreaOk, needed: true };
  if (flags.emergency && service === 'other' && urgency.defaultService) service = urgency.defaultService;
  const level = flags.emergency ? 'emergency' : urgency.urgentRe?.test(customerText) ? 'urgent' : 'routine';

  // Booked leads: only acknowledge; changes go to a person.
  if (lead.status === 'booked' || ctx.store.bookingForLead(lead.id)) {
    if (flags.handoff) {
      await reply('I have passed your request to a teammate, who will confirm the change with you directly.');
      await escalate('Customer wants to change or cancel an existing booking.');
    } else {
      await reply('You are all set. Reply here if anything changes and a teammate will help.');
    }
    return;
  }

  const q = await fx.call('qualify_lead', { service, urgency: level, location: loc.text, notes: latest.slice(0, 280) });
  if (!q.ok) { await escalate('Could not qualify the lead.'); return; }

  if (flags.handoff) {
    await reply('Thanks for the details. This one needs a person, so I have passed it to a teammate who will follow up with you directly.');
    await escalate(flags.reasons.find((r) => /needs a person|always goes to a person/.test(r)) || 'Customer request needs a person.');
    return;
  }
  if (flags.outOfScope && service === 'other') {
    await reply('That is outside what I can schedule here, so I have passed it to a teammate.');
    await escalate('Request is outside the services the agent schedules.');
    return;
  }
  if (q.service_area_ok === false) {
    await reply(`Thanks, ${first}. ${loc.text} may be outside our ${config.serviceArea?.label || 'service area'}, so I have asked a teammate to confirm and get back to you.`);
    await escalate(`Location (${loc.text}) appears to be outside the service area.`);
    return;
  }

  // 3. Urgent situation that needs a person now: priority path. Hold the earliest time (when enabled) and bring in a person at once.
  if (level === 'emergency') {
    if (q.service_area_ok !== true) {
      await reply(`${first}, ${urgency.safetyNote} I have flagged this as a priority and someone will call you shortly.`);
      await escalate(`${urgency.handoffReason} (location unconfirmed)`, 'urgent');
      return;
    }
    const cal = await fx.call('check_calendar', { days: 7, limit: 2 });
    let held = null;
    if (cal.ok && cal.slots.length && (config.limits.emergencyHolds || lead.seed)) {
      const b = await fx.call('book_appointment', { slot_id: cal.slots[0].slot_id, note: urgency.holdNote });
      if (b.ok) held = b.label;
    }
    await reply(`${first}, I am sorry you are dealing with this. ${urgency.safetyNote} I have flagged this as a priority${held ? ` and held the earliest ${wording.appointment}: ${held}` : ''}. Someone will call you at this number shortly.`);
    await escalate(urgency.handoffReason, 'urgent');
    return;
  }

  // 4. Not enough information yet: ask one clear question.
  if (service === 'other' || (loc.needed && !loc.known) || q.service_area_ok === null) {
    const needService = service === 'other';
    const needLoc = loc.needed && !loc.known || q.service_area_ok === null;
    const attempts = lead.messages.filter((m) => m.from === 'agent' && m.askedInfo).length;
    if (attempts >= 2) {
      await reply('I want to make sure you get the right help, so I have asked a teammate to follow up with you directly.');
      await escalate('Agent could not get a clear request after two questions.');
      return;
    }
    const where = config.serviceArea ? `what ZIP code or neighborhood are you in (${config.serviceArea.label})` : '';
    const ask = needService && needLoc ? `${wording.askService.replace(/\?$/, '')}, and ${where}?`
      : needService ? wording.askService : `${where}, so I can confirm we cover it?`;
    const r = await reply(`Hi ${first}, thanks for reaching out to ${biz}. Happy to help: ${ask}`);
    if (r.ok) lead.messages[lead.messages.length - 1].askedInfo = true;
    await fx.call('schedule_followup', { delay_minutes: 30, text: `Hi ${first}, just checking in. Tell me what you would like to book${config.serviceArea ? ' and your ZIP code' : ''} whenever you are ready and I will line up a time. ${SIGN(config).trim()}`.slice(0, 400) });
    return;
  }

  // 5. Customer is choosing among offered windows.
  if (lead.offeredSlots?.length && lead.messages.filter((m) => m.from === 'agent').length > 0 && trigger !== 'new_lead') {
    const chosen = pickSlot(latest, lead.offeredSlots);
    if (chosen) {
      const b = await fx.call('book_appointment', { slot_id: chosen, note: '' });
      if (b.ok) { await reply(`Booked, ${first}: ${b.label}. ${wording.bookedAfter}`); return; }
      // Slot vanished: fall through and re-offer.
    } else if (!declinesSlots(latest)) {
      // The customer named a day or time that fits several offered windows (for example all three are Thursday):
      // ask which one instead of counting it as a failed attempt. Two unclear answers in a row go to a person.
      const tries = lead.messages.filter((m) => m.from === 'agent' && m.clarified).length;
      const several = slotCandidates(latest, lead.offeredSlots);
      if (tries >= 2) {
        await reply('I want to get this right, so I have asked a teammate to confirm a time with you directly.');
        await escalate('Customer reply did not match any offered time after two clarifying questions.');
        return;
      }
      const clock = (id) => { const h = Number(id.slice(11, 13)); return `${h % 12 || 12} ${h >= 12 ? 'PM' : 'AM'}`; };
      let ask = 'Which of those times works best? Reply with the day or the number of the option.';
      if (several.length > 1) {
        const days = new Set(several.map((i) => lead.offeredSlots[i].slice(0, 10)));
        const dayName = days.size === 1 ? new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long' }).format(new Date(`${[...days][0]}T12:00:00Z`)) : '';
        const times = several.map((i) => clock(lead.offeredSlots[i]));
        const list = times.length === 2 ? `${times[0]} or ${times[1]}` : `${times.slice(0, -1).join(', ')} or ${times.at(-1)}`;
        ask = `Which time${dayName ? ` on ${dayName}` : ''} works best: ${list}? Reply with the time or the option number.`;
      }
      await reply(ask);
      lead.messages[lead.messages.length - 1].clarified = true;
      return;
    }
  }

  // 6. Offer real windows with a price-book range.
  const sinceDate = declinesSlots(latest) && lead.offeredSlots?.length ? addDays(dateOf(lead.offeredSlots.at(-1)), 1) : undefined;
  const cal = await fx.call('check_calendar', { days: 10, limit: 3, ...(sinceDate ? { earliest_date: sinceDate } : {}) });
  if (!cal.ok || !cal.slots.length) {
    await reply('I could not find an open time right now, so I have asked a teammate to find a time for you.');
    await escalate('No open calendar times available.');
    return;
  }
  const times = cal.slots.map((s, i) => `${i + 1}) ${s.label}`).join('  ');
  const price = q.price_range
    ? `Typical range for this is ${money(q.price_range.low)}-${money(q.price_range.high)}, ${wording.priceNote}.`
    : wording.noQuote;
  const afterHours = wantsOutsideHours(customerText)
    ? `We only schedule ${wording.appointment}s during business hours (${config.hours.text}), so I cannot book that time. `
    : !isOpenNow(localNow(ctx.now(), config.business.tz), config.hours) ? 'We are closed right now, but I can already hold a time. ' : '';
  await reply(`Hi ${first}! ${afterHours}${q.service_label}${loc.needed && loc.text ? ' in ' + loc.text : ''}: ${price} Open times: ${times}. Which one works?`);
  await fx.call('schedule_followup', { delay_minutes: 30, text: `Hi ${first}, still want me to hold one of those times for your ${q.service_label.toLowerCase()}? Reply with the day or option number.` });
  void slotLabel;
}
