import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { createMondayRuntime } from '../../src/office/backend/monday-runtime';
import { MONDAY_OAUTH_ORIGIN } from '../../src/office/backend/monday-oauth';
import { MONDAY_READ_BOARD_IDS } from '../../src/office/backend/monday-read';
import { OfficeError, type OfficeStore } from '../../src/office/backend/state';
import { createOfficeFixtureState } from '../../src/office/backend/fixtures';
import { createStagingOfficeApp } from '../../src/office/backend/staging-app';
import { parseOfficeStagingEnvironment } from '../../src/office/backend/staging';

// Credentials and keys are synthetic fixtures, never provisioned. Identity
// metadata uses only the public pilot values authorized for this integration.
const fixture = (extra: Record<string, string | undefined> = {}) => ({
  MONDAY_OAUTH_ENABLED: 'true', MONDAY_OWNER_USERNAME: 'synthetic_owner',
  MONDAY_OWNER_PASSWORD: 'SYNTHETIC_ONLY_OWNER_PASSWORD_123',
  OFFICE_STAGING_USERNAME: 'synthetic_shared', OFFICE_STAGING_PASSWORD: 'SYNTHETIC_ONLY_SHARED_PASSWORD_456',
  MONDAY_CLIENT_ID: 'synthetic-client', MONDAY_CLIENT_SECRET: 'SYNTHETIC_ONLY_CLIENT_SECRET',
  MONDAY_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 11).toString('base64'),
  MONDAY_EXPECTED_ACCOUNT_EMAIL: 'info@gourmet-corp.com', MONDAY_EXPECTED_USER_ID: '78158865', MONDAY_EXPECTED_ACCOUNT_ID: '29907909',
  ...extra,
});
const forbiddenPool = new Proxy({}, { get() { throw new Error('synthetic pool must not be touched'); } }) as Pool;
const mapping = () => Object.fromEntries(MONDAY_READ_BOARD_IDS.map(id => [id, [{ id: 'synthetic_status', type: 'status', field: 'stage' }]]));
function unavailable(runtime: ReturnType<typeof createMondayRuntime>, invalid: boolean) {
  assert.equal(runtime.enabled, false); assert.equal(runtime.configured, false); assert.equal(runtime.oauthService, undefined);
  assert.equal(runtime.configurationFailure, invalid ? 'configuration_invalid' : undefined);
  assert.deepEqual(runtime.ownerSessions.status(undefined), { authenticated: false });
  assert.throws(() => runtime.ownerSessions.issueLoginChallenge(), error => error instanceof OfficeError && error.code === 'MONDAY_OWNER_UNAVAILABLE');
}

