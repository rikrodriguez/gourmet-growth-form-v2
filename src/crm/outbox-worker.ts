import { randomUUID } from 'node:crypto';
import { createPhoneDecryptor, type PhoneDecryptor } from '../backend/crypto';
import type { ClaimedCrmJob, CrmOutboxStore, MondayClient } from './contracts';
import type { CrmWorkerConfig } from './config';
import { MondayApiError } from './monday-client';
import { mondayCreateColumns, mondayItemName, mondayUpdateColumns } from './monday-mapping';

type SafeLogger = {
  info(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
};

const logger: SafeLogger = {
  info(fields, message) { process.stdout.write(`${JSON.stringify({ level: 'info', message, ...fields })}\n`); },
  error(fields, message) { process.stderr.write(`${JSON.stringify({ level: 'error', message, ...fields })}\n`); },
};

function backoffMs(attempt: number): number {
  const base = Math.min(15 * 60_000, 2 ** Math.min(attempt, 10) * 1000);
  return Math.round(base * (0.75 + Math.random() * 0.5));
}

export class CrmOutboxWorker {
  private readonly workerId = `monday-${randomUUID()}`;
  private readonly decryptor: PhoneDecryptor;
  private stopped = false;

  constructor(
    private readonly config: CrmWorkerConfig,
    private readonly store: CrmOutboxStore,
    private readonly monday: MondayClient,
    private readonly log: SafeLogger = logger,
  ) {
    this.decryptor = createPhoneDecryptor(config.encryptionKeyBase64, config.encryptionKeyId);
  }

  stop() { this.stopped = true; }

  async start() {
    const preflight = await this.monday.preflight();
    this.log.info({ board_id: preflight.boardId, group_id: preflight.groupId }, 'crm_preflight_passed');
    await this.store.heartbeat('monday', this.config.gitSha);
    while (!this.stopped) {
      await this.pollOnce();
      if (!this.stopped) await new Promise((resolve) => setTimeout(resolve, this.config.pollMs));
    }
  }

  async pollOnce(): Promise<number> {
    const jobs = await this.store.claim(this.workerId, this.config.batchSize, this.config.maxAttempts, this.config.leaseMs);
    let index = 0;
    const runners = Array.from({ length: Math.min(this.config.concurrency, jobs.length) }, async () => {
      while (index < jobs.length) {
        const job = jobs[index++];
        await this.process(job);
      }
    });
    await Promise.all(runners);
    await this.store.heartbeat('monday', this.config.gitSha, jobs.length > 0);
    return jobs.length;
  }

  private async process(job: ClaimedCrmJob) {
    try {
      const lead = await this.store.loadLead(job.leadId);
      if (!lead) return await this.store.dead(job, 'lead_missing');
      const phone = this.decryptor.decrypt(lead.encryptedPhone);
      if (!/^\d{10}$/.test(phone)) return await this.store.dead(job, 'decrypted_phone_invalid');

      if (!lead.mondayItemId) {
        const attemptedAt = job.createAttemptedAt ?? await this.store.markCreateAttempted(job.outboxId);
        if (Date.now() - attemptedAt.getTime() >= this.config.ambiguousWindowMs) {
          return await this.store.dead(job, 'ambiguous_create_window_expired');
        }
        const item = await this.monday.createLead(
          mondayItemName(lead),
          mondayCreateColumns(lead, phone),
          job.dedupeKey,
        );
        await this.store.saveMondayItem(lead.leadId, item);
      } else {
        await this.monday.updateLead(
          lead.mondayItemId,
          mondayUpdateColumns(lead, phone),
          `${job.dedupeKey}:v${job.payloadVersion}`,
        );
      }
      await this.store.complete(job);
      this.log.info({ outbox_id: job.outboxId, lead_id: job.leadId, attempt: job.attemptCount }, 'crm_job_completed');
    } catch (error) {
      const classified = error instanceof MondayApiError
        ? error
        : new MondayApiError(error instanceof Error && error.message === 'unsupported_phone_key' ? 'unsupported_phone_key' : 'worker_internal_error', false);
      const createAmbiguityExpired = classified.ambiguous && job.createAttemptedAt
        && Date.now() - job.createAttemptedAt.getTime() >= this.config.ambiguousWindowMs;
      const exhausted = job.attemptCount >= this.config.maxAttempts;
      if (!classified.retryable || exhausted || createAmbiguityExpired) {
        await this.store.dead(job, createAmbiguityExpired ? 'ambiguous_create_window_expired' : classified.code);
        this.log.error({ outbox_id: job.outboxId, lead_id: job.leadId, error_code: classified.code }, 'crm_job_dead');
        return;
      }
      const delay = classified.retryAfterMs ?? backoffMs(job.attemptCount);
      await this.store.retry(job, classified.code, new Date(Date.now() + delay));
      this.log.info({ outbox_id: job.outboxId, lead_id: job.leadId, error_code: classified.code, retry_in_ms: delay }, 'crm_job_retry_scheduled');
    }
  }
}

