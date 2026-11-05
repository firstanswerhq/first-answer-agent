// Outbound time validation: every time a model reply OFFERS must be an open slot at that moment.
// Pure: the caller supplies today's date, a function that lists the open start times on a date, and a short list of real open times.
// The reply is read clause by clause. A clause that says a time is taken, closed or excluded, or that only mentions a time as a deadline,
// an hours statement, a duration or an end time, exempts the times in THAT clause only.
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYNAMES = [['sun', 'sunday'], ['mon', 'monday'], ['tue', 'tues', 'tuesday'], ['wed', 'weds', 'wednesday'], ['thu', 'thur', 'thurs', 'thursday'], ['fri', 'friday'], ['sat', 'saturday']];
const DAY_RE = '(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tues?|weds?|thurs?|thu|fri|sat)';
const MON_RE = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?';
const WORDNUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
const WORD_RE = Object.keys(WORDNUM).join('|');
// day cues, in one pass: [weekday] month day | day month | weekday the 12th | next weekday | weekday | tomorrow | today
const DAY_TOKEN = new RegExp(`\\b(?:(next)\\s+)?(?:(${DAY_RE})\\.?,?\\s+)?(${MON_RE})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b|\\b(?:(${DAY_RE})\\.?,?\\s+)?(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MON_RE})|\\b(?:(next)\\s+)?(${DAY_RE})\\b(?:,?\\s+the\\s+(\\d{1,2})(?:st|nd|rd|th)\\b)?|\\b(tomorrow|today)\\b|(?<![\\d/])\\b(1[0-2]|[1-9])\\/([1-3]?\\d)\\b(?![\\d/])|\\bthe\\s+(\\d{1,2})(?:st|nd|rd|th)\\b(?!\\s+(?:of|child|kid))`, 'gi');
const TIME_TOKEN = /(?<![\d:$.])(\d{1,2})(?::([0-5]\d))?\s?(a\.?m\.?|p\.?m\.?)(?![a-z])|(?<![\d:$.])(1[3-9]|2[0-3]):([0-5]\d)(?!\d)|\b(?:noon|midday|midnight)\b|(?<![\d:$.])(\d{1,2})(?::([0-5]\d))?\s?(?:o'?clock\b|in the (morning|afternoon|evening)\b)|(?<![\d:$.])(1[0-2]|[1-9]):([0-5]\d)(?![\d:])(?!\s?(?:a\.?m|p\.?m|o'?clock))/gi;
const AT_BARE = /\bat\s+(\d{1,2})(?::([0-5]\d))?\b(?!\s*(?:a\.?m|p\.?m|minutes?|mins?|hours?|years?|:|%|o'?clock))/gi;
// Things that are not offers: the time is a deadline, an hours statement, an end time, a contact window, a reminder, or excluded.
const HOURS_OPEN = /\b(?:we open|opens? at|open from|open until|open till)\b/i; // an hours statement only when the clause names no day
const NON_OFFER = /\b(?:hours|closes?|closed|closing|before|after|between|around noon|reminders?|remind|text you|call you|call us|call any|finished|finish\w*|ends?|arriv\w*|early|wrap\w*|deadline|due|arranged|rather than|instead of|other than|except|excluding|besides)\b|\b(?:by|until|till)\s+(?:\d|noon|midday)|\bthrough\s+(?:\d|the\b|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)|(?:sun|mon|tue|wed|thu|fri|sat))|\bopen\s+\d{1,2}(?::\d\d)?\s?(?:am|pm)?\s?[-–]/i;
const TAKEN = /\b(?:taken|booked|booked up|unavailable|not available|isn'?t available|is not available|aren'?t available|fully booked|already booked|no openings?|nothing (?:is )?open|not offered|filled(?: up)?|gone|(?<!not )full|busy|reserved|no longer|not open|isn'?t open|is not open|aren'?t open|isn'?t free|is not free|can'?t do|cannot do|can'?t make|passed|too soon|already has|has an appointment|don'?t have|do not have|won'?t work|doesn'?t work|no availability|spoken for|not an option|not a start time|isn'?t a start time|is lunch|lunch|not offered|don'?t schedule|do not schedule|out of room|no good|someone has|has someone|closed to)\b/i;
const NEG = /\b(?:no|not|nothing|never|can'?t|cannot|won'?t|doesn'?t|don'?t|isn'?t|aren'?t|wasn'?t|unfortunately|afraid)\b|n't\b/i;
const NOT_TAKEN = /\bnot (?:full|booked|busy|taken|reserved|unavailable|closed)\b|\b(?:isn'?t|is not|aren'?t) (?:full|booked|busy|taken|reserved)\b/i; // "is not taken" is an offer
const POSITIVE = /\b(?:is|are|still) (?:open|available|free)\b|\bworks\b|\bi (?:can|could) (?:do|offer|fit|book|get)\b|\bwe (?:can|could) (?:do|offer|fit|book|get)\b|\bi have\b|\bhow about\b/i;

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
  else if (m[12]) { wd = null; date = monthDate(Number(m[12]) - 1, Number(m[13])); }
  else if (m[14]) { // "the 5th": the next date with that day of the month
    for (let i = 0; i < 45 && !date; i += 1) { const d = addDays(today, i); if (Number(d.slice(8)) === Number(m[14])) date = d; }
    return { date, mismatch: !date };
  }
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
function expandLists(t) {
  const N = '\\d{1,2}(?::[0-5]\\d)?(?:\\s?[ap]\\.?m\\.?)?';
  // "at 10, 11 or 12" / "Thursday: 10, 11 or 12" / "at 10 and also 1": every number in the list is a time
  t = t.replace(new RegExp(`((?:\\bat\\b|(?<=[a-z]):)\\s+)(${N})((?:\\s*(?:,|;|\\bor\\b|\\band\\b|\\balso\\b|&)\\s*(?:also\\s+)?${N}(?![\\d/%]))+)`, 'gi'), (_m, lead, first, rest) => `${lead}${first}${rest.replace(new RegExp(`(${N})(?![\\d/%])`, 'g'), (num) => `, at ${num.trim()}`).replace(/(?:\\s*(?:,|;|\\bor\\b|\\band\\b|\\balso\\b|&)\\s*(?:also\\s+)?)+(?=, at)/gi, '')}`);
  // "Thursday at 10 works, or 12."
  t = t.replace(/\b(at\s+\d{1,2}(?::[0-5]\d)?(?:\s?[ap]\.?m\.?)?\s+(?:works|is open|is available|is free|are open|are available))\s*,?\s*(?:or|and)\s+(\d{1,2})(?![\d:%/])(?!\s?(?:a\.?m|p\.?m|minutes|mins|hours|years))/gi, '$1, at $2');
  return t;
}

function plain(t) {
  t = t.replace(new RegExp(`\\b(${DAY_RE}|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)\\.`, 'gi'), '$1');
  t = t.replace(new RegExp(`\\b(${WORD_RE})\\s+(thirty|fifteen|forty[- ]five)\\b`, 'gi'), (_m, n, w) => `${WORDNUM[n.toLowerCase()]}:${/thirty/i.test(w) ? '30' : /fifteen/i.test(w) ? '15' : '45'}`);
  t = t.replace(new RegExp(`\\b(?:a\\s+)?quarter\\s+(to|past|after)\\s+(${WORD_RE}|\\d{1,2})\\b`, 'gi'), (_m, w, n) => { const h = WORDNUM[String(n).toLowerCase()] || Number(n); return /to/i.test(w) ? `${h - 1 || 12}:45` : `${h}:15`; });
  t = t.replace(/(?<![\w:.])(\d{1,2})(?::([0-5]\d))?\s?([ap])(?![a-z])\.?/gi, (_m, h, mm, ap) => `${h}${mm ? ':' + mm : ''} ${ap.toLowerCase()}m`);
  t = expandLists(t);
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
export function timeProblem(text, o) {
  const { bad } = scan(text, o);
  if (!bad.length) return null;
  return { id: 'bad_time', message: `Only offer these exact open times: ${o.nearest || 'call check_calendar for the real list'}. The reply offered a time that is not an open slot (${bad.slice(0, 2).join(', ')}). Use only times from check_calendar, spelled exactly, or say a requested time is taken.` };
}

/** The open slot ids a reply actually shows the customer (in order), e.g. ["2026-11-05T10:00"]. Times with no day are matched against `hint` slot ids by hour. */
export function shownSlots(text, o, hint = []) {
  if (!o?.today || typeof o.openOn !== 'function') return [];
  const { shown, dayless } = scan(text, o);
  const out = [...new Set(shown)];
  for (const hm of dayless) { const hit = hint.find((id) => id.slice(11, 16) === hm && !out.includes(id)); if (hit) out.push(hit); }
  return out;
}

function scan(text, { today, openOn, anyOpen }) {
  const bad = [];
  const shown = [];
  const dayless = [];
  let lastDay = null;
  let prevOffer = false;
  for (const sentence of plain(String(text)).split(/(?<=[.!?])\s+|\n+/)) {
    let sentenceHadOffer = false;
    let sentenceDay = null;
    let prevNon = false;
    for (const clause of sentence.split(/[,;()]\s*|\s(?:but|and|though|however|instead)\s|\s[-–—]\s/i)) {
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
        if (/^(?:noon|midday)$/i.test(m[0])) h = 12;
        else if (/^midnight$/i.test(m[0])) h = 0;
        else if (m[3]) { if (Number(m[1]) > 12 || Number(m[1]) < 1) continue; h = (Number(m[1]) % 12) + (/^p/i.test(m[3]) ? 12 : 0); min = Number(m[2] || 0); }
        else if (m[4]) { h = Number(m[4]); min = Number(m[5]); }
        else if (m[9]) { const n = Number(m[9]); h = n >= 7 && n <= 11 ? n : n === 12 ? 12 : (n % 12) + 12; min = Number(m[10]); }
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
      const OFFER_CUE = /\b(?:available|open times?|i can|i could|we can|we have|works?|would|option|slot|how about|offer|(?:is|are) (?:open|available))\b/i;
      const nonOffer = NON_OFFER.test(clause) || (HOURS_OPEN.test(clause) && !days.length) || (prevNon && !OFFER_CUE.test(clause));
      prevNon = nonOffer;
      const exempt = (TAKEN.test(clause) && !NOT_TAKEN.test(clause)) || nonOffer || dayRange || /\bnothing\b/i.test(clause) || (NEG.test(clause) && !POSITIVE.test(clause) && !NOT_TAKEN.test(clause));
      if (mismatch) bad.push('the weekday and the date do not agree');
      // a day named in this clause wins; otherwise the day carried from the previous clause or an earlier offer sentence
      const carried = sentenceDay || (prevOffer ? lastDay : null);
      for (const x of starts) {
        const before = days.filter((d) => d.at < x.at && d.date).at(-1) || (carried ? { date: carried } : null) || days.find((d) => d.date) || null;
        sentenceHadOffer = sentenceHadOffer || !!days.length;
        const hh = String(x.h).padStart(2, '0');
        const mm = String(x.min).padStart(2, '0');
        if (exempt) {
          // an offer phrased with a hedge ("is open at 10 AM, hours are 8 to 5") still tells the customer that slot, so a later "yes" can book it
          if (before?.date && x.min === 0 && !TAKEN.test(clause) && !nonOffer && !dayRange && OFFER_CUE.test(clause) && openOn(before.date).has(`${hh}:00`)) shown.push(`${before.date}T${hh}:00`);
          continue;
        }
        let ok;
        if (before?.date) { ok = x.min === 0 && openOn(before.date).has(`${hh}:00`); if (ok) shown.push(`${before.date}T${hh}:00`); }
        else { ok = typeof anyOpen === 'function' ? anyOpen(`${hh}:${mm}`) : true; if (ok) dayless.push(`${hh}:${mm}`); }
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
  return { bad, shown, dayless };
}
