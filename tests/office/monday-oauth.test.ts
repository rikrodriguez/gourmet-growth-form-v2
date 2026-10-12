import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { MemoryMondayStore, MondayVault, type MondayStore, type MondayStoredRecord } from '../../src/office/backend/monday-store';
import { MONDAY_READ_BOARD_IDS, MONDAY_READ_SCOPES, type MondayIdentity, type MondayReadClient, type MondayReadInput } from '../../src/office/backend/monday-read';
import { createMondayOAuthService, parseMondayConfiguration, MONDAY_OAUTH_CALLBACK, MONDAY_OAUTH_ORIGIN, MONDAY_AUTHORIZED_USER_ID, MONDAY_AUTHORIZED_USER_EMAIL, MONDAY_CONFIGURED_ACCOUNT_ID, MONDAY_AUTHORIZE_URL, MONDAY_TOKEN_URL, MONDAY_REVOKE_URL, MondayOAuthError, type MondayConfiguration, type MondayOAuthOptions } from '../../src/office/backend/monday-oauth';
import type { MondayOAuthCallbackStage } from '../../src/office/monday-oauth-return';

const NOW = Date.parse('2026-10-11T12:00:00.000Z');
const NONCE = Buffer.alloc(32, 17).toString('base64url');
const OTHER_NONCE = Buffer.alloc(32, 18).toString('base64url');
const ENV = {
  MONDAY_OAUTH_ENABLED: 'true', MONDAY_CLIENT_ID: 'synthetic-client', MONDAY_CLIENT_SECRET: 'synthetic-client-secret',
  MONDAY_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 29).toString('base64'), MONDAY_EXPECTED_ACCOUNT_EMAIL: MONDAY_AUTHORIZED_USER_EMAIL,
  MONDAY_EXPECTED_USER_ID: MONDAY_AUTHORIZED_USER_ID, MONDAY_EXPECTED_ACCOUNT_ID: MONDAY_CONFIGURED_ACCOUNT_ID,
};
function configuration(): Extract<MondayConfiguration, { enabled: true }> {
  const parsed = parseMondayConfiguration(ENV, MONDAY_OAUTH_ORIGIN); assert.equal(parsed.enabled, true); return parsed as Extract<MondayConfiguration, { enabled: true }>;
}
function jwt(now: number, tag: string, extra: Record<string, unknown> = {}): string {
  return `${Buffer.from('{"alg":"synthetic-test-only"}').toString('base64url')}.${Buffer.from(JSON.stringify({ exp: Math.floor(now / 1000) + 3600, tag, ...extra })).toString('base64url')}.c3ludGhldGlj`;
}
function grant(now: number, tag = 'first', extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { access_token: jwt(now, tag), refresh_token: `synthetic-refresh-${tag}`, token_type: 'Bearer', scope: MONDAY_READ_SCOPES.join(' '), ...extra };
}
function json(value: unknown, status = 200): Response { return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } }); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const errorCode = (code: string) => (error: unknown) => error instanceof MondayOAuthError && error.code === code && !error.message.includes('synthetic-client-secret');
class ObservedStore extends MemoryMondayStore {
  writes: Array<{ key: string; value: unknown | null }> = [];
  override async compareAndSet(key: string, revision: number | null, value: unknown | null) {
    this.writes.push({ key, value }); return super.compareAndSet(key, revision, value);
  }
}
type Setup = ReturnType<typeof setup>;
function setup(overrides: Partial<MondayOAuthOptions> = {}) {
  let now = NOW; const store = new ObservedStore(); const vault = new MondayVault(Buffer.alloc(32, 29));
  const calls: Array<{ url: string; body: Record<string, unknown>; init: RequestInit }> = [];
  const reads: Array<MondayReadInput & { kind: string }> = [];
  let identityCalls = 0; let verificationCalls = 0;
  let provider = async (url: string, _body: Record<string, unknown>, _signal: AbortSignal | null | undefined): Promise<Response> => url === MONDAY_REVOKE_URL ? json({ success: true }) : json(grant(now, calls.length === 1 ? 'first' : `rotated-${calls.length}`));
  let identity = async (): Promise<MondayIdentity> => ({ id: MONDAY_AUTHORIZED_USER_ID, email: MONDAY_AUTHORIZED_USER_EMAIL, readAt: new Date(now).toISOString() });
  let boardAccess = async () => ({ boardIds: [...MONDAY_READ_BOARD_IDS], readAt: new Date(now).toISOString() });
  const fetcher: typeof fetch = async (url, init) => {
    const body = JSON.parse(init?.body as string) as Record<string, unknown>; calls.push({ url: String(url), body, init: init! });
    return provider(String(url), body, init?.signal);
  };
  const readClient: MondayReadClient = {
    async getIdentity() { identityCalls++; return identity(); },
    async verifyBoardAccess(accessToken) { verificationCalls++; assert.match(accessToken, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/); return boardAccess(); },
    async readBoard(input) { reads.push({ ...input, kind: 'board' }); return { status: 'complete', boardId: input.boardId, mappingVersion: 'test', readAt: new Date(now).toISOString(), pages: 1, items: [] }; },
    async readUpdates(input) { reads.push({ ...input, kind: 'updates' }); return { status: 'complete', boardId: input.boardId, mappingVersion: 'test', readAt: new Date(now).toISOString(), pages: 1, items: [] }; },
  };
  const options: MondayOAuthOptions = { configuration: configuration(), store, vault, readClient, fetch: fetcher, clock: () => now, requestTimeoutMs: 100, ...overrides };
  const service = createMondayOAuthService(options);
  return { service, options, store, vault, calls, reads, setTime(value: number) { now = value; }, now: () => now, setProvider(value: typeof provider) { provider = value; }, setIdentity(value: typeof identity) { identity = value; }, setBoardAccess(value: typeof boardAccess) { boardAccess = value; }, identityCalls: () => identityCalls, verificationCalls: () => verificationCalls };
}
async function begin(fixture: Setup, browserNonce = NONCE) {
  const start = await fixture.service.startOAuth({ ownerId: 'ricardo', browserNonce });
  const url = new URL(start.authorizationUrl); const state = url.searchParams.get('state'); assert.ok(state);
  return { start, url, state };
}
async function connect(fixture: Setup) {
  const { state } = await begin(fixture); const result = await fixture.service.callback({ state, code: 'synthetic-code' }, NONCE); assert.equal(result.state, 'connected'); return result;
}
async function connectionRecord(fixture: Setup) {
  const stored = await fixture.store.read('monday-connection-ricardo'); assert.ok(stored);
  return { stored, value: fixture.vault.open(stored.value, 'monday-connection-ricardo') as Record<string, unknown> };
}

