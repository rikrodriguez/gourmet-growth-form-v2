import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { before, after, describe, it } from 'node:test';
import { Pool } from 'pg';
import { CanonicalBridge, CanonicalBridgeError, MemoryCanonicalBridgeStore, validateCanonicalBridgeStoredValue } from '../../src/office/backend/canonical-bridge';
import { PostgresCanonicalBridgeStore } from '../../src/office/backend/canonical-bridge-postgres';
import { DEFAULT_OFFICE_DATABASE_URL } from '../../src/office/backend/postgres-store';
import type { BridgeBindingRevision, BridgeCommand, BridgeScope, BridgeSourceVersion } from '../../src/office/canonical-bridge-contracts';

const AT = Date.parse('2026-10-12T06:00:00.000Z');
const SOURCES = [{ sourceSystem: 'fixture:office', partition: 'demo' }, { sourceSystem: 'monday:synthetic', partition: 'external' }] as const;
const scope = (suffix: string, partition: BridgeScope['partition'] = 'demo'): BridgeScope => ({ organizationId: `org-${suffix}`, actorId: 'actor-synthetic', partition });
const keyFor = (value: BridgeScope) => `bridge-${createHash('sha256').update(JSON.stringify([value.organizationId, value.actorId, value.partition])).digest('hex')}`;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const code = (expected: string) => (error: unknown) => error instanceof CanonicalBridgeError && error.code === expected && error.message === expected;
const schema = `bridge_test_${randomUUID().replaceAll('-', '')}`;
const emptySchema = `bridge_test_${randomUUID().replaceAll('-', '')}`;
const pools: Pool[] = [];
const closedPools = new Set<Pool>();
const connect = () => { const pool = new Pool({ connectionString: DEFAULT_OFFICE_DATABASE_URL, max: 4, connectionTimeoutMillis: 1000, statement_timeout: 5000 }); pools.push(pool); return pool; };
async function disconnect(connection: Pool) { await connection.end(); closedPools.add(connection); }
let pool: Pool;
let up: string;
let down: string;
const ddl = (sql: string, target = schema) => sql.replaceAll('office_canonical_bridge', target);
const storeFor = (connection: Pool) => new PostgresCanonicalBridgeStore(connection, { sources: SOURCES, schema });
const bridgeFor = (connection: Pool) => new CanonicalBridge(storeFor(connection), { sources: SOURCES, clock: () => AT });
function command(value: BridgeScope, revision: number, suffix: string, kind: 'lead' | 'event' | 'quote' | 'invoice' = 'lead'): BridgeCommand {
  return { action: 'record_source', idempotencyKey: `command-${suffix}`, expectedRevision: revision, kind,
    reference: { sourceSystem: value.partition === 'demo' ? 'fixture:office' : 'monday:synthetic', boardId: `board-${kind}`, itemId: `item-${suffix}` },
    sourceVersion: 'version-1', contentDigest: digest(suffix), provenance: { evidenceRef: `evidence-${suffix}`, observedAtMs: AT - 1 } };
}
async function ledger(value: BridgeScope, commands: BridgeCommand[]) {
  const memory = new MemoryCanonicalBridgeStore(); const bridge = new CanonicalBridge(memory, { sources: SOURCES, clock: () => AT });
  for (const body of commands) await bridge.execute(value, body);
  return (await memory.read(keyFor(value)))!.value;
}
async function counts(value: BridgeScope) {
  const result = await pool.query(`SELECT revision, (SELECT count(*)::int FROM ${schema}.audit_events a WHERE a.workspace_key=w.key) AS audits FROM ${schema}.workspaces w WHERE key=$1`, [keyFor(value)]);
  return result.rows[0] ?? null;
}

