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
  const explicit = mon ? iso(MONTHS.findIndex((x) => x.startsWith(mon[1])) + 1, Number(mon[2])) : num ? iso(Number(num[1]), Number(num[2])) : null;
  if (explicit && explicit >= today) return { date: explicit, dow: dowOf(explicit), weekday: false };
  for (let i = 0; i < 7; i += 1) {
    const date = addDay(today, i);
    if (namesWeekday(t, dowOf(date))) return { date, dow: dowOf(date), weekday: true };
  }
  return null;
}

/**
 * The clock hour (0-23) the customer asked for, or null. Understands "9am", "at 1 pm", "10:00 am", "at 14:00". A time with minutes
 * other than :00 gives null (appointments start on the hour). "9 year old", dates and prices are not times.
 */
export function requestedHour(text) {
  const t = String(text || '').toLowerCase();
  let m = /\b(1[0-2]|0?[1-9])(?::([0-5]\d))?\s?([ap])\.?m\b/.exec(t);
  if (m) {
    if (m[2] && m[2] !== '00') return null;
    return (Number(m[1]) % 12) + (m[3] === 'p' ? 12 : 0);
  }
  m = /\bat (1[0-9]|2[0-3]|0?[7-9]):00\b/.exec(t);
  if (m) return Number(m[1]);
  return null;
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
  const t = text.toLowerCase();
  if (!slots?.length) return null;
  const yes = /^(yes|yep|yeah|sure|ok|okay|that works|works for me|sounds good|perfect|book it|let'?s do it)\b/.test(t.trim());
  // The offers are numbered "1) ... 2) ...", so a bare number picks that option: "2", "2)", "#2", "number 2", "I will take 2".
  const num = /^\s*(?:#|no\.?\s*|number\s*|option\s*)?([1-9])\s*[.)]?\s*(?:please|pls|thanks|thank you)?\s*[.!]*\s*$/.exec(t) || /\b(?:take|pick|choose|want|go with|book)\s+(?:number\s+|option\s+|#)?([1-9])\b(?!\s*(?::|a\.?m|p\.?m))/.exec(t);
  if (num && slots[Number(num[1]) - 1]) return slots[Number(num[1]) - 1];
  const candidates = slotCandidates(text, slots);
  if (candidates.length === 1) return slots[candidates[0]];
  if (candidates.length > 1) return null; // ambiguous: the caller asks which one
  if (WEEKDAYS.some((_, i) => namesWeekday(t, i))) return null; // a day that was not offered: never guess a different one
  const oi = ordIndex(t);
  if (oi >= 0 && slots[oi]) return slots[oi];
  if (yes) return slots[0];
  return null;
}

function slotDow(id) {
  const [y, m, d] = id.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function declinesSlots(text) {
  return /\b(none|neither|different|another|other (day|time)|later|next week|doesn'?t work|don'?t work|can'?t make|not (good|available)|no thanks?)\b/i.test(text);
}
