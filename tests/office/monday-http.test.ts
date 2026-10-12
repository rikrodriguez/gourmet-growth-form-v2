import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { createOfficeApi } from '../../src/office/backend/http';
import { parseOfficeStagingEnvironment } from '../../src/office/backend/staging';
import { createOfficeFixtureState } from '../../src/office/backend/fixtures';
import type { OfficeState, OfficeStore } from '../../src/office/backend/state';
import { MondayOwnerSessions, parseMondayOwnerConfiguration, MONDAY_OWNER_COOKIE, MONDAY_OWNER_CSRF_HEADER, MONDAY_OWNER_LOGIN_COOKIE } from '../../src/office/backend/monday-owner';
import { createMondayOAuthService, parseMondayConfiguration, MondayOAuthError, MONDAY_OAUTH_CALLBACK, MONDAY_OAUTH_ORIGIN, MONDAY_TOKEN_URL, MONDAY_REVOKE_URL } from '../../src/office/backend/monday-oauth';
import { createMondayReadClient, MONDAY_READ_BOARD_IDS, MONDAY_READ_SCOPES } from '../../src/office/backend/monday-read';
import { MemoryMondayStore, MondayVault } from '../../src/office/backend/monday-store';
import { MONDAY_CALLBACK_PATH, MONDAY_OAUTH_NONCE_COOKIE } from '../../src/office/backend/monday-http';
import type { MondayRuntime } from '../../src/office/backend/monday-runtime';

