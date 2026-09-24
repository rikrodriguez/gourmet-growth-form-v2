import pg from 'pg';
import type { LeadAnswers } from '../backend/contracts';
import type { ClaimedCrmJob, CrmLeadSnapshot, CrmOutboxStore, MondayItem } from './contracts';

const { Pool } = pg;

export function createCrmOutboxStore(databaseUrl: string): CrmOutboxStore {
  return new PostgresCrmOutboxStore(new Pool({ connectionString: databaseUrl, max: 8, idleTimeoutMillis: 30_000 }));
}

export class PostgresCrmOutboxStore implements CrmOutboxStore {
  constructor(private readonly pool: pg.Pool) {}

  async health() { await this.pool.query('SELECT 1'); }

  async heartbeat(workerName: string, gitSha: string | null, success = false) {
    await this.pool.query(
      `INSERT INTO growth_v2.crm_worker_state(worker_name,last_started_at,last_poll_at,last_success_at,git_sha)
       VALUES($1,now(),now(),CASE WHEN $3 THEN now() ELSE NULL END,$2)
       ON CONFLICT(worker_name) DO UPDATE SET
         last_poll_at=now(), last_success_at=CASE WHEN $3 THEN now() ELSE growth_v2.crm_worker_state.last_success_at END,
         git_sha=EXCLUDED.git_sha, updated_at=now()`,
      [workerName, gitSha, success],
    );
  }

  async claim(workerId: string, batchSize: number, maxAttempts: number, leaseMs: number): Promise<ClaimedCrmJob[]> {
    const result = await this.pool.query(
      `WITH recovered AS (
         UPDATE growth_v2.crm_outbox
         SET status=CASE WHEN attempt_count >= $3 THEN 'dead' ELSE 'retry' END,
             next_attempt_at=now(), locked_at=NULL, locked_by=NULL,
             last_error_code=CASE WHEN attempt_count >= $3 THEN 'worker_lease_exhausted' ELSE 'worker_lease_expired' END,
             updated_at=now()
         WHERE status='processing' AND locked_at < now()-($4::integer * interval '1 millisecond')
       ), candidates AS (
         SELECT outbox_id FROM growth_v2.crm_outbox
         WHERE status IN ('pending','retry') AND next_attempt_at <= now() AND attempt_count < $3
         ORDER BY next_attempt_at,created_at
         FOR UPDATE SKIP LOCKED LIMIT $2
       )
       UPDATE growth_v2.crm_outbox o
       SET status='processing', locked_at=now(), locked_by=$1, attempt_count=attempt_count+1, updated_at=now()
       FROM candidates c WHERE o.outbox_id=c.outbox_id
       RETURNING o.outbox_id,o.lead_id,o.dedupe_key,o.payload_version,o.attempt_count,o.create_attempted_at`,
      [workerId, batchSize, maxAttempts, leaseMs],
    );
    return result.rows.map((row) => ({
      outboxId: row.outbox_id,
      leadId: row.lead_id,
      dedupeKey: row.dedupe_key,
      payloadVersion: Number(row.payload_version),
      attemptCount: Number(row.attempt_count),
      createAttemptedAt: row.create_attempted_at,
    }));
  }

