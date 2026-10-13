import { randomBytes, randomUUID } from 'node:crypto';
import { createOfficeApi } from '../../src/office/backend/http';
import { createFixtureCommunicationsDependencies } from '../../src/office/backend/communications-fixture';
import { createCommunicationsStore } from '../../src/office/backend/communications-store';
import { MondayVault, PostgresMondayStore } from '../../src/office/backend/monday-store';
import { PostgresOfficeStore } from '../../src/office/backend/postgres-store';

// Explicit local test entrypoint. It uses only the project's validated isolated
// loopback candidate DB, a fresh synthetic aggregate and an ephemeral in-memory
// fixture encryption key. Never import this module in a runtime entrypoint.
const store = new PostgresOfficeStore({ stateId: `test-communications-${randomUUID()}` });
let app: ReturnType<typeof createOfficeApi> | undefined;
let stopping = false;
async function stop() { if (stopping) return; stopping = true; await app?.close(); await store.close(); }
process.once('SIGINT', () => { void stop(); });
process.once('SIGTERM', () => { void stop(); });
try {
  if (process.env.OFFICE_RUNTIME_MODE !== undefined && process.env.OFFICE_RUNTIME_MODE !== 'development') throw new Error('Local development mode required');
  await store.initialize();
  const physical = new PostgresMondayStore(store.pool);
  const vault = new MondayVault(randomBytes(32));
  app = createOfficeApi(store, { communicationsFixture: createFixtureCommunicationsDependencies({ storage: 'postgres', storeFor: scope => createCommunicationsStore({ scope, store: physical, vault }) }) });
  await app.listen({ host: '127.0.0.1', port: 4180 });
  process.stdout.write('Communications fixture ready: loopback API 4180, synthetic data, zero provider effects. Open /office/communications through office:dev.\n');
} catch {
  process.stderr.write('Communications fixture could not start. Isolated candidate PostgreSQL on loopback port 55433 is required; no fallback or external connection was attempted.\n');
  await stop(); process.exitCode = 1;
}
