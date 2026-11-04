// Deterministic safety classifier. It runs BEFORE any model call, on every customer
// message, and its verdicts are enforced in code. A model cannot talk its way past it.
const COMPLAINT = [
  /\b(lawyer|attorney|lawsuit|sue you|\bsue\b|bbb|complaint|complain)\b/i,
  /\b(want|demand|need|give me|get) (a |my )?(full )?refund\b|\brefund (me|my (money|fee|payment|deposit))\b|\bmoney back\b|\bchargeback\b/i,
  /\b(unacceptable|terrible|horrible|worst|rude|incompetent|useless|garbage|disgusting|ripped? ?off|scam|fraud)\b/i,
  /\b(furious|angry|pissed|livid|fed up)\b/i,
  /\b(third|2nd|second|3rd) time (i|we)('ve| have)? (called|called you|emailed|texted)\b/i,
  /\bnobody (called|came|showed|responded)\b|\bno[- ]show\b|\bnever (came|showed)\b/i,
  /\b(damaged|ruined|botched|messed up) my\b/i,
  /!{3,}/,
];

// Generic reasons to bring in a person for any business. Business-specific topics (insurance, tax advice and so on)
// come from the profile's alwaysHuman list.
const HANDOFF = [
  /\b(speak|talk) (to|with) (a |the )?(human|person|manager|owner|supervisor|someone)\b/i,
  /\b(real person|human being)\b/i,
  /\b(cancel|reschedule|move|change) (my|the|our) (appointment|booking|visit|consultation)\b/i,
];

const INJECTION = [
  /\bignore\b.{0,30}\b(previous|prior|above|earlier|all|your|the)\b.{0,20}\b(instructions?|prompts?|rules?|messages?)\b/i,
  /\b(disregard|forget|override|bypass)\b.{0,30}\b(instructions?|rules?|guardrails?|policy|policies|price|pricing)\b/i,
  /\b(system|developer) (prompt|message|mode)\b/i,
  /\byou are now\b|\bact as\b.{0,30}\b(admin|developer|unrestricted|different)\b/i,
  /\b(reveal|show|print|repeat)\b.{0,25}\b(prompt|instructions|api key|secret|password)\b/i,
  /\bnew instructions?\b|\bjailbreak\b|\bDAN mode\b/i,
  /<\/?(system|assistant|tool|function)[^>]*>/i,
  /\bcall (the )?(function|tool)\b|\bescalate_to_human\b|\bbook_appointment\b|\bsend_reply\b/i,
  /\b(important |urgent |attention )?(note|message|instruction)s? (to|for) (the )?(ai|assistant|agent|bot|model|llm)\b/i,
  /\b(pre-?approved|pre-?authorized|already approved)\b.{0,40}\$\s?\d|\bapproved by (the )?(owner|manager|admin)\b/i,
  /\b(as|being) (an? )?(ai|assistant|bot)\b.{0,40}\byou (must|should|will|are required)\b/i,
];

// Medical or personal-safety emergencies. Same in every business: the customer is told to call 911 (or 988) and a person
// is brought in at once. This is a safety net, not a diagnosis.
const MEDICAL_911 = /\b(chest (pain|pressure|tightness)|heart attack|stroke|can'?t breathe|cannot breathe|trouble breathing|difficulty breathing|struggling to breathe|not breathing|unresponsive|unconscious|passed out|seizure|overdos(e|ed|ing)|severe(ly)? bleeding|bleeding (heavily|badly|a lot)|anaphyla\w*|allergic reaction.{0,30}(throat|swelling|breath))\b/i;
// Direct and indirect wording about ending one's life or hurting oneself. Phrases that are ordinary figures of speech
// ("dying to get in", "killing it", "die of embarrassment", "end of life planning") are not matched.
const SELF_HARM = new RegExp([
  String.raw`\bsuic\w*`,
  String.raw`\bkil{1,2}(?:ing)?\s*my\s*self\b`,
  String.raw`\b(?:end(?:ing)?|take|taking)\s+(?:my\s+(?:own\s+)?life|it\s+all)\b`,
  String.raw`\b(?:want|wanna)\s*(?:to|2)?\s*(?:die|be\s+dead)\b(?!\s+(?:laughing|of\s+embarrassment))`,
  String.raw`\bwish\s+i\s+(?:was|were)\s+dead\b`,
  String.raw`\b(?:do\s*n[o']?t|dont|do\s+not|no\s+longer)\s+want\s+to\s+(?:be\s+alive|live(?!\s+(?:in|at|near|far|with|here|there|on|by|downtown|nearby|close)\b)|go\s+on|exist)\b`,
  String.raw`\b(?:can'?t|cannot|can\s+not)\s+go\s+on(?=\s*(?:$|[.,!?;])|\s+(?:like\s+this|anymore|any\s+more|much\s+longer|without))`,
  String.raw`\bno\s+(?:reason|point)\s+(?:to|in)\s+(?:live|living|go\s+on|going\s+on|keep\s+going|be\s+alive)\b`,
  String.raw`\bbetter\s+off\s+without\s+me\b`,
  String.raw`\b(?:hurt|harm|cut)ing?\s+myself\b|\b(?:hurt|harm)\s+myself\b`,
  String.raw`\bself[\s-]?harm\w*`,
].join('|'), 'i');

// Make the text comparable before matching: fold look-alike characters, drop zero-width characters, and join letters
// that were spaced or dotted out ("i g n o r e", "i.g.n.o.r.e"). Used for the classifier only, never for what is stored.
export function normalizeForSafety(text) {
  let t = String(text || '').normalize('NFKC').replace(/[\u2018\u2019\u02BC`\u00B4]/g, "'").replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF\u00AD]/g, '');
  t = t.replace(/\b(?:[A-Za-z][ .\-_*]){3,}[A-Za-z]\b/g, (m) => m.replace(/[ .\-_*]/g, ''));
  return t;
}

const test = (list, text) => list.some((re) => re.test(text));

// A legal threat is strong on its own. Anything else needs two separate anger signals before the fast path fires.
const LEGAL_THREAT = /\b(lawyer|attorney|lawsuit|sue you|\bsue\b|bbb|chargeback)\b/i;

function shouting(text) {
  const letters = text.replace(/[^A-Za-z]/g, '');
  if (letters.length < 25) return false;
  const upper = letters.replace(/[^A-Z]/g, '').length;
  return upper / letters.length > 0.6;
}

/**
 * @param text customer message
 * @param profile the compiled business profile (urgency phrases, always-human topics, out-of-scope services)
 */
export function classify(text, profile = null) {
  const t = normalizeForSafety(text);
  // Count separate anger signals: one mild word ("terrible parking", "Thank you!!!") is not a complaint by itself.
  const anger = COMPLAINT.reduce((n, re) => n + new Set([...t.matchAll(new RegExp(re.source, 'gi'))].map((m) => m[0].toLowerCase())).size, 0) + (shouting(t) ? 2 : 0); // a long all-caps message counts as two signals
  const strong = LEGAL_THREAT.test(t) || anger >= 2;
  const topic = profile?.alwaysHuman?.find((x) => x.re?.test(t));
  const flags = {
    emergency: !!profile?.urgency?.emergencyRe?.test(t),
    complaint: strong,
    complaintWeak: !strong && anger >= 1,
    handoff: test(HANDOFF, t) || !!topic,
    outOfScope: !!profile?.outOfScopeRe?.test(t),
    injection: test(INJECTION, t),
    medical: MEDICAL_911.test(t) || SELF_HARM.test(t),
    selfHarm: SELF_HARM.test(t),
    topic: topic?.id || null,
  };
  const reasons = [];
  if (flags.medical) reasons.push('Possible medical or personal-safety emergency (the customer is told to call 911)');
  if (flags.emergency) reasons.push(`${profile.urgency.label} wording (urgent situation that needs a person now)`);
  if (flags.complaint) reasons.push('Complaint or angry customer');
  else if (flags.complaintWeak) reasons.push('Mild complaint wording (one signal only; the assistant decides, no automatic handoff)');
  if (flags.handoff) reasons.push(topic ? `Customer raised ${topic.label}, which always goes to a person` : 'Customer needs a person (schedule change or asked for a human)');
  if (flags.outOfScope) reasons.push('Request is outside the services the agent schedules');
  if (flags.injection) reasons.push('Message tries to give the agent instructions (possible prompt injection)');
  return { ...flags, reasons, any: reasons.length > 0 };
}

// Wording that asks to change or cancel something already booked. Only used once a booking exists.
export const CHANGE_REQUEST = /\b(reschedul\w*|cancel\w*|change (it|that|this|the|my|our|to)|move (it|that|this|the|my|our)|push (it|that) back|switch (it|that|to))\b/i;

// Which flags force a human, regardless of what a model decides.
export function mustEscalate(f) {
  return f.complaint || f.handoff || f.outOfScope || f.injection || f.emergency || f.medical;
}
