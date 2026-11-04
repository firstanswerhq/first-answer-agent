// The six functions the agent can call. Every call goes through the same path whether it
// comes from the model or from the offline rules engine: validate arguments, enforce
// guardrails in code, write state, and record a timeline step.
import { findZip } from './extract.js';
import { cleanText, money, rid, round2 } from './util.js';
import { openSlots, localNow, isRealSlot, isBookableNow, slotLabel, isOpenNow, isValidDate, dateOf, DATE_RE } from './calendar.js';

const URGENCIES = ['emergency', 'urgent', 'routine'];
const serviceIds = (config) => [...config.services.map((x) => x.id), 'other'];
export const serviceLabel = (config, id) => config.services.find((x) => x.id === id)?.label || 'Unclassified request';

// ---- tiny schema validator (strict types, unknown keys dropped) ----
export class ValidationError extends Error {}

function check(name, spec, v) {
  if (v === undefined || v === null) {
    if (spec.required) throw new ValidationError(`${name} is required`);
    return spec.default;
  }
  switch (spec.type) {
    case 'string': {
      if (typeof v !== 'string') throw new ValidationError(`${name} must be a string`);
      const s = cleanText(v, (spec.max || 500) + 1);
      if (s.length > (spec.max || 500)) throw new ValidationError(`${name} is too long (max ${spec.max || 500})`);
      if (s.length < (spec.min ?? 0)) throw new ValidationError(`${name} is too short (min ${spec.min})`);
      if (spec.pattern && !spec.pattern.test(s)) throw new ValidationError(`${name} has the wrong format`);
      return s;
    }
    case 'enum':
      if (!spec.values.includes(v)) throw new ValidationError(`${name} must be one of: ${spec.values.join(', ')}`);
      return v;
    case 'integer':
      if (!Number.isInteger(v)) throw new ValidationError(`${name} must be an integer`);
      if (v < spec.min || v > spec.max) throw new ValidationError(`${name} must be between ${spec.min} and ${spec.max}`);
      return v;
    default:
      throw new ValidationError(`unsupported type for ${name}`);
  }
}

export function validateArgs(schema, raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new ValidationError('arguments must be a JSON object');
  const out = {};
  for (const [k, spec] of Object.entries(schema)) out[k] = check(k, spec, raw[k]);
  return out;
}

// Argument schemas and the tool definitions sent to the model are built from the business profile (its list of
// services), so the same code serves any kind of business. The code-side validator is the real gate.
const schemaCache = new WeakMap();
export function schemasFor(config) {
  if (schemaCache.has(config)) return schemaCache.get(config);
  const schemas = {
    qualify_lead: {
      service: { type: 'enum', values: serviceIds(config), required: true },
      urgency: { type: 'enum', values: URGENCIES, required: true },
      location: { type: 'string', max: 80, default: '' },
      notes: { type: 'string', max: 300, default: '' },
      also_service: { type: 'enum', values: serviceIds(config) },
    },
    check_calendar: {
      earliest_date: { type: 'string', max: 10, pattern: DATE_RE },
      days: { type: 'integer', min: 1, max: 14, default: 7 },
      limit: { type: 'integer', min: 1, max: 6, default: 4 },
    },
    book_appointment: {
      slot_id: { type: 'string', max: 16, required: true },
      note: { type: 'string', max: 200, default: '' },
    },
    send_reply: { text: { type: 'string', min: 1, max: 600, required: true } },
    schedule_followup: {
      delay_minutes: { type: 'integer', min: 5, max: 1440, required: true },
      text: { type: 'string', min: 1, max: 400, required: true },
    },
    escalate_to_human: {
      reason: { type: 'string', min: 5, max: 300, required: true },
      priority: { type: 'enum', values: ['normal', 'urgent'], default: 'normal' },
    },
  };
  schemaCache.set(config, schemas);
  return schemas;
}

