// Usage: npm run seed   (resets the data file and loads the sample day)
import { loadConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { seedSample } from '../src/seed.js';

const config = loadConfig();
const store = new Store({ file: config.dataFile });
await seedSample(store, config, { force: true });
await store.flush();
console.log(`Seeded ${store.leads.length} sample leads and ${store.bookings.length} bookings into ${config.dataFile ?? '(memory)'}`);
