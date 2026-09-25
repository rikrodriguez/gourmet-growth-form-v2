import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/backend/app';
import type { BackendConfig } from '../../src/backend/config';
import type { GrowthDataStore } from '../../src/backend/contracts';
import { eventFixture } from '../helpers/fixtures';

const config: BackendConfig = {
  environment: 'test',
  host: '127.0.0.1',
  port: 3001,
  databaseUrl: 'postgres://not-used',
  allowedOrigins: ['https://gourmet-corporation.com'],
  allowMissingOrigin: false,
  bodyLimitBytes: 1_024,
  rateLimitMax: 120,
  rateLimitWindow: '1 minute',
  appVersion: 'test',
  gitSha: 'test-sha',
  trustProxy: false,
  encryptionKeyBase64: Buffer.alloc(32).toString('base64'),
  encryptionKeyId: 'test',
  qaMarkerSecret: null,
  measurementEnvironment: 'staging',
  googleAdsCustomerId: null,
  googleAdsConversionActionId: null,
};

function fakeStore(overrides: Partial<GrowthDataStore> = {}): GrowthDataStore {
  return {
    async health() {},
    async ingestEvents(events) {
      return { accepted_event_ids: events.map((event) => event.event_id), duplicate_event_ids: [] };
    },
    async captureLead() { return { leadId: randomUUID(), conversionId: 'a'.repeat(64), status: 'created' }; },
    async updateLead() { return true; },
    async cleanupQa() { return { events: 0, leads: 0, sessions: 0, visitors: 0 }; },
    async close() {},
    ...overrides,
  };
}

const apps: FastifyInstance[] = [];

async function appFor(store: GrowthDataStore, configOverride: Partial<BackendConfig> = {}) {
  const app = await buildApp({
    config: { ...config, ...configOverride },
    store,
    phoneEncryptor: { encrypt: () => ({ ciphertext: 'cipher', iv: 'iv', authTag: 'tag', keyId: 'test' }) },
  });
  apps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('API security and failures', () => {
  it('gates enhanced conversion eligibility on production, consent, configuration, and QA exclusion', async () => {
    const captured: Array<{ eligible: boolean; isQa: boolean }> = [];
    const store = fakeStore({
      async captureLead(input, isQa) {
        captured.push({ eligible: input.enhancedConversionEligible, isQa });
        return { leadId: randomUUID(), conversionId: 'c'.repeat(64), status: 'created' };
      },
    });
    const app = await appFor(store, {
      measurementEnvironment: 'production',
      googleAdsCustomerId: '1112667809',
      googleAdsConversionActionId: '7476344812',
      qaMarkerSecret: 'qa-secret',
    });
    const payload = {
      visitor_id: randomUUID(), session_id: randomUUID(), phone: '5035550123',
      intent_cluster: 'bbq', idempotency_key: randomUUID(),
      measurement_consent: {
        version: 1, updated_at: new Date().toISOString(),
        ad_storage: 'granted', ad_user_data: 'granted', ad_personalization: 'denied',
      },
    };
    const allowed = await app.inject({
      method: 'POST', url: '/v1/leads/capture-phone',
      headers: { origin: config.allowedOrigins[0], 'content-type': 'application/json' },
      payload,
    });
    assert.equal(allowed.statusCode, 201);
    assert.match(allowed.json().conversion_id, /^[a-f0-9]{64}$/);

    await app.inject({
      method: 'POST', url: '/v1/leads/capture-phone',
      headers: {
        origin: config.allowedOrigins[0], 'content-type': 'application/json',
        'x-gourmet-qa-test': 'true', 'x-gourmet-qa-secret': 'qa-secret',
      },
      payload: { ...payload, session_id: randomUUID(), idempotency_key: randomUUID() },
    });
    await app.inject({
      method: 'POST', url: '/v1/leads/capture-phone',
      headers: { origin: config.allowedOrigins[0], 'content-type': 'application/json' },
      payload: {
        ...payload, session_id: randomUUID(), idempotency_key: randomUUID(),
        measurement_consent: { ...payload.measurement_consent, ad_user_data: 'denied' },
      },
    });
    assert.deepEqual(captured, [
      { eligible: true, isQa: false },
      { eligible: false, isQa: true },
      { eligible: false, isQa: false },
    ]);
  });

  it('returns a real service error after database failure', async () => {
    const app = await appFor(fakeStore({ async ingestEvents() { throw new Error('db_down'); } }));
    const response = await app.inject({
      method: 'POST',
      url: '/v1/events/batch',
      headers: { origin: config.allowedOrigins[0], 'content-type': 'application/json' },
      payload: { events: [eventFixture()] },
    });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().error, 'database_unavailable');
  });

  it('rejects forbidden origins, non-JSON content, PII, and oversized bodies', async () => {
    const app = await appFor(fakeStore());
    const forbidden = await app.inject({
      method: 'POST', url: '/v1/events/batch',
      headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
      payload: { events: [eventFixture()] },
    });
    assert.equal(forbidden.statusCode, 403);

    const nonJson = await app.inject({
      method: 'POST', url: '/v1/events/batch',
      headers: { origin: config.allowedOrigins[0], 'content-type': 'text/plain' },
      payload: 'not-json',
    });
    assert.equal(nonJson.statusCode, 415);

    const pii = await app.inject({
      method: 'POST', url: '/v1/events/batch',
      headers: { origin: config.allowedOrigins[0], 'content-type': 'application/json' },
      payload: { events: [eventFixture({ properties: { nested: { phone_number: '5035550123' } } } as never)] },
    });
    assert.equal(pii.statusCode, 422);
    assert.equal(pii.json().rejections[0].code, 'pii_key_rejected');

    const oversized = await app.inject({
      method: 'POST', url: '/v1/events/batch',
      headers: { origin: config.allowedOrigins[0], 'content-type': 'application/json' },
      payload: JSON.stringify({ events: [], padding: 'x'.repeat(2_000) }),
    });
    assert.equal(oversized.statusCode, 413);
  });

  it('rate limits repeated lead capture attempts', async () => {
    const app = await appFor(fakeStore());
    let lastStatus = 0;
    for (let attempt = 0; attempt < 21; attempt += 1) {
      const response = await app.inject({
        method: 'POST', url: '/v1/leads/capture-phone',
        headers: { origin: config.allowedOrigins[0], 'content-type': 'application/json' },
        payload: {
          visitor_id: randomUUID(), session_id: randomUUID(), phone: '5035550123',
          intent_cluster: 'bbq', idempotency_key: randomUUID(),
        },
      });
      lastStatus = response.statusCode;
    }
    assert.equal(lastStatus, 429);
  });
});
