// Lightweight text understanding used by the offline rules engine and as a cross-check.
import { SERVICE_AREA } from './config.js';

export function detectJob(text) {
  const t = text.toLowerCase();
  if (/\bgutter/.test(t)) return /\b(sag|pull(ed|ing)? (away|off)|repair|fix|replace|broken|hang)/.test(t) ? 'gutter_repair' : 'gutter_cleaning';
  if (/\b(new roof|roof replacement|re-?roof|replace (the |my |our )?roof)/.test(t)) return 'roof_replacement';
  if (/\broof\b|\bceiling\b|\bshingle/.test(t) && /\b(leak|leaking|drip|water|stain|rain|wet)/.test(t)) return 'roof_leak';
  if (/\broof|\bshingle|\bflashing|storm damage/.test(t)) return 'roof_repair';
  if (/\bwater heater|hot water (tank|heater)/.test(t)) return 'water_heater';
  if (/\b(drain|clog+ed?|garbage disposal|toilet|backed up)\b/.test(t)) return 'drain_clog';
  if (/\b(pipe|faucet|plumb|sink|leaking|leak)\b/.test(t)) return 'plumbing_leak';
  if (/\bmove[- ]?(out|in)\b/.test(t) && /clean/.test(t)) return 'move_out_cleaning';
  if (/\bdeep clean/.test(t)) return 'deep_cleaning';
  if (/\bclean(ing|er|ers)?\b|\bmaid\b/.test(t)) return 'house_cleaning';
  return 'other';
}

export function detectSize(text, job) {
  const t = text.toLowerCase();
  if (/\b(1|one|single)[- ]story\b|\bsmall\b|\bstudio\b|\bone (spot|room)\b|\btiny\b|\b1[- ]bed(room)?\b/.test(t)) return 'small';
  if (/\b(3|three)[- ]story\b|\b(large|big|huge|whole|entire|multiple|several|mansion)\b|\b([4-9]|four|five)[- ]bed(room)?s?\b/.test(t)) return 'large';
  if (/\b(2|two)[- ]stor(y|ey)\b|\bmedium\b|\b(2|two|3|three)[- ]bed(room)?s?\b/.test(t)) return 'medium';
  const sq = t.match(/(\d{3,5})\s*(sq|square)/);
  if (sq && job) {
    const n = Number(sq[1]);
    return n < 1200 ? 'small' : n < 2600 ? 'medium' : 'large';
  }
  return 'unknown';
}

export function detectLocation(text) {
  const zip = text.match(/\b(37\d{3}|3[0-9]{4}|[0-9]{5})\b/);
  const lower = text.toLowerCase();
  const city = [...SERVICE_AREA.cities].sort((a, b) => b.length - a.length).find((c) => lower.includes(c.toLowerCase()));
  const outside = SERVICE_AREA.outside.find((c) => lower.includes(c.toLowerCase()));
  if (outside && !city) return { text: outside, known: true, inArea: false };
  if (zip) {
    return { text: zip[1], known: true, inArea: SERVICE_AREA.zips.includes(zip[1]) || (!!city) };
  }
  if (city) return { text: city, known: true, inArea: true };
  return { text: '', known: false, inArea: null };
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

// Pick one of the offered slots from a customer's reply, or return null if unclear.
export function pickSlot(text, slots) {
  const t = text.toLowerCase();
  if (!slots?.length) return null;
  const yes = /^(yes|yep|yeah|sure|ok|okay|that works|works for me|sounds good|perfect|book it|let'?s do it)\b/.test(t.trim());
  const candidates = new Set();
  WEEKDAYS.forEach((w, i) => {
    if (t.includes(w) || t.includes(w.slice(0, 3) + ' ') || new RegExp(`\\b${w.slice(0, 3)}\\b`).test(t)) {
      slots.forEach((s, idx) => { if (slotDow(s) === i) candidates.add(idx); });
    }
  });
  const tm = t.match(/\b(\d{1,2})(?::(\d{2}))?\s?(am|pm)\b/);
  if (tm) {
    let h = Number(tm[1]) % 12;
    if (tm[3] === 'pm') h += 12;
    slots.forEach((s, idx) => { if (Number(s.slice(11, 13)) === h) candidates.add(idx); });
  } else if (/\bmorning\b/.test(t)) {
    slots.forEach((s, idx) => { if (Number(s.slice(11, 13)) < 12) candidates.add(idx); });
  } else if (/\bafternoon\b/.test(t)) {
    slots.forEach((s, idx) => { if (Number(s.slice(11, 13)) >= 12) candidates.add(idx); });
  }
  if (candidates.size === 1) return slots[[...candidates][0]];
  if (candidates.size > 1) return null; // ambiguous: ask again
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
