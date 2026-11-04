// Read-only Google Calendar feed. Fetches a secret iCal address, parses VEVENTs and exposes busy time ranges.
// Safety rules enforced here: only https://calendar.google.com is ever fetched (redirects included), the response is
// size and time limited, and the address itself is never exposed: it lives in a private field, is never logged and never
// appears in an error message or status. Event titles and details are not even kept.
import { wallOf, instantOf, validTz } from './tz.js';

export const FEED_HOST = 'calendar.google.com';
export const MAX_BYTES = 2 * 1024 * 1024;
const DAY = 86_400_000;
const MAX_RAW_EVENTS = 20_000; // VEVENTs in the file at all
const MAX_EVENTS = 2000; // events that can matter for the window (recurring, or overlapping it)
const MAX_OCCURRENCES = 5000; // expanded busy blocks inside the window
const MAX_STEPS = 400_000; // cheap loop steps in total
const CPU_BUDGET_MS = 750;
export const STALE_MS = 15 * 60_000; // how long the last good read is still used after refreshes fail

export class FeedConfigError extends Error {}

/** Startup validation. Messages never contain the address. Returns the normalized URL string. */
export function validateFeedUrl(raw) {
  let u;
  try { u = new URL(String(raw).trim()); } catch { throw new FeedConfigError('CALENDAR_ICAL_URL is not a valid URL.'); }
  if (u.protocol !== 'https:') throw new FeedConfigError('CALENDAR_ICAL_URL must use https.');
  if (u.hostname !== FEED_HOST) throw new FeedConfigError(`CALENDAR_ICAL_URL host must be exactly ${FEED_HOST}.`);
  if (u.username || u.password) throw new FeedConfigError('CALENDAR_ICAL_URL must not contain a user name or password.');
  if (u.port && u.port !== '443') throw new FeedConfigError('CALENDAR_ICAL_URL must use the standard https port.');
  u.hash = '';
  return u.toString();
}

// ---------------------------------------------------------------- parsing
function unfold(text) { return text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/); }

// "NAME;P=V;P2=\"a;b\":value" -> { name, params, value }
function parseLine(line) {
  let i = 0; let inQ = false; let colon = -1;
  for (; i < line.length; i += 1) {
    const c = line[i];
    if (c === '"') inQ = !inQ;
    else if (c === ':' && !inQ) { colon = i; break; }
  }
  if (colon < 1) return null;
  const head = line.slice(0, colon); const value = line.slice(colon + 1);
  const parts = []; let cur = ''; inQ = false;
  for (const c of head) {
    if (c === '"') { inQ = !inQ; cur += c; } else if (c === ';' && !inQ) { parts.push(cur); cur = ''; } else cur += c;
  }
  parts.push(cur);
  const name = parts.shift().toUpperCase();
  const params = {};
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name, params, value };
}

const DT_RE = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/;

// Windows and legacy zone names that calendar programs (Outlook invitations) use, mapped to IANA names.
const TZ_ALIASES = {
  'eastern standard time': 'America/New_York', 'eastern daylight time': 'America/New_York', 'us/eastern': 'America/New_York', 'eastern time': 'America/New_York',
  'central standard time': 'America/Chicago', 'central daylight time': 'America/Chicago', 'us/central': 'America/Chicago', 'central time': 'America/Chicago',
  'mountain standard time': 'America/Denver', 'mountain daylight time': 'America/Denver', 'us/mountain': 'America/Denver', 'mountain time': 'America/Denver',
  'us mountain standard time': 'America/Phoenix', 'us/arizona': 'America/Phoenix',
  'pacific standard time': 'America/Los_Angeles', 'pacific daylight time': 'America/Los_Angeles', 'us/pacific': 'America/Los_Angeles', 'pacific time': 'America/Los_Angeles',
  'alaskan standard time': 'America/Anchorage', 'us/alaska': 'America/Anchorage', 'hawaiian standard time': 'Pacific/Honolulu', 'us/hawaii': 'Pacific/Honolulu',
  'utc': 'UTC', 'gmt': 'UTC', 'greenwich standard time': 'UTC', 'coordinated universal time': 'UTC',
};
function normTz(name) {
  const n = String(name).trim().replace(/^"|"$/g, '');
  const alias = TZ_ALIASES[n.toLowerCase()];
  if (alias) return alias;
  return validTz(n) ? n : null;
}

