import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseOfficeStagingEnvironment } from '../../src/office/backend/staging';
import { createStagingOfficeApp } from '../../src/office/backend/staging-app';
import { createOfficeFixtureState } from '../../src/office/backend/fixtures';
import { DEFAULT_OFFICE_DATABASE_URL, PostgresOfficeStore, STAGING_OFFICE_STATE_ID, validateStagingDatabaseOptions } from '../../src/office/backend/postgres-store';
import { OfficeError, canonical } from '../../src/office/backend/state';
import type { OfficeState, OfficeStore } from '../../src/office/backend/state';

const AT = Date.parse('2026-10-10T21:00:00.000Z');
// Deliberately fictitious credentials for isolated tests; never provisioned.
function testEnvironment(extra: Record<string, string | undefined> = {}) {
  return {
    OFFICE_RUNTIME_MODE: 'staging',
    OFFICE_STAGING_ORIGIN: 'https://office.example.test',
    OFFICE_STAGING_USERNAME: 'synthetic-test-user',
    OFFICE_STAGING_PASSWORD: 'synthetic-auth-password-for-unit-tests-only',
    OFFICE_STAGING_TRUSTED_PROXY_CIDRS: '127.0.0.1/32,172.31.240.0/24',
    OFFICE_STAGING_DB_HOST: 'office-db',
    OFFICE_STAGING_DB_PORT: '5432',
    OFFICE_STAGING_DB_USER: 'office_stage',
    OFFICE_STAGING_DB_NAME: 'gourmet_office_stage_demo',
    OFFICE_STAGING_DB_PASSWORD: 'synthetic-database-password-for-unit-tests-only',
    ...extra,
  };
}
class SyntheticStore implements OfficeStore {
  state = createOfficeFixtureState(AT);
  transactions = 0;
  reads = 0;
  async snapshot() { this.reads++; return structuredClone(this.state); }
  async transact<T>(fn: (state: OfficeState) => T | Promise<T>) {
    this.transactions++;
    const copy = structuredClone(this.state);
    const result = await fn(copy);
    this.state = copy;
    return result;
  }
}
const error = (code: string) => (value: unknown) => value instanceof OfficeError && value.code === code;
async function fixture(t: TestContext, extra: Record<string, string | undefined> = {}) {
  const env = testEnvironment(extra);
  const config = parseOfficeStagingEnvironment(env);
  const directory = await mkdtemp(join(tmpdir(), 'office-synthetic-staging-test-'));
  await mkdir(join(directory, 'assets'));
  await writeFile(join(directory, 'index.html'), '<!doctype html><title>Synthetic office</title><script src="/office/assets/office.js"></script>');
  await writeFile(join(directory, 'assets', 'office.js'), 'window.syntheticOffice = true;');
  const store = new SyntheticStore();
  const api = createStagingOfficeApp(config, store, { staticRoot: directory, clock: () => AT });
  t.after(async () => { await api.close(); await rm(directory, { recursive: true, force: true }); });
  await api.ready();
  const headers = { host: config.access.host, 'x-forwarded-proto': 'https', origin: config.access.origin, authorization: `Basic ${Buffer.from(`${env.OFFICE_STAGING_USERNAME}:${env.OFFICE_STAGING_PASSWORD}`).toString('base64')}` };
  const login = async (payload: object = {}) => {
    const response = await api.inject({ method: 'POST', url: '/office-api/session', headers, payload });
    assert.equal(response.statusCode, 200);
    return { response, cookie: String(response.headers['set-cookie']).split(';')[0] };
  };
  return { api, store, config, headers, login };
}

