import express from 'express';
import path from 'node:path';
import { VERSION, withProfile } from './config.js';
import { Store } from './store.js';
import { Agent, newSharedBudget } from './agent.js';
import { LlmClient } from './llm.js';
import { Notifier } from './notify.js';
import { LeadService, validateLeadInput, summary, detail, InputError, SOURCES } from './service.js';
import { FollowupScheduler } from './followups.js';
import { computeMetrics } from './metrics.js';
import { listSlots, mondayOf, localNow, dateOf, addDays, isValidDate, isOpenNow, feedFor, calendarSource, busyOnDate, dayChecked } from './calendar.js';
import { rateLimiter, acceptCounter, gate } from './ratelimit.js';
import { seedSample, sampleIsStale } from './seed.js';
import { loadProfile, SHIPPED_PROFILES } from './profile.js';
import { safeEqual } from './util.js';
import { buildIcs, googleCalendarUrl } from './ics.js';
import { slotLabel } from './calendar.js';
import crypto from 'node:crypto';

// Calendar status for /api/health and the Calendar page: only flags and short codes, never the feed address.
const NO_FEED = { configured: false, connected: false, lastOk: null, lastError: null, eventsLoaded: 0, stale: false, staleMinutes: 0, unsupportedRules: 0, warnings: 0 };
function calendarHealth(cfg) {
  const feed = feedFor(cfg);
  if (!feed) return NO_FEED;
  const { configured, connected, lastOk, lastError, eventsLoaded, stale, staleMinutes, unsupportedRules, warnings } = feed.status();
  return { configured, connected, lastOk, lastError, eventsLoaded, stale, staleMinutes, unsupportedRules, warnings };
}
const CALENDAR_NOTICE = 'Google Calendar could not be read right now, so this page and the assistant are using the demo calendar instead. Nothing here is from your real calendar until the connection works again.';

const SCENARIOS_OF = (config) => config.profile.scenarios;
const LEAD_ID = /^L-[0-9a-f]{8}$/;

/**
 * One business "tenant": its own profile, state file, agent, lead service and follow-up scheduler. The server runs the
 * deployment's own profile and, on request, the other shipped example profiles, each fully isolated from the others.
 * Only the model budget and the visitor-key salt are shared (so switching profiles cannot multiply the model budget).
 */