// Date-time value -> { kind: 'date'|'utc'|'zoned'|'floating'|'unknown', wall (ms read as UTC clock), tz }
function parseDt(value, params, defaultTz) {
  const m = DT_RE.exec(String(value).trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  const Y = Number(y); const M = Number(mo); const D = Number(d);
  if (M < 1 || M > 12 || D < 1 || D > 31 || Number(h || 0) > 23 || Number(mi || 0) > 59 || Number(s || 0) > 60) return null;
  const wall = Date.UTC(Y, M - 1, D, Number(h || 0), Number(mi || 0), Number(s || 0));
  if (new Date(wall).getUTCDate() !== D) return null;
  if (h === undefined || params.VALUE === 'DATE') return h === undefined ? { kind: 'date', wall, tz: defaultTz } : null;
  if (z) return { kind: 'utc', wall, tz: 'UTC' };
  if (params.TZID) {
    const tz = normTz(params.TZID);
    if (tz) return { kind: 'zoned', wall, tz };
    return { kind: 'unknown', wall, tz: defaultTz }; // unknown zone name: block both readings (business zone and UTC), and say so
  }
  return { kind: 'floating', wall, tz: defaultTz };
}
const toInstant = (dt) => (dt.kind === 'utc' ? dt.wall : instantOf(dt.wall, dt.tz));

function parseDuration(v) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(String(v).trim());
  if (!m || v.trim().replace(/^[+-]?P/, '') === '') return null;
  const [, sign, w, d, h, mi, s] = m;
  const ms = ((Number(w || 0) * 7 + Number(d || 0)) * 24 * 3600 + Number(h || 0) * 3600 + Number(mi || 0) * 60 + Number(s || 0)) * 1000;
  return sign === '-' ? -ms : ms;
}

const WD = { MO: 0, TU: 1, WE: 2, TH: 3, FR: 4, SA: 5, SU: 6 };
const KNOWN_BY = new Set(['FREQ', 'INTERVAL', 'COUNT', 'UNTIL', 'BYDAY', 'BYMONTHDAY', 'BYMONTH', 'WKST']);
const intList = (v, lo, hi) => {
  const out = [];
  for (const x of String(v).split(',')) { const n = Number(x); if (!Number.isInteger(n) || n === 0 || n < lo || n > hi) return null; out.push(n); }
  return out;
};
function parseRrule(v) {
  const r = {};
  for (const part of String(v).split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) r[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1);
  }
  const bad = { unsupported: true };
  if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(r.FREQ)) return bad;
  if (Object.keys(r).some((k) => !KNOWN_BY.has(k))) return bad; // BYSETPOS, BYHOUR, BYYEARDAY, ...
  const interval = r.INTERVAL === undefined ? 1 : Number(r.INTERVAL);
  if (!Number.isInteger(interval) || interval < 1 || interval > 1000) return bad;
  let count = null;
  if (r.COUNT !== undefined) { count = Number(r.COUNT); if (!Number.isInteger(count) || count < 1) return bad; }
  const out = { freq: r.FREQ, interval, count, until: r.UNTIL || null, byday: null, bymonthday: null, bymonth: null };
  if (r.BYDAY) {
    out.byday = [];
    for (const d of r.BYDAY.split(',')) {
      const m = /^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/i.exec(d.trim());
      if (!m) return bad;
      const ord = m[1] ? Number(m[1]) : 0;
      if (ord !== 0 && (r.FREQ === 'DAILY' || r.FREQ === 'WEEKLY' || Math.abs(ord) > 5)) return bad;
      out.byday.push({ ord, wd: WD[m[2].toUpperCase()] });
    }
  }
  if (r.BYMONTHDAY) { if (r.FREQ === 'DAILY' || r.FREQ === 'WEEKLY') return bad; out.bymonthday = intList(r.BYMONTHDAY, -31, 31); if (!out.bymonthday) return bad; }
  if (r.BYMONTH) { if (r.FREQ !== 'YEARLY') return bad; out.bymonth = intList(r.BYMONTH, 1, 12); if (!out.bymonth) return bad; }
  if (out.bymonthday && out.byday) return bad;
  return out;
}

// Wall-clock weekday, Monday = 0.
const wdOf = (wall) => (new Date(wall).getUTCDay() + 6) % 7;
const dim = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

