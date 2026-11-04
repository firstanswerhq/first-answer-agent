// Read-only Google Calendar feed. Fetches a secret iCal address, parses VEVENTs and exposes busy time ranges.
// Safety rules enforced here: only https://calendar.google.com is ever fetched (redirects included), the response is
// size and time limited, and the address itself is never exposed: it lives in a private field, is never logged and never
// appears in an error message or status. Event titles and details are not even kept.
import { wallOf, instantOf, validTz } from './tz.js';

export const FEED_HOST = 'calendar.google.com';
export const MAX_BYTES = 2 * 1024 * 1024;
const DAY = 86_400_000;
const MAX_EVENTS = 5000;
const MAX_BLOCKS = 20_000;
const MAX_ITER = 4000;

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

// Date-time value -> { kind: 'date'|'utc'|'zoned'|'floating', wall (ms read as UTC clock), tz }
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
    const tz = params.TZID;
    if (validTz(tz)) return { kind: 'zoned', wall, tz };
    return { kind: 'floating', wall, tz: defaultTz }; // unknown zone name: treat as the business zone rather than guess
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
function parseRrule(v) {
  const r = {};
  for (const part of String(v).split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) r[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1);
  }
  if (!['DAILY', 'WEEKLY'].includes(r.FREQ)) return { unsupported: true };
  const interval = r.INTERVAL === undefined ? 1 : Number(r.INTERVAL);
  if (!Number.isInteger(interval) || interval < 1 || interval > 1000) return { unsupported: true };
  let count = null;
  if (r.COUNT !== undefined) { count = Number(r.COUNT); if (!Number.isInteger(count) || count < 1) return { unsupported: true }; }
  let byday = null;
  if (r.BYDAY) {
    byday = [];
    for (const d of r.BYDAY.split(',')) {
      if (!(d.toUpperCase() in WD)) return { unsupported: true }; // numeric prefixes such as 2MO are not supported
      byday.push(WD[d.toUpperCase()]);
    }
  }
  return { freq: r.FREQ, interval, count, until: r.UNTIL || null, byday };
}

// Wall-clock weekday, Monday = 0.
const wdOf = (wall) => (new Date(wall).getUTCDay() + 6) % 7;

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
    if (events.length > MAX_EVENTS) break;
  }
  return { events, sawCal, unterminated: cur !== null };
}

/**
 * Parse an iCal text into busy blocks (instants) inside the window.
 * Returns { blocks: [{start,end,allDay}], stats: { events, skipped, unsupported } }. Throws Error('parse_error').
 */