export function toolDefs(config) {
  const area = config.serviceArea;
  return [
    {
      name: 'qualify_lead',
      description: `Record what the customer wants. Always call this first. Returns ${area ? 'whether the location is in the service area and ' : ''}the ONLY price range you may quote (null means no quote: say the cost is confirmed in person).`,
      parameters: {
        type: 'object',
        properties: {
          service: { type: 'string', enum: serviceIds(config), description: 'Which offering the customer wants; "other" if none fits' },
          urgency: { type: 'string', enum: URGENCIES, description: `emergency = ${config.profile.urgency.label.toLowerCase()} situations that need a person now` },
          ...(area ? { location: { type: 'string', description: `City, neighborhood or ZIP the customer gave (${area.label})` } } : {}),
          notes: { type: 'string' },
          also_service: { type: 'string', enum: serviceIds(config), description: 'Optional: a second offering the customer also asked about (for example a haircut and a blowout); its price range is returned too' },
        },
        required: ['service', 'urgency'],
      },
    },
    {
      name: 'check_calendar',
      description: 'List open appointment times from the demo calendar. Never offer a time that this function did not return.',
      parameters: {
        type: 'object',
        properties: {
          earliest_date: { type: 'string', description: 'YYYY-MM-DD, optional' },
          days: { type: 'integer', description: '1-14, default 7' },
          limit: { type: 'integer', description: '1-6, default 4' },
        },
      },
    },
    {
      name: 'book_appointment',
      description: 'Book a slot returned by check_calendar for this lead. Refuses double bookings, out-of-hours slots and leads that must go to a person.',
      parameters: { type: 'object', properties: { slot_id: { type: 'string' }, note: { type: 'string' } }, required: ['slot_id'] },
    },
    {
      name: 'send_reply',
      description: 'Send a text message to the customer (simulated in the demo). Max 600 characters. No dollar amounts except the range from qualify_lead. No discounts, refunds, guarantees or links.',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    },
    {
      name: 'schedule_followup',
      description: 'If the customer goes quiet, post this follow-up message after delay_minutes. Cancelled automatically if they reply.',
      parameters: {
        type: 'object',
        properties: { delay_minutes: { type: 'integer', description: '5-1440' }, text: { type: 'string' } },
        required: ['delay_minutes', 'text'],
      },
    },
    {
      name: 'escalate_to_human',
      description: 'Flag the lead "Needs a Human" with a reason. Use for complaints, urgent situations, anything unclear, out of scope, or outside the price book.',
      parameters: {
        type: 'object',
        properties: { reason: { type: 'string' }, priority: { type: 'string', enum: ['normal', 'urgent'] } },
        required: ['reason'],
      },
    },
  ];
}

// ---- outbound message guard (price book, promises, links, leaks) ----
const BANNED = /\b(discount|refund|guarantee[sd]?|price[- ]match|warranty|coupon|waive[sd]?|promo(tion)? code|\d+\s?% off|free of charge|no charge|on the house)\b/i;
const LEAK = /system prompt|my instructions|developer message|api[- ]?key|VULTR_|as an ai language model/i;

export function checkOutbound(text, lead) {
  if (BANNED.test(text)) return 'Message makes a promise the agent may not make (discount, refund, guarantee, warranty or free work). Rephrase, or escalate_to_human.';
  if (/https?:\/\/|www\./i.test(text)) return 'Messages may not contain links.';
  if (LEAK.test(text)) return 'Message appears to reveal internal instructions.';
  const amounts = [...text.matchAll(/\$\s?([\d,]+(?:\.\d{1,2})?)|\b([\d,]+(?:\.\d{1,2})?)\s?(?:dollars|bucks)\b/gi)]
    .map((m) => Number((m[1] || m[2]).replace(/,/g, '')));
  if (amounts.length) {
    const ranges = [lead.qualification?.priceRange, lead.qualification?.alsoPriceRange].filter(Boolean);
    if (!ranges.length) return 'No price may be quoted for this service. Say the cost is confirmed in person, or escalate_to_human.';
    const bad = amounts.find((a) => !ranges.some((pr) => a >= pr.low && a <= pr.high));
    if (bad !== undefined) return `Price ${money(bad)} is outside the price book range${ranges.length > 1 ? 's' : ''} ${ranges.map((pr) => `${money(pr.low)}-${money(pr.high)}`).join(' and ')}. Quote only ${ranges.length > 1 ? 'those ranges' : 'that range'} or escalate_to_human.`;
  }
  return null;
}

