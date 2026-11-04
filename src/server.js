import express from 'express';
import path from 'node:path';
import { VERSION, JOB_TYPES } from './config.js';
import { Store } from './store.js';
import { Agent } from './agent.js';
import { LlmClient } from './llm.js';
import { LeadService, validateLeadInput, summary, detail, InputError, SOURCES } from './service.js';
import { FollowupScheduler } from './followups.js';
import { computeMetrics } from './metrics.js';
import { listSlots, mondayOf, localNow, dateOf, addDays, isValidDate, isOpenNow } from './calendar.js';
import { rateLimiter } from './ratelimit.js';
import { SCENARIOS } from './scenarios.js';
import { seedSample } from './seed.js';
import { priceRangeFor } from './functions.js';
import { safeEqual } from './util.js';

const LEAD_ID = /^L-[0-9a-f]{8}$/;

export async function createApp({ config, store = new Store({ file: config.dataFile }), llm, now = Date.now, startTimers = true } = {}) {
  const client = llm ?? new LlmClient({ ...config.inference, fetchImpl: globalThis.fetch });
  const agent = new Agent({ store, config, llm: client, now });
  const svc = new LeadService({ store, agent, config, now });
  const scheduler = new FollowupScheduler({ store, agent, now });
  const startedAt = now();
  if (config.seedOnEmpty && !store.state.meta.seeded && store.leads.length === 0) await seedSample(store, config, { realNow: now() });
  if (startTimers) scheduler.start();

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    });
    next();
  });
  app.use(express.json({ limit: config.limits.bodyBytes }));

  const readLimit = rateLimiter(config.limits.readRate, 'read', now);
  const leadLimit = rateLimiter(config.limits.leadRate, 'lead', now);
  const replyLimit = rateLimiter(config.limits.replyRate, 'reply', now);

  app.get('/api/health', (_req, res) => {
    const st = agent.status();
    res.json({
      ok: true, version: VERSION, mode: st.mode, modeLabel: st.label, model: st.model,
      inferenceConfigured: st.inferenceConfigured, uptimeSec: Math.round((now() - startedAt) / 1000),
      leads: store.leads.length, pendingFollowups: store.followups.filter((f) => f.status === 'pending').length,
      business: config.business.name, followupSpeedup: config.followupSpeedup,
    });
  });

  app.get('/api/config', readLimit, (_req, res) => {
    res.json({
      business: config.business, hours: config.hours.text, serviceArea: config.serviceArea.cities, followupSpeedup: config.followupSpeedup,
      maxSteps: config.maxSteps, sources: SOURCES,
      priceBook: Object.entries(config.priceBook).filter(([, v]) => v).map(([k, v]) => ({ job: k, label: JOB_TYPES[k].label, range: priceRangeFor(config, k, 'unknown'), noQuote: false, sizes: v })),
      noQuoteJobs: Object.entries(config.priceBook).filter(([, v]) => !v).map(([k]) => JOB_TYPES[k].label),
      agent: agent.status(),
    });
  });

  app.get('/api/scenarios', readLimit, (_req, res) => res.json(SCENARIOS.map(({ id, title, blurb }) => ({ id, title, blurb }))));

  app.get('/api/leads', readLimit, (_req, res) => {
    res.json({ leads: store.leads.map((l) => summary(l, store)), agent: agent.status(), officeOpen: isOpenNow(localNow(now(), config.business.tz), config.hours), today: dateOf(localNow(now(), config.business.tz)) });
  });

  app.get('/api/leads/:id', readLimit, (req, res) => {
    const lead = LEAD_ID.test(req.params.id) ? store.getLead(req.params.id) : null;
    if (!lead) return res.status(404).json({ error: 'Lead not found.' });
    return res.json({ lead: detail(lead, store), agent: agent.status(), followupSpeedup: config.followupSpeedup });
  });

  // Public intake: the customer-facing form and any website can post here.
  app.post('/api/leads', leadLimit, (req, res, next) => {
    try {
      const input = validateLeadInput(req.body, config.limits);
      const { lead } = svc.createLead(input);
      res.status(202).json({ id: lead.id, token: lead.token, status: lead.status, receivedAt: lead.createdAt });
    } catch (e) { next(e); }
  });

  app.post('/api/simulate', leadLimit, (req, res, next) => {
    try {
      const sc = SCENARIOS.find((s) => s.id === req.body?.scenario);
      if (!sc) throw new InputError('Unknown scenario.');
      const { lead } = svc.createLead(sc.lead, { simulated: true });
      res.status(202).json({ id: lead.id, token: lead.token, status: lead.status });
    } catch (e) { next(e); }
  });

  // Dashboard role-play: type as the customer. Needs the per-lead token like every other write.
  // Simulated leads hand their token to the browser that created them; sample leads expose a demo token in their detail.
  app.post('/api/leads/:id/customer-reply', replyLimit, (req, res, next) => {
    try {
      const target = LEAD_ID.test(req.params.id) ? store.getLead(req.params.id) : null;
      const tok = String(req.get('x-lead-token') || req.body?.token || '');
      if (!target || !tok || !safeEqual(tok, target.token)) throw new InputError('Lead not found.', 404);
      const { lead } = svc.addCustomerMessage(req.params.id, req.body?.text);
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
  app.post('/api/public/leads/:id/messages', replyLimit, (req, res, next) => {
    try {
      const lead = publicLead(req);
      svc.addCustomerMessage(lead.id, req.body?.text);
      res.status(202).json({ id: lead.id });
    } catch (e) { next(e); }
  });

  app.get('/api/calendar', readLimit, (req, res) => {
    const today = dateOf(localNow(now(), config.business.tz));
    let start = typeof req.query.start === 'string' && isValidDate(req.query.start) ? req.query.start : today;
    start = mondayOf(start);
    const slots = listSlots(store, config, now(), start, 6);
    const days = Array.from({ length: 6 }, (_, i) => addDays(start, i)).map((date) => ({ date, today: date === today, slots: slots.filter((s) => s.date === date) }));
    res.json({ start, prev: addDays(start, -7), next: addDays(start, 7), today, timezone: config.business.tz, days });
  });

  app.get('/api/metrics', readLimit, (req, res) => {
    res.json(computeMetrics(store, config, now(), req.query.scope === 'live' ? 'live' : 'all'));
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

  return { app, store, agent, svc, scheduler, llm: client, close: async () => { scheduler.stop(); await store.flush(); } };
}
