import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { createOfficeFixtureState } from './fixtures';
import { OfficeError, assertOfficeState, canonical } from './state';
import type { OfficeState, OfficeStore } from './state';
import { StagingVariableError } from './staging-diagnostics';
import { ensureSupplyWorkflow } from './supply-workflow';

export const DEFAULT_OFFICE_DATABASE_URL = 'postgresql://office_candidate@127.0.0.1:55433/gourmet_office_candidate_dev';
export const OFFICE_STATE_ID = 'gourmet-office-candidate-development';
export const STAGING_OFFICE_STATE_ID = 'gourmet-office-synthetic-staging';
export type StagingDatabaseOptions = Readonly<{ host: 'office-db'; port: 5432; user: 'office_stage'; database: 'gourmet_office_stage_demo'; password: string }>;

// The development server refuses remote hosts, production names, passwords and
// URL options. Local Docker uses explicit trust on its loopback-only dev port.
export function validateDevelopmentDatabaseUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new OfficeError('INVALID_DEVELOPMENT_DATABASE', 503); }
  if (!['postgresql:', 'postgres:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.port !== '55433' || url.pathname !== '/gourmet_office_candidate_dev' || url.username !== 'office_candidate' || url.password || url.search || url.hash) {
    throw new OfficeError('INVALID_DEVELOPMENT_DATABASE', 503);
  }
  return value;
}

export function validateStagingDatabaseOptions(value: unknown): StagingDatabaseOptions {
  const invalid = () => new OfficeError('INVALID_STAGING_DATABASE', 503);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some(key => !['host', 'port', 'user', 'database', 'password'].includes(key))) throw invalid();
  if (body.host !== 'office-db') throw new StagingVariableError('INVALID_STAGING_DATABASE', 'OFFICE_STAGING_DB_HOST');
  if (body.port !== 5432) throw new StagingVariableError('INVALID_STAGING_DATABASE', 'OFFICE_STAGING_DB_PORT');
  if (body.user !== 'office_stage') throw new StagingVariableError('INVALID_STAGING_DATABASE', 'OFFICE_STAGING_DB_USER');
  if (body.database !== 'gourmet_office_stage_demo') throw new StagingVariableError('INVALID_STAGING_DATABASE', 'OFFICE_STAGING_DB_NAME');
  if (typeof body.password !== 'string' || body.password.length < 24 || body.password.length > 256 || /[\u0000-\u001f\u007f]/u.test(body.password)) throw new StagingVariableError('INVALID_STAGING_DATABASE', 'OFFICE_STAGING_DB_PASSWORD');
  return Object.freeze({ host: body.host, port: body.port, user: body.user, database: body.database, password: body.password });
}

export class PostgresOfficeStore implements OfficeStore {
  readonly pool: Pool;
  private ready = false;
  constructor(options: { mode?: 'development'; connectionString?: string; stateId?: string } | { mode: 'staging'; database: StagingDatabaseOptions; stateId?: string } = {}) {
    const staging = options.mode === 'staging';
    this.stateId = options.stateId ?? (staging ? STAGING_OFFICE_STATE_ID : OFFICE_STATE_ID);
    if (!/^[a-z0-9][a-z0-9_-]{0,95}$/.test(this.stateId)) throw new OfficeError('INVALID_STATE_ID', 503);
    if (staging && this.stateId !== STAGING_OFFICE_STATE_ID) throw new OfficeError('INVALID_STATE_ID', 503);
    const database = staging ? { ...validateStagingDatabaseOptions(options.database), ssl: false, options: '' } : { connectionString: validateDevelopmentDatabaseUrl(options.connectionString ?? DEFAULT_OFFICE_DATABASE_URL) };
    this.pool = new Pool({ ...database, max: 4, connectionTimeoutMillis: 3000, idleTimeoutMillis: 10000, statement_timeout: 5000, application_name: staging ? 'gourmet-office-synthetic-staging' : 'gourmet-office-synthetic-development' });
    // An idle pool error must not crash the process or expose connection details.
    this.pool.on('error', () => { /* pg evicts the broken idle client; next call reconnects without re-seeding. */ });
  }
  readonly stateId: string;