describe('canonical bridge shared durable-value validation', () => {
  it('returns detached replay-validated state, scope, exact event digest and timestamp', async () => {
    const value = scope('validator'); const raw = await ledger(value, [command(value, 0, 'validator')]);
    const validated = await validateCanonicalBridgeStoredValue(keyFor(value), raw, { sources: SOURCES });
    assert.deepEqual(validated.scope, value); assert.equal(validated.revision, 1); assert.equal(validated.events.length, 1);
    assert.equal(validated.lastDigest, validated.events[0].digest); assert.equal(validated.lastAtMs, AT);
    assert.deepEqual(validated.value, raw); validated.scope.actorId = 'mutated-validator-output';
    assert.deepEqual((await validateCanonicalBridgeStoredValue(keyFor(value), raw, { sources: SOURCES })).scope, value);
  });

  it('rejects cross-scope keys, malformed payload and altered history without evaluating accessors', async () => {
    const value = scope('validator-invalid'); const raw = await ledger(value, [command(value, 0, 'validator-invalid')]);
    const altered = structuredClone(raw) as { events: { digest: string }[] }; altered.events[0].digest = 'a'.repeat(64);
    for (const candidate of [null, { schemaVersion: 1, scope: value, revision: 1, events: [] }, altered]) await assert.rejects(validateCanonicalBridgeStoredValue(keyFor(value), candidate, { sources: SOURCES }), code('BRIDGE_STATE_INVALID'));
    await assert.rejects(validateCanonicalBridgeStoredValue(keyFor({ ...value, actorId: 'foreign-actor' }), raw, { sources: SOURCES }), code('BRIDGE_STATE_INVALID'));
    let accesses = 0; const executable = {};
    Object.defineProperty(executable, 'scope', { enumerable: true, get() { accesses++; throw new Error('SYNTHETIC_PRIVATE_GETTER'); } });
    await assert.rejects(validateCanonicalBridgeStoredValue(keyFor(value), executable, { sources: SOURCES }), code('BRIDGE_STATE_INVALID')); assert.equal(accesses, 0);
  });
});