describe('explicit synthetic staging configuration', () => {
  it('requires every staging field and HTTPS origin, with viewer as the default maximum role', () => {
    const env = testEnvironment();
    const config = parseOfficeStagingEnvironment(env);
    assert.equal(config.access.role, 'viewer');
    assert.equal(config.access.origin, 'https://office.example.test');
    for (const key of Object.keys(env)) assert.throws(() => parseOfficeStagingEnvironment({ ...env, [key]: undefined }), value => value instanceof OfficeError && value.statusCode === 503);
    for (const origin of ['http://office.example.test', 'https://office.example.test/path', 'https://office.example.test/', 'https://office.example.test?query=1', 'https://user:pass@office.example.test', 'https://localhost', 'https://127.0.0.1', 'https://[::1]', 'https://[2001:db8::1]', 'https://[fd12:3456:789a::1]', 'https://[::ffff:127.0.0.1]', 'https://[::ffff:7f00:1]', 'https://office.example.test:8443']) assert.throws(() => parseOfficeStagingEnvironment({ ...env, OFFICE_STAGING_ORIGIN: origin }), error('INVALID_STAGING_CONFIGURATION'));
    for (const change of [{ OFFICE_RUNTIME_MODE: 'development' }, { OFFICE_STAGING_ROLE: 'administrator' }, { OFFICE_STAGING_USERNAME: 'name:bad' }, { OFFICE_STAGING_PASSWORD: 'short' }, { OFFICE_STAGING_PASSWORD: 'do-not-accept-a-password\nwith-controls' }]) assert.throws(() => parseOfficeStagingEnvironment({ ...env, ...change }), error('INVALID_STAGING_CONFIGURATION'));
  });

  it('rejects alternate connection sources and broad or public trusted proxy networks', () => {
    const env = testEnvironment();
    for (const key of ['OFFICE_DATABASE_URL', 'DATABASE_URL', 'PGHOST', 'PGHOSTADDR', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD', 'PGOPTIONS', 'PGSSLMODE', 'PGSERVICE', 'PGSERVICEFILE', 'PGPASSFILE']) assert.throws(() => parseOfficeStagingEnvironment({ ...env, [key]: 'synthetic-test-override' }), error('INVALID_STAGING_CONFIGURATION'));
    for (const cidrs of ['', '0.0.0.0/0', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '127.0.0.1/24', '203.0.113.0/24', '::/0', 'fc00::/7', '::1/64', '0:0:0:0:0:0:0:1/64', '::ffff:10.0.0.1/64', '::ffff:127.0.0.1/128', '172.31.240.0', '172.31.240.0/24, 127.0.0.1/32', '127.0.0.1/32,127.0.0.1/32']) assert.throws(() => parseOfficeStagingEnvironment({ ...env, OFFICE_STAGING_TRUSTED_PROXY_CIDRS: cidrs }), error('INVALID_STAGING_CONFIGURATION'));
    const peers = parseOfficeStagingEnvironment(env).access;
    assert(peers.trustedPeer('127.0.0.1')); assert(peers.trustedPeer('::ffff:127.0.0.1')); assert(peers.trustedPeer('172.31.240.20'));
    assert(!peers.trustedPeer('172.31.241.20')); assert(!peers.trustedPeer('127.0.0.2')); assert(!peers.trustedPeer('203.0.113.20'));
    const ipv6 = parseOfficeStagingEnvironment({ ...env, OFFICE_STAGING_TRUSTED_PROXY_CIDRS: '::1/128,fd12:3456:789a::/64' }).access;
    assert(ipv6.trustedPeer('::1')); assert(ipv6.trustedPeer('fd12:3456:789a::10')); assert(!ipv6.trustedPeer('fd12:3456:789b::10'));
  });

  it('requires the authenticated internal synthetic database and preserves separate local defaults', async t => {
    const config = parseOfficeStagingEnvironment(testEnvironment());
    const db = config.database;
    for (const change of [{ host: 'example.test' }, { host: '127.0.0.1' }, { port: 55433 }, { database: 'production' }, { database: 'gourmet_office_candidate_dev' }, { user: 'postgres' }, { password: '' }, { password: 'short' }, { password: 'synthetic-password-with\ncontrols' }, { ssl: false }]) assert.throws(() => validateStagingDatabaseOptions({ ...db, ...change }), error('INVALID_STAGING_DATABASE'));
    const staging = new PostgresOfficeStore({ mode: 'staging', database: db });
    const local = new PostgresOfficeStore();
    t.after(async () => { await staging.close(); await local.close(); });
    // Constructing pools does not establish a connection or create credentials.
    assert.equal(staging.stateId, STAGING_OFFICE_STATE_ID);
    assert.equal(staging.pool.options.host, 'office-db');
    assert.equal(staging.pool.options.port, 5432);
    assert.equal(staging.pool.options.user, 'office_stage');
    assert.equal(staging.pool.options.database, 'gourmet_office_stage_demo');
    assert.equal(staging.pool.options.ssl, false);
    assert.equal(staging.pool.options.options, '');
    assert.equal(local.pool.options.connectionString, DEFAULT_OFFICE_DATABASE_URL);
    assert.equal(local.stateId, 'gourmet-office-candidate-development');
    assert.throws(() => new PostgresOfficeStore({ mode: 'staging', database: db, stateId: 'gourmet-office-candidate-development' }), error('INVALID_STATE_ID'));
  });

  it('does not substitute a development server when the compiled office is missing', () => {
    assert.throws(() => createStagingOfficeApp(parseOfficeStagingEnvironment(testEnvironment()), new SyntheticStore(), { staticRoot: join(tmpdir(), 'nonexistent-office-synthetic-build') }), error('STAGING_BUILD_REQUIRED'));
  });
});

describe('synthetic staging authentication and request boundaries', () => {
  it('accepts only the inspected coolify proxy peer while still requiring authentication', async t => {
    const { api, headers, store } = await fixture(t, {
      OFFICE_STAGING_ORIGIN: 'https://office-staging.gourmet-corporation.com',
      OFFICE_STAGING_TRUSTED_PROXY_CIDRS: '127.0.0.1/32,172.16.1.2/32',
    });
    // Synthetic injection proves the allowlist contract, not the deployed peer.
    const request = { url: '/office-api/health', remoteAddress: '172.16.1.2', headers };
    const health = await api.inject(request);
    assert.equal(health.statusCode, 200);
    assert.deepEqual(health.json(), { status: 'ok', mode: 'demo', storage: 'postgres', outboundEffects: 0 });
    assert.equal((await api.inject({ ...request, headers: { ...headers, authorization: '' } })).statusCode, 401);
    for (const peer of ['172.16.1.3', '172.16.7.2']) {
      const response = await api.inject({ ...request, remoteAddress: peer, headers: { ...headers, 'x-forwarded-for': '172.16.1.2' } });
      assert.equal(response.statusCode, 403);
      assert.equal(response.json().error, 'UNTRUSTED_STAGING_PROXY');
    }
    assert.equal(store.transactions, 0);
  });

  it('protects UI, assets, redirects, deep links, health and API before accessing storage', async t => {
    const { api, store, headers } = await fixture(t);
    const anonymous = { ...headers, authorization: '' };
    for (const url of ['/', '/office', '/office/', '/office/assets/office.js', '/office/dashboard', '/office-api/health', '/office-api/session', '/office-api/snapshot', '/unknown']) {
      const response = await api.inject({ url, headers: anonymous });
      assert.equal(response.statusCode, 401);
      assert.match(String(response.headers['www-authenticate']), /^Basic /);
      assert(!response.body.includes('Synthetic office')); assert(!response.body.includes('window.syntheticOffice'));
    }
    assert.equal((await api.inject({ method: 'POST', url: '/office-api/session', headers: anonymous, payload: { role: 'operator' } })).statusCode, 401);
    assert.equal(store.reads, 0); assert.equal(store.transactions, 0);
    for (const authorization of ['Bearer synthetic-test-token', 'Basic ???', 'Basic Zm9v', 'Basic Zm9v===', `Basic ${Buffer.from('synthetic-test-user:incorrect-synthetic-password').toString('base64')}`]) assert.equal((await api.inject({ url: '/office/', headers: { ...headers, authorization } })).statusCode, 401);
  });

  it('serves the compiled same-origin UI and restricts SPA fallbacks and response metadata', async t => {
    const { api, headers } = await fixture(t);
    const html = await api.inject({ url: '/office/', headers });
    assert.equal(html.statusCode, 200); assert(html.body.includes('Synthetic office'));
    assert.equal(html.headers['cache-control'], 'no-store'); assert.equal(html.headers['x-frame-options'], 'DENY');
    assert.match(String(html.headers['content-security-policy']), /connect-src 'self'/);
    assert.equal((await api.inject({ url: '/office/assets/office.js', headers })).body, 'window.syntheticOffice = true;');
    const redirect = await api.inject({ url: '/', headers }); assert.equal(redirect.statusCode, 302); assert.equal(redirect.headers.location, '/office/');
    assert.equal((await api.inject({ url: '/office/dashboard/history', headers: { ...headers, accept: 'text/html' } })).statusCode, 200);
    for (const url of ['/office/assets/missing.js', '/office-api/missing', '/missing']) assert.equal((await api.inject({ url, headers: { ...headers, accept: 'text/html' } })).statusCode, 404);
    for (const url of ['/office/.env', '/office/%2e%2e/package.json']) assert([403, 404].includes((await api.inject({ url, headers: { ...headers, accept: 'text/html' } })).statusCode));
    const health = await api.inject({ url: '/office-api/health', headers });
    assert.equal(health.statusCode, 200); assert.deepEqual(health.json(), { status: 'ok', mode: 'demo', storage: 'postgres', outboundEffects: 0 });
  });

  it('uses authenticated server permissions rather than an operator selected by the browser', async t => {
    const { api, store, headers, login } = await fixture(t);
    const original = canonical(store.state);
    const escalation = await api.inject({ method: 'POST', url: '/office-api/session', headers, payload: { role: 'operator' } });
    assert.equal(escalation.statusCode, 403); assert.equal(escalation.json().error, 'FORBIDDEN_STAGING_ROLE');
    const { response, cookie } = await login();
    assert.equal(response.json().role, 'viewer'); assert.equal(response.json().actorId, 'OFFICE_DEMO_OPERATOR');
    assert.match(String(response.headers['set-cookie']), /HttpOnly; SameSite=Strict; Secure;/);
    const command = { idempotencyKey: 'synthetic-viewer-must-not-write', caseId: 'demo-aurora', functionId: 'sales', action: 'chat', text: 'synthetic viewer test' };
    assert.equal((await api.inject({ method: 'POST', url: '/office-api/commands', headers: { ...headers, cookie }, payload: command })).statusCode, 403);
    assert.equal(canonical(store.state), original); assert.equal(store.transactions, 0);
    const snapshot = (await api.inject({ url: '/office-api/snapshot', headers: { ...headers, cookie } })).json();
    assert.equal(snapshot.mode, 'demo'); assert.equal(snapshot.outboundEffects, 0); assert.equal(snapshot.mondayWrites, 0);
  });

  it('permits synthetic operator commands only when operator is explicitly configured', async t => {
    const { api, headers, store, login } = await fixture(t, { OFFICE_STAGING_ROLE: 'operator' });
    const { response, cookie } = await login({ role: 'operator' });
    assert.equal(response.json().role, 'operator');
    const command = { idempotencyKey: 'synthetic-staging-operator-command', caseId: 'demo-aurora', functionId: 'sales', action: 'chat', text: 'Pregunta sintética de staging' };
    const result = await api.inject({ method: 'POST', url: '/office-api/commands', headers: { ...headers, cookie }, payload: command });
    assert.equal(result.statusCode, 200); assert.equal(store.transactions, 1);
    assert.equal(result.json().snapshot.outboundEffects, 0); assert.equal(result.json().snapshot.mondayWrites, 0);
    assert(Object.values(store.state.office.history).every(row => row.evidence.simulated));
  });

  it('requires current Basic authorization even with a valid demo session cookie', async t => {
    const { api, headers, store, login } = await fixture(t, { OFFICE_STAGING_ROLE: 'operator' });
    const { cookie } = await login();
    const original = canonical(store.state);
    const anonymous = { ...headers, cookie, authorization: '' };
    for (const url of ['/office/', '/office/assets/office.js', '/office-api/snapshot', '/office-api/session', '/office-api/health']) assert.equal((await api.inject({ url, headers: anonymous })).statusCode, 401);
    assert.equal((await api.inject({ method: 'POST', url: '/office-api/commands', headers: anonymous, payload: { idempotencyKey: 'must-not-run', caseId: 'demo-aurora', functionId: 'sales', action: 'chat', text: 'must-not-run' } })).statusCode, 401);
    assert.equal(canonical(store.state), original); assert.equal(store.transactions, 0);
  });

  it('rejects host, origin, protocol and peer spoofing without writing history or reflecting headers', async t => {
    const { api, headers, store } = await fixture(t, { OFFICE_STAGING_ROLE: 'operator' });
    const original = canonical(store.state);
    for (const invalid of [{ host: 'private-marker.example.test' }, { 'x-forwarded-host': 'private-marker.example.test' }, { 'x-forwarded-proto': 'http' }, { 'x-forwarded-proto': 'https,http' }, { 'x-forwarded-proto': '' }, { forwarded: 'for=127.0.0.1;proto=https' }, { origin: 'https://private-marker.example.test' }, { origin: '' }]) {
      const response = await api.inject({ method: 'POST', url: '/office-api/session', headers: { ...headers, ...invalid }, payload: {} });
      assert.equal(response.statusCode, 403); assert(!response.body.includes('private-marker'));
    }
    const spoof = await api.inject({ url: '/office-api/health', remoteAddress: '203.0.113.20', headers: { ...headers, 'x-forwarded-for': '127.0.0.1' } });
    assert.equal(spoof.statusCode, 403); assert.equal(spoof.json().error, 'UNTRUSTED_STAGING_PROXY');
    assert.equal((await api.inject({ url: '/office-api/health', remoteAddress: '172.31.240.20', headers })).statusCode, 200);
    assert.equal(canonical(store.state), original); assert.equal(store.transactions, 0);
  });

  it('retains JSON and session scope validation and expires Secure cookies on logout', async t => {
    const { api, headers, login } = await fixture(t);
    const malformed = await api.inject({ method: 'POST', url: '/office-api/session', headers, payload: { role: 'viewer', actorId: 'private-marker' } });
    assert.equal(malformed.statusCode, 400); assert(!malformed.body.includes('private-marker'));
    const nonJson = await api.inject({ method: 'POST', url: '/office-api/session', headers: { ...headers, 'content-type': 'text/plain' }, payload: 'synthetic-test' });
    assert.equal(nonJson.statusCode, 415);
    const { cookie } = await login();
    const logout = await api.inject({ method: 'DELETE', url: '/office-api/session', headers: { ...headers, cookie } });
    assert.equal(logout.statusCode, 204); assert.match(String(logout.headers['set-cookie']), /SameSite=Strict; Secure; Max-Age=0/);
    assert.equal((await api.inject({ url: '/office-api/session', headers: { ...headers, cookie } })).statusCode, 401);
  });
});
