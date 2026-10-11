import { parseOfficeStagingEnvironment } from './staging';
import { createStagingOfficeApp } from './staging-app';
import { PostgresOfficeStore } from './postgres-store';
import { closeStagingResources, stagingStartupDiagnostic } from './staging-diagnostics';
import type { StagingStartupStage } from './staging-diagnostics';
import { createMondayRuntime } from './monday-runtime';
import { formatMondayStartupDiagnostic } from './monday-diagnostics';

let store: PostgresOfficeStore | undefined;
let app: ReturnType<typeof createStagingOfficeApp> | undefined;
let stage: StagingStartupStage = 'configuration';
try {
  const runtime = parseOfficeStagingEnvironment(process.env);
  stage = 'database-construction';
  store = new PostgresOfficeStore({ mode: 'staging', database: runtime.database });
  stage = 'ui-build';
  const monday = createMondayRuntime(process.env, runtime.access.origin, store.pool);
  app = createStagingOfficeApp(runtime, store, { monday });
  stage = 'app-ready';
  await app.ready();
  stage = 'database-initialize';
  await store.initialize();
  stage = 'listen';
  await app.listen({ host: '0.0.0.0', port: 4180 });
  if (monday.startupDiagnostic) process.stdout.write(formatMondayStartupDiagnostic(monday.startupDiagnostic) + '\n');
  process.stdout.write(monday.enabled
    ? 'Gourmet Office staging: authentication required; DEMO active; optional Monday OAuth configured.\n'
    : 'Gourmet Office synthetic staging: authentication required; no outbound effects.\n');
} catch (error) {
  process.stderr.write(stagingStartupDiagnostic(stage, error) + '\n');
  await stop();
  process.exitCode = 1;
}
async function stop() {
  if (await closeStagingResources([app, store])) {
    process.stderr.write(stagingStartupDiagnostic('shutdown', undefined) + '\n');
    process.exitCode = 1;
  }
}
process.once('SIGINT', () => { void stop(); });
process.once('SIGTERM', () => { void stop(); });
