// The app's own calendar. All slot ids are business-local wall time ("2026-11-05T10:00"),
// so no timezone arithmetic is needed after we convert "now" once.
import { instantOfLocal, wallOf } from './tz.js';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const SLOT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:00$/;
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function localNow(ms, tz) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const g = (t) => parts.find((p) => p.type === t).value;
  return `${g('year')}-${g('month')}-${g('day')}T${g('hour')}:${g('minute')}`;
}

const minutes = (local) => {
  const [d, t = '00:00'] = local.split('T');
  const [y, m, dd] = d.split('-').map(Number);
  const [h, mi] = t.split(':').map(Number);
  return Date.UTC(y, m - 1, dd, h, mi) / 60000;
};

export const dateOf = (id) => id.slice(0, 10);
export const timeOf = (id) => id.slice(11, 16);
export function dow(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
export function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
export function mondayOf(date) {
  const w = dow(date);
  return addDays(date, w === 0 ? -6 : 1 - w);
}
export function isValidDate(s) {
  if (!DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function fmtTime(hhmm) {
  let [h, m] = hhmm.split(':').map(Number);
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return m ? `${h}:${String(m).padStart(2, '0')} ${ap}` : `${h}:00 ${ap}`;
}
export const fmtClock = fmtTime;
export const endTime = (start, hours) => `${String(Number(start.slice(0, 2)) + hours).padStart(2, '0')}:${start.slice(3, 5)}`;

export function dateLabel(date, long = false) {
  const [y, m, d] = date.split('-').map(Number);
  return `${long ? ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][dow(date)] : DAYS[dow(date)]}, ${MONTHS[m - 1]} ${d}`;
}

export function slotLabel(id, hours = 2) {
  const t = timeOf(id);
  return `${dateLabel(dateOf(id))}, ${fmtTime(t)}-${fmtTime(endTime(t, hours))}`;
}

export function slotsForDate(date, hoursCfg) {
  const list = hoursCfg.starts[dow(date)] || [];
  return list.map((t) => `${date}T${t}`);
}

export function isOpenNow(nowLocalStr, hoursCfg) {
  const date = dateOf(nowLocalStr);
  const w = hoursCfg.open[dow(date)];
  if (!w) return false;
  const t = timeOf(nowLocalStr);
  return t >= w[0] && t < w[1];
}

// Is this a valid slot of the demo calendar (a valid start time on a working day)?
export function isRealSlot(id, hoursCfg) {
  if (typeof id !== 'string' || !SLOT_RE.test(id) || !isValidDate(dateOf(id))) return false;
  return slotsForDate(dateOf(id), hoursCfg).includes(id);
}

export function isBookableNow(id, nowLocalStr, cfg) {
  return minutes(id) - minutes(nowLocalStr) >= cfg.minLeadMinutes;
}

// The connected Google Calendar feed applies to ONE profile only; every other profile keeps its demo calendar.
export const feedFor = (cfg) => (cfg.calendarFeed && cfg.calendarFeed.appliesTo(cfg.profile.id) ? cfg.calendarFeed : null);
export const connectedFeed = (cfg) => { const f = feedFor(cfg); return f && f.connected ? f : null; };
export const CALENDAR_LABELS = { google: 'Connected Google Calendar (read-only)', demo: 'Demo calendar' };
export const calendarSource = (cfg) => (connectedFeed(cfg) ? 'google' : 'demo');

/** Does the connected feed have something busy during this slot? (false for the demo calendar) */
export function slotIsBusy(id, cfg) {
  const feed = connectedFeed(cfg);
  if (!feed) return false;
  const s = instantOfLocal(id, cfg.business.tz);
  return feed.isBusy(s, s + cfg.hours.windowHours * 3_600_000);
}

/** Busy blocks of the connected feed on one date, clipped to that day, as local HH:MM. Titles are never included. */
export function busyOnDate(date, cfg) {
  const feed = connectedFeed(cfg);
  if (!feed) return [];
  const tz = cfg.business.tz;
  const d0 = instantOfLocal(`${date}T00:00`, tz);
  const d1 = instantOfLocal(`${addDays(date, 1)}T00:00`, tz);
  const hhmm = (ms) => { const w = new Date(wallOf(ms, tz)); return `${String(w.getUTCHours()).padStart(2, '0')}:${String(w.getUTCMinutes()).padStart(2, '0')}`; };
  return feed.busyBetween(d0, d1).map((b) => {
    const s = Math.max(b.start, d0); const e = Math.min(b.end, d1);
    return { start: hhmm(s), end: e >= d1 ? '24:00' : hhmm(e), allDay: s <= d0 && e >= d1 };
  });
}

// Status of every slot in a date range, using the actual booking store.
export function listSlots(store, cfg, nowMs, fromDate, days) {
  const nowL = localNow(nowMs, cfg.business.tz);
  const out = [];
  for (let i = 0; i < days; i += 1) {
    const date = addDays(fromDate, i);
    for (const id of slotsForDate(date, cfg.hours)) {
      const booking = store.bookingForSlot(id);
      let status = 'open';
      if (booking) status = 'booked';
      else if (!isBookableNow(id, nowL, cfg)) status = 'past';
      else if (slotIsBusy(id, cfg)) status = 'busy';
      out.push({
        slot_id: id, date, start: timeOf(id), end: endTime(timeOf(id), cfg.hours.windowHours),
        label: slotLabel(id, cfg.hours.windowHours), status, booking: booking || null,
      });
    }
  }
  return out;
}

export function openSlots(store, cfg, nowMs, fromDate, days, limit) {
  const nowL = localNow(nowMs, cfg.business.tz);
  const start = fromDate && fromDate > dateOf(nowL) ? fromDate : dateOf(nowL);
  return listSlots(store, cfg, nowMs, start, days).filter((s) => s.status === 'open').slice(0, limit);
}
