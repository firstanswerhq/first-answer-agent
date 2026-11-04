// Real timers: a one-second tick looks at the persisted follow-up list and fires what is due.
export class FollowupScheduler {
  constructor({ store, agent, now = Date.now, intervalMs = 1000 }) {
    Object.assign(this, { store, agent, now, intervalMs, timer: null });
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
    const due = this.store.followups.filter((f) => f.status === 'pending' && f.dueAt <= this.now());
    for (const f of due) await this.agent.queueFollowup(f);
    return due.length;
  }
}
