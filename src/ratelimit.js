// Small in-memory fixed-window rate limiter keyed by client IP and bucket name.
export function rateLimiter({ windowMs, max }, name, now = Date.now) {
  const hits = new Map();
  let lastSweep = now();
  return (req, res, next) => {
    const t = now();
    if (t - lastSweep > windowMs) { for (const [k, v] of hits) if (v.reset <= t) hits.delete(k); lastSweep = t; }
    const key = `${name}:${req.ip}`;
    let h = hits.get(key);
    if (!h || h.reset <= t) { h = { n: 0, reset: t + windowMs }; hits.set(key, h); }
    h.n += 1;
    if (h.n > max) {
      res.set('Retry-After', String(Math.ceil((h.reset - t) / 1000)));
      return res.status(429).json({ error: 'Too many requests. Please slow down and try again shortly.' });
    }
    return next();
  };
}

/**
 * Counts only ACCEPTED actions. check(key) says whether another action is allowed without spending anything; hit(key)
 * records one accepted action. Invalid submissions (400s) never call hit, so they never use up anyone's allowance.
 * Fixed sliding window of timestamps per key.
 */
export function acceptCounter({ windowMs, max }, now = Date.now) {
  const stamps = new Map();
  const live = (key) => {
    const cutoff = now() - windowMs;
    const s = (stamps.get(key) || []).filter((t) => t > cutoff);
    if (s.length) stamps.set(key, s); else stamps.delete(key);
    return s;
  };
  return {
    check: (key) => live(key).length < max,
    retryAfterSec: (key) => { const s = live(key); return s.length ? Math.max(1, Math.ceil((s[0] + windowMs - now()) / 1000)) : 1; },
    hit: (key) => { const s = live(key); s.push(now()); stamps.set(key, s); },
  };
}

/** Express middleware: refuse with 429 if any counter is full for its key; the route calls hit() only after it accepted. */
export function gate(counters) {
  return (req, res, next) => {
    for (const { counter, key } of counters) {
      const k = key(req);
      if (!counter.check(k)) {
        res.set('Retry-After', String(counter.retryAfterSec(k)));
        return res.status(429).json({ error: 'Too many requests. Please slow down and try again shortly.' });
      }
    }
    return next();
  };
}
