import { round2 as round1 } from './util.js';
import { localNow, dateOf } from './calendar.js';

// Everything on the Results screen and the inbox side card is computed from stored leads.
export function computeMetrics(store, config, nowMs, scope = 'all') {
  const leads = store.leads.filter((l) => (scope === 'live' ? !l.seed : true));
  const answered = leads.filter((l) => l.firstReplyAt);
  const times = answered.map((l) => l.replyTimeSec);
  const avg = times.length ? round1(times.reduce((a, b) => a + b, 0) / times.length) : null;
  const sorted = [...times].sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
  const booked = leads.filter((l) => store.bookingForLead(l.id)).length;
  const human = leads.filter((l) => l.status === 'human').length;
  const today = dateOf(localNow(nowMs, config.business.tz));
  const todays = leads.filter((l) => dateOf(localNow(l.createdAt, config.business.tz)) === today);
  const chartLeads = [...answered].sort((a, b) => a.createdAt - b.createdAt).slice(-14).map((l) => ({
    id: l.id, name: l.name.split(' ')[0], sec: l.replyTimeSec, mode: l.lastRunMode || 'offline', seed: !!l.seed,
  }));
  return {
    scope,
    totalLeads: leads.length,
    answered: answered.length,
    avgReplySec: avg,
    medianReplySec: median,
    fastestSec: sorted[0] ?? null,
    slowestSec: sorted.at(-1) ?? null,
    booked,
    bookedRate: answered.length ? Math.round((booked / answered.length) * 100) : null,
    human,
    humanRate: answered.length ? Math.round((human / answered.length) * 100) : null,
    waiting: leads.filter((l) => l.status === 'new').length,
    today: {
      leads: todays.length,
      answered: todays.filter((l) => l.firstReplyAt).length,
      booked: todays.filter((l) => store.bookingForLead(l.id)).length,
      human: todays.filter((l) => l.status === 'human').length,
      avgReplySec: (() => { const t = todays.filter((l) => l.firstReplyAt).map((l) => l.replyTimeSec); return t.length ? round1(t.reduce((a, b) => a + b, 0) / t.length) : null; })(),
    },
    chart: chartLeads,
    liveLeads: store.leads.filter((l) => !l.seed).length,
    sampleLeads: store.leads.filter((l) => l.seed).length,
  };
}
