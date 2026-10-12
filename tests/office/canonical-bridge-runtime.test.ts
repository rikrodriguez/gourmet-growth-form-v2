import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { Pool } from 'pg';
import { createDemoBridgeProvenanceProvider } from '../../src/office/backend/canonical-bridge-runtime';
import { CanonicalBridge, CanonicalBridgeError } from '../../src/office/backend/canonical-bridge';
import { PostgresCanonicalBridgeStore } from '../../src/office/backend/canonical-bridge-postgres';
import { DEFAULT_OFFICE_DATABASE_URL } from '../../src/office/backend/postgres-store';
import { DevelopmentSessions } from '../../src/office/backend/session';
import type { DevelopmentSession } from '../../src/office/backend/session';
import { DEMO_ACTOR } from '../../src/office/backend/state';
import { createOfficeApi } from '../../src/office/backend/http';
import { createOfficeFixtureState } from '../../src/office/backend/fixtures';
import type { OfficeStore } from '../../src/office/backend/state';

const AT = Date.parse('2026-10-12T07:00:00.000Z');
const sources = [{ sourceSystem: 'fixture:office', partition: 'demo' }] as const;
const code = (expected: string) => (error: unknown) => error instanceof CanonicalBridgeError && error.code === expected && error.message === expected;
const session = (scope: object = {}) => new DevelopmentSessions(() => AT).create(scope).session;

describe('prepared PostgreSQL provenance runtime without migration activation', () => {
  it('constructs without DB access and rejects restricted or foreign DEMO capabilities before a read', async () => {
    let calls = 0;
    const pool = { async query() { calls++; throw new Error('SYNTHETIC_PRIVATE_DB_FAILURE'); } } as unknown as Pool;
    const provider = createDemoBridgeProvenanceProvider(pool, 'synthetic-runtime-office');
    assert.equal(calls, 0);
    for (const scoped of [session({ caseIds: ['demo-aurora'] }), session({ functionIds: ['sales'] }), { ...session(), actorId: 'foreign-actor' } as unknown as DevelopmentSession]) {
      await assert.rejects(provider.read(scoped), code('BRIDGE_FORBIDDEN_SCOPE'));
    }
    assert.equal(calls, 0);
  });

  it('surfaces missing storage with a safe error instead of initializing or falling back to memory', async () => {
    let calls = 0;
    const pool = { async query() { calls++; throw new Error('SYNTHETIC_PRIVATE_MISSING_SCHEMA'); } } as unknown as Pool;
    const provider = createDemoBridgeProvenanceProvider(pool, 'synthetic-runtime-missing-schema');
    await assert.rejects(provider.read(session()), code('BRIDGE_STORE_UNAVAILABLE'));
    assert.equal(calls, 1);
  });

  it('reads exact durable DEMO provenance through the caller-owned PostgreSQL pool without changing audit', async () => {
    const pool = new Pool({ connectionString: DEFAULT_OFFICE_DATABASE_URL, connectionTimeoutMillis: 1000, statement_timeout: 5000 });
    const schema = `bridge_test_${randomUUID().replaceAll('-', '')}`;
    const stateId = `synthetic-runtime-${randomUUID()}`;
    const scope = { organizationId: stateId, actorId: DEMO_ACTOR, partition: 'demo' as const };
    try {
      const up = await readFile(new URL('../../migrations/office/004_canonical_bridge.up.sql', import.meta.url), 'utf8');
      await pool.query(up.replaceAll('office_canonical_bridge', schema));
      const service = new CanonicalBridge(new PostgresCanonicalBridgeStore(pool, { schema, sources }), { sources, clock: () => AT });
      await service.execute(scope, { action: 'record_source', idempotencyKey: 'runtime-reference', expectedRevision: 0, kind: 'lead', reference: { sourceSystem: 'fixture:office', boardId: 'synthetic-lead-board', itemId: 'synthetic-lead-item' }, sourceVersion: 'synthetic-v1', contentDigest: 'a'.repeat(64), provenance: { evidenceRef: 'synthetic-origin-proof', observedAtMs: AT } });
      const before = await service.snapshot(scope);
      const beforeAudit = await pool.query(`SELECT count(*)::int AS count FROM ${schema}.audit_events`);
      const readOnlyPool = { query: (sql: string, values: unknown[]) => {
        assert.match(sql.trim(), /^SELECT /); return pool.query(sql, values);
      } } as unknown as Pool;
      const provider = createDemoBridgeProvenanceProvider(readOnlyPool, stateId, { schema });
      assert.deepEqual(await provider.read(session()), before);
      const reconstructed = createDemoBridgeProvenanceProvider(readOnlyPool, stateId, { schema });
      assert.deepEqual(await reconstructed.read(session()), before);
      assert.equal((await createDemoBridgeProvenanceProvider(readOnlyPool, 'synthetic-other-workspace', { schema }).read(session())).revision, 0);
      // The actual GET route consumes this durable provider. Only the existing
      // synthetic Office session is created; the provenance request is read-only.
      const office: OfficeStore = {
        async snapshot() { return createOfficeFixtureState(AT); },
        async transact() { throw new Error('UNEXPECTED_OFFICE_WRITE'); },
      };
      const api = createOfficeApi(office, { clock: () => AT, provenance: { demoBridge: provider } });
      try {
        const headers = { host: '127.0.0.1:4180', origin: 'http://127.0.0.1:4175' };
        const login = await api.inject({ method: 'POST', url: '/office-api/session', headers, payload: {} });
        assert.equal(login.statusCode, 200);
        const cookie = String(login.headers['set-cookie']).split(';')[0];
        const response = await api.inject({ url: '/office-api/provenance', headers: { ...headers, cookie } });
        assert.equal(response.statusCode, 200);
        const dto = response.json();
        assert.equal(dto.source, 'demo'); assert.equal(dto.bridge.storage, 'postgres');
        assert.equal(dto.bridge.state, 'available'); assert.equal(dto.bridge.revision, 1);
        assert.deepEqual(dto.bridge.sourceVersions, before.sourceVersions);
        assert.equal(dto.bridge.importsEnabled, false); assert.equal(dto.bridge.automaticLinking, false); assert.equal(dto.bridge.metricsConsumed, false);
      } finally { await api.close(); }
      assert.deepEqual((await pool.query(`SELECT count(*)::int AS count FROM ${schema}.audit_events`)).rows, beforeAudit.rows);
      assert.deepEqual(await service.snapshot(scope), before);
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await pool.end();
    }
  });
});
