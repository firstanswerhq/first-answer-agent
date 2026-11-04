// Owner phone alert. When a lead is handed to a person, send one short push notification through ntfy
// (https://ntfy.sh). This is the one real outside action the app takes. It never blocks a customer reply:
// the caller does not wait for it, the request has a 3 second timeout, and every error is caught and logged as one line.
import { firstName } from './util.js';

export const ALERT_TIMEOUT_MS = 3000;
export const MAX_ALERTS_PER_HOUR = 20;
export const MAX_ALERTS_PER_VISITOR_PER_HOUR = 3;

const ascii = (s) => String(s || '').replace(/[^\x20-\x7e]/g, ' ').replace(/\s+/g, ' ').trim();
const oneLine = (s, n) => ascii(s).slice(0, n);

// The alert goes to a public relay, so it carries only fixed text built in code: the business name, the customer's
// first name, a category from the safety flags and an optional https dashboard link. Never model or customer text.
export const CATEGORIES = ['Possible medical emergency', 'Urgent request (emergency wording)', 'Message looked like an instruction attack', 'Angry customer', 'Customer asked for a person', 'Request outside our services', 'Medication or clinical question', 'Allergy or health question', 'Tax or legal advice question', 'Insurance or billing question', 'Contract or fee question', 'Color correction request', 'Needs a person'];

export class Notifier {
  /**
   * topic: ntfy topic (secret-ish; never exposed). transport: fetch-compatible function, injected in tests.
   * offline: true means never touch the network (tests, FORCE_OFFLINE=1). An explicitly injected transport is still used.
   */
  constructor({ topic = '', dashboardUrl = '', transport = null, offline = false, now = Date.now, baseUrl = 'https://ntfy.sh', log = (m) => console.warn(m) } = {}) {
    this.topic = String(topic || '').trim();
    const url = String(dashboardUrl || '').trim();
    this.dashboardUrl = /^https:\/\/[^\s]+$/i.test(url) ? url : ''; // https only, so a typo cannot put arbitrary text in the push
    this.offline = !!offline;
    this.transport = transport || (offline ? null : (globalThis.fetch ? globalThis.fetch.bind(globalThis) : null));
    this.now = now;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.log = log;
    this.stamps = [];
    this.visitorStamps = new Map();
  }

  get configured() { return !!this.topic; }

  alertsLastHour() {
    const cutoff = this.now() - 3_600_000;
    this.stamps = this.stamps.filter((t) => t > cutoff);
    return this.stamps.length;
  }

  visitorCount(key) {
    const cutoff = this.now() - 3_600_000;
    const s = (this.visitorStamps.get(key) || []).filter((t) => t > cutoff);
    if (s.length) this.visitorStamps.set(key, s); else this.visitorStamps.delete(key);
    return s.length;
  }

  status() { return { configured: this.configured, alertsLastHour: this.alertsLastHour() }; }

  /**
   * Alert the owner about a lead. Resolves to { status } where status is one of:
   * 'sent', 'failed', 'not_configured', 'offline', 'rate_limited', 'duplicate', 'skipped'. Never rejects.
   */
  async alert(lead, { category = 'Needs a person', priority = 'normal', business = '', again = false } = {}) {
    try {
      if (!lead || lead.seed) return { status: 'skipped' };
      // One alert per lead, plus one more if a NEW emergency-level message arrives after a non-urgent alert.
      if (lead.ownerAlertedAt && !(again && priority === 'urgent' && !lead.ownerAlertedUrgent)) return { status: 'duplicate' };
      if (lead.simulated) return { status: 'simulated' }; // demo scenario buttons never buzz the owner's phone
      if (!this.configured) return { status: 'not_configured' };
      if (!this.transport) return { status: 'offline' };
      const vkey = lead.ipHash || 'unknown';
      if (this.alertsLastHour() >= MAX_ALERTS_PER_HOUR || this.visitorCount(vkey) >= MAX_ALERTS_PER_VISITOR_PER_HOUR) return { status: 'rate_limited' };
      this.visitorStamps.set(vkey, [...(this.visitorStamps.get(vkey) || []), this.now()]);
      lead.ownerAlertedAt = this.now(); if (priority === 'urgent') lead.ownerAlertedUrgent = true; // max one alert per lead, reserved before the request starts
      this.stamps.push(this.now());
      const urgent = priority === 'urgent';
      const body = [`${oneLine(business, 60)}: ${firstName(lead.name) === 'there' ? 'A customer' : oneLine(firstName(lead.name), 30)} needs a person.`,
        `Reason: ${CATEGORIES.includes(category) ? category : 'Needs a person'}`, this.dashboardUrl ? this.dashboardUrl : ''].filter(Boolean).join('\n');
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), ALERT_TIMEOUT_MS);
      try {
        const res = await this.transport(`${this.baseUrl}/${encodeURIComponent(this.topic)}`, {
          method: 'POST',
          headers: { Title: oneLine(`${urgent ? 'URGENT: ' : ''}${business} needs a person`, 100), Priority: urgent ? 'urgent' : 'high', Tags: urgent ? 'rotating_light' : 'bell', 'Content-Type': 'text/plain; charset=utf-8' },
          body,
          signal: ctl.signal,
        });
        if (!res || res.ok === false) throw new Error(`HTTP ${res?.status ?? '?'}`);
        try { res.body?.cancel?.(); } catch { /* ignore */ }
        return { status: 'sent' };
      } finally { clearTimeout(timer); }
    } catch (err) {
      this.log(`ntfy alert failed: ${String(err?.name === 'AbortError' ? 'timed out' : err?.message || err).slice(0, 80)}`);
      return { status: 'failed' };
    }
  }
}
