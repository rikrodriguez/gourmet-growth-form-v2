import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import { createOfficeApi } from '../../src/office/backend/http';
import { createOfficeFixtureState } from '../../src/office/backend/fixtures';
import { CASE_IDS, FUNCTION_IDS, DEMO_ACTOR } from '../../src/office/backend/state';
import type { OfficeStore, OfficeState } from '../../src/office/backend/state';
import type { DevelopmentSession } from '../../src/office/backend/session';
import type { BridgeSnapshot } from '../../src/office/canonical-bridge-contracts';
import { MondayOwnerSessions, parseMondayOwnerConfiguration, MONDAY_OWNER_LOGIN_COOKIE, MONDAY_OWNER_CSRF_HEADER, MONDAY_OWNER_COOKIE } from '../../src/office/backend/monday-owner';
import { createMondayOAuthService, parseMondayConfiguration, MONDAY_AUTHORIZED_USER_ID, MONDAY_AUTHORIZED_USER_EMAIL, MONDAY_CONFIGURED_ACCOUNT_ID, MONDAY_OAUTH_ORIGIN, MONDAY_TOKEN_URL } from '../../src/office/backend/monday-oauth';
import type { MondayOAuthService, MondayOAuthStatus } from '../../src/office/backend/monday-oauth';
import { MONDAY_READ_BOARD_IDS, MONDAY_READ_SCOPES } from '../../src/office/backend/monday-read';
import type { MondayReadClient } from '../../src/office/backend/monday-read';
import { MemoryMondayStore, MondayVault } from '../../src/office/backend/monday-store';
import type { MondayRuntime } from '../../src/office/backend/monday-runtime';
import { parseOfficeStagingEnvironment } from '../../src/office/backend/staging';
import { validateDemoProvenance, validateMondayProvenance } from '../../src/office/provenance-contracts';

const AT = Date.parse('2026-10-12T07:00:00.000Z');
const HEADERS = { host: '127.0.0.1:4180', origin: 'http://127.0.0.1:4175' };
class ReadOnlyOfficeStore implements OfficeStore {
  state = createOfficeFixtureState(AT); writes = 0;
  async snapshot() { return structuredClone(this.state); }
  async transact<T>(_fn: (state: OfficeState) => T | Promise<T>): Promise<T> { this.writes++; throw new Error('unexpected-write'); }
}
function cookie(response: { headers: Record<string, unknown> }, name: string) {
  const values = response.headers['set-cookie'];
  const found = (Array.isArray(values) ? values : [values]).find(value => typeof value === 'string' && value.startsWith(`${name}=`));
  assert.equal(typeof found, 'string'); return (found as string).split(';')[0];
}
function emptyBridge(): BridgeSnapshot {
  return { schemaVersion: 1, scope: { organizationId: 'synthetic-org', actorId: DEMO_ACTOR, partition: 'demo' }, revision: 0, sourceVersions: [], bindings: [] };
}
function source(index: number) {
  return { id: `version-${index}`, entityId: `entity-${index}`, kind: 'lead' as const, reference: { sourceSystem: 'fixture:office', boardId: 'board-lead', itemId: `item-${index}` }, sourceVersion: 'v1', contentDigest: createHash('sha256').update(String(index)).digest('hex'), provenance: { evidenceRef: `fixture:evidence-${index}`, observedAtMs: AT - 1000 }, recordedAtMs: AT, recordedBy: DEMO_ACTOR };
}
async function fixture(t: TestContext, provider?: (session: DevelopmentSession) => Promise<BridgeSnapshot | null>) {
  const store = new ReadOnlyOfficeStore();
  const api = createOfficeApi(store, { clock: () => AT, ...(provider ? { provenance: { demoBridge: { read: provider } } } : {}) });
  await api.ready(); t.after(() => api.close());
  const login = async (scope: object = {}) => {
    const response = await api.inject({ method: 'POST', url: '/office-api/session', headers: HEADERS, payload: scope });
    assert.equal(response.statusCode, 200); return { ...HEADERS, cookie: cookie(response, 'gourmet_office_demo') };
  };
  return { api, store, login };
}

