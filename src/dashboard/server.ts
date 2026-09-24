import { buildDashboardApp } from './app';
import { loadDashboardConfig } from './config';
import { createPostgresDashboardStore } from './postgres-dashboard-store';

const config = loadDashboardConfig();
const store = createPostgresDashboardStore(config.databaseUrl);
const app = await buildDashboardApp({ config, store });

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'dashboard_shutdown_started');
  await app.close();
  process.exit(0);
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error({ error_name: error instanceof Error ? error.name : 'UnknownError' }, 'dashboard_startup_failed');
  await app.close();
  process.exit(1);
}