// Days (1-based) of one month matching BYMONTHDAY / BYDAY (with optional ordinal) or, with neither, the series' own day.
function monthDays(y, m, rule, defaultDay) {
  const n = dim(y, m);
  const days = new Set();
  if (rule.bymonthday) for (const d of rule.bymonthday) { const x = d > 0 ? d : n + 1 + d; if (x >= 1 && x <= n) days.add(x); }
  else if (rule.byday) {
    for (const { ord, wd } of rule.byday) {
      const list = [];
      for (let d = 1; d <= n; d += 1) if (wdOf(Date.UTC(y, m, d)) === wd) list.push(d);
      if (ord === 0) list.forEach((d) => days.add(d));
      else { const x = ord > 0 ? list[ord - 1] : list[list.length + ord]; if (x) days.add(x); }
    }
  } else if (defaultDay <= n) days.add(defaultDay);
  return [...days].sort((a, b) => a - b);
}

function collectEvents(text) {
  const lines = unfold(text);
  const events = []; let cur = null; let sawCal = false; let depth = 0;
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line) continue;
    const u = line.toUpperCase();
    if (u === 'BEGIN:VCALENDAR') { sawCal = true; continue; }
    if (u === 'BEGIN:VEVENT') { if (cur === null) { cur = []; } depth += 1; continue; }
    if (u === 'END:VEVENT') { depth -= 1; if (depth <= 0 && cur) { events.push(cur); cur = null; depth = 0; } continue; }
    if (cur && depth === 1) { const p = parseLine(line); if (p) cur.push(p); }
    if (events.length > MAX_RAW_EVENTS) throw new Error('too_complex');
  }
  return { events, sawCal };
}

/**
 * Parse an iCal text into busy blocks (instants) inside [from, to].
 * Work is bounded: repeats jump straight to the window (no walking from an old DTSTART), and total steps, expanded
 * occurrences, relevant events and CPU time are capped; going over a cap throws Error('too_complex') so the app falls back
 * instead of freezing. Returns { blocks: [{start,end,allDay}], stats }. Throws Error('parse_error') or Error('too_complex').
 */
