import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createDurableTestQuoteApi } from '../../src/office/backend/event-quote-durable';
import { EVENT_QUOTE_API as API, EVENT_QUOTE_CSRF_HEADER as CSRF } from '../../src/office/backend/event-quote-http';
import type { CatalogSnapshot, QuoteScope } from '../../src/office/backend/event-quote-contracts';
import { PostgresEventQuoteStore } from '../../src/office/backend/event-quote-postgres';
import { MondayVault } from '../../src/office/backend/monday-store';
import { DEFAULT_OFFICE_DATABASE_URL } from '../../src/office/backend/postgres-store';
import { PostgresQuoteAccessRepository, type ExistingQuoteSession } from '../../src/office/backend/quote-access-postgres';
import { bindDashboardQuoteClient, createDashboardQuoteAccessSource, DashboardQuoteAccessGate,
  validateDashboardQuoteAccess, type DashboardQuoteGrant } from '../../src/office/dashboard/quote-access';
import { EventQuoteClientError, type EventQuoteClient, type EventQuoteStatusResponse } from '../../src/office/event-quote-client';
import { TEST_AT, testActor, testBrief, testScope, testService } from './event-quote-fixtures';

const ACCESS = `${API}/dashboard/access`;
const EVENT = 'dashboard-event';
const ORIGIN = 'https://dashboard-quote.test';
const headers = { host: 'dashboard-quote.test', origin: ORIGIN };
const AT = Date.parse('2026-10-14T01:00:00Z');
const scope: QuoteScope = { organizationId: 'dashboard-org', workspaceId: 'dashboard-workspace', mode: 'test' };
const proof: ExistingQuoteSession = { sessionToken: 'dashboard_synthetic_session_1234', csrfToken: 'dashboard_synthetic_csrf_1234' };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const signal = () => new AbortController().signal;
const clientError = (code: string) => (error: unknown) => error instanceof EventQuoteClientError && error.code === code;
const syntheticCatalog = (): CatalogSnapshot => ({ id: 'dashboard-catalog', version: 'v1', authority: 'test_only',
  approvalRef: 'synthetic-test-only', source: 'synthetic-dashboard-test', currency: 'USD', validUntilMs: AT + 3_600_000,
  taxBps: 0, depositBps: 5000, terms: 'Synthetic fixture only.',
  items: [{ id: 'meal', label: 'Synthetic meal', unit: 'person', unitPriceCents: 1000 }] });

