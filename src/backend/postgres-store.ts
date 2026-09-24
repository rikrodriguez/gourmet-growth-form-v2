import { randomUUID } from 'node:crypto';
import pg, { type PoolClient } from 'pg';
import { ATTRIBUTION_KEYS, type AttributionTouch, type GourmetTelemetryEvent } from '../telemetry/types';
import type {
  EventBatchResult,
  GrowthDataStore,
  LeadAnswers,
  LeadCaptureRecord,
  LeadCaptureResult,
} from './contracts';

const { Pool } = pg;

export class DataConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DataConflictError';
  }
}

export function createPostgresStore(databaseUrl: string): GrowthDataStore {
  const pool = new Pool({ connectionString: databaseUrl, max: 10, idleTimeoutMillis: 30_000 });
  return new PostgresGrowthDataStore(pool);
}

class PostgresGrowthDataStore implements GrowthDataStore {
  constructor(private readonly pool: pg.Pool) {}

  async health() {
    await this.pool.query('SELECT 1');
  }

  private async transaction<Value>(operation: (client: PoolClient) => Promise<Value>): Promise<Value> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async ingestEvents(events: GourmetTelemetryEvent[], isQa: boolean): Promise<EventBatchResult> {
    return this.transaction(async (client) => {
      const accepted_event_ids: string[] = [];
      const duplicate_event_ids: string[] = [];

      for (const event of events) {
        const occurredAt = new Date(event.occurred_at);
        const startedAt = new Date(occurredAt.getTime() - event.session_elapsed_ms);
        await client.query(
          `INSERT INTO growth_v2.visitors (visitor_id, first_seen_at, last_seen_at)
           VALUES ($1, $2, $2)
           ON CONFLICT (visitor_id) DO UPDATE
           SET first_seen_at = LEAST(growth_v2.visitors.first_seen_at, EXCLUDED.first_seen_at),
               last_seen_at = GREATEST(growth_v2.visitors.last_seen_at, EXCLUDED.last_seen_at)`,
          [event.visitor_id, occurredAt],
        );

        const session = await client.query<{ visitor_id: string }>(
          `INSERT INTO growth_v2.sessions (
             session_id, visitor_id, intent_cluster, landing_path, started_at, last_seen_at,
             completed_at, last_step_id, last_step_index, experiment_id, variant_id, is_qa
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           ON CONFLICT (session_id) DO UPDATE
           SET started_at = LEAST(growth_v2.sessions.started_at, EXCLUDED.started_at),
               last_seen_at = GREATEST(growth_v2.sessions.last_seen_at, EXCLUDED.last_seen_at),
               completed_at = COALESCE(growth_v2.sessions.completed_at, EXCLUDED.completed_at),
               last_step_id = CASE WHEN EXCLUDED.last_seen_at >= growth_v2.sessions.last_seen_at THEN EXCLUDED.last_step_id ELSE growth_v2.sessions.last_step_id END,
               last_step_index = CASE WHEN EXCLUDED.last_seen_at >= growth_v2.sessions.last_seen_at THEN EXCLUDED.last_step_index ELSE growth_v2.sessions.last_step_index END,
               updated_at = now(),
               is_qa = growth_v2.sessions.is_qa OR EXCLUDED.is_qa
           RETURNING visitor_id`,
          [
            event.session_id,
            event.visitor_id,
            event.intent_cluster,
            event.attribution.first_touch.landing_path,
            startedAt,
            occurredAt,
            event.event_name === 'form_completed' ? occurredAt : null,
            event.step_id,
            event.step_index,
            event.experiment_id,
            event.variant_id,
            isQa,
          ],
        );
        if (session.rows[0].visitor_id !== event.visitor_id) {
          throw new DataConflictError('Session is already associated with another visitor.');
        }

        await this.persistAttribution(client, event.session_id, 'first', event.attribution.first_touch);
        await this.persistAttribution(client, event.session_id, 'latest', event.attribution.latest_touch);

        const inserted = await client.query(
          `INSERT INTO growth_v2.events (
             event_id, session_id, visitor_id, schema_version, event_name, occurred_at,
             intent_cluster, route, step_id, step_index, step_duration_ms, session_elapsed_ms,
             properties, attribution, experiment_id, variant_id, is_qa
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
             $13::jsonb, $14::jsonb, $15, $16, $17
           ) ON CONFLICT (event_id) DO NOTHING
           RETURNING event_id`,
          [
            event.event_id,
            event.session_id,
            event.visitor_id,
            event.schema_version,
            event.event_name,
            occurredAt,
            event.intent_cluster,
            event.route,
            event.step_id,
            event.step_index,
            event.step_duration_ms,
            event.session_elapsed_ms,
            JSON.stringify(event.properties),
            JSON.stringify(event.attribution),
            event.experiment_id,
            event.variant_id,
            isQa,
          ],
        );
        if (inserted.rowCount === 1) accepted_event_ids.push(event.event_id);
        else duplicate_event_ids.push(event.event_id);
      }

      return { accepted_event_ids, duplicate_event_ids };
    });
  }