  async initialize(nowMs = Date.now()): Promise<void> {
    const migrations = await Promise.all(['001_office_demo.sql', '002_append_only_history.sql', '003_monday_oauth.sql'].map(async name => {
      const sql = await readFile(new URL(`../../../migrations/office/${name}`, import.meta.url), 'utf8');
      return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
    }));
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '5s'");
      // Serialize migration application, including concurrent API/test startup.
      await client.query('SELECT pg_advisory_xact_lock($1)', [47001901]);
      for (const migration of migrations) {
        const existingTable = await client.query<{ table_name: string | null }>("SELECT to_regclass('office_demo.migrations') AS table_name");
        if (existingTable.rows[0].table_name) {
          const previous = await client.query<{ sha256: string }>('SELECT sha256 FROM office_demo.migrations WHERE name = $1', [migration.name]);
          if (previous.rows.length) {
            if (previous.rows[0].sha256 !== migration.checksum) throw new OfficeError('MIGRATION_CHECKSUM_MISMATCH', 503);
            continue;
          }
        }
        await client.query(migration.sql);
        await client.query('INSERT INTO office_demo.migrations(name, sha256) VALUES ($1, $2)', [migration.name, migration.checksum]);
      }
      const fixture = createOfficeFixtureState(nowMs);
      assertOfficeState(fixture);
      await client.query('INSERT INTO office_demo.states(id, payload) VALUES ($1, $2::jsonb) ON CONFLICT (id) DO NOTHING', [this.stateId, JSON.stringify(fixture)]);
      const stored = await client.query<{ payload: OfficeState }>('SELECT payload FROM office_demo.states WHERE id = $1 FOR UPDATE', [this.stateId]);
      if (stored.rows.length !== 1) throw new OfficeError('OFFICE_STATE_MISSING', 503);
      const state = stored.rows[0].payload;
      assertOfficeState(state);
      const before = canonical(state);
      // Upgrade this aggregate under the same row lock used by commands. Keep
      // old approvals, digests, durable intents and append-only history intact.
      ensureSupplyWorkflow(state, nowMs);
      assertOfficeState(state);
      if (canonical(state) !== before) await client.query('UPDATE office_demo.states SET payload = $2::jsonb, revision = revision + 1, updated_at = clock_timestamp() WHERE id = $1', [this.stateId, JSON.stringify(state)]);
      for (const row of Object.values(state.office.history)) await client.query('INSERT INTO office_demo.history_events(state_id, history_id, record) VALUES ($1,$2,$3::jsonb) ON CONFLICT (state_id, history_id) DO NOTHING', [this.stateId, row.id, JSON.stringify(row)]);
      await client.query('COMMIT');
      this.ready = true;
    } catch (error) {
      await rollback(client);
      throw error;
    } finally { client.release(); }
    await this.snapshot();
  }

  async transact<T>(fn: (state: OfficeState) => T | Promise<T>): Promise<T> {
    if (!this.ready) throw new OfficeError('OFFICE_STORAGE_UNAVAILABLE', 503);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '5s'");
      const result = await client.query<{ payload: OfficeState }>('SELECT payload FROM office_demo.states WHERE id = $1 FOR UPDATE', [this.stateId]);
      if (result.rows.length !== 1) throw new OfficeError('OFFICE_STATE_MISSING', 503);
      const state = result.rows[0].payload;
      assertOfficeState(state);
      const before = canonical(state);
      const oldHistory = structuredClone(state.office.history);
      const oldCommands = structuredClone(state.office.commands);
      const oldKeys = new Set(Object.keys(state.office.commands));
      const output = await fn(state);
      assertOfficeState(state);
      for (const [key, row] of Object.entries(oldHistory)) if (!Object.hasOwn(state.office.history, key) || canonical(state.office.history[key]) !== canonical(row)) throw new OfficeError('HISTORY_APPEND_ONLY', 409);
      for (const [key, row] of Object.entries(oldCommands)) if (!Object.hasOwn(state.office.commands, key) || canonical(state.office.commands[key]) !== canonical(row)) throw new OfficeError('COMMANDS_APPEND_ONLY', 409);
      for (const row of Object.values(state.office.commands)) {
        if (oldKeys.has(row.key)) continue;
        await client.query('INSERT INTO office_demo.command_events(state_id, command_key, digest, case_id, function_id, action, actor_id, recorded_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [this.stateId, row.key, row.digest, row.input.caseId, row.input.functionId, row.input.action, row.actorId, new Date(row.atMs).toISOString()]);
      }
      for (const row of Object.values(state.office.history)) if (!Object.hasOwn(oldHistory, row.id)) await client.query('INSERT INTO office_demo.history_events(state_id, history_id, record) VALUES ($1,$2,$3::jsonb)', [this.stateId, row.id, JSON.stringify(row)]);
      if (canonical(state) !== before) await client.query('UPDATE office_demo.states SET payload = $2::jsonb, revision = revision + 1, updated_at = clock_timestamp() WHERE id = $1', [this.stateId, JSON.stringify(state)]);
      await client.query('COMMIT');
      return output;
    } catch (error) {
      await rollback(client);
      throw error;
    } finally { client.release(); }
  }

  async snapshot(): Promise<OfficeState> {
    if (!this.ready) throw new OfficeError('OFFICE_STORAGE_UNAVAILABLE', 503);
    const result = await this.pool.query<{ payload: OfficeState }>('SELECT payload FROM office_demo.states WHERE id = $1', [this.stateId]);
    if (result.rows.length !== 1) throw new OfficeError('OFFICE_STATE_MISSING', 503);
    assertOfficeState(result.rows[0].payload);
    return structuredClone(result.rows[0].payload);
  }
  async close(): Promise<void> { this.ready = false; await this.pool.end(); }
}
async function rollback(client: PoolClient) { try { await client.query('ROLLBACK'); } catch { /* Preserve the original safe boundary error. */ } }
