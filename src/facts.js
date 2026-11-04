// Plain questions about the business (hours, weekends, parking, walk-ins, how long a visit takes) are answered from the
// business profile and nothing else. A detail the profile does not state is never guessed: the customer is told that a
// person will confirm it.
import { fmtClock } from './calendar.js';

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const ASKS = {
  hours: /\b(?:office|business|opening|operating|store|shop|your|the) hours\b|\bhours of operation\b|\bwhen (?:are|do) you (?:open|close)\b|\bwhat time (?:do|are) you (?:open|close)\b|\bare you (?:open|closed)\b|\bwhat are (?:the |your )?hours\b/i,
  weekend: /\b(saturdays?|sundays?|weekends?)\b/i,
  parking: /\bpark(?:ing)?\b|\bparking (?:lot|garage)\b/i,
  walkIns: /\bwalk[- ]?ins?\b|\bwithout (?:an? )?appointment\b|\bdrop[- ]?in\b|\bwalk in\b/i,
  duration: /\bhow long (?:is|does|will|would|do|should)\b[^?.!]{0,50}\b(?:exam|cleaning|appointment|visit|check-?up|consult\w*|session|meeting|take|last|haircut|color|service)\b|\blength of (?:the |an? )?(?:exam|appointment|visit|consult\w*)\b|\bhow much time\b[^?.!]{0,30}\b(?:exam|appointment|visit|take)\b/i,
};
const WEEKEND_CONTEXT = /\b(open|closed|appointments?|come in|see (?:someone|you)|available|hours|book|schedule|visit|walk|work|do you)\b/i;
const TOPIC_WORDS = { hours: 'our hours', weekend: 'our weekend hours', parking: 'parking', walkIns: 'our walk-in policy', duration: 'how long a visit takes' };

const range = (open) => `${fmtClock(open[0])} to ${fmtClock(open[1])}`;

function weekendAnswer(text, config) {
  const t = text.toLowerCase();
  const days = [];
  if (/\bsaturdays?\b/.test(t)) days.push(6);
  if (/\bsundays?\b/.test(t)) days.push(0);
  if (/\bweekends?\b/.test(t)) { if (!days.includes(6)) days.push(6); if (!days.includes(0)) days.push(0); }
  const open = config.hours.open || {};
  const parts = days.sort((a, b) => b - a).map((d) => (open[d] ? `We are open on ${DAY_NAMES[d]}s from ${range(open[d])}.` : `We are closed on ${DAY_NAMES[d]}s.`));
  return `${parts.join(' ')} Our hours are ${config.hours.text}.`;
}

/**
 * @returns {{ answers: string[], missing: string[], any: boolean }} answers are ready-to-send sentences; missing lists the
 * topics the customer asked about that the profile has no fact for (a person has to confirm those).
 */
export function factAnswers(text, config, { skipWeekend = false } = {}) {
  const answers = []; const missing = [];
  const t = String(text || '');
  const facts = config.profile?.facts || {};
  const weekend = !skipWeekend && ASKS.weekend.test(t) && WEEKEND_CONTEXT.test(t);
  if (weekend) answers.push(weekendAnswer(t, config));
  else if (ASKS.hours.test(t)) answers.push(`We are open ${config.hours.text}.`);
  for (const k of ['parking', 'walkIns', 'duration']) {
    if (!ASKS[k].test(t)) continue;
    if (facts[k]) answers.push(facts[k]); else missing.push(TOPIC_WORDS[k]);
  }
  return { answers, missing, any: answers.length > 0 || missing.length > 0 };
}

export const missingFactText = (missing) => `I do not have ${missing.join(' or ')} on file, so a teammate will confirm that for you.`;
