// Small time zone helpers built on Intl (no dependencies). "Wall" values are milliseconds that, read as UTC, show the
// local clock time of a zone (so 10:00 in Chicago is Date.UTC(..., 10, 0) here). Instants are ordinary epoch milliseconds.
const cache = new Map();
function fmt(tz) {
  if (!cache.has(tz)) {
    cache.set(tz, new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }));
  }
  return cache.get(tz);
}

export function validTz(tz) {
  try { fmt(tz); return true; } catch { return false; }
}

/** Local clock of an instant in tz, as wall milliseconds. */
export function wallOf(ms, tz) {
  const p = {};
  for (const x of fmt(tz).formatToParts(new Date(Math.floor(ms / 1000) * 1000))) p[x.type] = x.value;
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
}

/** The instant at which the clock in tz shows this wall time (a time skipped by DST resolves to just after the gap). */
export function instantOf(wallMs, tz) {
  const t1 = wallMs - (wallOf(wallMs, tz) - wallMs);
  return wallMs - (wallOf(t1, tz) - t1);
}

const p2 = (n) => String(n).padStart(2, '0');
/** "2026-11-05T10:00" style business-local string for an instant. */
export function localString(ms, tz) {
  const d = new Date(wallOf(ms, tz));
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}T${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
}
/** "2026-11-05T10:00" (business-local) to an instant. */
export function instantOfLocal(local, tz) {
  const [d, t = '00:00'] = local.split('T');
  const [y, m, dd] = d.split('-').map(Number);
  const [h, mi] = t.split(':').map(Number);
  return instantOf(Date.UTC(y, m - 1, dd, h, mi), tz);
}