describe('canonical bridge real PostgreSQL durability (synthetic isolated schema)', () => {
  before(async () => {
    [up, down] = await Promise.all(['up', 'down'].map(direction => readFile(new URL(`../../migrations/office/004_canonical_bridge.${direction}.sql`, import.meta.url), 'utf8')));
    pool = connect(); await pool.query(ddl(up));
  });
  after(async () => {
    // The fixtures are confined to a fresh random schema in the loopback dev DB.
    // Never weaken the normal down migration to erase populated history.
    try { if (pool) await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); }
    finally { await Promise.all(pools.filter(connection => !closedPools.has(connection)).map(disconnect)); }
  });

  it('survives replacing service, store and PostgreSQL pool with exact replay and audit', async () => {
    const value = scope('restart'); const originatingPool = connect(); const first = bridgeFor(originatingPool); const body = command(value, 0, 'restart-lead');
    await first.execute(value, body); await first.execute(value, command(value, 1, 'restart-event', 'event'));
    const before = await first.snapshot(value); await disconnect(originatingPool);
    await assert.rejects(first.snapshot(value), code('BRIDGE_STORE_UNAVAILABLE'));
    const independent = connect(); const restarted = bridgeFor(independent);
    assert.deepEqual(await restarted.snapshot(value), before);
    assert.equal((await restarted.execute(value, body)).replayed, true);
    assert.deepEqual(await counts(value), { revision: 2, audits: 2 });
    const rows = await pool.query(`SELECT organization_id, actor_id, partition, revision, logical_revision, digest, event_at_ms, committed_at, event_record FROM ${schema}.audit_events WHERE workspace_key=$1 ORDER BY revision`, [keyFor(value)]);
    assert.equal(rows.rowCount, 2);
    for (const row of rows.rows) {
      assert.equal(row.organization_id, value.organizationId); assert.equal(row.actor_id, value.actorId); assert.equal(row.partition, value.partition);
      assert.equal(row.logical_revision, row.revision); assert.equal(row.digest, row.event_record.digest); assert.equal(row.event_at_ms, String(AT)); assert(row.committed_at instanceof Date);
    }
  });

  it('serializes concurrent insert and update CAS across independent connections exactly once', async () => {
    const value = scope('race'); const a = storeFor(pool); const b = storeFor(connect()); const first = await ledger(value, [command(value, 0, 'race-first')]);
    const inserted = await Promise.all([a.compareAndSet(keyFor(value), null, first), b.compareAndSet(keyFor(value), null, first)]);
    assert.equal(inserted.filter(Boolean).length, 1); assert.deepEqual(await counts(value), { revision: 1, audits: 1 });
    const left = await ledger(value, [command(value, 0, 'race-first'), command(value, 1, 'race-left', 'event')]);
    const right = await ledger(value, [command(value, 0, 'race-first'), command(value, 1, 'race-right', 'event')]);
    const updated = await Promise.all([a.compareAndSet(keyFor(value), 1, left), b.compareAndSet(keyFor(value), 1, right)]);
    assert.equal(updated.filter(Boolean).length, 1); assert.deepEqual(await counts(value), { revision: 2, audits: 2 });
    assert.equal(await a.compareAndSet(keyFor(value), 1, left), false); assert.deepEqual(await counts(value), { revision: 2, audits: 2 });
  });

  it('isolates organization, actor and DEMO/external partition at storage and service boundaries', async () => {
    const original = scope('isolated'); const values = [original, { ...original, organizationId: 'org-other' }, { ...original, actorId: 'actor-other' }, { ...original, partition: 'external' as const }];
    const service = bridgeFor(pool);
    for (const value of values) {
      assert.equal((await service.snapshot(value)).revision, 0);
      await service.execute(value, command(value, 0, 'identical-command'));
    }
    const snapshots = await Promise.all(values.map(value => service.snapshot(value)));
    assert.equal(new Set(snapshots.map(row => row.sourceVersions[0].id)).size, 4);
    for (let index = 0; index < values.length; index++) {
      assert.deepEqual(snapshots[index].scope, values[index]); assert.equal(snapshots[index].revision, 1);
      for (let other = 0; other < values.length; other++) if (other !== index) await assert.rejects(service.resolve(values[index], snapshots[other].sourceVersions[0].id), code('BRIDGE_REFERENCE_NOT_FOUND'));
    }
    const wrong = await ledger(values[1], [command(values[1], 0, 'foreign-payload')]);
    await assert.rejects(storeFor(pool).compareAndSet(keyFor(original), 1, wrong), code('BRIDGE_STATE_INVALID'));
    const blank = scope('wrong-key');
    await assert.rejects(pool.query(`INSERT INTO ${schema}.workspaces(key,organization_id,actor_id,partition,revision,payload) VALUES($1,$2,$3,$4,1,$5::jsonb)`, [keyFor(blank), values[1].organizationId, values[1].actorId, values[1].partition, JSON.stringify(wrong)]));
    assert.deepEqual(await counts(original), { revision: 1, audits: 1 });
  });

  it('preserves duplicate source observations, versions, unlink and reversal history across restart', async () => {
    const value = scope('versions'); const service = bridgeFor(pool); const first = command(value, 0, 'versions-lead');
    const lead = (await service.execute(value, first)).recorded as BridgeSourceVersion;
    const repeated = await service.execute(value, { ...first, expectedRevision: 1, idempotencyKey: 'second-observation' }); assert.equal(repeated.deduplicated, true);
    const next = await service.execute(value, { ...first, expectedRevision: 2, idempotencyKey: 'new-version', sourceVersion: 'version-2', contentDigest: digest('version-2') });
    const event = (await service.execute(value, command(value, 3, 'versions-event', 'event'))).recorded as BridgeSourceVersion;
    const bound = (await service.execute(value, { action: 'bind', idempotencyKey: 'versions-bind', expectedRevision: 4, bindingId: 'binding-synthetic', expectedBindingRevision: 0, expectedBindingDigest: null, evidenceRef: 'explicit-binding', refs: { lead: lead.id, event: event.id, quote: null, invoice: null } })).recorded as BridgeBindingRevision;
    const removed = (await service.execute(value, { action: 'unlink', idempotencyKey: 'versions-unlink', expectedRevision: 5, bindingId: bound.bindingId, expectedBindingRevision: 1, expectedBindingDigest: bound.digest, evidenceRef: 'explicit-unlink' })).recorded as BridgeBindingRevision;
    await service.execute(value, { action: 'revert', idempotencyKey: 'versions-revert', expectedRevision: 6, bindingId: bound.bindingId, expectedBindingRevision: 2, expectedBindingDigest: removed.digest, evidenceRef: 'explicit-revert', targetRevision: 1 });
    const restarted = bridgeFor(connect()); const snapshot = await restarted.snapshot(value);
    assert.equal(snapshot.sourceVersions.length, 3); assert.equal(snapshot.bindings.length, 3); assert.equal(snapshot.bindings[2].revision, 3); assert.equal(snapshot.bindings[2].action, 'revert');
    assert('id' in next.recorded); assert.notEqual(lead.id, next.recorded.id); assert.equal(snapshot.bindings[2].refs?.lead, lead.id);
    assert.deepEqual(await restarted.readBinding(value, bound.bindingId, 1), bound); assert.deepEqual(await counts(value), { revision: 7, audits: 7 });
  });

  it('rejects valid but rewritten or truncated prior history and nonmonotonic revisions', async () => {
    const value = scope('append-only'); const store = storeFor(pool); const first = command(value, 0, 'append-first');
    const initial = await ledger(value, [first]); await store.compareAndSet(keyFor(value), null, initial);
    const next = await ledger(value, [first, command(value, 1, 'append-next', 'event')]); await store.compareAndSet(keyFor(value), 1, next);
    const rewritten = await ledger(value, [command(value, 0, 'rewritten-first'), command(value, 1, 'append-next', 'event'), command(value, 2, 'append-last', 'quote')]);
    for (const payload of [rewritten, initial, next]) await assert.rejects(store.compareAndSet(keyFor(value), 2, payload), code('BRIDGE_STATE_INVALID'));
    assert.deepEqual((await store.read(keyFor(value)))!.value, next); assert.deepEqual(await counts(value), { revision: 2, audits: 2 });
    await assert.rejects(pool.query(`UPDATE ${schema}.workspaces SET payload=$2::jsonb,revision=3 WHERE key=$1`, [keyFor(value), JSON.stringify(rewritten)]), /BRIDGE_HISTORY_APPEND_ONLY/);
    await assert.rejects(pool.query(`DELETE FROM ${schema}.workspaces WHERE key=$1`, [keyFor(value)]), /BRIDGE_HISTORY_APPEND_ONLY/);
    await assert.rejects(pool.query(`TRUNCATE ${schema}.workspaces CASCADE`), /BRIDGE_(HISTORY|AUDIT)_APPEND_ONLY/);
  });

  it('keeps conflict failures and foreign references out of the durable ledger and audit', async () => {
    const value = scope('semantic-conflict'); const service = bridgeFor(pool); const first = command(value, 0, 'conflict-lead');
    await service.execute(value, first); const before = await service.snapshot(value);
    await assert.rejects(service.execute(value, { ...first, expectedRevision: 1, idempotencyKey: 'changed-version-content', contentDigest: digest('different-content') }), code('BRIDGE_VERSION_CONFLICT'));
    await assert.rejects(service.execute(value, { ...first, expectedRevision: 1, contentDigest: digest('different-idempotent-content') }), code('BRIDGE_IDEMPOTENCY_CONFLICT'));
    await assert.rejects(service.execute(value, { action: 'bind', idempotencyKey: 'foreign-binding', expectedRevision: 1, bindingId: 'binding-foreign', expectedBindingRevision: 0, expectedBindingDigest: null, evidenceRef: 'unproven-binding', refs: { lead: before.sourceVersions[0].id, event: 'version-missing', quote: null, invoice: null } }), code('BRIDGE_REFERENCE_NOT_FOUND'));
    assert.deepEqual(await service.snapshot(value), before); assert.deepEqual(await counts(value), { revision: 1, audits: 1 });
  });

  it('rolls back workspace changes if atomic audit insertion fails', async () => {
    const value = scope('rollback'); const service = bridgeFor(pool); await service.execute(value, command(value, 0, 'rollback-first'));
    const before = await service.snapshot(value);
    await pool.query(`CREATE FUNCTION ${schema}.fail_test_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.organization_id = 'org-rollback' THEN RAISE EXCEPTION 'SYNTHETIC_PRIVATE_FAILURE_DETAIL'; END IF; RETURN NEW; END; $$; CREATE TRIGGER fail_test_audit BEFORE INSERT ON ${schema}.audit_events FOR EACH ROW EXECUTE FUNCTION ${schema}.fail_test_audit()`);
    try { await assert.rejects(service.execute(value, command(value, 1, 'rollback-second', 'event')), code('BRIDGE_STORE_UNAVAILABLE')); }
    finally { await pool.query(`DROP TRIGGER fail_test_audit ON ${schema}.audit_events; DROP FUNCTION ${schema}.fail_test_audit()`); }
    assert.deepEqual(await service.snapshot(value), before); assert.deepEqual(await counts(value), { revision: 1, audits: 1 });
  });

  it('protects audit against update, deletion, truncate and direct forged insertion', async () => {
    const value = scope('audit-protected'); await bridgeFor(pool).execute(value, command(value, 0, 'audit-protected'));
    for (const sql of [`UPDATE ${schema}.audit_events SET digest=repeat('a',64) WHERE workspace_key=$1`, `DELETE FROM ${schema}.audit_events WHERE workspace_key=$1`]) await assert.rejects(pool.query(sql, [keyFor(value)]), /BRIDGE_AUDIT_APPEND_ONLY/);
    await assert.rejects(pool.query(`TRUNCATE ${schema}.audit_events`), /BRIDGE_AUDIT_APPEND_ONLY/);
    await assert.rejects(pool.query(`INSERT INTO ${schema}.audit_events SELECT * FROM ${schema}.audit_events WHERE workspace_key=$1`, [keyFor(value)]), /BRIDGE_AUDIT_INTERNAL_ONLY/);
    assert.deepEqual(await counts(value), { revision: 1, audits: 1 });
  });

  it('detaches database values and rejects unsafe keys, schemas or executable JSON', async () => {
    const value = scope('detached'); const store = storeFor(pool); const initial = await ledger(value, [command(value, 0, 'detached')]);
    await store.compareAndSet(keyFor(value), null, initial); const read = (await store.read(keyFor(value)))!;
    (read.value as { scope: BridgeScope }).scope.actorId = 'mutated-output'; assert.deepEqual((await bridgeFor(pool).snapshot(value)).scope, value);
    await assert.rejects(store.read('bridge-invalid'), code('BRIDGE_STORE_UNAVAILABLE')); await assert.rejects(store.compareAndSet(keyFor(value), 0, initial), code('BRIDGE_STORE_UNAVAILABLE'));
    assert.throws(() => new PostgresCanonicalBridgeStore(pool, { sources: SOURCES, schema: 'office_demo;DROP SCHEMA office_demo' }), code('BRIDGE_STORE_UNAVAILABLE'));
    let accesses = 0; const dangerous = {};
    Object.defineProperty(dangerous, 'scope', { enumerable: true, get() { accesses++; throw new Error('SYNTHETIC_PRIVATE_GETTER'); } });
    await assert.rejects(store.compareAndSet(keyFor(scope('unsafe')), null, dangerous), code('BRIDGE_STATE_INVALID')); assert.equal(accesses, 0);
  });

  it('fails closed when migrations are absent and sanitizes PostgreSQL failures', async () => {
    const uninitialized = new PostgresCanonicalBridgeStore(pool, { sources: SOURCES, schema: emptySchema });
    await assert.rejects(uninitialized.read(keyFor(scope('absent'))), code('BRIDGE_STORE_UNAVAILABLE'));
    await assert.rejects(uninitialized.compareAndSet(keyFor(scope('absent')), null, await ledger(scope('absent'), [command(scope('absent'), 0, 'absent')])), code('BRIDGE_STORE_UNAVAILABLE'));
    assert.equal((await pool.query('SELECT to_regnamespace($1) AS name', [emptySchema])).rows[0].name, null);
  });

  it('reverses the empty migration and refuses populated rollback without data loss', async () => {
    await pool.query(ddl(up, emptySchema)); await pool.query(ddl(down, emptySchema));
    const removed = await pool.query('SELECT to_regnamespace($1) AS name', [emptySchema]); assert.equal(removed.rows[0].name, null);
    const before = await pool.query(`SELECT count(*)::int AS count FROM ${schema}.audit_events`);
    await assert.rejects(pool.query(ddl(down)), /BRIDGE_ROLLBACK_REQUIRES_EMPTY_HISTORY/);
    const after = await pool.query(`SELECT count(*)::int AS count FROM ${schema}.audit_events`); assert.deepEqual(after.rows, before.rows);
  });
});
