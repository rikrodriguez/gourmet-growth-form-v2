import pg from 'pg';
import type { ClaimedMeasurementJob, MeasurementLeadSnapshot, MeasurementOutboxStore } from './contracts';

const { Pool } = pg;

export function createMeasurementOutboxStore(databaseUrl: string): MeasurementOutboxStore {
  return new PostgresMeasurementOutboxStore(new Pool({ connectionString: databaseUrl, max: 8, idleTimeoutMillis: 30_000 }));
}

export class PostgresMeasurementOutboxStore implements MeasurementOutboxStore {
  constructor(private readonly pool: pg.Pool) {}

  async heartbeat(workerName: string, gitSha: string | null, success = false) {
    await this.pool.query(
      `INSERT INTO growth_v2.measurement_worker_state(worker_name,last_started_at,last_poll_at,last_success_at,git_sha)
       VALUES($1,now(),now(),CASE WHEN $3 THEN now() ELSE NULL END,$2)
       ON CONFLICT(worker_name) DO UPDATE SET
         last_poll_at=now(),last_success_at=CASE WHEN $3 THEN now() ELSE growth_v2.measurement_worker_state.last_success_at END,
         git_sha=EXCLUDED.git_sha,updated_at=now()`,
      [workerName, gitSha, success],
    );
  }

  async claim(workerId: string, batchSize: number, maxAttempts: number, leaseMs: number): Promise<ClaimedMeasurementJob[]> {
    const result = await this.pool.query(
      `WITH recovered AS (
         UPDATE growth_v2.measurement_outbox
         SET status=CASE WHEN attempt_count >= $3 THEN 'dead' ELSE 'retry' END,
             next_attempt_at=now(),locked_at=NULL,locked_by=NULL,
             last_error_code=CASE WHEN attempt_count >= $3 THEN 'worker_lease_exhausted' ELSE 'worker_lease_expired' END,
             updated_at=now()
         WHERE status='processing' AND locked_at < now()-($4::integer * interval '1 millisecond')
       ), candidates AS (
         SELECT outbox_id FROM growth_v2.measurement_outbox
         WHERE status IN ('pending','retry') AND next_attempt_at <= now() AND attempt_count < $3
         ORDER BY next_attempt_at,created_at FOR UPDATE SKIP LOCKED LIMIT $2
       )
       UPDATE growth_v2.measurement_outbox o
       SET status='processing',locked_at=now(),locked_by=$1,attempt_count=attempt_count+1,updated_at=now()
       FROM candidates c WHERE o.outbox_id=c.outbox_id
       RETURNING o.outbox_id,o.lead_id,o.dedupe_key,o.attempt_count`,
      [workerId, batchSize, maxAttempts, leaseMs],
    );
    return result.rows.map((row) => ({
      outboxId: row.outbox_id,
      leadId: row.lead_id,
      dedupeKey: row.dedupe_key,
      attemptCount: Number(row.attempt_count),
    }));
  }

  async loadLead(leadId: string): Promise<MeasurementLeadSnapshot | null> {
    const result = await this.pool.query(
      `SELECT l.lead_id,l.created_at,l.is_qa,l.google_ads_conversion_id,
              l.phone_ciphertext,l.phone_iv,l.phone_auth_tag,l.phone_key_id,
              c.ad_storage,c.ad_user_data,c.ad_personalization,c.consent_recorded_at,
              COALESCE(max(t.gclid) FILTER (WHERE t.touch_kind='latest'),max(t.gclid) FILTER (WHERE t.touch_kind='first')) AS gclid,
              COALESCE(max(t.gbraid) FILTER (WHERE t.touch_kind='latest'),max(t.gbraid) FILTER (WHERE t.touch_kind='first')) AS gbraid,
              COALESCE(max(t.wbraid) FILTER (WHERE t.touch_kind='latest'),max(t.wbraid) FILTER (WHERE t.touch_kind='first')) AS wbraid
       FROM growth_v2.leads l
       LEFT JOIN growth_v2.lead_measurement_consents c ON c.lead_id=l.lead_id
       LEFT JOIN growth_v2.attribution_touches t ON t.session_id=l.session_id
       WHERE l.lead_id=$1 AND l.deleted_at IS NULL
       GROUP BY l.lead_id,c.lead_id`,
      [leadId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      leadId: row.lead_id,
      createdAt: row.created_at,
      isQa: row.is_qa,
      conversionId: row.google_ads_conversion_id,
      encryptedPhone: {
        ciphertext: row.phone_ciphertext,
        iv: row.phone_iv,
        authTag: row.phone_auth_tag,
        keyId: row.phone_key_id,
      },
      consent: row.ad_storage ? {
        adStorage: row.ad_storage,
        adUserData: row.ad_user_data,
        adPersonalization: row.ad_personalization,
        recordedAt: row.consent_recorded_at,
      } : null,
      clickIds: Object.fromEntries(
        [['gclid', row.gclid], ['gbraid', row.gbraid], ['wbraid', row.wbraid]].filter(([, value]) => Boolean(value)),
      ),
    } as MeasurementLeadSnapshot;
  }

  async complete(job: ClaimedMeasurementJob, providerRequestId: string | null) {
    const result = await this.pool.query(
      `UPDATE growth_v2.measurement_outbox
       SET status='completed',completed_at=now(),provider_request_id=$2,locked_at=NULL,locked_by=NULL,
           last_error_code=NULL,updated_at=now()
       WHERE outbox_id=$1 AND status='processing' RETURNING outbox_id`,
      [job.outboxId, providerRequestId],
    );
    if (!result.rowCount) throw new Error('outbox_claim_lost');
  }

  async retry(job: ClaimedMeasurementJob, code: string, nextAttemptAt: Date) {
    await this.finishFailure(job, 'retry', code, nextAttemptAt);
  }

  async dead(job: ClaimedMeasurementJob, code: string) {
    await this.finishFailure(job, 'dead', code, new Date());
  }

  private async finishFailure(job: ClaimedMeasurementJob, status: 'retry' | 'dead', code: string, nextAttemptAt: Date) {
    const result = await this.pool.query(
      `UPDATE growth_v2.measurement_outbox
       SET status=$2,next_attempt_at=$3,locked_at=NULL,locked_by=NULL,last_error_code=$4,updated_at=now()
       WHERE outbox_id=$1 AND status='processing' RETURNING outbox_id`,
      [job.outboxId, status, nextAttemptAt, code.slice(0, 100)],
    );
    if (!result.rowCount) throw new Error('outbox_claim_lost');
  }

  async close() { await this.pool.end(); }
}
