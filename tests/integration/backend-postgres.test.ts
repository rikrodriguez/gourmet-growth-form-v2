import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/backend/app';
import type { BackendConfig } from '../../src/backend/config';
import { createPhoneEncryptor } from '../../src/backend/crypto';
import { createPostgresStore } from '../../src/backend/postgres-store';
import { eventFixture } from '../helpers/fixtures';

const { Pool } = pg;
const databaseUrl = process.env.TEST_DATABASE_URL;

describe('PostgreSQL backend integration', { skip: !databaseUrl, concurrency: 1 }, () => {
  let app: FastifyInstance;
  let inspection: pg.Pool;
  let runtimeCheck: pg.Pool;
  const origin = 'https://gourmet-corporation.com';

  before(async () => {
    const config: BackendConfig = {
      environment: 'test', host: '127.0.0.1', port: 3001,
      databaseUrl: databaseUrl!, allowedOrigins: [origin], allowMissingOrigin: false,
      bodyLimitBytes: 262_144, rateLimitMax: 1_000, rateLimitWindow: '1 minute',
      appVersion: 'integration-test', gitSha: 'integration-test',
      trustProxy: false,
      encryptionKeyBase64: Buffer.alloc(32, 7).toString('base64'),
      encryptionKeyId: 'integration-v1', qaMarkerSecret: 'qa-secret',
    };
    const store = createPostgresStore(databaseUrl!);
    app = await buildApp({
      config,
      store,
      phoneEncryptor: createPhoneEncryptor(config.encryptionKeyBase64, config.encryptionKeyId),
    });
    inspection = new Pool({ connectionString: process.env.TEST_ADMIN_DATABASE_URL ?? databaseUrl });
    runtimeCheck = new Pool({ connectionString: databaseUrl });
    await inspection.query(`
      TRUNCATE growth_v2.events, growth_v2.lead_answers, growth_v2.leads,
               growth_v2.attribution_touches, growth_v2.sessions, growth_v2.visitors CASCADE
    `);
  });

  after(async () => {
    await app?.close();
    await inspection?.end();
    await runtimeCheck?.end();
  });

  it('reports health with verified database connectivity', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(response.statusCode, 200);
    assert.match(response.headers['x-request-id'] ?? '', /^[0-9a-f-]{36}$/i);
    assert.deepEqual(response.json(), {
      status: 'ok', database: 'connected', version: 'integration-test', git_sha: 'integration-test',
    });
  });

  it('keeps destructive schema and delete privileges away from the runtime role', async () => {
    if (!process.env.TEST_ADMIN_DATABASE_URL) return;
    const client = await runtimeCheck.connect();
    try {
      await client.query('BEGIN');
      await assert.rejects(() => client.query('DELETE FROM growth_v2.events'));
      await client.query('ROLLBACK');
      await client.query('BEGIN');
      await assert.rejects(() => client.query('ALTER TABLE growth_v2.events ADD COLUMN forbidden_test text'));
      await client.query('ROLLBACK');
      await client.query('BEGIN');
      await assert.rejects(() => client.query("UPDATE growth_v2.events SET event_name = 'step_viewed'"));
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('accepts events, upserts visitor/session/attribution, and deduplicates event_id', async () => {
    const visitorId = randomUUID();
    const sessionId = randomUUID();
    const first = eventFixture({ visitor_id: visitorId, session_id: sessionId });
    const second = eventFixture({ visitor_id: visitorId, session_id: sessionId, step_id: 'service', step_index: 2 });
    const headers = {
      origin, 'content-type': 'application/json',
      'x-gourmet-qa-test': 'true', 'x-gourmet-qa-secret': 'qa-secret',
    };
    const accepted = await app.inject({
      method: 'POST', url: '/v1/events/batch', headers, payload: { events: [first, second] },
    });
    assert.equal(accepted.statusCode, 200);
    assert.equal(accepted.json().accepted, 2);
    assert.equal(accepted.json().duplicates, 0);

    const duplicate = await app.inject({
      method: 'POST', url: '/v1/events/batch', headers, payload: { events: [first] },
    });
    assert.equal(duplicate.statusCode, 200);
    assert.equal(duplicate.json().accepted, 0);
    assert.equal(duplicate.json().duplicates, 1);
    assert.deepEqual(duplicate.json().acknowledged_event_ids, [first.event_id]);

    const counts = await inspection.query(
      `SELECT
        (SELECT count(*)::int FROM growth_v2.visitors WHERE visitor_id = $1) AS visitors,
        (SELECT count(*)::int FROM growth_v2.sessions WHERE session_id = $2) AS sessions,
        (SELECT count(*)::int FROM growth_v2.events WHERE session_id = $2) AS events,
        (SELECT count(*)::int FROM growth_v2.attribution_touches WHERE session_id = $2) AS touches`,
      [visitorId, sessionId],
    );
    assert.deepEqual(counts.rows[0], { visitors: 1, sessions: 1, events: 2, touches: 2 });
  });

  it('returns structured rejections for unknown events and PII', async () => {
    const unknown = { ...eventFixture(), event_name: 'lost' };
    const pii = eventFixture({ properties: { nested: { formData: { phone: '5035550123' } } } } as never);
    const response = await app.inject({
      method: 'POST', url: '/v1/events/batch',
      headers: { origin, 'content-type': 'application/json' },
      payload: { events: [unknown, pii] },
    });
    assert.equal(response.statusCode, 422);
    assert.deepEqual(response.json().rejections.map((item: { code: string }) => item.code), [
      'unsupported_contract', 'pii_key_rejected',
    ]);
  });

  it('captures one encrypted lead per session and progressively updates allowlisted answers', async () => {
    const visitorId = randomUUID();
    const sessionId = randomUUID();
    const idempotencyKey = randomUUID();
    const rawPhone = '5035550123';
    const capturePayload = {
      visitor_id: visitorId,
      session_id: sessionId,
      phone: rawPhone,
      intent_cluster: 'bbq',
      idempotency_key: idempotencyKey,
      attribution: eventFixture().attribution,
      answers: { guest_range: '26-50', service_style: 'full-service', zip_code: '97205' },
    };
    const headers = {
      origin, 'content-type': 'application/json',
      'x-gourmet-qa-test': 'true', 'x-gourmet-qa-secret': 'qa-secret',
    };
    const created = await app.inject({
      method: 'POST', url: '/v1/leads/capture-phone', headers, payload: capturePayload,
    });
    assert.equal(created.statusCode, 201);
    assert.equal(created.json().status, 'created');
    const leadId = created.json().lead_id as string;

    const repeated = await app.inject({
      method: 'POST', url: '/v1/leads/capture-phone', headers, payload: capturePayload,
    });
    assert.equal(repeated.statusCode, 200);
    assert.equal(repeated.json().lead_id, leadId);
    assert.equal(repeated.json().status, 'existing');

    const storedLead = await inspection.query(
      `SELECT count(*)::int AS count, max(phone_ciphertext) AS ciphertext
       FROM growth_v2.leads WHERE session_id = $1`,
      [sessionId],
    );
    assert.equal(storedLead.rows[0].count, 1);
    assert.notEqual(storedLead.rows[0].ciphertext, rawPhone);
    assert.ok(!JSON.stringify(storedLead.rows[0]).includes(rawPhone));

    const updated = await app.inject({
      method: 'PATCH', url: `/v1/leads/${leadId}`,
      headers: { origin, 'content-type': 'application/json', 'x-gourmet-session-id': sessionId },
      payload: { event_type: 'Corporate', date_window: 'still-deciding', first_name: 'QA Test' },
    });
    assert.equal(updated.statusCode, 200);
    const answers = await inspection.query<{ field_key: string; field_value: string }>(
      'SELECT field_key, field_value FROM growth_v2.lead_answers WHERE lead_id = $1 ORDER BY field_key',
      [leadId],
    );
    assert.deepEqual(Object.fromEntries(answers.rows.map((row) => [row.field_key, row.field_value])), {
      date_window: 'still-deciding', event_type: 'Corporate', first_name: 'QA Test',
      guest_range: '26-50', service_style: 'full-service', zip_code: '97205',
    });

    const arbitrary = await app.inject({
      method: 'PATCH', url: `/v1/leads/${leadId}`,
      headers: { origin, 'content-type': 'application/json', 'x-gourmet-session-id': sessionId },
      payload: { status: 'won' },
    });
    assert.equal(arbitrary.statusCode, 422);
  });

  it('rejects invalid phone input without creating a lead', async () => {
    const before = await inspection.query<{ count: number }>('SELECT count(*)::int AS count FROM growth_v2.leads');
    const response = await app.inject({
      method: 'POST', url: '/v1/leads/capture-phone',
      headers: { origin, 'content-type': 'application/json' },
      payload: {
        visitor_id: randomUUID(), session_id: randomUUID(), phone: '12345',
        intent_cluster: 'bbq', idempotency_key: randomUUID(),
      },
    });
    assert.equal(response.statusCode, 422);
    assert.equal(response.json().error, 'invalid_phone');
    const afterCount = await inspection.query<{ count: number }>('SELECT count(*)::int AS count FROM growth_v2.leads');
    assert.equal(afterCount.rows[0].count, before.rows[0].count);
  });
});