export function parseIcs(text, { tz, from, to, cpuMs = CPU_BUDGET_MS }) {
  if (typeof text !== 'string' || !/BEGIN:VCALENDAR/i.test(text)) throw new Error('parse_error');
  const deadline = Date.now() + cpuMs;
  const { events, sawCal } = collectEvents(text);
  if (!sawCal) throw new Error('parse_error');
  const stats = { events: 0, skipped: 0, unsupported: 0, warnings: 0 };
  const parsed = [];
  let relevant = 0;
  for (const props of events) {
    if (Date.now() > deadline) throw new Error('too_complex');
    const get = (n) => props.find((p) => p.name === n);
    const all = (n) => props.filter((p) => p.name === n);
    const status = (get('STATUS')?.value || '').trim().toUpperCase();
    const transp = (get('TRANSP')?.value || '').trim().toUpperCase();
    const ds = get('DTSTART');
    const start = ds ? parseDt(ds.value, ds.params, tz) : null;
    if (!start) { stats.skipped += 1; continue; }
    let end = null; let durMs = null;
    const de = get('DTEND'); const du = get('DURATION');
    if (de) { end = parseDt(de.value, de.params, tz); if (!end) { stats.skipped += 1; continue; } } else if (du) { durMs = parseDuration(du.value); if (durMs === null) { stats.skipped += 1; continue; } }
    const allDay = start.kind === 'date';
    const sI = toInstant(start);
    let len;
    if (end) len = toInstant(end) - sI; else if (durMs !== null) len = durMs; else len = allDay ? DAY : 0;
    if (!(len > 0)) { stats.skipped += 1; continue; } // zero or negative length: nothing to block
    stats.events += 1;
    const rr = get('RRULE');
    const rid = get('RECURRENCE-ID');
    // A single event far outside the window can never matter: skip it without further work.
    if (!rr && (sI + len < from - DAY || sI > to + DAY)) continue;
    relevant += 1;
    if (relevant > MAX_EVENTS) throw new Error('too_complex');
    let ridKey = null;
    if (rid) { const r = parseDt(rid.value, rid.params, tz); if (r) ridKey = r.kind === 'date' ? `D${r.wall}` : `I${toInstant(r)}`; }
    const ex = [];
    for (const e of all('EXDATE')) for (const v of e.value.split(',')) { const d = parseDt(v, e.params, start.tz); if (d) ex.push(d); }
    if (start.kind === 'unknown') stats.warnings += 1;
    parsed.push({
      uid: (get('UID')?.value || '').trim(), cancelled: status === 'CANCELLED', free: transp === 'TRANSPARENT',
      start, len, allDay, ridKey, rule: rr ? parseRrule(rr.value) : null, exdates: ex,
    });
  }
  if (events.length > 0 && stats.events === 0) throw new Error('parse_error');

  // Overridden instances of a recurring event are replaced by their own VEVENT (which may move, or be cancelled).
  const overridden = new Set(parsed.filter((e) => e.ridKey && e.uid).map((e) => `${e.uid}|${e.ridKey}`));
  const blocks = [];
  let steps = 0;
  const tick = () => {
    steps += 1;
    if (steps > MAX_STEPS) throw new Error('too_complex');
    if ((steps & 1023) === 0 && Date.now() > deadline) throw new Error('too_complex');
  };
  const push = (s, e, allDay) => {
    if (e > from && s < to) { if (blocks.length >= MAX_OCCURRENCES) throw new Error('too_complex'); blocks.push({ start: s, end: e, allDay }); }
  };

  for (const ev of parsed) {
    if (ev.cancelled || ev.free) continue;
    const { start } = ev;
    const wallLen = ev.allDay ? Math.round(ev.len / DAY) * DAY : null;
    const place = (wallStart) => {
      const s = start.kind === 'utc' ? wallStart : instantOf(wallStart, start.tz);
      const e = ev.allDay ? instantOf(wallStart + wallLen, start.tz) : s + ev.len;
      return [s, e];
    };
    const emit = (wallStart, checkMaster) => {
      const [s, e] = place(wallStart);
      if (checkMaster) {
        const day = wallStart - (((wallStart % DAY) + DAY) % DAY);
        const dateKey = `D${day}`;
        if (ev.uid && (overridden.has(`${ev.uid}|I${s}`) || overridden.has(`${ev.uid}|${dateKey}`))) return;
        if (ev.exdates.some((x) => (x.kind === 'date' ? `D${x.wall}` === dateKey : toInstant(x) === s || (x.kind !== 'utc' && x.wall === wallStart)))) return;
      }
      push(s, e, ev.allDay);
      if (start.kind === 'unknown') push(wallStart, wallStart + ev.len, false); // the same clock time read as UTC
    };
    const lowW = from - ev.len - 2 * DAY; // earliest occurrence start that can still reach the window (wall clocks differ from instants by under a day)
    const highW = to + 2 * DAY;
    const startWall = start.wall;

    const rule = ev.rule;
    if (!rule) { emit(startWall, false); continue; }
    if (rule.unsupported) { stats.unsupported += 1; emit(startWall, false); continue; }

    const { freq, interval, count, byday } = rule;
    let untilOk = () => true;
    if (rule.until) {
      const u = parseDt(rule.until, {}, start.tz);
      if (u) untilOk = u.kind === 'date' ? (w) => w < u.wall + DAY : u.kind === 'utc' ? (w) => (start.kind === 'utc' ? w : instantOf(w, start.tz)) <= u.wall : (w) => w <= u.wall;
    }
    let produced = 0;
    // Returns false when the series is over (count reached, past UNTIL).
    const take = (w) => {
      produced += 1;
      if (count !== null && produced > count) return false;
      if (!untilOk(w)) return false;
      if (w >= lowW) emit(w, true);
      return true;
    };
    const dayStart = startWall - (((startWall % DAY) + DAY) % DAY);
    const tod = startWall - dayStart;

    if (freq === 'DAILY') {
      const plainDays = byday ? byday.map((x) => x.wd) : null;
      const canJump = count === null || !plainDays;
      let k0 = 0;
      if (canJump && lowW > startWall) k0 = Math.max(0, Math.floor((lowW - startWall) / (interval * DAY)) - 1);
      if (count !== null && !plainDays) produced = k0;
      for (let k = k0; ; k += 1) {
        tick();
        const w = startWall + k * interval * DAY;
        if (w > highW) break;
        if (plainDays && !plainDays.includes(wdOf(w))) continue;
        if (!take(w)) break;
      }
    } else if (freq === 'WEEKLY') {
      const days = byday && byday.length ? [...new Set(byday.map((x) => x.wd))].sort((a, b) => a - b) : [wdOf(startWall)];
      const weekStart = dayStart - wdOf(startWall) * DAY;
      const s0 = days.filter((d) => weekStart + d * DAY + tod < startWall).length;
      let k0 = 0;
      if (lowW > weekStart) k0 = Math.max(0, Math.floor((lowW - weekStart) / (interval * 7 * DAY)) - 1);
      if (k0 > 0) produced = k0 * days.length - s0;
      outer: for (let k = k0; ; k += 1) {
        tick();
        const wk = weekStart + k * interval * 7 * DAY;
        if (wk > highW) break;
        for (const d of days) {
          const w = wk + d * DAY + tod;
          if (w < startWall) continue;
          if (!take(w)) break outer;
        }
      }
    } else { // MONTHLY and YEARLY
      const sd = new Date(startWall);
      const y0 = sd.getUTCFullYear(); const m0 = sd.getUTCMonth(); const d0 = sd.getUTCDate();
      const yearly = freq === 'YEARLY';
      const step = yearly ? 12 * interval : interval; // in months
      const base = y0 * 12 + m0;
      const lowD = new Date(Math.max(lowW, startWall));
      const lowIdx = lowD.getUTCFullYear() * 12 + lowD.getUTCMonth();
      let k0 = 0;
      if (count === null && lowIdx > base) k0 = Math.max(0, Math.floor((lowIdx - base) / step) - 1);
      outer2: for (let k = k0; ; k += 1) {
        tick();
        const idx = base + k * step;
        const y = Math.floor(idx / 12); const mo = ((idx % 12) + 12) % 12;
        if (Date.UTC(y, mo, 1) > highW) break;
        const months = yearly ? (rule.bymonth ? [...new Set(rule.bymonth.map((x) => x - 1))].sort((a, b) => a - b) : [m0]) : [mo];
        for (const mm of months) {
          for (const d of monthDays(y, mm, rule, d0)) {
            const w = Date.UTC(y, mm, d) + tod;
            if (w < startWall) continue;
            if (!take(w)) break outer2;
          }
        }
      }
    }
  }
  blocks.sort((a, b) => a.start - b.start);
  return { blocks, stats };
}

