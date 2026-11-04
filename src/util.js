import crypto from 'node:crypto';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Strip control characters and trim. Never trust text from customers or the model.
export function cleanText(v, max = 1000) {
  if (typeof v !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').replace(/\r\n?/g, '\n').trim().slice(0, max);
}

export const money = (n) => '$' + Number(n).toLocaleString('en-US');

export function firstName(name) {
  const f = String(name || '').trim().split(/\s+/)[0] || 'there';
  return f.slice(0, 30);
}

export function rid(prefix) {
  return prefix + '-' + crypto.randomBytes(4).toString('hex');
}

export function round1(n) {
  return Math.round(n * 10) / 10;
}

export const token = () => crypto.randomBytes(16).toString('hex');

export function round2(n) {
  return Math.round(n * 100) / 100;
}

/** Mask a phone number to its last four digits, e.g. "(***) ***-0111". */
export function maskPhone(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  return d.length >= 4 ? `(***) ***-${d.slice(-4)}` : '(hidden)';
}

/** Constant-time string comparison for secrets. */
export function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