export async function createApp({ config, store = new Store({ file: config.dataFile }), llm, now = Date.now, startTimers = true, notifyTransport = null } = {}) {
  const client = llm ?? new LlmClient({ ...config.inference, fetchImpl: globalThis.fetch });
  const shared = newSharedBudget();
  const notifier = new Notifier({ ...config.notify, transport: notifyTransport, now });
  const startedAt = now();
  const tenants = new Map();
  const timers = [];

  async function buildTenant(cfg, st) {
    const agent = new Agent({ store: st, config: cfg, llm: client, now, shared, notifier });
    const svc = new LeadService({ store: st, agent, config: cfg, now });
    const scheduler = new FollowupScheduler({ store: st, agent, now });
    if (cfg.seedOnEmpty && !st.state.meta.seeded && st.leads.length === 0) await seedSample(st, cfg, { realNow: now() });
    // Keep the fictional sample day fresh on a long-running server: its times are relative to when it was loaded.
    const refreshSample = async () => { if (cfg.seedOnEmpty && sampleIsStale(st, now())) { await seedSample(st, cfg, { force: true, realNow: now() }); return true; } return false; };
    await refreshSample();
    if (startTimers) {
      scheduler.start();
      const t = setInterval(() => { refreshSample().catch(() => {}); }, 15 * 60_000);
      t.unref?.();
      timers.push(t);
    }
    return { id: cfg.profile.id, config: cfg, store: st, agent, svc, scheduler, refreshSample, lastReset: 0 };
  }

  const main = await buildTenant(config, store);
  tenants.set(config.profile.id, Promise.resolve(main));

  // Which profiles a visitor may switch to: the shipped examples plus this deployment's own profile. Never a name or path
  // taken from the request: the id is looked up in this fixed list.
  const allowed = config.profileSwitcher === false ? [config.profile.id] : [...new Set([config.profile.id, ...SHIPPED_PROFILES])];
  const profileInfo = new Map();
  const infoFor = (id) => {
    if (!profileInfo.has(id)) {
      const p = id === config.profile.id ? config.profile : loadProfile(id);
      profileInfo.set(id, { id, name: id === config.profile.id ? config.business.name : p.business.name, tagline: p.business.tagline, accent: p.business.accent, customerWord: p.business.customerWord });
    }
    return profileInfo.get(id);
  };
  const getTenant = (id) => {
    if (!tenants.has(id)) {
      const p = loadProfile(id);
      const cfg = withProfile(config, p);
      tenants.set(id, buildTenant(cfg, new Store({ file: cfg.dataFile })));
    }
    return tenants.get(id);
  };

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy ?? false);
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    });
    next();
  });
  app.use(express.json({ limit: config.limits.bodyBytes }));

  // A non-reversible per-process visitor key, used only for per-visitor caps (never shown or sent anywhere).
  const ipSalt = crypto.randomBytes(16);
  const ipKey = (req) => crypto.createHmac('sha256', ipSalt).update(String(req.ip)).digest('hex').slice(0, 16);

  const readLimit = rateLimiter(config.limits.readRate, 'read', now);
  // Accepted-only counters (invalid submissions never count). Keys include the business profile, so the three example
  // businesses each have their own allowance. "visitor" = address + browser; "ip" = address only (an office behind one NAT).
  const visitorOf = (req) => crypto.createHash('sha256').update(`${req.ip}|${req.get('user-agent') || ''}`).digest('hex').slice(0, 16);
  const K = {
    visitor: (req) => `${req.t.id}:${visitorOf(req)}`,
    ip: (req) => `${req.t.id}:${req.ip}`,
    ipAll: (req) => String(req.ip),
  };
  const cLeadMin = acceptCounter(config.limits.leadRate, now);
  const cLeadHour = acceptCounter(config.limits.leadRateHour, now);
  const cLeadIp = acceptCounter(config.limits.leadIpHour, now);
  const cSimMin = acceptCounter(config.limits.simRate, now);
  const cSimHour = acceptCounter(config.limits.simRateHour, now);
  const cReplyMin = acceptCounter(config.limits.replyRate, now);
  const cReplyHour = acceptCounter(config.limits.replyRateHour, now);
  const leadGate = gate([{ counter: cLeadMin, key: K.ip }, { counter: cLeadHour, key: K.visitor }, { counter: cLeadIp, key: K.ip }]);
  const simGate = gate([{ counter: cSimMin, key: K.ipAll }, { counter: cSimHour, key: K.visitor }]);
  const replyGate = gate([{ counter: cReplyMin, key: K.ip }, { counter: cReplyHour, key: K.visitor }]);
  const hitAll = (req, list) => list.forEach(([c, k]) => c.hit(K[k](req)));
  const resetLimit = rateLimiter(config.limits.resetRate, 'reset', now);

  // Which business this request is for: the x-profile header or ?profile= query, looked up in a fixed list. No header means
  // the deployment's own profile. Anything else is rejected, so no path or file name ever comes from a request.
  app.use('/api', async (req, res, next) => {
    try {
      const raw = req.get('x-profile') ?? req.query.profile;
      if (raw === undefined || raw === '') { req.t = main; return next(); }
      const id = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
      if (!allowed.includes(id)) return res.status(400).json({ error: 'Unknown business profile.' });
      req.t = await getTenant(id);
      return next();
    } catch (e) { return next(e); }
  });

  app.get('/api/profiles', readLimit, (_req, res) => {
    res.json({ default: config.profile.id, switcher: allowed.length > 1, profiles: allowed.map(infoFor) });
  });

  app.get('/api/health', (req, res) => {
    const { config, store, agent } = req.t;
    const st = agent.status();
    const feed = feedFor(config);
    feed?.ensureFresh(now()); // warm the cache in the background; never awaited and never throws
    res.json({
      ok: true, version: VERSION, mode: st.mode, modeLabel: st.label, model: st.model,
      inferenceConfigured: st.inferenceConfigured, modelVerified: st.modelVerified, consecutiveModelFailures: st.consecutiveModelFailures, lastError: st.lastError, quotaReached: st.quotaReached, modelRunsLastHour: st.modelRunsLastHour, modelRunCap: st.modelRunCap, uptimeSec: Math.round((now() - startedAt) / 1000),
      leads: store.leads.length, pendingFollowups: store.followups.filter((f) => f.status === 'pending').length,
      fallbackReasons: agent.fallbackReasons(), ruleHandled: agent.ruleHandled(), notify: notifier.status(), calendar: calendarHealth(config), business: config.business.name, followupSpeedup: config.followupSpeedup,
    });
  });

  app.get('/api/config', readLimit, (req, res) => {
    const { config, agent } = req.t;
    const p = config.profile;
    res.json({
      profile: p.id,
      business: config.business, wording: config.wording, hours: config.hours, hoursText: config.hours.text,
      serviceArea: config.serviceArea, followupSpeedup: config.followupSpeedup, maxSteps: config.maxSteps, sources: SOURCES,
      services: config.services.map((x) => ({ id: x.id, label: x.label, group: x.group, price: x.price })),
      alwaysHuman: p.alwaysHuman.filter((t) => t.id !== 'insurance').map((t) => t.label), confirmByTeammate: p.alwaysHuman.filter((t) => t.id === 'insurance').map((t) => t.label), urgency: { label: p.urgency.label, safetyNote: p.urgency.safetyNote },
      agent: agent.status(),
    });
  });

  app.get('/api/scenarios', readLimit, (req, res) => res.json(SCENARIOS_OF(req.t.config).map(({ id, title, blurb }) => ({ id, title, blurb }))));

  app.get('/api/leads', readLimit, (req, res) => {
    const { config, store, agent } = req.t;
    res.json({ leads: [...store.leads].sort((a, b) => b.createdAt - a.createdAt).map((l) => summary(l, store)), agent: agent.status(), officeOpen: isOpenNow(localNow(now(), config.business.tz), config.hours), today: dateOf(localNow(now(), config.business.tz)) });
  });

  app.get('/api/leads/:id', readLimit, (req, res) => {
    const { config, store, agent } = req.t;
    const lead = LEAD_ID.test(req.params.id) ? store.getLead(req.params.id) : null;
    if (!lead) return res.status(404).json({ error: 'Lead not found.' });
    return res.json({ lead: detail(lead, store), agent: agent.status(), followupSpeedup: config.followupSpeedup });
  });

  // Public intake: the customer-facing form and any website can post here.
  app.post('/api/leads', leadGate, (req, res, next) => {
    try {
      const { config, svc } = req.t;
      const input = validateLeadInput(req.body, config.limits);
      const { lead } = svc.createLead(input, { ipKey: ipKey(req) });
      hitAll(req, [[cLeadMin, 'ip'], [cLeadHour, 'visitor'], [cLeadIp, 'ip']]);
      res.status(202).json({ id: lead.id, token: lead.token, status: lead.status, receivedAt: lead.createdAt });
    } catch (e) { next(e); }
  });

  app.post('/api/simulate', simGate, (req, res, next) => {
    try {
      const { config, svc } = req.t;
      const sc = SCENARIOS_OF(config).find((s) => s.id === req.body?.scenario);
      if (!sc) throw new InputError('Unknown scenario.');
      const { lead } = svc.createLead(sc.lead, { simulated: true, ipKey: ipKey(req) });
      hitAll(req, [[cSimMin, 'ipAll'], [cSimHour, 'visitor']]);
      res.status(202).json({ id: lead.id, token: lead.token, status: lead.status });
    } catch (e) { next(e); }
  });

  // Dashboard role-play: type as the customer. Needs the per-lead token like every other write.
  // Simulated leads hand their token to the browser that created them; sample leads expose a demo token in their detail.
  app.post('/api/leads/:id/customer-reply', replyGate, (req, res, next) => {
    try {
      const { store, svc } = req.t;
      const target = LEAD_ID.test(req.params.id) ? store.getLead(req.params.id) : null;
      const tok = String(req.get('x-lead-token') || req.body?.token || '');
      if (!target || !tok || !safeEqual(tok, target.token)) throw new InputError('Lead not found.', 404);
      const { lead } = svc.addCustomerMessage(req.params.id, req.body?.text, { ipKey: ipKey(req) });
      hitAll(req, [[cReplyMin, 'ip'], [cReplyHour, 'visitor']]);
      res.status(202).json({ id: lead.id });
    } catch (e) { next(e); }
  });

  // Customer-facing thread: needs the secret token returned at intake; exposes messages only.
  const publicLead = (req) => {
    const { store } = req.t;
    const lead = LEAD_ID.test(req.params.id) ? store.getLead(req.params.id) : null;
    const tok = String(req.query.token || req.body?.token || '');
    if (!lead || !tok || !safeEqual(tok, lead.token)) throw new InputError('Lead not found.', 404);
    return lead;
  };
  // The customer's own booked appointment, for the "Add to my calendar" buttons. Public facts only.
  const appointmentOf = (req, lead) => {
    const { store, config } = req.t;
    const b = store.bookingForLead(lead.id);
    return b ? { label: slotLabel(b.slot_id, config.hours.windowHours), googleUrl: googleCalendarUrl(b, config) } : null;
  };
  app.get('/api/public/leads/:id/appointment.ics', readLimit, (req, res, next) => {
    try {
      const { store, config } = req.t;
      const lead = publicLead(req);
      const b = store.bookingForLead(lead.id);
      if (!b) throw new InputError('No booked appointment for this conversation.', 404);
      res.set({ 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': 'attachment; filename="appointment.ics"', 'Cache-Control': 'no-store' });
      res.send(buildIcs(b, config, now()));
    } catch (e) { next(e); }
  });
  app.get('/api/public/leads/:id', readLimit, (req, res, next) => {
    try {
      const { store, agent } = req.t;
      const lead = publicLead(req);
      res.json({ id: lead.id, name: lead.name, replyTimeSec: lead.replyTimeSec ?? null, messages: lead.messages.map((m) => ({ from: m.from, text: m.text, ts: m.ts })), handedToHuman: lead.status === 'human', booked: !!store.bookingForLead(lead.id), mode: lead.lastReplyBy ? ({ model: 'AI model', safety: 'Safety rules' }[lead.lastReplyBy] || 'Built-in rules') : agent.status().label, appointment: appointmentOf(req, lead) });
    } catch (e) { next(e); }
  });
  app.post('/api/public/leads/:id/messages', replyGate, (req, res, next) => {
    try {
      const { svc } = req.t;
      const lead = publicLead(req);
      svc.addCustomerMessage(lead.id, req.body?.text, { ipKey: ipKey(req) });
      hitAll(req, [[cReplyMin, 'ip'], [cReplyHour, 'visitor']]);
      res.status(202).json({ id: lead.id });
    } catch (e) { next(e); }
  });

  // Reset the demo: reloads the fictional sample day only. Visitors' own conversations and bookings are never touched,
  // so one visitor cannot erase another's work. The sample day is produced by the offline rules engine on a separate
  // agent, so this never spends or touches the live model budget.
  app.post('/api/demo/reset', resetLimit, async (req, res, next) => {
    try {
      const { config, store } = req.t;
      if (now() - req.t.lastReset < config.limits.resetCooldownMs) {
        res.set('Retry-After', String(Math.ceil(config.limits.resetCooldownMs / 1000)));
        return res.status(429).json({ error: 'The demo was reset a moment ago. Try again shortly.' });
      }
      req.t.lastReset = now();
      await seedSample(store, config, { force: true, realNow: now() });
      return res.json({ ok: true, leads: store.leads.length, bookings: store.bookings.length });
    } catch (e) { return next(e); }
  });

  app.get('/api/calendar', readLimit, async (req, res) => {
    const { config, store } = req.t;
    await feedFor(config)?.ensureFresh(now());
    const today = dateOf(localNow(now(), config.business.tz));
    let start = typeof req.query.start === 'string' && isValidDate(req.query.start) && req.query.start >= '2000-01-01' && req.query.start <= '2100-12-31' ? req.query.start : today;
    start = mondayOf(start);
    const slots = listSlots(store, config, now(), start, 6);
    const days = Array.from({ length: 6 }, (_, i) => addDays(start, i)).map((date) => ({ date, today: date === today, slots: slots.filter((s) => s.date === date), busy: busyOnDate(date, config), checked: dayChecked(date, config) }));
    const h = calendarHealth(config);
    res.json({
      start, prev: addDays(start, -7), next: addDays(start, 7), today, timezone: config.business.tz, days,
      calendar: { source: calendarSource(config), configured: h.configured, connected: h.connected, stale: h.stale, staleMinutes: h.staleMinutes, unsupportedRules: h.unsupportedRules, warnings: h.warnings, lastError: h.lastError, notice: h.configured && !h.connected ? CALENDAR_NOTICE : null },
    });
  });

  app.get('/api/metrics', readLimit, (req, res) => {
    const { config, store } = req.t;
    res.json(computeMetrics(store, config, now(), req.query.scope === 'all' ? 'all' : 'live'));
  });

  app.use(express.static(path.join(config.root, 'public'), { extensions: ['html'], maxAge: 0 }));
  app.get(['/inbox', '/calendar', '/results', '/guardrails'], (_req, res) => res.sendFile(path.join(config.root, 'public', 'index.html')));
  app.get('/lead', (_req, res) => res.sendFile(path.join(config.root, 'public', 'lead.html')));
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof InputError) return res.status(err.status).json({ error: err.message });
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'Request is too large.' });
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Body must be valid JSON.' });
    return res.status(500).json({ error: 'Something went wrong.' });
  });

  return {
    app, store, agent: main.agent, svc: main.svc, scheduler: main.scheduler, llm: client, refreshSample: main.refreshSample, shared,
    tenant: async (id) => getTenant(id),
    close: async () => {
      timers.forEach((t) => clearInterval(t));
      for (const p of tenants.values()) { const t = await p; t.scheduler.stop(); await t.store.flush(); }
    },
  };
}