// ---------------------------------------------------------------- the feed
export class CalendarFeed {
  #url;

  constructor({ url, profile, tz, fetchImpl = globalThis.fetch, ttlMs = 60_000, failTtlMs = 30_000, timeoutMs = 5000, maxBytes = MAX_BYTES }) {
    this.#url = validateFeedUrl(url);
    this.profile = profile;
    this.tz = tz;
    this.fetchImpl = fetchImpl;
    this.ttlMs = ttlMs; this.failTtlMs = failTtlMs; this.timeoutMs = timeoutMs; this.maxBytes = maxBytes;
    this.blocks = [];
    this.connected = false; this.stale = false; this.lastOk = null; this.lastError = null; this.eventsLoaded = 0; this.unsupportedRules = 0; this.warnings = 0;
    this.window = null; this.lastNow = 0;
    this.checkedAt = -Infinity; this.inflight = null;
  }

  // Never print the address, even if an object holding the feed is logged or serialized.
  toJSON() { return { profile: this.profile, connected: this.connected }; }
  [Symbol.for('nodejs.util.inspect.custom')]() { return `CalendarFeed{profile:${this.profile},connected:${this.connected}}`; }

  appliesTo(profileId) { return profileId === this.profile; }

  status() {
    return {
      configured: true, connected: this.connected, stale: this.connected && this.stale,
      staleMinutes: this.connected && this.stale && this.lastOk ? Math.max(1, Math.round((this.lastNow - this.lastOk) / 60_000)) : 0,
      lastOk: this.lastOk ? new Date(this.lastOk).toISOString() : null, lastError: this.lastError, eventsLoaded: this.eventsLoaded,
      unsupportedRules: this.unsupportedRules, warnings: this.warnings,
    };
  }

  /** Does the loaded data cover this whole time range? Outside it the calendar has NOT been checked. */
  covers(fromMs, toMs) { return !!this.window && fromMs >= this.window.from && toMs <= this.window.to; }