  async captureLead(input: LeadCaptureRecord, isQa: boolean): Promise<LeadCaptureResult> {
    return this.transaction(async (client) => {
      const now = new Date();
      await client.query(
        `INSERT INTO growth_v2.visitors (visitor_id, first_seen_at, last_seen_at)
         VALUES ($1, $2, $2)
         ON CONFLICT (visitor_id) DO UPDATE SET last_seen_at = GREATEST(growth_v2.visitors.last_seen_at, EXCLUDED.last_seen_at)`,
        [input.visitor_id, now],
      );
      const session = await client.query<{ visitor_id: string }>(
        `INSERT INTO growth_v2.sessions (
           session_id, visitor_id, intent_cluster, landing_path, started_at, last_seen_at, is_qa
         ) VALUES ($1, $2, $3, $4, $5, $5, $6)
         ON CONFLICT (session_id) DO UPDATE
         SET started_at = LEAST(growth_v2.sessions.started_at, EXCLUDED.started_at),
             last_seen_at = GREATEST(growth_v2.sessions.last_seen_at, EXCLUDED.last_seen_at),
             updated_at = now(), is_qa = growth_v2.sessions.is_qa OR EXCLUDED.is_qa
         RETURNING visitor_id`,
        [
          input.session_id,
          input.visitor_id,
          input.intent_cluster,
          input.attribution?.first_touch.landing_path ?? '/form2/bbq/',
          now,
          isQa,
        ],
      );
      if (session.rows[0].visitor_id !== input.visitor_id) {
        throw new DataConflictError('Session is already associated with another visitor.');
      }

      const idempotencyOwner = await client.query<{ lead_id: string; session_id: string }>(
        'SELECT lead_id, session_id FROM growth_v2.leads WHERE capture_idempotency_key = $1 FOR UPDATE',
        [input.idempotency_key],
      );
      if (idempotencyOwner.rowCount && idempotencyOwner.rows[0].session_id !== input.session_id) {
        throw new DataConflictError('Idempotency key is already associated with another session.');
      }

      const existing = await client.query<{ lead_id: string; capture_idempotency_key: string }>(
        'SELECT lead_id, capture_idempotency_key FROM growth_v2.leads WHERE session_id = $1 AND deleted_at IS NULL FOR UPDATE',
        [input.session_id],
      );

      let result: LeadCaptureResult;
      if (existing.rowCount) {
        const row = existing.rows[0];
        if (row.capture_idempotency_key === input.idempotency_key) {
          result = { leadId: row.lead_id, status: 'existing' };
        } else {
          await client.query(
            `UPDATE growth_v2.leads
             SET capture_idempotency_key = $2, phone_ciphertext = $3, phone_iv = $4,
                 phone_auth_tag = $5, phone_key_id = $6, updated_at = now()
             WHERE lead_id = $1`,
            [
              row.lead_id,
              input.idempotency_key,
              input.encryptedPhone.ciphertext,
              input.encryptedPhone.iv,
              input.encryptedPhone.authTag,
              input.encryptedPhone.keyId,
            ],
          );
          result = { leadId: row.lead_id, status: 'updated' };
        }
      } else {
        const leadId = randomUUID();
        await client.query(
          `INSERT INTO growth_v2.leads (
             lead_id, session_id, visitor_id, intent_cluster, capture_idempotency_key,
             phone_ciphertext, phone_iv, phone_auth_tag, phone_key_id, is_qa
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            leadId,
            input.session_id,
            input.visitor_id,
            input.intent_cluster,
            input.idempotency_key,
            input.encryptedPhone.ciphertext,
            input.encryptedPhone.iv,
            input.encryptedPhone.authTag,
            input.encryptedPhone.keyId,
            isQa,
          ],
        );
        result = { leadId, status: 'created' };
      }

      await this.persistLeadAnswers(client, result.leadId, input.answers ?? {});
      if (input.attribution) {
        await this.persistAttribution(client, input.session_id, 'first', input.attribution.first_touch);
        await this.persistAttribution(client, input.session_id, 'latest', input.attribution.latest_touch);
      }
      await client.query(
        `INSERT INTO growth_v2.crm_outbox (outbox_id, lead_id, dedupe_key)
         VALUES ($1, $2, $1)
         ON CONFLICT (lead_id) DO NOTHING`,
        [randomUUID(), result.leadId],
      );
      if (result.status === 'updated') {
        await client.query(
          `UPDATE growth_v2.crm_outbox
           SET payload_version=payload_version+1,
               operation=CASE WHEN delivered_version=0 THEN 'create_lead' ELSE 'update_lead' END,
               status=CASE WHEN status IN ('dead','processing') THEN status ELSE 'pending' END,
               next_attempt_at=CASE WHEN status='processing' THEN next_attempt_at ELSE now() END,
               completed_at=NULL,updated_at=now()
           WHERE lead_id=$1`,
          [result.leadId],
        );
      }
      await client.query(
        `UPDATE growth_v2.leads SET crm_status = CASE
           WHEN crm_status='dead' THEN 'dead'
           WHEN $2 OR crm_status='not_queued' THEN 'pending'
           ELSE crm_status END
         WHERE lead_id = $1`,
        [result.leadId, result.status === 'updated'],
      );
      return result;
    });
  }

  async updateLead(leadId: string, sessionId: string, answers: LeadAnswers): Promise<boolean> {
    return this.transaction(async (client) => {
      const found = await client.query<{ lead_id: string }>(
        `UPDATE growth_v2.leads
         SET updated_at = now(), status = CASE WHEN $3 THEN 'completed' ELSE status END
         WHERE lead_id = $1 AND session_id = $2 AND deleted_at IS NULL
         RETURNING lead_id`,
        [leadId, sessionId, Object.hasOwn(answers, 'first_name')],
      );
      if (!found.rowCount) return false;
      await this.persistLeadAnswers(client, leadId, answers);
      await client.query(
        `UPDATE growth_v2.crm_outbox
         SET payload_version = payload_version + 1,
             operation = CASE WHEN delivered_version = 0 THEN 'create_lead' ELSE 'update_lead' END,
             status = CASE WHEN status IN ('dead','processing') THEN status ELSE 'pending' END,
             next_attempt_at = CASE WHEN status='processing' THEN next_attempt_at ELSE now() END,
             completed_at = NULL, updated_at = now()
         WHERE lead_id = $1`,
        [leadId],
      );
      await client.query(
        `UPDATE growth_v2.leads
         SET crm_status = CASE WHEN crm_status = 'dead' THEN 'dead' ELSE 'pending' END
         WHERE lead_id = $1`,
        [leadId],
      );
      return true;
    });
  }

  async cleanupQa() {
    return this.transaction(async (client) => {
      const events = await client.query('DELETE FROM growth_v2.events WHERE is_qa = true');
      const leads = await client.query('DELETE FROM growth_v2.leads WHERE is_qa = true');
      const sessions = await client.query('DELETE FROM growth_v2.sessions WHERE is_qa = true');
      const visitors = await client.query(
        `DELETE FROM growth_v2.visitors v
         WHERE NOT EXISTS (SELECT 1 FROM growth_v2.sessions s WHERE s.visitor_id = v.visitor_id)
           AND NOT EXISTS (SELECT 1 FROM growth_v2.leads l WHERE l.visitor_id = v.visitor_id)
           AND NOT EXISTS (SELECT 1 FROM growth_v2.events e WHERE e.visitor_id = v.visitor_id)`,
      );
      return {
        events: events.rowCount ?? 0,
        leads: leads.rowCount ?? 0,
        sessions: sessions.rowCount ?? 0,
        visitors: visitors.rowCount ?? 0,
      };
    });
  }

  async close() {
    await this.pool.end();
  }

  private async persistLeadAnswers(client: PoolClient, leadId: string, answers: LeadAnswers) {
    for (const [fieldKey, fieldValue] of Object.entries(answers)) {
      if (fieldValue === undefined) continue;
      await client.query(
        `INSERT INTO growth_v2.lead_answers (lead_id, field_key, field_value, cleared_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (lead_id, field_key) DO UPDATE
         SET field_value = EXCLUDED.field_value, cleared_at = EXCLUDED.cleared_at, updated_at = now()`,
        [leadId, fieldKey, fieldValue, fieldValue === null ? new Date() : null],
      );
    }
  }

  private async persistAttribution(
    client: PoolClient,
    sessionId: string,
    touchKind: 'first' | 'latest',
    touch: AttributionTouch,
  ) {
    const values = ATTRIBUTION_KEYS.map((key) => touch[key] ?? null);
    const columns = ATTRIBUTION_KEYS.join(', ');
    const placeholders = ATTRIBUTION_KEYS.map((_, index) => `$${index + 9}`).join(', ');
    const conflict = touchKind === 'first'
      ? 'DO NOTHING'
      : `DO UPDATE SET
          captured_at = EXCLUDED.captured_at,
          landing_path = EXCLUDED.landing_path,
          landing_url_without_pii = EXCLUDED.landing_url_without_pii,
          referrer = EXCLUDED.referrer,
          intent_cluster = EXCLUDED.intent_cluster,
          ${ATTRIBUTION_KEYS.map((key) => `${key} = EXCLUDED.${key}`).join(', ')},
          updated_at = now()`;
    await client.query(
      `INSERT INTO growth_v2.attribution_touches (
         attribution_touch_id, session_id, touch_kind, captured_at, landing_path,
         landing_url_without_pii, referrer, intent_cluster, ${columns}
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, ${placeholders})
       ON CONFLICT (session_id, touch_kind) ${conflict}`,
      [
        randomUUID(), sessionId, touchKind, touch.captured_at, touch.landing_path,
        touch.landing_url_without_pii, touch.referrer, touch.intent_cluster, ...values,
      ],
    );
  }
}
