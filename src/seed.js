// Loads a believable sample day with the offline rules engine and a simulated clock.
// Sample leads are flagged seed:true so Results can separate them from live agent runs.
import { Agent } from './agent.js';
import { LeadService } from './service.js';
import { addDays, dateOf, localNow, dow } from './calendar.js';

const SAMPLE = [
  { min: 265, lead: { name: 'Melissa Barnes', phone: '(615) 555-0101', source: 'Phone call', message: 'Hi, rain came through the ceiling in our back bedroom last night but it stopped. Can someone look at the roof? East Nashville 37206.' }, replies: ['The first one works for us.'] },
  { min: 230, lead: { name: 'Jordan Reed', phone: '(615) 555-0102', source: 'Website form', message: 'Need a move-out cleaning for a 2 bedroom apartment in The Gulch.' }, replies: ['Option 2 please'] },
  { min: 190, lead: { name: 'Taylor Wells', phone: '(615) 555-0103', source: 'Text message', message: 'Our water heater is leaking at the bottom and it is pretty old. Green Hills, 37215.' }, replies: [] },
  { min: 150, lead: { name: 'Denise King', phone: '(615) 555-0104', source: 'Phone call', message: 'We had storm damage on the roof and I need help with my insurance claim. Donelson 37214.' }, replies: [] },
  { min: 120, lead: { name: 'Andre Brooks', phone: '(615) 555-0105', source: 'Website form', message: 'Looking for a house cleaning for our 3 bedroom house in Sylvan Park, maybe every other week.' }, replies: ['2nd'] },
  { min: 85, lead: { name: 'Sam Patel', phone: '(615) 555-0106', source: 'Text message', message: 'My kitchen faucet is leaking underneath the sink. Madison 37115.' }, replies: [] },
  { min: 50, lead: { name: 'Pat Holloway', phone: '(615) 555-0107', source: 'Text message', message: 'Nobody called me back after the crew left a mess in my yard. This is unacceptable and I want a refund.' }, replies: [] },
  { min: 25, lead: { name: 'Chris Morgan', phone: '(615) 555-0108', source: 'Google Ads', message: 'What would it cost to clean the gutters on a 2 story home in Franklin 37064?' }, replies: [], quietFollowup: true },
];

const EXISTING = [
  ['Walker residence', 'House cleaning', 1, 0], ['Alvarez residence', 'Gutter cleaning', 2, 1],
  ['Nguyen residence', 'Drain clog', 3, 2], ['Brandt residence', 'Roof repair', 4, 1], ['Okoye residence', 'Deep cleaning', 2, 3],
];

function shiftLead(lead, store, delta) {
  const f = (o, k) => { if (typeof o[k] === 'number') o[k] -= delta; };
  ['createdAt', 'firstReplyAt', 'lastCustomerAt', 'lastRunAt'].forEach((k) => f(lead, k));
  lead.messages.forEach((m) => f(m, 'ts'));
  lead.timeline.forEach((t) => f(t, 'ts'));
  if (lead.qualification) f(lead.qualification, 'updatedAt');
  store.bookings.filter((b) => b.leadId === lead.id).forEach((b) => f(b, 'createdAt'));
  store.followups.filter((x) => x.leadId === lead.id).forEach((x) => ['createdAt', 'dueAt', 'firedAt', 'endedAt'].forEach((k) => f(x, k)));
}

export async function seedSample(store, config, { force = false, realNow = Date.now() } = {}) {
  if (store.state.meta.seeded && !force) return false;
  if (force) store.reset();
  // Simulated clock that advances a few hundred milliseconds per reading.
  let t = realNow;
  let seedState = 7;
  const clock = () => { seedState = (seedState * 1103515245 + 12345) & 0x7fffffff; t += 240 + (seedState % 420); return t; };
  const cfg = { ...config, followupSpeedup: 60, forceOffline: false };
  const agent = new Agent({ store, config: cfg, llm: null, now: clock });
  const svc = new LeadService({ store, agent, config: cfg, now: clock });

  for (const s of SAMPLE) {
    const { lead, done } = svc.createLead(s.lead, { seed: true, simulated: true });
    await done;
    for (const text of s.replies) { const r = svc.addCustomerMessage(lead.id, text); await r.done; t += 20_000; }
    if (s.quietFollowup) {
      const fu = store.followups.find((x) => x.leadId === lead.id && x.status === 'pending');
      if (fu) { t = fu.dueAt + 100; await agent.fireFollowup(fu); }
    }
    for (const f of store.followups) if (f.leadId === lead.id && f.status === 'pending') { f.status = 'cancelled'; f.reason = 'sample data'; }
    shiftLead(lead, store, lead.createdAt - (realNow - s.min * 60_000));
    t += 5_000;
  }

  // Fictional existing customers so the week view shows a realistic, partly full calendar.
  const today = dateOf(localNow(realNow, config.business.tz));
  EXISTING.forEach(([name, jobLabel, dayOffset, slotIdx], i) => {
    let date = addDays(today, dayOffset);
    while (!config.hours.starts[dow(date)]) date = addDays(date, 1);
    const starts = config.hours.starts[dow(date)];
    const slot = `${date}T${starts[slotIdx % starts.length]}`;
    if (!store.bookingForSlot(slot)) {
      store.bookings.push({ id: `B-seed${i}`, slot_id: slot, leadId: null, name, jobLabel, job_type: 'other', kind: 'existing', status: 'confirmed', createdAt: realNow - 86_400_000 });
    }
  });
  store.state.meta.seeded = true;
  store.save();
  return true;
}
