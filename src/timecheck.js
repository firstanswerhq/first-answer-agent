// Outbound time validation: every time a model reply OFFERS must be an open slot at that moment.
// Pure: the caller supplies today's date, a function that lists the open start times on a date, and a short list of real open times.
// The reply is read clause by clause. A clause that says a time is taken, closed or excluded, or that only mentions a time as a deadline,
// an hours statement, a duration or an end time, exempts the times in THAT clause only.
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYNAMES = [['sun', 'sunday'], ['mon', 'monday'], ['tue', 'tues', 'tuesday'], ['wed', 'wednesday'], ['thu', 'thur', 'thurs', 'thursday'], ['fri', 'friday'], ['sat', 'saturday']];
const DAY_RE = '(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tues?|wed|thurs?|thu|fri|sat)';
const MON_RE = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?';
const WORDNUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
const WORD_RE = Object.keys(WORDNUM).join('|');
// day cues, in one pass: [weekday] month day | day month | weekday the 12th | next weekday | weekday | tomorrow | today
const DAY_TOKEN = new RegExp(`\\b(?:(next)\\s+)?(?:(${DAY_RE})\\.?,?\\s+)?(${MON_RE})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b|\\b(?:(${DAY_RE})\\.?,?\\s+)?(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MON_RE})|\\b(?:(next)\\s+)?(${DAY_RE})\\b(?:,?\\s+the\\s+(\\d{1,2})(?:st|nd|rd|th)\\b)?|\\b(tomorrow|today)\\b`, 'gi');
const TIME_TOKEN = /(?<![\d:$.])(\d{1,2})(?::([0-5]\d))?\s?(a\.?m\.?|p\.?m\.?)(?![a-z])|(?<![\d:$.])(1[3-9]|2[0-3]):([0-5]\d)(?!\d)|\bnoon\b|(?<![\d:$.])(\d{1,2})(?::([0-5]\d))?\s?(?:o'?clock\b|in the (morning|afternoon|evening)\b)/gi;
const AT_BARE = /\bat\s+(\d{1,2})(?::([0-5]\d))?\b(?!\s*(?:a\.?m|p\.?m|minutes?|mins?|hours?|years?|:|%|o'?clock))/gi;
// Things that are not offers: the time is a deadline, an hours statement, an end time, a contact window, a reminder, or excluded.
const NON_OFFER = /\b(?:hours|we open|opens? at|open from|open until|open till|closes?|closed|closing|until|till|by|before|after|between|around noon|reminders?|remind|text you|call you|call us|call any|finished|ends?|deadline|due|through|arranged|rather than|instead of|other than|except|excluding|besides)\b|\bopen\s+\d{1,2}(?::\d\d)?\s?(?:am|pm)?\s?[-–]/i;
const TAKEN = /\b(?:taken|booked|booked up|unavailable|not available|isn'?t available|is not available|aren'?t available|fully booked|already booked|no openings?|nothing (?:is )?open|not offered|filled(?: up)?|gone|full|busy|reserved|no longer|not open|isn'?t open|is not open|aren'?t open|isn'?t free|is not free|can'?t do|cannot do|can'?t make|passed|too soon|already has|has an appointment|don'?t have|do not have)\b/i;

const addDays = (date, n) => { const [y, m, d] = date.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
const dowOf = (date) => { const [y, m, d] = date.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); };
const dayIdx = (name) => DAYNAMES.findIndex((names) => names.includes(String(name).toLowerCase().replace(/\.$/, '')));
const monIdx = (name) => MONTHS.indexOf(String(name).slice(0, 3).toLowerCase());

/** A date token -> { date, mismatch }. Weekday/date disagreement ("Thursday Nov 6" when Nov 6 is a Friday) is reported as a mismatch. */
function resolveDay(m, today) {
  const year = Number(today.slice(0, 4));
  const monthDate = (mi, d) => {
    let date = `${year}-${String(mi + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    if (date < addDays(today, -2)) date = `${year + 1}${date.slice(4)}`;
    return date;
  };
  let wd = null; let date = null; let far = false;
  if (m[3]) { wd = m[2] ? dayIdx(m[2]) : null; date = monthDate(monIdx(m[3]), Number(m[4])); }
  else if (m[7]) { wd = m[5] ? dayIdx(m[5]) : null; date = monthDate(monIdx(m[7]), Number(m[6])); }
  else if (m[9]) {
    wd = dayIdx(m[9]);
    if (m[10]) { // "Thursday the 12th": the next date with that day of the month that falls on that weekday
      for (let i = 0; i < 90 && !date; i += 1) { const d = addDays(today, i); if (Number(d.slice(8)) === Number(m[10]) && dowOf(d) === wd) date = d; }
      return { date, mismatch: !date };
    }
    let i = 0;
    while (i < 7 && dowOf(addDays(today, i)) !== wd) i += 1;
    date = addDays(today, i);
    if (m[8] || m[1]) { // "next Friday": the Friday of the following week
      const mondayOfToday = addDays(today, -((dowOf(today) + 6) % 7));
      if (date < addDays(mondayOfToday, 7)) date = addDays(date, 7);
    }
    return { date, mismatch: false };
  } else if (m[11]) return { date: m[11].toLowerCase() === 'today' ? today : addDays(today, 1), mismatch: false };
  else return { date: null, mismatch: false };
  if (date > addDays(today, 120)) far = true;
  return { date, mismatch: wd != null && dowOf(date) !== wd, far };
}

/** Pre-process wording: spelled-out hours and "half past". */
function plain(t) {
  return t
    .replace(/\bbetween (\S+(?: \S+)?) and /gi, 'between $1 to ')
    .replace(new RegExp(`\\bhalf past (${WORD_RE}|\\d{1,2})\\b`, 'gi'), (_m, n) => `at ${WORDNUM[n.toLowerCase()] || n}:30`)
    .replace(new RegExp(`\\b(${WORD_RE})(\\s+o'?clock\\b)`, 'gi'), (_m, n, r) => `${WORDNUM[n.toLowerCase()]}${r}`)
    .replace(new RegExp(`\\bat (${WORD_RE})\\b`, 'gi'), (_m, n) => `at ${WORDNUM[n.toLowerCase()]}`)
    // keep "Thu, Nov 5, 9:00 AM" together as one clause
    .replace(new RegExp(`\\b(${DAY_RE}),\\s+(?=${MON_RE}\\s+\\d)`, 'gi'), '$1 ')
    .replace(new RegExp(`(${MON_RE}\\s+\\d{1,2}(?:st|nd|rd|th)?),\\s+(?=\\d{1,2}(?::\\d\\d)?\\s?(?:a\\.?m|p\\.?m))`, 'gi'), '$1 ')
    .replace(new RegExp(`\\b(${DAY_RE}),\\s+(?=\\d{1,2}(?::\\d\\d)?\\s?(?:a\\.?m|p\\.?m))`, 'gi'), '$1 ');
}

/** Returns { id: 'bad_time', message } when the reply offers a time that is not an open slot, otherwise null. */
export function timeProblem(text, { today, openOn, anyOpen, nearest = '' }) {
  if (!today || typeof openOn !== 'function') return null;
  const bad = [];
  let lastDay = null;
  let prevOffer = false;
  for (const sentence of plain(String(text)).split(/(?<=[.!?])\s+|\n+/)) {
    let sentenceHadOffer = false;
    let sentenceDay = null;
    let prevNon = false;
    for (const clause of sentence.split(/[,;]\s*|\s(?:but|and|though|however|instead)\s|\s[-–—]\s/i)) {
      if (!clause.trim()) continue;
      const days = [];
      let mismatch = false;
      for (const m of clause.matchAll(DAY_TOKEN)) {
        const r = resolveDay(m, today);
        if (!r.date && !r.mismatch) continue;
        if (r.mismatch) mismatch = true;
        days.push({ at: m.index, end: m.index + m[0].length, date: r.date, far: r.far });
      }
      const times = [];
      for (const m of clause.matchAll(TIME_TOKEN)) {
        let h; let min = 0;
        if (/^noon$/i.test(m[0])) h = 12;
        else if (m[3]) { if (Number(m[1]) > 12 || Number(m[1]) < 1) continue; h = (Number(m[1]) % 12) + (/^p/i.test(m[3]) ? 12 : 0); min = Number(m[2] || 0); }
        else if (m[4]) { h = Number(m[4]); min = Number(m[5]); }
        else { const n = Number(m[6]); if (n < 1 || n > 12) continue; min = Number(m[7] || 0); h = m[8] ? ((n % 12) + (/^m/i.test(m[8]) ? 0 : 12)) : (n >= 8 && n <= 11 ? n : (n % 12) + 12); }
        times.push({ at: m.index, end: m.index + m[0].length, h, min });
      }
      // "1-2pm": the first number has no am/pm of its own and takes the second one's
      for (const m of clause.matchAll(/(?<![\d:$.])(1[0-2]|[1-9])(?::([0-5]\d))?\s?[-–]\s?(?:1[0-2]|[1-9])(?::[0-5]\d)?\s?(a\.?m\.?|p\.?m\.?)/gi)) {
        times.push({ at: m.index, end: m.index + m[0].length, h: (Number(m[1]) % 12) + (/^p/i.test(m[3]) ? 12 : 0), min: Number(m[2] || 0) });
      }
      // "Friday at 10": a bare hour after "at", with a day in context; business hours decide am or pm
      if (days.length || lastDay) {
        for (const m of clause.matchAll(AT_BARE)) {
          const n = Number(m[1]);
          if (n < 1 || n > 12 || times.some((x) => m.index < x.end && x.at <= m.index + m[0].length)) continue;
          times.push({ at: m.index, end: m.index + m[0].length, h: n >= 8 && n <= 11 ? n : (n % 12) + 12, min: Number(m[2] || 0) });
        }
      }
      times.sort((a, b) => a.at - b.at);
      // the end of a range ("9:00 AM-10:00 AM") is not a start time
      const starts = times.filter((x, i) => !(i > 0 && /^\s*(?:[-–]|to|until)\s*$/i.test(clause.slice(times[i - 1].end, x.at))) && !times.some((y, j) => j !== i && y.at === x.at));
      const dayRange = new RegExp(`${DAY_RE}\\s?(?:[-–]|through|to)\\s?${DAY_RE}`, 'i').test(clause);
      const OFFER_CUE = /\b(?:available|open times?|i can|i could|we can|we have|works?|would|option|slot|how about|offer)\b/i;
      const nonOffer = NON_OFFER.test(clause) || (prevNon && !OFFER_CUE.test(clause));
      prevNon = nonOffer;
      const exempt = TAKEN.test(clause) || nonOffer || dayRange;
      if (mismatch) bad.push('the weekday and the date do not agree');
      // a day named in this clause wins; otherwise the day carried from the previous clause or an earlier offer sentence
      const carried = sentenceDay || (prevOffer ? lastDay : null);
      for (const x of starts) {
        const before = days.filter((d) => d.at < x.at && d.date).at(-1) || (carried ? { date: carried } : null) || days.find((d) => d.date) || null;
        sentenceHadOffer = sentenceHadOffer || !!days.length;
        if (exempt) continue;
        const hh = String(x.h).padStart(2, '0');
        const mm = String(x.min).padStart(2, '0');
        let ok;
        if (before?.date) ok = x.min === 0 && openOn(before.date).has(`${hh}:00`);
        else ok = typeof anyOpen === 'function' ? anyOpen(`${hh}:${mm}`) : true;
        sentenceHadOffer = true;
        if (!ok) bad.push(`${before?.date || 'day not named'} ${hh}:${mm}`);
      }
      const dated = days.filter((d) => d.date && !d.far).at(-1);
      if (dated && !/\b(?:due|deadline|through)\b/i.test(clause)) { sentenceDay = dated.date; lastDay = dated.date; }
      if (starts.length && days.length) sentenceHadOffer = true;
    }
    prevOffer = sentenceHadOffer;
    if (!sentenceHadOffer) lastDay = lastDay; // a stale date does not leak: prevOffer gates it
  }
  if (!bad.length) return null;
  return { id: 'bad_time', message: `Only offer these exact open times: ${nearest || 'call check_calendar for the real list'}. The reply offered a time that is not an open slot (${bad.slice(0, 2).join(', ')}). Use only times from check_calendar, spelled exactly, or say a requested time is taken.` };
}