export function priceRangeFor(config, serviceId) {
  const svc = config.services.find((x) => x.id === serviceId);
  return svc?.price ? { ...svc.price } : null;
}

export function locationCheck(config, location) {
  const area = config.serviceArea;
  if (!area) return { ok: true, match: '' }; // customers come to the business: no area check
  const loc = (location || '').trim();
  if (!loc) return { ok: null, match: '' };
  const lower = loc.toLowerCase();
  const zip = findZip(loc);
  const city = area.cities.find((c) => lower.includes(c.toLowerCase()));
  if (zip) {
    if (area.zips.includes(zip)) return { ok: true, match: zip };
    return { ok: city ? null : false, match: zip }; // unlisted ZIP beside a served city: unknown, so ask
  }
  if (city) return { ok: true, match: city };
  const out = area.outside.find((c) => lower.includes(c.toLowerCase()));
  if (out) return { ok: false, match: out };
  return { ok: null, match: '' }; // unknown place: ask or hand off, never assume
}

// ---- executor ----
export class Functions {
  /**
   * @param ctx { store, config, now(), lead, flags, step(stepObj), run }
   */
  constructor(ctx) {
    this.ctx = ctx;
    this.counts = {};
  }

  get lead() { return this.ctx.lead; }

  async call(name, rawArgs, source = 'agent') {
    const { store, config } = this.ctx;
    const schema = schemasFor(config)[name];
    const t0 = this.ctx.now();
    let args;
    let result;
    if (!schema) {
      result = { ok: false, error: `Unknown function "${String(name).slice(0, 40)}"` };
      this.record(name, rawArgs, result, t0, source);
      return result;
    }
    this.counts[name] = (this.counts[name] || 0) + 1;
    try {
      if (this.counts[name] > (name === 'send_reply' ? 3 : 4)) throw new ValidationError('Call limit for this function reached in this run');
      args = validateArgs(schema, rawArgs);
      result = await this[name](args);
    } catch (err) {
      result = { ok: false, error: err instanceof ValidationError ? err.message : 'Function failed' };
      if (!(err instanceof ValidationError)) result.error = `Function failed: ${String(err.message).slice(0, 120)}`;
    }
    store.save();
    void config;
    this.record(name, args ?? rawArgs, result, t0, source);
    return result;
  }

  record(name, args, result, t0, source) {
    this.ctx.step({
      kind: 'function', fn: name, args: safeJson(args), result: safeJson(result), ok: !!result.ok,
      title: describeCall(name, args, result, this.ctx.config), source, ms: this.ctx.now() - t0,
    });
  }

  // 1. qualify_lead
  async qualify_lead(a) {
    const { config, lead, flags } = this.ctx;
    let urgency = a.urgency;
    if (flags?.emergency) urgency = 'emergency'; // code overrides a downgraded urgency
    const loc = locationCheck(config, a.location);
    const inScope = a.service !== 'other';
    const priceRange = priceRangeFor(config, a.service);
    const label = serviceLabel(config, a.service);
    const also = a.also_service && a.also_service !== 'other' && a.also_service !== a.service ? a.also_service : null;
    lead.qualification = {
      service: a.service, serviceLabel: label, urgency,
      location: a.location, serviceAreaOk: loc.ok, areaMatch: loc.match, inScope, priceRange,
      ...(also ? { alsoService: also, alsoLabel: serviceLabel(config, also), alsoPriceRange: priceRangeFor(config, also) } : {}),
      notes: a.notes, updatedAt: this.ctx.now(),
    };
    if (urgency === 'emergency') lead.priority = 'urgent';
    return {
      ok: true, service: a.service, service_label: label, urgency,
      in_scope: inScope,
      service_area_ok: loc.ok, // true | false | null (null = location unknown, ask or escalate); always true when the business has no service area
      price_range: priceRange, // the ONLY range you may quote; null = no quote, say the cost is confirmed in person
      ...(also ? { also_service_label: serviceLabel(config, also), also_price_range: priceRangeFor(config, also) } : {}),
      office_open_now: isOpenNow(localNow(this.ctx.now(), config.business.tz), config.hours),
    };
  }

