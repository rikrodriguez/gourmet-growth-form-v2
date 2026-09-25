import { randomUUID } from 'node:crypto';
import { createPhoneDecryptor, type PhoneDecryptor } from '../backend/crypto';
import type { AdsWorkerConfig } from './config';
import type { ClaimedMeasurementJob, EnhancedConversionClient, MeasurementOutboxStore } from './contracts';
import { DataManagerDeliveryError } from './data-manager-client';
import { hashPhoneForGoogle } from './normalization';

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

export class MeasurementOutboxWorker {
  private readonly workerId = `google-ads-${randomUUID()}`;
  private readonly decryptor: PhoneDecryptor;
  private stopped = false;

  constructor(
    private readonly config: AdsWorkerConfig,
    private readonly store: MeasurementOutboxStore,
    private readonly client: EnhancedConversionClient,
    private readonly log: SafeLogger = logger,
  ) {
    this.decryptor = createPhoneDecryptor(config.encryptionKeyBase64, config.encryptionKeyId);
  }

  stop() { this.stopped = true; }

  async start() {
    if (this.config.deliveryMode === 'disabled') throw new Error('Google Ads delivery is disabled.');
    await this.store.heartbeat('google_ads', this.config.gitSha);
    while (!this.stopped) {
      await this.pollOnce();
      if (!this.stopped) await new Promise((resolve) => setTimeout(resolve, this.config.pollMs));
    }
  }

  async pollOnce(): Promise<number> {
    const jobs = await this.store.claim(this.workerId, this.config.batchSize, this.config.maxAttempts, this.config.leaseMs);
    let index = 0;
    const runners = Array.from({ length: Math.min(this.config.concurrency, jobs.length) }, async () => {
      while (index < jobs.length) await this.process(jobs[index++]);
    });
    await Promise.all(runners);
    await this.store.heartbeat('google_ads', this.config.gitSha, jobs.length > 0);
    return jobs.length;
  }

  private async process(job: ClaimedMeasurementJob) {
    try {
      const lead = await this.store.loadLead(job.leadId);
      if (!lead) return await this.store.dead(job, 'lead_missing');
      if (lead.isQa) return await this.store.dead(job, 'qa_delivery_forbidden');
      if (!lead.consent || lead.consent.adStorage !== 'granted' || lead.consent.adUserData !== 'granted') {
        return await this.store.dead(job, 'consent_not_granted');
      }
      if (!lead.conversionId) return await this.store.dead(job, 'conversion_id_missing');
      const phoneHash = hashPhoneForGoogle(this.decryptor.decrypt(lead.encryptedPhone));
      const response = await this.client.deliver({
        transactionId: lead.conversionId,
        eventTimestamp: lead.createdAt.toISOString(),
        phoneHash,
        adPersonalization: lead.consent.adPersonalization,
        clickIds: lead.clickIds,
      });
      await this.store.complete(job, response.requestId);
      this.log.info({ outbox_id: job.outboxId, attempt: job.attemptCount }, 'measurement_job_completed');
    } catch (error) {
      const classified = error instanceof DataManagerDeliveryError
        ? error
        : new DataManagerDeliveryError(error instanceof Error && error.message === 'unsupported_phone_key'
          ? 'unsupported_phone_key' : 'worker_internal_error', false);
      if (!classified.retryable || job.attemptCount >= this.config.maxAttempts) {
        await this.store.dead(job, classified.code);
        this.log.error({ outbox_id: job.outboxId, error_code: classified.code }, 'measurement_job_dead');
        return;
      }
      const delay = backoffMs(job.attemptCount);
      await this.store.retry(job, classified.code, new Date(Date.now() + delay));
      this.log.info({ outbox_id: job.outboxId, error_code: classified.code, retry_in_ms: delay }, 'measurement_job_retry_scheduled');
    }
  }
}