const AT = Date.parse('2026-10-11T18:00:00.000Z');
// Fixed fictitious fixtures, never provisioned as credentials.
const ENV = {
  OFFICE_RUNTIME_MODE: 'staging', OFFICE_STAGING_ORIGIN: MONDAY_OAUTH_ORIGIN,
  OFFICE_STAGING_USERNAME: 'synthetic-shared-test', OFFICE_STAGING_PASSWORD: 'synthetic-shared-password-only-in-tests',
  OFFICE_STAGING_TRUSTED_PROXY_CIDRS: '127.0.0.1/32', OFFICE_STAGING_DB_HOST: 'office-db', OFFICE_STAGING_DB_PORT: '5432',
  OFFICE_STAGING_DB_USER: 'office_stage', OFFICE_STAGING_DB_NAME: 'gourmet_office_stage_demo', OFFICE_STAGING_DB_PASSWORD: 'synthetic-database-password-only-in-tests',
  MONDAY_OAUTH_ENABLED: 'true', MONDAY_CLIENT_ID: 'synthetic-client', MONDAY_CLIENT_SECRET: 'synthetic-client-secret',
  MONDAY_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 41).toString('base64'),
  MONDAY_EXPECTED_ACCOUNT_EMAIL: 'info@gourmet-corp.com', MONDAY_EXPECTED_USER_ID: '78158865', MONDAY_EXPECTED_ACCOUNT_ID: '29907909',
  MONDAY_OWNER_USERNAME: 'synthetic-owner-test', MONDAY_OWNER_PASSWORD: 'synthetic-owner-password-only-in-tests',
};
class DemoStore implements OfficeStore {
  state = createOfficeFixtureState(AT);
  transactions = 0;
  async snapshot() { return structuredClone(this.state); }
  async transact<T>(fn: (state: OfficeState) => T | Promise<T>) { this.transactions++; return fn(this.state); }
}
function cookie(response: { headers: Record<string, unknown> }, name: string) {
  const value = response.headers['set-cookie'];
  const values = Array.isArray(value) ? value : [value];
  const found = values.find(item => typeof item === 'string' && item.startsWith(`${name}=`));
  assert.equal(typeof found, 'string');
  return (found as string).split(';')[0];
}
function json(value: unknown) { return new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } }); }
async function fixture(t: TestContext, disabled = false, fault?: 'token_http' | 'token_scope' | 'identity' | 'boards') {
  let now = AT;
  const clock = () => now;
  const calls: Array<{ url: string; query?: string }> = [];
  const exchangedCodes: string[] = [];
  const exchangedVerifiers: string[] = [];
  const privateStore = new MemoryMondayStore();
  const vault = new MondayVault(Buffer.alloc(32, 41));
  const fetcher: typeof fetch = async (url, init) => {
    const target = String(url);
    const value = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ url: target, ...(typeof value.query === 'string' ? { query: value.query } : {}) });
    assert.equal(init?.redirect, 'error');
    if (target === MONDAY_REVOKE_URL) return json({ success: true });
    if (target === MONDAY_TOKEN_URL) {
      if (typeof value.code === 'string') exchangedCodes.push(value.code);
      if (typeof value.code_verifier === 'string') exchangedVerifiers.push(value.code_verifier);
      if (fault === 'token_http') return new Response(JSON.stringify({ error: 'synthetic-private-provider-error' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
      const access = `${Buffer.from('{"alg":"synthetic-only"}').toString('base64url')}.${Buffer.from(JSON.stringify({ exp: Math.floor(now / 1000) + 3600, tag: calls.length })).toString('base64url')}.c3ludGhldGlj`;
      return json({ access_token: access, refresh_token: `synthetic-refresh-${calls.length}`, token_type: 'Bearer', scope: fault === 'token_scope' ? 'boards:read updates:read me:read boards:write' : MONDAY_READ_SCOPES.join(' ') });
    }
    assert.equal(target, 'https://api.monday.com/v2');
    if (value.query === 'query OfficeMondayIdentity { me { id email } }') return json({ data: { me: { id: fault === 'identity' ? '78158866' : '78158865', email: 'info@gourmet-corp.com' } } });
    if (String(value.query).startsWith('query OfficeMondayBoardAccess(')) {
      assert.deepEqual(value.variables, { boardIds: [...MONDAY_READ_BOARD_IDS] });
      return json({ data: { boards: (fault === 'boards' ? MONDAY_READ_BOARD_IDS.slice(0, 4) : MONDAY_READ_BOARD_IDS).map(id => ({ id })) } });
    }
    assert.ok(String(value.query).startsWith('query OfficeMondayBoardRead(') || String(value.query).startsWith('query OfficeMondayUpdatesRead('));
    const variables = value.variables as { boardIds: string[] };
    return json({ data: { boards: [{ id: variables.boardIds[0], items_page: { cursor: null, items: [] } }] } });
  };
  const readClient = createMondayReadClient({ enabled: true, fetch: fetcher, clock, columnAllowlist: { [MONDAY_READ_BOARD_IDS[0]]: [{ id: 'stage', type: 'status', field: 'stage' }] } });
  const oauthService = createMondayOAuthService({ configuration: parseMondayConfiguration(ENV, MONDAY_OAUTH_ORIGIN), store: privateStore, vault, readClient, fetch: fetcher, clock });
  const monday: MondayRuntime = disabled
    ? { enabled: false, configured: false, ownerSessions: new MondayOwnerSessions() }
    : { enabled: true, configured: true, ownerSessions: new MondayOwnerSessions(parseMondayOwnerConfiguration(ENV), clock), oauthService };
  const staging = parseOfficeStagingEnvironment(ENV).access;
  const demo = new DemoStore();
  const api = createOfficeApi(demo, { staging, clock, monday });
  await api.ready(); t.after(() => api.close());
  const headers = { host: staging.host, 'x-forwarded-proto': 'https', origin: staging.origin, authorization: `Basic ${Buffer.from(`${ENV.OFFICE_STAGING_USERNAME}:${ENV.OFFICE_STAGING_PASSWORD}`).toString('base64')}` };
  const callbackHeaders = { host: staging.host, 'x-forwarded-proto': 'https' };
  const login = async () => {
    const challenge = await api.inject({ method: 'GET', url: '/office-api/monday/owner/login', headers });
    assert.equal(challenge.statusCode, 200);
    const response = await api.inject({ method: 'POST', url: '/office-api/monday/owner/login', headers: { ...headers, cookie: cookie(challenge, MONDAY_OWNER_LOGIN_COOKIE), [MONDAY_OWNER_CSRF_HEADER]: challenge.json().csrfToken }, payload: { username: ENV.MONDAY_OWNER_USERNAME, password: ENV.MONDAY_OWNER_PASSWORD } });
    assert.equal(response.statusCode, 200);
    const ownerCookie = cookie(response, MONDAY_OWNER_COOKIE);
    return { response, ownerCookie, ownerHeaders: { ...headers, cookie: ownerCookie, [MONDAY_OWNER_CSRF_HEADER]: response.json().csrfToken } };
  };
  const begin = async () => {
    const owner = await login();
    const response = await api.inject({ method: 'POST', url: '/office-api/monday/oauth/start', headers: owner.ownerHeaders, payload: {} });
    assert.equal(response.statusCode, 200);
    const url = new URL(response.json().authorizationUrl);
    const state = url.searchParams.get('state'); assert.ok(state);
    return { ...owner, response, url, state, nonceCookie: cookie(response, MONDAY_OAUTH_NONCE_COOKIE) };
  };
  const complete = async () => {
    const flow = await begin();
    const callback = await api.inject({ method: 'GET', url: `${MONDAY_CALLBACK_PATH}?state=${flow.state}&code=synthetic-code`, headers: { ...callbackHeaders, cookie: flow.nonceCookie } });
    assert.equal(callback.statusCode, 303); assert.equal(callback.headers.location, '/office/monday?oauth=complete');
    return { ...flow, callback };
  };
  return { api, headers, callbackHeaders, calls, exchangedCodes, exchangedVerifiers, demo, privateStore, vault, monday, login, begin, complete, setTime(value: number) { now = value; } };
}

test('callback parser contract accepts documented Monday returns with form encoding', async t => {
  for (const metadata of ['scope=boards%3Aread+updates%3Aread+me%3Aread', 'status=success', 'status=success&scope=boards%3Aread%20updates%3Aread%20me%3Aread']) {
    const f = await fixture(t); const flow = await f.begin();
    const result = await f.api.inject({ url: `${MONDAY_CALLBACK_PATH}?code=synthetic%2Bcode%2Fopaque%3D._-&%73tate=${flow.state}&${metadata}`, headers: { ...f.callbackHeaders, cookie: flow.nonceCookie } });
    assert.equal(result.headers.location, '/office/monday?oauth=complete');
    assert.deepEqual(f.exchangedCodes, ['synthetic+code/opaque=._-']);
    assert.equal((await f.api.inject({ url: '/office-api/monday/status', headers: flow.ownerHeaders })).json().pending, false);
  }
});

test('callback parser contract decodes query separators and percent escapes exactly once', async t => {
  for (const [encoded, expected] of [['synthetic%26opaque%3Dvalue', 'synthetic&opaque=value'], ['synthetic%252Bopaque', 'synthetic%2Bopaque']]) {
    const f = await fixture(t); const flow = await f.begin();
    const result = await f.api.inject({ url: `${MONDAY_CALLBACK_PATH}?state=${flow.state}&code=${encoded}&status=success`, headers: { ...f.callbackHeaders, cookie: flow.nonceCookie } });
    assert.equal(result.headers.location, '/office/monday?oauth=complete');
    assert.deepEqual(f.exchangedCodes, [expected]);
  }
});

test('callback parser contract discards unrecognized response metadata before validating the bound grant', async t => {
  for (const metadata of ['provider_metadata=SYNTHETIC_PRIVATE_METADATA', 'error_uri=https%3A%2F%2Fforeign.invalid%2Fprivate', 'provider_metadata=one&provider_metadata=two', 'state%5B%5D=forged&scope%5B%5D=boards%3Awrite&access_token=SYNTHETIC_PRIVATE_METADATA']) {
    const f = await fixture(t); const flow = await f.begin();
    const result = await f.api.inject({ url: `${MONDAY_CALLBACK_PATH}?state=${flow.state}&code=synthetic-code&status=success&${metadata}`, headers: { ...f.callbackHeaders, cookie: flow.nonceCookie } });
    assert.equal(result.headers.location, '/office/monday?oauth=complete');
    const status = (await f.api.inject({ url: '/office-api/monday/status', headers: flow.ownerHeaders })).json();
    assert.equal(status.state, 'connected'); assert.deepEqual(status.scopes, MONDAY_READ_SCOPES);
    assert.deepEqual(f.exchangedCodes, ['synthetic-code']);
    for (const output of [result.body, String(result.headers.location), JSON.stringify(status)]) assert.ok(!output.includes('SYNTHETIC_PRIVATE_METADATA') && !output.includes('foreign.invalid') && !output.includes('boards:write'));
  }
});

test('callback parser contract accepts standard error_uri without granting or reflecting it', async t => {
  const f = await fixture(t); const flow = await f.begin();
  const result = await f.api.inject({ url: `${MONDAY_CALLBACK_PATH}?state=${flow.state}&error=access_denied&error_uri=https%3A%2F%2Fforeign.invalid%2Fprivate`, headers: { ...f.callbackHeaders, cookie: flow.nonceCookie } });
  assert.equal(result.headers.location, '/office/monday?oauth=error&stage=provider_decision&reason=oauth_denied');
  assert.equal(f.calls.length, 0);
  assert.ok(!result.body.includes('foreign.invalid'));
  const status = (await f.api.inject({ url: '/office-api/monday/status', headers: flow.ownerHeaders })).json();
  assert.equal(status.pending, false); assert.equal(status.state, 'error'); assert.deepEqual(status.scopes, []);
});

test('callback parser contract distinguishes every retained query rejection without consuming state', async t => {
  const cases = [
    { suffix: '&state=other', reason: 'query_duplicate_state' },
    { suffix: '&%73tate=other', reason: 'query_duplicate_state' },
    { suffix: '&code=other', reason: 'query_duplicate_code' },
    { suffix: '&%63ode=other', reason: 'query_duplicate_code' },
    { suffix: '&error=one&error=two', reason: 'query_duplicate_error' },
    { suffix: '&status=one&status=two', reason: 'query_duplicate_status' },
    { suffix: '&error_description=one&error_description=two', reason: 'query_duplicate_description' },
    { suffix: '&scope=one&scope=two', reason: 'query_duplicate_scope' },
    { suffix: `&scope=${'s'.repeat(1025)}`, reason: 'query_scope_too_long' },
    { suffix: '&scope=%00', reason: 'query_scope_control' },
    { suffix: '&scope=%0A', reason: 'query_scope_control' },
    { suffix: '&scope=%7F', reason: 'query_scope_control' },
    { suffix: `&error_description=${'d'.repeat(1025)}`, reason: 'query_description_too_long' },
    { prefix: 'code=synthetic-code', reason: 'query_state_missing' },
    { prefix: 'state=&code=synthetic-code', reason: 'query_state_empty' },
    { prefix: 'State=other&code=synthetic-code', reason: 'query_state_missing' },
    { prefix: 'state%5B%5D=other&code=synthetic-code', reason: 'query_state_missing' },
    { prefix: '%2573tate=other&code=synthetic-code', reason: 'query_state_missing' },
  ];
  for (const scenario of cases) {
    const f = await fixture(t); const flow = await f.begin();
    const result = await f.api.inject({ url: `${MONDAY_CALLBACK_PATH}?${scenario.prefix ?? `state=${flow.state}&code=synthetic-code`}${scenario.suffix ?? ''}`, headers: { ...f.callbackHeaders, cookie: flow.nonceCookie } });
    assert.equal(result.headers.location, `/office/monday?oauth=error&stage=callback_query&reason=${scenario.reason}`);
    assert.equal(result.headers['set-cookie'], undefined); assert.equal(f.calls.length, 0);
    assert.equal((await f.api.inject({ url: '/office-api/monday/status', headers: flow.ownerHeaders })).json().pending, true);
    const legitimate = await f.api.inject({ url: `${MONDAY_CALLBACK_PATH}?state=${flow.state}&code=synthetic-code`, headers: { ...f.callbackHeaders, cookie: flow.nonceCookie } });
    assert.equal(legitimate.headers.location, '/office/monday?oauth=complete');
  }
});

test('callback parser contract never normalizes invalid state or code into a valid callback', async t => {
  for (const fields of [`state=malformed&code=synthetic-code`, `state=%20STATE%20&code=synthetic-code`, `state=STATE&code=synthetic+code`, `state=STATE&code=synthetic%0Acode`, `state=STATE&code=${'c'.repeat(4097)}`]) {
    const f = await fixture(t); const flow = await f.begin();
    const result = await f.api.inject({ url: `${MONDAY_CALLBACK_PATH}?${fields.replace('STATE', flow.state)}&provider_metadata=discarded`, headers: { ...f.callbackHeaders, cookie: flow.nonceCookie } });
    assert.equal(result.headers.location, '/office/monday?oauth=error&stage=callback_state&reason=oauth_state_invalid');
    assert.equal(result.headers['set-cookie'], undefined); assert.equal(f.calls.length, 0);
    assert.equal((await f.api.inject({ url: '/office-api/monday/status', headers: flow.ownerHeaders })).json().pending, true);
  }
});

test('callback parser contract discarded metadata cannot bypass nonce state expiry replay or token scopes', async t => {
  const f = await fixture(t); const flow = await f.begin();
  const url = `${MONDAY_CALLBACK_PATH}?state=${flow.state}&code=synthetic-code&access_token=SYNTHETIC_PRIVATE_METADATA&scope=boards%3Awrite`;
  const missingNonce = await f.api.inject({ url, headers: f.callbackHeaders });
  assert.equal(missingNonce.headers.location, '/office/monday?oauth=error&stage=callback_nonce&reason=oauth_state_invalid');
  const wrongState = await f.api.inject({ url: url.replace(flow.state, 'a'.repeat(43)), headers: { ...f.callbackHeaders, cookie: flow.nonceCookie } });
  assert.equal(wrongState.headers.location, '/office/monday?oauth=error&stage=callback_state&reason=oauth_state_invalid');
  assert.equal(f.calls.length, 0);
  f.setTime(AT + 300_000);
  const expired = await f.api.inject({ url, headers: { ...f.callbackHeaders, cookie: flow.nonceCookie } });
  assert.equal(expired.headers.location, '/office/monday?oauth=error&stage=callback_state&reason=oauth_state_expired');
  assert.equal(f.calls.length, 0);
  const fresh = await f.begin();
  const freshUrl = `${MONDAY_CALLBACK_PATH}?state=${fresh.state}&code=synthetic-code&provider_metadata=discarded`;
  assert.equal((await f.api.inject({ url: freshUrl, headers: { ...f.callbackHeaders, cookie: fresh.nonceCookie } })).headers.location, '/office/monday?oauth=complete');
  assert.equal((await f.api.inject({ url: freshUrl, headers: { ...f.callbackHeaders, cookie: fresh.nonceCookie } })).headers.location, '/office/monday?oauth=error&stage=callback_state&reason=oauth_state_invalid');
  assert.equal(f.exchangedCodes.length, 1);
  const extraScope = await fixture(t, false, 'token_scope'); const second = await extraScope.begin();
  const rejected = await extraScope.api.inject({ url: `${MONDAY_CALLBACK_PATH}?state=${second.state}&code=synthetic-code&scope=boards%3Aread+updates%3Aread+me%3Aread&metadata=discarded`, headers: { ...extraScope.callbackHeaders, cookie: second.nonceCookie } });
  assert.equal(rejected.headers.location, '/office/monday?oauth=error&stage=token_response&reason=scope_mismatch');
  assert.equal(extraScope.exchangedCodes.length, 1);
  const status = (await extraScope.api.inject({ url: '/office-api/monday/status', headers: second.ownerHeaders })).json();
  assert.equal(status.state, 'error'); assert.deepEqual(status.scopes, []);
});

test('callback parser contract rejects a malformed stored PKCE verifier and ignores a forged query verifier', async t => {
  const f = await fixture(t); const flow = await f.begin();
  const key = `monday-oauth-state-${createHash('sha256').update(flow.state).digest('base64url')}`;
  const original = await f.privateStore.read(key); assert.ok(original);
  const authorization = f.vault.open(original.value, key) as Record<string, unknown>;
  assert.equal(await f.privateStore.compareAndSet(key, original.revision, f.vault.seal({ ...authorization, verifier: 'weak' }, key)), true);
  const url = `${MONDAY_CALLBACK_PATH}?state=${flow.state}&code=synthetic-code&code_verifier=forged&code_challenge_method=plain`;
  const rejected = await f.api.inject({ url, headers: { ...f.callbackHeaders, cookie: flow.nonceCookie } });
  assert.equal(rejected.headers.location, '/office/monday?oauth=error&stage=callback_state&reason=oauth_state_invalid');
  assert.equal(rejected.headers['set-cookie'], undefined); assert.equal(f.calls.length, 0);
  const retained = await f.privateStore.read(key); assert.ok(retained);
  assert.equal(await f.privateStore.compareAndSet(key, retained.revision, original.value), true);
  const valid = await f.api.inject({ url, headers: { ...f.callbackHeaders, cookie: flow.nonceCookie } });
  assert.equal(valid.headers.location, '/office/monday?oauth=complete');
  assert.equal(f.exchangedVerifiers.length, 1); assert.match(f.exchangedVerifiers[0], /^[A-Za-z0-9_-]{43}$/);
  assert.equal(createHash('sha256').update(f.exchangedVerifiers[0]).digest('base64url'), flow.url.searchParams.get('code_challenge'));
  assert.equal(flow.url.searchParams.get('code_challenge_method'), 'S256');
});

test('disabled Monday serves DEMO and never exposes an OAuth Basic Auth exception', async t => {
  const f = await fixture(t, true);
  const status = await f.api.inject({ url: '/office-api/monday/owner/session', headers: f.headers });
  assert.deepEqual(status.json(), { available: false, authenticated: false });
  assert.equal((await f.api.inject({ url: MONDAY_CALLBACK_PATH, headers: f.callbackHeaders })).statusCode, 401);
  assert.equal((await f.api.inject({ url: '/office-api/health', headers: f.headers })).json().status, 'ok');
  assert.equal((await f.api.inject({ method: 'POST', url: '/office-api/monday/oauth/start', headers: f.headers, payload: {} })).statusCode, 503);
  assert.equal(f.calls.length, 0);
});
test('shared Basic Auth and a DEMO viewer session do not grant any private Monday access', async t => {
  const f = await fixture(t);
  const viewer = await f.api.inject({ method: 'POST', url: '/office-api/session', headers: f.headers, payload: { role: 'viewer' } });
  assert.equal(viewer.statusCode, 200);
  const headers = { ...f.headers, cookie: String(viewer.headers['set-cookie']).split(';')[0] };
  assert.deepEqual((await f.api.inject({ url: '/office-api/monday/owner/session', headers })).json(), { available: true, authenticated: false });
  assert.equal((await f.api.inject({ url: '/office-api/monday/status', headers })).statusCode, 403);
  for (const path of ['oauth/start', 'refresh', 'disconnect', 'read-board', 'read-updates']) {
    const response = await f.api.inject({ method: 'POST', url: `/office-api/monday/${path}`, headers, payload: { boardId: MONDAY_READ_BOARD_IDS[0] } });
    assert.equal(response.statusCode, 403); assert.equal(response.headers['www-authenticate'], undefined);
    assert.deepEqual(response.json(), { error: 'MONDAY_OWNER_UNAUTHORIZED' });
  }
  assert.equal(f.calls.length, 0);
});
test('owner challenge, login and session JSON never serialize HttpOnly cookie credentials', async t => {
  const f = await fixture(t); const owner = await f.login();
  const header = String(owner.response.headers['set-cookie']);
  assert.match(header, /HttpOnly/); assert.match(header, /Secure/); assert.match(header, /SameSite=Strict/); assert.match(header, /Path=\/office-api\/monday/);
  assert.deepEqual(Object.keys(owner.response.json()).sort(), ['csrfToken', 'expiresAt', 'principal']);
  assert.ok(!owner.response.body.includes(owner.ownerCookie.split('=')[1]));
  assert.ok(!owner.response.body.includes(ENV.MONDAY_OWNER_PASSWORD));
  const session = await f.api.inject({ url: '/office-api/monday/owner/session', headers: owner.ownerHeaders });
  assert.equal(session.json().authenticated, true); assert.equal(session.json().csrfToken, owner.response.json().csrfToken);
  assert.equal(f.calls.length, 0);
});
test('owner login requires a challenge and matching CSRF, consuming a bad credential attempt', async t => {
  const f = await fixture(t);
  const payload = { username: ENV.MONDAY_OWNER_USERNAME, password: ENV.MONDAY_OWNER_PASSWORD };
  assert.equal((await f.api.inject({ method: 'POST', url: '/office-api/monday/owner/login', headers: f.headers, payload })).statusCode, 403);
  const challenge = await f.api.inject({ url: '/office-api/monday/owner/login', headers: f.headers });
  const headers = { ...f.headers, cookie: cookie(challenge, MONDAY_OWNER_LOGIN_COOKIE) };
  assert.equal((await f.api.inject({ method: 'POST', url: '/office-api/monday/owner/login', headers, payload })).statusCode, 403);
  const csrfHeaders = { ...headers, [MONDAY_OWNER_CSRF_HEADER]: challenge.json().csrfToken };
  const bad = await f.api.inject({ method: 'POST', url: '/office-api/monday/owner/login', headers: csrfHeaders, payload: { ...payload, password: 'synthetic-invalid-password-for-tests' } });
  assert.equal(bad.statusCode, 403); assert.deepEqual(bad.json(), { error: 'MONDAY_OWNER_UNAUTHORIZED' });
  assert.equal(bad.headers['www-authenticate'], undefined);
  assert.equal((await f.api.inject({ method: 'POST', url: '/office-api/monday/owner/login', headers: csrfHeaders, payload })).statusCode, 403);
  assert.deepEqual((await f.api.inject({ url: '/office-api/monday/owner/session', headers: f.headers })).json(), { available: true, authenticated: false });
  const fresh = await f.api.inject({ url: '/office-api/monday/owner/login', headers: f.headers });
  assert.equal(fresh.statusCode, 200); assert.notEqual(fresh.json().csrfToken, challenge.json().csrfToken);
  const freshHeaders = { ...f.headers, cookie: cookie(fresh, MONDAY_OWNER_LOGIN_COOKIE), [MONDAY_OWNER_CSRF_HEADER]: fresh.json().csrfToken };
  const invalidBasic = await f.api.inject({ method: 'POST', url: '/office-api/monday/owner/login', headers: { ...freshHeaders, authorization: 'Basic ???' }, payload });
  assert.equal(invalidBasic.statusCode, 401); assert.match(String(invalidBasic.headers['www-authenticate']), /^Basic /);
  assert.deepEqual(invalidBasic.json(), { error: 'STAGING_AUTHENTICATION_REQUIRED' });
  assert.equal((await f.api.inject({ method: 'POST', url: '/office-api/monday/owner/login', headers: freshHeaders, payload })).statusCode, 200);
  assert.equal(f.calls.length, 0);
});
test('expired owner credentials return a cookie error without a browser Basic challenge', async t => {
  const f = await fixture(t); const owner = await f.login();
  f.setTime(AT + 15 * 60_000);
  const response = await f.api.inject({ url: '/office-api/monday/status', headers: owner.ownerHeaders });
  assert.equal(response.statusCode, 403); assert.equal(response.headers['www-authenticate'], undefined);
  assert.deepEqual(response.json(), { error: 'MONDAY_OWNER_UNAUTHORIZED' });
  assert.deepEqual((await f.api.inject({ url: '/office-api/monday/owner/session', headers: owner.ownerHeaders })).json(), { available: true, authenticated: false });
  assert.equal((await f.api.inject({ url: '/office-api/monday/owner/login', headers: f.headers })).statusCode, 200);
  assert.equal(f.calls.length, 0);
});
test('every owner operation including reads requires CSRF and a same-origin JSON POST', async t => {
  const f = await fixture(t); const owner = await f.login();
  const noCsrf = { ...f.headers, cookie: owner.ownerCookie };
  for (const path of ['oauth/start', 'refresh', 'disconnect', 'read-board', 'read-updates', 'owner/logout']) assert.equal((await f.api.inject({ method: 'POST', url: `/office-api/monday/${path}`, headers: noCsrf, payload: {} })).statusCode, 403);
  assert.equal((await f.api.inject({ method: 'POST', url: '/office-api/monday/oauth/start', headers: { ...owner.ownerHeaders, origin: 'https://foreign.invalid' }, payload: {} })).statusCode, 403);
  const missingOrigin = { ...owner.ownerHeaders }; delete (missingOrigin as { origin?: string }).origin;
  assert.equal((await f.api.inject({ method: 'POST', url: '/office-api/monday/oauth/start', headers: missingOrigin, payload: {} })).statusCode, 403);
  assert.equal((await f.api.inject({ method: 'POST', url: '/office-api/monday/oauth/start', headers: { ...owner.ownerHeaders, 'content-type': 'text/plain' }, payload: '{}' })).statusCode, 415);
  assert.equal(f.calls.length, 0);
});
test('the exact HTTPS callback completes without shared Basic or owner cookies, using PKCE and browser nonce', async t => {
  const f = await fixture(t); const flow = await f.complete();
  assert.equal(flow.url.searchParams.get('redirect_uri'), MONDAY_OAUTH_CALLBACK);
  assert.equal(flow.url.searchParams.get('scope'), MONDAY_READ_SCOPES.join(' '));
  assert.equal(flow.url.searchParams.get('code_challenge_method'), 'S256');
  assert.match(String(flow.response.headers['set-cookie']), /HttpOnly; Secure; SameSite=Lax; Max-Age=300/);
  assert.match(String(flow.callback.headers['set-cookie']), /Max-Age=0/);
  const status = (await f.api.inject({ url: '/office-api/monday/status', headers: flow.ownerHeaders })).json();
  assert.equal(status.state, 'connected'); assert.equal(status.actorId, '78158865'); assert.equal(status.accountId, null);
  assert.equal(status.accountVerified, false); assert.equal(status.configuredAccountId, '29907909'); assert.equal(status.boardAccessVerified, true);
  assert.deepEqual(status.allowedBoards, MONDAY_READ_BOARD_IDS);
  assert.equal(f.calls.length, 3);
  const stored = await f.privateStore.read('monday-connection-ricardo'); assert.ok(stored);
  assert.ok(!JSON.stringify(stored).includes('synthetic-refresh-')); assert.ok(!JSON.stringify(stored).includes('info@gourmet-corp.com'));
  for (const value of [flow.response.body, flow.callback.body, JSON.stringify(status)]) {
    assert.ok(!value.includes('synthetic-client-secret')); assert.ok(!value.includes('synthetic-refresh-')); assert.ok(!value.includes('synthetic-code'));
  }
});
test('owner cannot read excluded Deals records or update metadata after five-board OAuth access succeeds', async t => {
  const f = await fixture(t); const flow = await f.complete();
  const before = (await f.api.inject({ url: '/office-api/monday/status', headers: flow.ownerHeaders })).json();
  assert.equal(before.state, 'connected'); assert.equal(before.boardAccessVerified, true);
  assert.deepEqual(before.allowedBoards, MONDAY_READ_BOARD_IDS);
  const calls = f.calls.length;
  for (const path of ['read-board', 'read-updates']) {
    const response = await f.api.inject({ method: 'POST', url: `/office-api/monday/${path}`, headers: flow.ownerHeaders, payload: { boardId: '18411103560' } });
    assert.equal(response.statusCode, 403); assert.deepEqual(response.json(), { error: 'FORBIDDEN_MONDAY_BOARD' });
  }
  assert.equal(f.calls.length, calls);
  const after = (await f.api.inject({ url: '/office-api/monday/status', headers: flow.ownerHeaders })).json();
  assert.deepEqual(after, before);
});
test('callback exception is exact GET only; HEAD, sibling, trailing and encoded paths retain Basic', async t => {
  const f = await fixture(t);
  for (const [method, path] of [['HEAD', MONDAY_CALLBACK_PATH], ['GET', `${MONDAY_CALLBACK_PATH}/`], ['GET', `${MONDAY_CALLBACK_PATH}-other`], ['GET', '/office-api/monday/status'], ['GET', '/office-api/monday/oauth/%63allback']] as const) assert.equal((await f.api.inject({ method, url: path, headers: f.callbackHeaders })).statusCode, 401);
  assert.equal((await f.api.inject({ method: 'POST', url: MONDAY_CALLBACK_PATH, headers: f.callbackHeaders, payload: {} })).statusCode, 401);
  assert.equal(f.calls.length, 0);
});
test('callback still rejects spoofed host, plaintext forwarding, alternate Forwarded and untrusted socket peer', async t => {
  const f = await fixture(t); const flow = await f.begin();
  const url = `${MONDAY_CALLBACK_PATH}?state=${flow.state}&code=synthetic-code`;
  const headers = { ...f.callbackHeaders, cookie: flow.nonceCookie };
  for (const change of [{ host: 'foreign.invalid' }, { 'x-forwarded-host': 'foreign.invalid' }, { 'x-forwarded-proto': 'http' }, { forwarded: 'proto=https' }, { origin: 'https://foreign.invalid' }]) assert.equal((await f.api.inject({ url, headers: { ...headers, ...change } })).statusCode, 403);
  assert.equal((await f.api.inject({ url, headers, remoteAddress: '198.51.100.9' })).statusCode, 403);
  assert.equal(f.calls.length, 0);
});
test('missing, wrong or duplicated callback nonce cannot exchange or consume legitimate state', async t => {
  const f = await fixture(t); const flow = await f.begin();
  const url = `${MONDAY_CALLBACK_PATH}?state=${flow.state}&code=synthetic-code`;
  for (const value of [undefined, `${MONDAY_OAUTH_NONCE_COOKIE}=${'a'.repeat(43)}`, `${flow.nonceCookie}; ${flow.nonceCookie}`]) {
    const result = await f.api.inject({ url, headers: { ...f.callbackHeaders, ...(value ? { cookie: value } : {}) } });
    assert.equal(result.statusCode, 303); assert.equal(result.headers.location, `/office/monday?oauth=error&stage=${value === `${MONDAY_OAUTH_NONCE_COOKIE}=${'a'.repeat(43)}` ? 'callback_state' : 'callback_nonce'}&reason=oauth_state_invalid`);
    assert.equal(result.headers['set-cookie'], undefined);
  }
  assert.equal(f.calls.length, 0);
  const legitimate = await f.api.inject({ url, headers: { ...f.callbackHeaders, cookie: flow.nonceCookie } });
  assert.equal(legitimate.headers.location, '/office/monday?oauth=complete');
});
test('an unbound callback rejection preserves the browser nonce for a legitimate return', async t => {
  const f = await fixture(t); const flow = await f.begin();
  const browserCookies = new Map<string, string>();
  const applySetCookie = (response: { headers: Record<string, unknown> }) => {
    const header = response.headers['set-cookie'];
    for (const value of Array.isArray(header) ? header : [header]) {
      if (typeof value !== 'string') continue;
      const [pair, ...attributes] = value.split(';');
      const separator = pair.indexOf('=');
      const name = pair.slice(0, separator);
      if (attributes.some(attribute => /^Max-Age=0$/iu.test(attribute.trim()))) browserCookies.delete(name);
      else browserCookies.set(name, pair.slice(separator + 1));
    }
  };
  const callbackCookies = () => [...browserCookies].map(([name, value]) => `${name}=${value}`).join('; ');
  applySetCookie(flow.response);
  const rejected = await f.api.inject({
    url: `${MONDAY_CALLBACK_PATH}?state=${flow.state}&code=synthetic-code&%73tate=synthetic-field`,
    headers: { ...f.callbackHeaders, cookie: callbackCookies() },
  });
  applySetCookie(rejected);
  assert.equal(rejected.headers.location, '/office/monday?oauth=error&stage=callback_query&reason=query_duplicate_state');
  const pending = await f.api.inject({ url: '/office-api/monday/status', headers: flow.ownerHeaders });
  assert.equal(pending.json().pending, true);
  assert.equal(f.calls.length, 0);
  const legitimate = await f.api.inject({
    url: `${MONDAY_CALLBACK_PATH}?state=${flow.state}&code=synthetic-code`,
    headers: { ...f.callbackHeaders, cookie: callbackCookies() },
  });
  assert.equal(legitimate.headers.location, '/office/monday?oauth=complete');
  applySetCookie(legitimate);
  assert.equal(browserCookies.has(MONDAY_OAUTH_NONCE_COOKIE), false);
  const completed = await f.api.inject({ url: '/office-api/monday/status', headers: flow.ownerHeaders });
  assert.equal(completed.json().pending, false);
  assert.equal(f.calls.filter(call => call.url === MONDAY_TOKEN_URL).length, 1);
});
test('documented optional callback scope is ignored in favor of verified token scopes', async t => {
  for (const scope of [MONDAY_READ_SCOPES.join(' '), 'boards:write arbitrary-provider-metadata', '', 's'.repeat(1024)]) {
    const f = await fixture(t); const flow = await f.begin();
    const query = new URLSearchParams({ state: flow.state, code: 'synthetic-code', scope });
    const result = await f.api.inject({ url: `${MONDAY_CALLBACK_PATH}?${query}`, headers: { ...f.callbackHeaders, cookie: flow.nonceCookie } });
    assert.equal(result.headers.location, '/office/monday?oauth=complete');
    const status = await f.api.inject({ url: '/office-api/monday/status', headers: flow.ownerHeaders });
    assert.deepEqual(status.json().scopes, MONDAY_READ_SCOPES);
    assert.equal(status.json().pending, false);
    assert.equal(f.calls.filter(call => call.url === MONDAY_TOKEN_URL).length, 1);
  }
});
test('duplicate or overlong callback scope rejects without consuming legitimate state', async t => {
  for (const [scopeQuery, reason] of [['scope=boards%3Aread&scope=me%3Aread', 'query_duplicate_scope'], [`scope=${'s'.repeat(1025)}`, 'query_scope_too_long']]) {
    const f = await fixture(t); const flow = await f.begin();
    const result = await f.api.inject({ url: `${MONDAY_CALLBACK_PATH}?state=${flow.state}&code=synthetic-code&${scopeQuery}`, headers: { ...f.callbackHeaders, cookie: flow.nonceCookie } });
    assert.equal(result.headers.location, `/office/monday?oauth=error&stage=callback_query&reason=${reason}`);
    assert.equal(result.headers['set-cookie'], undefined);
    assert.equal(f.calls.length, 0);
    const status = await f.api.inject({ url: '/office-api/monday/status', headers: flow.ownerHeaders });
    assert.equal(status.json().pending, true);
    const legitimate = await f.api.inject({ url: `${MONDAY_CALLBACK_PATH}?state=${flow.state}&code=synthetic-code`, headers: { ...f.callbackHeaders, cookie: flow.nonceCookie } });
    assert.equal(legitimate.headers.location, '/office/monday?oauth=complete');
  }
});
test('callback scope control characters are rejected without consuming legitimate state', async t => {
  for (const scopeQuery of ['scope=%0A', 'scope=%00', 'scope=%7F']) {
    const f = await fixture(t); const flow = await f.begin();
    const result = await f.api.inject({ url: `${MONDAY_CALLBACK_PATH}?state=${flow.state}&code=synthetic-code&${scopeQuery}`, headers: { ...f.callbackHeaders, cookie: flow.nonceCookie } });
    assert.equal(result.headers.location, '/office/monday?oauth=error&stage=callback_query&reason=query_scope_control');
    assert.equal(result.headers['set-cookie'], undefined);
    assert.equal(f.calls.length, 0);
    const status = await f.api.inject({ url: '/office-api/monday/status', headers: flow.ownerHeaders });
    assert.equal(status.json().pending, true);
    const legitimate = await f.api.inject({ url: `${MONDAY_CALLBACK_PATH}?state=${flow.state}&code=synthetic-code`, headers: { ...f.callbackHeaders, cookie: flow.nonceCookie } });
    assert.equal(legitimate.headers.location, '/office/monday?oauth=complete');
  }
});
test('pending authorization permits a new attempt only after lease expiry without provider calls', async t => {
  const f = await fixture(t); const flow = await f.begin();
  f.setTime(AT + 299_999);
  const pending = await f.api.inject({ url: '/office-api/monday/status', headers: flow.ownerHeaders });
  assert.equal(pending.json().pending, true);
  const blocked = await f.api.inject({ method: 'POST', url: '/office-api/monday/oauth/start', headers: flow.ownerHeaders, payload: {} });
  assert.equal(blocked.statusCode, 409);
  assert.equal(f.calls.length, 0);
  f.setTime(AT + 300_000);
  const expired = await f.api.inject({ url: '/office-api/monday/status', headers: flow.ownerHeaders });
  assert.equal(expired.json().pending, false);
  assert.equal(expired.json().code, 'oauth_state_expired');
  assert.equal(f.calls.length, 0);
  const fresh = await f.api.inject({ method: 'POST', url: '/office-api/monday/oauth/start', headers: flow.ownerHeaders, payload: {} });
  assert.equal(fresh.statusCode, 200);
  assert.notEqual(new URL(fresh.json().authorizationUrl).searchParams.get('state'), flow.state);
  const restarted = await f.api.inject({ url: '/office-api/monday/status', headers: flow.ownerHeaders });
  assert.equal(restarted.json().pending, true);
  assert.equal(restarted.json().code, null);
  assert.equal(f.calls.length, 0);
});
test('replaying a completed callback fails without a second code exchange', async t => {
  const f = await fixture(t); const flow = await f.complete();
  const replay = await f.api.inject({ url: `${MONDAY_CALLBACK_PATH}?state=${flow.state}&code=synthetic-code`, headers: { ...f.callbackHeaders, cookie: flow.nonceCookie } });
  assert.equal(replay.headers.location, '/office/monday?oauth=error&stage=callback_state&reason=oauth_state_invalid');
  assert.equal(f.calls.filter(call => call.url === MONDAY_TOKEN_URL).length, 1);
});
test('callback duplicate or missing state rejects without reflecting sensitive metadata', async t => {
  const f = await fixture(t); const flow = await f.begin();
  for (const [query, reason] of [[`state=${flow.state}&state=${flow.state}&code=synthetic-code`, 'query_duplicate_state'], ['code=synthetic-code&access_token=synthetic-sensitive', 'query_state_missing'], ['code=synthetic-sensitive', 'query_state_missing']]) {
    const result = await f.api.inject({ url: `${MONDAY_CALLBACK_PATH}?${query}`, headers: { ...f.callbackHeaders, cookie: flow.nonceCookie } });
    assert.equal(result.headers.location, `/office/monday?oauth=error&stage=callback_query&reason=${reason}`); assert.ok(!result.body.includes('synthetic-sensitive'));
    assert.equal(result.headers['set-cookie'], undefined);
  }
  assert.equal(f.calls.length, 0);
});
test('provider refusal and expired state return a fixed error redirect without token requests', async t => {
  const f = await fixture(t); const flow = await f.begin();
  const refused = await f.api.inject({ url: `${MONDAY_CALLBACK_PATH}?state=${flow.state}&error=access_denied&error_description=synthetic-private-message`, headers: { ...f.callbackHeaders, cookie: flow.nonceCookie } });
  assert.equal(refused.headers.location, '/office/monday?oauth=error&stage=provider_decision&reason=oauth_denied'); assert.ok(!refused.body.includes('synthetic-private-message'));
  assert.equal(cookie(refused, MONDAY_OAUTH_NONCE_COOKIE), `${MONDAY_OAUTH_NONCE_COOKIE}=`);
  assert.match(String(refused.headers['set-cookie']), /Max-Age=0/u);
  const refusedStatus = await f.api.inject({ url: '/office-api/monday/status', headers: flow.ownerHeaders });
  assert.equal(refusedStatus.json().pending, false);
  assert.equal(refusedStatus.json().code, 'oauth_denied');
  const second = await f.begin(); f.setTime(AT + 300_000);
  const expired = await f.api.inject({ url: `${MONDAY_CALLBACK_PATH}?state=${second.state}&code=synthetic-code`, headers: { ...f.callbackHeaders, cookie: second.nonceCookie } });
  assert.equal(expired.headers.location, '/office/monday?oauth=error&stage=callback_state&reason=oauth_state_expired'); assert.equal(f.calls.length, 0);
});
test('owner reads accept only allowlisted board IDs and return provenance outside DEMO transactions', async t => {
  const f = await fixture(t); const flow = await f.complete();
  assert.equal((await f.api.inject({ method: 'POST', url: '/office-api/monday/read-board', headers: flow.ownerHeaders, payload: { boardId: '999999' } })).statusCode, 403);
  assert.equal((await f.api.inject({ method: 'POST', url: '/office-api/monday/read-board', headers: flow.ownerHeaders, payload: { boardId: MONDAY_READ_BOARD_IDS[0], query: 'query { users { email } }' } })).statusCode, 400);
  const read = await f.api.inject({ method: 'POST', url: '/office-api/monday/read-board', headers: flow.ownerHeaders, payload: { boardId: MONDAY_READ_BOARD_IDS[0] } });
  assert.equal(read.statusCode, 200); assert.equal(read.json().status, 'complete'); assert.equal(read.json().boardId, MONDAY_READ_BOARD_IDS[0]); assert.equal(read.json().readAt, new Date(AT).toISOString());
  assert.equal(f.demo.transactions, 0);
  assert.ok(!JSON.stringify(await f.demo.snapshot()).includes('synthetic-refresh-'));
});
test('logout revokes the owner session and clears the callback nonce; viewer still cannot read a connected grant', async t => {
  const f = await fixture(t); const flow = await f.complete();
  const logout = await f.api.inject({ method: 'POST', url: '/office-api/monday/owner/logout', headers: flow.ownerHeaders, payload: {} });
  assert.equal(logout.statusCode, 204); assert.match(String(logout.headers['set-cookie']), /Max-Age=0/);
  assert.equal((await f.api.inject({ url: '/office-api/monday/status', headers: flow.ownerHeaders })).statusCode, 403);
  assert.equal((await f.api.inject({ method: 'POST', url: '/office-api/monday/read-updates', headers: f.headers, payload: { boardId: MONDAY_READ_BOARD_IDS[0] } })).statusCode, 403);
  assert.equal(f.calls.length, 3);
});
test('dependency failures return a safe HTTP code without reflecting error details', async t => {
  const f = await fixture(t); const owner = await f.login();
  f.monday.oauthService!.status = async () => { throw new Error('synthetic-private-database-token-message'); };
  const result = await f.api.inject({ url: '/office-api/monday/status', headers: owner.ownerHeaders });
  assert.equal(result.statusCode, 503); assert.deepEqual(result.json(), { error: 'OFFICE_STORAGE_UNAVAILABLE' });
});

test('callback diagnostic separates query, browser nonce and bound state failures without reflecting input', async t => {
  const f = await fixture(t); const flow = await f.begin();
  const cases = [
    { url: `${MONDAY_CALLBACK_PATH}?code=synthetic-private-code`, headers: f.callbackHeaders, stage: 'callback_query', reason: 'query_state_missing' },
    { url: `${MONDAY_CALLBACK_PATH}?state=${flow.state}&code=synthetic-private-code`, headers: f.callbackHeaders, stage: 'callback_nonce', reason: 'oauth_state_invalid' },
    { url: `${MONDAY_CALLBACK_PATH}?state=${'a'.repeat(43)}&code=synthetic-private-code`, headers: { ...f.callbackHeaders, cookie: flow.nonceCookie }, stage: 'callback_state', reason: 'oauth_state_invalid' },
  ];
  for (const scenario of cases) {
    const response = await f.api.inject(scenario);
    assert.equal(response.statusCode, 303);
    assert.equal(response.headers.location, `/office/monday?oauth=error&stage=${scenario.stage}&reason=${scenario.reason}`);
    assert.equal(response.headers['set-cookie'], undefined);
    for (const secret of [flow.state, flow.nonceCookie, 'synthetic-private-code']) {
      assert.ok(!String(response.headers.location).includes(secret)); assert.ok(!response.body.includes(secret));
    }
  }
  assert.equal(f.calls.length, 0);
  assert.equal((await f.api.inject({ url: '/office-api/monday/status', headers: flow.ownerHeaders })).json().pending, true);
});

test('callback diagnostic reflects only closed internal stages and known error codes', async t => {
  const f = await fixture(t); const flow = await f.begin();
  // The observer is internal metadata; provider and exception contents never
  // become return parameters, even if a dependency offers arbitrary strings.
  for (const known of [true, false]) {
    f.monday.oauthService!.callback = async (_params, _nonce, onStage) => {
      onStage?.('token_exchange');
      onStage?.('synthetic-private-stage' as never);
      if (known) throw new MondayOAuthError('token_invalid', 502);
      throw new Error('synthetic-private-error-token-url');
    };
    const response = await f.api.inject({ url: `${MONDAY_CALLBACK_PATH}?state=${flow.state}&code=synthetic-private-code`, headers: { ...f.callbackHeaders, cookie: flow.nonceCookie } });
    assert.equal(response.headers.location, `/office/monday?oauth=error&stage=token_exchange&reason=${known ? 'token_invalid' : 'callback_failed'}`);
    assert.equal(response.headers['set-cookie'], undefined);
    assert.ok(!response.body.includes('synthetic-private'));
  }
  assert.equal(f.calls.length, 0);
});

test('callback diagnostic carries verified failure phases through HTTP while never granting reads', async t => {
  const cases = [
    { fault: 'token_http', stage: 'token_exchange', reason: 'token_invalid', calls: 1 },
    { fault: 'token_scope', stage: 'token_response', reason: 'scope_mismatch', calls: 1 },
    { fault: 'identity', stage: 'identity_check', reason: 'identity_mismatch', calls: 2 },
    { fault: 'boards', stage: 'board_access_check', reason: 'board_access_unverified', calls: 3 },
  ] as const;
  for (const scenario of cases) {
    const f = await fixture(t, false, scenario.fault); const flow = await f.begin();
    const response = await f.api.inject({ url: `${MONDAY_CALLBACK_PATH}?state=${flow.state}&code=synthetic-private-code&scope=boards%3Aread`, headers: { ...f.callbackHeaders, cookie: flow.nonceCookie } });
    assert.equal(response.statusCode, 303);
    assert.equal(response.headers.location, `/office/monday?oauth=error&stage=${scenario.stage}&reason=${scenario.reason}`);
    assert.match(String(response.headers['set-cookie']), /Max-Age=0/u);
    const status = (await f.api.inject({ url: '/office-api/monday/status', headers: flow.ownerHeaders })).json();
    assert.equal(status.pending, false); assert.equal(status.state, 'error'); assert.equal(status.code, scenario.reason);
    assert.equal(status.actorId, null); assert.equal(status.boardAccessVerified, false); assert.deepEqual(status.scopes, []);
    assert.equal(f.calls.length, scenario.calls);
    assert.equal(f.calls.filter(call => call.url === MONDAY_TOKEN_URL).length, 1);
    const read = await f.api.inject({ method: 'POST', url: '/office-api/monday/read-board', headers: flow.ownerHeaders, payload: { boardId: MONDAY_READ_BOARD_IDS[0] } });
    assert.equal(read.statusCode, 409); assert.equal(read.json().error, 'not_connected');
    assert.equal(f.calls.length, scenario.calls);
    for (const value of [String(response.headers.location), response.body, JSON.stringify(status)]) {
      for (const privateValue of [flow.state, flow.nonceCookie, 'synthetic-private-code', 'synthetic-private-provider-error', 'synthetic-refresh-', 'synthetic-client-secret', 'boards:write']) assert.ok(!value.includes(privateValue));
    }
  }
});
