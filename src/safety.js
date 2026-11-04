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
  /\bcall (the )?(function|tool)\b|\bescalate_to_human\b|\bbook_(job|appointment)\b|\bsend_reply\b/i,
];

const test = (list, text) => list.some((re) => re.test(text));

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
  const t = String(text || '');
  const topic = profile?.alwaysHuman?.find((x) => x.re?.test(t));
  const flags = {
    emergency: !!profile?.urgency?.emergencyRe?.test(t),
    complaint: test(COMPLAINT, t) || shouting(t),
    handoff: test(HANDOFF, t) || !!topic,
    outOfScope: !!profile?.outOfScopeRe?.test(t),
    injection: test(INJECTION, t),
    topic: topic?.id || null,
  };
  const reasons = [];
  if (flags.emergency) reasons.push(`${profile.urgency.label} wording (urgent situation that needs a person now)`);
  if (flags.complaint) reasons.push('Complaint or angry customer');
  if (flags.handoff) reasons.push(topic ? `Customer raised ${topic.label}, which always goes to a person` : 'Customer needs a person (schedule change or asked for a human)');
  if (flags.outOfScope) reasons.push('Request is outside the services the agent schedules');
  if (flags.injection) reasons.push('Message tries to give the agent instructions (possible prompt injection)');
  return { ...flags, reasons, any: reasons.length > 0 };
}

// Which flags force a human, regardless of what a model decides.
export function mustEscalate(f) {
  return f.complaint || f.handoff || f.outOfScope || f.injection || f.emergency;
}
