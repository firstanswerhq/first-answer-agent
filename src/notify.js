// Owner phone alert. When a lead is handed to a person, send one short push notification through ntfy
// (https://ntfy.sh). This is the one real outside action the app takes. It never blocks a customer reply:
// the caller does not wait for it, the request has a 3 second timeout, and every error is caught and logged as one line.
import { firstName } from './util.js';

export const ALERT_TIMEOUT_MS = 3000;
export const MAX_ALERTS_PER_HOUR = 20;

const ascii = (s) => String(s || '').replace(/[^\x20-\x7e]/g, ' ').replace(/\s+/g, ' ').trim();
// A reason can come from the model, so keep it to one short line and never let a phone number through.
const oneLine = (s, n) => ascii(s).replace(/\+?\d[\d\s().-]{6,}\d/g, '[number removed]').slice(0, n);

export class Notifier {
  /**
   * topic: ntfy topic (secret-ish; never exposed). transport: fetch-compatible function, injected in tests.
   * offline: true means never touch the network (tests, FORCE_OFFLINE=1). An explicitly injected transport is still used.
   */
  constructor({ topic = '', dashboardUrl = '', transport = null, offline = false, now = Date.now, baseUrl = 'https://ntfy.sh', log = (m) => console.warn(m) } = {}) {
    this.topic = String(topic || '').trim();
    this.dashboardUrl = String(dashboardUrl || '').trim();
    this.offline = !!offline;
    this.transport = transport || (offline ? null : (globalThis.fetch ? globalThis.fetch.bind(globalThis) : null));
    this.now = now;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.log = log;
    this.stamps = [];
  }

  get configured() { return !!this.topic; }

  alertsLastHour() {
    const cutoff = this.now() - 3_600_000;
    this.stamps = this.stamps.filter((t) => t > cutoff);
    return this.stamps.length;
  }

  status() { return { configured: this.configured, alertsLastHour: this.alertsLastHour() }; }

  /**
   * Alert the owner about a lead. Resolves to { status } where status is one of:
   * 'sent', 'failed', 'not_configured', 'offline', 'rate_limited', 'duplicate', 'skipped'. Never rejects.
   */
  async alert(lead, { reason = '', priority = 'normal', business = '' } = {}) {
    try {
      if (!lead || lead.seed) return { status: 'skipped' };
      if (lead.ownerAlertedAt) return { status: 'duplicate' };
      if (!this.configured) return { status: 'not_configured' };
      if (!this.transport) return { status: 'offline' };
      if (this.alertsLastHour() >= MAX_ALERTS_PER_HOUR) return { status: 'rate_limited' };
      lead.ownerAlertedAt = this.now(); // max one alert per lead, reserved before the request starts
      this.stamps.push(this.now());
      const urgent = priority === 'urgent';
      const body = [`${oneLine(business, 60)}: ${firstName(lead.name) === 'there' ? 'A customer' : oneLine(firstName(lead.name), 30)} needs a person.`,
        `Reason: ${oneLine(reason, 140) || 'needs a person'}`, this.dashboardUrl ? this.dashboardUrl : ''].filter(Boolean).join('\n');
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
        return { status: 'sent' };
      } finally { clearTimeout(timer); }
    } catch (err) {
      this.log(`ntfy alert failed: ${String(err?.name === 'AbortError' ? 'timed out' : err?.message || err).slice(0, 80)}`);
      return { status: 'failed' };
    }
  }
}
