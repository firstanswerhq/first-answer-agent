// Plain questions about the business (hours, weekends, parking, walk-ins, how long a visit takes) are answered from the
// business profile and nothing else. A detail the profile does not state is never guessed: the customer is told that a
// person will confirm it. The wording of shipped facts is SAMPLE content (see README).
import { fmtClock, localNow, dow, dateOf, timeOf, isOpenNow } from './calendar.js';

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const ASKS = {
  hours: /\b(?:office|business|opening|operating|store|shop|your|the) hours\b|\bhours of operation\b|\bwhen (?:are|do) you (?:open|close)\b|\bwhat time (?:do|are) you (?:open|close)\b|\bare you (?:open|closed)\b|\bwhat are (?:the |your )?hours\b/i,
  openNow: /\bare you (?:open|closed)\b[^?.!]{0,30}\b(?:now|right now|today|tonight|this (?:morning|afternoon|evening))\b|\b(?:open|closed) (?:right )?(?:now|today|tonight)\b/i,
  weekend: /\b(saturdays?|sundays?|weekends?)\b/i,
  parking: /\bparking\b|\bwhere (?:do|can|should|would|will) (?:i|we|you|people|patients|customers|clients) park\b|\bwhere to park\b|\b(?:can|do) (?:i|we) park\b|\bpark (?:my|our|the) (?:car|truck|van|bike)\b/i,
  walkIns: /\bwalk[- ]?ins?\b|\bwithout (?:an? )?appointment\b|\bdrop[- ]?in\b|\bwalk in\b/i,
  duration: /\bhow long (?:is|does|will|would|do|should)\b[^?.!]{0,50}\b(?:exam|cleaning|appointment|visit|check-?up|consult\w*|session|meeting|haircut|service)\b|\blength of (?:the |an? )?(?:exam|appointment|visit|consult\w*)\b|\bhow long (?:does|will|would) (?:it|that|this) take\b|\bhow long (?:does|is|will) (?:a|an|the|my)\b[^?.!]{0,40}\btake\b/i,
};
// A "how long" question about a specific job is not the length of the standard visit, so it is not answered with it.
const OTHER_JOB = /\b(?:tax|return|filing|file|payroll|setup|set up|whitening|treatment|keratin|braces|aligner|color|colour|highlights|balayage|extensions|bookkeeping|llc|audit|root canal|crown|filling|implant|extraction)\b/i;
const WEEKEND_CONTEXT = /\b(open|closed|appointments?|come in|see (?:someone|you)|available|hours|book|do you)\b/i;
// Questions the profile has no facts for. They are acknowledged honestly: a teammate will confirm.
const UNKNOWN = [
  [/\b(?:your|the office'?s?|clinic'?s?|salon'?s?|shop'?s?) address\b|\bwhat(?:'s| is) the address\b|\bwhere (?:are you|is (?:the |your )?(?:office|clinic|salon|shop)) (?:located|at)\b|\bwhere are you (?:located|at)\b|\bhow do i get (?:there|to you)\b|\bdirections\b/i, 'our address'],
  [/\b(?:thanksgiving|christmas|easter|new year'?s?|memorial day|labor day|independence day|july (?:4|4th|fourth)|holidays?)\b(?=[\s\S]*\b(?:open|closed|hours)\b)|\b(?:open|closed|hours)\b[\s\S]*\b(?:thanksgiving|christmas|easter|new year'?s?|memorial day|labor day|independence day|july (?:4|4th|fourth)|holidays?)\b/i, 'holiday hours'],
  [/\b(?:credit|debit) cards?\b|\bpayment (?:methods?|options)\b|\bdo you (?:take|accept) (?:cash|checks?|visa|mastercard|amex|apple pay|venmo|zelle|cards?)\b|\bfinancing\b|\bcarecredit\b|\b(?:hsa|fsa)\b/i, 'our accepted payment methods'],
  [/\bpharmac(?:y|ies)\b/i, 'nearby pharmacies'],
  [/\bwheelchair\b|\baccessib(?:le|ility)\b|\belevator\b/i, 'accessibility details'],
];
const TOPIC_WORDS = { hours: 'our hours', weekend: 'our weekend hours', parking: 'parking', walkIns: 'our walk-in policy', duration: 'the length of a visit' };

const range = (open) => `${fmtClock(open[0])} to ${fmtClock(open[1])}`;

function weekendAnswer(text, config) {
  const t = text.toLowerCase();
  const days = [];
  if (/\bsaturdays?\b/.test(t)) days.push(6);
  if (/\bsundays?\b/.test(t)) days.push(0);
  if (/\bweekends?\b/.test(t)) { if (!days.includes(6)) days.push(6); if (!days.includes(0)) days.push(0); }
  const open = config.hours.open || {};
  const sorted = days.sort((a, b) => b - a);
  const closed = sorted.filter((d) => !open[d]);
  const parts = [];
  if (closed.length === sorted.length && sorted.length > 1) parts.push(`We are closed on ${DAY_NAMES[6]}s and ${DAY_NAMES[0]}s.`);
  else sorted.forEach((d) => parts.push(open[d] ? `We are open on ${DAY_NAMES[d]}s from ${range(open[d])}.` : `We are closed on ${DAY_NAMES[d]}s.`));
  return `${parts.join(' ')} Our hours are ${config.hours.text}.`;
}

// "Are you open now / today?" answered from the weekly hours and the clock in the business time zone. No holiday calendar is known.
function openNowAnswer(config, nowMs) {
  const local = localNow(nowMs, config.business.tz);
  const w = config.hours.open?.[dow(dateOf(local))];
  const t = timeOf(local);
  if (!w) return `We are closed today. Our hours are ${config.hours.text}.`;
  if (isOpenNow(local, config.hours)) return `Yes, we are open right now, until ${fmtClock(w[1])} today.`;
  if (t < w[0]) return `Not yet. We open at ${fmtClock(w[0])} today. Our hours are ${config.hours.text}.`;
  return `We are closed for the day. Our hours are ${config.hours.text}.`;
}

/**
 * @returns {{ answers: string[], missing: string[], any: boolean }} answers are ready-to-send sentences; missing lists the
 * topics the customer asked about that the profile has no fact for (a person has to confirm those).
 */
export function factAnswers(text, config, { skipWeekend = false, nowMs = Date.now() } = {}) {
  const answers = []; const missing = [];
  const t = String(text || '');
  const facts = config.profile?.facts || {};
  const weekend = !skipWeekend && ASKS.weekend.test(t) && WEEKEND_CONTEXT.test(t);
  if (ASKS.openNow.test(t)) answers.push(openNowAnswer(config, nowMs));
  else if (weekend) answers.push(weekendAnswer(t, config));
  else if (ASKS.hours.test(t)) answers.push(`We are open ${config.hours.text}.`);
  for (const k of ['parking', 'walkIns', 'duration']) {
    if (!ASKS[k].test(t)) continue;
    if (k === 'duration' && OTHER_JOB.test(t)) { missing.push('the length of that service'); continue; }
    if (facts[k]) answers.push(facts[k]); else missing.push(TOPIC_WORDS[k]);
  }
  for (const [re, label] of UNKNOWN) if (re.test(t)) missing.push(label);
  return { answers, missing, any: answers.length > 0 || missing.length > 0 };
}

export const missingFactText = (missing) => `I do not have ${missing.join(' or ')} on file, so a teammate will confirm that for you.`;

// US federal holidays plus Christmas Eve. The business calendar has no holiday concept, so a request for one of these
// days is never confirmed as "open": a teammate confirms holiday hours.
export function holidayName(date) {
  const [y, m, d] = date.split('-').map(Number);
  const w = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const nth = (n) => Math.ceil(d / 7) === n && true;
  const last = d + 7 > new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (m === 1 && d === 1) return "New Year's Day";
  if (m === 1 && w === 1 && nth(3)) return 'Martin Luther King Jr. Day';
  if (m === 2 && w === 1 && nth(3)) return "Presidents' Day";
  if (m === 5 && w === 1 && last) return 'Memorial Day';
  if (m === 6 && d === 19) return 'Juneteenth';
  if (m === 7 && d === 4) return 'Independence Day';
  if (m === 9 && w === 1 && nth(1)) return 'Labor Day';
  if (m === 10 && w === 1 && nth(2)) return 'Columbus Day';
  if (m === 11 && d === 11) return 'Veterans Day';
  if (m === 11 && w === 4 && nth(4)) return 'Thanksgiving';
  if (m === 12 && d === 24) return 'Christmas Eve';
  if (m === 12 && d === 25) return 'Christmas Day';
  return null;
}