  async loadLead(leadId: string): Promise<CrmLeadSnapshot | null> {
    const result = await this.pool.query(
      `SELECT l.lead_id,l.created_at,l.is_qa,l.monday_item_id,
              l.phone_ciphertext,l.phone_iv,l.phone_auth_tag,l.phone_key_id,
              COALESCE(jsonb_object_agg(a.field_key,a.field_value) FILTER (WHERE a.field_key IS NOT NULL AND a.cleared_at IS NULL),'{}') AS answers,
              max(t.utm_term) FILTER (WHERE t.touch_kind='first') AS utm_term,
              COALESCE(max(t.landing_url_without_pii) FILTER (WHERE t.touch_kind='first'),'https://gourmet-corporation.com/form2/bbq/') AS landing_url
       FROM growth_v2.leads l
       LEFT JOIN growth_v2.lead_answers a ON a.lead_id=l.lead_id
       LEFT JOIN growth_v2.attribution_touches t ON t.session_id=l.session_id
       WHERE l.lead_id=$1 AND l.deleted_at IS NULL
       GROUP BY l.lead_id`,
      [leadId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      leadId: row.lead_id,
      createdAt: row.created_at,
      isQa: row.is_qa,
      mondayItemId: row.monday_item_id === null ? null : String(row.monday_item_id),
      encryptedPhone: {
        ciphertext: row.phone_ciphertext,
        iv: row.phone_iv,
        authTag: row.phone_auth_tag,
        keyId: row.phone_key_id,
      },
      answers: row.answers as LeadAnswers,
      utmTerm: row.utm_term,
      landingUrl: row.landing_url,
    };
  }

  async markCreateAttempted(outboxId: string): Promise<Date> {
    const result = await this.pool.query(
      `UPDATE growth_v2.crm_outbox SET create_attempted_at=COALESCE(create_attempted_at,now()),updated_at=now()
       WHERE outbox_id=$1 AND status='processing' RETURNING create_attempted_at`,
      [outboxId],
    );
    if (!result.rowCount) throw new Error('outbox_claim_lost');
    return result.rows[0].create_attempted_at;
  }

  async saveMondayItem(leadId: string, item: MondayItem) {
    const result = await this.pool.query(
      `UPDATE growth_v2.leads SET monday_item_id=$2,monday_item_url=$3,updated_at=now()
       WHERE lead_id=$1 AND (monday_item_id IS NULL OR monday_item_id=$2::bigint)
       RETURNING lead_id`,
      [leadId, item.id, item.url],
    );
    if (!result.rowCount) throw new Error('monday_item_conflict');
  }

  async complete(job: ClaimedCrmJob) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `UPDATE growth_v2.crm_outbox
         SET delivered_version=GREATEST(delivered_version,$2),
             operation=CASE WHEN payload_version > $2 THEN 'update_lead' ELSE operation END,
             status=CASE WHEN payload_version > $2 THEN 'pending' ELSE 'completed' END,
             next_attempt_at=CASE WHEN payload_version > $2 THEN now() ELSE next_attempt_at END,
             completed_at=CASE WHEN payload_version > $2 THEN NULL ELSE now() END,
             locked_at=NULL,locked_by=NULL,last_error_code=NULL,updated_at=now()
         WHERE outbox_id=$1 AND status='processing' AND locked_by IS NOT NULL
         RETURNING status`,
        [job.outboxId, job.payloadVersion],
      );
      if (!result.rowCount) throw new Error('outbox_claim_lost');
      await client.query(
        `UPDATE growth_v2.leads SET crm_status=CASE WHEN $2='completed' THEN 'synced' ELSE 'pending' END,
          monday_synced_at=CASE WHEN $2='completed' THEN now() ELSE monday_synced_at END,
          crm_last_error_code=NULL,crm_last_error_at=NULL,updated_at=now() WHERE lead_id=$1`,
        [job.leadId, result.rows[0].status],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async retry(job: ClaimedCrmJob, code: string, nextAttemptAt: Date) {
    await this.finishFailure(job, 'retry', code, nextAttemptAt);
  }

  async dead(job: ClaimedCrmJob, code: string) {
    await this.finishFailure(job, 'dead', code, new Date());
  }

  private async finishFailure(job: ClaimedCrmJob, status: 'retry' | 'dead', code: string, nextAttemptAt: Date) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const changed = await client.query(
        `UPDATE growth_v2.crm_outbox SET status=$2,next_attempt_at=$3,locked_at=NULL,locked_by=NULL,
          last_error_code=$4,updated_at=now() WHERE outbox_id=$1 AND status='processing' RETURNING outbox_id`,
        [job.outboxId, status, nextAttemptAt, code],
      );
      if (!changed.rowCount) throw new Error('outbox_claim_lost');
      await client.query(
        `UPDATE growth_v2.leads SET crm_status=$2,crm_last_error_code=$3,crm_last_error_at=now(),updated_at=now()
         WHERE lead_id=$1`,
        [job.leadId, status === 'retry' ? 'retrying' : 'dead', code],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async close() { await this.pool.end(); }
}
