import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { setTimeout as pause } from 'node:timers/promises';
import { Pool, type PoolClient } from 'pg';
import { EventQuoteError } from '../../src/office/backend/event-quote-contracts';
import { PostgresQuoteAccessRepository } from '../../src/office/backend/quote-access-postgres';
import { DEFAULT_OFFICE_DATABASE_URL } from '../../src/office/backend/postgres-store';

const proof = { sessionToken: 'synthetic_timeout_session_1234', csrfToken: 'synthetic_timeout_csrf_1234' };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const at = Date.parse('2026-10-14T01:00:00Z');
const unavailable = (error: unknown) => error instanceof EventQuoteError && error.code === 'QUOTE_ACCESS_UNAVAILABLE';
const session = { organization_id: 'org-one', workspace_id: 'space-one', mode: 'test', actor_id: 'actor-one',
  role: 'MANAGER', enabled: true, revoked: false, session_version: 1, current_session_version: 1,
  membership_version: 1, current_membership_version: 1, csrf_hash: hash(proof.csrfToken),
  expires_ms: String(at + 60_000), membership_from_ms: String(at - 1_000), membership_to_ms: null };
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
class SyntheticClient extends EventEmitter {
  pipeline = false;
  closed = false;
  queries: string[] = [];
  releases: boolean[] = [];
  intercept?: (sql: string) => Promise<{ rows: unknown[] }> | undefined;
  async query(sql: string) {
    if (this.closed) throw new Error('Synthetic closed client');
    this.queries.push(sql);
    return this.intercept?.(sql) ?? { rows: sql.startsWith('SELECT s.') ? [session] : [] };
  }
  release(destroy = false) {
    assert.equal(this.releases.length, 0, 'client must be released only once');
    this.releases.push(destroy);
    if (destroy) this.closed = true;
  }
}
function fixture(timeoutMs = 60, client = new SyntheticClient()) {
  const pool = { options: { connectionTimeoutMillis: 1000 }, connect: async () => client };
  const repo = new PostgresQuoteAccessRepository(pool as unknown as Pool, { clock: () => at, timeoutMs });
  return { client, pool, repo };
}

test('quote timeout rejects unbounded pool acquisition, connection hooks and pipelined clients', () => {
  for (const connectionTimeoutMillis of [undefined, 0, -1, 30_001, NaN]) {
    const pool = { options: { connectionTimeoutMillis } } as unknown as Pool;
    assert.throws(() => new PostgresQuoteAccessRepository(pool), unavailable);
  }
  assert.throws(() => new PostgresQuoteAccessRepository({ options: { connectionTimeoutMillis: 1000, pipeline: true } } as Pool), unavailable);
  for (const hooks of [{ onConnect: async () => {} }, { verify: () => {} }]) {
    assert.throws(() => new PostgresQuoteAccessRepository({ options: { connectionTimeoutMillis: 1000, ...hooks } } as unknown as Pool), unavailable);
  }
  for (const timeoutMs of [0, -1, 30_001, NaN]) {
    assert.throws(() => new PostgresQuoteAccessRepository({ options: { connectionTimeoutMillis: 1000 } } as Pool, { timeoutMs }), unavailable);
  }
});

test('quote timeout destroys a lease acquired after the request already expired', { timeout: 2000 }, async () => {
  const t = fixture(), acquisition = deferred<SyntheticClient>();
  t.pool.connect = () => acquisition.promise;
  let called = false;
  await assert.rejects(t.repo.run(proof, { kind: 'status' }, async () => { called = true; }), unavailable);
  acquisition.resolve(t.client);
  await pause(0);
  assert.equal(called, false);
  assert.deepEqual(t.client.queries, []);
  assert.deepEqual(t.client.releases, [true]);
});

test('quote timeout closes authority connection and rejects late callback writes', { timeout: 2000 }, async () => {
  const t = fixture(), entered = deferred(), hold = deferred(), lateDone = deferred();
  const result = t.repo.run(proof, { kind: 'status' }, async (_identity, client) => {
    entered.resolve(); await hold.promise;
    try { await client.query('INSERT late-write'); } finally { lateDone.resolve(); }
  });
  const rejected = assert.rejects(result, unavailable);
  await entered.promise;
  await rejected;
  assert.deepEqual(t.client.releases, [true]);
  hold.resolve(); await lateDone.promise; await pause(0);
  assert.equal(t.client.queries.includes('INSERT late-write'), false);
  assert.equal(t.client.queries.includes('COMMIT'), false);
  assert.deepEqual(t.client.releases, [true]);
});

