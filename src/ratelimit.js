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
