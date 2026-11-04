// Outbound time validation: every concrete time the model offers must be an open slot at that moment.
// Pure: the caller supplies today's date, a function that lists the open start times on a date, and a short list of real open times.
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYNAMES = [['sun', 'sunday'], ['mon', 'monday'], ['tue', 'tues', 'tuesday'], ['wed', 'wednesday'], ['thu', 'thur', 'thurs', 'thursday'], ['fri', 'friday'], ['sat', 'saturday']];
const DAY_RE = '(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tues?|wed|thurs?|thu|fri|sat)';
const MON_RE = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?';
const DATE_TOKEN = new RegExp(`\\b(?:${DAY_RE}\\.?,?\\s+)?(${MON_RE})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b|\\b(${DAY_RE})\\b|\\b(tomorrow|today)\\b`, 'gi');
const TIME_TOKEN = /(?<![\d:$.])(\d{1,2})(?::([0-5]\d))?\s?(a\.?m\.?|p\.?m\.?)(?![a-z])|(?<![\d:$.])(1[3-9]|2[0-3]):([0-5]\d)(?!\d)|\bnoon\b/gi;
const AT_BARE = /\bat\s+(\d{1,2})(?::([0-5]\d))?\b(?!\s*(?:a\.?m|p\.?m|minutes?|mins?|hours?|years?|:|%))/gi;
const HOURS_TALK = /\b(?:hours|we open|opens (?:at|from)|open (?:from|until|till)|closes?|closed|closing|until|till)\b/i;
const TAKEN = /\b(?:taken|booked up|unavailable|not available|isn't available|is not available|fully booked|already booked|no openings?|nothing (?:is )?open|not offered|filled up|passed|too soon)\b/i;

const addDays = (date, n) => { const [y, m, d] = date.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
const dowOf = (date) => { const [y, m, d] = date.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); };

function dateFor(tok, today) {
  if (tok.rel) return tok.rel === 'today' ? today : addDays(today, 1);
  if (tok.month != null) {
    const y = Number(today.slice(0, 4));
    let date = `${y}-${String(tok.month + 1).padStart(2, '0')}-${String(tok.day).padStart(2, '0')}`;
    if (date < addDays(today, -2)) date = `${y + 1}${date.slice(4)}`;
    return date;
  }
  for (let i = 0; i < 7; i += 1) if (dowOf(addDays(today, i)) === tok.dow) return addDays(today, i);
  return null;
}

/** Returns { id: 'bad_time', message } when the reply offers a time that is not an open slot, otherwise null. */
export function timeProblem(text, { today, openOn, anyOpen, nearest = '' }) {
  if (!today || typeof openOn !== 'function') return null;
  const t = String(text);
  let lastDay = null;
  const bad = [];
  for (const sentence of t.split(/(?<=[.!?])\s+|\n+|;/)) {
    for (const seg of sentence.split(/\bbut\b|\bhowever\b|\binstead\b|\bthough\b/i)) {
      const days = [];
      for (const m of seg.matchAll(DATE_TOKEN)) {
        const tok = m[1] ? { month: MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()), day: Number(m[2]) } : m[3] ? { dow: DAYNAMES.findIndex((names) => names.includes(m[3].toLowerCase())) } : { rel: m[4].toLowerCase() };
        days.push({ at: m.index, date: dateFor(tok, today) });
      }
      const times = [];
      for (const m of seg.matchAll(TIME_TOKEN)) {
        let h; let min = 0;
        if (/^noon$/i.test(m[0])) h = 12;
        else if (m[3]) { h = Number(m[1]) % 12 + (/^p/i.test(m[3]) ? 12 : 0); min = Number(m[2] || 0); }
        else { h = Number(m[4]); min = Number(m[5]); }
        if (m[1] && Number(m[1]) > 12) continue;
        times.push({ at: m.index, end: m.index + m[0].length, h, min });
      }
      // "1-2pm": the first number has no am/pm of its own and takes the second one's
      for (const m of seg.matchAll(/(?<![\d:$.])(1[0-2]|[1-9])(?::([0-5]\d))?\s?[-–]\s?(?:1[0-2]|[1-9])(?::[0-5]\d)?\s?(a\.?m\.?|p\.?m\.?)/gi)) {
        times.push({ at: m.index, end: m.index + m[0].length, h: Number(m[1]) % 12 + (/^p/i.test(m[3]) ? 12 : 0), min: Number(m[2] || 0) });
      }
      // "Friday at 10": a bare hour after "at", only with a day in context; business hours decide am or pm
      if (days.length || lastDay) {
        for (const m of seg.matchAll(AT_BARE)) {
          const n = Number(m[1]);
          if (n < 1 || n > 12 || times.some((x) => m.index < x.end && x.at <= m.index + m[0].length)) continue;
          times.push({ at: m.index, end: m.index + m[0].length, h: n >= 8 && n <= 11 ? n : (n % 12) + 12, min: Number(m[2] || 0) });
        }
      }
      times.sort((a, b) => a.at - b.at);
      // the end of a range ("9:00 AM-10:00 AM") is not a start time
      const starts = times.filter((x, i) => !(i > 0 && /^\s*(?:[-–]|to|until)\s*$/i.test(seg.slice(times[i - 1].end, x.at))) && !times.some((y, j) => j !== i && y.at === x.at));
      const skip = TAKEN.test(seg) || HOURS_TALK.test(seg) || new RegExp(`${DAY_RE}\\s?[-–]\\s?${DAY_RE}`, 'i').test(seg);
      for (const x of starts) {
        const before = days.filter((d) => d.at < x.at).at(-1) || (lastDay ? { date: lastDay } : null) || days[0] || null;
        if (skip) continue;
        const hh = String(x.h).padStart(2, '0');
        const mm = String(x.min).padStart(2, '0');
        let ok;
        if (before?.date) ok = x.min === 0 && openOn(before.date).has(`${hh}:00`);
        else ok = typeof anyOpen === 'function' ? anyOpen(`${hh}:${mm}`) : true;
        if (!ok) bad.push(`${before?.date || 'day not named'} ${hh}:${mm}`);
      }
      if (days.length) lastDay = days.at(-1).date;
    }
  }
  if (!bad.length) return null;
  return { id: 'bad_time', message: `Only offer these exact open times: ${nearest || 'call check_calendar for the real list'}. The reply offered a time that is not an open slot (${bad.slice(0, 2).join(', ')}). Use only times from check_calendar, spelled exactly, or say a requested time is taken.` };
}
