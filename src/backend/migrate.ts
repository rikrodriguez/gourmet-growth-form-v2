import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg from 'pg';

const { Client } = pg;
const databaseUrl = process.env.MIGRATION_DATABASE_URL;
if (!databaseUrl) throw new Error('MIGRATION_DATABASE_URL is required.');

const appRole = process.env.APP_DATABASE_ROLE;
if (appRole && !/^[a-z_][a-z0-9_]{0,62}$/i.test(appRole)) throw new Error('APP_DATABASE_ROLE is invalid.');

const migrationsDirectory = resolve(process.cwd(), 'migrations');
const direction = process.argv.includes('--down') ? 'down' : 'up';
if (direction === 'down' && !process.argv.includes('--confirm-down')) {
  throw new Error('Down migration requires --confirm-down.');
}

const client = new Client({ connectionString: databaseUrl });
await client.connect();

try {
  await client.query('SELECT pg_advisory_lock($1)', [714_202_601]);
  await client.query(`
    CREATE TABLE IF NOT EXISTS public.gourmet_growth_schema_migrations (
      migration_name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const filenames = (await readdir(migrationsDirectory))
    .filter((name) => name.endsWith('.up.sql'))
    .sort();
  const appliedResult = await client.query<{ migration_name: string }>(
    'SELECT migration_name FROM public.gourmet_growth_schema_migrations ORDER BY migration_name',
  );
  const applied = new Set(appliedResult.rows.map((row) => row.migration_name));

  if (direction === 'up') {
    for (const filename of filenames) {
      const migrationName = filename.replace(/\.up\.sql$/, '');
      if (applied.has(migrationName)) continue;
      const sql = await readFile(resolve(migrationsDirectory, filename), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO public.gourmet_growth_schema_migrations (migration_name) VALUES ($1)',
          [migrationName],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
      process.stdout.write(`Applied ${migrationName}\n`);
    }
  } else {
    const migrationName = [...applied].sort().at(-1);
    if (!migrationName) throw new Error('No applied migration is available to roll back.');
    const sql = await readFile(resolve(migrationsDirectory, `${migrationName}.down.sql`), 'utf8');
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('DELETE FROM public.gourmet_growth_schema_migrations WHERE migration_name = $1', [migrationName]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
    process.stdout.write(`Rolled back ${migrationName}\n`);
  }

  if (direction === 'up' && appRole) {
    await client.query(`REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA growth_v2 FROM ${appRole}`);
    await client.query(`REVOKE CREATE ON SCHEMA growth_v2 FROM ${appRole}`);
    await client.query(`GRANT USAGE ON SCHEMA growth_v2 TO ${appRole}`);
    await client.query(`GRANT SELECT, INSERT, UPDATE ON
      growth_v2.visitors,
      growth_v2.sessions,
      growth_v2.attribution_touches,
      growth_v2.leads,
      growth_v2.lead_answers
      TO ${appRole}`);
    await client.query(`GRANT SELECT, INSERT ON growth_v2.events TO ${appRole}`);
    await client.query(`GRANT SELECT ON growth_v2.staff_users TO ${appRole}`);
    await client.query(`GRANT UPDATE (last_login_at, updated_at) ON growth_v2.staff_users TO ${appRole}`);
    await client.query(`GRANT SELECT ON growth_v2.staff_sessions TO ${appRole}`);
    await client.query(`GRANT INSERT
      (staff_session_id, staff_user_id, token_hash, expires_at)
      ON growth_v2.staff_sessions TO ${appRole}`);
    await client.query(`GRANT UPDATE (revoked_at, last_seen_at) ON growth_v2.staff_sessions TO ${appRole}`);
  }
} finally {
  await client.query('SELECT pg_advisory_unlock($1)', [714_202_601]).catch(() => undefined);
  await client.end();
}
