import { createPostgresStore } from './postgres-store';

const databaseUrl = process.env.CLEANUP_DATABASE_URL ?? process.env.MIGRATION_DATABASE_URL;
if (!databaseUrl) throw new Error('CLEANUP_DATABASE_URL or MIGRATION_DATABASE_URL is required.');
if (!process.argv.includes('--confirm')) throw new Error('QA cleanup requires --confirm.');

const store = createPostgresStore(databaseUrl);
try {
  const deleted = await store.cleanupQa();
  process.stdout.write(`${JSON.stringify({ cleanup: 'staging_qa', deleted })}\n`);
} finally {
  await store.close();
}
