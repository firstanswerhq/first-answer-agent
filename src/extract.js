// Lightweight text understanding used by the offline rules engine and as a cross-check.

/** Which of the profile's services the text is about, or 'other'. Services are tried in the order the profile lists them. */
export function detectService(text, config) {
  const t = String(text || '');
  for (const svc of config.services) if (svc.re?.test(t)) return svc.id;
  return 'other';
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

const ORD = [
  [/\b(first|1st|option 1|#1|number 1|one)\b/i, 0],
  [/\b(second|2nd|option 2|#2|number 2|two)\b/i, 1],
  [/\b(third|3rd|option 3|#3|number 3|three)\b/i, 2],
];
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

// Indices of the offered slots that a customer's day or time words point at (empty if no day or time was mentioned).
export function slotCandidates(text, slots) {
  const t = text.toLowerCase();
  if (!slots?.length) return [];
  const byDay = new Set();
  const byTime = new Set();
  WEEKDAYS.forEach((w, i) => {
    if (t.includes(w) || new RegExp(`\\b${w.slice(0, 3)}\\b`).test(t)) {
      slots.forEach((s, idx) => { if (slotDow(s) === i) byDay.add(idx); });
    }
  });
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
  const candidates = slotCandidates(text, slots);
  if (candidates.length === 1) return slots[candidates[0]];
  if (candidates.length > 1) return null; // ambiguous: the caller asks which one
  for (const [re, idx] of ORD) if (re.test(t) && slots[idx]) return slots[idx];
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
