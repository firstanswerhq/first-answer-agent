import { loadConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { Agent } from '../src/agent.js';
import { LeadService } from '../src/service.js';
import { LlmClient } from '../src/llm.js';
import { createApp } from '../src/server.js';
import { loadProfile, compileProfile, listProfiles } from '../src/profile.js';
import fs from 'node:fs';
import path from 'node:path';

// Wednesday 2026-11-04, 10:00 AM Central (CST = UTC-6) is inside business hours.
export const WED_10AM = Date.UTC(2026, 10, 4, 16, 0, 0);
export const WED_11PM = Date.UTC(2026, 10, 5, 5, 0, 0);
export const SUN_10AM = Date.UTC(2026, 10, 8, 16, 0, 0);

export function makeClock(start = WED_10AM, step = 0) {
  const c = { t: start, now: () => { const v = c.t; c.t += step; return v; }, advance: (ms) => { c.t += ms; } };
  return c;
}

export const PROFILE_NAMES = listProfiles();
export const profileCfg = (name, over = {}) => loadConfig({ DATA_FILE: '' }, { profile: name, seedOnEmpty: false, followupSpeedup: 60, ...over });

// A test-only variant of the default profile that ALSO has a service area, so the location checks (ZIPs, cities, outside
// places) stay covered even though the shipped profiles are businesses where customers come to the office.
export const PROFILE = loadProfile('dental');
export function areaProfile() {
  const raw = JSON.parse(fs.readFileSync(path.join(path.resolve(import.meta.dirname, '..'), 'config', 'profiles', 'dental.json'), 'utf8'));
  raw.serviceArea = {
    label: 'service area (Nashville and nearby)',
    cities: ['Nashville', 'East Nashville', 'Brentwood', 'Franklin', 'Hendersonville', 'Murfreesboro', 'Antioch', 'Madison', 'Donelson', 'Hermitage', 'Green Hills', 'The Gulch', 'Sylvan Park', 'Bellevue'],
    zips: [...Array.from({ length: 21 }, (_, i) => String(37201 + i)), '37027', '37064', '37067', '37069', '37076', '37115', '37130'],
    outside: ['Memphis', 'Knoxville', 'Chattanooga', 'Atlanta', 'Louisville'],
  };
  return compileProfile(raw);
}
export const areaCfg = (over = {}) => cfgFor({ profile: areaProfile(), ...over });

export const cfgFor = (over = {}) => loadConfig({ DATA_FILE: '' }, { seedOnEmpty: false, followupSpeedup: 60, ...over });

export function makeEnv({ llm = null, clock = makeClock(), config = cfgFor(), store = new Store() } = {}) {
  const agent = new Agent({ store, config, llm, now: clock.now });
  const svc = new LeadService({ store, agent, config, now: clock.now });
  return { store, agent, svc, config, clock };
}

export const lead = (over = {}) => ({ name: 'Test Person', phone: '(615) 555-0111', source: 'Website form', message: 'How much is a cleaning and checkup for an adult? I pay out of pocket.', ...over });

export async function newLead(env, over, opts) {
  const { lead: l, done } = env.svc.createLead(lead(over), opts);
  await done;
  return l;
}
export async function say(env, l, text) {
  const { done } = env.svc.addCustomerMessage(l.id, text);
  await done;
}

export const agentTexts = (l) => l.messages.filter((m) => m.from === 'agent').map((m) => m.text);
export const fnSteps = (l) => l.timeline.filter((t) => t.kind === 'function');
export const fnNames = (l) => fnSteps(l).map((t) => t.fn);

// ---- fake OpenAI-compatible endpoint ----
export const call = (name, args, id = 'c' + Math.random().toString(16).slice(2, 6)) => ({ id, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } });
export const reply = (...toolCalls) => ({ status: 200, json: { model: 'fake-model-1', choices: [{ message: { role: 'assistant', content: toolCalls.length ? null : 'done', tool_calls: toolCalls.length ? toolCalls : undefined } }] } });

/** script: array of responses or functions(body) => response. Throws/hangs are supported via {hang:true} / {throw:Error}. */
export function fakeFetch(script) {
  const state = { calls: [], bodies: [] };
  const fn = async (url, opts) => {
    state.calls.push(url);
    state.bodies.push(JSON.parse(opts.body));
    const step = script[Math.min(state.calls.length - 1, script.length - 1)];
    const r = typeof step === 'function' ? step(JSON.parse(opts.body)) : step;
    if (r.throw) throw r.throw;
    if (r.hang) return new Promise((_res, rej) => opts.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.json };
  };
  fn.state = state;
  return fn;
}

export const fakeLlm = (script, over = {}) => {
  const f = fakeFetch(script);
  const llm = new LlmClient({ key: 'test-key', url: 'https://example.invalid/v1', model: 'fake-model-1', timeoutMs: 200, retries: 2, fetchImpl: f, sleepFn: async () => {}, ...over });
  llm.fetchMock = f;
  return llm;
};

export async function startServer(opts = {}) {
  const config = opts.config || cfgFor();
  const made = await createApp({ config, startTimers: false, ...opts });
  const server = await new Promise((res) => { const s = made.app.listen(0, '127.0.0.1', () => res(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { ...made, base, stop: async () => { await new Promise((r) => server.close(r)); await made.close(); } };
}

export const post = (base, path, body, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
