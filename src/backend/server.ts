import { buildApp } from './app';
import { loadBackendConfig } from './config';
import { createPhoneEncryptor } from './crypto';
import { createPostgresStore } from './postgres-store';

const config = loadBackendConfig();
const store = createPostgresStore(config.databaseUrl);
const phoneEncryptor = createPhoneEncryptor(config.encryptionKeyBase64, config.encryptionKeyId);
const app = await buildApp({ config, store, phoneEncryptor });

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutdown_started');
  await app.close();
  process.exit(0);
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error({ error_name: error instanceof Error ? error.name : 'UnknownError' }, 'startup_failed');
  await app.close();
  process.exit(1);
}