describe('read-only DEMO provenance', () => {
  it('requires a DEMO session before reading any store/provider', async t => {
    let reads = 0; const f = await fixture(t, async () => { reads++; return emptyBridge(); });
    const response = await f.api.inject({ url: '/office-api/provenance', headers: HEADERS });
    assert.equal(response.statusCode, 401); assert.deepEqual(response.json(), { error: 'UNAUTHORIZED' }); assert.equal(reads, 0);
  });
  it('defaults to explicitly unconfigured durable bridge without a memory fallback', async t => {
    const f = await fixture(t); const headers = await f.login();
    const response = await f.api.inject({ url: '/office-api/provenance', headers });
    assert.equal(response.statusCode, 200); const result = response.json();
    assert.equal(result.source, 'demo'); assert.equal(result.synthetic, true); assert.equal(result.bridge.state, 'unconfigured');
    assert.equal(result.bridge.storage, null); assert.equal(result.bridge.coverage, 'not_queried');
    assert.equal(result.bridge.importsEnabled, false); assert.equal(result.bridge.automaticLinking, false); assert.equal(result.bridge.metricsConsumed, false);
    assert.deepEqual(result.coverage, { caseIds: [...CASE_IDS], functionIds: [...FUNCTION_IDS] });
    assert(result.officeEvidence.every((row: { simulated: boolean; source: string }) => row.simulated && row.source.startsWith('fixture:')));
    assert.equal(f.store.writes, 0); assert.equal(response.headers['cache-control'], 'no-store');
  });
  it('rejects query selectors before reading the authorized bridge', async t => {
    let reads = 0; const f = await fixture(t, async () => { reads++; return emptyBridge(); }); const headers = await f.login();
    for (const query of ['organizationId=other', 'actorId=other', 'partition=external', 'caseIds=demo-cedar', 'fields=contact']) {
      const response = await f.api.inject({ url: `/office-api/provenance?${query}`, headers });
      assert.equal(response.statusCode, 400); assert.deepEqual(response.json(), { error: 'INVALID_PROVENANCE_REQUEST' });
    }
    assert.equal(reads, 0); assert.equal(f.store.writes, 0);
  });
  it('rejects a GET body before provider reads', async t => {
    let reads = 0; const f = await fixture(t, async () => { reads++; return emptyBridge(); });
    const response = await f.api.inject({ method: 'GET', url: '/office-api/provenance', headers: await f.login(), payload: { organizationId: 'other' } });
    assert.equal(response.statusCode, 400); assert.equal(reads, 0);
  });
  it('filters case evidence and skips global bridge reads for case/function restricted sessions', async t => {
    let reads = 0; const f = await fixture(t, async () => { reads++; return emptyBridge(); });
    for (const scope of [{ caseIds: ['demo-aurora'] }, { functionIds: ['proposals'] }, { caseIds: ['demo-cedar'], functionIds: ['sales'] }]) {
      const headers = await f.login(scope); const response = await f.api.inject({ url: '/office-api/provenance', headers });
      assert.equal(response.statusCode, 200); const result = response.json(); assert.equal(result.bridge.state, 'scope_restricted');
      assert.deepEqual(result.coverage.caseIds, scope.caseIds ?? [...CASE_IDS]); assert.deepEqual(result.coverage.functionIds, scope.functionIds ?? [...FUNCTION_IDS]);
      assert(result.officeEvidence.every((row: { caseId: string }) => result.coverage.caseIds.includes(row.caseId)));
    }
    assert.equal(reads, 0);
  });
  it('returns durable empty and available bridge projections from a trusted server provider', async t => {
    let current = emptyBridge(); const sessions: DevelopmentSession[] = [];
    const f = await fixture(t, async session => { sessions.push(session); return structuredClone(current); }); const headers = await f.login();
    let response = await f.api.inject({ url: '/office-api/provenance', headers }); assert.equal(response.statusCode, 200);
    assert.equal(response.json().bridge.state, 'empty'); assert.equal(response.json().bridge.storage, 'postgres');
    current = { ...current, revision: 1, sourceVersions: [source(1)] };
    response = await f.api.inject({ url: '/office-api/provenance', headers }); assert.equal(response.json().bridge.state, 'available');
    assert.deepEqual(response.json().bridge.sourceVersions, current.sourceVersions); assert(!response.body.includes('organizationId'));
    assert.equal(sessions[0].actorId, DEMO_ACTOR); assert.equal(f.store.writes, 0);
  });
  it('reports missing migration or provider faults without reflecting private errors', async t => {
    for (const read of [async () => null, async () => { throw new Error('relation private_bridge does not exist: synthetic-private'); }]) {
      const f = await fixture(t, read); const headers = await f.login(); const response = await f.api.inject({ url: '/office-api/provenance', headers });
      assert.equal(response.statusCode, 200); assert.equal(response.json().bridge.state, 'unavailable'); assert.equal(response.json().bridge.coverage, 'not_queried');
      assert(!response.body.includes('private_bridge')); assert(!response.body.includes('synthetic-private'));
    }
  });
  it('fails closed on wrong actor, external partition, external source or unexpected payload fields', async t => {
    for (const tamper of [
      (value: BridgeSnapshot) => { value.scope.actorId = 'other-actor'; },
      (value: BridgeSnapshot) => { value.scope.partition = 'external'; },
      (value: BridgeSnapshot) => { value.sourceVersions[0].reference.sourceSystem = 'monday'; },
      (value: BridgeSnapshot) => { (value.sourceVersions[0] as unknown as Record<string, unknown>).contact = 'synthetic@invalid.test'; },
      (value: BridgeSnapshot) => { value.sourceVersions[0].recordedBy = 'other-actor'; },
    ]) {
      const value = { ...emptyBridge(), revision: 1, sourceVersions: [source(1)] }; tamper(value);
      const f = await fixture(t, async () => value); const response = await f.api.inject({ url: '/office-api/provenance', headers: await f.login() });
      assert.equal(response.statusCode, 200); assert.equal(response.json().bridge.state, 'unavailable'); assert.deepEqual(response.json().bridge.sourceVersions, []);
      assert(!response.body.includes('synthetic@invalid.test')); assert(!response.body.includes('other-actor'));
    }
  });
  it('bounds both collections and labels truncated bridge coverage partial', async t => {
    const value = { ...emptyBridge(), revision: 51, sourceVersions: Array.from({ length: 51 }, (_, index) => source(index)) };
    const f = await fixture(t, async () => value); const response = await f.api.inject({ url: '/office-api/provenance', headers: await f.login() });
    assert.equal(response.statusCode, 200); assert.equal(response.json().bridge.sourceVersions.length, 50); assert.equal(response.json().bridge.coverage, 'partial');
  });
  it('bounds binding history without silently claiming complete coverage', async t => {
    const lead = source(1); const event = { ...source(2), kind: 'event' as const };
    const bindings = Array.from({ length: 51 }, (_, index) => ({ bindingId: 'binding-history', revision: index + 1, digest: createHash('sha256').update(`binding-${index}`).digest('hex'), previousDigest: index === 0 ? null : createHash('sha256').update(`binding-${index - 1}`).digest('hex'), action: 'bind' as const, refs: { lead: lead.id, event: event.id, quote: null, invoice: null }, targetRevision: null, evidenceRef: `fixture:binding-${index}`, recordedAtMs: AT, recordedBy: DEMO_ACTOR }));
    const value = { ...emptyBridge(), revision: 53, sourceVersions: [lead, event], bindings };
    const f = await fixture(t, async () => value); const response = await f.api.inject({ url: '/office-api/provenance', headers: await f.login() });
    assert.equal(response.statusCode, 200); assert.equal(response.json().bridge.bindings.length, 50); assert.equal(response.json().bridge.coverage, 'partial');
  });
  it('validates rows outside the response cap before emitting any bridge rows', async t => {
    const value = { ...emptyBridge(), revision: 51, sourceVersions: Array.from({ length: 51 }, (_, index) => source(index)) };
    (value.sourceVersions[50] as unknown as Record<string, unknown>).private = 'synthetic-private';
    const f = await fixture(t, async () => value); const response = await f.api.inject({ url: '/office-api/provenance', headers: await f.login() });
    assert.equal(response.statusCode, 200); assert.equal(response.json().bridge.state, 'unavailable'); assert.deepEqual(response.json().bridge.sourceVersions, []);
    assert(!response.body.includes('synthetic-private'));
  });
  it('exposes no mutation route', async t => {
    const f = await fixture(t); const headers = await f.login();
    for (const method of ['POST', 'PATCH', 'DELETE'] as const) {
      const response = await f.api.inject({ method, url: '/office-api/provenance', headers, ...(method !== 'DELETE' ? { payload: {} } : {}) }); assert.equal(response.statusCode, 404);
    }
    assert.equal(f.store.writes, 0);
  });
});

