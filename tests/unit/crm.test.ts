import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { createPhoneEncryptor } from '../../src/backend/crypto';
import type { ClaimedCrmJob, CrmLeadSnapshot, CrmOutboxStore, MondayClient, MondayItem } from '../../src/crm/contracts';
import type { CrmWorkerConfig } from '../../src/crm/config';
import { createMondayClient, MondayApiError } from '../../src/crm/monday-client';
import { mondayCreateColumns, mondayItemName, mondayUpdateColumns, MONDAY_COLUMNS } from '../../src/crm/monday-mapping';
import { CrmOutboxWorker } from '../../src/crm/outbox-worker';

const key = randomBytes(32).toString('base64');
const encryptedPhone = createPhoneEncryptor(key, 'v1').encrypt('5035550199');

function lead(overrides: Partial<CrmLeadSnapshot> = {}): CrmLeadSnapshot {
  return {
    leadId: 'a81f2c00-0000-4000-8000-000000000001',
    createdAt: new Date('2026-09-24T18:00:00Z'),
    isQa: false,
    mondayItemId: null,
    encryptedPhone,
    answers: { guest_range: '26-50', service_style: 'full-service', zip_code: '97205' },
    utmTerm: 'portland catering',
    landingUrl: 'https://gourmet-corporation.com/form2/bbq/',
    ...overrides,
  };
}

function job(overrides: Partial<ClaimedCrmJob> = {}): ClaimedCrmJob {
  return {
    outboxId: randomUUID(), leadId: lead().leadId, dedupeKey: randomUUID(), payloadVersion: 1,
    attemptCount: 1, createAttemptedAt: null, ...overrides,
  };
}

function workerConfig(): CrmWorkerConfig {
  return {
    databaseUrl: 'postgres://unused', token: 'secret-token-never-log', boardId: '18403945258',
    groupId: 'group_mm1etwgc', batchSize: 10, concurrency: 2, pollMs: 10_000, maxAttempts: 8,
    leaseMs: 120_000, ambiguousWindowMs: 1_500_000, encryptionKeyBase64: key,
    encryptionKeyId: 'v1', gitSha: 'test-sha',
  };
}

class FakeStore implements CrmOutboxStore {
  jobs: ClaimedCrmJob[] = [];
  snapshot: CrmLeadSnapshot | null = lead();
  completed = 0;
  retries: string[] = [];
  deadCodes: string[] = [];
  async health() {}
  async heartbeat() {}
  async claim() { return this.jobs.splice(0); }
  async loadLead() { return this.snapshot; }
  async markCreateAttempted() { return new Date(); }
  async saveMondayItem(_leadId: string, item: MondayItem) { if (this.snapshot) this.snapshot.mondayItemId = item.id; }
  async complete() { this.completed += 1; }
  async retry(_job: ClaimedCrmJob, code: string) { this.retries.push(code); }
  async dead(_job: ClaimedCrmJob, code: string) { this.deadCodes.push(code); }
  async close() {}
}

class FakeMonday implements MondayClient {
  creates = 0;
  updates = 0;
  error: Error | null = null;
  async preflight() { return { boardId: '18403945258', boardName: 'Lead Management', groupId: 'group_mm1etwgc', groupName: 'List of Leads' }; }
  async createLead() { this.creates += 1; if (this.error) throw this.error; return { id: '123', name: 'lead', url: 'https://acme.monday.com/boards/18403945258/pulses/123' }; }
  async updateLead() { this.updates += 1; if (this.error) throw this.error; return { id: '123', name: 'lead', url: 'https://acme.monday.com/boards/18403945258/pulses/123' }; }
  async getItem() { return null; }
  async archiveItem() {}
}

describe('Monday CRM mapping', () => {
  it('maps create fields without PII in item name or URL and sets New', () => {
    const snapshot = lead();
    const values = mondayCreateColumns(snapshot, '5035550199');
    assert.equal(mondayItemName(snapshot), 'BBQ Lead — a81f2c');
    assert.deepEqual(values[MONDAY_COLUMNS.status], { label: 'New' });
    assert.equal(values[MONDAY_COLUMNS.guests], '26-50 Guests');
    assert.equal(values[MONDAY_COLUMNS.service], 'Full Service Staff');
    assert.equal(values[MONDAY_COLUMNS.zip], '97205');
    assert.equal(values[MONDAY_COLUMNS.fullUrl], snapshot.landingUrl);
    assert.ok(!mondayItemName(snapshot).includes('5035550199'));
  });

  it('renames QA leads safely, maps exact dates, and clears flexible dates', () => {
    const exact = lead({ isQa: true, answers: { first_name: 'QA Monday', date_window: 'exact', exact_date: '2026-11-04' } });
    assert.equal(mondayItemName(exact), '[QA] QA Monday');
    assert.deepEqual(mondayUpdateColumns(exact, '5035550199')[MONDAY_COLUMNS.eventDate], { date: '2026-11-04' });
    const flexible = lead({ answers: { date_window: 'still-deciding' } });
    assert.equal(mondayUpdateColumns(flexible, '5035550199')[MONDAY_COLUMNS.eventDate], null);
  });
});

