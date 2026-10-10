import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkStagingHealth } from '../../scripts/office-staging-health.mjs';

const ENV = Object.freeze({
  OFFICE_STAGING_ORIGIN: 'https://office.synthetic.test',
  OFFICE_STAGING_USERNAME: 'synthetic_probe',
  OFFICE_STAGING_PASSWORD: 'TEST_ONLY_synthetic_health_password',
});
const HEALTH = Object.freeze({ status: 'ok', mode: 'demo', storage: 'postgres', outboundEffects: 0 });

describe('authenticated staging health probe with in-memory TEST_ONLY fixtures', () => {
  it('contacts only its fixed loopback endpoint with Basic, configured Host and HTTPS protocol', async () => {
    let calls = 0;
    await checkStagingHealth({ env: ENV, fetchImpl: async (target: string, options: RequestInit) => {
      calls++;
      assert.equal(target, 'http://127.0.0.1:4180/office-api/health');
      assert.equal(options.method, 'GET');
      assert.deepEqual(options.headers, {
        Host: 'office.synthetic.test',
        'X-Forwarded-Proto': 'https',
        Authorization: `Basic ${Buffer.from(`${ENV.OFFICE_STAGING_USERNAME}:${ENV.OFFICE_STAGING_PASSWORD}`).toString('base64')}`,
      });
      assert.equal(options.redirect, 'error');
      assert.equal(options.credentials, 'omit');
      assert.equal(options.cache, 'no-store');
      assert(options.signal instanceof AbortSignal);
      return Response.json(HEALTH);
    } });
    assert.equal(calls, 1);
  });

  it('rejects unauthenticated responses even when their JSON claims healthy storage', async () => {
    for (const status of [401, 403, 503]) {
      await assert.rejects(() => checkStagingHealth({ env: ENV, fetchImpl: async () => Response.json(HEALTH, { status }) }));
    }
  });

  it('requires successful synthetic PostgreSQL health with zero external effects', async () => {
    for (const change of [{ status: 'down' }, { mode: 'production' }, { storage: 'memory' }, { outboundEffects: 1 }, { outboundEffects: '0' }]) {
      await assert.rejects(() => checkStagingHealth({ env: ENV, fetchImpl: async () => Response.json({ ...HEALTH, ...change }) }));
    }
  });

  it('rejects redirects, fetch failures and malformed JSON without treating them as health', async () => {
    await assert.rejects(() => checkStagingHealth({ env: ENV, fetchImpl: async () => new Response(null, { status: 302, headers: { Location: 'https://elsewhere.invalid/' } }) }));
    await assert.rejects(() => checkStagingHealth({ env: ENV, fetchImpl: async () => { throw new Error('TEST_ONLY_transport_failure'); } }));
    await assert.rejects(() => checkStagingHealth({ env: ENV, fetchImpl: async () => new Response('not JSON', { status: 200 }) }));
  });

  it('fails invalid origin or credential configuration before any request', async () => {
    const changes = [
      { OFFICE_STAGING_ORIGIN: '' },
      { OFFICE_STAGING_ORIGIN: 'http://office.synthetic.test' },
      { OFFICE_STAGING_ORIGIN: 'https://office.synthetic.test/' },
      { OFFICE_STAGING_ORIGIN: 'https://user:TEST_ONLY_password@office.synthetic.test' },
      { OFFICE_STAGING_ORIGIN: 'https://office.synthetic.test/path' },
      { OFFICE_STAGING_ORIGIN: 'https://office.synthetic.test/?q=1' },
      { OFFICE_STAGING_ORIGIN: 'https://office.synthetic.test/#fragment' },
      { OFFICE_STAGING_ORIGIN: 'https://127.0.0.1' },
      { OFFICE_STAGING_ORIGIN: 'https://localhost' },
      { OFFICE_STAGING_ORIGIN: 'https://office.synthetic.test:8443' },
      { OFFICE_STAGING_USERNAME: '' },
      { OFFICE_STAGING_USERNAME: 'colon:user' },
      { OFFICE_STAGING_PASSWORD: '' },
      { OFFICE_STAGING_PASSWORD: 'TEST_ONLY_short' },
      { OFFICE_STAGING_PASSWORD: 'TEST_ONLY_password_with whitespace' },
    ];
    let calls = 0;
    for (const change of changes) {
      await assert.rejects(() => checkStagingHealth({ env: { ...ENV, ...change }, fetchImpl: async () => { calls++; return Response.json(HEALTH); } }));
    }
    assert.equal(calls, 0);
  });

  it('rejects bracketed IPv6 literal origins before making a request', async () => {
    let calls = 0;
    for (const origin of ['https://[::1]', 'https://[fd00::1234]', 'https://[::ffff:127.0.0.1]']) {
      assert.doesNotThrow(() => new URL(origin), 'each fixture must be a valid URL');
      await assert.rejects(() => checkStagingHealth({
        env: { ...ENV, OFFICE_STAGING_ORIGIN: origin },
        fetchImpl: async () => { calls++; return Response.json(HEALTH); },
      }), /Staging health configuration is invalid/);
    }
    assert.equal(calls, 0);
  });

  it('prints only a generic CLI failure when invalid configuration contains a secret', () => {
    const script = fileURLToPath(new URL('../../scripts/office-staging-health.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [script], {
      env: { ...ENV, OFFICE_STAGING_ORIGIN: `https://user:${ENV.OFFICE_STAGING_PASSWORD}@office.synthetic.test` },
      encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'Gourmet Office staging health check failed.\n');
    assert(!result.stderr.includes(ENV.OFFICE_STAGING_PASSWORD));
  });

  it('prints only a generic CLI failure when a fetch implementation throws a credential-bearing error', () => {
    const script = fileURLToPath(new URL('../../scripts/office-staging-health.mjs', import.meta.url));
    const source = `process.argv[1] = ${JSON.stringify(script)}; globalThis.fetch = async () => { throw new Error(process.env.OFFICE_STAGING_PASSWORD); }; await import(${JSON.stringify(new URL('../../scripts/office-staging-health.mjs', import.meta.url).href)});`;
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', source], { env: ENV, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'Gourmet Office staging health check failed.\n');
    assert(!result.stderr.includes(ENV.OFFICE_STAGING_PASSWORD));
  });
});
