// A tiny persistent store: everything lives in memory and is snapshotted to one JSON
// file with atomic writes (write temp file, then rename). No native dependencies.
import fs from 'node:fs';
import path from 'node:path';

const empty = () => ({ version: 1, leads: [], bookings: [], followups: [], meta: { seeded: false } });

export class Store {
  constructor({ file = null, debounceMs = 150 } = {}) {
    this.file = file;
    this.debounceMs = debounceMs;
    this.state = empty();
    this.timer = null;
    this.writing = Promise.resolve();
    this.writeCount = 0;
    if (file) this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.leads) && Array.isArray(parsed.bookings)) {
        this.state = { ...empty(), ...parsed };
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // A corrupt file must not take the service down; keep it for inspection and start clean.
        try { fs.renameSync(this.file, `${this.file}.corrupt-${Date.now()}`); } catch { /* ignore */ }
      }
    }
  }

  save() {
    if (!this.file) return;
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, this.debounceMs);
    this.timer.unref?.();
  }

  flush() {
    if (!this.file) return Promise.resolve();
    const json = JSON.stringify(this.state);
    this.writing = this.writing.then(async () => {
      const tmp = `${this.file}.${process.pid}.tmp`;
      await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
      await fs.promises.writeFile(tmp, json);
      await fs.promises.rename(tmp, this.file);
      this.writeCount += 1;
    }).catch(() => {});
    return this.writing;
  }

  get leads() { return this.state.leads; }
  get bookings() { return this.state.bookings; }
  get followups() { return this.state.followups; }

  getLead(id) { return this.state.leads.find((l) => l.id === id) || null; }
  bookingForSlot(slotId) { return this.state.bookings.find((b) => b.slot_id === slotId && b.status === 'confirmed') || null; }
  bookingForLead(leadId) { return this.state.bookings.find((b) => b.leadId === leadId && b.status === 'confirmed') || null; }

  addLead(lead, maxLeads = 300) {
    this.state.leads.unshift(lead);
    // Keep the file bounded: drop the oldest NON-sample leads (and their bookings) past the cap.
    // Sample leads are the demo's baseline and are never evicted.
    while (this.state.leads.length > maxLeads) {
      let idx = -1;
      for (let i = this.state.leads.length - 1; i >= 0; i -= 1) if (!this.state.leads[i].seed) { idx = i; break; }
      if (idx < 0) break;
      const [old] = this.state.leads.splice(idx, 1);
      this.state.bookings = this.state.bookings.filter((b) => b.leadId !== old.id);
      this.state.followups = this.state.followups.filter((f) => f.leadId !== old.id);
    }
    this.save();
    return lead;
  }

  /** Bookings made by visitors (not the original sample day) that are still holding a slot. */
  liveBookings() { return this.state.bookings.filter((b) => b.status === 'confirmed' && !b.sample); }

  /** Free slots held by visitor bookings older than ttlMs. Returns how many were released. */
  releaseExpired(nowMs, ttlMs) {
    let n = 0;
    for (const b of this.state.bookings) {
      if (b.status === 'confirmed' && !b.sample && nowMs - b.createdAt > ttlMs) {
        b.status = 'released'; b.releasedAt = nowMs; n += 1;
        const lead = b.leadId ? this.getLead(b.leadId) : null;
        if (lead && lead.status === 'booked') lead.status = 'replied';
        if (lead) {
          lead.bookingReleasedAt = nowMs;
          // Say so in the conversation, so a booking never disappears silently.
          lead.messages.push({ id: `M-rel${b.id}`, ts: nowMs, from: 'agent', note: true, simulated: true, text: 'Demo note: this demo booking was released automatically so the shared demo calendar stays open for other visitors.' });
        }
      }
    }
    if (n) this.save();
    return n;
  }

  reset() { this.state = empty(); this.save(); }
}
