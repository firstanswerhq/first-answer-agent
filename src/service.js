// Lead lifecycle operations shared by the API, the seed script and the tests.
import { cleanText, rid, token, maskPhone } from './util.js';

export const SOURCES = ['Website form', 'Google Ads', 'Facebook', 'Referral', 'Text message', 'Phone call', 'Other'];

export class InputError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

export function validateLeadInput(body, limits) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new InputError('Send a JSON object.');
  const name = cleanText(body.name, limits.name + 1);
  const message = cleanText(body.message, limits.message + 1);
  const phone = cleanText(body.phone, limits.phone + 1);
  if (typeof body.name !== 'string' || !name) throw new InputError('Name is required.');
  if (name.length > limits.name) throw new InputError(`Name is too long (max ${limits.name}).`);
  if (typeof body.message !== 'string' || !message) throw new InputError('Message is required.');
  if (message.length > limits.message) throw new InputError(`Message is too long (max ${limits.message}).`);
  if (typeof body.phone !== 'string' || phone.length > limits.phone || !/^[+(\d][\d\s().+-]{6,}$/.test(phone) || phone.replace(/\D/g, '').length < 10) {
    throw new InputError('Enter a valid phone number (at least 10 digits).');
  }
  let source = cleanText(body.source ?? 'Website form', 40);
  if (!SOURCES.includes(source)) source = 'Other';
  return { name, phone, message, source };
}

export class LeadService {
  constructor({ store, agent, config, now = Date.now }) {
    Object.assign(this, { store, agent, config, now });
  }

  createLead(input, { simulated = false, seed = false, run = true, ipKey = null } = {}) {
    const ts = this.now();
    const lead = {
      id: 'L-' + rid('x').slice(2), name: input.name, phone: input.phone, source: input.source, createdAt: ts,
      status: 'new', priority: 'normal', simulated, seed, token: token(), ipHash: ipKey || undefined,
      messages: [{ id: rid('M'), ts, from: 'customer', text: input.message }],
      timeline: [], qualification: null, offeredSlots: [], awaitingCustomer: false,
    };
    this.store.addLead(lead, this.config.limits.maxLeads);
    const done = run ? this.agent.enqueue(lead.id, 'new_lead', { ipKey }) : Promise.resolve();
    return { lead, done };
  }

  addCustomerMessage(leadId, text, { ipKey = null } = {}) {
    const lead = this.store.getLead(leadId);
    if (!lead) throw new InputError('Lead not found.', 404);
    const clean = cleanText(text, this.config.limits.message + 1);
    if (typeof text !== 'string' || !clean) throw new InputError('Message is required.');
    if (clean.length > this.config.limits.message) throw new InputError(`Message is too long (max ${this.config.limits.message}).`);
    if (lead.messages.length >= this.config.limits.maxMessagesPerLead) throw new InputError('This conversation has reached its message limit.', 429);
    const ts = this.now();
    lead.messages.push({ id: rid('M'), ts, from: 'customer', text: clean });
    lead.lastCustomerAt = ts;
    lead.awaitingCustomer = false;
    for (const f of this.store.followups) {
      if (f.leadId === lead.id && f.status === 'pending') { f.status = 'cancelled'; f.reason = 'customer replied'; f.endedAt = ts; }
    }
    this.store.save();
    return { lead, done: this.agent.enqueue(lead.id, 'customer_reply', { ipKey: ipKey || lead.ipHash || null }) };
  }
}

export function summary(lead, store) {
  const q = lead.qualification;
  const fu = store.followups.find((f) => f.leadId === lead.id && f.status === 'pending');
  return {
    id: lead.id, name: lead.name, phone: lead.seed ? lead.phone : maskPhone(lead.phone), source: lead.source, status: lead.status, priority: lead.priority,
    createdAt: lead.createdAt, replyTimeSec: lead.replyTimeSec ?? null, serviceLabel: q?.serviceLabel || null,
    location: q?.location || '', lastRunMode: lead.lastRunMode || null, simulated: !!lead.simulated, seed: !!lead.seed,
    snippet: lead.messages[0]?.text.slice(0, 110) || '', humanReason: lead.humanReason || null,
    followupPending: !!fu, booked: !!store.bookingForLead(lead.id),
  };
}

export function detail(lead, store) {
  const booking = store.bookingForLead(lead.id);
  const fus = store.followups.filter((f) => f.leadId === lead.id);
  const { token: _t, ipHash: _ip, ...rest } = lead; // the secret token and IP hash are never sent to the dashboard
  // Fictional sample leads are open for role-play, so their token goes to the dashboard. Every other lead's token stays private.
  return { ...rest, phone: lead.seed ? lead.phone : maskPhone(lead.phone), demoToken: lead.seed ? lead.token : undefined, booking, followups: fus.slice(-4) };
}
