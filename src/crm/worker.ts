import { loadCrmWorkerConfig } from './config';
import { createMondayClient } from './monday-client';
import { CrmOutboxWorker } from './outbox-worker';
import { createCrmOutboxStore } from './postgres-outbox-store';

const config = loadCrmWorkerConfig();
const store = createCrmOutboxStore(config.databaseUrl);
const monday = createMondayClient({ token: config.token, boardId: config.boardId, groupId: config.groupId });
const worker = new CrmOutboxWorker(config, store, monday);

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stdout.write(`${JSON.stringify({ level: 'info', message: 'crm_worker_shutdown', signal })}\n`);
  worker.stop();
}
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGINT', () => { void shutdown('SIGINT'); });

try {
  await worker.start();
  await store.close();
} catch (error) {
  process.stderr.write(`${JSON.stringify({ level: 'error', message: 'crm_worker_startup_failed', error_code: error instanceof Error ? error.message : 'unknown' })}\n`);
  await store.close().catch(() => undefined);
  process.exitCode = 1;
}