  /** Refresh when the cache is stale (60 s after success, 30 s after a failure). Never throws; failures set lastError. */
  async ensureFresh(nowMs = Date.now()) {
    const ttl = this.connected && !this.stale ? this.ttlMs : this.failTtlMs;
    this.lastNow = Math.max(this.lastNow, nowMs);
    if (nowMs - this.checkedAt < ttl && nowMs >= this.checkedAt) return this.status();
    if (!this.inflight) {
      this.inflight = this.#load(nowMs).finally(() => { this.inflight = null; });
    }
    await this.inflight;
    return this.status();
  }

  async #load(nowMs) {
    this.checkedAt = nowMs;
    try {
      const text = await this.#fetchText();
      const from = nowMs - 14 * DAY; const to = nowMs + 120 * DAY;
      const { blocks, stats } = parseIcs(text, { tz: this.tz, from, to });
      this.blocks = mergeBlocks(blocks);
      this.window = { from, to };
      this.connected = true; this.stale = false; this.lastOk = nowMs; this.lastError = null; this.eventsLoaded = stats.events; this.unsupportedRules = stats.unsupported; this.warnings = stats.warnings;
    } catch (e) {
      this.lastError = FEED_ERRORS.has(e?.message) ? e.message : e?.name === 'AbortError' ? 'timeout' : 'network';
      if (this.connected && this.lastOk !== null && nowMs - this.lastOk <= STALE_MS) {
        this.stale = true; // keep serving the last good read for a while, and say so everywhere
      } else {
        this.blocks = []; this.window = null; this.connected = false; this.stale = false; this.eventsLoaded = 0; this.unsupportedRules = 0; this.warnings = 0;
      }
    }
  }

  async #fetchText() {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      let url = this.#url;
      for (let hop = 0; hop < 4; hop += 1) {
        let res;
        try { res = await this.fetchImpl(url, { redirect: 'manual', signal: ctl.signal, headers: { accept: 'text/calendar, text/plain;q=0.5' } }); } catch (e) {
          throw new Error(e?.name === 'AbortError' || ctl.signal.aborted ? 'timeout' : 'network');
        }
        if (res.status >= 300 && res.status < 400) {
          const loc = res.headers?.get?.('location');
          try { res.body?.cancel?.(); } catch { /* ignore */ }
          let next;
          try { next = new URL(loc, url); } catch { throw new Error('bad_redirect'); }
          if (next.protocol !== 'https:' || next.hostname !== FEED_HOST || next.username || next.password) throw new Error('bad_redirect');
          url = next.toString();
          continue;
        }
        if (res.status !== 200) { try { res.body?.cancel?.(); } catch { /* ignore */ } throw new Error('http_error'); }
        const len = Number(res.headers?.get?.('content-length'));
        if (Number.isFinite(len) && len > this.maxBytes) { try { res.body?.cancel?.(); } catch { /* ignore */ } throw new Error('too_large'); }
        return await this.#readBody(res, ctl);
      }
      throw new Error('bad_redirect');
    } finally { clearTimeout(timer); }
  }

  async #readBody(res, ctl) {
    try {
      if (res.body?.getReader) {
        const reader = res.body.getReader(); const chunks = []; let total = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > this.maxBytes) { try { await reader.cancel(); } catch { /* ignore */ } throw new Error('too_large'); }
          chunks.push(value);
        }
        return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
      }
      const t = await res.text();
      if (Buffer.byteLength(t) > this.maxBytes) throw new Error('too_large');
      return t;
    } catch (e) {
      if (e?.message === 'too_large') throw e;
      throw new Error(ctl.signal.aborted ? 'timeout' : 'network');
    }
  }

  /** Busy blocks (instants) overlapping [from, to). Empty unless connected. */
  busyBetween(from, to) {
    if (!this.connected) return [];
    return this.blocks.filter((b) => b.end > from && b.start < to);
  }

  isBusy(from, to) { return this.busyBetween(from, to).length > 0; }
}

const FEED_ERRORS = new Set(['timeout', 'network', 'http_error', 'bad_redirect', 'too_large', 'parse_error', 'too_complex']);

function mergeBlocks(blocks) {
  const out = [];
  for (const b of [...blocks].sort((a, c) => a.start - c.start)) {
    const last = out[out.length - 1];
    if (last && b.start <= last.end) { last.end = Math.max(last.end, b.end); last.allDay = last.allDay && b.allDay; } else out.push({ ...b });
  }
  return out;
}

export { wallOf };