const OWNER_ENV = { MONDAY_OWNER_USERNAME: 'synthetic-owner', MONDAY_OWNER_PASSWORD: 'synthetic-owner-password-only-for-test' };
const OAUTH_ENV = { MONDAY_OAUTH_ENABLED: 'true', MONDAY_CLIENT_ID: 'synthetic-client', MONDAY_CLIENT_SECRET: 'synthetic-client-secret-only-for-test', MONDAY_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 61).toString('base64'), MONDAY_EXPECTED_USER_ID: MONDAY_AUTHORIZED_USER_ID, MONDAY_EXPECTED_ACCOUNT_EMAIL: MONDAY_AUTHORIZED_USER_EMAIL, MONDAY_EXPECTED_ACCOUNT_ID: MONDAY_CONFIGURED_ACCOUNT_ID };
async function mondayFixture(t: TestContext, staging = false, suppliedService?: MondayOAuthService) {
  const calls = { status: 0, readOnlyStatus: 0, other: 0 };
  const status: MondayOAuthStatus = { state: 'connected', code: null, actorId: 'synthetic-private-owner', accountId: null, accountVerified: false, configuredAccountId: 'synthetic-private-account', boardAccessVerified: true, boardAccessReadAt: new Date(AT - 1000).toISOString(), scopes: ['synthetic-private-scope'], expiresAt: new Date(AT + 3600_000).toISOString(), connectedAt: new Date(AT - 2000).toISOString(), identityReadAt: new Date(AT - 2000).toISOString(), lastReadAt: null, updatedAt: new Date(AT).toISOString(), pending: false, grantFingerprint: 'synthetic-private-fingerprint' };
  const service = { status: async () => { calls.status++; throw new Error('operational-status-must-not-run'); }, readOnlyStatus: async () => { calls.readOnlyStatus++; return structuredClone(status); }, readBoard: async () => { calls.other++; throw new Error('unexpected-provider-call'); }, readUpdates: async () => { calls.other++; throw new Error('unexpected-provider-call'); }, refresh: async () => { calls.other++; throw new Error('unexpected-provider-call'); }, disconnect: async () => { calls.other++; throw new Error('unexpected-provider-call'); }, startOAuth: async () => { calls.other++; throw new Error('unexpected-provider-call'); } } as unknown as MondayOAuthService;
  const runtime: MondayRuntime = { enabled: true, configured: true, ownerSessions: new MondayOwnerSessions(parseMondayOwnerConfiguration(OWNER_ENV), () => AT), oauthService: suppliedService ?? service };
  const access = staging ? parseOfficeStagingEnvironment({ OFFICE_RUNTIME_MODE: 'staging', OFFICE_STAGING_ORIGIN: 'https://office-staging.gourmet-corporation.com', OFFICE_STAGING_USERNAME: 'synthetic-basic', OFFICE_STAGING_PASSWORD: 'synthetic-basic-password-only-for-test', OFFICE_STAGING_TRUSTED_PROXY_CIDRS: '127.0.0.1/32', OFFICE_STAGING_DB_HOST: 'office-db', OFFICE_STAGING_DB_PORT: '5432', OFFICE_STAGING_DB_USER: 'office_stage', OFFICE_STAGING_DB_NAME: 'gourmet_office_stage_demo', OFFICE_STAGING_DB_PASSWORD: 'synthetic-db-password-only-for-test' }).access : undefined;
  const headers = access ? { host: access.host, origin: access.origin, 'x-forwarded-proto': 'https', authorization: `Basic ${Buffer.from('synthetic-basic:synthetic-basic-password-only-for-test').toString('base64')}` } : HEADERS;
  const store = new ReadOnlyOfficeStore(); const api = createOfficeApi(store, { clock: () => AT, monday: runtime, ...(access ? { staging: access } : {}) }); await api.ready(); t.after(() => api.close());
  const login = async () => {
    const challenge = await api.inject({ url: '/office-api/monday/owner/login', headers });
    const response = await api.inject({ method: 'POST', url: '/office-api/monday/owner/login', headers: { ...headers, cookie: cookie(challenge, MONDAY_OWNER_LOGIN_COOKIE), [MONDAY_OWNER_CSRF_HEADER]: challenge.json().csrfToken }, payload: { username: OWNER_ENV.MONDAY_OWNER_USERNAME, password: OWNER_ENV.MONDAY_OWNER_PASSWORD } });
    assert.equal(response.statusCode, 200); return { ...headers, cookie: cookie(response, MONDAY_OWNER_COOKIE) };
  };
  return { api, store, headers, calls, login, status };
}
describe('read-only Monday provenance', () => {
  it('does not persist expired lease cleanup when using the real OAuth service with a synthetic stored grant', async t => {
    const key = 'monday-connection-ricardo'; const clock = () => AT;
    class ObservedStore extends MemoryMondayStore {
      writes = 0;
      override async compareAndSet(key: string, revision: number | null, value: unknown | null) { this.writes++; return super.compareAndSet(key, revision, value); }
    }
    const privateStore = new ObservedStore(); const vault = new MondayVault(Buffer.alloc(32, 61));
    const configuration = parseMondayConfiguration(OAUTH_ENV, MONDAY_OAUTH_ORIGIN);
    let calls = 0;
    const accessToken = `${Buffer.from('{"alg":"synthetic-only"}').toString('base64url')}.${Buffer.from(JSON.stringify({ exp: AT / 1000 + 3600 })).toString('base64url')}.c3ludGhldGlj`;
    const fetcher: typeof fetch = async url => { calls++; assert.equal(String(url), MONDAY_TOKEN_URL); return new Response(JSON.stringify({ access_token: accessToken, refresh_token: 'synthetic-refresh-only-for-test', token_type: 'Bearer', scope: MONDAY_READ_SCOPES.join(' ') }), { headers: { 'Content-Type': 'application/json' } }); };
    const readClient: MondayReadClient = {
      async getIdentity() { calls++; return { id: MONDAY_AUTHORIZED_USER_ID, email: MONDAY_AUTHORIZED_USER_EMAIL, readAt: new Date(AT - 1000).toISOString() }; },
      async verifyBoardAccess() { calls++; return { boardIds: [...MONDAY_READ_BOARD_IDS], readAt: new Date(AT - 1000).toISOString() }; },
      async readBoard() { calls++; throw new Error('unexpected-read'); },
      async readUpdates() { calls++; throw new Error('unexpected-read'); },
    };
    const service = createMondayOAuthService({ configuration, store: privateStore, vault, readClient, fetch: fetcher, clock });
    const nonce = Buffer.alloc(32, 62).toString('base64url');
    const start = await service.startOAuth({ ownerId: 'ricardo', browserNonce: nonce });
    const state = new URL(start.authorizationUrl).searchParams.get('state'); assert.ok(state);
    await service.callback({ state, code: 'synthetic-code-only-for-test' }, nonce);
    const stored = await privateStore.read(key); assert.ok(stored);
    const baseRecord = vault.open(stored.value, key) as Record<string, unknown>;
    const f = await mondayFixture(t, false, service); const headers = await f.login();
    for (const [kind, code, expired] of [['read', 'read_unavailable', false], ['refresh', 'refresh_uncertain', false], ['revoke', 'revoke_uncertain', false], ['authorize', 'oauth_state_expired', false], ['exchange', 'code_exchange_uncertain', false], ['read', 'expired', true]] as const) {
      const current = await privateStore.read(key); assert.ok(current);
      const record = structuredClone(baseRecord);
      record.attempt = { id: Buffer.alloc(32, 63).toString('base64url'), kind, deadline: AT - 1 };
      record.updatedAt = new Date(AT - 5000).toISOString();
      if (expired) (record.tokens as Record<string, unknown>).expiresAt = new Date(AT - 1).toISOString();
      assert.equal(await privateStore.compareAndSet(key, current.revision, vault.seal(record, key)), true);
      const before = await privateStore.read(key); const writes = privateStore.writes; const providerCalls = calls;
      const response = await f.api.inject({ url: '/office-api/monday/provenance', headers });
      assert.equal(response.statusCode, 200); assert.equal(privateStore.writes, writes);
      assert.deepEqual(await privateStore.read(key), before); assert.equal(calls, providerCalls);
      assert.equal(response.json().connection.state, expired ? 'expired' : 'error'); assert.equal(response.json().connection.boardAccessVerified, false);
      assert(!response.body.includes('synthetic-refresh')); assert(!response.body.includes('attempt'));
      const again = await f.api.inject({ url: '/office-api/monday/provenance', headers }); assert.equal(again.statusCode, 200);
      assert.equal(privateStore.writes, writes); assert.deepEqual(await privateStore.read(key), before); assert.equal(calls, providerCalls);
      const status = await service.readOnlyStatus();
      assert.equal(status.code, code); assert.equal(status.pending, false); assert.equal(status.updatedAt, record.updatedAt); assert.equal(status.grantFingerprint, null);
      assert.equal(privateStore.writes, writes); assert.deepEqual(await privateStore.read(key), before); assert.equal(calls, providerCalls);
    }
  });
  it('does not initialize absent connection storage and avoids storage entirely when disabled', async () => {
    for (const enabled of [true, false]) {
      let reads = 0; let writes = 0; let providerCalls = 0;
      const unavailable = async (): Promise<never> => { providerCalls++; throw new Error('unexpected-provider'); };
      const service = createMondayOAuthService({
        configuration: parseMondayConfiguration({ ...OAUTH_ENV, MONDAY_OAUTH_ENABLED: String(enabled) }, MONDAY_OAUTH_ORIGIN),
        store: { async read() { reads++; return null; }, async compareAndSet() { writes++; throw new Error('unexpected-write'); } },
        vault: new MondayVault(Buffer.alloc(32, 61)), clock: () => AT, fetch: unavailable,
        readClient: { getIdentity: unavailable, verifyBoardAccess: unavailable, readBoard: unavailable, readUpdates: unavailable },
      });
      const status = await service.readOnlyStatus();
      assert.equal(status.state, enabled ? 'disconnected' : 'disabled'); assert.equal(status.pending, false); assert.equal(status.boardAccessVerified, false);
      assert.equal(reads, enabled ? 1 : 0); assert.equal(writes, 0); assert.equal(providerCalls, 0);
    }
  });
  it('does not authorize Monday through a DEMO session or HTTP Basic alone', async t => {
    for (const staging of [false, true]) {
      const f = await mondayFixture(t, staging); const session = await f.api.inject({ method: 'POST', url: '/office-api/session', headers: f.headers, payload: {} });
      for (const headers of [f.headers, { ...f.headers, cookie: cookie(session, 'gourmet_office_demo') }]) {
        const response = await f.api.inject({ url: '/office-api/monday/provenance', headers }); assert.equal(response.statusCode, 403); assert.deepEqual(response.json(), { error: 'MONDAY_OWNER_UNAUTHORIZED' });
      }
      assert.equal(f.calls.status, 0); assert.equal(f.calls.readOnlyStatus, 0); assert.equal(f.calls.other, 0);
    }
  });
  it('reads stored local connection status only and excludes identities, grants and secrets', async t => {
    const f = await mondayFixture(t); const response = await f.api.inject({ url: '/office-api/monday/provenance', headers: await f.login() });
    assert.equal(response.statusCode, 200); const result = response.json();
    assert.equal(result.source, 'monday'); assert.equal(result.synthetic, false); assert.equal(result.connection.state, 'connected');
    assert.equal(result.bridge.partition, 'external'); assert.equal(result.bridge.state, 'unconfigured'); assert.equal(result.bridge.coverage, 'not_queried');
    assert.equal(f.calls.status, 0); assert.equal(f.calls.readOnlyStatus, 1); assert.equal(f.calls.other, 0); assert.equal(f.store.writes, 0);
    assert(!response.body.includes('synthetic-private')); assert(!response.body.includes('account')); assert(!response.body.includes('scopes'));
  });
  it('does not authorize DEMO through a Monday owner cookie', async t => {
    const f = await mondayFixture(t); const response = await f.api.inject({ url: '/office-api/provenance', headers: await f.login() });
    assert.equal(response.statusCode, 401); assert.deepEqual(response.json(), { error: 'UNAUTHORIZED' });
    assert.equal(f.calls.status, 0); assert.equal(f.calls.readOnlyStatus, 0); assert.equal(f.calls.other, 0);
  });
  it('rejects GET bodies before stored Monday status reads', async t => {
    const f = await mondayFixture(t); const response = await f.api.inject({ method: 'GET', url: '/office-api/monday/provenance', headers: await f.login(), payload: { actorId: 'other' } });
    assert.equal(response.statusCode, 400); assert.equal(f.calls.status, 0); assert.equal(f.calls.readOnlyStatus, 0); assert.equal(f.calls.other, 0);
  });
  it('rejects Monday selectors before reading local status and exposes no mutation route', async t => {
    const f = await mondayFixture(t); const headers = await f.login();
    for (const query of ['organizationId=other', 'actorId=other', 'partition=demo', 'fields=access_token']) {
      const response = await f.api.inject({ url: `/office-api/monday/provenance?${query}`, headers }); assert.equal(response.statusCode, 400);
    }
    for (const method of ['POST', 'PATCH', 'DELETE'] as const) {
      const response = await f.api.inject({ method, url: '/office-api/monday/provenance', headers, ...(method !== 'DELETE' ? { payload: {} } : {}) }); assert.equal(response.statusCode, 404);
    }
    assert.equal(f.calls.status, 0); assert.equal(f.calls.readOnlyStatus, 0); assert.equal(f.calls.other, 0); assert.equal(f.store.writes, 0);
  });
});

