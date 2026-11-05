// Lightweight text understanding used by the offline rules engine and as a cross-check.

/** Which of the profile's services the text is about, or 'other'. Services are tried in the order the profile lists them. */
export function detectService(text, config) {
  const t = String(text || '');
  for (const svc of config.services) if (svc.re?.test(t)) return svc.id;
  return 'other';
}

/** Every service the text mentions, in the order the customer mentioned them. */
export function detectServices(text, config) {
  const t = String(text || '');
  const found = [];
  for (const svc of config.services) {
    const m = svc.re ? t.search(svc.re) : -1;
    if (m >= 0) found.push({ id: svc.id, at: m });
  }
  return found.sort((a, b) => a.at - b.at).map((x) => x.id);
}

/**
 * Find a ZIP code only where it plausibly is one: a 5-digit number that is not part of a longer
 * number, a price ("$30000", "30000 dollars") or a measurement ("35000 sq ft"). Returns the 5 digits or null.
 */
export function findZip(text) {
  const re = /(?<![\d$,.])(\d{5})(?![\d,]|\.\d|\s*(?:dollars?|bucks|usd|sq|square|ft|feet|k\b|%|\$))/gi;
  for (const m of String(text).matchAll(re)) {
    const before = String(text).slice(Math.max(0, m.index - 12), m.index).toLowerCase();
    if (/(\$|budget|about|around|roughly|spend|pay|cost|price)\s*$/.test(before) && !/zip\s*(code)?\s*$/.test(before)) continue;
    return m[1];
  }
  return null;
}

/**
 * Where the customer is, checked against the profile's service area. A profile without a serviceArea (customers come
 * to the business) never asks for a location: it is always "known" and in area.
 */
export function detectLocation(text, config) {
  const area = config.serviceArea;
  if (!area) return { text: '', known: true, inArea: true, needed: false };
  const zip = findZip(text);
  const lower = text.toLowerCase();
  const city = [...area.cities].sort((a, b) => b.length - a.length).find((c) => lower.includes(c.toLowerCase()));
  const outside = area.outside.find((c) => lower.includes(c.toLowerCase()));
  if (outside && !city) return { text: outside, known: true, inArea: false, needed: true };
  if (zip) {
    if (area.zips.includes(zip)) return { text: zip, known: true, inArea: true, needed: true };
    // A ZIP we do not list next to a city we do serve is ambiguous: keep both so the agent asks instead of guessing.
    if (city) return { text: `${city} ${zip}`, known: true, inArea: null, needed: true };
    return { text: zip, known: true, inArea: false, needed: true };
  }
  if (city) return { text: city, known: true, inArea: true, needed: true };
  return { text: '', known: false, inArea: null, needed: true };
}

export function wantsOutsideHours(text) {
  return /\b(tonight|right now|midnight|after hours|late night|(?:[6-9]|1[01])\s?(?:pm|p\.m\.)|(?:[0-6])\s?(?:am|a\.m\.))\b/i.test(text);
}

