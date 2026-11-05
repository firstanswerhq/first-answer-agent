import { timeProblem } from './timecheck.js';
// Outbound message guard. Every text that reaches a customer (the model's or the software's) passes through checkOutbound.
// It checks: text tricks, instruction echoes, tool or markup text, links and contact details, promises and free offers, prices,
// and claims that an appointment is booked, changed or cancelled when it is not.
import { money } from './util.js';
import { requestedClock } from './extract.js';

// ---- 1. normalize: the guards look at what a person would read, not at how it is encoded ----
const INVISIBLE = /[​-‏‪-‮⁠-⁤﻿­᠎]/g;
const LOOKALIKE = { а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', х: 'x', у: 'y', і: 'i', ј: 'j', к: 'k', м: 'm', н: 'h', т: 't', в: 'b', ѕ: 's', ԁ: 'd', ɡ: 'g', ο: 'o', ν: 'v', α: 'a', ρ: 'p' };
/** The text as a person reads it: NFKC, no zero-width or format characters, Cyrillic or Greek look-alikes folded, spaces collapsed. */
export function cleanOutbound(text) {
  return String(text ?? '').normalize('NFKC').replace(INVISIBLE, '').replace(/[Ѐ-ӿͰ-Ͽɐ-ʯ]/g, (c) => LOOKALIKE[c.toLowerCase()] || c).replace(/\s+/g, ' ').trim();
}

const BANNED = /\b(discount|refund|guarantee[sd]?|price[- ]match|warranty|coupon|waive[sd]?|promo(tion)? code|\d+\s?% off|free of charge|no charge|on the house)\b/i;
// "free" used as an offer. "free parking" is a fact, not an offer, and is allowed.
const FREE_OFFER = /\bfor free\b|\bcomplimentary\b|\bno[- ]cost\b|\bat no (?:charge|cost)\b|\bwithout (?:any )?charge\b|\bfree (?:visit|consult\w*|cleaning|whitening|exam\w*|check-?up|appointment|service|quote|estimate|session|haircut|color|colour|x-?rays?|work|trial|treatment|style|blowout|return|prep\w*)\b|\b(?:visit|consult\w*|cleaning|whitening|exam\w*|check-?up|appointment|service|quote|estimate|session|haircut|treatment|x-?rays?|trial|work|style|blowout|prep\w*|first one|first time)s?\b[^.!?]{0,30}?\b(?:is|are|will be|would be|be) (?:totally |completely |absolutely )?free\b(?! (?:to|of the|parking)\b)|\b(?:it|that|this)(?:'s| is| will be| would be) (?:totally |completely |absolutely )?free\b(?! (?:to|of the|parking)\b)|\b(?:you can|you'll|you will|we'll|we will) (?:get|have|receive) (?:it|that|this) (?:for )?free\b|\beverything(?: is)? free\b/i;
const LEAK = /system prompt|my instructions|developer message|api[- ]?key|VULTR_|as an ai language model/i;
const NUMW = '(?:zero|oh|one|two|three|four|five|six|seven|eight|nine)';

const UNSAFE_TEXT = [
  ['injection', /\b(?:ignor|disregard|forget|overrid|bypass|dismiss)\w*\b[^.!?]{0,60}\b(?:instructions?|prompts?|rules?|guidelines|guardrails?|programming|directives?|system message)\b/i, 'Message echoes an instruction override.'],
  ['injection', /\b(?:ignora\w*|olvida\w*|ignorez?|oubliez?|ignorier\w*|vergiss\w*|vergesst|missachte\w*|ignorare|dimentica\w*)\b[^.!?]{0,60}\b(?:instrucciones|instruccion|reglas|instructions|consignes|r[eè]gles|anweisungen|befehle|regeln|istruzioni)\b/i, 'Message echoes an instruction override.'],
  ['injection', /\b(?:developer|jailbreak|dan|god) mode\b|as an ai(?: language)? model|\bi am (?:now )?(?:in|an?) (?:unrestricted|unfiltered)\b|\bunrestricted mode\b/i, 'Message echoes an instruction override.'],
  ['json', /^\s*[{[]|"\s*(?:tool|tool_calls?|function|arguments|name)\s*"\s*:/i, 'Message looks like JSON or a tool call, not a message for a customer.'],
  ['tool_text', /\b(?:send_reply|qualify_lead|check_calendar|book_appointment|schedule_followup|escalate_to_human|tool[_ ]call|function[_ ]call)\b/i, 'Message mentions internal tools.'],
  ['markup', /<\/?\s*[a-z!][^>]*>|<\/?\s*(?:script|think|thinking|reasoning)\b/i, 'Message contains markup.'],
  ['reasoning', /^\s*(?:thinking|thoughts?|reasoning|analysis|scratchpad)\s*[:>-]/im, 'Message contains reasoning text.'],
];
// Links, bare domains and written-out addresses. "Dr. Lee" and "9.30" are not domains (the ending must be a known web ending).
const TLD = '(?:com|net|org|io|co|us|info|biz|app|dev|me|ly|xyz|online|site|store|shop|example|test|invalid|localhost|ai|gov|edu|ca|uk|de|ru|cn|tk|cc|tv|link|click|top|club|page|website|tech|cloud|live|fyi)';
const LINKS = [
  /https?:\/\/|www\.|\bh(?:xx|tt)ps?\b|ftp:\/\//i,
  new RegExp(`(?<![\\w.@-])[a-z0-9][a-z0-9-]*(?:\\.[a-z0-9-]+)*\\.${TLD}\\b(?![a-z0-9])`, 'i'),
  /\b[a-z0-9-]{2,}\.[a-z]{2,}\/\S*/i,
  /\[\s*(?:at|dot)\s*\]|\(\s*(?:at|dot)\s*\)|\{\s*(?:at|dot)\s*\}/i,
  new RegExp(`\\b[\\w-]+ dot ${TLD}\\b|\\b[\\w.-]+ at [\\w-]+ dot \\w+\\b`, 'i'),
  new RegExp(`(?:\\b${NUMW}\\b[\\s,.-]*){7,}`, 'i'),
];
const digitsOf = (v) => String(v || '').replace(/\D/g, '').slice(-10);

// ---- prices: digits, symbols and number words ----
const ONES = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
function wordsToNumber(s) {
  let total = 0; let cur = 0; let any = false;
  for (const w of s.toLowerCase().trim().split(/[\s-]+/)) {
    if (w in ONES) { cur += ONES[w]; any = true; } else if (w in TENS) { cur += TENS[w]; any = true; } else if (w === 'hundred') { cur = (cur || 1) * 100; any = true; } else if (w === 'thousand') { total += (cur || 1) * 1000; cur = 0; any = true; } else if (w === 'and' || w === 'a') continue; else return null;
  }
  return any ? total + cur : null;
}
const NW = `(?:${Object.keys(ONES).join('|')}|${Object.keys(TENS).join('|')}|hundred|thousand)`;
const MONEY_WORD = new RegExp(`\\b((?:${NW}(?:[\\s-]+(?:and[\\s-]+)?)?)+)\\s*(?:dollars?|bucks|usd)\\b`, 'gi');
function amountsIn(text) {
  const out = [];
  for (const m of text.matchAll(/(?:[$€£]|\busd\s?)\s?([\d,]+(?:\.\d{1,2})?)|\b([\d,]+(?:\.\d{1,2})?)\s?(?:dollars?|bucks|usd|eur|euros?|gbp|pounds)\b/gi)) out.push(Number((m[1] || m[2]).replace(/,/g, '')));
  for (const m of text.matchAll(MONEY_WORD)) { const n = wordsToNumber(m[1]); if (n != null) out.push(n); }
  // "one-fifty" (150): a hundreds digit then a tens word, not a clock time
  for (const m of text.matchAll(/\b(one|two|three|four|five|six|seven|eight|nine)[- ](twenty|forty|fifty|sixty|seventy|eighty|ninety)\b(?!\s*(?:a\.?m|p\.?m|o'?clock|minutes?|mins?|years?|hours?|pm|am))/gi)) out.push(ONES[m[1].toLowerCase()] * 100 + TENS[m[2].toLowerCase()]);
  return out;
}

// ---- booking claims ----
const BOOKING_CLAIM = /\b(?:booked|scheduled|reserved|secured|confirmed(?!\s+(?:at|in|by|with|after|during|once|when))|locked in|penciled in|pencilled in|all set|good to go|consider it done|on (?:the|our|my) (?:calendar|schedule|books)|put you down|(?:got|have|has) you (?:down|in|lined up)|lined you up|lined up for you|set for|signed you up|registered you|added you to|(?:is|are) (?:all )?yours|see you (?:on|at|then|soon|thursday|friday|monday|tuesday|wednesday|saturday|sunday|tomorrow|next|today|this)|you(?:'re| are) (?:in|on)\b|spot is yours|holding (?:a|the|that|your) (?:time|slot|spot))\b/i;
const NOT_A_CLAIM = /\b(?:once|until|if|when|before|after|unless|can|could|will|would|shall|should|may|might|to get you|want|wanted|like|interested|ready|not|never|cannot|unable|how|which|whether|need|needs|please|let me|going to|once you|hold|nothing|nobody)\b|n't|\?/i;
const NEGATED_BOOKED = /\b(?:fully|totally|completely) (?:booked|reserved)\b|\bbooked up\b|\bnothing (?:is|has been|was) (?:booked|scheduled|reserved)\b|\b(?:is|was) already (?:booked|taken|reserved)\b|\b(?:have|got) you down as\b|\breserved for (?:another|someone|other|a different)\b|\bnot (?:been )?(?:booked|scheduled|confirmed|reserved)\b/i;
// We will see you ...: a promise of an appointment even though "will" appears
const SEE_YOU = /\b(?:we(?:'ll| will)|i(?:'ll| will)) see you\b/i;
const CHANGE_CLAIM = /\b(?:cancel(?:l?ed|ling)?|moved|rescheduled|switched|changed (?:it|your|the)|updated your (?:appointment|booking|time)|second (?:appointment|booking)|another (?:appointment|booking)|as well)\b/i;
// A promise to look something up, with no answer in it: "let me check what's open around Tuesday". Not final.
const DANGLING = /\b(?:let me (?:check|see|look|find|pull|take a look|grab)|let'?s see|i(?:'ll| will| am going to|'m going to) (?:check|look|see|pull|get back)|one (?:moment|sec|second|minute)|just a (?:moment|sec|second|minute)|give me a (?:moment|sec|second|minute)|checking (?:now|that|the calendar|what)|hold on(?! to\b)|bear with me|looking (?:now|that up|into it))\b/i;
const TIME_TOKEN = /\b(?:1[0-2]|[1-9])(?::[0-5]\d)?\s?(?:a\.?m\b|p\.?m\b)|\b(?:1[0-9]|2[0-3]|[1-9]):[0-5]\d\b|\bnoon\b/gi;
const ANSWERS = /\b(?:is|are|was) (?:already )?(?:taken|unavailable|booked up|full|closed)\b|\bnot available\b|\bnothing (?:is )?open\b/i;
const ANSWERS_WITH_TIME = /\b(?:is|are) (?:still |already )?(?:open|available|free)\b/i; // only an answer when it names a time
const HANDOFF_OR_ASK = /\b(?:teammate|team member|someone|staff|front desk|dentist|stylist|hygienist|accountant|office|let me know|tell me)\b/i;
function danglingProblem(text) {
  if (!DANGLING.test(text)) return null;
  // Hand-offs and asks are not promises to look something up: "a teammate will follow up", "let me know which day".
  if (HANDOFF_OR_ASK.test(text)) return null;
  const times = new Set((text.match(TIME_TOKEN) || []).map((t) => t.toLowerCase().replace(/\s|\./g, '')));
  const concrete = text.includes('?') || times.size >= 2 || /\$\s?\d/.test(text) || ANSWERS.test(text) || (times.size >= 1 && ANSWERS_WITH_TIME.test(text));
  return concrete ? null : { id: 'dangling', message: 'Message promises to look something up but gives no answer. You already have the results: give the actual open times (or say the requested time is taken).' };
}

/** A reply to a scheduling request that has no time in it and only asks a question is not final: check the calendar, give times first. */
function questionOnlyProblem(text, opts) {
  if (!opts.schedulingRequest || opts.booking || opts.offeredSlots) return null;
  if (!text.includes('?') || /\b(?:1[0-2]|[1-9])(?::[0-5]\d)?\s?(?:a\.?m|p\.?m)\b|\b(?:1[0-9]|2[0-3]):[0-5]\d\b|\bnoon\b/i.test(text)) return null;
  if (TAKEN.test(text) || ANSWERS.test(text)) return null;
  return { id: 'no_times', message: 'This is a scheduling request. Call check_calendar first, then list 2-3 concrete open times (nearest first), say a requested time is taken when it is, and ask at most one short question AFTER the times. Do not reply with only a question.' };
}

/** After check_calendar, the reply must carry the open times it found, or say the asked time is taken. */
const TAKEN = /\b(?:taken|booked up|unavailable|not available|isn't available|is not available|fully booked|already booked|no openings?|nothing (?:is )?open|closed)\b/i;
export function calendarProblem(text, slotIds) {
  if (!slotIds?.length) return null;
  if (TAKEN.test(text)) return null;
  const bare = text.replace(/\$\s?[\d,.]+(?:\s?[-–]\s?\$?[\d,.]+)?/g, ' ').replace(/\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? \d{1,2}(?:st|nd|rd|th)?\b/gi, ' ').replace(/\d+[- ]year/gi, ' ').replace(/\d+(?:st|nd|rd|th)\b/gi, ' ');
  const h24 = slotIds.map((id) => Number(id.slice(11, 13)));
  const hours = new Set(h24.map((h) => h % 12 || 12));
  const nums = [...bare.matchAll(/(?<![\d:.])(1[0-2]|[1-9])(?::[0-5]\d)?(?!\d)/g)].map((m) => Number(m[1]));
  for (const m of bare.matchAll(/(?<![\d:])(1[3-9]|2[0-3]):[0-5]\d(?!\d)/g)) nums.push(Number(m[1]) % 12 || 12);
  for (const m of bare.matchAll(/(?<![\d:])(0[6-9]|1[0-9]|2[0-3])[0-5]0(?:\s?hours?)?(?!\d)/g)) if (/hours?|h\b/i.test(m[0])) nums.push(Number(m[1]) % 12 || 12);
  const WORD = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
  for (const m of bare.matchAll(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)(?: o'?clock|\s?(?:[ap]\.?m\b))/gi)) nums.push(WORD[m[1].toLowerCase()]);
  if (nums.some((n) => hours.has(n))) return null;
  // "noon", "Thursday morning is open": acceptable when an open time falls in that part of the day
  if (/\bnoon\b|\bmidday\b/i.test(bare) && hours.has(12)) return null;
  if (/\bmorning\b/i.test(bare) && h24.some((h) => h < 12)) return null;
  if (/\bafternoon\b/i.test(bare) && h24.some((h) => h >= 12 && h < 17)) return null;
  if (/\bevening\b/i.test(bare) && h24.some((h) => h >= 17)) return null;
  return { id: 'no_times', message: 'You checked the calendar but the reply does not give any of the open times. State the actual open times from check_calendar (or say the requested time is taken).' };
}

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const clausesOf = (text) => text.split(/(?<=[.!?])\s+|\n+|[;:]|,|\s[-–—]\s|\bbut\b|\band\b/i).map((c) => c.trim()).filter(Boolean);

// Past-tense claims that something was cancelled, moved or changed. The assistant has no such power, booking or not.
const PAST_CHANGE = /\b(?:cancel(?:l?ed)|moved|rescheduled|re-scheduled|switched|changed|updated)\b/i;
const CHANGE_OBJECT = /\b(?:appointment|booking|visit|reservation|slot|it|you|your|that|this|time|session)\b/i;
// "Our hours changed", "prices were updated", "that time was updated in our calendar" are about the business, not the customer's appointment.
const ABOUT_BUSINESS = /\b(?:hours|prices?|pricing|rates?|fees?|polic(?:y|ies)|menu|website|location|address|calendar|schedule|holiday)\b/i;
const ABOUT_CUSTOMER = /\b(?:your|you(?:'re| are)?)\b.{0,20}\b(?:appointment|booking|visit|reservation|session|slot)\b|\bcancel(?:l?ed)\b/i;
function changeProblem(text) {
  for (const c of clausesOf(text)) {
    if (PAST_CHANGE.test(c) && CHANGE_OBJECT.test(c) && !NOT_A_CLAIM.test(c) && !NEGATED_BOOKED.test(c) && !(ABOUT_BUSINESS.test(c) && !ABOUT_CUSTOMER.test(c))) return { id: 'booking_change', message: 'Message says an appointment was changed or cancelled, but this assistant cannot do that. A teammate handles changes.' };
  }
  return null;
}

// "I'll lock it in", "I'm holding that for you": a promise to hold a time. Only fine as a conditional offer ("just confirm and I'll lock it in").
const LOCK = /\b(?:i(?:'ve| have|'m| am|'ll| will)|we(?:'ve| have|'re| are|'ll| will))\s+(?:now\s+|already\s+|just\s+|also\s+)?(?:locked|lock|locking|holding|hold|held|reserved|reserve|reserving|penciled|pencilled|pencil)\s+(?:it|that|this|you|(?:that|the|this|your)(?: [\w:]+(?: [ap]m)?){0,3} (?:time|slot|spot|appointment|visit))\b(?:\s+(?:in|down|for you))?|\b(?:it|that|this) (?:is|has been) (?:held|locked|reserved)(?: for you)?\b|\b(?:that|the|this|your) (?:time|slot|spot|appointment) (?:is|has been) (?:locked|held|reserved)\b/i;
const COND = /\b(?:confirm|if you|once you|when you|just say|just reply|reply|let me know|want me to|would you like|shall i|should i|can i|may i|tell me|say yes|up to you)\b|\?/i;
function lockClaim(text) {
  return text.split(/(?<=[.!?])\s+|\n+/).some((sen) => LOCK.test(sen) && !COND.test(sen) && !NEGATED_BOOKED.test(sen) && !/\b(?:cannot|can't|unable|not|never|won't)\b/i.test(sen));
}

function bookingProblem(text, opts) {
  const claimClause = (c) => (BOOKING_CLAIM.test(c) || SEE_YOU.test(c)) && !NEGATED_BOOKED.test(c) && (SEE_YOU.test(c) || !NOT_A_CLAIM.test(c));
  if (opts.booked === false) {
    // Sentence by sentence first, then clause by clause: a negation in another clause does not excuse a claim.
    if (clausesOf(text).some(claimClause) || lockClaim(text)) return { id: 'booking_claim', message: 'Message says an appointment is booked or confirmed, but no appointment has been booked for this customer. Offer times with check_calendar and book only when they choose one.' };
    return opts.model ? changeProblem(text) : null;
  }
  const b = opts.booking;
  if (!b) return opts.model ? changeProblem(text) : null;
  // The customer already has a booking. This assistant cannot change, cancel or add one, so any such claim is false.
  { const cp = changeProblem(text); if (cp) return cp; }
  for (const c of clausesOf(text)) {
    if (CHANGE_CLAIM.test(c) && !NOT_A_CLAIM.test(c.replace(/\bas well\b/i, '')) && !NEGATED_BOOKED.test(c)) return { id: 'booking_change', message: 'Message says an appointment was changed, cancelled or added, but this assistant cannot do that. A teammate handles changes.' };
    if (CHANGE_CLAIM.test(c) && /\bas well\b|\banother\b|\bsecond\b/i.test(c) && !NOT_A_CLAIM.test(c.replace(/\bas well\b/i, ''))) return { id: 'booking_change', message: 'Message says a second appointment was made, but only one exists.' };
    if (claimClause(c)) {
      // Names a different day or time than the real booking
      const dow = new Date(`${String(b.slot_id).slice(0, 10)}T12:00:00Z`).getUTCDay();
      const named = DAYS.filter((d) => new RegExp(`\\b${d}\\b`, 'i').test(c));
      if (named.length && !named.includes(DAYS[dow])) return { id: 'booking_claim', message: 'Message confirms a different day than the real booking.' };
      const clock = requestedClock(c);
      if (clock && (clock.hour !== Number(String(b.slot_id).slice(11, 13)) || clock.minute !== 0)) return { id: 'booking_claim', message: 'Message confirms a different time than the real booking.' };
    }
  }
  return null;
}

/** Like checkOutbound, but returns { id, message } so the reason can be counted (ids never contain message text). */
export function checkOutboundRule(rawText, lead, opts = {}) {
  const text = cleanOutbound(rawText);
  for (const [id, re, msg] of UNSAFE_TEXT) if (re.test(text)) return { id, message: `${msg} Write a short plain message for the customer.` };
  if (LINKS.some((re) => re.test(text))) return { id: 'link', message: 'Messages may not contain links, web addresses or spelled-out contact details.' };
  // Phone numbers and email addresses that are not the business's or the lead's own are never repeated.
  const own = new Set([digitsOf(lead?.phone), ...(opts.ownPhones || []).map(digitsOf)].filter((d) => d.length === 10));
  const foreign = [...text.matchAll(/\+?\d[\d\s().-]{8,}\d/g)].map((m) => digitsOf(m[0])).find((d) => d.length === 10 && !own.has(d));
  if (foreign || /[\w.+-]+@[\w-]+\.[\w.-]+/.test(text)) return { id: 'contact', message: 'Message repeats a phone number or email address that is not the business contact. Leave it out.' };
  const bp = bookingProblem(text, opts);
  if (bp) return bp;
  if (opts.model) { const d = danglingProblem(text); if (d) return d; const qo = questionOnlyProblem(text, opts); if (qo) return qo; if (opts.timeCheck) { const tp = timeProblem(text, opts.timeCheck); if (tp) return tp; } if (opts.offeredSlots) { const c = calendarProblem(text, opts.offeredSlots); if (c) return c; } }
  const freeOk = (lead?.qualification?.priceRange?.high ?? 1) === 0; // a service the profile explicitly prices at zero
  if (BANNED.test(text) || (!freeOk && FREE_OFFER.test(text))) return { id: BANNED.test(text) ? 'promise' : 'free_offer', message: 'Message makes a promise the agent may not make (discount, refund, guarantee, warranty or free work). Rephrase, or escalate_to_human.' };
  if (LEAK.test(text)) return { id: 'leak', message: 'Message appears to reveal internal instructions.' };
  const amounts = amountsIn(text);
  if (amounts.length) {
    let ranges = [lead?.qualification?.priceRange, lead?.qualification?.alsoPriceRange].filter(Boolean);
    // Before qualify_lead ran, any approved range from the price book may be quoted (for example a duration answer that mentions the usual cost).
    if (!lead?.qualification && opts.knownRanges?.length) ranges = opts.knownRanges;
    if (!ranges.length) return { id: 'price', message: 'No price may be quoted for this service. Say the cost is confirmed in person, or escalate_to_human.' };
    const bad = amounts.find((a) => !ranges.some((pr) => a >= pr.low && a <= pr.high));
    if (bad !== undefined) return { id: 'price', message: `Price ${money(bad)} is outside the price book range${ranges.length > 1 ? 's' : ''} ${ranges.map((pr) => `${money(pr.low)}-${money(pr.high)}`).join(' and ')}. Quote only ${ranges.length > 1 ? 'those ranges' : 'that range'} or escalate_to_human.` };
  }
  return null;
}

export function checkOutbound(text, lead, opts = {}) {
  return checkOutboundRule(text, lead, opts)?.message ?? null;
}
