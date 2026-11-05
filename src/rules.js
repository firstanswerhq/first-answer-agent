// Offline rules engine. It follows the SAME path as the model: qualify, check the
// calendar, reply, book, schedule a follow-up, escalate. It calls the very same
// guarded functions. Deterministic, no network.
import { requestedClock, partOfDay, pastDay, detectService, detectServices, detectLocation, wantsOutsideHours, pickSlot, slotCandidates, declinesSlots, requestedDay, slotOnDay, windowOf, picksOffered, asksOtherTime, strictPick, bareHourOf, isAvailabilityRequest } from './extract.js';
import { firstName, money } from './util.js';
import { CHANGE_REQUEST, isOffTopic } from './safety.js';
import { slotLabel, addDays, dateOf, localNow, isOpenNow, dateLabel, listSlots, slotsForDate, fmtClock, openSlots } from './calendar.js';
import { factAnswers, missingFactText, holidayName } from './facts.js';

const SIGN = (config) => ` - ${config.business.agentName} (AI)`;
const lc = (label) => (/^[A-Z][A-Z]/.test(label) ? label : label.charAt(0).toLowerCase() + label.slice(1));
const aOrAn = (w) => (/^[aeiou]/i.test(w) ? 'an' : 'a');
const upper1 = (t) => t.charAt(0).toUpperCase() + t.slice(1);

/** Fixed safe wording for a possible medical or personal-safety emergency (also used for later messages after a handoff). */
export function medicalText(config, flags) {
  // For self-harm the 988 line comes first: it is the line that matters most to this person.
  const lead988 = flags.selfHarm ? 'If you are thinking about harming yourself, please call or text 988 right now, at any time. ' : '';
  return `${lead988}Please call 911 right now if you or someone else is in danger or having a medical emergency. I am an automated assistant and cannot help with emergencies by text. I have flagged this for our team, and you can also reach us at ${config.business.phone}.`;
}

