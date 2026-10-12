import { createOfficeApi } from './http';
import { PostgresOfficeStore } from './postgres-store';
import { createDemoBridgeProvenanceProvider } from './canonical-bridge-runtime';

const store = new PostgresOfficeStore({ connectionString: process.env.OFFICE_DATABASE_URL });
let app: ReturnType<typeof createOfficeApi> | undefined;
try {
  if (process.env.OFFICE_RUNTIME_MODE !== undefined && process.env.OFFICE_RUNTIME_MODE !== 'development') throw new Error('Explicit development mode required.');
  await store.initialize();
  app = createOfficeApi(store, { provenance: { demoBridge: createDemoBridgeProvenanceProvider(store.pool, store.stateId) } });
  await app.listen({ host: '127.0.0.1', port: 4180 });
  process.stdout.write('Gourmet Office DEMO API: http://127.0.0.1:4180 · PostgreSQL development · no outbound effects\n');
} catch {
  process.stderr.write('Gourmet Office API could not start. Candidate PostgreSQL must be available at loopback port 55433; no fallback was created.\n');
  await store.close();
  process.exitCode = 1;
}
async function stop() { await app?.close(); await store.close(); }
process.once('SIGINT', () => { void stop(); });
process.once('SIGTERM', () => { void stop(); });
