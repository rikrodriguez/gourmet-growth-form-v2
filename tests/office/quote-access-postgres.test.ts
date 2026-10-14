import assert from 'node:assert/strict';
import { before, beforeEach, after, test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createDurableTestQuoteApi } from '../../src/office/backend/event-quote-durable';
import { PostgresEventQuoteStore } from '../../src/office/backend/event-quote-postgres';
import { MondayVault } from '../../src/office/backend/monday-store';
import type { CatalogSnapshot } from '../../src/office/backend/event-quote-contracts';
import { PostgresQuoteAccessRepository } from '../../src/office/backend/quote-access-postgres';
import { DEFAULT_OFFICE_DATABASE_URL } from '../../src/office/backend/postgres-store';
import { EventQuoteError } from '../../src/office/backend/event-quote-contracts';

// Synthetic identities only. No provider, real account, deployment or credentials.
const schema = `quote_access_test_${randomUUID().replaceAll('-', '')}`;
const quoteSchema = `quote_test_${randomUUID().replaceAll('-', '')}`;
const vault = new MondayVault(Buffer.alloc(32, 71));
const pool = new Pool({ connectionString: DEFAULT_OFFICE_DATABASE_URL, connectionTimeoutMillis: 1000 });
const at = Date.parse('2026-10-14T01:00:00Z');
let now = at;
const proof = { sessionToken: 'synthetic_session_token_1234', csrfToken: 'synthetic_csrf_token_1234' };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const repo = () => new PostgresQuoteAccessRepository(pool, { schema, clock: () => now });
const read = { kind: 'read' as const, eventId: 'event-one' };
const rejected = (code: string) => (e: unknown) => e instanceof EventQuoteError && e.code === code;
const inspect = async () => repo().run(proof, read, async identity => identity);

