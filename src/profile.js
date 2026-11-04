// Business profiles: everything that is specific to one kind of small business lives in one JSON file under
// config/profiles/. The agent prompt, rules engine, qualify_lead, safety checks, calendar, UI wording, demo
// scenarios and sample data all read from the loaded profile. To make it yours: copy a profile, edit it, and set
// BUSINESS_PROFILE=<file name without .json>.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PROFILE_DIR = path.join(root, 'config', 'profiles');
export const DEFAULT_PROFILE = 'dental';

export class ProfileError extends Error {}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Literal phrases match at a word start, any case, with flexible spaces ("check up" also matches "check  up").
const phraseRe = (list) => (list.length ? new RegExp(list.map((p) => `(?<![\\w])${escapeRe(String(p).trim().toLowerCase()).replace(/\s+/g, '\\s+')}`).join('|'), 'i') : null);
const patternRe = (list) => (list.length ? new RegExp(list.map((p) => `(?:${p})`).join('|'), 'i') : null);

const need = (cond, msg) => { if (!cond) throw new ProfileError(`Invalid business profile: ${msg}`); };
const str = (v, name, max = 300) => { need(typeof v === 'string' && v.trim() && v.length <= max, `${name} must be a non-empty string`); return v.trim(); };
const strList = (v, name) => { need(Array.isArray(v) && v.every((x) => typeof x === 'string' && x.trim()), `${name} must be a list of strings`); return v; };
const HHMM = /^([01]\d|2[0-3]):00$/;

