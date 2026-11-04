// Central configuration. Everything a business owner would tune lives here:
// hours, service area and the price book. Secrets come only from the environment.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const int = (v, d) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};

export const VERSION = '1.0.0';

export const JOB_TYPES = {
  roof_leak: { label: 'Roof leak repair', group: 'roof' },
  roof_repair: { label: 'Roof repair', group: 'roof' },
  roof_replacement: { label: 'Roof replacement estimate', group: 'roof' },
  gutter_cleaning: { label: 'Gutter cleaning', group: 'roof' },
  gutter_repair: { label: 'Gutter repair', group: 'roof' },
  house_cleaning: { label: 'House cleaning', group: 'clean' },
  deep_cleaning: { label: 'Deep cleaning', group: 'clean' },
  move_out_cleaning: { label: 'Move-out cleaning', group: 'clean' },
  plumbing_leak: { label: 'Plumbing leak', group: 'plumb' },
  drain_clog: { label: 'Drain clog', group: 'plumb' },
  water_heater: { label: 'Water heater', group: 'plumb' },
  other: { label: 'Unclassified job', group: 'other' },
};

// Dollar ranges per job size. A null entry means "no quote by the agent":
// it offers a free on-site estimate instead.
const r = (low, high) => ({ low, high });
export const PRICE_BOOK = {
  roof_leak: { small: r(250, 450), medium: r(450, 900), large: r(900, 1800) },
  roof_repair: { small: r(300, 700), medium: r(700, 1500), large: r(1500, 3500) },
  roof_replacement: null,
  gutter_cleaning: { small: r(120, 170), medium: r(170, 250), large: r(250, 380) },
  gutter_repair: { small: r(150, 300), medium: r(300, 600), large: r(600, 1100) },
  house_cleaning: { small: r(110, 150), medium: r(150, 220), large: r(220, 320) },
  deep_cleaning: { small: r(180, 260), medium: r(260, 380), large: r(380, 560) },
  move_out_cleaning: { small: r(200, 290), medium: r(290, 420), large: r(420, 620) },
  plumbing_leak: { small: r(150, 300), medium: r(300, 600), large: r(600, 1200) },
  drain_clog: { small: r(120, 200), medium: r(200, 350), large: r(350, 600) },
  water_heater: { small: r(900, 1400), medium: r(900, 1400), large: r(1400, 2200) },
  other: null,
};

export const SERVICE_AREA = {
  cities: [
    'Nashville', 'East Nashville', 'Brentwood', 'Franklin', 'Hendersonville', 'Murfreesboro', 'Antioch',
    'Madison', 'Donelson', 'Hermitage', 'Goodlettsville', 'Mt. Juliet', 'Mount Juliet', 'Smyrna', 'Gallatin',
    'Green Hills', 'The Gulch', 'Sylvan Park', 'Germantown', 'Bellevue', 'Belle Meade', 'Inglewood',
    'Berry Hill', 'Oak Hill', 'Nolensville', 'Old Hickory', 'Joelton',
  ],
  zips: [
    ...Array.from({ length: 21 }, (_, i) => String(37201 + i)),
    '37027', '37064', '37067', '37069', '37075', '37072', '37076', '37115', '37116', '37122', '37127',
    '37128', '37129', '37130', '37132', '37013', '37167', '37066', '37135', '37138', '37189',
  ],
  // Cities we recognize as outside the area, so the agent can say so politely.
  outside: ['Memphis', 'Knoxville', 'Chattanooga', 'Atlanta', 'Louisville', 'Birmingham', 'Huntsville', 'Clarksville', 'Jackson', 'Bowling Green'],
};

// Visit windows are two hours long. Keys are weekday numbers (0 = Sunday).
export const HOURS = {
  starts: { 1: ['08:00', '10:00', '13:00', '15:00'], 2: ['08:00', '10:00', '13:00', '15:00'], 3: ['08:00', '10:00', '13:00', '15:00'], 4: ['08:00', '10:00', '13:00', '15:00'], 5: ['08:00', '10:00', '13:00', '15:00'], 6: ['09:00', '11:00'] },
  open: { 1: ['08:00', '17:00'], 2: ['08:00', '17:00'], 3: ['08:00', '17:00'], 4: ['08:00', '17:00'], 5: ['08:00', '17:00'], 6: ['09:00', '13:00'] },
  windowHours: 2,
  text: 'Mon-Fri 8 AM-5 PM, Sat 9 AM-1 PM Central',
};

export function loadConfig(env = process.env, over = {}) {
  const cfg = {
    port: int(env.PORT, 3000),
    host: env.HOST || '0.0.0.0',
    root,
    dataFile: env.DATA_FILE === '' ? null : env.DATA_FILE || path.join(root, 'data', 'state.json'),
    inference: {
      key: env.VULTR_INFERENCE_KEY || '',
      url: (env.VULTR_INFERENCE_URL || 'https://api.vultrinference.com/v1').replace(/\/+$/, ''),
      model: env.VULTR_INFERENCE_MODEL || 'glm-5.3-flash',
      timeoutMs: int(env.INFERENCE_TIMEOUT_MS, 20000),
      retries: int(env.INFERENCE_RETRIES, 2),
      maxRunsPerHour: int(env.INFERENCE_MAX_RUNS_PER_HOUR, 120),
    },
    forceOffline: env.FORCE_OFFLINE === '1',
    business: {
      name: env.BUSINESS_NAME || 'Harbor Lane Home Services',
      phone: '(615) 555-0100',
      tz: env.BUSINESS_TZ || 'America/Chicago',
    },
    hours: HOURS,
    serviceArea: SERVICE_AREA,
    priceBook: PRICE_BOOK,
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
      readRate: { windowMs: 60_000, max: int(env.RATE_READS_PER_MIN, 300) },
      maxMessagesPerLead: 40,
    },
    seedOnEmpty: env.SEED_ON_EMPTY !== '0',
    ...over,
  };
  return cfg;
}
