// Offline rules engine. It follows the SAME path as the model: qualify, check the
// calendar, reply, book, schedule a follow-up, escalate. It calls the very same
// guarded functions. Deterministic, no network.
import { detectJob, detectSize, detectLocation, wantsOutsideHours, pickSlot, declinesSlots } from './extract.js';
import { firstName, money } from './util.js';
import { slotLabel, addDays, dateOf, localNow, isOpenNow } from './calendar.js';

const SIGN = (b) => ` - ${b} scheduling assistant (AI)`;

export async function runRules(ctx, fx, trigger) {
  const { lead, config, flags } = ctx;
  const biz = config.business.name;
  const first = firstName(lead.name);
  const customerText = lead.messages.filter((m) => m.from === 'customer').map((m) => m.text).join('\n');
  const latest = [...lead.messages].reverse().find((m) => m.from === 'customer')?.text || '';
  const reply = (text) => fx.call('send_reply', { text: text + SIGN(biz) });
  const escalate = (reason, priority = 'normal') => fx.call('escalate_to_human', { reason, priority });

  // 1. Hard stops that need a person.
  if (lead.status === 'human') return;
  if (flags.injection) {
    await reply('I can only help with scheduling home-service jobs, so I have passed your message to a teammate who will follow up.');
    await escalate('Message contained instructions aimed at the agent (possible prompt injection); held for human review.');
    return;
  }
  if (flags.complaint) {
    await reply(`${first}, I am sorry about this experience. I am not the right one to fix it, so I have asked the owner to call you personally.`);
    await escalate('Complaint or angry customer; the owner should call personally.');
    return;
  }

  // 2. Qualify from everything the customer has said.
  let job = detectJob(customerText);
  if (lead.qualification?.jobType && lead.qualification.jobType !== 'other' && job === 'other') job = lead.qualification.jobType;
  const size = detectSize(customerText, job);
  let loc = detectLocation(customerText);
  if (!loc.known && lead.qualification?.location) loc = { text: lead.qualification.location, known: true, inArea: lead.qualification.serviceAreaOk };
  const urgency = flags.emergency ? 'emergency' : /\b(asap|urgent|today|soon|tonight)\b/i.test(customerText) ? 'urgent' : 'routine';

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

  const q = await fx.call('qualify_lead', { job_type: job, urgency, size, location: loc.text, notes: latest.slice(0, 280) });
  if (!q.ok) { await escalate('Could not qualify the lead.'); return; }

  if (flags.handoff) {
    await reply('Thanks for the details. This one needs a person, so I have passed it to a teammate who will call you.');
    await escalate('Customer request needs a person (insurance, contract, schedule change or asked for a human).');
    return;
  }
  if (flags.outOfScope && job === 'other') {
    await reply('That is outside the work I can schedule here (roofing, gutters, cleaning and plumbing), so I have passed it to a teammate.');
    await escalate('Request is outside the services the agent schedules.');
    return;
  }
  if (q.service_area_ok === false) {
    await reply(`Thanks, ${first}. ${loc.text} may be outside our service area (Nashville and nearby), so I have asked a teammate to confirm and get back to you.`);
    await escalate(`Location (${loc.text}) appears to be outside the service area.`);
    return;
  }

  // 3. Emergency: priority path. Hold the earliest window and bring in a person at once.
  if (urgency === 'emergency') {
    if (q.service_area_ok !== true) {
      await reply(`${first}, if anyone is in danger (electrical, gas or structural) call 911 first. I have flagged this as a priority and a dispatcher will call you shortly.`);
      await escalate('Emergency; service area unconfirmed. Call the customer now.', 'urgent');
      return;
    }
    const cal = await fx.call('check_calendar', { days: 7, limit: 2 });
    let held = null;
    if (cal.ok && cal.slots.length && (config.limits.emergencyHolds || lead.seed)) {
      const b = await fx.call('book_job', { slot_id: cal.slots[0].slot_id, note: 'Emergency hold: confirm by phone' });
      if (b.ok) held = b.label;
    }
    await reply(`${first}, I am sorry, active water is urgent. If anyone is in danger (electrical, gas or structural) call 911 first. I have flagged this as a priority${held ? ` and held the earliest visit: ${held}` : ''}. A dispatcher will call you at this number shortly.`);
    await escalate('Emergency (active leak/flooding or safety risk): priority dispatch, call the customer now.', 'urgent');
    return;
  }

  // 4. Not enough information yet: ask one clear question.
  if (job === 'other' || !loc.known || q.service_area_ok === null) {
    const needJob = job === 'other';
    const attempts = lead.messages.filter((m) => m.from === 'agent' && m.askedInfo).length;
    if (attempts >= 2) {
      await reply('I want to make sure you get the right help, so I have asked a teammate to follow up with you directly.');
      await escalate('Agent could not get a clear job type and location after two questions.');
      return;
    }
    const ask = needJob && !loc.known
      ? 'what kind of job is it (roof, gutters, cleaning or plumbing) and what ZIP code or neighborhood are you in?'
      : needJob ? 'what kind of job is it (roof, gutters, cleaning or plumbing)?' : 'what ZIP code or neighborhood is the job in, so I can confirm we cover it?';
    const r = await reply(`Hi ${first}, thanks for reaching out to ${biz}. Happy to help: ${ask}`);
    if (r.ok) lead.messages[lead.messages.length - 1].askedInfo = true;
    await fx.call('schedule_followup', { delay_minutes: 30, text: `Hi ${first}, just checking in. Send me the job type and ZIP code whenever you are ready and I will line up a time. ${SIGN(biz).trim()}`.slice(0, 400) });
    return;
  }

  // 5. Customer is choosing among offered windows.
  if (lead.offeredSlots?.length && lead.messages.filter((m) => m.from === 'agent').length > 0 && trigger !== 'new_lead') {
    const chosen = pickSlot(latest, lead.offeredSlots);
    if (chosen) {
      const b = await fx.call('book_job', { slot_id: chosen, address: '', note: '' });
      if (b.ok) { await reply(`Booked, ${first}: ${b.label}. The crew will arrive during that window. Reply here if anything changes.`); return; }
      // Slot vanished: fall through and re-offer.
    } else if (!declinesSlots(latest)) {
      const tries = lead.messages.filter((m) => m.from === 'agent' && m.clarified).length;
      if (tries >= 1) {
        await reply('I want to get this right, so I have asked a teammate to confirm a time with you directly.');
        await escalate('Customer reply did not match any offered time twice.');
        return;
      }
      await reply('Which of those times works best? Reply with the day or the number of the option.');
      lead.messages[lead.messages.length - 1].clarified = true;
      return;
    }
  }

  // 6. Offer real windows with a price-book range.
  const sinceDate = declinesSlots(latest) && lead.offeredSlots?.length ? addDays(dateOf(lead.offeredSlots.at(-1)), 1) : undefined;
  const cal = await fx.call('check_calendar', { days: 10, limit: 3, ...(sinceDate ? { earliest_date: sinceDate } : {}) });
  if (!cal.ok || !cal.slots.length) {
    await reply('I could not find an open window right now, so I have asked a teammate to find a time for you.');
    await escalate('No open calendar windows available.');
    return;
  }
  const times = cal.slots.map((s, i) => `${i + 1}) ${s.label}`).join('  ');
  const price = q.price_range
    ? `Typical range for this is ${money(q.price_range.low)}-${money(q.price_range.high)}, confirmed on site.`
    : 'We give a free on-site estimate for this one.';
  const afterHours = wantsOutsideHours(customerText)
    ? `We only schedule visits during business hours (${config.hours.text}), so I cannot book that time. `
    : !isOpenNow(localNow(ctx.now(), config.business.tz), config.hours) ? 'Our office is closed right now, but I can already hold a time. ' : '';
  await reply(`Hi ${first}! ${afterHours}${q.job_label} in ${loc.text}: ${price} Open windows: ${times}. Which one works?`);
  await fx.call('schedule_followup', { delay_minutes: 30, text: `Hi ${first}, still want me to hold one of those times for your ${q.job_label.toLowerCase()}? Reply with the day or option number.` });
  void slotLabel;
}