// All writes are confined to fresh, synthetic loopback schemas. These tests do
// not start PostgreSQL, provision accounts, migrate a deployed schema or listen.
describe('durable Dashboard PostgreSQL projection', { concurrency: false }, () => {
  const accessSchema = `quote_access_test_${randomUUID().replaceAll('-', '')}`;
  const quoteSchema = `quote_test_${randomUUID().replaceAll('-', '')}`;
  const pool = new Pool({ connectionString: DEFAULT_OFFICE_DATABASE_URL, connectionTimeoutMillis: 1000 });
  const vault = new MondayVault(Buffer.alloc(32, 79));
  let now = AT;
  let currentProof: ExistingQuoteSession | null = proof;
  let catalog: CatalogSnapshot | null = syntheticCatalog();
  let requestedScopes: QuoteScope[] = [];
  const make = (overrides: Partial<Parameters<typeof createDurableTestQuoteApi>[0]> = {}) => createDurableTestQuoteApi({
    pool, vault, accessSchema, quoteSchema, allowedOrigin: ORIGIN, dashboardEventId: EVENT, clock: () => now,
    resolveExistingSession: async () => currentProof,
    catalogFor: async owner => { requestedScopes.push(structuredClone(owner)); return catalog; }, ...overrides,
  });
  const project = (app: ReturnType<typeof make>) => app.inject({ method: 'GET', url: ACCESS, headers });
  const ready = async (app: ReturnType<typeof make>): Promise<DashboardQuoteGrant> => {
    const response = await project(app);
    assert.equal(response.statusCode, 200, response.body);
    const value = response.json<DashboardQuoteGrant>();
    assert.equal(value.state, 'ready');
    assert.equal(validateDashboardQuoteAccess(value, now).state, 'ready');
    return value;
  };
  const create = async (app: ReturnType<typeof make>) => app.inject({ method: 'POST', url: `${API}/${EVENT}/commands`,
    headers: { ...headers, [CSRF]: proof.csrfToken, 'x-event-quote-access-revision': (await ready(app)).serverRevision! },
    payload: { action: 'create', key: 'dashboard-synthetic-create', expectedRevision: 0, brief: testBrief } });

  before(async () => {
    await new PostgresQuoteAccessRepository(pool, { schema: accessSchema, clock: () => now }).initializeTestSchema();
  });
  beforeEach(async () => {
    now = AT; currentProof = proof; catalog = syntheticCatalog(); requestedScopes = [];
    // Quote history intentionally refuses TRUNCATE, even in test schemas.
    await pool.query(`DROP SCHEMA IF EXISTS ${quoteSchema} CASCADE`);
    await new PostgresEventQuoteStore(pool, { schema: quoteSchema, vault }).initialize();
    await pool.query(`TRUNCATE ${accessSchema}.event_grants,${accessSchema}.assignments,${accessSchema}.sessions,${accessSchema}.memberships,${accessSchema}.users`);
    await pool.query(`INSERT INTO ${accessSchema}.users VALUES ('dashboard-org','dashboard-workspace','test','dashboard-actor','MANAGER',true,1)`);
    await pool.query(`INSERT INTO ${accessSchema}.memberships VALUES ('dashboard-membership','dashboard-org','dashboard-workspace','test','dashboard-actor',1,$1,NULL)`, [new Date(AT - 1000)]);
    await pool.query(`INSERT INTO ${accessSchema}.sessions VALUES ($1,$2,'dashboard-org','dashboard-workspace','test','dashboard-actor','dashboard-membership',1,1,$3,NULL)`,
      [hash(proof.sessionToken), hash(proof.csrfToken), new Date(AT + 60_000)]);
    await pool.query(`INSERT INTO ${accessSchema}.assignments VALUES ('dashboard-org','dashboard-workspace','test','${EVENT}','dashboard-actor',1,true)`);
    await pool.query(`INSERT INTO ${accessSchema}.event_grants VALUES ('dashboard-org','dashboard-workspace','test','${EVENT}','dashboard-actor',1,true,true,true,$1,NULL)`, [new Date(AT - 1000)]);
  });
  after(async () => {
    try { await pool.query(`DROP SCHEMA IF EXISTS ${accessSchema} CASCADE; DROP SCHEMA IF EXISTS ${quoteSchema} CASCADE`); }
    finally { await pool.end(); }
  });

  test('omitting the fixed event leaves the projection unregistered and never resolves its session', async () => {
    let resolutions = 0;
    const app = make({ dashboardEventId: undefined, resolveExistingSession: async () => { resolutions++; return proof; } });
    try {
      assert.equal((await project(app)).statusCode, 404);
      assert.equal(resolutions, 0);
      assert.deepEqual(requestedScopes, []);
    } finally { await app.close(); }
  });

  test('reserved or malformed dashboard event configuration fails before routes are constructed', () => {
    for (const dashboardEventId of ['status', 'constructor', 'prototype', '__proto__', '../other-event', '']) {
      assert.throws(() => make({ dashboardEventId }));
    }
  });

  test('projects one durable test event, SQL permissions, an opaque revision and no proof secrets', async () => {
    const app = make();
    try {
      const response = await project(app);
      assert.equal(response.statusCode, 200, response.body);
      const grant = response.json<DashboardQuoteGrant>();
      assert.equal(grant.durableIdentity, true);
      assert.deepEqual(grant.scope, scope);
      assert.deepEqual(grant.eventIds, [EVENT]);
      assert.deepEqual(grant.permissions, { canRead: true, canWrite: true, canApprove: true });
      assert.equal(grant.expiresAtMs, AT + 60_000);
      assert.equal(grant.catalog.authority, 'test_only');
      assert.equal(grant.catalog.ready, true);
      assert.match(grant.catalog.digest, /^[a-f0-9]{64}$/);
      assert.match(grant.serverRevision!, /^[A-Za-z0-9_-]{32,128}$/);
      assert.equal(grant.identityKey, grant.serverRevision);
      assert.equal((await ready(app)).serverRevision, grant.serverRevision, 'unchanged authority must not rotate per request');
      for (const secret of [proof.sessionToken, proof.csrfToken, hash(proof.sessionToken), hash(proof.csrfToken), 'dashboard-actor', 'dashboard-membership']) {
        assert.equal(response.body.includes(secret), false, `projection leaked ${secret}`);
      }
      assert.doesNotMatch(response.body, /sessionToken|csrfToken|token_hash|csrf_hash|session_version|membership_version|assignment_version/);
      assert.deepEqual(Object.keys(grant).sort(), ['catalog', 'durableIdentity', 'eventIds', 'expiresAtMs', 'identityKey', 'permissions', 'scope', 'serverRevision', 'state']);
      assert.deepEqual(requestedScopes, [scope, scope]);
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.equal(response.headers.pragma, 'no-cache');
      assert.equal(response.headers['x-content-type-options'], 'nosniff');
      assert.equal(response.headers['referrer-policy'], 'no-referrer');
      assert.equal(response.headers['set-cookie'], undefined);
      assert.equal(response.headers['access-control-allow-origin'], undefined);
    } finally { await app.close(); }
  });

  test('status, read and command JSON echo the same authorized event revision', async () => {
    const app = make();
    try {
      const grant = await ready(app);
      const status = await app.inject({ url: `${API}/status`, headers });
      assert.equal(status.statusCode, 200, status.body);
      assert.equal(status.json().session.accessRevision, grant.serverRevision);
      const written = await create(app);
      assert.equal(written.statusCode, 200, written.body);
      assert.equal(written.json().accessRevision, grant.serverRevision);
      const read = await app.inject({ url: `${API}/${EVENT}`, headers });
      assert.equal(read.statusCode, 200, read.body);
      assert.equal(read.json().accessRevision, grant.serverRevision);
      assert.equal(read.json().record.revision, 1);
    } finally { await app.close(); }
  });

  test('read-only SQL grant wins over a role that would make legacy status writable', async () => {
    await pool.query(`UPDATE ${accessSchema}.event_grants SET can_write=false,can_approve=false`);
    const app = make(), legacy = make({ dashboardEventId: undefined });
    try {
      const roleOnly = await legacy.inject({ url: `${API}/status`, headers });
      assert.equal(roleOnly.statusCode, 200, roleOnly.body);
      assert.equal(roleOnly.json().session.canWrite, true);
      const grant = await ready(app);
      assert.deepEqual(grant.permissions, { canRead: true, canWrite: false, canApprove: false });
      const status = await app.inject({ url: `${API}/status`, headers });
      assert.equal(status.statusCode, 200, status.body);
      assert.equal(status.json().reason, 'READ_ONLY');
      assert.equal(status.json().session.canWrite, false);
      assert.equal(status.json().session.canApprove, false);
      assert.equal(status.json().session.accessRevision, grant.serverRevision);
      assert.equal((await create(app)).statusCode, 403);
    } finally { await app.close(); await legacy.close(); }
  });

  test('role limits approval even when the event grant allows it', async () => {
    await pool.query(`UPDATE ${accessSchema}.users SET role='OPERATIONS'`);
    const app = make();
    try { assert.deepEqual((await ready(app)).permissions, { canRead: true, canWrite: true, canApprove: false }); }
    finally { await app.close(); }
  });

  const denials: Array<{ label: string; sql?: string; status: number; missingProof?: boolean }> = [
    { label: 'missing existing adapter proof', status: 401, missingProof: true },
    { label: 'no event grant despite an authorized role', sql: 'DELETE FROM $S.event_grants', status: 403 },
    { label: 'revoked session', sql: 'UPDATE $S.sessions SET revoked_at=now()', status: 401 },
    { label: 'disabled account', sql: 'UPDATE $S.users SET enabled=false', status: 401 },
    { label: 'session expiry', sql: `UPDATE $S.sessions SET expires_at=to_timestamp(${AT}/1000.0)`, status: 401 },
    { label: 'membership expiry', sql: `UPDATE $S.memberships SET effective_to=to_timestamp(${AT}/1000.0)`, status: 403 },
    { label: 'future membership', sql: `UPDATE $S.memberships SET effective_from=to_timestamp(${AT + 1}/1000.0)`, status: 403 },
    { label: 'grant expiry', sql: `UPDATE $S.event_grants SET effective_to=to_timestamp(${AT}/1000.0)`, status: 403 },
    { label: 'future grant', sql: `UPDATE $S.event_grants SET effective_from=to_timestamp(${AT + 1}/1000.0)`, status: 403 },
    { label: 'stale session version', sql: 'UPDATE $S.users SET session_version=2', status: 401 },
    { label: 'stale membership version', sql: 'UPDATE $S.memberships SET version=2', status: 401 },
    { label: 'stale assignment version', sql: 'UPDATE $S.assignments SET version=2', status: 403 },
    { label: 'revoked event grant', sql: 'UPDATE $S.event_grants SET enabled=false', status: 403 },
    { label: 'inactive assignment', sql: 'UPDATE $S.assignments SET active=false', status: 403 },
  ];
  for (const scenario of denials) test(`denies ${scenario.label} before catalog access`, async () => {
    if (scenario.missingProof) currentProof = null;
    if (scenario.sql) await pool.query(scenario.sql.replaceAll('$S', accessSchema));
    const app = make();
    try {
      const denied = await project(app);
      assert.equal(denied.statusCode, scenario.status, denied.body);
      assert.deepEqual(denied.json(), { error: scenario.status === 401 ? 'AUTHENTICATION_REQUIRED' : 'ACCESS_DENIED' });
      assert.equal(denied.headers['cache-control'], 'no-store');
      assert.equal(denied.body.includes('identityKey'), false);
      assert.deepEqual(requestedScopes, []);
      assert.equal((await app.inject({ url: `${API}/status`, headers })).statusCode, scenario.status);
    } finally { await app.close(); }
  });

  test('a successful grant is withdrawn on the next request after revocation', async () => {
    const app = make();
    try {
      await ready(app);
      await pool.query(`UPDATE ${accessSchema}.event_grants SET enabled=false`);
      assert.equal((await project(app)).statusCode, 403);
      assert.equal((await app.inject({ url: `${API}/${EVENT}`, headers })).statusCode, 403);
    } finally { await app.close(); }
  });

  test('valid session, membership, assignment and permission changes rotate the opaque revision', async () => {
    const app = make();
    try {
      let previous = (await ready(app)).serverRevision;
      const revisions = new Set([previous]);
      for (const sql of [
        `UPDATE ${accessSchema}.users SET session_version=2; UPDATE ${accessSchema}.sessions SET session_version=2`,
        `UPDATE ${accessSchema}.memberships SET version=2; UPDATE ${accessSchema}.sessions SET membership_version=2`,
        `INSERT INTO ${accessSchema}.memberships SELECT 'replacement-membership',organization_id,workspace_id,mode,actor_id,version,effective_from,effective_to FROM ${accessSchema}.memberships;
          UPDATE ${accessSchema}.sessions SET membership_id='replacement-membership'`,
        `UPDATE ${accessSchema}.assignments SET version=2; UPDATE ${accessSchema}.event_grants SET assignment_version=2`,
        `UPDATE ${accessSchema}.event_grants SET can_approve=false`,
        `UPDATE ${accessSchema}.event_grants SET can_write=false`,
        `UPDATE ${accessSchema}.event_grants SET effective_to=to_timestamp(${AT + 30_000}/1000.0)`,
        `UPDATE ${accessSchema}.memberships SET effective_to=to_timestamp(${AT + 40_000}/1000.0)`,
        `UPDATE ${accessSchema}.users SET role='OPERATIONS'`,
      ]) {
        await pool.query(sql);
        const next = await ready(app);
        assert.notEqual(next.serverRevision, previous, sql);
        assert.equal(revisions.has(next.serverRevision), false, 'each distinct authority state gets a fresh revision');
        const status = await app.inject({ url: `${API}/status`, headers });
        assert.equal(status.json().session.accessRevision, next.serverRevision);
        revisions.add(next.serverRevision); previous = next.serverRevision;
      }
    } finally { await app.close(); }
  });

  test('rotated adapter proof is resolved from the supplied token and never reconstructed from SQL hashes', async () => {
    const app = make();
    try {
      assert.equal((await create(app)).statusCode, 200);
      const old = await ready(app);
      const nextProof = { ...proof, sessionToken: 'dashboard_rotated_synthetic_session_1234' };
      await pool.query(`UPDATE ${accessSchema}.sessions SET token_hash=$1`, [hash(nextProof.sessionToken)]);
      assert.equal((await project(app)).statusCode, 401, 'the old proof must not authorize the rotated SQL row');
      currentProof = nextProof;
      const fresh = await ready(app);
      assert.notEqual(fresh.serverRevision, old.serverRevision);
      assert.deepEqual(fresh.permissions, old.permissions);
      const records = (await pool.query(`SELECT * FROM ${quoteSchema}.events`)).rows;
      const audit = (await pool.query(`SELECT * FROM ${quoteSchema}.audit_events`)).rows;
      const payload = { action: 'brief', key: 'token-rotated-brief', expectedRevision: 1, brief: { ...testBrief, attendees: 25 } };
      const rejected = await app.inject({ method: 'POST', url: `${API}/${EVENT}/commands`,
        headers: { ...headers, [CSRF]: proof.csrfToken, 'x-event-quote-access-revision': old.serverRevision! }, payload });
      assert.equal(rejected.statusCode, 403, rejected.body);
      assert.deepEqual((await pool.query(`SELECT * FROM ${quoteSchema}.events`)).rows, records);
      assert.deepEqual((await pool.query(`SELECT * FROM ${quoteSchema}.audit_events`)).rows, audit);
      const written = await app.inject({ method: 'POST', url: `${API}/${EVENT}/commands`,
        headers: { ...headers, [CSRF]: proof.csrfToken, 'x-event-quote-access-revision': fresh.serverRevision! }, payload });
      assert.equal(written.statusCode, 200, written.body);
      assert.equal(written.json().record.revision, 2);
      const raw = JSON.stringify(fresh);
      assert.equal(raw.includes(nextProof.sessionToken), false);
      assert.equal(raw.includes(hash(nextProof.sessionToken)), false);
    } finally { await app.close(); }
  });

  test('one authorized event revision cannot read or mutate a second authorized event', async () => {
    const other = 'dashboard-event-other';
    await pool.query(`INSERT INTO ${accessSchema}.assignments VALUES ('dashboard-org','dashboard-workspace','test',$1,'dashboard-actor',1,true)`, [other]);
    await pool.query(`INSERT INTO ${accessSchema}.event_grants VALUES ('dashboard-org','dashboard-workspace','test',$1,'dashboard-actor',1,true,true,true,$2,NULL)`, [other, new Date(AT - 1000)]);
    const app = make(), legacy = make({ dashboardEventId: undefined });
    try {
      const created = await legacy.inject({ method: 'POST', url: `${API}/${other}/commands`, headers: { ...headers, [CSRF]: proof.csrfToken },
        payload: { action: 'create', key: 'other-event-create', expectedRevision: 0, brief: testBrief } });
      assert.equal(created.statusCode, 200, created.body);
      const grant = await ready(app);
      assert.deepEqual(grant.eventIds, [EVENT]);
      const otherRead = await app.inject({ url: `${API}/${other}`, headers });
      assert.equal(otherRead.statusCode, 200, otherRead.body);
      const otherRevision = otherRead.json().accessRevision;
      assert.notEqual(otherRevision, grant.serverRevision);
      const wrongHeaders = { ...headers, [CSRF]: proof.csrfToken, 'x-event-quote-access-revision': grant.serverRevision! };
      const records = (await pool.query(`SELECT * FROM ${quoteSchema}.events`)).rows;
      const audit = (await pool.query(`SELECT * FROM ${quoteSchema}.audit_events`)).rows;
      assert.equal((await app.inject({ url: `${API}/${other}`, headers: wrongHeaders })).statusCode, 403);
      const payload = { action: 'brief', key: 'other-event-brief', expectedRevision: 1, brief: { ...testBrief, attendees: 25 } };
      const rejected = await app.inject({ method: 'POST', url: `${API}/${other}/commands`, headers: wrongHeaders, payload });
      assert.equal(rejected.statusCode, 403, rejected.body);
      assert.deepEqual((await pool.query(`SELECT * FROM ${quoteSchema}.events`)).rows, records);
      assert.deepEqual((await pool.query(`SELECT * FROM ${quoteSchema}.audit_events`)).rows, audit);
      const allowed = await app.inject({ method: 'POST', url: `${API}/${other}/commands`,
        headers: { ...wrongHeaders, 'x-event-quote-access-revision': otherRevision }, payload });
      assert.equal(allowed.statusCode, 200, allowed.body);
    } finally { await app.close(); await legacy.close(); }
  });

  test('stale presentation revision rejects writes before touching quote records or immutable audit', async () => {
    const app = make();
    try {
      assert.equal((await create(app)).statusCode, 200);
      let grant = await ready(app), recordRevision = 1;
      const snapshot = async () => ({
        records: (await pool.query(`SELECT * FROM ${quoteSchema}.events ORDER BY key`)).rows,
        audit: (await pool.query(`SELECT * FROM ${quoteSchema}.audit_events ORDER BY event_key,revision`)).rows,
      });
      for (const [index, sql] of [
        `UPDATE ${accessSchema}.users SET session_version=2; UPDATE ${accessSchema}.sessions SET session_version=2`,
        `UPDATE ${accessSchema}.event_grants SET can_approve=false`,
      ].entries()) {
        await pool.query(sql);
        const unchanged = await snapshot();
        const oldHeaders = { ...headers, [CSRF]: proof.csrfToken, 'x-event-quote-access-revision': grant.serverRevision! };
        const payload = { action: 'brief', key: `dashboard-revision-write-${index}`, expectedRevision: recordRevision,
          brief: { ...testBrief, attendees: testBrief.attendees + index + 1 } };
        const rejected = await app.inject({ method: 'POST', url: `${API}/${EVENT}/commands`, headers: oldHeaders, payload });
        assert.equal(rejected.statusCode, 403, rejected.body);
        assert.deepEqual(rejected.json(), { error: 'ACCESS_DENIED' });
        assert.deepEqual(await snapshot(), unchanged, 'an obsolete presentation must not write before its response is discarded');
        for (const url of [`${API}/status`, `${API}/${EVENT}`]) {
          assert.equal((await app.inject({ url, headers: oldHeaders })).statusCode, 403);
        }
        const refreshed = await ready(app);
        assert.notEqual(refreshed.serverRevision, grant.serverRevision);
        const written = await app.inject({ method: 'POST', url: `${API}/${EVENT}/commands`,
          headers: { ...oldHeaders, 'x-event-quote-access-revision': refreshed.serverRevision! }, payload });
        assert.equal(written.statusCode, 200, written.body);
        assert.equal(written.json().record.revision, ++recordRevision);
        assert.equal(written.json().accessRevision, refreshed.serverRevision);
        grant = refreshed;
      }
    } finally { await app.close(); }
  });

  test('Dashboard writes require a nonempty revision before creating any quote or audit row', async () => {
    const app = make();
    try {
      for (const value of [undefined, '']) {
        const denied = await app.inject({ method: 'POST', url: `${API}/${EVENT}/commands`,
          headers: { ...headers, [CSRF]: proof.csrfToken, ...(value === undefined ? {} : { 'x-event-quote-access-revision': value }) },
          payload: { action: 'create', key: 'missing-revision-create', expectedRevision: 0, brief: testBrief } });
        assert.equal(denied.statusCode, 403, denied.body);
        assert.equal((await pool.query(`SELECT * FROM ${quoteSchema}.events`)).rowCount, 0);
        assert.equal((await pool.query(`SELECT * FROM ${quoteSchema}.audit_events`)).rowCount, 0);
      }
      assert.equal((await create(app)).statusCode, 200);
    } finally { await app.close(); }
  });

  test('restart preserves durable access and quote data while invalidating the old presentation revision', async () => {
    let app = make();
    const freshPool = new Pool({ connectionString: DEFAULT_OFFICE_DATABASE_URL, connectionTimeoutMillis: 1000 });
    try {
      const first = await ready(app);
      const created = await create(app);
      assert.equal(created.statusCode, 200, created.body);
      await app.close(); app = make({ pool: freshPool });
      const restored = await ready(app);
      assert.deepEqual(restored.scope, first.scope);
      assert.deepEqual(restored.eventIds, first.eventIds);
      assert.deepEqual(restored.permissions, first.permissions);
      assert.notEqual(restored.serverRevision, first.serverRevision);
      const read = await app.inject({ url: `${API}/${EVENT}`, headers });
      assert.equal(read.statusCode, 200, read.body);
      assert.equal(read.json().record.revision, 1);
      assert.equal(read.json().accessRevision, restored.serverRevision);
      await pool.query(`UPDATE ${accessSchema}.sessions SET revoked_at=now()`);
      assert.equal((await project(app)).statusCode, 401);
    } finally { await app.close(); await freshPool.end(); }
  });

  test('minimum lifetime includes session, membership, event grant, catalog and presentation cap', async () => {
    const app = make();
    try {
      await pool.query(`UPDATE ${accessSchema}.sessions SET expires_at=$1`, [new Date(AT + 7_200_000)]);
      assert.equal((await ready(app)).expiresAtMs, AT + 15 * 60_000);
      catalog!.validUntilMs = AT + 50_000;
      assert.equal((await ready(app)).expiresAtMs, AT + 50_000);
      await pool.query(`UPDATE ${accessSchema}.memberships SET effective_to=$1`, [new Date(AT + 40_000)]);
      assert.equal((await ready(app)).expiresAtMs, AT + 40_000);
      await pool.query(`UPDATE ${accessSchema}.event_grants SET effective_to=$1`, [new Date(AT + 30_000)]);
      assert.equal((await ready(app)).expiresAtMs, AT + 30_000);
      await pool.query(`UPDATE ${accessSchema}.sessions SET expires_at=$1`, [new Date(AT + 20_000)]);
      assert.equal((await ready(app)).expiresAtMs, AT + 20_000);
    } finally { await app.close(); }
  });

  test('fixed event and server workspace cannot be selected through URL, headers or another workspace grant', async () => {
    const app = make();
    try {
      const spoofed = await app.inject({ url: ACCESS, headers: { ...headers, 'x-event-id': 'other-event', 'x-workspace-id': 'other-workspace', 'x-organization-id': 'other-org', 'x-mode': 'commercial' } });
      assert.equal(spoofed.statusCode, 200, spoofed.body);
      assert.deepEqual(spoofed.json().eventIds, [EVENT]);
      assert.deepEqual(spoofed.json().scope, scope);
      for (const selector of ['eventId=other-event', 'workspaceId=other-workspace', 'organizationId=other-org', 'mode=commercial']) {
        assert.equal((await app.inject({ url: `${ACCESS}?${selector}`, headers })).statusCode, 400);
      }
      assert.equal((await app.inject({ url: `${API}/other-event`, headers })).statusCode, 403);
      assert(requestedScopes.every(owner => JSON.stringify(owner) === JSON.stringify(scope)));
      await pool.query(`DELETE FROM ${accessSchema}.event_grants;
        INSERT INTO ${accessSchema}.users VALUES ('dashboard-org','other-workspace','test','dashboard-actor','MANAGER',true,1);
        INSERT INTO ${accessSchema}.assignments VALUES ('dashboard-org','other-workspace','test','${EVENT}','dashboard-actor',1,true)`);
      await pool.query(`INSERT INTO ${accessSchema}.event_grants VALUES ('dashboard-org','other-workspace','test','${EVENT}','dashboard-actor',1,true,true,true,$1,NULL)`, [new Date(AT - 1000)]);
      assert.equal((await project(app)).statusCode, 403);
    } finally { await app.close(); }
  });

  test('catalog lookup receives the authenticated workspace and requires a valid test-only catalog', async () => {
    const app = make({ catalogFor: async owner => {
      requestedScopes.push(structuredClone(owner));
      return owner.workspaceId === 'other-workspace' ? syntheticCatalog() : catalog;
    } });
    try {
      for (const value of [null, { ...syntheticCatalog(), authority: 'owner_authorized' as const }, { ...syntheticCatalog(), validUntilMs: AT }]) {
        catalog = value;
        const response = await project(app);
        assert.equal(response.statusCode, 503, response.body);
        assert.deepEqual(response.json(), { error: 'SERVICE_UNAVAILABLE' });
      }
      assert.deepEqual(requestedScopes, [scope, scope, scope]);
    } finally { await app.close(); }
  });

  test('origin and fetch guards reject before resolving proof or exposing cacheable access', async () => {
    let resolutions = 0;
    const app = make({ resolveExistingSession: async () => { resolutions++; return proof; } });
    try {
      for (const invalid of [{ ...headers, host: 'other.test' }, { ...headers, origin: 'https://other.test' }, { ...headers, 'sec-fetch-site': 'cross-site' }]) {
        const response = await app.inject({ url: ACCESS, headers: invalid });
        assert.equal(response.statusCode, 403, response.body);
        assert.equal(response.headers['cache-control'], 'no-store');
        assert.deepEqual(response.json(), { error: 'ACCESS_DENIED' });
      }
      assert.equal(resolutions, 0);
      const sameOriginNavigation = await app.inject({ url: ACCESS, headers: { host: headers.host, 'sec-fetch-site': 'same-origin' } });
      assert.equal(sameOriginNavigation.statusCode, 200, sameOriginNavigation.body);
    } finally { await app.close(); }
  });

  for (const authority of ['session', 'membership', 'grant', 'catalog'] as const) test(`expiry of ${authority} during awaited catalog lookup never returns a grant`, async () => {
    const end = AT + 1000;
    if (authority === 'session') await pool.query(`UPDATE ${accessSchema}.sessions SET expires_at=$1`, [new Date(end)]);
    if (authority === 'membership') await pool.query(`UPDATE ${accessSchema}.memberships SET effective_to=$1`, [new Date(end)]);
    if (authority === 'grant') await pool.query(`UPDATE ${accessSchema}.event_grants SET effective_to=$1`, [new Date(end)]);
    if (authority === 'catalog') catalog!.validUntilMs = end;
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const app = make({ catalogFor: async () => { enter(); await held; return catalog; } });
    const request = project(app);
    try {
      await entered; now = end; release();
      const response = await request;
      assert([401, 403, 503].includes(response.statusCode), response.body);
      assert.equal(response.body.includes('identityKey'), false);
      assert.equal(response.headers['cache-control'], 'no-store');
    } finally { release(); await request; await app.close(); }
  });
});

