// Central configuration. Everything a business owner would tune lives here:
// hours, service area and the price book. Secrets come only from the environment.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProfile, compileProfile } from './profile.js';
import { CalendarFeed } from './icalfeed.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const int = (v, d) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};

export const VERSION = '1.0.0';

// TRUST_PROXY: unset/empty/0/false = off (default, rate limits use the socket address).
// Set to 1 (one hop) when the app sits behind a single reverse proxy such as Caddy or nginx, so each visitor
// is rate limited by their own address instead of everyone sharing the proxy's.
export function parseTrustProxy(v) {
  const t = String(v ?? '').trim().toLowerCase();
  if (!t || t === '0' || t === 'false' || t === 'off' || t === 'no') return false;
  if (t === 'true' || t === 'on' || t === 'yes') return 1;
  const n = Number.parseInt(t, 10);
  return Number.isFinite(n) && n > 0 && String(n) === t ? n : false;
}

/**
 * The same server settings with a different business profile: used by the "Switch business" control. Only the
 * business-specific parts change; the secrets, limits and model settings stay shared. Each profile keeps its own state file.
 */
export function withProfile(cfg, profile) {
  return {
    ...cfg, profile, business: { ...profile.business }, hours: profile.hours, serviceArea: profile.serviceArea, services: profile.services, wording: profile.wording,
    dataFile: cfg.dataFile ? path.join(path.dirname(cfg.dataFile), `state-${profile.id}.json`) : null,
  };
}

// Optional read-only Google Calendar feed for ONE profile (CALENDAR_PROFILE, default dental). Validated at startup: a bad
// address stops the app with a message that never repeats the address. Unset means the demo calendar everywhere.
function buildCalendarFeed(env, profile, businessTz, over) {
  const url = String(env.CALENDAR_ICAL_URL || '').trim();
  if (!url) return null;
  const id = String(env.CALENDAR_PROFILE || 'dental').trim().toLowerCase();
  let tz = businessTz;
  if (id !== profile.id) {
    try { tz = loadProfile(id).business.tz; } catch { throw new Error('CALENDAR_PROFILE is not a known business profile.'); }
  }
  return new CalendarFeed({ url, profile: id, tz, fetchImpl: over.calendarFetch ?? globalThis.fetch });
}

export function loadConfig(env = process.env, over = {}) {
  // The business profile (config/profiles/<name>.json) carries everything specific to one kind of business.
  const { profile: profileOver, calendarFetch, ...rest } = over;
  const profile = profileOver && typeof profileOver === 'object' ? (profileOver.services?.[0]?.re !== undefined ? profileOver : compileProfile(profileOver)) : loadProfile(profileOver ?? env.BUSINESS_PROFILE);
  const cfg = {
    port: int(env.PORT, 3000),
    host: env.HOST || '0.0.0.0',
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    root,
    dataFile: env.DATA_FILE === '' ? null : env.DATA_FILE || path.join(root, 'data', 'state.json'),
    inference: {
      key: env.VULTR_INFERENCE_KEY || '',
      url: (env.VULTR_INFERENCE_URL || 'https://api.vultrinference.com/v1').replace(/\/+$/, ''),
      model: env.VULTR_INFERENCE_MODEL || 'glm-5.3-flash',
      timeoutMs: int(env.INFERENCE_TIMEOUT_MS, 20000),
      retries: int(env.INFERENCE_RETRIES, 1),
      maxTokens: int(env.MODEL_MAX_TOKENS, 2000),
      maxTokensCap: int(env.MODEL_MAX_TOKENS_CAP, 4000),
      modelDeadlineMs: int(env.MODEL_DEADLINE_MS, 18000), // total time one inquiry may spend waiting on the model
      thinkingOff: env.MODEL_THINKING_OFF !== '0',
      maxRunsPerHour: int(env.INFERENCE_MAX_RUNS_PER_HOUR, 120),
      maxRunsPerIpPerHour: int(env.INFERENCE_MAX_RUNS_PER_IP_PER_HOUR, 15),
    },
    forceOffline: env.FORCE_OFFLINE === '1',
    // Owner phone alerts through ntfy. No topic means no alerts. Never on the network in tests or with FORCE_OFFLINE=1.
    notify: { topic: env.NTFY_TOPIC || '', dashboardUrl: env.DASHBOARD_URL || '', offline: env.FORCE_OFFLINE === '1' || env.NODE_ENV === 'test' || !!process.env.NODE_TEST_CONTEXT },
    profile,
    business: { ...profile.business, name: env.BUSINESS_NAME || profile.business.name, tz: env.BUSINESS_TZ || profile.business.tz },
    hours: profile.hours,
    calendarFeed: buildCalendarFeed(env, profile, env.BUSINESS_TZ || profile.business.tz, { calendarFetch }),
    serviceArea: profile.serviceArea, // null when customers come to the business and no area check is needed
    services: profile.services,
    wording: profile.wording,
    maxSteps: int(env.AGENT_MAX_STEPS, 8),
    maxConcurrentRuns: int(env.AGENT_MAX_CONCURRENT, 4),
    minLeadMinutes: 120, // earliest bookable visit is 2 hours out
    // Demo clock: follow-up delays are divided by this so a viewer can watch one fire.
    followupSpeedup: int(env.FOLLOWUP_SPEEDUP, 60),
    limits: {
      bodyBytes: '8kb',
      name: 80,
      message: 1000,
      phone: 24,
      maxLeads: int(env.MAX_LEADS, 300),
      leadRate: { windowMs: 60_000, max: int(env.RATE_LEADS_PER_MIN, 10) },
      replyRate: { windowMs: 60_000, max: int(env.RATE_REPLIES_PER_MIN, 30) },
      readRate: { windowMs: 60_000, max: int(env.RATE_READS_PER_MIN, 1200) },
      maxMessagesPerLead: 40,
      // Real inquiries: counted only when accepted. Per visitor (address + browser) and per address, per business profile.
      leadRateHour: { windowMs: 3_600_000, max: int(env.RATE_LEADS_PER_HOUR, 20) },
      leadIpHour: { windowMs: 3_600_000, max: int(env.RATE_LEADS_PER_IP_HOUR, 60) },
      // Demo scenario buttons have their own small allowance so they never use up the real-inquiry allowance.
      simRate: { windowMs: 60_000, max: int(env.RATE_SIM_PER_MIN, 10) },
      simRateHour: { windowMs: 3_600_000, max: int(env.RATE_SIM_PER_HOUR, 15) },
      replyRateHour: { windowMs: 3_600_000, max: int(env.RATE_REPLIES_PER_HOUR, 40) },
      resetRate: { windowMs: 3_600_000, max: int(env.RATE_RESETS_PER_HOUR, 3) },
      resetCooldownMs: 30_000,
      // Public-demo protection: bookings made by visitors are temporary and capped, so one visitor cannot fill the calendar.
      liveBookingTtlMs: int(env.LIVE_BOOKING_TTL_MINUTES, 30) * 60_000,
      maxLiveBookings: int(env.MAX_LIVE_BOOKINGS, 24),
      maxBookingsPerVisitor: int(env.MAX_BOOKINGS_PER_VISITOR, 3),
      // Emergency leads from the public form are flagged and handed off, not given a calendar hold, unless this is on.
      emergencyHolds: env.EMERGENCY_HOLDS === '1',
    },
    seedOnEmpty: env.SEED_ON_EMPTY !== '0',
    // Let visitors switch between the shipped example businesses (PROFILE_SWITCHER=0 turns the control off).
    profileSwitcher: env.PROFILE_SWITCHER !== '0',
    ...rest,
  };
  return cfg;
}
