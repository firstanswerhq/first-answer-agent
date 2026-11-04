import { loadConfig } from './config.js';
import { createApp } from './server.js';
import { LlmClient, pickModel } from './llm.js';

const config = loadConfig();
const llm = new LlmClient({ ...config.inference });

// If a key is set but no model was named, ask the endpoint what it serves. Never invent a name.
if (llm.key && !llm.model) {
  try {
    const picked = pickModel(await llm.listModels());
    if (picked) { llm.model = picked; console.log(`Inference model discovered: ${picked}`); } else console.warn('No suitable model found; running in offline rules mode.');
  } catch (e) { console.warn(`Could not list models (${e.message}); running in offline rules mode.`); }
}

const { app, store, scheduler, agent } = await createApp({ config, llm });
const server = app.listen(config.port, config.host, () => {
  const st = agent.status();
  console.log(`First Answer Agent listening on ${config.host}:${config.port} | ${st.label}${st.model ? ` | ${st.model}` : ''}`);
});

async function shutdown() {
  scheduler.stop();
  await store.flush();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