export function parseIcs(text, { tz, from, to }) {
  if (typeof text !== 'string' || !/BEGIN:VCALENDAR/i.test(text)) throw new Error('parse_error');
  const { events, sawCal } = collectEvents(text);
  if (!sawCal) throw new Error('parse_error');
  const stats = { events: 0, skipped: 0, unsupported: 0 };
  const parsed = [];
  for (const props of events) {
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
    const rid = get('RECURRENCE-ID');
    let ridKey = null;
    if (rid) { const r = parseDt(rid.value, rid.params, tz); if (r) ridKey = r.kind === 'date' ? `D${r.wall}` : `I${toInstant(r)}`; }
    const rr = get('RRULE');
    const ex = [];
    for (const e of all('EXDATE')) for (const v of e.value.split(',')) { const d = parseDt(v, e.params, start.tz); if (d) ex.push(d); }
    parsed.push({
      uid: (get('UID')?.value || '').trim(), cancelled: status === 'CANCELLED', free: transp === 'TRANSPARENT',
      start, len, allDay, ridKey, rule: rr ? parseRrule(rr.value) : null, exdates: ex,
    });
    stats.events += 1;
  }
  if (events.length > 0 && parsed.length === 0) throw new Error('parse_error');

  // Overridden instances of a recurring event are replaced by their own VEVENT (which may move, or be cancelled).
  const overridden = new Set(parsed.filter((e) => e.ridKey && e.uid).map((e) => `${e.uid}|${e.ridKey}`));
  const blocks = [];
  const push = (s, e, allDay) => { if (e > from && s < to && blocks.length < MAX_BLOCKS) blocks.push({ start: s, end: e, allDay }); };

  for (const ev of parsed) {
    if (ev.cancelled || ev.free) continue;
    const { start } = ev;
    const sI = toInstant(start);
    const wallLen = ev.allDay ? Math.round(ev.len / DAY) * DAY : null;
    const emit = (wallStart) => {
      const s = start.kind === 'utc' ? wallStart : instantOf(wallStart, start.tz);
      const e = ev.allDay ? instantOf(wallStart + wallLen, start.tz) : s + ev.len;
      const dateKey = `D${Date.UTC(new Date(wallStart).getUTCFullYear(), new Date(wallStart).getUTCMonth(), new Date(wallStart).getUTCDate())}`;
      if (ev.uid && (overridden.has(`${ev.uid}|I${s}`) || overridden.has(`${ev.uid}|${dateKey}`))) return;
      if (ev.exdates.some((x) => (x.kind === 'date' ? `D${x.wall}` === dateKey : toInstant(x) === s || (x.kind !== 'utc' && x.wall === wallStart)))) return;
      push(s, e, ev.allDay);
    };
    if (!ev.rule) { push(sI, ev.allDay ? instantOf(start.wall + wallLen, start.tz) : sI + ev.len, ev.allDay); continue; }
    if (ev.rule.unsupported) { stats.unsupported += 1; push(sI, ev.allDay ? instantOf(start.wall + wallLen, start.tz) : sI + ev.len, ev.allDay); continue; }

    const { freq, interval, count, byday } = ev.rule;
    let untilCheck = () => true;
    if (ev.rule.until) {
      const u = parseDt(ev.rule.until, {}, start.tz);
      if (u) untilCheck = u.kind === 'date' ? (w) => w < u.wall + DAY : u.kind === 'utc' ? (w) => (start.kind === 'utc' ? w : instantOf(w, start.tz)) <= u.wall : (w) => w <= u.wall;
    }
    const startWall = start.wall;
    const dayWall = startWall - (startWall % DAY); // midnight of the start day (wall)
    const timeOfDay = startWall - dayWall;
    let produced = 0; let iter = 0;
    const horizon = to + 2 * DAY;
    const emitIf = (w) => { // w = occurrence wall start. Returns false when the series has ended.
      if (!untilCheck(w)) return false;
      produced += 1;
      if (count !== null && produced > count) return false;
      emit(w);
      return true;
    };
    const past = (w) => (start.kind === 'utc' ? w : instantOf(w, start.tz)) > horizon;
    if (freq === 'DAILY') {
      for (let k = 0; iter < MAX_ITER; k += 1, iter += 1) {
        const w = startWall + k * interval * DAY;
        if (past(w)) break;
        if (byday && !byday.includes(wdOf(w))) { continue; } // BYDAY on DAILY filters; COUNT counts kept days only
        if (!emitIf(w)) break;
      }
    } else {
      const days = byday && byday.length ? [...new Set(byday)].sort((a, b) => a - b) : [wdOf(startWall)];
      const weekStart = dayWall - wdOf(startWall) * DAY; // Monday of the first week
      outer: for (let k = 0; iter < MAX_ITER; k += 1, iter += 1) {
        const wk = weekStart + k * interval * 7 * DAY;
        if (past(wk)) break;
        for (const d of days) {
          const w = wk + d * DAY + timeOfDay;
          if (w < startWall) continue;
          if (!emitIf(w)) break outer;
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
    this.connected = false; this.lastOk = null; this.lastError = null; this.eventsLoaded = 0; this.unsupportedRules = 0;
    this.checkedAt = -Infinity; this.inflight = null;
  }

  // Never print the address, even if an object holding the feed is logged or serialized.
  toJSON() { return { profile: this.profile, connected: this.connected }; }
  [Symbol.for('nodejs.util.inspect.custom')]() { return `CalendarFeed{profile:${this.profile},connected:${this.connected}}`; }

  appliesTo(profileId) { return profileId === this.profile; }

  status() {
    return { configured: true, connected: this.connected, lastOk: this.lastOk ? new Date(this.lastOk).toISOString() : null, lastError: this.lastError, eventsLoaded: this.eventsLoaded, unsupportedRules: this.unsupportedRules };
  }

  /** Refresh when the cache is stale (60 s after success, 30 s after a failure). Never throws; failures set lastError. */
  async ensureFresh(nowMs = Date.now()) {
    const ttl = this.connected ? this.ttlMs : this.failTtlMs;
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
      const { blocks, stats } = parseIcs(text, { tz: this.tz, from: nowMs - 14 * DAY, to: nowMs + 120 * DAY });
      this.blocks = mergeBlocks(blocks);
      this.rawBlockCount = blocks.length;
      this.connected = true; this.lastOk = nowMs; this.lastError = null; this.eventsLoaded = stats.events; this.unsupportedRules = stats.unsupported;
    } catch (e) {
      this.blocks = []; this.connected = false; this.eventsLoaded = 0; this.unsupportedRules = 0;
      this.lastError = FEED_ERRORS.has(e?.message) ? e.message : e?.name === 'AbortError' ? 'timeout' : 'network';
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

const FEED_ERRORS = new Set(['timeout', 'network', 'http_error', 'bad_redirect', 'too_large', 'parse_error']);

function mergeBlocks(blocks) {
  const out = [];
  for (const b of [...blocks].sort((a, c) => a.start - c.start)) {
    const last = out[out.length - 1];
    if (last && b.start <= last.end) { last.end = Math.max(last.end, b.end); last.allDay = last.allDay && b.allDay; } else out.push({ ...b });
  }
  return out;
}

export { wallOf };