describe('Monday API client safety', () => {
  it('sends a stable idempotency key for create and never includes the token in errors', async () => {
    let headers: HeadersInit | undefined;
    const client = createMondayClient({
      token: 'super-secret-token', boardId: '18403945258', groupId: 'group_mm1etwgc',
      request: async (_url, init) => {
        headers = init?.headers;
        return new Response(JSON.stringify({ data: { create_item: { id: '123', name: 'Lead', url: 'https://acme.monday.com/boards/18403945258/pulses/123' } } }), { status: 200 });
      },
    });
    await client.createLead('Lead', {}, 'stable-key');
    assert.equal(new Headers(headers).get('idempotency-key'), 'stable-key');
    assert.equal(JSON.stringify(headers).includes('super-secret-token'), true);
  });

  it('classifies rate limits as retryable and honors Retry-After', async () => {
    const client = createMondayClient({
      token: 'token', boardId: '18403945258', groupId: 'group_mm1etwgc',
      request: async () => new Response('{}', { status: 429, headers: { 'retry-after': '7' } }),
    });
    await assert.rejects(client.createLead('Lead', {}, 'key'), (error: MondayApiError) => {
      assert.equal(error.code, 'monday_rate_limited');
      assert.equal(error.retryable, true);
      assert.equal(error.retryAfterMs, 7000);
      assert.ok(!error.message.includes('token'));
      return true;
    });
  });

  it('blocks a mismatched live schema before writes', async () => {
    const client = createMondayClient({
      token: 'token', boardId: '18403945258', groupId: 'group_mm1etwgc',
      request: async () => new Response(JSON.stringify({ data: { boards: [{ id: '18403945258', name: 'Lead Management', groups: [{ id: 'group_mm1etwgc', title: 'List of Leads' }], columns: [] }] } }), { status: 200 }),
    });
    await assert.rejects(client.preflight(), (error: MondayApiError) => error.code.startsWith('column_mismatch_'));
  });
});

describe('CRM outbox worker', () => {
  it('creates exactly one item and completes the claimed job', async () => {
    const store = new FakeStore(); const monday = new FakeMonday(); store.jobs.push(job());
    const worker = new CrmOutboxWorker(workerConfig(), store, monday, { info() {}, error() {} });
    assert.equal(await worker.pollOnce(), 1);
    assert.equal(monday.creates, 1);
    assert.equal(monday.updates, 0);
    assert.equal(store.completed, 1);
  });

  it('uses the existing monday_item_id and updates the same item', async () => {
    const store = new FakeStore(); const monday = new FakeMonday();
    store.snapshot = lead({ mondayItemId: '123', answers: { first_name: 'Ricardo', event_type: 'Corporate' } });
    store.jobs.push(job({ payloadVersion: 2 }));
    const worker = new CrmOutboxWorker(workerConfig(), store, monday, { info() {}, error() {} });
    await worker.pollOnce();
    assert.equal(monday.creates, 0);
    assert.equal(monday.updates, 1);
    assert.equal(store.completed, 1);
  });

  it('fails closed after the ambiguous create window without creating again', async () => {
    const store = new FakeStore(); const monday = new FakeMonday();
    store.jobs.push(job({ createAttemptedAt: new Date(Date.now() - 1_600_000), attemptCount: 2 }));
    const worker = new CrmOutboxWorker(workerConfig(), store, monday, { info() {}, error() {} });
    await worker.pollOnce();
    assert.equal(monday.creates, 0);
    assert.deepEqual(store.deadCodes, ['ambiguous_create_window_expired']);
  });

  it('retries transient errors and logs neither phone nor token', async () => {
    const store = new FakeStore(); const monday = new FakeMonday(); const logs: string[] = [];
    monday.error = new MondayApiError('monday_server_error', true, 1, true);
    store.jobs.push(job());
    const worker = new CrmOutboxWorker(workerConfig(), store, monday, {
      info(fields, message) { logs.push(JSON.stringify({ fields, message })); },
      error(fields, message) { logs.push(JSON.stringify({ fields, message })); },
    });
    await worker.pollOnce();
    assert.deepEqual(store.retries, ['monday_server_error']);
    assert.ok(!logs.join('').includes('5035550199'));
    assert.ok(!logs.join('').includes('secret-token-never-log'));
  });

  it('dead-letters permanent mapping errors', async () => {
    const store = new FakeStore(); const monday = new FakeMonday();
    monday.error = new MondayApiError('monday_graphql_permanent', false);
    store.jobs.push(job());
    const worker = new CrmOutboxWorker(workerConfig(), store, monday, { info() {}, error() {} });
    await worker.pollOnce();
    assert.deepEqual(store.deadCodes, ['monday_graphql_permanent']);
  });
});