describe('optional Monday runtime with synthetic manual configuration', () => {
  it('reads only the feature flag while disabled, even when all other reads throw', () => {
    for (const flag of [undefined, '', 'false']) {
      const reads: string[] = [];
      const env = new Proxy({}, { get(_target, name) {
        reads.push(String(name)); if (name === 'MONDAY_OAUTH_ENABLED') return flag;
        throw new Error('synthetic forbidden credential read');
      }, getOwnPropertyDescriptor() { throw new Error('synthetic forbidden owner credential read'); } });
      unavailable(createMondayRuntime(env, 'https://unused.invalid.test', forbiddenPool), false);
      assert.deepEqual(reads, ['MONDAY_OAUTH_ENABLED']);
    }
  });

  it('rejects nonliteral enabled values or a different origin before credentials or pool access', () => {
    for (const [flag, origin] of [['TRUE', MONDAY_OAUTH_ORIGIN], ['1', MONDAY_OAUTH_ORIGIN], ['true', `${MONDAY_OAUTH_ORIGIN}/`], ['true', 'http://office-staging.gourmet-corporation.com'], ['true', `${MONDAY_OAUTH_ORIGIN}:443`]]) {
      const env = new Proxy({}, { get(_target, name) { if (name === 'MONDAY_OAUTH_ENABLED') return flag; throw new Error('synthetic forbidden read'); } });
      unavailable(createMondayRuntime(env, origin, forbiddenPool), true);
    }
  });

  it('requires a separate manual owner before inspecting OAuth credentials', () => {
    const env = Object.defineProperty({ MONDAY_OAUTH_ENABLED: 'true' }, 'MONDAY_CLIENT_SECRET', { get() { throw new Error('synthetic forbidden OAuth secret read'); } });
    unavailable(createMondayRuntime(env, MONDAY_OAUTH_ORIGIN, forbiddenPool), true);
    unavailable(createMondayRuntime(fixture({ MONDAY_OWNER_PASSWORD: fixture().OFFICE_STAGING_PASSWORD }), MONDAY_OAUTH_ORIGIN, forbiddenPool), true);
    unavailable(createMondayRuntime(fixture({ MONDAY_OWNER_USERNAME: fixture().OFFICE_STAGING_USERNAME }), MONDAY_OAUTH_ORIGIN, forbiddenPool), true);
  });

  it('contains invalid OAuth configuration or throwing accessors without exposing values or fetching', t => {
    let calls = 0; t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('synthetic unexpected provider request'); });
    for (const extra of [
      { MONDAY_CLIENT_SECRET: undefined }, { MONDAY_TOKEN_ENCRYPTION_KEY: 'synthetic-invalid-key' }, { MONDAY_EXPECTED_USER_ID: 'not-an-id' },
      { MONDAY_EXPECTED_USER_ID: '101' }, { MONDAY_EXPECTED_ACCOUNT_EMAIL: 'other@invalid.test' }, { MONDAY_EXPECTED_ACCOUNT_ID: '202' },
    ]) {
      const runtime = createMondayRuntime(fixture(extra), MONDAY_OAUTH_ORIGIN, forbiddenPool);
      unavailable(runtime, true); assert(!JSON.stringify(runtime).includes('SYNTHETIC_ONLY'));
    }
    const env = fixture(); Object.defineProperty(env, 'MONDAY_CLIENT_SECRET', { get() { throw new Error('SYNTHETIC_ONLY_ACCESSOR_RAW_ERROR'); } });
    const runtime = createMondayRuntime(env, MONDAY_OAUTH_ORIGIN, forbiddenPool);
    unavailable(runtime, true); assert(!JSON.stringify(runtime).includes('ACCESSOR_RAW_ERROR')); assert.equal(calls, 0);
  });

  it('constructs without provider or DB work and reuses the injected office pool on status', async t => {
    let fetches = 0; t.mock.method(globalThis, 'fetch', async () => { fetches++; throw new Error('synthetic unexpected provider request'); });
    const queries: string[] = [];
    const pool = { async query(sql: string) { queries.push(sql); return { rows: [], rowCount: 0 }; } } as unknown as Pool;
    const runtime = createMondayRuntime(fixture(), MONDAY_OAUTH_ORIGIN, pool);
    assert.equal(runtime.enabled, true); assert.equal(runtime.configured, true); assert(runtime.oauthService);
    assert.equal(runtime.configurationFailure, undefined); assert.equal(fetches, 0); assert.equal(queries.length, 0);
    assert.equal((await runtime.oauthService.status()).state, 'disconnected');
    assert.equal(queries.length, 1); assert.match(queries[0], /office_demo\.monday_private_records/); assert.equal(fetches, 0);
    const challenge = runtime.ownerSessions.issueLoginChallenge(); const credentials = fixture();
    const login = runtime.ownerSessions.login({ username: credentials.MONDAY_OWNER_USERNAME, password: credentials.MONDAY_OWNER_PASSWORD }, challenge.cookie.split(';')[0], challenge.csrfToken);
    assert.equal(login.principal, 'ricardo'); assert.equal(runtime.ownerSessions.authorize(login.cookie.split(';')[0], login.csrfToken), 'ricardo');
    assert(!JSON.stringify(runtime).includes(credentials.MONDAY_CLIENT_SECRET));
  });

  it('admits only a capped server mapping with exactly the five approved board keys', () => {
    for (const value of [undefined, '', JSON.stringify(mapping()), JSON.stringify(Object.fromEntries(MONDAY_READ_BOARD_IDS.map(id => [id, []])))]) {
      const runtime = createMondayRuntime(fixture({ MONDAY_BOARD_COLUMNS_JSON: value }), MONDAY_OAUTH_ORIGIN, forbiddenPool);
      assert.equal(runtime.enabled, true); assert.equal(runtime.configured, true);
    }
    for (const value of [
      'not-json', ' '.repeat(32 * 1024 + 1), 'null', '[]', '{}',
      JSON.stringify({ ...mapping(), '999': [] }),
      JSON.stringify({ [MONDAY_READ_BOARD_IDS[0]]: [] }),
      JSON.stringify({ ...mapping(), [MONDAY_READ_BOARD_IDS[0]]: { id: 'wrong-shape' } }),
      JSON.stringify({ ...mapping(), [MONDAY_READ_BOARD_IDS[0]]: Array.from({ length: 21 }, () => ({ id: 'synthetic_status', type: 'status', field: 'stage' })) }),
      JSON.stringify({ ...mapping(), [MONDAY_READ_BOARD_IDS[0]]: [{ id: 'synthetic_email', type: 'text', field: 'email' }] }),
      JSON.stringify({ ...mapping(), [MONDAY_READ_BOARD_IDS[0]]: [{ id: 'synthetic_status', type: 'status', field: 'stage', query: 'synthetic-unapproved-query' }] }),
    ]) unavailable(createMondayRuntime(fixture({ MONDAY_BOARD_COLUMNS_JSON: value }), MONDAY_OAUTH_ORIGIN, forbiddenPool), true);
  });

  it('keeps authenticated DEMO health available when optional Monday configuration fails', async t => {
    let fetches = 0; t.mock.method(globalThis, 'fetch', async () => { fetches++; throw new Error('synthetic unexpected request'); });
    const env = {
      ...fixture({ MONDAY_CLIENT_SECRET: undefined }), OFFICE_RUNTIME_MODE: 'staging', OFFICE_STAGING_ORIGIN: MONDAY_OAUTH_ORIGIN,
      OFFICE_STAGING_TRUSTED_PROXY_CIDRS: '127.0.0.1/32', OFFICE_STAGING_DB_HOST: 'office-db', OFFICE_STAGING_DB_PORT: '5432',
      OFFICE_STAGING_DB_USER: 'office_stage', OFFICE_STAGING_DB_NAME: 'gourmet_office_stage_demo', OFFICE_STAGING_DB_PASSWORD: 'SYNTHETIC_ONLY_DATABASE_PASSWORD_789',
    };
    const runtime = createMondayRuntime(env, MONDAY_OAUTH_ORIGIN, forbiddenPool); unavailable(runtime, true);
    const state = createOfficeFixtureState(Date.parse('2026-10-11T20:00:00.000Z'));
    const store: OfficeStore = { async snapshot() { return structuredClone(state); }, async transact() { throw new Error('synthetic unexpected transaction'); } };
    const directory = await mkdtemp(join(tmpdir(), 'office-monday-runtime-synthetic-'));
    await writeFile(join(directory, 'index.html'), '<!doctype html><title>Synthetic DEMO</title>');
    const staging = parseOfficeStagingEnvironment(env);
    const app = createStagingOfficeApp(staging, store, { staticRoot: directory, monday: runtime });
    t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
    const response = await app.inject({ url: '/office-api/health', remoteAddress: '127.0.0.1', headers: {
      host: staging.access.host, 'x-forwarded-proto': 'https', origin: staging.access.origin,
      authorization: `Basic ${Buffer.from(`${env.OFFICE_STAGING_USERNAME}:${env.OFFICE_STAGING_PASSWORD}`).toString('base64')}`,
    } });
    assert.equal(response.statusCode, 200); assert.equal(response.json().mode, 'demo'); assert.equal(response.json().outboundEffects, 0); assert.equal(fetches, 0);
  });
});
