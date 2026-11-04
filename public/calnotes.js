// Calendar page header pieces for the connected Google Calendar (badge, notices, legend). Pure functions so they can be
// tested without a browser. Each returns finished HTML (already escaped); the caller inserts it with R().
import { esc } from './tpl.js';

export function calendarBadge(c) {
  const k = c?.calendar;
  if (!k?.connected) return '';
  return k.stale
    ? `<span class="badge" id="calBadge">Connected: Google Calendar (read-only), last updated ${esc(k.staleMinutes)} min ago</span>`
    : '<span class="badge" id="calBadge">Connected: Google Calendar (read-only)</span>';
}

export function calendarNotices(c) {
  const k = c?.calendar;
  if (!k?.configured) return '';
  const out = [];
  if (!k.connected) out.push(`<div class="note" id="calNotice" role="status"><strong>Demo calendar in use.</strong> ${esc(k.notice || '')}</div>`);
  else if (k.stale) out.push(`<div class="note" id="calStale" role="status"><strong>Showing older calendar data.</strong> Google Calendar could not be refreshed just now, so this page uses what it read ${esc(k.staleMinutes)} min ago.</div>`);
  if (k.connected && k.unsupportedRules > 0) out.push('<div class="note" id="calUnsupported" role="status">Some repeating events in the connected calendar are not supported and may not block time.</div>');
  if (k.connected && k.warnings > 0) out.push('<div class="note" id="calWarn" role="status">Some events could not be read exactly (for example an unknown time zone), so extra time may be blocked to be safe.</div>');
  return out.join('');
}

export function calendarLegend(c) {
  return c?.calendar?.connected ? '<span style="color:#b3b8cc">● Busy (Google Calendar, titles hidden)</span>' : '';
}