const CALLBACK_STAGES: MondayOAuthCallbackStage[] = ['callback_state', 'provider_decision', 'persist_connection', 'token_exchange', 'token_response', 'identity_check', 'board_access_check', 'persist_connection'];
const PHASE_CANARY = 'synthetic-sensitive-phase-canary';
function tracedCallback(fixture: Pick<Setup, 'service'>, params: Parameters<Setup['service']['callback']>[0], observer: (stage: MondayOAuthCallbackStage) => void) {
  return fixture.service.callback(params, NONCE, observer);
}

test('callback phase observer reports only enums for successful bound consent', async () => {
  const fixture = setup(); const { state } = await begin(fixture); const stages: MondayOAuthCallbackStage[] = [];
  const result = await tracedCallback(fixture, { state, code: PHASE_CANARY }, stage => stages.push(stage));
  assert.deepEqual(stages, CALLBACK_STAGES);
  assert.equal(result.state, 'connected'); assert.equal(result.code, null); assert.equal(result.pending, false);
  assert.deepEqual(result.scopes, MONDAY_READ_SCOPES); assert.equal(result.scopes.length, 3);
  const { value } = await connectionRecord(fixture);
  assert.deepEqual((value.boardProof as { boardIds: string[] }).boardIds, MONDAY_READ_BOARD_IDS);
  assert.equal(MONDAY_READ_BOARD_IDS.length, 5);
  assert.equal(fixture.calls.length, 1); assert.equal(fixture.identityCalls(), 1); assert.equal(fixture.verificationCalls(), 1);
  for (const sensitive of [state, NONCE, PHASE_CANARY, ENV.MONDAY_CLIENT_SECRET, grant(NOW).access_token as string]) assert.ok(!JSON.stringify(stages).includes(sensitive));
});
test('callback phase observer retains each original failure stage after terminal cleanup', async () => {
  const cases = [
    ['callback_state', 'oauth_state_invalid'], ['provider_decision', 'oauth_denied'], ['token_exchange', 'code_exchange_uncertain'],
    ['token_response', 'token_invalid'], ['identity_check', 'identity_mismatch'], ['board_access_check', 'board_access_unverified'],
  ] as const;
  for (const [stage, code] of cases) {
    const fixture = setup(); const { state } = await begin(fixture); const stages: MondayOAuthCallbackStage[] = [];
    if (stage === 'token_exchange') fixture.setProvider(async () => { throw new Error(PHASE_CANARY); });
    if (stage === 'token_response') fixture.setProvider(async () => json(grant(NOW, 'invalid', { access_token: PHASE_CANARY })));
    if (stage === 'identity_check') fixture.setIdentity(async () => ({ id: '999', email: `${PHASE_CANARY}@invalid.test`, readAt: new Date(NOW).toISOString() }));
    if (stage === 'board_access_check') fixture.setBoardAccess(async () => ({ boardIds: MONDAY_READ_BOARD_IDS.slice(0, 4), readAt: new Date(NOW).toISOString() }));
    const params = stage === 'callback_state' ? { state: 'malformed', code: PHASE_CANARY } : stage === 'provider_decision' ? { state, error: PHASE_CANARY } : { state, code: PHASE_CANARY };
    if (stage === 'callback_state') await assert.rejects(tracedCallback(fixture, params, value => stages.push(value)), errorCode(code));
    else {
      const result = await tracedCallback(fixture, params, value => stages.push(value));
      assert.equal(result.code, code); assert.equal(result.pending, false);
    }
    assert.equal(stages.at(-1), stage);
    assert.ok(stages.every(value => CALLBACK_STAGES.includes(value)));
    for (const sensitive of [state, NONCE, PHASE_CANARY, ENV.MONDAY_CLIENT_SECRET]) assert.ok(!JSON.stringify(stages).includes(sensitive));
    const calls = fixture.calls.length;
    if (stage !== 'callback_state') await assert.rejects(tracedCallback(fixture, { state, code: PHASE_CANARY }, () => {}), errorCode('oauth_state_invalid'));
    assert.equal(fixture.calls.length, calls);
  }
});
test('callback phase observer reports persist_connection when exchange reservation loses CAS', async () => {
  const fixture = setup(); const { state } = await begin(fixture); const stages: MondayOAuthCallbackStage[] = [];
  const conflicting: MondayStore = { read: key => fixture.store.read(key), compareAndSet: (key, revision, value) => key === 'monday-connection-ricardo' ? Promise.resolve(false) : fixture.store.compareAndSet(key, revision, value) };
  const service = createMondayOAuthService({ ...fixture.options, store: conflicting });
  await assert.rejects(tracedCallback({ service }, { state, code: PHASE_CANARY }, stage => stages.push(stage)), errorCode('connection_changed'));
  assert.deepEqual(stages, ['callback_state', 'provider_decision', 'persist_connection']);
  assert.equal(fixture.calls.length, 0);
});
test('callback phase observer reports persist_connection when successful finalization loses CAS', async () => {
  const fixture = setup(); const { state } = await begin(fixture); const stages: MondayOAuthCallbackStage[] = [];
  const conflicting: MondayStore = { read: key => fixture.store.read(key), async compareAndSet(key, revision, record) {
    if (key === 'monday-connection-ricardo' && record !== null && (fixture.vault.open(record, key) as { state: string }).state === 'connected') return false;
    return fixture.store.compareAndSet(key, revision, record);
  } };
  const service = createMondayOAuthService({ ...fixture.options, store: conflicting });
  await assert.rejects(tracedCallback({ service }, { state, code: PHASE_CANARY }, stage => stages.push(stage)), errorCode('connection_changed'));
  assert.deepEqual(stages, CALLBACK_STAGES); assert.equal(stages.at(-1), 'persist_connection');
  assert.equal(fixture.calls.length, 1);
});
test('callback phase observer reports persist_connection when terminal cleanup fails', async () => {
  for (const denied of [false, true]) {
    const fixture = setup(); const { state } = await begin(fixture); const stages: MondayOAuthCallbackStage[] = [];
    fixture.setProvider(async () => { throw new Error(PHASE_CANARY); });
    const unavailable: MondayStore = { read: key => fixture.store.read(key), async compareAndSet(key, revision, record) {
      if (key === 'monday-connection-ricardo' && record !== null && (fixture.vault.open(record, key) as { attempt: unknown }).attempt === null) throw new Error(PHASE_CANARY);
      return fixture.store.compareAndSet(key, revision, record);
    } };
    const service = createMondayOAuthService({ ...fixture.options, store: unavailable });
    await assert.rejects(tracedCallback({ service }, denied ? { state, error: PHASE_CANARY } : { state, code: PHASE_CANARY }, stage => stages.push(stage)), errorCode('storage_unavailable'));
    assert.equal(stages.at(-1), 'persist_connection');
    assert.equal(fixture.calls.length, denied ? 0 : 1);
    assert.ok(!JSON.stringify(stages).includes(PHASE_CANARY));
  }
});
test('callback phase observer exceptions cannot change success or terminal failure', async () => {
  for (const failing of [false, true]) {
    const fixture = setup(); const { state } = await begin(fixture); const stages: MondayOAuthCallbackStage[] = [];
    if (failing) fixture.setProvider(async () => json(grant(NOW, 'invalid', { scope: 'boards:write' })));
    const result = await tracedCallback(fixture, { state, code: PHASE_CANARY }, stage => { stages.push(stage); throw new Error(PHASE_CANARY); });
    assert.equal(result.state, failing ? 'error' : 'connected'); assert.equal(result.code, failing ? 'scope_mismatch' : null); assert.equal(result.pending, false);
    assert.equal(stages.at(-1), failing ? 'token_response' : 'persist_connection');
    assert.equal(fixture.calls.length, 1); assert.equal(fixture.identityCalls(), failing ? 0 : 1); assert.equal(fixture.verificationCalls(), failing ? 0 : 1);
    assert.ok(!JSON.stringify(stages).includes(PHASE_CANARY));
  }
});
test('callback phase observer remains request local after a timed out transport resolves late', async () => {
  const fixture = setup({ requestTimeoutMs: 5 }); const { state } = await begin(fixture); const stages: MondayOAuthCallbackStage[] = [];
  const gate = deferred<Response>(); fixture.setProvider(() => gate.promise);
  const result = await tracedCallback(fixture, { state, code: PHASE_CANARY }, stage => stages.push(stage));
  assert.equal(result.code, 'code_exchange_uncertain'); assert.equal(result.pending, false); assert.equal(stages.at(-1), 'token_exchange');
  const finishedStages = [...stages]; gate.resolve(json(grant(NOW))); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(stages, finishedStages); assert.equal(fixture.calls.length, 1);
  fixture.setProvider(async () => json(grant(NOW, 'second'))); const next = await begin(fixture); const secondStages: MondayOAuthCallbackStage[] = [];
  assert.equal((await tracedCallback(fixture, { state: next.state, code: PHASE_CANARY }, stage => secondStages.push(stage))).state, 'connected');
  assert.deepEqual(secondStages, CALLBACK_STAGES); assert.deepEqual(stages, finishedStages); assert.equal(fixture.calls.length, 2);
});