export function compileProfile(raw) {
  need(raw && typeof raw === 'object', 'profile must be an object');
  const id = str(raw.id, 'id', 40);
  need(/^[a-z0-9_-]+$/.test(id), 'id may contain only a-z, 0-9, _ and -');
  const b = raw.business || {};
  const business = {
    name: str(b.name, 'business.name', 80), agentName: str(b.agentName, 'business.agentName', 80), phone: str(b.phone, 'business.phone', 30),
    tz: str(b.tz, 'business.tz', 60), accent: str(b.accent || '#a95aff', 'business.accent', 9), tagline: str(b.tagline, 'business.tagline', 160),
    description: str(b.description, 'business.description', 200), customerWord: str(b.customerWord || 'customer', 'business.customerWord', 30),
  };
  need(/^#[0-9a-fA-F]{6}$/.test(business.accent), 'business.accent must look like #rrggbb');
  try { new Intl.DateTimeFormat('en-US', { timeZone: business.tz }); } catch { throw new ProfileError('Invalid business profile: business.tz is not a valid time zone'); }

  const h = raw.hours || {};
  need(Number.isInteger(h.windowHours) && h.windowHours >= 1 && h.windowHours <= 4, 'hours.windowHours must be a whole number from 1 to 4 (appointment length in hours)');
  need(h.starts && h.open, 'hours.starts and hours.open are required');
  for (const [d, list] of Object.entries(h.starts)) {
    need(/^[0-6]$/.test(d), 'hours.starts keys are weekday numbers 0-6 (0 = Sunday)');
    need(Array.isArray(list) && list.every((t) => HHMM.test(t)), 'hours.starts times must look like "09:00" (whole hours)');
    need(h.open[d] && list.every((t) => t >= h.open[d][0] && Number(t.slice(0, 2)) + h.windowHours <= Number(h.open[d][1].slice(0, 2))), `hours.starts for weekday ${d} must fit inside hours.open`);
  }
  const hours = { windowHours: h.windowHours, starts: h.starts, open: h.open, text: str(h.text, 'hours.text', 120) };

  let serviceArea = null;
  if (raw.serviceArea) {
    const a = raw.serviceArea;
    serviceArea = { label: str(a.label || 'service area', 'serviceArea.label', 60), cities: strList(a.cities || [], 'serviceArea.cities'), zips: strList(a.zips || [], 'serviceArea.zips'), outside: strList(a.outside || [], 'serviceArea.outside') };
  }

  need(Array.isArray(raw.services) && raw.services.length >= 1 && raw.services.length <= 20, 'services must list 1 to 20 offerings');
  const ids = new Set();
  const services = raw.services.map((s, i) => {
    const sid = str(s.id, `services[${i}].id`, 40);
    need(/^[a-z0-9_]+$/.test(sid) && sid !== 'other', `services[${i}].id must be a-z, 0-9 or _ (and not "other")`);
    need(!ids.has(sid), `duplicate service id ${sid}`); ids.add(sid);
    if (s.price) need(Number.isFinite(s.price.low) && Number.isFinite(s.price.high) && s.price.low >= 0 && s.price.high >= s.price.low, `services[${i}].price needs low <= high (or null for "quote required")`);
    return { id: sid, label: str(s.label, `services[${i}].label`, 80), group: ['a', 'b', 'c'].includes(s.group) ? s.group : 'a', price: s.price ? { low: s.price.low, high: s.price.high } : null, keywords: strList(s.keywords || [], `services[${i}].keywords`), re: phraseRe(s.keywords || []) };
  });

  const u = raw.urgency || {};
  const urgency = {
    label: str(u.label || 'Urgent', 'urgency.label', 60), safetyNote: str(u.safetyNote, 'urgency.safetyNote'), holdNote: str(u.holdNote, 'urgency.holdNote', 120), handoffReason: str(u.handoffReason, 'urgency.handoffReason'),
    emergencyPhrases: strList(u.emergencyPhrases || [], 'urgency.emergencyPhrases'), urgentWords: strList(u.urgentWords || ['asap', 'urgent', 'today', 'soon'], 'urgency.urgentWords'),
  };
  try { urgency.emergencyRe = patternRe(urgency.emergencyPhrases); } catch { throw new ProfileError('Invalid business profile: urgency.emergencyPhrases contains a bad pattern'); }
  urgency.urgentRe = phraseRe(urgency.urgentWords);
  // Optional: the service to record when an urgent situation is flagged but no specific service was named.
  if (u.defaultService) { need(ids.has(u.defaultService), 'urgency.defaultService must be one of the service ids'); urgency.defaultService = u.defaultService; }

  const alwaysHuman = (raw.alwaysHuman || []).map((t, i) => ({ id: str(t.id, `alwaysHuman[${i}].id`, 40), label: str(t.label, `alwaysHuman[${i}].label`, 120), phrases: strList(t.phrases || [], `alwaysHuman[${i}].phrases`), re: phraseRe(t.phrases || []) }));
  const outOfScope = strList(raw.outOfScope || [], 'outOfScope');

  const w = raw.wording || {};
  const wording = Object.fromEntries(['appointment', 'formEyebrow', 'formTitle', 'formIntro', 'formPlaceholder', 'priceNote', 'noQuote', 'bookedAfter', 'askService'].map((k) => [k, str(w[k], `wording.${k}`, 300)]));

  need(Array.isArray(raw.scenarios) && raw.scenarios.length >= 1, 'scenarios must list at least one example lead');
  const leadOk = (l, where) => { need(l && typeof l.name === 'string' && typeof l.phone === 'string' && typeof l.message === 'string', `${where} needs name, phone and message`); return { name: l.name, phone: l.phone, source: l.source || 'Website form', message: l.message }; };
  const scenarios = raw.scenarios.map((s, i) => ({ id: str(s.id, `scenarios[${i}].id`, 40), title: str(s.title, `scenarios[${i}].title`, 80), blurb: str(s.blurb, `scenarios[${i}].blurb`, 160), lead: leadOk(s.lead, `scenarios[${i}].lead`) }));
  const seed = (raw.seed || []).map((s, i) => ({ minutesAgo: Number(s.minutesAgo), lead: leadOk(s.lead, `seed[${i}].lead`), replies: strList(s.replies || [], `seed[${i}].replies`), quietFollowup: !!s.quietFollowup }));
  seed.forEach((s, i) => need(Number.isFinite(s.minutesAgo) && s.minutesAgo > 0, `seed[${i}].minutesAgo must be a positive number`));
  const existing = (raw.existing || []).map((e, i) => ({ name: str(e.name, `existing[${i}].name`, 80), service: str(e.service, `existing[${i}].service`, 80), dayOffset: Number(e.dayOffset) || 0, slotIndex: Number(e.slotIndex) || 0 }));

  return { id, business, wording, hours, serviceArea, services, urgency, alwaysHuman, outOfScope, outOfScopeRe: phraseRe(outOfScope), scenarios, seed, existing };
}

export function listProfiles() {
  return fs.readdirSync(PROFILE_DIR).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
}

export function loadProfile(name = DEFAULT_PROFILE) {
  const n = String(name || DEFAULT_PROFILE).trim();
  if (!/^[a-z0-9_-]+$/i.test(n)) throw new ProfileError(`BUSINESS_PROFILE "${n.slice(0, 40)}" is not a valid profile name. Use a file name from config/profiles without .json (${listProfiles().join(', ')}).`);
  const file = path.join(PROFILE_DIR, `${n}.json`);
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    if (e.code === 'ENOENT') throw new ProfileError(`Business profile "${n}" was not found in config/profiles. Available: ${listProfiles().join(', ')}.`);
    throw new ProfileError(`Business profile "${n}" is not valid JSON: ${e.message}`);
  }
  return compileProfile(raw);
}
