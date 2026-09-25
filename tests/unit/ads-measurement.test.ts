import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { createPhoneEncryptor } from '../../src/backend/crypto';
import { loadAdsWorkerConfig, type AdsWorkerConfig } from '../../src/ads/config';
import type {
  ClaimedMeasurementJob,
  EnhancedConversionClient,
  EnhancedConversionDelivery,
  MeasurementLeadSnapshot,
  MeasurementOutboxStore,
} from '../../src/ads/contracts';
import { buildDataManagerRequest, DataManagerDeliveryError } from '../../src/ads/data-manager-client';
import { protos } from '@google-ads/datamanager';
import { hashPhoneForGoogle, normalizeUsPhoneE164 } from '../../src/ads/normalization';
import { MeasurementOutboxWorker } from '../../src/ads/outbox-worker';

const encryptionKeyBase64 = Buffer.alloc(32, 7).toString('base64');

function config(): AdsWorkerConfig {
  return {
    databaseUrl: 'postgres://unused', customerId: '1112667809', conversionActionId: '7476344812',
    deliveryMode: 'validate-only', measurementEnvironment: 'production', batchSize: 1, concurrency: 1,
    pollMs: 1_000, maxAttempts: 3, leaseMs: 30_000, encryptionKeyBase64, encryptionKeyId: 'v1', gitSha: null,
  };
}

function lead(consent: 'granted' | 'denied' = 'granted'): MeasurementLeadSnapshot {
  return {
    leadId: randomUUID(), isQa: false, createdAt: new Date('2026-09-25T12:00:00.000Z'),
    conversionId: 'a'.repeat(64),
    encryptedPhone: createPhoneEncryptor(encryptionKeyBase64, 'v1').encrypt('5035550199'),
    consent: { adStorage: consent, adUserData: consent, adPersonalization: 'denied', recordedAt: new Date() },
    clickIds: { gclid: 'safe-gclid', gbraid: 'safe-gbraid', wbraid: 'safe-wbraid' },
  };
}

class FakeStore implements MeasurementOutboxStore {
  completed = 0;
  deadCodes: string[] = [];
  retried = 0;
  claimCount = 0;
  constructor(readonly jobs: ClaimedMeasurementJob[], readonly snapshot: MeasurementLeadSnapshot) {}
  async claim() { return this.claimCount < this.jobs.length ? [this.jobs[this.claimCount++]] : []; }
  async loadLead() { return this.snapshot; }
  async complete() { this.completed += 1; }
  async retry() { this.retried += 1; }
  async dead(_job: ClaimedMeasurementJob, code: string) { this.deadCodes.push(code); }
  async heartbeat() {}
  async close() {}
}

class FakeClient implements EnhancedConversionClient {
  events: EnhancedConversionDelivery[] = [];
  failures = 0;
  async deliver(event: EnhancedConversionDelivery) {
    this.events.push(event);
    if (this.failures++ === 0) throw new DataManagerDeliveryError('unavailable', true);
    return { requestId: 'safe-request-id' };
  }
}

describe('Google Ads enhanced conversion preparation', () => {
  it('normalizes US phone and hashes the E.164 value exactly once', () => {
    assert.equal(normalizeUsPhoneE164('(503) 555-0199'), '+15035550199');
    assert.equal(hashPhoneForGoogle('5035550199'), '2bc813f4ba6c1bb27f0e1b7f69be1fc020528835d4c626b62ee8a4f74207c192');
  });

  it('builds a validate-only Data Manager request with one transaction ID', () => {
    const request = buildDataManagerRequest('1112667809', '7476344812', {
      transactionId: 'a'.repeat(64), eventTimestamp: '2026-09-25T12:00:00.000Z',
      phoneHash: hashPhoneForGoogle('5035550199'), adPersonalization: 'denied',
      clickIds: { gclid: 'safe-gclid', gbraid: 'safe-gbraid', wbraid: 'safe-wbraid' },
    }, true);
    assert.equal(request.validateOnly, true);
    assert.equal(request.destinations.length, 1);
    assert.equal(request.events.length, 1);
    assert.equal(request.events[0].transactionId, 'a'.repeat(64));
    assert.equal(request.events[0].userData?.userIdentifiers.length, 1);
    assert.equal(protos.google.ads.datamanager.v1.IngestEventsRequest.verify(request), null);
    assert.equal(JSON.stringify(request).includes('5035550199'), false);
  });

  it('blocks delivery when required consent is denied', async () => {
    const job = { outboxId: randomUUID(), leadId: randomUUID(), dedupeKey: 'b'.repeat(64), attemptCount: 1 };
    const store = new FakeStore([job], lead('denied'));
    const client = new FakeClient();
    const worker = new MeasurementOutboxWorker(config(), store, client, { info() {}, error() {} });
    await worker.pollOnce();
    assert.deepEqual(store.deadCodes, ['consent_not_granted']);
    assert.equal(client.events.length, 0);
  });

  it('retries with the same transaction ID and never logs plaintext PII', async () => {
    const job = { outboxId: randomUUID(), leadId: randomUUID(), dedupeKey: 'c'.repeat(64), attemptCount: 1 };
    const retryJob = { ...job, attemptCount: 2 };
    const store = new FakeStore([job, retryJob], lead());
    const client = new FakeClient();
    const logs: string[] = [];
    const worker = new MeasurementOutboxWorker(config(), store, client, {
      info(fields, message) { logs.push(JSON.stringify({ fields, message })); },
      error(fields, message) { logs.push(JSON.stringify({ fields, message })); },
    });
    await worker.pollOnce();
    await worker.pollOnce();
    assert.equal(store.retried, 1);
    assert.equal(store.completed, 1);
    assert.equal(client.events.length, 2);
    assert.equal(client.events[0].transactionId, client.events[1].transactionId);
    assert.equal(logs.join('').includes('5035550199'), false);
    assert.equal(logs.join('').includes('QA Enhanced'), false);
  });

  it('forbids live delivery from staging configuration', () => {
    assert.throws(() => loadAdsWorkerConfig({
      DATABASE_URL: 'postgres://unused', GOOGLE_ADS_CUSTOMER_ID: '1112667809',
      GOOGLE_ADS_CONVERSION_ACTION_ID: '7476344812', GOOGLE_ADS_DELIVERY_MODE: 'live',
      MEASUREMENT_ENVIRONMENT: 'staging', LEAD_ENCRYPTION_KEY_BASE64: encryptionKeyBase64,
    }), /requires MEASUREMENT_ENVIRONMENT=production/);
  });
});
