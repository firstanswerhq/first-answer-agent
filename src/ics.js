// "Add to my calendar" for customers: a one-event RFC 5545 file and a Google Calendar link for a booked demo appointment.
// Only public, non-private facts go in: service, business, time, optional business address. Never the customer's name,
// phone or message. All text is escaped and stripped of line breaks, so customer-controlled text cannot add properties.
import { instantOfLocal } from './tz.js';

const HOUR = 3_600_000;
const p2 = (n) => String(n).padStart(2, '0');
export function utcStamp(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}T${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}${p2(d.getUTCSeconds())}Z`;
}

// Remove every character that any parser might treat as a line break or control, keeping printable text.
// eslint-disable-next-line no-control-regex
const cleanLine = (v) => String(v ?? '').replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
export const escapeText = (v) => cleanLine(v).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,');
// DESCRIPTION may hold real line breaks: they become the two characters \n (never a raw CR or LF).
const escapeBlock = (lines) => lines.map(escapeText).join('\\n');

// Fold to 75 octets per line (UTF-8 safe), continuation lines start with one space.
export function fold(line) {
  const out = []; let cur = ''; let bytes = 0; let limit = 75;
  for (const ch of line) {
    const n = Buffer.byteLength(ch);
    if (bytes + n > limit) { out.push(cur); cur = ' '; bytes = 1; limit = 75; }
    cur += ch; bytes += n;
  }
  out.push(cur);
  return out.join('\r\n');
}

/** Details of a booked appointment for the calendar file and link. */
export function appointmentFacts(booking, config) {
  const startMs = instantOfLocal(booking.slot_id, config.business.tz);
  const endMs = startMs + config.hours.windowHours * HOUR;
  const service = cleanLine(booking.serviceLabel) || 'Appointment';
  const business = cleanLine(config.business.name);
  return {
    uid: `${cleanLine(booking.id).replace(/[^A-Za-z0-9-]/g, '')}@first-answer-agent`,
    startMs, endMs, summary: `${service} at ${business}`, location: cleanLine(config.business.address || ''),
    description: ['Demo booking.', 'This is a demonstration appointment from the First Answer Agent demo. Nothing real was scheduled.'],
  };
}

export function buildIcs(booking, config, nowMs) {
  const f = appointmentFacts(booking, config);
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//First Answer Agent//Demo booking//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${f.uid}`, `DTSTAMP:${utcStamp(nowMs)}`, `DTSTART:${utcStamp(f.startMs)}`, `DTEND:${utcStamp(f.endMs)}`,
    `SUMMARY:${escapeText(f.summary)}`,
    ...(f.location ? [`LOCATION:${escapeText(f.location)}`] : []),
    `DESCRIPTION:${escapeBlock(f.description)}`,
    'STATUS:CONFIRMED', 'TRANSP:OPAQUE',
    'END:VEVENT', 'END:VCALENDAR',
  ];
  return lines.map(fold).join('\r\n') + '\r\n';
}

export function googleCalendarUrl(booking, config) {
  const f = appointmentFacts(booking, config);
  const q = [['action', 'TEMPLATE'], ['text', f.summary], ['dates', `${utcStamp(f.startMs)}/${utcStamp(f.endMs)}`], ['details', f.description.join(' ')], ...(f.location ? [['location', f.location]] : [])];
  return 'https://calendar.google.com/calendar/render?' + q.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
}
