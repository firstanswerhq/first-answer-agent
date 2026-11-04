// Tiny HTML template helper: every interpolated string is escaped unless wrapped in R().
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export class Raw { constructor(s) { this.s = s; } }
export const raw = (s) => new Raw(s);
export const html = (strings, ...vals) => strings.reduce((out, s, i) => out + s + (i < vals.length ? (vals[i] instanceof Raw ? vals[i].s : Array.isArray(vals[i]) ? vals[i].map((x) => (x instanceof Raw ? x.s : esc(x))).join('') : esc(vals[i])) : ''), '');
export const R = (s) => raw(s);