const EXPLICIT_BOOK = /\b(?:book me|please book|put me down|sign me up|schedule me|reserve|go ahead and book|like to (?:book|schedule)|want to (?:book|schedule))\b/i;
const UNLISTED_WORK = /\b(?:root canals?|crowns?|bridges?|dentures?|implants?|extractions?|wisdom teeth|veneers?|bonding|sealants?|retainers?|night ?guards?|periodontal|gum disease|deep clean\w*|scaling|perm|keratin|relaxer|hair extensions?|balayage|highlights?|bridal|updo|tax returns?|audit|payroll|bookkeeping|llc|incorporat\w*)\b/i;

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
  if (flags.medical || flags.injection || flags.complaint) ctx.writer = 'safety';
  if (flags.medical) {
    // Fixed, safe wording for any business: call 911 (or 988), and bring a person in at once.
    await reply(medicalText(config, flags));
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
  if (lead.serviceDefaulted && detectService(customerText, config) !== 'other') lead.serviceDefaulted = false; // the customer named the visit themselves
  // A treatment this business has no price for (root canal, crown, ...) must never be answered with the default service's price.
  const unpriced = detectService(customerText, config) === 'other' && UNLISTED_WORK.test(customerText);
  if (flags.emergency && service === 'other' && urgency.defaultService) service = urgency.defaultService;
  // A vague service word with a day, a time or "as soon as possible" ("an exam Thursday at 9", "an appointment ASAP") is still a request for times:
  // pick the service that word names (or the first priced one) instead of asking what to book.
  if (service === 'other' && !flags.emergency && !flags.handoff && !flags.topic) {
    const generic = latest.match(/\b(exam|check-?up|cleaning|consultation|appointment|visit|session|booking)\b/i);
    const asksTimes = requestedDay(latest, dateOf(localNow(ctx.now(), config.business.tz))) || /\b(this week|next week|sometime|asap|as soon as possible|soonest|earliest|right away|openings?|availab\w*|anything open|open (?:today|tomorrow))\b/i.test(latest);
    const offeredNow = lead.offeredSlots || [];
    const picking = trigger !== 'new_lead' && offeredNow.length && picksOffered(latest, offeredNow);
    const plainWhen = /\b(?:mornings?|afternoons?|asap|as soon as possible|soonest|earliest|right away|openings?|availab\w*|anything|something|sometime|this week|next week|tomorrow|today|open)\b/i.test(latest);
    if (picking) {
      // The customer picked one of the times already offered: never ask the visit type again. Use the one from the inquiry, else the main service.
      const fromInquiry = detectService(customerText, config);
      service = fromInquiry !== 'other' ? fromInquiry : (customerText.match(/\b(exam|check-?up)\b/i) && config.services.find((x) => /exam|check/i.test(x.label) && !/\bnew\b/i.test(x.label))?.id) || config.services.find((x) => x.price && !/\bnew\b/i.test(x.label))?.id || 'other';
      if (service !== 'other') lead.serviceDefaulted = true;
    } else if (!generic && (asksTimes || plainWhen) && !(/\b(?:are you open|do you open|what(?:'s| is| are)? (?:your |the )?hours|what time do you (?:open|close)|open on)\b/i.test(latest) && !/\b(?:openings?|availab\w*|appointments?|book\w*|schedul\w*|slots?)\b/i.test(latest)) && !flags.offTopic && !isOffTopic(latest, config.profile) && (requestedDay(latest, dateOf(localNow(ctx.now(), config.business.tz))) || /\b(?:asap|as soon as possible|soonest|earliest|this week|next week|tomorrow|today|openings?|availab\w*|mornings?|afternoons?)\b/i.test(latest) || windowOf(latest))) {
      // A day or "ASAP" with no service word: still a request for times, so show real ones for the main service.
      service = config.services.find((x) => x.price && !/\bnew\b/i.test(x.label))?.id || 'other';
      if (service !== 'other') lead.serviceDefaulted = true;
    } else if (generic && asksTimes) {
      const word = generic[1].toLowerCase().replace('-', '');
      const saidNew = /\bnew\b/i.test(latest);
      const named = config.services.filter((x) => new RegExp(`\\b${word}`, 'i').test(String(x.label).replace('-', '')));
      if (named.length > 1) service = 'other'; // "a consultation" fits several services: ask which one
      else {
        const pick = named.find((x) => saidNew || !/\bnew\b/i.test(x.label)); // never assume a new patient
        service = pick?.id || config.services.find((x) => x.price && (saidNew || !/\bnew\b/i.test(x.label)))?.id || 'other';
      }
    }
  }
  const level = flags.emergency ? 'emergency' : urgency.urgentRe?.test(customerText) ? 'urgent' : 'routine';

  // Booked leads: only acknowledge; changes go to a person.
  if (lead.status === 'booked' || ctx.store.bookingForLead(lead.id)) {
    if (flags.handoff) {
      const change = CHANGE_REQUEST.test(latest);
      await reply(change ? 'I cannot change a booked appointment myself, so I have flagged this for our team and a person will follow up with you.' : 'I have asked a teammate to follow up with you directly.');
      await escalate(change ? 'Customer wants to change or cancel an existing booking.' : 'Customer asked for a person after booking.');
    } else {
      await reply('You are all set. Reply here if anything changes and a teammate will help.');
    }
    return;
  }

  if (flags.insuranceNote === 'only') {
    lead.confirmNeeded = lead.confirmNeeded || (flags.factLabel ? 'Customer asked about payment options or pricing terms (not in the business facts); a teammate should confirm.' : 'Customer asked about insurance (not in the business facts); a teammate should confirm which plans are accepted.');
    ctx.step({ kind: 'info', title: 'Flagged for a teammate to confirm (low priority, no phone alert)', detail: lead.confirmNeeded });
    await reply((flags.factLabel ? 'I do not have our payment options or terms in front of me, so a teammate will confirm that with you. ' : 'Insurance questions go to our front desk, so a teammate there will confirm that with you. I cannot say which plans we accept. ') + 'If you would like an appointment in the meantime, tell me a day and I will check the times.');
    return;
  }

  // A second named service ("a haircut and a blowout") is recorded too, so both price ranges can be quoted.
  const also = mentioned.find((id) => id !== service && service !== 'other');
  const q = await fx.call('qualify_lead', { service, urgency: level, location: loc.text, notes: latest.slice(0, 280), ...(also ? { also_service: also } : {}) });
  if (!q.ok) { await escalate('Could not qualify the lead.'); return; }

  if (flags.handoff) {
    const topic = config.profile.alwaysHuman.find((x) => x.id === flags.topic);
    await reply(topic ? (topic.reply || `Questions about ${topic.label} go to a person, so I have passed this to a teammate who will follow up with you directly.`)
      : 'Thanks. This one needs a person, so I have passed it to a teammate who will follow up with you directly.');
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

  // Plain questions about the business are answered from the profile only (hours, weekends, parking, walk-ins, visit length).
  const fa = factAnswers(latest, config, { nowMs: ctx.now(), skipWeekend: service !== 'other' && !!requestedDay(latest, dateOf(localNow(ctx.now(), config.business.tz))) });
  const factText = [...fa.answers, ...(fa.missing.length ? [missingFactText(fa.missing)] : [])].join(' ');
  // A fact we do not have: low priority. The assistant keeps helping; a note for a teammate is added (no phone alert, not a hand-off).
  const flagMissing = async () => {
    if (!fa.missing.length) return;
    lead.confirmNeeded = `Customer asked about ${fa.missing.join(' and ')}, which is not in the business facts; a teammate should confirm.`;
    ctx.step({ kind: 'info', title: 'Flagged for a teammate to confirm (low priority, no phone alert)', detail: lead.confirmNeeded });
  };

  // A plain question about the business that names a service ("how long does a new patient exam take?") is answered on its own:
  // no unasked price and no list of times. The offer follows when the customer says yes.
  const BOOK_INTENT = /\b(book|schedule|appointments?|come in|come by|see someone|availab\w*|openings?|open (?:times?|slots?)|this week|next week|price|cost|how much|need|want|looking for|would like|interested|can i get|can i see)\b|\$/i;
  if (fa.any && service !== 'other' && !flags.handoff && !BOOK_INTENT.test(latest) && !requestedDay(latest, dateOf(localNow(ctx.now(), config.business.tz)))) {
    await reply(`Hi ${first}! ${factText} Would you like me to find a time for your ${lc(q.service_label)}?`);
    await flagMissing();
    if (lead.status !== 'human') await fx.call('schedule_followup', { delay_minutes: 30, text: `Hi ${first}, would you like me to find a time for your ${lc(q.service_label)}? Reply here whenever you are ready.`.slice(0, 400) });
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
    if (!fa.any && service === 'other' && !needLoc && attempts === 0 && isOffTopic(latest, config.profile) && !BOOK_INTENT.test(latest)) {
      // Plainly outside what this business helps with: say so, and say what we do.
      await reply(`Hi ${first}, thanks for reaching out to ${biz}. That one is outside what I can help with here. I can book appointments and answer questions about our hours, parking and visits, so ${ask}`);
      return;
    }
    if (fa.any && service === 'other' && !needLoc) {
      // A question about the business: answer it, then offer to book. Answering does not use up the one-question budget.
      await reply(`Hi ${first}, thanks for reaching out to ${biz}. ${factText} Happy to book a visit too: ${ask}`);
      await flagMissing();
      if (lead.status !== 'human') await fx.call('schedule_followup', { delay_minutes: 30, text: `Hi ${first}, just checking in. Tell me what you would like to book whenever you are ready and I will line up a time. ${SIGN(config).trim()}`.slice(0, 400) });
      return;
    }
    const r = await reply(attempts === 0
      ? `Hi ${first}, thanks for reaching out to ${biz}. Happy to help: ${ask}`
      : `Sorry, ${first === 'there' ? '' : first + ', '}I did not catch that. ${upper1(ask)}`);
    if (r.ok) lead.messages[lead.messages.length - 1].askedInfo = true;
    await fx.call('schedule_followup', { delay_minutes: 30, text: `Hi ${first}, just checking in. Tell me what you would like to book${config.serviceArea ? ' and your ZIP code' : ''} whenever you are ready and I will line up a time. ${SIGN(config).trim()}`.slice(0, 400) });
    return;
  }

  const todayLocal = dateOf(localNow(ctx.now(), config.business.tz));
  const declines = declinesSlots(latest);
  let reqDay = declines ? null : requestedDay(latest, todayLocal);
  const offered = lead.offeredSlots || [];
  const ckTop0 = requestedClock(latest) || bareHourOf(latest);
  // An outright booking request for an exact day and time ("Book me Friday at 8am"): books it when that exact time is open, like "Put me down for ...".
  if (!declines && reqDay && ckTop0 && !ckTop0.minute && EXPLICIT_BOOK.test(latest) && !/\?/.test(latest) && !windowOf(latest)
    && (isAvailabilityRequest(latest, todayLocal, (config.services || []).flatMap((x) => String(x.label || '').toLowerCase().split(/[^a-z]+/).filter(Boolean)))
      || strictPick(latest.replace(/\band\b/gi, ' '), [`${reqDay.date}T${String(ckTop0.hour).padStart(2, '0')}:00`]))) {
    const wanted0 = `${reqDay.date}T${String(ckTop0.hour).padStart(2, '0')}:00`;
    if (listSlots(ctx.store, config, ctx.now(), reqDay.date, 1).find((x) => x.slot_id === wanted0)?.status === 'open') {
      const b0 = await fx.call('book_appointment', { slot_id: wanted0, note: '' });
      if (b0.ok) { await reply(`Booked, ${first}: ${b0.label}${lead.serviceDefaulted ? ` for your ${lc(q.service_label)}` : ''}. ${wording.bookedAfter}${lead.serviceDefaulted ? ' If you wanted a different visit type, just reply and a teammate will adjust.' : ''}`); return; }
    }
  }
  // "Can you do 2 pm instead?": a time that was not offered is never booked silently. If it is open, offer it and wait for a yes.
  let otherTime = false;
  const ckTop = requestedClock(latest) || bareHourOf(latest);
  const dayClock = !!reqDay && !!ckTop && !windowOf(latest) && !strictPick(latest, offered);
  if (!declines && trigger !== 'new_lead' && offered.length && ((!reqDay && asksOtherTime(latest, offered)) || dayClock)) {
    const ck = ckTop;
    const days = [...new Set(offered.map((id) => id.slice(0, 10)))];
    if (!reqDay && days.length > 1) {
      const names = days.map((d) => dateLabel(d, true).split(',')[0]);
      await reply(`Which day did you mean, ${names.slice(0, -1).join(', ')} or ${names.at(-1)}? I will check that time for you.`);
      return;
    }
    const date = reqDay ? reqDay.date : offered[0].slice(0, 10);
    const wanted = `${date}T${String(ck.hour).padStart(2, '0')}:00`;
    const info = listSlots(ctx.store, config, ctx.now(), date, 1).find((x) => x.slot_id === wanted);
    if (!ck.minute && info?.status === 'open') {
      lead.offeredSlots = [wanted];
      await reply(`${dateLabel(date, true).split(',')[0]} at ${fmtClock(`${String(ck.hour).padStart(2, '0')}:00`)} is open. Want me to book it?`);
      return;
    }
    otherTime = true;
    reqDay = reqDay || { date, dow: new Date(`${date}T12:00:00Z`).getUTCDay(), weekday: false };
  }
  // "The one at 10am doesn't work": the same day's other times come first, not the next day's.
  const rejected = declines && trigger !== 'new_lead' && offered.length ? (pickSlot(latest, offered) || (slotCandidates(latest, offered).length === 1 ? offered[slotCandidates(latest, offered)[0]] : null)) : null;
  // The customer named a day (or date) and none of the windows already offered is on it.
  const dayMismatch = !!reqDay && offered.length > 0 && !offered.some((id) => slotOnDay(id, reqDay));
  let bookNote = '';

  // 5. Customer is choosing among offered windows.
  // A day alone ("Thursday?") after an offer is a question about that day, never a pick: it falls through to that day's open times.
  const dayAsk = !!reqDay && !strictPick(latest, offered) && !/\d/.test(latest);
  if (offered.length && lead.messages.filter((m) => m.from === 'agent').length > 0 && trigger !== 'new_lead' && !dayMismatch && !otherTime && !dayAsk) {
    const chosen = strictPick(latest, offered);
    if (chosen) {
      const b = await fx.call('book_appointment', { slot_id: chosen, note: '' });
      if (b.ok) { await reply(`Booked, ${first}: ${b.label}${lead.serviceDefaulted && !lead.confirmNeeded?.includes('no listed price') ? ` for your ${lc(q.service_label)}` : ''}. ${wording.bookedAfter}${lead.serviceDefaulted ? ` If you wanted a different visit type, just reply and a teammate will adjust.` : ''}`); return; }
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
      let ask = offered.length === 1 ? `Would you like me to book ${dateLabel(dateOf(offered[0]))} ${clock(offered[0])}? Reply yes, or tell me another day or time.` : `Which of these works best: ${offered.map((id, i) => `${i + 1}) ${dateLabel(dateOf(id))} ${clock(id)}`).join('  ')}? Reply with the number or the time.`;
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
  const sinceDate = declines && offered.length ? (rejected ? rejected.slice(0, 10) : addDays(dateOf(offered.at(-1)), 1))
    : reqDay ? reqDay.date
      : wantsNextWeek ? nextMonday : undefined;
  const cal = await fx.call('check_calendar', { days: 10, limit: 6, ...(sinceDate ? { earliest_date: sinceDate } : {}) });
  if (rejected && cal.ok) { cal.slots = cal.slots.filter((sl) => sl.slot_id !== rejected); bookNote = 'No problem, here are other times. '; }
  // A specific time on a specific day: say plainly whether it is open. If it is taken, offer the nearest open times that day
  // first (closest to the time asked for), then the next ones after it.
  const win = !declines ? windowOf(latest) : null;
  const clockReq = !declines && reqDay && !win ? requestedClock(latest) : null;
  const part = !declines && reqDay && !clockReq ? (partOfDay(latest) || (win ? 'window' : null)) : null;
  const pastWhen = !declines && !reqDay ? pastDay(latest, todayLocal) : null;
  let timeNote = '';
  let windowOnly = false;
  let noteDone = false; // the note already says what is open, so nothing more needs adding after it
  if (cal.ok && reqDay && (clockReq || part)) {
    const dayName = dateLabel(reqDay.date, true).split(',')[0];
    const dayWord = reqDay.rel || (reqDay.weekday ? dayName : dateLabel(reqDay.date));
    const nowL = localNow(ctx.now(), config.business.tz);
    const dayOpen = listSlots(ctx.store, config, ctx.now(), reqDay.date, 1);
    const openList = dayOpen.filter((x) => x.status === 'open').map((x) => ({ slot_id: x.slot_id, label: x.label }));
    const hourOf = (sl) => Number(sl.slot_id.slice(11, 13));
    let sameDay = openList;
    if (clockReq) {
      const hh = String(clockReq.hour).padStart(2, '0');
      const wanted = `${reqDay.date}T${hh}:00`;
      const clock = fmtClock(`${hh}:${String(clockReq.minute).padStart(2, '0')}`);
      const info = dayOpen.find((x) => x.slot_id === wanted);
      const at = `${reqDay.rel ? reqDay.rel : dayWord} at ${clock}`;
      if (clockReq.minute) timeNote = `We start ${wording.appointment}s on the hour, so ${clock} is not a start time. `;
      else if (info && info.status === 'open') { timeNote = `${upper1(at)} is open. `; noteDone = true; }
      else if (info && (info.status === 'booked' || info.status === 'busy')) timeNote = `${upper1(at)} is already taken. `;
      else if (info && info.status === 'past') timeNote = wanted <= nowL ? `${upper1(at)} has already passed. ` : `${upper1(at)} is too soon to book. `;
      else if (info && info.status === 'unchecked') timeNote = `I cannot check ${at} right now. `;
      else if (slotsForDate(reqDay.date, config.hours).length) timeNote = `We do not start ${wording.appointment}s at ${clock} on ${dayWord}. `;
      const target = clockReq.hour + clockReq.minute / 60;
      const dist = (sl) => Math.abs(hourOf(sl) - target);
      // The three open times nearest the asked one (the asked time itself when it is open), always shown in time order.
      sameDay = [...openList].sort((x, y) => dist(x) - dist(y) || y.slot_id.localeCompare(x.slot_id));
      sameDay = [...sameDay.slice(0, 3).sort((x, y) => x.slot_id.localeCompare(y.slot_id)), ...sameDay.slice(3)];
    } else {
      const inPart = (sl) => (part === 'window' ? win.test(hourOf(sl)) : part === 'morning' ? hourOf(sl) < 12 : part === 'afternoon' ? hourOf(sl) >= 12 && hourOf(sl) < 17 : hourOf(sl) >= 17);
      const label = part === 'window' ? (reqDay.rel === 'today' ? `today ${win.label}` : `${dayWord} ${win.label}`) : reqDay.rel === 'today' ? `this ${part}` : `${dayWord} ${part}`;
      const hit = openList.filter(inPart);
      if (hit.length) { timeNote = `Here is what is open ${label}. `; noteDone = true; sameDay = hit; windowOnly = true; }
      else if (slotsForDate(reqDay.date, config.hours).length) timeNote = `Nothing is open ${label}. `;
    }
    const others = cal.slots.filter((sl) => sl.slot_id.slice(0, 10) !== reqDay.date);
    if (windowOnly) cal.slots = sameDay; // only slots inside the window are listed under a window claim
    else if (sameDay.length) cal.slots = [...sameDay, ...others];
  }
  let anyDayNote = '';
  if (cal.ok && !reqDay && !declines && (partOfDay(latest) || win)) {
    const pod = partOfDay(latest);
    const inW = win ? (h) => win.test(h) : pod === 'morning' ? (h) => h < 12 : pod === 'afternoon' ? (h) => h >= 12 && h < 17 : (h) => h >= 17;
    const wanted = win ? win.label : pod === 'morning' ? 'in the morning' : pod === 'afternoon' ? 'in the afternoon' : 'in the evening';
    const wide = openSlots(ctx.store, config, ctx.now(), sinceDate, 21, 200).map((x) => ({ slot_id: x.slot_id, label: x.label }));
    const hit = wide.filter((x) => inW(Number(x.slot_id.slice(11, 13))));
    if (hit.length) { cal.slots = hit; anyDayNote = `Here is what is open ${wanted}. `; }
    else anyDayNote = `Nothing is open ${wanted} in the next few weeks; these are the nearest times. `;
  }
  if (cal.ok) { cal.slots = cal.slots.slice(0, 3); lead.offeredSlots = cal.slots.map((sl) => sl.slot_id); }
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
  if (unpriced) { price = 'I do not have a price for that, so a teammate will confirm the cost.'; lead.confirmNeeded = lead.confirmNeeded || 'Customer asked about a treatment with no listed price; a teammate should confirm the visit type and cost.'; }
  const closedNow = !isOpenNow(localNow(ctx.now(), config.business.tz), config.hours);
  const intro = wantsOutsideHours(customerText)
    ? `We only schedule ${wording.appointment}s during business hours: ${config.hours.text}. I cannot book that time, but here is what is open. `
    : closedNow && !reqDay ? `We are closed right now (${config.hours.text}), but I can already hold a time. ` : '';
  let dayNote = '';
  if (reqDay) {
    const dayName = reqDay.rel || dateLabel(reqDay.date, true).split(',')[0];
    const on = reqDay.rel ? '' : 'on ';
    const onThatDay = cal.slots.some((sl) => sl.slot_id.slice(0, 10) === reqDay.date);
    dayNote = timeNote ? (onThatDay ? `${timeNote}${noteDone ? '' : `Here is what is open ${on}${dayName} instead. `}` : `${timeNote}Nothing else is open ${on}${dayName}, so here are the nearest times on other days. `) : onThatDay ? `Here is what is open ${on}${dayName}. ` : `I do not have an opening ${on}${reqDay.rel || (reqDay.weekday ? dayName : dateLabel(reqDay.date))}. We are open ${config.hours.text}, so here are the nearest times. `;
    const hol = holidayName(reqDay.date);
    if (hol) {
      dayNote = `${reqDay.rel ? upper1(reqDay.rel) : dateLabel(reqDay.date)} is ${hol}, and I do not know our holiday hours, so a teammate will confirm holiday hours. These times follow our regular schedule and are not confirmed. `;
      lead.confirmNeeded = lead.confirmNeeded || `Customer asked about ${hol} (${reqDay.date}); a teammate should confirm holiday hours.`;
    }
  } else if (anyDayNote) dayNote = anyDayNote;
  else if (pastWhen) dayNote = `${dateLabel(pastWhen)} has already passed, so here are the next open times. `;
  else if (wantsNextWeek && cal.slots.every((sl) => sl.slot_id.slice(0, 10) >= nextMonday)) dayNote = 'Here is what is open next week. ';
  const inLoc = loc.needed && loc.text ? ` in ${loc.text}` : '';
  const body = unpriced ? `I can find you a time. ${price}` : q.price_range ? `${price.replace(/ usually runs/, inLoc + ' usually runs')}` : `Happy to help with your ${lc(q.service_label)}${inLoc}. ${price}`;
  let insNote = '';
  if (flags.insuranceNote) {
    insNote = flags.factLabel ? 'On payment options, I cannot confirm those here, so a teammate will confirm that with you. ' : 'On insurance, I cannot confirm what we accept, so a teammate at the front desk will confirm that with you. ';
    lead.confirmNeeded = lead.confirmNeeded || (flags.factLabel ? 'Customer asked about payment options or pricing terms (not in the business facts); a teammate should confirm.' : 'Customer asked about insurance (not in the business facts); a teammate should confirm which plans are accepted.');
    ctx.step({ kind: 'info', title: 'Flagged for a teammate to confirm (low priority, no phone alert)', detail: lead.confirmNeeded });
  }
  let text = `Hi ${first}! ${fa.any ? factText + ' ' : ''}${insNote}${bookNote}${dayNote}${intro}${body} Open times: ${times}. Which one works?`;
  // Never send the identical offer twice in a row.
  const lastAgent = [...lead.messages].reverse().find((m) => m.from === 'agent');
  if (lastAgent && lastAgent.text === text + SIGN(config)) {
    await reply('I want to make sure you get a time that works, so I have asked a teammate to follow up with you directly.');
    await escalate('The agent had nothing new to offer; a person should find a time with the customer.');
    return;
  }
  await reply(text);
  await flagMissing();
  if (lead.status === 'human') return;
  await fx.call('schedule_followup', { delay_minutes: 30, text: `Hi ${first}, still want me to hold one of those times for your ${q.service_label.toLowerCase()}? Reply with the day or option number.` });
  void slotLabel;
}

// Monday of the week that contains the given date (weeks run Monday to Sunday).
function mondayStart(date) {
  const [y, m, d] = date.split('-').map(Number);
  const w = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return addDays(date, w === 0 ? -6 : 1 - w);
}
