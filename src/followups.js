// Real timers: a one-second tick looks at the persisted follow-up list and fires what is due.
export class FollowupScheduler {
  constructor({ store, agent, now = Date.now, intervalMs = 1000 }) {
    Object.assign(this, { store, agent, now, intervalMs, timer: null, inflight: new Set() });
  }
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { this.tick().catch(() => {}); }, this.intervalMs);
    this.timer.unref?.();
  }
  stop() { clearInterval(this.timer); this.timer = null; }
  async tick() {
    const ttl = this.agent?.config?.limits?.liveBookingTtlMs;
    if (ttl) this.store.releaseExpired(this.now(), ttl);
    // A follow-up stays 'pending' until it actually runs, so remember which ones are already queued; otherwise a slow
    // lead queue would make every 1 s tick queue the same follow-up again.
    const due = this.store.followups.filter((f) => f.status === 'pending' && f.dueAt <= this.now() && !this.inflight.has(f.id));
    const runs = due.map((f) => {
      this.inflight.add(f.id);
      return this.agent.queueFollowup(f).finally(() => this.inflight.delete(f.id));
    });
    await Promise.all(runs);
    return due.length;
  }
}