before(async () => {
  await repo().initializeTestSchema();
  await new PostgresEventQuoteStore(pool, { schema: quoteSchema, vault }).initialize();
  await pool.query(`CREATE TABLE ${schema}.probe(value text)`);
});
beforeEach(async () => {
  now = at;
  await pool.query(`TRUNCATE ${schema}.event_grants,${schema}.assignments,${schema}.sessions,${schema}.memberships,${schema}.users,${schema}.probe`);
  await pool.query(`INSERT INTO ${schema}.users VALUES ('org-one','workspace-one','test','actor-one','MANAGER',true,1)`);
  await pool.query(`INSERT INTO ${schema}.memberships VALUES ('membership-one','org-one','workspace-one','test','actor-one',1,$1,NULL)`, [new Date(at - 1000)]);
  await pool.query(`INSERT INTO ${schema}.sessions VALUES ($1,$2,'org-one','workspace-one','test','actor-one','membership-one',1,1,$3,NULL)`, [hash(proof.sessionToken), hash(proof.csrfToken), new Date(at + 60000)]);
  await pool.query(`INSERT INTO ${schema}.assignments VALUES ('org-one','workspace-one','test','event-one','actor-one',1,true)`);
  await pool.query(`INSERT INTO ${schema}.event_grants VALUES ('org-one','workspace-one','test','event-one','actor-one',1,true,true,true,$1,NULL)`, [new Date(at - 1000)]);
});
after(async () => { await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE; DROP SCHEMA IF EXISTS ${quoteSchema} CASCADE`); await pool.end(); });

test('restores authorized test identity through a fresh repository and connection pool', async () => {
  assert.equal((await inspect()).actor.canApprove, true);
  const fresh = new Pool({ connectionString: DEFAULT_OFFICE_DATABASE_URL, connectionTimeoutMillis: 1000 });
  try {
    const result = await new PostgresQuoteAccessRepository(fresh, { schema, clock: () => now }).run(proof, read, async identity => identity);
    assert.equal(result.scope.organizationId, 'org-one');
    assert.equal(result.actor.durable, true);
  } finally { await fresh.end(); }
});
test('rejects missing proof and incorrect CSRF before business operation', async () => {
  let executed = false;
  for (const candidate of [null, { ...proof, csrfToken: 'wrong_synthetic_csrf_1234' }]) {
    await assert.rejects(repo().run(candidate, read, async () => { executed = true; }), rejected('AUTHENTICATION_REQUIRED'));
  }
  assert.equal(executed, false);
});
test('rejects revoked sessions', async () => {
  await pool.query(`UPDATE ${schema}.sessions SET revoked_at=now()`);
  await assert.rejects(inspect(), rejected('AUTHENTICATION_REQUIRED'));
});
test('rejects stale account and membership versions', async () => {
  await pool.query(`UPDATE ${schema}.users SET session_version=2`);
  await assert.rejects(inspect(), rejected('AUTHENTICATION_REQUIRED'));
  await pool.query(`UPDATE ${schema}.users SET session_version=1; UPDATE ${schema}.memberships SET version=2`);
  await assert.rejects(inspect(), rejected('AUTHENTICATION_REQUIRED'));
});
test('rejects disabled accounts and roles not allowed to access quotes', async () => {
  await pool.query(`UPDATE ${schema}.users SET enabled=false`);
  await assert.rejects(inspect(), rejected('AUTHENTICATION_REQUIRED'));
  await pool.query(`UPDATE ${schema}.users SET enabled=true,role='FINANCE'`);
  await assert.rejects(inspect(), rejected('ACCESS_DENIED'));
});
test('denies another event and a stale assignment grant', async () => {
  await assert.rejects(repo().run(proof, { ...read, eventId: 'event-other' }, async () => null), rejected('ACCESS_DENIED'));
  await pool.query(`UPDATE ${schema}.assignments SET version=2`);
  await assert.rejects(inspect(), rejected('ACCESS_DENIED'));
});
test('read-only grant permits reading and rejects create write and approve', async () => {
  await pool.query(`UPDATE ${schema}.event_grants SET can_write=false,can_approve=false`);
  assert.equal((await inspect()).actor.canWrite, false);
  for (const kind of ['create','write','approve'] as const) {
    await assert.rejects(repo().run(proof, { kind, eventId: 'event-one' }, async () => null), rejected('ACCESS_DENIED'));
  }
});
test('closer cannot approve even when the grant requests approval', async () => {
  await pool.query(`UPDATE ${schema}.users SET role='CLOSER'`);
  assert.equal((await inspect()).actor.canApprove, false);
  await assert.rejects(repo().run(proof, { kind: 'approve', eventId: 'event-one' }, async () => null), rejected('ACCESS_DENIED'));
});
test('expired session and ended grant reject access at the exact boundary', async () => {
  now = at + 60000;
  await assert.rejects(inspect(), rejected('AUTHENTICATION_REQUIRED'));
  now = at;
  await pool.query(`UPDATE ${schema}.event_grants SET effective_to=$1`, [new Date(at)]);
  await assert.rejects(inspect(), rejected('ACCESS_DENIED'));
});
test('expiration during the operation rolls back business writes', async () => {
  await assert.rejects(repo().run(proof, { kind: 'write', eventId: 'event-one' }, async (_identity, client) => {
    await client.query(`INSERT INTO ${schema}.probe VALUES ('must-rollback')`);
    now = at + 60000;
  }), rejected('ACCESS_DENIED'));
  assert.equal((await pool.query(`SELECT * FROM ${schema}.probe`)).rowCount, 0);
});
test('business errors roll back and never expose the raw database error', async () => {
  await assert.rejects(repo().run(proof, read, async (_identity, client) => {
    await client.query(`INSERT INTO ${schema}.probe VALUES ('must-rollback')`);
    throw new Error('synthetic private detail');
  }), e => e instanceof EventQuoteError && e.code === 'QUOTE_ACCESS_UNAVAILABLE' && !e.message.includes('private detail'));
  assert.equal((await pool.query(`SELECT * FROM ${schema}.probe`)).rowCount, 0);
});
test('test initialization refuses the default namespace', async () => {
  await assert.rejects(new PostgresQuoteAccessRepository(pool).initializeTestSchema(), rejected('QUOTE_ACCESS_UNAVAILABLE'));
});

test('same actor and event names in another tenant do not authorize this tenant', async () => {
  await pool.query(`DELETE FROM ${schema}.event_grants`);
  await pool.query(`INSERT INTO ${schema}.users VALUES ('org-other','workspace-one','test','actor-one','MANAGER',true,1)`);
  await pool.query(`INSERT INTO ${schema}.assignments VALUES ('org-other','workspace-one','test','event-one','actor-one',1,true)`);
  await pool.query(`INSERT INTO ${schema}.event_grants VALUES ('org-other','workspace-one','test','event-one','actor-one',1,true,true,true,$1,NULL)`, [new Date(at - 1000)]);
  await assert.rejects(inspect(), rejected('ACCESS_DENIED'));
});

test('revocation waits for the authorized transaction and denies the next operation', { timeout: 10000 }, async () => {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const hold = new Promise<void>(resolve => { release = resolve; });
  const updater = await pool.connect();
  const pid = (await updater.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  let update: Promise<unknown> | undefined;
  const operation = repo().run(proof, read, async (_identity, client) => {
    enter(); await hold;
    await client.query(`INSERT INTO ${schema}.probe VALUES ('authorized-before-revocation')`);
  });
  try {
    await entered;
    update = updater.query(`UPDATE ${schema}.sessions SET revoked_at=now()`);
    // Observe an actual PostgreSQL lock wait instead of assuming it from a delay.
    let observed = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const state = (await pool.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1', [pid])).rows[0];
      if (state?.wait_event_type === 'Lock') { observed = true; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(observed, true);
    release(); await operation; await update;
    assert.equal((await pool.query(`SELECT * FROM ${schema}.probe`)).rowCount, 1);
    await assert.rejects(inspect(), rejected('AUTHENTICATION_REQUIRED'));
  } finally {
    release(); await operation.catch(() => undefined); await update?.catch(() => undefined); updater.release();
  }
});

test('HTTP composition persists a quote brief and enforces revoked access after restart', async () => {
  const catalog: CatalogSnapshot = { id: 'catalog-synthetic', version: 'v1', authority: 'test_only', approvalRef: 'synthetic-only',
    source: 'synthetic-test-fixture', currency: 'USD', validUntilMs: at + 3600000, taxBps: 0, depositBps: 5000,
    terms: 'Synthetic fixture only.', items: [{ id: 'meal', label: 'Synthetic meal', unit: 'person', unitPriceCents: 1000 }] };
  const make = () => createDurableTestQuoteApi({ pool, vault, accessSchema: schema, quoteSchema,
    allowedOrigin: 'https://quote.test', clock: () => now,
    resolveExistingSession: async () => proof, catalogFor: async () => catalog });
  const headers = { host: 'quote.test', origin: 'https://quote.test', 'content-type': 'application/json', 'x-event-quote-csrf': proof.csrfToken };
  let app = make();
  try {
    const created = await app.inject({ method: 'POST', url: '/api/office/event-quotes/event-one/commands', headers,
      payload: { action: 'create', key: 'synthetic-create', expectedRevision: 0, brief: {
        contactName: 'Synthetic Customer', recipient: 'synthetic@example.test', originalMessage: 'Synthetic inquiry',
        attendees: 12, proposedDate: '2026-12-20', proposedLocation: 'Synthetic venue', requirements: 'Synthetic requirements',
      } } });
    assert.equal(created.statusCode, 200, created.body);
    assert.equal(created.json().record.revision, 1);
    await app.close(); app = make();
    const restored = await app.inject({ method: 'GET', url: '/api/office/event-quotes/event-one', headers });
    assert.equal(restored.statusCode, 200, restored.body);
    assert.equal(restored.json().record.revision, 1);
    await pool.query(`UPDATE ${schema}.event_grants SET enabled=false`);
    const rejected = await app.inject({ method: 'GET', url: '/api/office/event-quotes/event-one', headers });
    assert.equal(rejected.statusCode, 403);
    assert.equal(rejected.body.includes('Synthetic Customer'), false);
  } finally { await app.close(); }
});
