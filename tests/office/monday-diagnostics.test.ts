import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import {
  formatMondayStartupDiagnostic, getMondayConfigurationDiagnostic, withMondayConfigurationDiagnostic,
  type MondayConfigurationDiagnostic, type MondayConfigurationField, type MondayConfigurationReason,
} from '../../src/office/backend/monday-diagnostics';
import { createMondayRuntime } from '../../src/office/backend/monday-runtime';
import { MondayOAuthError, MONDAY_OAUTH_ORIGIN } from '../../src/office/backend/monday-oauth';
import { MONDAY_READ_BOARD_IDS } from '../../src/office/backend/monday-read';
import { OfficeError } from '../../src/office/backend/state';

// All credentials, keys, malicious payloads and errors below are synthetic.
// No process configuration, provisioned secret, network or database is read.
const canary = 'SYNTHETIC_CANARY_NEVER_LOG_VALUE';
const fixture = (extra: Record<string, string | undefined> = {}) => ({
  MONDAY_OAUTH_ENABLED: 'true', MONDAY_OWNER_USERNAME: 'synthetic_owner',
  MONDAY_OWNER_PASSWORD: 'SYNTHETIC_ONLY_OWNER_PASSWORD_123',
  OFFICE_STAGING_USERNAME: 'synthetic_shared', OFFICE_STAGING_PASSWORD: 'SYNTHETIC_ONLY_SHARED_PASSWORD_456',
  MONDAY_CLIENT_ID: 'synthetic-client', MONDAY_CLIENT_SECRET: 'SYNTHETIC_ONLY_CLIENT_SECRET',
  MONDAY_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 11).toString('base64'),
  MONDAY_EXPECTED_ACCOUNT_EMAIL: 'info@gourmet-corp.com', MONDAY_EXPECTED_USER_ID: '78158865', MONDAY_EXPECTED_ACCOUNT_ID: '29907909',
  ...extra,
});
const forbiddenPool = new Proxy({}, { get() { throw new Error(canary); } }) as Pool;
const configuredMapping = () => ({
  ...Object.fromEntries(MONDAY_READ_BOARD_IDS.map(id => [id, []])),
  '18403945258': [
    { id: 'color_mm1e35nf', type: 'status', field: 'stage' },
    { id: 'date_mm1ehb3s', type: 'date', field: 'event_date' },
    { id: 'color_mm5ggm58', type: 'status', field: 'quote_status' },
    { id: 'numeric_mm5gfyz5', type: 'numbers', field: 'amount' },
  ],
  '18377848804': [{ id: 'amount', type: 'numbers', field: 'amount' }],
});
const generic = { code: 'configuration_invalid' };
function diagnosed(env: Record<string, string | undefined>, field: MondayConfigurationField, reason: MondayConfigurationReason) {
  const runtime = createMondayRuntime(env, MONDAY_OAUTH_ORIGIN, forbiddenPool);
  assert.equal(runtime.enabled, false); assert.equal(runtime.configured, false);
  assert.equal(runtime.configurationFailure, 'configuration_invalid');
  const expected: MondayConfigurationDiagnostic = { code: 'configuration_invalid', field, reason };
  assert.deepEqual(runtime.startupDiagnostic, expected);
  const output = formatMondayStartupDiagnostic(runtime.startupDiagnostic);
  assert.deepEqual(JSON.parse(output), expected);
  assert(!output.includes(canary));
  assert(!output.includes('SYNTHETIC_ONLY'));
  assert(!output.includes('synthetic-client'));
  assert(!output.includes(fixture().MONDAY_TOKEN_ENCRYPTION_KEY));
  assert.equal(output.includes('\n'), false);
  return runtime;
}