test('quote timeout after a queued authority query never invokes the callback', { timeout: 2000 }, async () => {
  const t = fixture(), selection = deferred<{ rows: unknown[] }>();
  t.client.intercept = sql => sql.startsWith('SELECT s.') ? selection.promise : undefined;
  let called = false;
  await assert.rejects(t.repo.run(proof, { kind: 'status' }, async () => { called = true; }), unavailable);
  selection.resolve({ rows: [session] }); await pause(0);
  assert.equal(called, false);
  assert.deepEqual(t.client.releases, [true]);
  assert.equal(t.client.queries.includes('COMMIT'), false);
});

test('quote deadline preserves successful commit and ordinary rollback paths', async () => {
  const ok = fixture(1000);
  assert.equal(await ok.repo.run(proof, { kind: 'status' }, async () => 'value'), 'value');
  assert.deepEqual(ok.client.releases, [false]);
  assert.equal(ok.client.queries.at(-1), 'COMMIT');
  assert.match(ok.client.queries[1], /statement_timeout.*idle_in_transaction_session_timeout.*lock_timeout/);
  const failed = fixture(1000);
  await assert.rejects(failed.repo.run(proof, { kind: 'status' }, async () => { throw new EventQuoteError('ACCESS_DENIED', 403); }),
    error => error instanceof EventQuoteError && error.code === 'ACCESS_DENIED');
  assert.equal(failed.client.queries.at(-1), 'ROLLBACK');
  assert.deepEqual(failed.client.releases, [false]);
});

test('quote timeout destroys rather than awaiting an unresponsive rollback', { timeout: 2000 }, async () => {
  const t = fixture(), rollback = deferred<{ rows: unknown[] }>();
  t.client.intercept = sql => sql === 'ROLLBACK' ? rollback.promise : undefined;
  await assert.rejects(t.repo.run(proof, { kind: 'status' }, async () => { throw new Error('synthetic failure'); }), unavailable);
  assert.deepEqual(t.client.releases, [true]);
  rollback.resolve({ rows: [] }); await pause(0);
  assert.deepEqual(t.client.releases, [true]);
});

test('quote connection errors interrupt a stalled callback without an unhandled error event', { timeout: 2000 }, async () => {
  for (const event of ['error', 'end']) {
    const t = fixture(1000), entered = deferred(), hold = deferred();
    const result = t.repo.run(proof, { kind: 'status' }, async () => { entered.resolve(); await hold.promise; });
    const rejected = assert.rejects(result, unavailable);
    await entered.promise;
    t.client.emit(event, new Error('synthetic connection loss'));
    await rejected;
    hold.resolve(); await pause(0);
    assert.deepEqual(t.client.releases, [true]);
    assert.equal(t.client.queries.includes('COMMIT'), false);
  }
});

test('quote timeout during COMMIT returns failure and never pretends rollback is certain', { timeout: 2000 }, async () => {
  const t = fixture(), commit = deferred<{ rows: unknown[] }>();
  t.client.intercept = sql => sql === 'COMMIT' ? commit.promise : undefined;
  await assert.rejects(t.repo.run(proof, { kind: 'status' }, async () => 'must-not-return'), unavailable);
  assert.equal(t.client.queries.filter(sql => sql === 'COMMIT').length, 1);
  assert.equal(t.client.queries.includes('ROLLBACK'), false);
  assert.deepEqual(t.client.releases, [true]);
  commit.resolve({ rows: [] }); await pause(0);
  assert.deepEqual(t.client.releases, [true]);
});

test('quote timeout refuses a custom pipelined client before beginning a transaction', async () => {
  const t = fixture(); t.client.pipeline = true;
  await assert.rejects(t.repo.run(proof, { kind: 'status' }, async () => 'must-not-return'), unavailable);
  assert.deepEqual(t.client.queries, []);
  assert.deepEqual(t.client.releases, [true]);
});