function demoResponse() {
  return { schemaVersion: 1, source: 'demo', synthetic: true, readAt: new Date(AT).toISOString(), coverage: { caseIds: [...CASE_IDS], functionIds: [...FUNCTION_IDS] }, officeEvidence: [{ caseId: 'demo-aurora', source: 'fixture:office-demo', reference: 'demo:demo-aurora:case', observedAt: new Date(AT - 1000).toISOString(), simulated: true }], bridge: { state: 'available', partition: 'demo', storage: 'postgres', revision: 1, sourceVersions: [source(1)], bindings: [], importsEnabled: false, automaticLinking: false, metricsConsumed: false, coverage: 'complete' } };
}
function mondayResponse() {
  return { schemaVersion: 1, source: 'monday', synthetic: false, readAt: new Date(AT).toISOString(), connection: { state: 'connected', configured: true, boardAccessVerified: true, identityReadAt: new Date(AT - 1000).toISOString(), lastReadAt: null, expiresAt: new Date(AT + 1000).toISOString() }, bridge: { state: 'unconfigured', partition: 'external', storage: null, revision: null, sourceVersions: [], bindings: [], importsEnabled: false, automaticLinking: false, metricsConsumed: false, coverage: 'not_queried' } };
}
describe('strict shared provenance contracts', () => {
  it('returns detached DTOs for separate DEMO and Monday schemas', () => {
    const demo = demoResponse(); assert.deepEqual(validateDemoProvenance(demo), demo);
    const monday = mondayResponse(); assert.deepEqual(validateMondayProvenance(monday), monday);
    const result = validateDemoProvenance(demo); result.bridge.sourceVersions[0].reference.itemId = 'changed'; assert.equal(demo.bridge.sourceVersions[0].reference.itemId, 'item-1');
  });
  it('rejects implicit source mixing, extra sensitive fields, unbounded collections and false coverage', () => {
    for (const transform of [
      (value: ReturnType<typeof demoResponse>) => { value.synthetic = false; },
      (value: ReturnType<typeof demoResponse>) => { value.bridge.partition = 'external'; },
      (value: ReturnType<typeof demoResponse>) => { value.bridge.sourceVersions[0].reference.sourceSystem = 'monday'; },
      (value: ReturnType<typeof demoResponse>) => { value.bridge.sourceVersions[0].recordedBy = 'other-actor'; },
      (value: ReturnType<typeof demoResponse>) => { value.officeEvidence[0].caseId = 'demo-cedar'; value.coverage.caseIds = ['demo-aurora']; },
      (value: ReturnType<typeof demoResponse>) => { (value as unknown as Record<string, unknown>).access_token = 'synthetic-private'; },
      (value: ReturnType<typeof demoResponse>) => { value.bridge.sourceVersions = Array.from({ length: 51 }, (_, index) => source(index)); },
      (value: ReturnType<typeof demoResponse>) => { value.bridge.state = 'unconfigured'; },
      (value: ReturnType<typeof demoResponse>) => { value.bridge.importsEnabled = true; },
    ]) { const value = demoResponse(); transform(value); assert.throws(() => validateDemoProvenance(value), /^Error: Invalid provenance contract\.$/); }
    for (const transform of [
      (value: ReturnType<typeof mondayResponse>) => { value.synthetic = true; },
      (value: ReturnType<typeof mondayResponse>) => { value.bridge.partition = 'demo'; },
      (value: ReturnType<typeof mondayResponse>) => { (value.connection as unknown as Record<string, unknown>).grantFingerprint = 'synthetic-private'; },
      (value: ReturnType<typeof mondayResponse>) => { value.bridge.state = 'available'; value.bridge.sourceVersions = [source(1)]; },
    ]) { const value = mondayResponse(); transform(value); assert.throws(() => validateMondayProvenance(value), /^Error: Invalid provenance contract\.$/); }
  });
  it('rejects accessors and executable serializers without executing them', () => {
    let executed = 0;
    const value = demoResponse(); Object.defineProperty(value, 'private', { enumerable: true, get: () => { executed++; return 'synthetic-private'; } });
    assert.throws(() => validateDemoProvenance(value));
    const other = { ...demoResponse(), toJSON: () => { executed++; return {}; } }; assert.throws(() => validateDemoProvenance(other));
    assert.equal(executed, 0);
  });
});
