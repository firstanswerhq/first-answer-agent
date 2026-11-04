// Offline rules engine. It follows the SAME path as the model: qualify, check the
// calendar, reply, book, schedule a follow-up, escalate. It calls the very same
// guarded functions. Deterministic, no network.
import { detectService, detectServices, detectLocation, wantsOutsideHours, pickSlot, slotCandidates, declinesSlots, requestedDay, slotOnDay } from './extract.js';
import { firstName, money } from './util.js';
import { slotLabel, addDays, dateOf, localNow, isOpenNow, dateLabel } from './calendar.js';

const SIGN = (config) => ` - ${config.business.agentName} (AI)`;
const lc = (label) => (/^[A-Z][A-Z]/.test(label) ? label : label.charAt(0).toLowerCase() + label.slice(1));
const aOrAn = (w) => (/^[aeiou]/i.test(w) ? 'an' : 'a');
const upper1 = (t) => t.charAt(0).toUpperCase() + t.slice(1);

export async function runRules(ctx, fx, trigger) {
  const { lead, config, flags } = ctx;
  const biz = config.business.name;
  const wording = config.wording;
  const urgency = config.profile.urgency;
  const first = firstName(lead.name);
  const customerText = lead.messages.filter((m) => m.from === 'customer').map((m) => m.text).join('\n');
  const latest = [...lead.messages].reverse().find((m) => m.from === 'customer')?.text || '';
  // "Dana, I am sorry..." or, when the name is not usable, "I am sorry...".
  const addr = (rest) => (first === 'there' ? upper1(rest) : `${first}, ${rest}`);
  const phone = config.business.phone;
  const reply = (text) => fx.call('send_reply', { text: text + SIGN(config) });
  const escalate = (reason, priority = 'normal') => fx.call('escalate_to_human', { reason, priority });

  // 1. Hard stops that need a person.
  if (lead.status === 'human') return;
  if (flags.medical) {
    // Fixed, safe wording for any business: call 911 (or 988), and bring a person in at once.
    await reply(`Please call 911 right now if you or someone else is in danger or having a medical emergency. I am an automated assistant and cannot help with emergencies by text. I have flagged this for our team, and you can also reach us at ${phone}.${flags.selfHarm ? ' If you are thinking about harming yourself, you can call or text 988 at any time.' : ''}`);
    await escalate('Possible medical or personal-safety emergency; the customer was told to call 911. A person should reach out now.', 'urgent');
    return;
  }
  if (flags.injection) {
    await reply('I can only help with scheduling and questions about our services, so I have passed your message to a teammate who will follow up.');
    await escalate('Message contained instructions aimed at the agent (possible prompt injection); held for human review.');
    return;
  }
  if (flags.complaint) {
    await reply(`${addr('I am sorry about this experience. I am not the right one to fix it, so I have flagged this for our team and a person will follow up with you. If you would rather call us, we are at ' + phone + '.')}`);
    await escalate('Complaint or angry customer; the owner should call personally.');
    return;
  }

  // 2. Qualify from everything the customer has said.
  const mentioned = detectServices(customerText, config);
  let service = detectService(customerText, config);
  if (lead.qualification?.service && lead.qualification.service !== 'other' && service === 'other') service = lead.qualification.service;
  let loc = detectLocation(customerText, config);
  if (!loc.known && lead.qualification?.location) loc = { text: lead.qualification.location, known: true, inArea: lead.qualification.serviceAreaOk, needed: true };
  if (flags.emergency && service === 'other' && urgency.defaultService) service = urgency.defaultService;
  const level = flags.emergency ? 'emergency' : urgency.urgentRe?.test(customerText) ? 'urgent' : 'routine';

  // Booked leads: only acknowledge; changes go to a person.
  if (lead.status === 'booked' || ctx.store.bookingForLead(lead.id)) {
    if (flags.handoff) {
      const change = /\b(cancel|reschedule|move|change)\b/i.test(latest);
      await reply(change ? 'I have passed your request to a teammate, who will confirm the change with you directly.' : 'I have asked a teammate to follow up with you directly.');
      await escalate(change ? 'Customer wants to change or cancel an existing booking.' : 'Customer asked for a person after booking.');
    } else {
      await reply('You are all set. Reply here if anything changes and a teammate will help.');
    }
    return;
  }

  // A second named service ("a haircut and a blowout") is recorded too, so both price ranges can be quoted.
  const also = mentioned.find((id) => id !== service && service !== 'other');
  const q = await fx.call('qualify_lead', { service, urgency: level, location: loc.text, notes: latest.slice(0, 280), ...(also ? { also_service: also } : {}) });
  if (!q.ok) { await escalate('Could not qualify the lead.'); return; }

  if (flags.handoff) {
    await reply('Thanks. This one needs a person, so I have passed it to a teammate who will follow up with you directly.');
    await escalate(flags.reasons.find((r) => /needs a person|always goes to a person/.test(r)) || 'Customer request needs a person.');
    return;
  }
  if (flags.outOfScope) {
    // Never offer times for half of a mixed request and then park the lead without saying so.
    await reply(service === 'other'
      ? 'That is outside what I can schedule here, so I have passed it to a teammate.'
      : `I can schedule your ${lc(q.service_label)}, but part of your request is outside what I can book here. I have passed the whole request to a teammate who will confirm everything with you.`);
    await escalate('Request is outside the services the agent schedules (or only partly inside them).');
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
      await reply(`${addr(urgency.safetyNote + ' I have marked this urgent and flagged it for our team; a person will follow up. If you do not hear from us within 15 minutes, please call us at ' + phone + '.')}`);
      await escalate(`${urgency.handoffReason} (location unconfirmed)`, 'urgent');
      return;
    }
    const cal = await fx.call('check_calendar', { days: 7, limit: 2 });
    let held = null;
    if (cal.ok && cal.slots.length && (config.limits.emergencyHolds || lead.seed)) {
      const b = await fx.call('book_appointment', { slot_id: cal.slots[0].slot_id, note: urgency.holdNote });
      if (b.ok) held = b.label;
    }
    await reply(`${addr('I am sorry you are dealing with this. ' + urgency.safetyNote + ' I have marked this urgent and flagged it for our team' + (held ? `, and held the earliest ${wording.appointment}: ${held}` : '') + '. If you do not hear from us within 15 minutes, please call us at ' + phone + '.')}`);
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
    // The second ask sounds different from the first, so the customer never gets the same message twice in a row.
    const r = await reply(attempts === 0
      ? `Hi ${first}, thanks for reaching out to ${biz}. Happy to help: ${ask}`
      : `Sorry, ${first === 'there' ? '' : first + ', '}I did not catch that. ${upper1(ask)}`);
    if (r.ok) lead.messages[lead.messages.length - 1].askedInfo = true;
    await fx.call('schedule_followup', { delay_minutes: 30, text: `Hi ${first}, just checking in. Tell me what you would like to book${config.serviceArea ? ' and your ZIP code' : ''} whenever you are ready and I will line up a time. ${SIGN(config).trim()}`.slice(0, 400) });
    return;
  }

  const todayLocal = dateOf(localNow(ctx.now(), config.business.tz));
  const declines = declinesSlots(latest);
  const reqDay = declines ? null : requestedDay(latest, todayLocal);
  const offered = lead.offeredSlots || [];
  // The customer named a day (or date) and none of the windows already offered is on it.
  const dayMismatch = !!reqDay && offered.length > 0 && !offered.some((id) => slotOnDay(id, reqDay));
  let bookNote = '';

  // 5. Customer is choosing among offered windows.
  if (offered.length && lead.messages.filter((m) => m.from === 'agent').length > 0 && trigger !== 'new_lead' && !dayMismatch) {
    const chosen = pickSlot(latest, offered);
    if (chosen) {
      const b = await fx.call('book_appointment', { slot_id: chosen, note: '' });
      if (b.ok) { await reply(`Booked, ${first}: ${b.label}. ${wording.bookedAfter}`); return; }
      if (b.code === 'visitor_cap' || b.code === 'demo_calendar_full') {
        // Say what happened and bring in a person, instead of offering the same times again.
        await reply(b.code === 'visitor_cap'
          ? `I would like to lock that in, ${first}, but this public demo only holds a few bookings per visitor. I have asked a teammate to confirm your time directly.`
          : `I would like to lock that in, ${first}, but the demo calendar is full of visitor bookings right now. I have asked a teammate to confirm your time directly.`);
        await escalate('Demo booking limit reached; a teammate should confirm the requested time with the customer.');
        return;
      }
      bookNote = 'That time is no longer open, so here are fresh options. ';
    } else if (!declines) {
      // The customer named a day or time that fits several offered windows (for example all three are Thursday):
      // ask which one instead of counting it as a failed attempt. Two unclear answers in a row go to a person.
      const tries = lead.messages.filter((m) => m.from === 'agent' && m.clarified).length;
      const several = slotCandidates(latest, offered);
      if (tries >= 2) {
        await reply('I want to get this right, so I have asked a teammate to confirm a time with you directly.');
        await escalate('Customer reply did not match any offered time after two clarifying questions.');
        return;
      }
      const clock = (id) => { const h = Number(id.slice(11, 13)); return `${h % 12 || 12} ${h >= 12 ? 'PM' : 'AM'}`; };
      let ask = 'Which of those times works best? Reply with the day or the number of the option.';
      if (several.length > 1) {
        const days = new Set(several.map((i) => offered[i].slice(0, 10)));
        const dayName = days.size === 1 ? new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long' }).format(new Date(`${[...days][0]}T12:00:00Z`)) : '';
        const times = several.map((i) => clock(offered[i]));
        const list = times.length === 2 ? `${times[0]} or ${times[1]}` : `${times.slice(0, -1).join(', ')} or ${times.at(-1)}`;
        ask = `Which time${dayName ? ` on ${dayName}` : ''} works best: ${list}? Reply with the time or the number of the option.`;
      }
      await reply(ask);
      lead.messages[lead.messages.length - 1].clarified = true;
      return;
    }
  }

  // 6. Offer open windows with a price range. A day the customer asked for, or "next week", sets where the search starts.
  const wantsNextWeek = /\bnext week\b/i.test(latest);
  const nextMonday = addDays(mondayStart(todayLocal), 7);
  const sinceDate = declines && offered.length ? addDays(dateOf(offered.at(-1)), 1)
    : reqDay ? reqDay.date
      : wantsNextWeek ? nextMonday : undefined;
  const cal = await fx.call('check_calendar', { days: 10, limit: 3, ...(sinceDate ? { earliest_date: sinceDate } : {}) });
  if (!cal.ok || !cal.slots.length) {
    await reply('I could not find an open time right now, so I have asked a teammate to find a time for you.');
    await escalate('No open calendar times available.');
    return;
  }
  const times = cal.slots.map((s, i) => `${i + 1}) ${s.label}`).join('  ');
  const range = (r) => `${money(r.low)}-${money(r.high)}`;
  let price;
  if (q.price_range && q.also_price_range) price = `${upper1(aOrAn(q.service_label))} ${lc(q.service_label)} usually runs ${range(q.price_range)} and ${aOrAn(q.also_service_label)} ${lc(q.also_service_label)} ${range(q.also_price_range)}; ${wording.priceNote}.`;
  else if (q.price_range) price = `${upper1(aOrAn(q.service_label))} ${lc(q.service_label)} usually runs ${range(q.price_range)}; ${wording.priceNote}.`;
  else price = wording.noQuote;
  const closedNow = !isOpenNow(localNow(ctx.now(), config.business.tz), config.hours);
  const intro = wantsOutsideHours(customerText)
    ? `We only schedule ${wording.appointment}s during business hours: ${config.hours.text}. I cannot book that time, but here is what is open. `
    : closedNow ? 'We are closed right now, but I can already hold a time. ' : '';
  let dayNote = '';
  if (reqDay) {
    const dayName = dateLabel(reqDay.date, true).split(',')[0];
    const onThatDay = cal.slots.some((sl) => sl.slot_id.slice(0, 10) === reqDay.date);
    dayNote = onThatDay ? `Here is what is open on ${dayName}. ` : `I do not have an opening on ${reqDay.weekday ? dayName : dateLabel(reqDay.date)}. We are open ${config.hours.text}, so here are the nearest times. `;
  } else if (wantsNextWeek && cal.slots.every((sl) => sl.slot_id.slice(0, 10) >= nextMonday)) dayNote = 'Here is what is open next week. ';
  const inLoc = loc.needed && loc.text ? ` in ${loc.text}` : '';
  const body = q.price_range ? `${price.replace(/ usually runs/, inLoc + ' usually runs')}` : `${q.service_label}${inLoc}: ${price}`;
  let text = `Hi ${first}! ${bookNote}${dayNote}${intro}${body} Open times: ${times}. Which one works?`;
  // Never send the identical offer twice in a row.
  const lastAgent = [...lead.messages].reverse().find((m) => m.from === 'agent');
  if (lastAgent && lastAgent.text === text + SIGN(config)) {
    await reply('I want to make sure you get a time that works, so I have asked a teammate to follow up with you directly.');
    await escalate('The agent had nothing new to offer; a person should find a time with the customer.');
    return;
  }
  await reply(text);
  await fx.call('schedule_followup', { delay_minutes: 30, text: `Hi ${first}, still want me to hold one of those times for your ${q.service_label.toLowerCase()}? Reply with the day or option number.` });
  void slotLabel;
}

// Monday of the week that contains the given date (weeks run Monday to Sunday).
function mondayStart(date) {
  const [y, m, d] = date.split('-').map(Number);
  const w = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return addDays(date, w === 0 ? -6 : 1 - w);
}
