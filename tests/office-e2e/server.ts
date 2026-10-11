import { randomUUID } from 'node:crypto';
import { createOfficeApi } from '../../src/office/backend/http';
import { PostgresOfficeStore } from '../../src/office/backend/postgres-store';

// One fresh synthetic aggregate per browser suite. The production/development
// entrypoints and all previous database records remain unchanged.
let store: PostgresOfficeStore | undefined;
let app: ReturnType<typeof createOfficeApi> | undefined;
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  try { await app?.close(); await store?.close(); }
  catch {
    process.stderr.write('Gourmet Office browser test API could not close cleanly.\n');
    process.exitCode = 1;
  }
}
process.once('SIGINT', () => { void stop(); });
process.once('SIGTERM', () => { void stop(); });

try {
  if (process.env.OFFICE_RUNTIME_MODE !== undefined && process.env.OFFICE_RUNTIME_MODE !== 'development') throw new Error('Development mode required.');
  store = new PostgresOfficeStore({ stateId: `test-browser-office-${randomUUID()}` });
  await store.initialize();
  app = createOfficeApi(store);
  // This Playwright version cannot set readiness request headers. Canonicalize
  // only its exact read-only health probe; all API requests retain real guards.
  app.server.prependListener('request', request => {
    if (request.method === 'GET' && request.url === '/office-api/health' && request.headers.host === '127.0.0.1:4181') {
      request.headers.host = '127.0.0.1:4175';
    }
  });
  await app.listen({ host: '127.0.0.1', port: 4181 });
  process.stdout.write('Gourmet Office browser test API: http://127.0.0.1:4181 · isolated PostgreSQL DEMO aggregate · no outbound effects\n');
} catch {
  process.stderr.write('Gourmet Office browser test API could not start. Candidate PostgreSQL must be available on loopback; no fallback was created.\n');
  await stop();
  process.exitCode = 1;
}
