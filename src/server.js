import express from 'express';
import path from 'node:path';
import { VERSION } from './config.js';
import { Store } from './store.js';
import { Agent } from './agent.js';
import { LlmClient } from './llm.js';
import { LeadService, validateLeadInput, summary, detail, InputError, SOURCES } from './service.js';
import { FollowupScheduler } from './followups.js';
import { computeMetrics } from './metrics.js';
import { listSlots, mondayOf, localNow, dateOf, addDays, isValidDate, isOpenNow } from './calendar.js';
import { rateLimiter } from './ratelimit.js';
import { seedSample, sampleIsStale } from './seed.js';
import { safeEqual } from './util.js';
import crypto from 'node:crypto';

const SCENARIOS_OF = (config) => config.profile.scenarios;
const LEAD_ID = /^L-[0-9a-f]{8}$/;

export async function createApp({ config, store = new Store({ file: config.dataFile }), llm, now = Date.now, startTimers = true } = {}) {
  const client = llm ?? new LlmClient({ ...config.inference, fetchImpl: globalThis.fetch });
  const agent = new Agent({ store, config, llm: client, now });
  const svc = new LeadService({ store, agent, config, now });
  const scheduler = new FollowupScheduler({ store, agent, now });
  const startedAt = now();
  if (config.seedOnEmpty && !store.state.meta.seeded && store.leads.length === 0) await seedSample(store, config, { realNow: now() });
  // Keep the fictional sample day fresh on a long-running server: its times are relative to when it was loaded.
  const refreshSample = async () => { if (config.seedOnEmpty && sampleIsStale(store, now())) { await seedSample(store, config, { force: true, realNow: now() }); return true; } return false; };
  await refreshSample();
  let sampleTimer = null;
  if (startTimers) {
    scheduler.start();
    sampleTimer = setInterval(() => { refreshSample().catch(() => {}); }, 15 * 60_000);
    sampleTimer.unref?.();
  }

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
  const leadLimit = rateLimiter(config.limits.leadRate, 'lead', now);
  const replyLimit = rateLimiter(config.limits.replyRate, 'reply', now);
  const leadHourLimit = rateLimiter(config.limits.leadRateHour, 'lead-hour', now);
  const replyHourLimit = rateLimiter(config.limits.replyRateHour, 'reply-hour', now);
  const resetLimit = rateLimiter(config.limits.resetRate, 'reset', now);

  app.get('/api/health', (_req, res) => {
    const st = agent.status();
    res.json({
      ok: true, version: VERSION, mode: st.mode, modeLabel: st.label, model: st.model,
      inferenceConfigured: st.inferenceConfigured, modelVerified: st.modelVerified, lastError: st.lastError, quotaReached: st.quotaReached, modelRunsLastHour: st.modelRunsLastHour, modelRunCap: st.modelRunCap, uptimeSec: Math.round((now() - startedAt) / 1000),
      leads: store.leads.length, pendingFollowups: store.followups.filter((f) => f.status === 'pending').length,
      business: config.business.name, followupSpeedup: config.followupSpeedup,
    });
  });

  app.get('/api/config', readLimit, (_req, res) => {
    const p = config.profile;
    res.json({
      profile: p.id,
      business: config.business, wording: config.wording, hours: config.hours, hoursText: config.hours.text,
      serviceArea: config.serviceArea, followupSpeedup: config.followupSpeedup, maxSteps: config.maxSteps, sources: SOURCES,
      services: config.services.map((x) => ({ id: x.id, label: x.label, group: x.group, price: x.price })),
      alwaysHuman: p.alwaysHuman.map((t) => t.label), urgency: { label: p.urgency.label, safetyNote: p.urgency.safetyNote },
      agent: agent.status(),
    });
  });

  app.get('/api/scenarios', readLimit, (_req, res) => res.json(SCENARIOS_OF(config).map(({ id, title, blurb }) => ({ id, title, blurb }))));

  app.get('/api/leads', readLimit, (_req, res) => {
    res.json({ leads: [...store.leads].sort((a, b) => b.createdAt - a.createdAt).map((l) => summary(l, store)), agent: agent.status(), officeOpen: isOpenNow(localNow(now(), config.business.tz), config.hours), today: dateOf(localNow(now(), config.business.tz)) });
  });

  app.get('/api/leads/:id', readLimit, (req, res) => {
    const lead = LEAD_ID.test(req.params.id) ? store.getLead(req.params.id) : null;
    if (!lead) return res.status(404).json({ error: 'Lead not found.' });
    return res.json({ lead: detail(lead, store), agent: agent.status(), followupSpeedup: config.followupSpeedup });
  });

  // Public intake: the customer-facing form and any website can post here.
  app.post('/api/leads', leadLimit, leadHourLimit, (req, res, next) => {
    try {
      const input = validateLeadInput(req.body, config.limits);
      const { lead } = svc.createLead(input, { ipKey: ipKey(req) });
      res.status(202).json({ id: lead.id, token: lead.token, status: lead.status, receivedAt: lead.createdAt });
    } catch (e) { next(e); }
  });

  app.post('/api/simulate', leadLimit, leadHourLimit, (req, res, next) => {
    try {
      const sc = SCENARIOS_OF(config).find((s) => s.id === req.body?.scenario);
      if (!sc) throw new InputError('Unknown scenario.');
      const { lead } = svc.createLead(sc.lead, { simulated: true, ipKey: ipKey(req) });
      res.status(202).json({ id: lead.id, token: lead.token, status: lead.status });
    } catch (e) { next(e); }
  });

  // Dashboard role-play: type as the customer. Needs the per-lead token like every other write.
  // Simulated leads hand their token to the browser that created them; sample leads expose a demo token in their detail.
  app.post('/api/leads/:id/customer-reply', replyLimit, replyHourLimit, (req, res, next) => {
    try {
      const target = LEAD_ID.test(req.params.id) ? store.getLead(req.params.id) : null;
      const tok = String(req.get('x-lead-token') || req.body?.token || '');
      if (!target || !tok || !safeEqual(tok, target.token)) throw new InputError('Lead not found.', 404);
      const { lead } = svc.addCustomerMessage(req.params.id, req.body?.text, { ipKey: ipKey(req) });
      res.status(202).json({ id: lead.id });
    } catch (e) { next(e); }
  });

  // Customer-facing thread: needs the secret token returned at intake; exposes messages only.
  const publicLead = (req) => {
    const lead = LEAD_ID.test(req.params.id) ? store.getLead(req.params.id) : null;
    const tok = String(req.query.token || req.body?.token || '');
    if (!lead || !tok || !safeEqual(tok, lead.token)) throw new InputError('Lead not found.', 404);
    return lead;
  };
  app.get('/api/public/leads/:id', readLimit, (req, res, next) => {
    try {
      const lead = publicLead(req);
      res.json({ id: lead.id, name: lead.name, replyTimeSec: lead.replyTimeSec ?? null, messages: lead.messages.map((m) => ({ from: m.from, text: m.text, ts: m.ts })), handedToHuman: lead.status === 'human', booked: !!store.bookingForLead(lead.id), mode: agent.status().label });
    } catch (e) { next(e); }
  });
  app.post('/api/public/leads/:id/messages', replyLimit, replyHourLimit, (req, res, next) => {
    try {
      const lead = publicLead(req);
      svc.addCustomerMessage(lead.id, req.body?.text, { ipKey: ipKey(req) });
      res.status(202).json({ id: lead.id });
    } catch (e) { next(e); }
  });

  // Reset the demo: reloads the fictional sample day only. Visitors' own conversations and bookings are never touched,
  // so one visitor cannot erase another's work. The sample day is produced by the offline rules engine on a separate
  // agent, so this never spends or touches the live model budget.
  let lastReset = 0;
  app.post('/api/demo/reset', resetLimit, async (_req, res, next) => {
    try {
      if (now() - lastReset < config.limits.resetCooldownMs) {
        res.set('Retry-After', String(Math.ceil(config.limits.resetCooldownMs / 1000)));
        return res.status(429).json({ error: 'The demo was reset a moment ago. Try again shortly.' });
      }
      lastReset = now();
      await seedSample(store, config, { force: true, realNow: now() });
      return res.json({ ok: true, leads: store.leads.length, bookings: store.bookings.length });
    } catch (e) { return next(e); }
  });

  app.get('/api/calendar', readLimit, (req, res) => {
    const today = dateOf(localNow(now(), config.business.tz));
    let start = typeof req.query.start === 'string' && isValidDate(req.query.start) && req.query.start >= '2000-01-01' && req.query.start <= '2100-12-31' ? req.query.start : today;
    start = mondayOf(start);
    const slots = listSlots(store, config, now(), start, 6);
    const days = Array.from({ length: 6 }, (_, i) => addDays(start, i)).map((date) => ({ date, today: date === today, slots: slots.filter((s) => s.date === date) }));
    res.json({ start, prev: addDays(start, -7), next: addDays(start, 7), today, timezone: config.business.tz, days });
  });

  app.get('/api/metrics', readLimit, (req, res) => {
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

  return { app, store, agent, svc, scheduler, llm: client, refreshSample, close: async () => { scheduler.stop(); clearInterval(sampleTimer); await store.flush(); } };
}