const transportGrant = (): DashboardQuoteGrant => ({ state: 'ready', identityKey: 'opaque-dashboard-revision-v1', serverRevision: 'opaque-dashboard-revision-v1',
  durableIdentity: true, scope: { ...testScope }, expiresAtMs: TEST_AT + 60_000, eventIds: [EVENT],
  permissions: { canRead: true, canWrite: true, canApprove: true },
  catalog: { ready: true, digest: 'a'.repeat(64), validUntilMs: TEST_AT + 3_600_000, authority: 'test_only' } });
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const subscription = () => () => {};

describe('Dashboard transport without PostgreSQL', () => {
  test('uses only a fixed same-origin no-store GET and an abortable request', async () => {
    let calls = 0;
    let observedSignal: AbortSignal | undefined;
    const source = createDashboardQuoteAccessSource({ subscribe: subscription, clock: () => TEST_AT, fetch: async (url, init) => {
      calls++;
      assert.equal(url, ACCESS);
      assert.equal(init?.method, 'GET');
      assert.equal(init?.credentials, 'same-origin');
      assert.equal(init?.cache, 'no-store');
      assert.equal(init?.redirect, 'error');
      assert.deepEqual(init?.headers, { Accept: 'application/json' });
      assert.equal(init?.body, undefined);
      observedSignal = init?.signal ?? undefined;
      return response(transportGrant());
    } });
    const controller = new AbortController();
    assert.equal((await source.read(controller.signal)).state, 'ready');
    assert.equal(calls, 1);
    assert.equal(observedSignal?.aborted, false);
    controller.abort();
    assert.equal(observedSignal?.aborted, true);
    await assert.rejects(source.read(controller.signal), clientError('REQUEST_CANCELLED'));
    assert.equal(calls, 1, 'pre-aborted reads must not start the transport');
  });

  test('delegates synchronous withdrawal subscription and cleanup to the existing host', () => {
    let listener: (() => void) | undefined;
    let withdrawals = 0, cleaned = 0;
    const source = createDashboardQuoteAccessSource({ subscribe: callback => { listener = callback; return () => { listener = undefined; cleaned++; }; } });
    const unsubscribe = source.subscribe(() => { withdrawals++; });
    listener!();
    assert.equal(withdrawals, 1);
    unsubscribe();
    assert.equal(cleaned, 1);
    assert.equal(listener, undefined);
  });

  test('requires durable test-only access to exactly one event and a matching server revision', async () => {
    const grant = transportGrant();
    const invalid = [
      { ...grant, serverRevision: undefined }, { ...grant, serverRevision: 'different-revision' }, { ...grant, serverRevision: '' },
      { ...grant, durableIdentity: false }, { ...grant, eventIds: [] }, { ...grant, eventIds: [EVENT, 'other-event'] },
      { ...grant, scope: { ...grant.scope, mode: 'commercial' }, catalog: { ...grant.catalog, authority: 'owner_authorized' } },
      { ...grant, catalog: { ...grant.catalog, authority: 'owner_authorized' } },
      { ...grant, expiresAtMs: TEST_AT }, { ...grant, catalog: { ...grant.catalog, validUntilMs: TEST_AT } },
    ];
    for (const value of invalid) {
      const source = createDashboardQuoteAccessSource({ subscribe: subscription, clock: () => TEST_AT, fetch: async () => response(value) });
      await assert.rejects(source.read(signal()), clientError('DASHBOARD_ACCESS_WITHDRAWN'));
    }
    for (const state of ['unconfigured', 'unavailable'] as const) {
      const source = createDashboardQuoteAccessSource({ subscribe: subscription, fetch: async () => response({ state }) });
      assert.deepEqual(await source.read(signal()), { state });
    }
  });

  test('denies unsuccessful, non-JSON, oversized and malformed responses', async () => {
    for (const status of [401, 403, 404, 503]) {
      const source = createDashboardQuoteAccessSource({ subscribe: subscription, fetch: async () => response({ error: 'synthetic' }, status) });
      await assert.rejects(source.read(signal()), error => error instanceof EventQuoteClientError && error.status === status);
    }
    for (const make of [
      () => new Response('<html>login</html>', { headers: { 'Content-Type': 'text/html' } }),
      () => new Response(JSON.stringify({ ...transportGrant(), ignored: 'x'.repeat(16_384) }), { headers: { 'Content-Type': 'application/json' } }),
      () => new Response('{', { headers: { 'Content-Type': 'application/json' } }),
    ]) {
      const source = createDashboardQuoteAccessSource({ subscribe: subscription, fetch: async () => make() });
      await assert.rejects(source.read(signal()));
    }
  });

  test('late fetch completion cannot restore access when its transport ignores abort', async () => {
    let release!: (response: Response) => void;
    const waiting = new Promise<Response>(resolve => { release = resolve; });
    const source = createDashboardQuoteAccessSource({ subscribe: subscription, clock: () => TEST_AT, fetch: async () => waiting });
    const controller = new AbortController();
    const pending = source.read(controller.signal);
    controller.abort(); release(response(transportGrant()));
    await assert.rejects(pending, clientError('REQUEST_CANCELLED'));
  });

  test('late body completion is discarded and expiry is checked after reading the body', async () => {
    for (const mode of ['abort', 'expire'] as const) {
      let release!: (body: string) => void, enter!: () => void;
      const body = new Promise<string>(resolve => { release = resolve; });
      const entered = new Promise<void>(resolve => { enter = resolve; });
      let now = TEST_AT;
      const delayed = response(null);
      delayed.text = async () => { enter(); return body; };
      const source = createDashboardQuoteAccessSource({ subscribe: subscription, clock: () => now, fetch: async () => delayed });
      const controller = new AbortController();
      const pending = source.read(controller.signal);
      await entered;
      if (mode === 'abort') controller.abort(); else now = TEST_AT + 60_000;
      release(JSON.stringify(transportGrant()));
      await assert.rejects(pending, clientError(mode === 'abort' ? 'REQUEST_CANCELLED' : 'DASHBOARD_ACCESS_WITHDRAWN'));
    }
  });

  test('copies every nested grant value, strips extra data and bounds presentation lifetime', () => {
    const input = { ...transportGrant(), scope: { ...testScope }, expiresAtMs: TEST_AT + 3_600_000, sessionToken: proof.sessionToken, csrfToken: proof.csrfToken };
    const copied = validateDashboardQuoteAccess(input, TEST_AT);
    assert.equal(copied.state, 'ready');
    if (copied.state !== 'ready') assert.fail('Expected ready copy');
    input.scope.workspaceId = 'other-workspace'; input.eventIds.push('other-event'); input.permissions.canRead = false;
    input.catalog.digest = 'b'.repeat(64); input.serverRevision = 'changed';
    assert.deepEqual(copied.scope, testScope);
    assert.deepEqual(copied.eventIds, [EVENT]);
    assert.equal(copied.permissions.canRead, true);
    assert.equal(copied.catalog.digest, 'a'.repeat(64));
    assert.equal(copied.serverRevision, 'opaque-dashboard-revision-v1');
    assert.equal(copied.expiresAtMs, TEST_AT + 15 * 60_000);
    assert.equal(Object.hasOwn(copied, 'sessionToken'), false);
    assert.equal(Object.hasOwn(copied, 'csrfToken'), false);
  });

  test('binding withdraws status, reads and commands with a missing or changed server revision', async () => {
    const t = testService();
    const initialView = await t.service.execute(testScope, testActor, EVENT, { action: 'create', key: 'dashboard-revision-create', expectedRevision: 0, brief: testBrief });
    const serviceStatus = await t.service.status(testScope, testActor);
    const grant = { ...transportGrant(), catalog: { ...transportGrant().catalog, digest: serviceStatus.catalogDigest!, validUntilMs: serviceStatus.catalog!.validUntilMs } };
    for (const revision of [undefined, 'opaque-new-server-revision']) {
      const status: EventQuoteStatusResponse = { ...serviceStatus, externalEffectsEnabled: false,
        session: { mode: 'test', canWrite: true, canApprove: true, csrfToken: proof.csrfToken, expiresAtMs: grant.expiresAtMs, accessRevision: revision } };
      const view = { ...initialView, accessRevision: revision };
      const client: EventQuoteClient = { async status() { return status; }, async read() { return view; }, async execute() { return view; } };
      for (const method of ['status', 'read', 'execute'] as const) {
        let withdrawn = 0;
        const bound = bindDashboardQuoteClient(client, grant, new DashboardQuoteAccessGate().start(), () => TEST_AT, () => { withdrawn++; });
        const pending = method === 'status' ? bound.status(signal()) : method === 'read' ? bound.read(EVENT, signal())
          : bound.execute(EVENT, { action: 'brief', key: 'dashboard-revision-edit', expectedRevision: 1, brief: testBrief }, proof.csrfToken, signal());
        await assert.rejects(pending, clientError('DASHBOARD_ACCESS_WITHDRAWN'));
        assert.equal(withdrawn, 1, `${method} must withdraw the old presentation`);
      }
    }
    const status: EventQuoteStatusResponse = { ...serviceStatus, externalEffectsEnabled: false,
      session: { mode: 'test', canWrite: true, canApprove: true, csrfToken: proof.csrfToken, expiresAtMs: grant.expiresAtMs, accessRevision: grant.serverRevision } };
    const view = { ...initialView, accessRevision: grant.serverRevision };
    const client: EventQuoteClient = { async status() { return status; }, async read() { return view; }, async execute() { return view; } };
    const bound = bindDashboardQuoteClient(client, grant, new DashboardQuoteAccessGate().start(), () => TEST_AT);
    assert.equal((await bound.status(signal())).session.accessRevision, grant.serverRevision);
    assert.equal(await bound.read(EVENT, signal()), view);
    assert.equal(await bound.execute(EVENT, { action: 'brief', key: 'dashboard-revision-edit', expectedRevision: 1, brief: testBrief }, proof.csrfToken, signal()), view);
  });

  test('binding forwards its verified server revision on status, read and execute before their operations', async () => {
    const t = testService();
    const initialView = await t.service.execute(testScope, testActor, EVENT, { action: 'create', key: 'dashboard-forward-create', expectedRevision: 0, brief: testBrief });
    const serviceStatus = await t.service.status(testScope, testActor);
    const grant = { ...transportGrant(), catalog: { ...transportGrant().catalog, digest: serviceStatus.catalogDigest!, validUntilMs: serviceStatus.catalog!.validUntilMs } };
    const status: EventQuoteStatusResponse = { ...serviceStatus, externalEffectsEnabled: false,
      session: { mode: 'test', canWrite: true, canApprove: true, csrfToken: proof.csrfToken, expiresAtMs: grant.expiresAtMs, accessRevision: grant.serverRevision } };
    const view = { ...initialView, accessRevision: grant.serverRevision };
    const calls: Array<[string, string | undefined]> = [];
    const client: EventQuoteClient = {
      async status(_signal, revision) { calls.push(['status', revision]); return status; },
      async read(_eventId, _signal, revision) { calls.push(['read', revision]); return view; },
      async execute(_eventId, _command, _csrf, _signal, revision) { calls.push(['execute', revision]); return view; },
    };
    const bound = bindDashboardQuoteClient(client, grant, new DashboardQuoteAccessGate().start(), () => TEST_AT);
    await bound.status(signal());
    await bound.read(EVENT, signal());
    await bound.execute(EVENT, { action: 'brief', key: 'dashboard-forward-edit', expectedRevision: 1, brief: testBrief }, proof.csrfToken, signal());
    assert.deepEqual(calls, [['status', grant.serverRevision], ['read', grant.serverRevision], ['execute', grant.serverRevision]]);
  });
});
