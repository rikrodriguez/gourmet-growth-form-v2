import { parseOfficeStagingEnvironment } from './staging';
import { createStagingOfficeApp } from './staging-app';
import { PostgresOfficeStore } from './postgres-store';

let store: PostgresOfficeStore | undefined;
let app: ReturnType<typeof createStagingOfficeApp> | undefined;
try {
  const runtime = parseOfficeStagingEnvironment(process.env);
  store = new PostgresOfficeStore({ mode: 'staging', database: runtime.database });
  app = createStagingOfficeApp(runtime, store);
  await app.ready();
  await store.initialize();
  await app.listen({ host: '0.0.0.0', port: 4180 });
  process.stdout.write('Gourmet Office synthetic staging: authentication required; no outbound effects.\n');
} catch {
  process.stderr.write('Synthetic staging could not start. Verify the explicit HTTPS/proxy/auth configuration, compiled UI and internal synthetic PostgreSQL. No fallback was created.\n');
  await app?.close();
  await store?.close();
  process.exitCode = 1;
}
async function stop() { await app?.close(); await store?.close(); }
process.once('SIGINT', () => { void stop(); });
process.once('SIGTERM', () => { void stop(); });