// Which offered option a reply names, 0-based, or -1. Ordinals count only when they are clearly a choice ("the second one",
// "option 2", "second option", or the whole reply). "the 2nd", "November 2nd", "my 2nd child", "a second opinion" and
// "wait a second" are not choices.
const WORDN = { first: 0, second: 1, third: 2, one: 0, two: 1, three: 2, 1: 0, 2: 1, 3: 2 };
function ordIndex(t) {
  const x = t.trim();
  let m = /\b(?:option|number|choice|slot)\s*#?\s*(1|2|3|one|two|three)\b/.exec(x) || /(?:^|\s)#\s*(1|2|3)\b/.exec(x);
  if (m) return WORDN[m[1]];
  m = /\b(first|second|third)\s+(?:one|option|choice|slot)\b/.exec(x);
  if (m) return WORDN[m[1]];
  m = /^\W*(?:the\s+|my\s+)?(first|second|third)\W*(?:please|pls|thanks)?\W*$/.exec(x)
    || /^\W*(?:i(?:'ll|\s+will)?\s+)?(?:take|pick|choose|want|go\s+with)\s+(?:the\s+)?(first|second|third)\W*$/.exec(x)
    || /^\W*(one|two|three)\W*$/.exec(x);
  return m ? WORDN[m[1]] : -1;
}
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

const namesWeekday = (t, i) => t.includes(WEEKDAYS[i]) || new RegExp(`\\b${WEEKDAYS[i].slice(0, 3)}\\b`).test(t);
const dowOf = (date) => { const [y, m, d] = date.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); };
const addDay = (date, n) => { const [y, m, d] = date.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };

/**
 * A day the customer asked for: a weekday name (the next one on or after today) or an explicit date ("Nov 7", "11/7").
 * Returns { date, dow, weekday: bool } or null. Only the first day mentioned counts.
 */
export function requestedDay(text, today) {
  const t = String(text || '').toLowerCase();
  const year = Number(today.slice(0, 4));
  const iso = (m, d) => { const date = `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`; return Number.isNaN(Date.parse(date)) || new Date(`${date}T00:00:00Z`).getUTCMonth() !== m - 1 ? null : date; };
  const mon = t.match(new RegExp(`\\b(${MONTHS.map((x) => x.slice(0, 3)).join('|')})[a-z]*\\.? (\\d{1,2})(?:st|nd|rd|th)?\\b`));
  const num = t.match(/\b(\d{1,2})\/(\d{1,2})\b/);
  if (num) { // "Thursday 11/6" when 11/6 is a Friday: do not guess
    const ex = iso(Number(num[1]), Number(num[2]));
    const wdn = t.match(/\b(sun|mon|tue|tues|wed|weds|thu|thur|thurs|fri|sat)[a-z]*\.?,?\s+(?:the\s+)?\d{1,2}\/\d{1,2}\b/);
    if (ex && wdn && dowOf(ex) !== WEEKDAYS.findIndex((w) => w.startsWith(wdn[1].slice(0, 3)))) return null;
  }
  const explicit = mon ? iso(MONTHS.findIndex((x) => x.startsWith(mon[1])) + 1, Number(mon[2])) : num ? iso(Number(num[1]), Number(num[2])) : null;
  if (explicit && explicit >= today) return { date: explicit, dow: dowOf(explicit), weekday: false };
  if (/\btoday\b/.test(t)) return { date: today, dow: dowOf(today), weekday: false, rel: 'today' };
  if (/\btomorrow\b/.test(t)) return { date: addDay(today, 1), dow: dowOf(addDay(today, 1)), weekday: false, rel: 'tomorrow' };
  const wk = t.match(/\ba week from (?:this )?(sun|mon|tue|tues|wed|weds|thu|thur|thurs|fri|sat)[a-z]*/);
  if (wk) {
    const wd = WEEKDAYS.findIndex((w) => w.startsWith(wk[1].slice(0, 3)));
    let i = 0;
    while (i < 7 && dowOf(addDay(today, i)) !== wd) i += 1;
    const date = addDay(today, i + 7);
    return { date, dow: wd, weekday: false };
  }
  // "Thursday the 12th": the date wins; a weekday that does not match that date is not guessed
  const wn = t.match(/\b(sun|mon|tue|tues|wed|weds|thu|thur|thurs|fri|sat)[a-z]*\.?,?\s+the\s+(\d{1,2})(?:st|nd|rd|th)?\b(?!\s*(?::|a\.?m|p\.?m|o'?clock))/);
  if (wn) {
    const wd = WEEKDAYS.findIndex((w) => w.startsWith(wn[1].slice(0, 3)));
    for (let i = 0; i < 70; i += 1) { const date = addDay(today, i); if (Number(date.slice(8)) === Number(wn[2]) && dowOf(date) === wd) return { date, dow: wd, weekday: false }; }
    return null;
  }
  for (let i = 0; i < 7; i += 1) {
    const date = addDay(today, i);
    if (namesWeekday(t, dowOf(date))) {
      // "next Thursday" is the Thursday of next week, not the one coming up this week
      const nextTok = new RegExp(`\\bnext\\s+(?:${WEEKDAYS[dowOf(date)].slice(0, 3)}[a-z]*)\\b`).test(t);
      if (nextTok) {
        const mon = addDay(today, -((dowOf(today) + 6) % 7));
        const d2 = date < addDay(mon, 7) ? addDay(date, 7) : date;
        return { date: d2, dow: dowOf(d2), weekday: false };
      }
      return { date, dow: dowOf(date), weekday: true };
    }
  }
  return null;
}

/**
 * The clock time the customer asked for as { hour (0-23), minute }, or null. Understands "9am", "at 1 pm", "10:30 am", "at 14:00",
 * "noon", "half past 9" and a bare "at 9" / "Thursday 9" (read as business hours: 7-11 is morning, 1-6 is afternoon).
 * "9 year old", dates and prices are not times.
 */
export function requestedClock(text) {
  const t = String(text || '').toLowerCase();
  let m = /\b(1[0-2]|0?[1-9])(?::([0-5]\d))?\s?([ap])\.?m\b/.exec(t);
  if (m) return { hour: (Number(m[1]) % 12) + (m[3] === 'p' ? 12 : 0), minute: Number(m[2] || 0) };
  if (/\bnoon\b/.test(t)) return { hour: 12, minute: 0 };
  const guess = (h) => (h >= 7 && h <= 11 ? h : h === 12 ? 12 : h >= 1 && h <= 6 ? h + 12 : null);
  m = /\bhalf past (1[0-2]|[1-9])\b/.exec(t);
  if (m && guess(Number(m[1])) != null) return { hour: guess(Number(m[1])), minute: 30 };
  m = /\bat (1[0-9]|2[0-3]|0?[7-9]):([0-5]\d)\b/.exec(t);
  if (m) return { hour: Number(m[1]), minute: Number(m[2]) };
  m = /(?<![\d$:.])(1[0-2]|0?[1-9]):([0-5]\d)(?![\d:])(?!\s*[ap]\.?m)/.exec(t); // "10:00 on Friday": business hours decide am or pm
  if (m && guess(Number(m[1])) != null) return { hour: guess(Number(m[1])), minute: Number(m[2]) };
  m = /(?:\bat|\baround|\babout|@|\b(?:mon|tues|wednes|thurs|fri|satur|sun)day)\s*(1[0-2]|[1-9])(?::([0-5]\d))?\b(?!\s*(?:[/.-]\d|th\b|st\b|nd\b|rd\b|years?|yrs?|months?|people|kids|children|patients|teeth|minutes?|mins?|hours?|dollars?|%|\$|\d))/.exec(t);
  if (m && guess(Number(m[1])) != null) return { hour: guess(Number(m[1])), minute: Number(m[2] || 0) };
  return null;
}

/** "morning", "afternoon" or "evening" when the customer gave a part of the day, else null. */
export const partOfDay = (text) => (/\bmornings?\b/i.test(text) ? 'morning' : /\bafternoons?\b/i.test(text) ? 'afternoon' : /\bevenings?\b/i.test(text) ? 'evening' : null);

/** A window of start hours as { test(hour), label }, or null: after/before N, between A and B, after lunch, before noon. Bare 1-6 are afternoon, 7-11 morning. */
export function windowOf(text) {
  const t = String(text || '');
  const hr = (n, ap) => (ap ? (Number(n) % 12) + (/^p/i.test(ap) ? 12 : 0) : Number(n) >= 1 && Number(n) <= 6 ? Number(n) + 12 : Number(n));
  const fmt = (h) => `${h % 12 || 12} ${h >= 12 ? 'PM' : 'AM'}`;
  let m = /\bbetween\s+(1[0-2]|[1-9])(?::[0-5]\d)?\s?(a\.?m|p\.?m)?\s+(?:and|to|&)\s+(1[0-2]|[1-9])(?::[0-5]\d)?\s?(a\.?m|p\.?m)?\b/i.exec(t);
  if (m) {
    const e = hr(m[3], m[4]);
    let b = hr(m[1], m[2] || (m[4] && Number(m[1]) <= Number(m[3]) ? m[4] : null));
    if (b >= e) b -= 12;
    return { test: (x) => x >= b && x < e, label: `between ${fmt(b)} and ${fmt(e)}` };
  }
  if (/\bafter lunch\b/i.test(t)) return { test: (x) => x >= 13, label: 'after lunch' };
  m = /\b(after|before|earlier than|later than)\s+(1[0-2]|[1-9])(?::([0-5]\d))?\s?(a\.?m|p\.?m)?\b(?!\s*(?:years?|yrs?|people|persons?|kids|children|weeks?|days?|months?|visits?|minutes?|mins?|hours?|hrs?|times?|more|of\b|appointments?))/i.exec(t);
  if (m) {
    const h = hr(m[2], m[4]);
    const after = /after|later/i.test(m[1]);
    return { test: (x) => (after ? x >= h : x < h), label: `${after ? 'after' : 'before'} ${h % 12 || 12}${m[3] ? ':' + m[3] : ''} ${h >= 12 ? 'PM' : 'AM'}` };
  }
  if (/\b(?:after|before)\s+noon\b/i.test(t)) return /after/i.test(t.match(/\b(after|before)\s+noon/i)[1]) ? { test: (x) => x >= 12, label: 'after noon' } : { test: (x) => x < 12, label: 'before noon' };
  return null;
}

/** A request for a clock time that none of the offered slots has ("can you do 2 pm instead"). */
/** "can you do 4 instead", "how about 4", "what about 3", "is 4 open": a bare hour read as business hours (7-11 AM, 12, 1-6 PM). */
export function bareHourOf(text) {
  const m = /\b(?:(?:can|could) you do|how about|what about|do you have|any chance of|is|are you open at)\s+(1[0-2]|[1-9])(?::([0-5]\d))?\b(?!\s*(?:years?|people|kids|weeks|days|months|times|of\b))|\b(1[0-2]|[1-9])(?::([0-5]\d))?\s+instead\b/i.exec(String(text || ''));
  if (!m) return null;
  const n = Number(m[1] || m[3]);
  const hour = n >= 7 && n <= 11 ? n : n === 12 ? 12 : n >= 1 && n <= 6 ? n + 12 : null;
  return hour == null ? null : { hour, minute: Number(m[2] || m[4] || 0) };
}

export function asksOtherTime(text, slots) {
  const t = String(text || '');
  if (!slots?.length || t.length > 100 || windowOf(t) || pickSlot(t, slots) || slotCandidates(t, slots).length) return false;
  return !!(requestedClock(t) || bareHourOf(t)) && /\b(?:instead|rather|can you do|could you do|how about|what about|do you have|is .{1,12} (?:open|available)|any chance)\b/i.test(t);
}

/**
 * A pick that software may act on (book): the WHOLE message is a pick. Bare yes/ok/sure/that works/book it, or a number, ordinal, "earliest"
 * or time that matches a shown option, with no negation, question, extra clause or other person. Anything else returns null (the model or a question handles it).
 * A bare yes returns the only shown slot, and null when several were shown.
 */
export function strictPick(text, slots) {
  if (typeof text !== 'string' || !slots?.length) return null;
  // Allowlist over the WHOLE message: normalize, remove known filler, and what is left must be empty or one reference to a shown option.
  // Any other word ("doesnt work", "skip", "unless", "if", "out", "maybe", a person, a question) means no booking.
  const t = text.toLowerCase().replace(/[‘’ʼ'`]/g, '').replace(/[^a-z0-9:#]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t || t.length > 90) return null;
  const AFFIRM = (/\b(?:thanks|thank|thx)\b/.test(t) ? t.replace(/\b(?:ok|okay)\b/g, ' ') : t).match(/\b(?:yes|yeah|yep|yup|ok|okay|sure|that works|works for me|that time works|sounds good|sounds great|looks good|thats fine|that is fine|perfect|awesome|great|book it|book that|book me in|book me|go ahead|lets do it|lets do|see you then|ill take|i will take|confirm)\b/) !== null;
  const FILLER = ['that would be great', 'that time works', 'that works for me', 'that works', 'works for me', 'sounds good', 'sounds great', 'looks good', 'thats fine', 'that is fine', 'see you then', 'see you', 'book me in', 'book me', 'book it', 'book that', 'go ahead', 'lets do it', 'lets do', 'ill take', 'i will take', 'i would like', 'id like', 'thank you', 'thanks', 'thx', 'please', 'pls', 'yes', 'yeah', 'yep', 'yup', 'okay', 'ok', 'sure', 'great', 'perfect', 'awesome', 'confirm', 'for me', 'works', 'book', 'then', 'it', 'that'];
  let rest = ` ${t} `;
  for (const f of FILLER) rest = rest.replace(new RegExp(`(?<=\\s)${f}(?=\\s)`, 'g'), ' ');
  rest = rest.replace(/\s+/g, ' ').trim();
  const REF_WORDS = new Set(['the', 'one', 'option', 'number', 'at', 'on', 'first', 'second', 'third', 'fourth', 'fifth', 'last', 'time', 'you', 'offered', 'earlier', 'later', 'latest', 'earliest', 'soonest', 'am', 'pm', 'a', 'm', 'noon', 'oclock', ...WEEKDAYS.flatMap((w) => [w.toLowerCase(), w.toLowerCase().slice(0, 3), w.toLowerCase().slice(0, 4)])]);
  if (rest && !rest.split(' ').every((w) => REF_WORDS.has(w) || /^#?\d{1,2}(?::\d\d)?(?:st|nd|rd|th|am|pm)?$/.test(w))) return null;
  if (!rest) {
    // only an explicit affirmative books; "thanks" or a lone "please" never does
    return slots.length === 1 && AFFIRM ? slots[0] : null;
  }
  const named = WEEKDAYS.some((_, i) => namesWeekday(rest, i));
  if (named && !/\d/.test(rest)) return null; // a day alone is a question about that day, not a pick
  const got = pickSlot(rest, slots);
  if (!got) return null;
  if (named) { // "Thursday at 9am" books only a slot that is at exactly that time
    const ck = requestedClock(rest) || bareHourOf(rest);
    if (ck && (ck.minute !== 0 || ck.hour !== Number(got.slice(11, 13)))) return null;
  }
  const n = /^(?:the\s+)?(?:number\s+|option\s+|#)?([1-9])$/.exec(rest);
  if (n && slots[Number(n[1]) - 1] !== got) return null;
  return got;
}

/** Could this short customer message be choosing among times already offered? Only a strict, whole-message pick counts. */
export function picksOffered(text, slots) {
  if (!slots?.length) return false;
  if (strictPick(text, slots)) return true;
  return slots.length > 1 && /^\s*(?:yes|yeah|yep|sure|ok|okay|that works|works for me|sounds good|perfect|book it|let'?s do it)(?:[,\s]+(?:please|pls|that works|book it))?\s*[.!]*\s*$/i.test(String(text || ''));
}

/** An explicit date earlier than today ("Nov 1", "11/1"), or null. Weekday names and later dates are not past. */
export function pastDay(text, today) {
  const t = String(text || '').toLowerCase();
  const year = Number(today.slice(0, 4));
  const mon = t.match(new RegExp(`\\b(${MONTHS.map((x) => x.slice(0, 3)).join('|')})[a-z]*\\.? (\\d{1,2})(?:st|nd|rd|th)?\\b`));
  const num = t.match(/\b(\d{1,2})\/(\d{1,2})\b/);
  const mm = mon ? MONTHS.findIndex((x) => x.startsWith(mon[1])) + 1 : num ? Number(num[1]) : 0;
  const dd = mon ? Number(mon[2]) : num ? Number(num[2]) : 0;
  if (!mm || mm > 12 || !dd || dd > 31) return null;
  const date = `${year}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
  if (new Date(`${date}T00:00:00Z`).getUTCMonth() !== mm - 1) return null;
  return date < today ? date : null;
}

/** Does this offered slot fall on the day the customer named? */
export function slotOnDay(slotId, day) {
  return day.weekday ? dowOf(slotId.slice(0, 10)) === day.dow : slotId.slice(0, 10) === day.date;
}

// Indices of the offered slots that a customer's day or time words point at (empty if no day or time was mentioned).
export function slotCandidates(text, slots) {
  const t = text.toLowerCase();
  if (!slots?.length) return [];
  const byDay = new Set();
  const byTime = new Set();
  let namedAnyDay = false;
  WEEKDAYS.forEach((w, i) => {
    if (namesWeekday(t, i)) {
      namedAnyDay = true;
      slots.forEach((s, idx) => { if (slotDow(s) === i) byDay.add(idx); });
    }
  });
  // The customer named a day and none of the offered windows is on it: never fall back to the time alone,
  // because that would book a different day than the one they asked for.
  if (namedAnyDay && !byDay.size) return [];
  const tm = t.match(/\b(\d{1,2})(?::(\d{2}))?\s?(am|pm)\b/);
  if (tm) {
    let h = Number(tm[1]) % 12;
    if (tm[3] === 'pm') h += 12;
    slots.forEach((s, idx) => { if (Number(s.slice(11, 13)) === h) byTime.add(idx); });
  } else if (/\bmorning\b/.test(t)) {
    slots.forEach((s, idx) => { if (Number(s.slice(11, 13)) < 12) byTime.add(idx); });
  } else if (/\bafternoon\b/.test(t)) {
    slots.forEach((s, idx) => { if (Number(s.slice(11, 13)) >= 12) byTime.add(idx); });
  }
  if (byDay.size && byTime.size) return [...byDay].filter((i) => byTime.has(i)); // "Thursday at 1" narrows to one window
  return [...(byDay.size ? byDay : byTime)];
}

// Pick one of the offered slots from a customer's reply, or return null if unclear.
export function pickSlot(text, slots) {
  if (typeof text !== 'string') return null;
  const t = text.toLowerCase();
  if (/^\s*(?:no|nope|not)\b(?!\.)/.test(t)) return null; // a refusal is not a pick ("No. 2" with a period still is)
  if (!slots?.length) return null;
  const yes = /^(yes|yep|yeah|sure|ok|okay|that works|works for me|sounds good|perfect|book it|let'?s do it)\b/.test(t.trim());
  // The offers are numbered "1) ... 2) ...", so a bare number picks that option: "2", "2)", "#2", "number 2", "I will take 2".
  const NUMW = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
  const numWord = /^\s*(?:(?:ok(?:ay)?|yes|yeah|yep|sure)[,!.]?\s+)?(?:(?:i(?:'ll| will)? (?:take|pick|choose|want)|let'?s (?:do|go with)|go with|book|take)\s+)?(?:the\s+)?(?:number|option|choice|#)\s*(one|two|three|four|five|six)\b/.exec(t);
  if (numWord && slots[NUMW[numWord[1]] - 1]) return slots[NUMW[numWord[1]] - 1];
  const num = /^\s*(?:(?:ok(?:ay)?|yes|yeah|yep|sure)[,!.]?\s+)?(?:the\s+)?(?:#|no\.?\s*|number\s*|option\s*)?([1-9])(?:(?:st|nd|rd|th)?\s+(?:one|option|choice|slot))?\s*[.)]?\s*(?:please|pls|thanks|thank you)?\s*[.!]*\s*$/.exec(t) || /\b(?:take|pick|choose|want|go with|book)\s+(?:number\s+|option\s+|#)?([1-9])\b(?!\s*(?::|a\.?m|p\.?m))/.exec(t);
  if (num && slots[Number(num[1]) - 1]) return slots[Number(num[1]) - 1];
  const wi = wordPick(t, slots);
  if (wi) return wi;
  const candidates = slotCandidates(text, slots);
  if (candidates.length === 1) return slots[candidates[0]];
  if (candidates.length > 1) return null; // ambiguous: the caller asks which one
  if (WEEKDAYS.some((_, i) => namesWeekday(t, i))) return null; // a day that was not offered: never guess a different one
  const oi = ordIndex(t);
  if (oi >= 0 && slots[oi]) return slots[oi];
  if (yes && slots.length === 1) return slots[0]; // a bare "sure" among several offers is ambiguous: the caller asks which one
  return null;
}

/**
 * Natural ways to point at an offered slot: "the first one", "the first time you offered", "book the second", "the earliest",
 * "the last one", "that one" (only when one time was offered), "11 works", "Tuesday at 2". Ordinal dates ("the 2nd", "November 2nd",
 * "my 2nd child") are never picks, and neither is "my first time" on its own.
 */
function wordPick(t, slots) {
  const n = slots.length;
  const ORD = { first: 0, second: 1, third: 2 };
  let m = /\b(?:the\s+)?(first|second|third)\s+(?:one|option|choice|slot|time\s+(?:you|that)\s+(?:offered|mentioned|gave|listed|suggested|sent)|(?:you|that)\s+(?:offered|mentioned|gave|listed|suggested)|offered|mentioned|of those|of them)\b/.exec(t)
    || /\b(?:book|take|pick|choose|want|go with|do)\s+(?:the\s+)?(first|second|third)\b(?!\s+(?:time|visit|appointment|child|kid|day of))/.exec(t);
  if (m) return slots[ORD[m[1]]] || null;
  if (/\bthe (?:earlier|sooner) (?:one|time|option|slot)\b/.test(t) && n >= 2) return slots[0];
  if (/\bthe (?:later|latter) (?:one|time|option|slot)\b/.test(t) && n >= 2) return slots[n - 1];
  if (/\b(?:the\s+)?(?:earliest|soonest)(?:\s+(?:one|time|option|slot))?\b/.test(t) && !/\b(?:any|anything|available|openings?)\b/.test(t)) return slots[0];
  if (/\b(?:the\s+)?last\s+(?:one|option|slot|time\s+(?:you|that)\s+(?:offered|mentioned))\b|\b(?:book|take|pick|choose|go with)\s+(?:the\s+)?last\b/.test(t)) return slots[n - 1];
  if (n === 1 && /\b(?:that|this)\s+one\b|\b(?:book|take|pick|choose)\s+(?:that|it)\b/.test(t)) return slots[0];
  // A bare hour: "11 works", "the 2 one", "Tuesday at 2". The hour must match exactly one offered slot (and the named weekday, if any).
  const h = /\bthe (?:one|time|slot) at (1[0-2]|[1-9])(?::00)?\b(?!\s*(?::|a\.?m|p\.?m))/.exec(t) || /^\W*(?:the\s+)?(1[0-2]|[1-9])(?::00)?\s*(?:o'?clock\s*)?(?:works|is good|is fine|is great|sounds good|please|one)?\W*$/.exec(t) || /\b(?:on\s+)?(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)\s+at\s+(1[0-2]|[1-9])(?::00)?\b(?!\s*(?::|a\.?m|p\.?m))/.exec(t);
  if (h) {
    const hit = slots.filter((id) => (Number(id.slice(11, 13)) % 12 || 12) === Number(h[1]) && (!WEEKDAYS.some((_, i) => namesWeekday(t, i)) || WEEKDAYS.some((_, i) => namesWeekday(t, i) && slotDow(id) === i)));
    if (hit.length === 1) return hit[0];
  }
  return null;
}

function slotDow(id) {
  const [y, m, d] = id.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function declinesSlots(text) {
  return /\b(none|neither|different|another|other (day|time)|later|next week|doesn'?t work|don'?t work|can'?t make|not (good|available)|no thanks?)\b/i.test(text);
}

/**
 * A pure availability request, decided by a WHITELIST: the message may contain only availability vocabulary (days, dates, times, times of day,
 * windows, "anything", "open", "available", "do you have", "can I come", ASAP, please/thanks) and the names of the business's own services.
 * Any other content word (a symptom, a person, a document, a question about cost or access) sends the message to the AI model.
 * Several different days ("Saturday or Sunday", "Monday through Wednesday") also go to the model.
 */
const AVAIL_WORDS = new Set(('a an the i we you me my it is are was be do does can could would will to of in on at for by from and or if so ' +
  'hi hello hey please pls thanks thank anything any something sometime some open opening openings available availability avail free ' +
  'have has get got come see book schedule scheduling appointment appointments visit slot slots time times there ' +
  'today tomorrow tonight morning mornings afternoon afternoons evening evenings noon lunch midday week next this after before between around about ' +
  'asap soon soonest earliest first possible as early earlier later latest like looking need want hoping wondering check ' +
  'am pm oclock o\'clock st nd rd th january february march april may june july august september october november december ' +
  'jan feb mar apr jun jul aug sep sept oct nov dec monday tuesday wednesday thursday friday saturday sunday mon tue tues wed weds thu thur thurs fri sat sun ' +
  'what whats what\'s your thing day days').split(/\s+/));
export function isAvailabilityRequest(text, today, serviceWords = []) {
  const t = String(text || '').trim();
  if (!t || t.length > 100) return false;
  if (!(requestedDay(t, today) || windowOf(t) || /\b(?:tomorrow|today|this week|next week|asap|as soon as possible|soonest|earliest|first available|mornings?|afternoons?)\b/i.test(t))) return false;
  if (/\b(?:are you open|do you (?:open|close)|hours|closed|closing|opens?\b.*\b(?:at|until)\b)/i.test(t) && !/\b(?:openings?|availab\w*)\b/i.test(t)) return false; // hours questions are answered from the business facts
  const allowed = new Set([...AVAIL_WORDS, ...serviceWords.map((w) => String(w).toLowerCase())]);
  const words = t.toLowerCase().replace(/(\d)(am|pm)\b/g, '$1 $2').split(/[^a-z0-9'\/:]+/).filter(Boolean);
  for (const w of words) {
    if (/^\d{1,2}(?::\d{2})?$/.test(w) || /^\d{1,2}\/\d{1,2}$/.test(w) || /^\d{1,2}(?:st|nd|rd|th)$/.test(w)) continue;
    if (!allowed.has(w)) return false;
  }
  const dayNames = new Set(WEEKDAYS.filter((_, i) => namesWeekday(t.toLowerCase(), i)));
  if (dayNames.size > 1) return false;
  return true;
}