  // 2. check_calendar
  async check_calendar(a) {
    const { store, config, lead } = this.ctx;
    const from = a.earliest_date && isValidDate(a.earliest_date) ? a.earliest_date : undefined;
    const slots = openSlots(store, config, this.ctx.now(), from, a.days, a.limit);
    lead.offeredSlots = slots.map((s) => s.slot_id);
    return {
      ok: true, timezone: config.business.tz, business_hours: config.hours.text,
      slots: slots.map((s) => ({ slot_id: s.slot_id, label: s.label })),
      note: slots.length ? undefined : 'No open slots in that range; try a later earliest_date or escalate_to_human.',
    };
  }

  // 3. book_appointment
  async book_appointment(a) {
    const { store, config, lead, flags } = this.ctx;
    if (store.bookingForLead(lead.id)) return { ok: false, error: 'This lead already has a booking. Changes must be handled by a human (escalate_to_human).' };
    if (lead.status === 'human' && !(flags?.emergency)) return { ok: false, error: 'Lead is flagged for a human; the agent may not book.' };
    const q = lead.qualification;
    if (!q) return { ok: false, error: 'Call qualify_lead before book_appointment.' };
    if (!q.inScope) return { ok: false, error: 'This request is not something the business schedules; escalate_to_human.' };
    if (q.serviceAreaOk !== true) return { ok: false, error: q.serviceAreaOk === false ? 'Location is outside the service area; escalate_to_human.' : 'Service area is unconfirmed; ask the customer for a ZIP or neighborhood.' };
    if (!isRealSlot(a.slot_id, config.hours)) return { ok: false, error: 'That is not a valid appointment time. Business hours: ' + config.hours.text + '. Use a slot_id from check_calendar.' };
    const nowL = localNow(this.ctx.now(), config.business.tz);
    if (!isBookableNow(a.slot_id, nowL, config)) return { ok: false, error: `That time is in the past or too soon (${config.minLeadMinutes / 60} hours notice required).` };
    if (store.bookingForSlot(a.slot_id)) return { ok: false, error: 'That slot was just taken. Call check_calendar again.' };
    if (flags?.emergency && !config.limits.emergencyHolds) return { ok: false, error: 'Emergency leads are flagged for a person instead of holding a calendar slot. Call escalate_to_human with priority urgent.', code: 'emergency_hold_off' };
    // Public-demo protection: bookings made by visitors are capped overall and per visitor, and expire (see releaseExpired).
    // Sample leads follow the same rules when a visitor role-plays on them. The cap reasons carry a code so the caller can
    // tell the customer the truth and bring in a person, instead of offering the same times again.
    const visitor = this.ctx.ipKey || lead.ipHash || null;
    if (store.liveBookings().length >= config.limits.maxLiveBookings) return { ok: false, code: 'demo_calendar_full', error: 'The demo calendar is at its limit for visitor bookings right now. Tell the customer a teammate will confirm a time, and escalate_to_human.' };
    if (visitor && store.liveBookings().filter((b) => b.ipKey === visitor).length >= config.limits.maxBookingsPerVisitor) return { ok: false, code: 'visitor_cap', error: 'This visitor already holds the maximum number of demo bookings. Tell the customer a teammate will confirm any further visit, and escalate_to_human.' };
    // Synchronous check-and-write: atomic with respect to other runs in this process.
    const booking = {
      id: rid('B'), slot_id: a.slot_id, leadId: lead.id, name: lead.name, service: q.service, serviceLabel: q.serviceLabel,
      note: a.note, kind: flags?.emergency ? 'emergency_hold' : 'standard', status: 'confirmed',
      ipKey: visitor || undefined, createdAt: this.ctx.now(),
    };
    store.bookings.push(booking);
    lead.bookingId = booking.id;
    if (lead.status !== 'human') lead.status = 'booked';
    this.cancelFollowups('booked');
    return { ok: true, booking_id: booking.id, slot_id: a.slot_id, label: slotLabel(a.slot_id, config.hours.windowHours), kind: booking.kind };
  }

  // 4. send_reply
  async send_reply(a) {
    const { lead, config } = this.ctx;
    const bad = checkOutbound(a.text, lead);
    if (bad) {
      this.ctx.guardRejects = (this.ctx.guardRejects || 0) + 1;
      return { ok: false, error: bad, guardrail: true };
    }
    void config;
    return this.deliver(a.text);
  }

