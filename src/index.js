import { loadConfig } from './config.js';
import { createApp } from './server.js';
import { LlmClient, pickModel } from './llm.js';

let config;
try { config = loadConfig(); } catch (e) { console.error(`Configuration error: ${e.message}`); process.exit(1); } // messages never contain the calendar address
const llm = new LlmClient({ ...config.inference });

// If a key is set but no model was named, ask the endpoint what it serves. Never invent a name.
if (llm.key && !llm.model) {
  try {
    const picked = pickModel(await llm.listModels());
    if (picked) { llm.model = picked; console.log(`Inference model discovered: ${picked}`); } else console.warn('No suitable model found; running in offline rules mode.');
  } catch (e) { console.warn(`Could not list models (${e.message}); running in offline rules mode.`); }
}

const { app, store, scheduler, agent } = await createApp({ config, llm });
if (config.calendarFeed) {
  // Names the profile only; the address is never logged.
  console.log(`Calendar: read-only Google Calendar configured for the "${config.calendarFeed.profile}" profile (other profiles use demo calendars).`);
  config.calendarFeed.ensureFresh(Date.now()).then((s) => console.log(s.connected ? `Calendar: connected, ${s.eventsLoaded} events loaded.` : `Calendar: not connected (${s.lastError}); using the demo calendar.`));
}
const server = app.listen(config.port, config.host, () => {
  const st = agent.status();
  console.log(`First Answer Agent listening on ${config.host}:${config.port} | ${st.label}${st.model ? ` | ${st.model}` : ''}`);
});

// One tiny test call, so /api/health reports modelVerified only after the model has really answered.
if (process.env.PROBE_MODEL !== '0') {
  agent.probeModel().then((ok) => { if (ok === true) console.log('Model check passed: the inference endpoint answered a test call.'); else if (ok === false) console.warn(`Model check FAILED: ${agent.status().lastError}. Running in offline rules mode.`); });
}

async function shutdown() {
  scheduler.stop();
  await store.flush();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