test('PostgreSQL pool timeout removes expired acquisition requests from the queue', { timeout: 5000 }, async () => {
  const pool = new Pool({ connectionString: DEFAULT_OFFICE_DATABASE_URL, max: 1, connectionTimeoutMillis: 150 });
  const held = await pool.connect();
  const repo = new PostgresQuoteAccessRepository(pool, { clock: () => at, timeoutMs: 50 });
  let called = false;
  try {
    await assert.rejects(repo.run(proof, { kind: 'status' }, async () => { called = true; }), unavailable);
    assert.equal(called, false);
    for (let attempt = 0; attempt < 80 && pool.waitingCount; attempt++) await pause(5);
    assert.equal(pool.waitingCount, 0, 'pg acquisition deadline must remove the abandoned queue entry');
  } finally { held.release(); await pool.end(); }
});

test('PostgreSQL quote timeout rolls back writes, unblocks revocation and replaces the client', { timeout: 15000 }, async () => {
  const schema = `quote_access_test_${randomUUID().replaceAll('-', '')}`;
  const pool = new Pool({ connectionString: DEFAULT_OFFICE_DATABASE_URL, max: 1, connectionTimeoutMillis: 1000 });
  const observer = new Pool({ connectionString: DEFAULT_OFFICE_DATABASE_URL, connectionTimeoutMillis: 1000 });
  const repo = new PostgresQuoteAccessRepository(pool, { schema, clock: () => at, timeoutMs: 1000 });
  const entered = deferred(), hold = deferred(), lateDone = deferred();
  let result: Promise<unknown> | undefined, update: Promise<unknown> | undefined, backendPid: number | undefined;
  let heldClient: PoolClient | undefined;
  try {
    await repo.initializeTestSchema();
    await pool.query(`CREATE TABLE ${schema}.probe(value text);
      INSERT INTO ${schema}.users VALUES ('org-one','space-one','test','actor-one','MANAGER',true,1);
      INSERT INTO ${schema}.memberships VALUES ('member-one','org-one','space-one','test','actor-one',1,'2026-10-14T00:00:00Z',NULL)`);
    await pool.query(`INSERT INTO ${schema}.sessions VALUES ($1,$2,'org-one','space-one','test','actor-one','member-one',1,1,$3,NULL)`,
      [hash(proof.sessionToken), hash(proof.csrfToken), new Date(at + 60_000)]);
    result = repo.run(proof, { kind: 'status' }, async (_identity, client) => {
      heldClient = client;
      backendPid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await client.query(`INSERT INTO ${schema}.probe VALUES ('must-rollback')`);
      entered.resolve(); await hold.promise;
      try { await client.query(`INSERT INTO ${schema}.probe VALUES ('late-write')`); }
      finally { lateDone.resolve(); }
    });
    const rejected = assert.rejects(result, unavailable);
    await entered.promise;
    const updater = await observer.connect();
    try {
      const updaterPid = (await updater.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      update = updater.query(`UPDATE ${schema}.sessions SET revoked_at=now()`);
      let observed = false;
      for (let attempt = 0; attempt < 80; attempt++) {
        const state = (await observer.query('SELECT $1::integer = ANY(pg_blocking_pids($2)) AS blocked', [backendPid, updaterPid])).rows[0];
        if (state.blocked) { observed = true; break; }
        await pause(5);
      }
      assert.equal(observed, true, 'revocation must actually wait for the authority lock');
      await rejected;
      await update;
      assert.equal((await observer.query(`SELECT * FROM ${schema}.probe`)).rowCount, 0);
      await assert.rejects(heldClient!.query('SELECT 1'));
      hold.resolve(); await lateDone.promise;
      assert.equal((await observer.query(`SELECT * FROM ${schema}.probe`)).rowCount, 0);
      const replacementPid = (await pool.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      assert.notEqual(replacementPid, backendPid);
      assert.equal((await observer.query(`SELECT revoked_at IS NOT NULL AS revoked FROM ${schema}.sessions`)).rows[0].revoked, true);
    } finally { await update?.catch(() => undefined); updater.release(); }
  } finally {
    hold.resolve(); await result?.catch(() => undefined);
    await observer.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.end(); await observer.end();
  }
});
