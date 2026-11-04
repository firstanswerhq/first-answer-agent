// Deterministic safety classifier. It runs BEFORE any model call, on every customer
// message, and its verdicts are enforced in code. A model cannot talk its way past it.
const EMERGENCY = [
  /\b(active|actively|ongoing|currently)\b.{0,20}\b(leak|leaking|flood|flooding)\b/i,
  /\b(water|rain)\b.{0,30}\b(pouring|coming (in|through)|gushing|dripping|streaming|flooding)\b/i,
  /\bceiling\b.{0,40}\b(collaps|sagging|caving|dripping|leaking)\b/i,
  /\b(burst|broken)\s+pipe\b|\bpipe\b.{0,15}\bburst\b/i,
  /\b(flooded|flooding|flood)\b/i,
  /\bsewage\b.{0,20}\b(back|overflow|flood)/i,
  /\bgas\b.{0,15}\b(smell|leak)\b|\bsmell\b.{0,10}\bgas\b/i,
  /\b(tree|limb)\b.{0,20}\b(fell|through|on)\b.{0,20}\b(roof|house)\b/i,
  /\bsparking\b|\bon fire\b|\bsmoke\b.{0,15}\b(coming|from)\b/i,
];

const COMPLAINT = [
  /\b(refund|lawyer|attorney|lawsuit|sue you|\bsue\b|bbb|complaint|complain)\b/i,
  /\b(unacceptable|terrible|horrible|worst|rude|incompetent|useless|garbage|disgusting|ripped? ?off|scam|fraud)\b/i,
  /\b(furious|angry|pissed|livid|fed up)\b/i,
  /\b(third|2nd|second|3rd) time (i|we)('ve| have)? (called|called you|emailed|texted)\b/i,
  /\bnobody (called|came|showed|responded)\b|\bno[- ]show\b|\bnever (came|showed)\b/i,
  /\b(left|made) a (mess|hole)\b|\b(damaged|ruined|broke) my\b/i,
  /!{3,}/,
];

const HANDOFF = [
  /\b(speak|talk) (to|with) (a |the )?(human|person|manager|owner|supervisor|someone)\b/i,
  /\b(real person|human being)\b/i,
  /\binsurance claim\b|\badjuster\b/i,
  /\b(contract|permit|warranty|commercial building|hoa)\b/i,
  /\b(cancel|reschedule|move) (my|the|our) (appointment|booking|visit)\b/i,
];

const OUT_OF_SCOPE = [
  /\b(electrician|electrical|hvac|furnace|air conditioning|a\/c|pest|termite|exterminator|landscap|lawn|mow|paint(ing)?|mold remediation|asbestos|tax|legal advice|medical|siding|drywall|fence)\b/i,
];

const INJECTION = [
  /\bignore\b.{0,30}\b(previous|prior|above|earlier|all|your|the)\b.{0,20}\b(instructions?|prompts?|rules?|messages?)\b/i,
  /\b(disregard|forget|override|bypass)\b.{0,30}\b(instructions?|rules?|guardrails?|policy|policies|price|pricing)\b/i,
  /\b(system|developer) (prompt|message|mode)\b/i,
  /\byou are now\b|\bact as\b.{0,30}\b(admin|developer|unrestricted|different)\b/i,
  /\b(reveal|show|print|repeat)\b.{0,25}\b(prompt|instructions|api key|secret|password)\b/i,
  /\bnew instructions?\b|\bjailbreak\b|\bDAN mode\b/i,
  /<\/?(system|assistant|tool|function)[^>]*>/i,
  /\bcall (the )?(function|tool)\b|\bescalate_to_human\b|\bbook_job\b|\bsend_reply\b/i,
];

const test = (list, text) => list.some((re) => re.test(text));

function shouting(text) {
  const letters = text.replace(/[^A-Za-z]/g, '');
  if (letters.length < 25) return false;
  const upper = letters.replace(/[^A-Z]/g, '').length;
  return upper / letters.length > 0.6;
}

export function classify(text) {
  const t = String(text || '');
  const flags = {
    emergency: test(EMERGENCY, t),
    complaint: test(COMPLAINT, t) || shouting(t),
    handoff: test(HANDOFF, t),
    outOfScope: test(OUT_OF_SCOPE, t),
    injection: test(INJECTION, t),
  };
  const reasons = [];
  if (flags.emergency) reasons.push('Emergency wording (active leak, flooding, gas, fire or structural damage)');
  if (flags.complaint) reasons.push('Complaint or angry customer');
  if (flags.handoff) reasons.push('Customer needs a person (insurance, contract, schedule change or asked for a human)');
  if (flags.outOfScope) reasons.push('Request is outside the services the agent schedules');
  if (flags.injection) reasons.push('Message tries to give the agent instructions (possible prompt injection)');
  return { ...flags, reasons, any: reasons.length > 0 };
}

// Which flags force a human, regardless of what a model decides.
export function mustEscalate(f) {
  return f.complaint || f.handoff || f.outOfScope || f.injection || f.emergency;
}