describe('safe Monday startup configuration diagnostics', () => {
  it('identifies each required missing field without reporting its value', () => {
    const required = [
      'MONDAY_OWNER_USERNAME', 'MONDAY_OWNER_PASSWORD', 'MONDAY_CLIENT_ID', 'MONDAY_CLIENT_SECRET',
      'MONDAY_TOKEN_ENCRYPTION_KEY', 'MONDAY_EXPECTED_ACCOUNT_EMAIL', 'MONDAY_EXPECTED_USER_ID', 'MONDAY_EXPECTED_ACCOUNT_ID',
    ] as const;
    for (const field of required) {
      for (const value of [undefined, '']) diagnosed(fixture({ [field]: value }), field, 'missing');
    }
  });

  it('identifies formatting failures using only the fixed field and reason allowlists', () => {
    for (const [field, values] of [
      ['MONDAY_OAUTH_ENABLED', ['TRUE', '1', canary]],
      ['MONDAY_OWNER_USERNAME', ['short user', `${canary}\n`, 'é'.repeat(24)]],
      ['MONDAY_OWNER_PASSWORD', ['short', `${canary}\n`, 'é'.repeat(24), 'a'.repeat(257)]],
      ['MONDAY_CLIENT_ID', [`${canary}\n`, 'a'.repeat(201), `${canary} `]],
      ['MONDAY_CLIENT_SECRET', [`${canary}\r\nAuthorization: ${canary}`, 'a'.repeat(4097), ` ${canary}`]],
      ['MONDAY_TOKEN_ENCRYPTION_KEY', [canary, Buffer.alloc(31, 11).toString('base64'), Buffer.alloc(33, 11).toString('base64'), fixture().MONDAY_TOKEN_ENCRYPTION_KEY.replace(/=$/, ''), `${fixture().MONDAY_TOKEN_ENCRYPTION_KEY}\n`]],
      ['MONDAY_EXPECTED_ACCOUNT_EMAIL', [`${canary}\n`, 'not-an-email']],
      ['MONDAY_EXPECTED_USER_ID', [canary, '0', '0123']],
      ['MONDAY_EXPECTED_ACCOUNT_ID', [canary, '0', '0123']],
    ] as const) for (const value of values) diagnosed(fixture({ [field]: value }), field, 'invalid_format');
  });

  it('identifies owner credentials reused from Basic without exposing either credential', () => {
    diagnosed(fixture({ MONDAY_OWNER_USERNAME: fixture().OFFICE_STAGING_USERNAME }), 'MONDAY_OWNER_USERNAME', 'not_separate');
    diagnosed(fixture({ MONDAY_OWNER_PASSWORD: fixture().OFFICE_STAGING_PASSWORD }), 'MONDAY_OWNER_PASSWORD', 'not_separate');
  });

  it('rejects hostile nonstring values without coercing or serializing them', () => {
    let inspected = 0;
    const hostile = {
      toJSON() { inspected++; return canary; },
      toString() { inspected++; return canary; },
      [Symbol.toPrimitive]() { inspected++; throw new Error(canary); },
    };
    for (const field of [
      'MONDAY_OWNER_USERNAME', 'MONDAY_OWNER_PASSWORD', 'MONDAY_CLIENT_ID', 'MONDAY_CLIENT_SECRET',
      'MONDAY_TOKEN_ENCRYPTION_KEY', 'MONDAY_EXPECTED_ACCOUNT_EMAIL', 'MONDAY_EXPECTED_USER_ID',
      'MONDAY_EXPECTED_ACCOUNT_ID', 'MONDAY_BOARD_COLUMNS_JSON',
    ] as const) diagnosed(fixture({ [field]: hostile as never }), field, 'invalid_format');
    assert.equal(inspected, 0);
  });

  it('contains throwing field accessors and descriptor traps while identifying only the known field', () => {
    for (const field of ['MONDAY_OWNER_USERNAME', 'MONDAY_OWNER_PASSWORD', 'MONDAY_CLIENT_SECRET', 'MONDAY_TOKEN_ENCRYPTION_KEY', 'MONDAY_BOARD_COLUMNS_JSON'] as const) {
      const env = fixture();
      Object.defineProperty(env, field, { enumerable: true, get() { throw new Error(`${canary}\n${canary}`); } });
      diagnosed(env, field, 'invalid_format');
    }
    const env = new Proxy(fixture(), {
      getOwnPropertyDescriptor(target, field) {
        if (field === 'MONDAY_OWNER_USERNAME') throw new Error(canary);
        return Reflect.getOwnPropertyDescriptor(target, field);
      },
    });
    diagnosed(env, 'MONDAY_OWNER_USERNAME', 'invalid_format');
  });

  it('identifies an origin policy mismatch before inspecting credentials', () => {
    const reads: string[] = [];
    const env = new Proxy({}, { get(_target, field) {
      reads.push(String(field)); if (field === 'MONDAY_OAUTH_ENABLED') return 'true'; throw new Error(canary);
    }, getOwnPropertyDescriptor() { throw new Error(canary); } });
    const runtime = createMondayRuntime(env, 'https://unused.invalid.test', forbiddenPool);
    assert.deepEqual(runtime.startupDiagnostic, { code: 'configuration_invalid', field: 'OFFICE_STAGING_ORIGIN', reason: 'policy_mismatch' });
    assert.deepEqual(JSON.parse(formatMondayStartupDiagnostic(runtime.startupDiagnostic)), runtime.startupDiagnostic);
    assert.deepEqual(reads, ['MONDAY_OAUTH_ENABLED']);
  });

  it('keeps authorized identity metadata policy explicit and does not infer account verification', () => {
    for (const [field, value] of [
      ['MONDAY_EXPECTED_ACCOUNT_EMAIL', 'other@invalid.test'],
      ['MONDAY_EXPECTED_USER_ID', '101'],
      ['MONDAY_EXPECTED_ACCOUNT_ID', '202'],
    ] as const) diagnosed(fixture({ [field]: value }), field, 'policy_mismatch');
    const runtime = createMondayRuntime(fixture({ MONDAY_EXPECTED_ACCOUNT_EMAIL: 'INFO@GOURMET-CORP.COM' }), MONDAY_OAUTH_ORIGIN, forbiddenPool);
    assert.equal(runtime.enabled, true); assert.equal(runtime.startupDiagnostic, undefined);
  });

  it('reports invalid mapping syntax or schema without copying raw JSON, columns or hashes', () => {
    const values = [
      `${canary}{`, JSON.stringify({ [canary]: [] }), 'null', '[]', '{}',
      JSON.stringify({ ...configuredMapping(), [MONDAY_READ_BOARD_IDS[0]]: [{ id: canary, type: 'text', field: 'email' }] }),
      JSON.stringify({ ...configuredMapping(), [MONDAY_READ_BOARD_IDS[0]]: [{ id: 'synthetic_status', type: 'status', field: 'stage', query: canary }] }),
    ];
    for (const value of values) diagnosed(fixture({ MONDAY_BOARD_COLUMNS_JSON: value }), 'MONDAY_BOARD_COLUMNS_JSON', 'invalid_format');
    for (const value of [undefined, '', JSON.stringify(configuredMapping())]) {
      const runtime = createMondayRuntime(fixture({ MONDAY_BOARD_COLUMNS_JSON: value }), MONDAY_OAUTH_ORIGIN, forbiddenPool);
      assert.equal(runtime.enabled, true); assert.equal(runtime.startupDiagnostic, undefined);
    }
  });

  it('reports only the feature flag being absent or disabled without reading credentials', () => {
    for (const value of [undefined, '', 'false']) {
      const reads: string[] = [];
      const env = new Proxy({}, {
        get(_target, field) { reads.push(String(field)); if (field === 'MONDAY_OAUTH_ENABLED') return value; throw new Error(canary); },
        getOwnPropertyDescriptor() { throw new Error(canary); },
      });
      const runtime = createMondayRuntime(env, 'https://unused.invalid.test', forbiddenPool);
      assert.equal(runtime.enabled, false); assert.equal(runtime.configurationFailure, undefined);
      const expected = value === 'false'
        ? { code: 'disabled', field: 'MONDAY_OAUTH_ENABLED' }
        : { code: 'disabled', field: 'MONDAY_OAUTH_ENABLED', reason: 'missing' };
      assert.deepEqual(runtime.startupDiagnostic, expected);
      assert.deepEqual(JSON.parse(formatMondayStartupDiagnostic(runtime.startupDiagnostic)), expected);
      assert.deepEqual(reads, ['MONDAY_OAUTH_ENABLED']);
    }
  });

  it('configures successfully without provider or database work and has no failure diagnostic', t => {
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error(canary); });
    const runtime = createMondayRuntime(fixture({ MONDAY_BOARD_COLUMNS_JSON: JSON.stringify(configuredMapping()) }), MONDAY_OAUTH_ORIGIN, forbiddenPool);
    assert.equal(runtime.enabled, true); assert.equal(runtime.configured, true); assert(runtime.oauthService);
    assert.equal(runtime.configurationFailure, undefined); assert.equal(runtime.startupDiagnostic, undefined); assert.equal(calls, 0);
  });

  it('retains original error types and codes while storing only fixed diagnostic metadata privately', () => {
    for (const error of [new OfficeError('INVALID_MONDAY_OWNER_CONFIGURATION', 503), new MondayOAuthError('configuration_invalid', 503)]) {
      error.message = canary; error.stack = canary;
      const keys = Reflect.ownKeys(error);
      const tagged = withMondayConfigurationDiagnostic(error, 'MONDAY_CLIENT_SECRET', 'missing');
      assert.equal(tagged, error); assert.deepEqual(Reflect.ownKeys(error), keys);
      const diagnostic = getMondayConfigurationDiagnostic(tagged);
      assert.deepEqual(diagnostic, { code: 'configuration_invalid', field: 'MONDAY_CLIENT_SECRET', reason: 'missing' });
      assert(Object.isFrozen(diagnostic));
      assert.equal(JSON.stringify(tagged).includes('MONDAY_CLIENT_SECRET'), false);
      assert(!formatMondayStartupDiagnostic(getMondayConfigurationDiagnostic(tagged)).includes(canary));
    }
    assert.equal(getMondayConfigurationDiagnostic(new Error(canary)), undefined);
  });

  it('does not inspect error messages, properties or prototype traps when tagging or retrieving diagnostics', () => {
    let inspections = 0;
    const error = new Proxy(new Error(canary), {
      get() { inspections++; throw new Error(canary); },
      getOwnPropertyDescriptor() { inspections++; throw new Error(canary); },
      getPrototypeOf() { inspections++; throw new Error(canary); },
    });
    const tagged = withMondayConfigurationDiagnostic(error, 'MONDAY_TOKEN_ENCRYPTION_KEY', 'invalid_format');
    assert.equal(tagged, error);
    assert.deepEqual(JSON.parse(formatMondayStartupDiagnostic(getMondayConfigurationDiagnostic(tagged))), {
      code: 'configuration_invalid', field: 'MONDAY_TOKEN_ENCRYPTION_KEY', reason: 'invalid_format',
    });
    assert.equal(inspections, 0);
  });

  it('does not trust field or reason arguments outside the allowlists even on a tagged error', () => {
    const field = canary as MondayConfigurationField;
    const reason = canary as MondayConfigurationReason;
    for (const error of [
      withMondayConfigurationDiagnostic(new Error(canary), field, 'missing'),
      withMondayConfigurationDiagnostic(new Error(canary), 'MONDAY_CLIENT_SECRET', reason),
    ]) {
      const output = formatMondayStartupDiagnostic(getMondayConfigurationDiagnostic(error));
      assert.deepEqual(JSON.parse(output), generic); assert(!output.includes(canary));
    }
  });

  it('falls back to an exact generic record for spoofed, accessor and proxy diagnostic objects', () => {
    let getters = 0; let serializers = 0;
    const malicious = { toJSON() { serializers++; return canary; }, toString() { serializers++; return canary; } };
    const accessor = Object.defineProperty({ code: 'configuration_invalid', reason: 'missing' }, 'field', { enumerable: true, get() { getters++; throw new Error(canary); } });
    const hostileError = Object.defineProperty(new Error(canary), 'code', { get() { getters++; throw new Error(canary); } });
    const hostileProxy = new Proxy({}, { get() { throw new Error(canary); }, getOwnPropertyDescriptor() { throw new Error(canary); }, ownKeys() { throw new Error(canary); }, getPrototypeOf() { throw new Error(canary); } });
    for (const input of [
      undefined, null, canary, new Error(canary), hostileError, hostileProxy, accessor,
      { code: canary, field: 'MONDAY_CLIENT_SECRET', reason: 'missing' },
      { code: 'configuration_invalid', field: canary, reason: 'missing' },
      { code: 'configuration_invalid', field: 'MONDAY_CLIENT_SECRET', reason: canary },
      { code: 'configuration_invalid', field: malicious, reason: 'missing' },
      { code: 'configuration_invalid', field: 'MONDAY_CLIENT_SECRET', reason: malicious },
      { code: 'configuration_invalid', field: 'MONDAY_CLIENT_SECRET', reason: 'missing', value: canary },
      { code: 'configuration_invalid', field: 'MONDAY_CLIENT_SECRET', reason: 'missing' },
    ]) {
      const output = formatMondayStartupDiagnostic(input);
      assert.deepEqual(JSON.parse(output), generic); assert(!output.includes(canary));
      assert.equal(getMondayConfigurationDiagnostic(input), undefined);
    }
    assert.equal(getters, 0); assert.equal(serializers, 0);
  });
});