test('configuration defaults disabled without reading any credential-bearing property', () => {
  for (const flag of [undefined, '', 'false']) {
    let touched = 0; const env: Record<string, string | undefined> = { MONDAY_OAUTH_ENABLED: flag };
    for (const key of Object.keys(ENV).filter(key => key !== 'MONDAY_OAUTH_ENABLED')) Object.defineProperty(env, key, { get() { touched++; throw new Error('must not read'); } });
    assert.deepEqual(parseMondayConfiguration(env, 'http://irrelevant.invalid.test'), { enabled: false }); assert.equal(touched, 0);
  }
});
test('enabled configuration accepts exact origin and canonical 32-byte base64 only', () => {
  const config = configuration(); assert.equal(config.redirectUri, MONDAY_OAUTH_CALLBACK); assert.equal(config.tokenEncryptionKey.length, 32);
  for (const origin of ['http://office-staging.gourmet-corporation.com', `${MONDAY_OAUTH_ORIGIN}/`, `${MONDAY_OAUTH_ORIGIN}:443`, 'https://other.invalid.test']) assert.throws(() => parseMondayConfiguration(ENV, origin), errorCode('configuration_invalid'));
  for (const value of ['1', 'TRUE', 'yes']) assert.throws(() => parseMondayConfiguration({ ...ENV, MONDAY_OAUTH_ENABLED: value }, MONDAY_OAUTH_ORIGIN), errorCode('configuration_invalid'));
  for (const value of [Buffer.alloc(31).toString('base64'), Buffer.alloc(33).toString('base64'), ENV.MONDAY_TOKEN_ENCRYPTION_KEY.replace(/=$/, ''), `${ENV.MONDAY_TOKEN_ENCRYPTION_KEY}\n`]) assert.throws(() => parseMondayConfiguration({ ...ENV, MONDAY_TOKEN_ENCRYPTION_KEY: value }, MONDAY_OAUTH_ORIGIN), errorCode('configuration_invalid'));
});
test('missing identity/client configuration fails with safe code and no sensitive value', () => {
  for (const key of ['MONDAY_CLIENT_ID', 'MONDAY_CLIENT_SECRET', 'MONDAY_EXPECTED_ACCOUNT_EMAIL', 'MONDAY_EXPECTED_USER_ID', 'MONDAY_EXPECTED_ACCOUNT_ID']) {
    assert.throws(() => parseMondayConfiguration({ ...ENV, [key]: undefined }, MONDAY_OAUTH_ORIGIN), errorCode('configuration_invalid'));
  }
});
test('configuration and constructor cannot widen the authorized pilot identity or configured account', () => {
  for (const [key, value] of [['MONDAY_EXPECTED_USER_ID', '999'], ['MONDAY_EXPECTED_ACCOUNT_EMAIL', 'other@invalid.test'], ['MONDAY_EXPECTED_ACCOUNT_ID', '999']]) {
    assert.throws(() => parseMondayConfiguration({ ...ENV, [key]: value }, MONDAY_OAUTH_ORIGIN), errorCode('configuration_invalid'));
  }
  const fixture = setup();
  for (const replacement of [{ expectedUserId: '999' }, { expectedAccountEmail: 'other@invalid.test' }, { expectedAccountId: '999' }]) {
    assert.throws(() => createMondayOAuthService({ ...fixture.options, configuration: { ...configuration(), ...replacement } }), errorCode('configuration_invalid'));
  }
  assert.equal(fixture.calls.length, 0); assert.equal(fixture.store.writes.length, 0);
});
test('configuration is snapshotted so later caller mutations cannot redirect or change the authorized user', async () => {
  const fixture = setup(); const mutable = configuration(); const service = createMondayOAuthService({ ...fixture.options, configuration: mutable });
  mutable.expectedUserId = '999'; mutable.expectedAccountEmail = 'other@invalid.test'; mutable.expectedAccountId = '999'; mutable.redirectUri = 'https://other.invalid.test' as never;
  const start = await service.startOAuth({ ownerId: 'ricardo', browserNonce: NONCE }); const state = new URL(start.authorizationUrl).searchParams.get('state')!;
  assert.equal(new URL(start.authorizationUrl).searchParams.get('redirect_uri'), MONDAY_OAUTH_CALLBACK);
  const result = await service.callback({ state, code: 'synthetic-code' }, NONCE); assert.equal(result.state, 'connected'); assert.equal(result.actorId, MONDAY_AUTHORIZED_USER_ID); assert.equal(result.configuredAccountId, MONDAY_CONFIGURED_ACCOUNT_ID);
});
test('disabled service never reads storage or dispatches requests', async () => {
  const unavailable = async (): Promise<never> => { throw new Error('disabled path touched dependency'); };
  const fixture = setup({ configuration: { enabled: false }, store: { read: unavailable, compareAndSet: unavailable }, fetch: unavailable });
  assert.equal((await fixture.service.status()).state, 'disabled');
  await assert.rejects(fixture.service.startOAuth({ ownerId: 'ricardo', browserNonce: NONCE }), errorCode('disabled'));
  await assert.rejects(fixture.service.refresh(), errorCode('disabled')); await assert.rejects(fixture.service.disconnect(), errorCode('disabled'));
  await assert.rejects(fixture.service.readBoard(MONDAY_READ_BOARD_IDS[0]), errorCode('disabled')); assert.equal(fixture.calls.length, 0);
});
test('owner, nonce, getters and redirect overrides are rejected before persistent state or requests', async () => {
  const fixture = setup();
  await assert.rejects(fixture.service.startOAuth({ ownerId: 'demo', browserNonce: NONCE }), errorCode('owner_forbidden'));
  await assert.rejects(fixture.service.startOAuth({ ownerId: 'ricardo', browserNonce: 'weak' }), errorCode('oauth_state_invalid'));
  const getter = { ownerId: 'ricardo', get browserNonce(): string { throw new Error('getter executed'); } };
  await assert.rejects(fixture.service.startOAuth(getter), errorCode('oauth_state_invalid'));
  await assert.rejects(fixture.service.startOAuth({ ownerId: 'ricardo', browserNonce: NONCE, redirectUri: 'https://other.invalid.test' } as never), errorCode('oauth_state_invalid'));
  assert.throws(() => createMondayOAuthService({ ...fixture.options, configuration: { ...configuration(), redirectUri: 'https://other.invalid.test' as never } }), errorCode('configuration_invalid'));
  assert.equal(fixture.store.writes.length, 0); assert.equal(fixture.calls.length, 0);
});
test('authorization URL requests exact scopes, fixed callback, crypto state and matching S256 PKCE', async () => {
  const fixture = setup(); const { start, url, state } = await begin(fixture);
  assert.equal(`${url.origin}${url.pathname}`, MONDAY_AUTHORIZE_URL); assert.equal(url.searchParams.get('redirect_uri'), MONDAY_OAUTH_CALLBACK);
  assert.equal(url.searchParams.get('scope'), MONDAY_READ_SCOPES.join(' ')); assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.match(state, /^[A-Za-z0-9_-]{43}$/); assert.equal(start.expiresAt, new Date(NOW + 300_000).toISOString());
  const serialized = JSON.stringify(fixture.store.writes);
  assert.ok(!serialized.includes(state)); assert.ok(!serialized.includes(NONCE)); assert.ok(!serialized.includes('synthetic-client-secret'));
  await fixture.service.callback({ state, code: 'synthetic-code', status: 'opaque-undocumented-status' }, NONCE);
  const exchange = fixture.calls[0]; assert.equal(exchange.url, MONDAY_TOKEN_URL); assert.equal(exchange.init.method, 'POST'); assert.equal(exchange.init.redirect, 'error');
  assert.equal(exchange.body.grant_type, 'authorization_code'); assert.equal(exchange.body.redirect_uri, MONDAY_OAUTH_CALLBACK);
  assert.match(exchange.body.code_verifier as string, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(createHash('sha256').update(exchange.body.code_verifier as string).digest('base64url'), url.searchParams.get('code_challenge'));
});
test('state keeps a consistent five-minute interval when real time advances during persistence', async () => {
  const fixture = setup(); const advancing: MondayStore = {
    read: key => fixture.store.read(key),
    async compareAndSet(key, revision, value) { const saved = await fixture.store.compareAndSet(key, revision, value); fixture.setTime(fixture.now() + 7); return saved; },
  };
  const service = createMondayOAuthService({ ...fixture.options, store: advancing });
  const start = await service.startOAuth({ ownerId: 'ricardo', browserNonce: NONCE }); const state = new URL(start.authorizationUrl).searchParams.get('state')!;
  assert.equal(start.expiresAt, new Date(NOW + 300_000).toISOString()); assert.ok(fixture.now() > NOW);
  const result = await service.callback({ state, code: 'synthetic-code' }, NONCE); assert.equal(result.state, 'connected'); assert.equal(fixture.calls.length, 1);
});
test('opaque undocumented callback status neither grants nor blocks consent proved by code and state', async () => {
  for (const status of ['status value not documented', '', 'éxito proveedor']) {
    const fixture = setup(); const { state } = await begin(fixture);
    assert.equal((await fixture.service.callback({ state, code: 'synthetic-code', status }, NONCE)).state, 'connected');
  }
});
test('wrong browser nonce does not consume the legitimate single-use state', async () => {
  const fixture = setup(); const { state } = await begin(fixture);
  await assert.rejects(fixture.service.callback({ state, code: 'synthetic-code' }, OTHER_NONCE), errorCode('oauth_state_invalid'));
  assert.equal(fixture.calls.length, 0); assert.equal((await fixture.service.callback({ state, code: 'synthetic-code' }, NONCE)).state, 'connected');
});
test('state expiry consumes locally without provider requests and survives a new service instance', async () => {
  const fixture = setup(); const { state } = await begin(fixture); fixture.setTime(NOW + 300_000);
  const restarted = createMondayOAuthService(fixture.options);
  await assert.rejects(restarted.callback({ state, code: 'synthetic-code' }, NONCE), errorCode('oauth_state_expired'));
  assert.equal(fixture.calls.length, 0); assert.equal((await restarted.status()).code, 'oauth_state_expired');
  await assert.rejects(restarted.callback({ state, code: 'synthetic-code' }, NONCE), errorCode('oauth_state_invalid'));
});
test('concurrent callbacks consume state once before a single exchange, including across services', async () => {
  const fixture = setup(); const second = createMondayOAuthService(fixture.options); const { state } = await begin(fixture);
  const gate = deferred<Response>(); fixture.setProvider(() => gate.promise);
  const first = fixture.service.callback({ state, code: 'synthetic-code' }, NONCE);
  const secondCall = second.callback({ state, code: 'synthetic-code' }, NONCE);
  gate.resolve(json(grant(NOW))); const results = await Promise.allSettled([first, secondCall]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1); assert.equal(fixture.calls.length, 1);
  const failure = results.find(result => result.status === 'rejected') as PromiseRejectedResult; assert.ok(errorCode('oauth_state_invalid')(failure.reason));
  await assert.rejects(fixture.service.callback({ state, code: 'synthetic-code' }, NONCE), errorCode('oauth_state_invalid')); assert.equal(fixture.calls.length, 1);
});
test('explicit provider error or missing code terminates state without trusting callback status', async () => {
  for (const params of [{ error: 'access_denied', status: 'success' }, { status: 'success' }]) {
    const fixture = setup(); const { state } = await begin(fixture); const outcome = await fixture.service.callback({ state, ...params }, NONCE);
    assert.equal(outcome.state, 'error'); assert.equal(outcome.code, 'oauth_denied'); assert.equal(fixture.calls.length, 0);
    await assert.rejects(fixture.service.callback({ state, code: 'synthetic-code' }, NONCE), errorCode('oauth_state_invalid'));
  }
});
test('callback unknown fields/getters and invalid state syntax make no provider calls', async () => {
  const fixture = setup(); const { state } = await begin(fixture);
  await assert.rejects(fixture.service.callback({ state, code: 'synthetic-code', redirect_uri: 'https://other.invalid.test' } as never, NONCE), errorCode('oauth_state_invalid'));
  await assert.rejects(fixture.service.callback({ state, get code(): string { throw new Error('getter'); } }, NONCE), errorCode('oauth_state_invalid'));
  await assert.rejects(fixture.service.callback({ state: `${state}\n`, code: 'synthetic-code' }, NONCE), errorCode('oauth_state_invalid'));
  assert.equal(fixture.calls.length, 0);
});
test('callback verifies identity and all five boards, encrypting credentials while account stays explicitly unverified', async () => {
  const fixture = setup(); const result = await connect(fixture);
  assert.equal(result.actorId, MONDAY_AUTHORIZED_USER_ID); assert.equal(result.accountId, null); assert.equal(result.configuredAccountId, MONDAY_CONFIGURED_ACCOUNT_ID); assert.equal(result.accountVerified, false);
  assert.equal(result.boardAccessVerified, true); assert.equal(result.boardAccessReadAt, new Date(NOW).toISOString()); assert.equal(result.identityReadAt, new Date(NOW).toISOString());
  assert.deepEqual(result.scopes, MONDAY_READ_SCOPES); assert.equal(fixture.identityCalls(), 1); assert.equal(fixture.verificationCalls(), 1);
  const serialized = JSON.stringify(fixture.store.writes); const projection = JSON.stringify(result);
  for (const secret of [grant(NOW).access_token as string, 'synthetic-refresh-first', 'synthetic-client-secret', MONDAY_AUTHORIZED_USER_EMAIL]) { assert.ok(!serialized.includes(secret)); assert.ok(!projection.includes(secret)); }
  assert.equal((await fixture.service.status()).pending, false);
});
test('unverified JWT identity/account claims never replace me or the exact board access check', async () => {
  const fixture = setup(); fixture.setProvider(async () => json(grant(NOW, 'forged', { access_token: jwt(NOW, 'forged', { user_id: '999', account_id: '888', email: 'wrong@invalid.test' }) })));
  const result = await connect(fixture); assert.equal(result.actorId, MONDAY_AUTHORIZED_USER_ID); assert.equal(result.accountId, null); assert.equal(result.accountVerified, false); assert.equal(fixture.identityCalls(), 1); assert.equal(fixture.verificationCalls(), 1);
});
test('missing board access blocks connection and every board/updates read without retaining new tokens', async () => {
  const fixture = setup(); fixture.setBoardAccess(async () => ({ boardIds: MONDAY_READ_BOARD_IDS.slice(0, 4), readAt: new Date(NOW).toISOString() })); const { state } = await begin(fixture);
  const result = await fixture.service.callback({ state, code: 'synthetic-code' }, NONCE);
  assert.equal(result.state, 'error'); assert.equal(result.code, 'board_access_unverified'); assert.equal(result.accountId, null); assert.equal(result.accountVerified, false); assert.equal(result.boardAccessVerified, false); assert.equal(result.expiresAt, null);
  assert.equal((await connectionRecord(fixture)).value.tokens, null);
  await assert.rejects(fixture.service.readBoard(MONDAY_READ_BOARD_IDS[0]), errorCode('not_connected'));
  await assert.rejects(fixture.service.readUpdates(MONDAY_READ_BOARD_IDS[0]), errorCode('not_connected')); assert.equal(fixture.reads.length, 0);
});
test('board proof rejects extra, duplicate, sparse, accessor and stale results rather than inventing access', async () => {
  const sparse = [...MONDAY_READ_BOARD_IDS]; delete (sparse as unknown[])[2];
  const accessor = [...MONDAY_READ_BOARD_IDS]; Object.defineProperty(accessor, '2', { enumerable: true, get() { throw new Error('board getter executed'); } });
  const results: unknown[] = [
    { boardIds: [...MONDAY_READ_BOARD_IDS, '999'], readAt: new Date(NOW).toISOString() },
    { boardIds: [MONDAY_READ_BOARD_IDS[0], MONDAY_READ_BOARD_IDS[0], ...MONDAY_READ_BOARD_IDS.slice(2)], readAt: new Date(NOW).toISOString() },
    { boardIds: sparse, readAt: new Date(NOW).toISOString() }, { boardIds: accessor, readAt: new Date(NOW).toISOString() },
    { boardIds: [...MONDAY_READ_BOARD_IDS], readAt: new Date(NOW - 301_000).toISOString() },
    { boardIds: [...MONDAY_READ_BOARD_IDS], readAt: new Date(NOW + 31_000).toISOString() },
    { boardIds: [...MONDAY_READ_BOARD_IDS], readAt: new Date(NOW).toISOString(), accountId: MONDAY_CONFIGURED_ACCOUNT_ID },
  ];
  for (const result of results) {
    const fixture = setup(); fixture.setBoardAccess(async () => result as never); const { state } = await begin(fixture);
    const outcome = await fixture.service.callback({ state, code: 'synthetic-code' }, NONCE);
    assert.equal(outcome.state, 'error'); assert.equal(outcome.code, 'board_access_unverified'); assert.equal(outcome.boardAccessVerified, false);
    assert.equal((await connectionRecord(fixture)).value.tokens, null); assert.equal(fixture.reads.length, 0);
  }
  const fixture = setup(); fixture.setBoardAccess(async () => ({ boardIds: [...MONDAY_READ_BOARD_IDS].reverse(), readAt: new Date(NOW).toISOString() }));
  assert.equal((await connect(fixture)).boardAccessVerified, true);
});
test('board verifier exceptions are sanitized and scope expansion never reaches the verifier', async () => {
  const fixture = setup(); fixture.setBoardAccess(async () => { throw new Error('synthetic-client-secret raw-board-response'); });
  const { state } = await begin(fixture); const outcome = await fixture.service.callback({ state, code: 'synthetic-code' }, NONCE);
  assert.equal(outcome.code, 'board_access_unverified'); assert.ok(!JSON.stringify(outcome).includes('raw-board-response'));
  const expanded = setup(); expanded.setProvider(async () => json(grant(NOW, 'expanded', { scope: 'boards:read updates:read me:read account:read' })));
  const attempt = await begin(expanded); assert.equal((await expanded.service.callback({ state: attempt.state, code: 'synthetic-code' }, NONCE)).code, 'scope_mismatch');
  assert.equal(expanded.identityCalls(), 0); assert.equal(expanded.verificationCalls(), 0);
});
test('encrypted board proof is bound to the exact bearer token, actor and five board IDs', async () => {
  for (const mutation of ['token', 'actor', 'boards']) {
    const fixture = setup(); await connect(fixture); const { stored, value } = await connectionRecord(fixture);
    const proof = value.boardProof as Record<string, unknown>;
    assert.equal(proof.actorId, MONDAY_AUTHORIZED_USER_ID); assert.deepEqual(proof.boardIds, MONDAY_READ_BOARD_IDS);
    assert.equal(proof.tokenDigest, createHash('sha256').update(grant(NOW).access_token as string).digest('base64url'));
    if (mutation === 'token') (value.tokens as Record<string, unknown>).accessToken = jwt(NOW, 'different');
    if (mutation === 'actor') proof.actorId = '999';
    if (mutation === 'boards') proof.boardIds = MONDAY_READ_BOARD_IDS.slice(0, 4);
    await fixture.store.compareAndSet('monday-connection-ricardo', stored.revision, fixture.vault.seal(value, 'monday-connection-ricardo'));
    await assert.rejects(fixture.service.status(), errorCode('storage_unavailable')); assert.equal(fixture.calls.length, 1);
  }
});
test('wrong user, email or stale identity fail closed before checking boards', async () => {
  for (const identity of [{ id: '999', email: MONDAY_AUTHORIZED_USER_EMAIL, readAt: new Date(NOW).toISOString() }, { id: MONDAY_AUTHORIZED_USER_ID, email: 'other@invalid.test', readAt: new Date(NOW).toISOString() }, { id: MONDAY_AUTHORIZED_USER_ID, email: MONDAY_AUTHORIZED_USER_EMAIL, readAt: new Date(NOW - 301_000).toISOString() }]) {
    const fixture = setup(); fixture.setIdentity(async () => identity); const { state } = await begin(fixture);
    assert.equal((await fixture.service.callback({ state, code: 'synthetic-code' }, NONCE)).code, 'identity_mismatch'); assert.equal(fixture.verificationCalls(), 0);
  }
});
test('extra, missing, duplicate and incorrect granted scopes are rejected before identity', async () => {
  for (const scope of ['boards:read updates:read me:read account:read', 'boards:read me:read', 'boards:read boards:read me:read', 'boards:read updates:write me:read', 'boards:read  updates:read me:read']) {
    const fixture = setup(); fixture.setProvider(async () => json(grant(NOW, 'scope', { scope }))); const { state } = await begin(fixture);
    const result = await fixture.service.callback({ state, code: 'synthetic-code' }, NONCE); assert.equal(result.code, 'scope_mismatch'); assert.equal(fixture.identityCalls(), 0);
  }
  const fixture = setup(); fixture.setProvider(async () => json(grant(NOW, 'ordered', { scope: 'me:read updates:read boards:read' }))); assert.equal((await connect(fixture)).state, 'connected');
});
test('invalid token type, malformed JWT and unbounded/past/noninteger exp fail before identity', async () => {
  const responses = [grant(NOW, 'bad', { token_type: 'bearer' }), grant(NOW, 'bad', { access_token: 'legacy-opaque-token' }), grant(NOW, 'bad', { access_token: jwt(NOW, 'bad', { exp: NOW / 1000 }) }), grant(NOW, 'bad', { access_token: jwt(NOW, 'bad', { exp: NOW / 1000 + 0.5 }) }), grant(NOW, 'bad', { access_token: jwt(NOW, 'bad', { exp: NOW / 1000 + 367 * 86400 }) }), grant(NOW, 'bad', { refresh_token: '' })];
  for (const response of responses) {
    const fixture = setup(); fixture.setProvider(async () => json(response)); const { state } = await begin(fixture);
    assert.equal((await fixture.service.callback({ state, code: 'synthetic-code' }, NONCE)).code, 'token_invalid'); assert.equal(fixture.identityCalls(), 0);
  }
});
test('failed reconnection retains a previously verified live connection without attaching wrong grants', async () => {
  const fixture = setup(); const old = await connect(fixture); fixture.setProvider(async () => json(grant(NOW, 'bad-scope', { scope: 'boards:write' })));
  const { state } = await begin(fixture); const result = await fixture.service.callback({ state, code: 'synthetic-second-code' }, NONCE);
  assert.equal(result.state, 'connected'); assert.equal(result.code, 'scope_mismatch'); assert.equal(result.connectedAt, old.connectedAt);
  await fixture.service.readBoard(MONDAY_READ_BOARD_IDS[0]); assert.equal(fixture.reads[0].accessToken, grant(NOW).access_token);
});
test('uncertain exchange is terminal, sanitized and never replays the authorization code', async () => {
  const fixture = setup(); fixture.setProvider(async () => { throw new Error('synthetic-client-secret raw-provider-error'); }); const { state } = await begin(fixture);
  const result = await fixture.service.callback({ state, code: 'synthetic-code' }, NONCE);
  assert.equal(result.code, 'code_exchange_uncertain'); assert.ok(!JSON.stringify(result).includes('raw-provider-error'));
  await assert.rejects(fixture.service.callback({ state, code: 'synthetic-code' }, NONCE), errorCode('oauth_state_invalid')); assert.equal(fixture.calls.length, 1);
});
test('timeout aborts the exchange even when injected transport ignores AbortSignal', async () => {
  const fixture = setup({ requestTimeoutMs: 5 }); let signal: AbortSignal | null | undefined;
  fixture.setProvider(async (_url, _body, supplied) => { signal = supplied; return new Promise<Response>(() => {}); }); const { state } = await begin(fixture);
  const result = await fixture.service.callback({ state, code: 'synthetic-code' }, NONCE);
  assert.equal(result.code, 'code_exchange_uncertain'); assert.equal(signal?.aborted, true); assert.equal((await fixture.service.status()).pending, false);
});
test('bounded response, non-JSON and HTTP rejection never retain provider body or credentials', async () => {
  for (const response of [json({ detail: 'synthetic-client-secret' }, 401), new Response('synthetic-client-secret', { headers: { 'Content-Type': 'text/plain' } }), json({ padding: 'z'.repeat(65_537) })]) {
    const fixture = setup(); fixture.setProvider(async () => response); const { state } = await begin(fixture);
    const result = await fixture.service.callback({ state, code: 'synthetic-code' }, NONCE); assert.equal(result.code, 'token_invalid'); assert.ok(!JSON.stringify(result).includes('synthetic-client-secret'));
  }
});
test('readBoard and readUpdates receive proven identity, fixed scopes and token internally only', async () => {
  const fixture = setup(); await connect(fixture); fixture.setTime(NOW + 1000);
  assert.equal((await fixture.service.readBoard(MONDAY_READ_BOARD_IDS[0])).status, 'complete'); assert.equal((await fixture.service.readUpdates(MONDAY_READ_BOARD_IDS[2])).status, 'complete');
  assert.equal(fixture.reads.length, 2); assert.equal(fixture.reads[0].actorId, MONDAY_AUTHORIZED_USER_ID); assert.deepEqual(fixture.reads[0].scopes, MONDAY_READ_SCOPES);
  assert.equal((await fixture.service.status()).lastReadAt, new Date(NOW + 1000).toISOString()); assert.equal(fixture.calls.length, 1);
  await assert.rejects(fixture.service.readBoard('999' as never), errorCode('read_unavailable')); assert.equal(fixture.reads.length, 2);
});
test('excluded Deals cannot read records or update metadata and preserves the five-board OAuth proof', async () => {
  const fixture = setup(); const connected = await connect(fixture);
  assert.equal(connected.boardAccessVerified, true); assert.equal(fixture.verificationCalls(), 1);
  const before = await connectionRecord(fixture); const writes = fixture.store.writes.length;
  for (const method of ['readBoard', 'readUpdates'] as const) {
    await assert.rejects(fixture.service[method]('18411103560'), error => error instanceof MondayOAuthError && error.code === 'read_unavailable' && error.httpStatus === 403);
  }
  assert.equal(fixture.reads.length, 0); assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.store.writes.length, writes);
  const after = await connectionRecord(fixture); assert.deepEqual(after, before);
});
test('expiry blocks reads without inventing lifetime or auto-refreshing, while explicit refresh remains allowed', async () => {
  const fixture = setup(); await connect(fixture); fixture.setTime(NOW + 3600_000);
  assert.equal((await fixture.service.status()).state, 'expired'); await assert.rejects(fixture.service.readBoard(MONDAY_READ_BOARD_IDS[0]), errorCode('expired'));
  assert.equal(fixture.calls.length, 1); assert.equal(fixture.reads.length, 0); assert.equal((await fixture.service.refresh()).state, 'connected'); assert.equal(fixture.calls.length, 2);
});
test('refresh rotates both tokens exactly once and never exposes them through projection', async () => {
  const fixture = setup(); await connect(fixture); const status = await fixture.service.refresh();
  assert.equal(status.state, 'connected'); assert.equal(fixture.calls[1].body.grant_type, 'refresh_token'); assert.equal(fixture.calls[1].body.refresh_token, 'synthetic-refresh-first');
  assert.equal(status.accountId, null); assert.equal(status.accountVerified, false); assert.equal(status.configuredAccountId, MONDAY_CONFIGURED_ACCOUNT_ID); assert.equal(status.boardAccessVerified, true);
  assert.equal(fixture.identityCalls(), 2); assert.equal(fixture.verificationCalls(), 2);
  assert.ok(!JSON.stringify(status).includes('synthetic-refresh')); assert.ok(!JSON.stringify(fixture.store.writes).includes('synthetic-refresh'));
  await fixture.service.readBoard(MONDAY_READ_BOARD_IDS[0]); assert.notEqual(fixture.reads[0].accessToken, grant(NOW).access_token);
});
test('refresh rechecks user, email, exact scopes and complete board access before persisting rotated tokens', async () => {
  for (const invalid of ['user', 'email', 'extra-scope', 'missing-scope', 'missing-board', 'extra-board', 'board-offline']) {
    const fixture = setup(); await connect(fixture);
    if (invalid === 'user') fixture.setIdentity(async () => ({ id: '999', email: MONDAY_AUTHORIZED_USER_EMAIL, readAt: new Date(NOW).toISOString() }));
    if (invalid === 'email') fixture.setIdentity(async () => ({ id: MONDAY_AUTHORIZED_USER_ID, email: 'wrong@invalid.test', readAt: new Date(NOW).toISOString() }));
    if (invalid === 'extra-scope' || invalid === 'missing-scope') fixture.setProvider(async () => json(grant(NOW, 'rotated', { scope: invalid === 'extra-scope' ? 'boards:read updates:read me:read account:read' : 'boards:read me:read' })));
    if (invalid === 'missing-board') fixture.setBoardAccess(async () => ({ boardIds: MONDAY_READ_BOARD_IDS.slice(0, 4), readAt: new Date(NOW).toISOString() }));
    if (invalid === 'extra-board') fixture.setBoardAccess(async () => ({ boardIds: [...MONDAY_READ_BOARD_IDS, '999'] as never, readAt: new Date(NOW).toISOString() }));
    if (invalid === 'board-offline') fixture.setBoardAccess(async () => { throw new Error('synthetic-client-secret'); });
    const outcome = await fixture.service.refresh(); assert.equal(outcome.state, 'error'); assert.equal(outcome.code, 'refresh_uncertain');
    assert.equal(outcome.boardAccessVerified, false); assert.equal(outcome.actorId, null); assert.equal(outcome.accountId, null); assert.equal(outcome.accountVerified, false);
    assert.equal((await connectionRecord(fixture)).value.tokens, null);
    await assert.rejects(fixture.service.refresh(), errorCode('not_connected')); assert.equal(fixture.calls.length, 2);
  }
});
test('concurrent refresh claims once outside store operations and removes old credentials before dispatch', async () => {
  const fixture = setup(); await connect(fixture); const gate = deferred<Response>(); const dispatched = deferred<void>();
  fixture.setProvider(async () => { const record = await connectionRecord(fixture); assert.equal(record.value.tokens, null); dispatched.resolve(); return gate.promise; });
  const first = fixture.service.refresh(); await dispatched.promise;
  await assert.rejects(createMondayOAuthService(fixture.options).refresh(), errorCode('operation_in_progress'));
  gate.resolve(json(grant(NOW, 'rotated'))); assert.equal((await first).state, 'connected'); assert.equal(fixture.calls.length, 2);
});
test('same refresh/access token, grant failures and unknown refresh outcomes require manual reconnect', async () => {
  for (const provider of [async () => json(grant(NOW)), async () => json(grant(NOW, 'bad', { scope: 'boards:write' })), async () => { throw new Error('raw secret provider message'); }]) {
    const fixture = setup(); await connect(fixture); fixture.setProvider(provider); const result = await fixture.service.refresh();
    assert.equal(result.state, 'error'); assert.equal(result.code, 'refresh_uncertain'); assert.equal((await connectionRecord(fixture)).value.tokens, null);
    await assert.rejects(fixture.service.refresh(), errorCode('not_connected')); assert.equal(fixture.calls.length, 2); assert.ok(!JSON.stringify(result).includes('raw secret'));
  }
});
test('restart after unfinished refresh records uncertainty when lease expires and never retries old token', async () => {
  const fixture = setup(); await connect(fixture); const { stored, value } = await connectionRecord(fixture);
  value.tokens = null; value.state = 'disconnected'; value.actorId = null; value.boardProof = null; value.connectedAt = null; value.identityReadAt = null;
  value.attempt = { id: Buffer.alloc(32, 31).toString('base64url'), kind: 'refresh', deadline: NOW + 1000 };
  assert.equal(await fixture.store.compareAndSet('monday-connection-ricardo', stored.revision, fixture.vault.seal(value, 'monday-connection-ricardo')), true);
  const restarted = createMondayOAuthService(fixture.options); assert.equal((await restarted.status()).pending, true);
  await assert.rejects(restarted.refresh(), errorCode('operation_in_progress')); fixture.setTime(NOW + 1000);
  const result = await restarted.status(); assert.equal(result.state, 'error'); assert.equal(result.code, 'refresh_uncertain'); assert.equal(result.pending, false);
  await assert.rejects(restarted.refresh(), errorCode('not_connected')); assert.equal(fixture.calls.length, 1);
});
test('disconnect revokes refresh and access at most once each after durable local deletion', async () => {
  const fixture = setup(); await connect(fixture);
  fixture.setProvider(async (url, body) => { assert.equal(url, MONDAY_REVOKE_URL); assert.equal((await connectionRecord(fixture)).value.tokens, null); assert.ok(['access_token', 'refresh_token'].includes(body.token_type_hint as string)); return json({ success: true }); });
  const result = await fixture.service.disconnect(); assert.equal(result.state, 'disconnected'); assert.equal(result.code, null); assert.equal(result.actorId, null); assert.equal(result.expiresAt, null);
  assert.equal(fixture.calls.length, 3); assert.deepEqual(fixture.calls.slice(1).map(call => call.body.token_type_hint), ['refresh_token', 'access_token']);
  await fixture.service.disconnect(); assert.equal(fixture.calls.length, 3); await assert.rejects(fixture.service.refresh(), errorCode('not_connected'));
});
test('a concurrent disconnect cannot erase pending revocation uncertainty or duplicate remote calls', async () => {
  const fixture = setup(); await connect(fixture); const dispatched = deferred<void>(); const gate = deferred<Response>();
  fixture.setProvider(async () => { dispatched.resolve(); return gate.promise; }); const first = fixture.service.disconnect(); await dispatched.promise;
  await assert.rejects(createMondayOAuthService(fixture.options).disconnect(), errorCode('operation_in_progress'));
  gate.resolve(json({ success: false })); const outcome = await first;
  assert.equal(outcome.state, 'disconnected'); assert.equal(outcome.code, 'revoke_uncertain'); assert.equal(fixture.calls.length, 3);
});
test('remote revoke failures retain specific uncertainty while all local credentials remain discarded', async () => {
  const fixture = setup(); await connect(fixture); fixture.setProvider(async () => { throw new Error('synthetic-client-secret raw-revoke-error'); });
  const result = await fixture.service.disconnect(); assert.equal(result.state, 'disconnected'); assert.equal(result.code, 'revoke_uncertain'); assert.equal(fixture.calls.length, 3);
  assert.equal((await connectionRecord(fixture)).value.tokens, null); assert.ok(!JSON.stringify(result).includes('raw-revoke-error')); assert.ok(!JSON.stringify(result).includes('synthetic-client-secret'));
  await assert.rejects(fixture.service.readBoard(MONDAY_READ_BOARD_IDS[0]), errorCode('not_connected'));
});
test('disconnect during code exchange fences late success and reports unknown remote grant', async () => {
  const fixture = setup(); const { state } = await begin(fixture); const gate = deferred<Response>(); const dispatched = deferred<void>();
  fixture.setProvider(async () => { dispatched.resolve(); return gate.promise; });
  const exchange = fixture.service.callback({ state, code: 'synthetic-code' }, NONCE); await dispatched.promise;
  const result = await fixture.service.disconnect(); assert.equal(result.state, 'disconnected'); assert.equal(result.code, 'revoke_uncertain');
  gate.resolve(json(grant(NOW))); await assert.rejects(exchange, errorCode('connection_changed'));
  assert.equal((await fixture.service.status()).state, 'disconnected'); assert.equal((await connectionRecord(fixture)).value.tokens, null); assert.equal(fixture.calls.length, 1);
});
test('storage errors and tampered ciphertext fail safely without leaking raw exceptions or dispatching', async () => {
  const fixture = setup(); const unavailable: MondayStore = { async read() { throw new Error('synthetic-client-secret database text'); }, async compareAndSet() { throw new Error('synthetic-client-secret database text'); } };
  await assert.rejects(createMondayOAuthService({ ...fixture.options, store: unavailable }).status(), errorCode('storage_unavailable'));
  await connect(fixture); const { stored } = await connectionRecord(fixture); const sealed = stored.value as Record<string, unknown>;
  await fixture.store.compareAndSet('monday-connection-ricardo', stored.revision, { ...sealed, tag: Buffer.alloc(16).toString('base64url') });
  await assert.rejects(fixture.service.status(), errorCode('storage_unavailable')); assert.equal(fixture.calls.length, 1);
});
test('stored status codes and dates cannot carry credential or provider text into a public projection', async () => {
  for (const field of ['code', 'lastReadAt', 'connectedAt', 'identityReadAt']) {
    const fixture = setup(); await connect(fixture); const { stored, value } = await connectionRecord(fixture);
    value[field] = 'synthetic-client-secret raw-provider-text';
    await fixture.store.compareAndSet('monday-connection-ricardo', stored.revision, fixture.vault.seal(value, 'monday-connection-ricardo'));
    await assert.rejects(fixture.service.status(), errorCode('storage_unavailable')); assert.equal(fixture.calls.length, 1);
  }
});
test('state consumption storage failure cannot trigger exchange or expose store exception', async () => {
  const fixture = setup(); const { state } = await begin(fixture);
  const broken: MondayStore = { read: key => fixture.store.read(key), compareAndSet: async (key, revision, value) => { if (key.startsWith('monday-oauth-state-') && value === null) throw new Error('synthetic-client-secret'); return fixture.store.compareAndSet(key, revision, value); } };
  await assert.rejects(createMondayOAuthService({ ...fixture.options, store: broken }).callback({ state, code: 'synthetic-code' }, NONCE), errorCode('storage_unavailable')); assert.equal(fixture.calls.length, 0);
});
