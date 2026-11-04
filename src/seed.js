// Loads a believable sample day with the offline rules engine and a simulated clock.
// Sample leads are flagged seed:true so Results can separate them from live agent runs.
import { Agent } from './agent.js';
import { LeadService } from './service.js';
import { addDays, dateOf, localNow, dow } from './calendar.js';

function shiftLead(lead, store, delta) {
  const f = (o, k) => { if (typeof o[k] === 'number') o[k] -= delta; };
  ['createdAt', 'firstReplyAt', 'lastCustomerAt', 'lastRunAt'].forEach((k) => f(lead, k));
  lead.messages.forEach((m) => f(m, 'ts'));
  lead.timeline.forEach((t) => f(t, 'ts'));
  if (lead.qualification) f(lead.qualification, 'updatedAt');
  store.bookings.filter((b) => b.leadId === lead.id).forEach((b) => f(b, 'createdAt'));
  store.followups.filter((x) => x.leadId === lead.id).forEach((x) => ['createdAt', 'dueAt', 'firedAt', 'endedAt'].forEach((k) => f(x, k)));
}

export const SAMPLE_REFRESH_MS = 6 * 3_600_000;

/** Remove the fictional sample day (sample leads, sample bookings, their follow-ups). Visitors' own leads and bookings stay. */
export function clearSample(store) {
  const gone = new Set(store.leads.filter((l) => l.seed).map((l) => l.id));
  store.state.leads = store.leads.filter((l) => !l.seed);
  store.state.bookings = store.bookings.filter((b) => !b.sample && !gone.has(b.leadId));
  store.state.followups = store.followups.filter((f) => !gone.has(f.leadId));
}

/** Has the sample day been loaded long enough ago that its "minutes ago" times have drifted? */
export function sampleIsStale(store, nowMs, maxAgeMs = SAMPLE_REFRESH_MS) {
  const at = store.state.meta.seededAt;
  return !!store.state.meta.seeded && (!at || nowMs - at > maxAgeMs);
}

/**
 * Load the sample day with times relative to "now", so it always looks like a morning at the front desk.
 * force: replace the existing sample day (visitors' own conversations are kept).
 */
export async function seedSample(store, config, { force = false, realNow = Date.now() } = {}) {
  if (store.state.meta.seeded && !force) return false;
  if (force) clearSample(store);
  const existingIds = new Set(store.bookings.map((b) => b.id));
  // Simulated clock that advances a few hundred milliseconds per reading.
  let t = realNow;
  let seedState = 7;
  const clock = () => { seedState = (seedState * 1103515245 + 12345) & 0x7fffffff; t += 240 + (seedState % 420); return t; };
  const cfg = { ...config, followupSpeedup: 60, forceOffline: false, limits: { ...config.limits, emergencyHolds: true, maxLiveBookings: 999 } };
  const agent = new Agent({ store, config: cfg, llm: null, now: clock });
  const svc = new LeadService({ store, agent, config: cfg, now: clock });

  for (const s of config.profile.seed) {
    const { lead, done } = svc.createLead(s.lead, { seed: true, simulated: true });
    await done;
    for (const text of s.replies) { const r = svc.addCustomerMessage(lead.id, text); await r.done; t += 20_000; }
    if (s.quietFollowup) {
      const fu = store.followups.find((x) => x.leadId === lead.id && x.status === 'pending');
      if (fu) { t = fu.dueAt + 100; await agent.fireFollowup(fu); }
    }
    for (const f of store.followups) if (f.leadId === lead.id && f.status === 'pending') { f.status = 'cancelled'; f.reason = 'sample data'; }
    shiftLead(lead, store, lead.createdAt - (realNow - s.minutesAgo * 60_000));
    t += 5_000;
  }

  // Fictional existing customers so the week view shows a realistic, partly full calendar.
  const today = dateOf(localNow(realNow, config.business.tz));
  config.profile.existing.forEach((e, i) => {
    let date = addDays(today, e.dayOffset);
    while (!config.hours.starts[dow(date)]) date = addDays(date, 1);
    const starts = config.hours.starts[dow(date)];
    const slot = `${date}T${starts[e.slotIndex % starts.length]}`;
    if (!store.bookingForSlot(slot)) {
      store.bookings.push({ id: `B-seed${i}`, slot_id: slot, leadId: null, name: e.name, serviceLabel: e.service, service: 'other', kind: 'existing', status: 'confirmed', sample: true, createdAt: realNow - 86_400_000 });
    }
  });
  for (const b of store.bookings) if (!existingIds.has(b.id)) b.sample = true; // the sample day itself: never expires
  store.state.meta.seeded = true;
  store.state.meta.seededAt = realNow;
  store.save();
  return true;
}