  deliver(text, extra = {}) {
    const { lead, config } = this.ctx;
    // Messages the software writes itself (holding notes, handoff notes) pass the same outbound guard as the model's.
    if (checkOutbound(text, lead)) text = `A teammate will follow up with you shortly. - ${config.business.agentName} (AI)`;
    const ts = this.ctx.now();
    const msg = { id: rid('M'), ts, from: 'agent', text, simulated: true, ...extra };
    lead.messages.push(msg);
    lead.awaitingCustomer = true;
    if (!lead.firstReplyAt) {
      lead.firstReplyAt = ts;
      lead.replyTimeSec = round2((ts - lead.createdAt) / 1000);
    }
    if (lead.status === 'new') lead.status = 'replied';
    this.ctx.sentReply = true;
    return { ok: true, message_id: msg.id, simulated: true, note: 'Simulated send; no real SMS or email was sent.' };
  }

  // 5. schedule_followup
  async schedule_followup(a) {
    const { store, config, lead } = this.ctx;
    if (lead.status === 'human') return { ok: false, error: 'Lead is with a human; no automatic follow-up.' };
    if (store.bookingForLead(lead.id)) return { ok: false, error: 'Lead is already booked; no follow-up needed.' };
    const bad = checkOutbound(a.text, lead);
    if (bad) return { ok: false, error: bad, guardrail: true };
    this.cancelFollowups('replaced');
    const createdAt = this.ctx.now();
    const dueAt = createdAt + Math.round((a.delay_minutes * 60000) / config.followupSpeedup);
    const fu = { id: rid('F'), leadId: lead.id, text: a.text, delayMinutes: a.delay_minutes, createdAt, dueAt, status: 'pending' };
    store.followups.push(fu);
    return { ok: true, followup_id: fu.id, fires_in_seconds: Math.round((dueAt - createdAt) / 1000), demo_speedup: config.followupSpeedup };
  }

  cancelFollowups(reason) {
    const { store, lead } = this.ctx;
    for (const f of store.followups) {
      if (f.leadId === lead.id && f.status === 'pending') { f.status = 'cancelled'; f.reason = reason; f.endedAt = this.ctx.now(); }
    }
  }

  // 6. escalate_to_human
  async escalate_to_human(a) {
    const { lead } = this.ctx;
    if (lead.status !== 'human') lead.handoffAckSent = false; // a new handoff gets its own single holding message
    lead.status = 'human';
    lead.humanReason = a.reason;
    if (a.priority === 'urgent') lead.priority = 'urgent';
    lead.awaitingCustomer = false;
    this.cancelFollowups('handed to a human');
    this.ctx.onEscalate?.(a);
    return { ok: true, status: 'Needs a Human', priority: lead.priority };
  }
}

function safeJson(v) {
  try { return JSON.parse(JSON.stringify(v ?? null, (_k, x) => (typeof x === 'string' && x.length > 400 ? x.slice(0, 400) + '…' : x))); } catch { return null; }
}

function describeCall(name, args, result, config) {
  if (!result.ok) return `${name} was refused: ${result.error}`;
  switch (name) {
    case 'qualify_lead': {
      const area = result.service_area_ok === true ? 'in service area' : result.service_area_ok === false ? 'OUTSIDE service area' : 'area unconfirmed';
      return `Qualified the request: ${result.service_label}, ${result.urgency}${config.serviceArea ? ', ' + area : ''}`;
    }
    case 'check_calendar': return `Checked the calendar: ${result.slots.length} open window${result.slots.length === 1 ? '' : 's'} found`;
    case 'book_appointment': return `Booked ${result.label}`;
    case 'send_reply': return 'Sent a reply to the customer (simulated, nothing is really sent)';
    case 'schedule_followup': return `Scheduled a follow-up in ${args.delay_minutes} minutes in case the customer goes quiet`;
    case 'escalate_to_human': return `Flagged as needing a person${result.priority === 'urgent' ? ' (urgent)' : ''}`;
    default: return name;
  }
}
