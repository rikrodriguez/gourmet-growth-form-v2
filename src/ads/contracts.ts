import type { EncryptedPhone } from '../backend/contracts';

export type MeasurementOutboxStatus = 'pending' | 'processing' | 'retry' | 'completed' | 'dead';

export type ClaimedMeasurementJob = {
  outboxId: string;
  leadId: string;
  dedupeKey: string;
  attemptCount: number;
};

export type MeasurementLeadSnapshot = {
  leadId: string;
  isQa: boolean;
  createdAt: Date;
  conversionId: string | null;
  encryptedPhone: EncryptedPhone;
  consent: null | {
    adStorage: 'granted' | 'denied';
    adUserData: 'granted' | 'denied';
    adPersonalization: 'granted' | 'denied';
    recordedAt: Date;
  };
  clickIds: {
    gclid?: string;
    gbraid?: string;
    wbraid?: string;
  };
};

export type EnhancedConversionDelivery = {
  transactionId: string;
  eventTimestamp: string;
  phoneHash: string;
  adPersonalization: 'granted' | 'denied';
  clickIds: MeasurementLeadSnapshot['clickIds'];
};

export interface MeasurementOutboxStore {
  claim(workerId: string, batchSize: number, maxAttempts: number, leaseMs: number): Promise<ClaimedMeasurementJob[]>;
  loadLead(leadId: string): Promise<MeasurementLeadSnapshot | null>;
  complete(job: ClaimedMeasurementJob, providerRequestId: string | null): Promise<void>;
  retry(job: ClaimedMeasurementJob, code: string, nextAttemptAt: Date): Promise<void>;
  dead(job: ClaimedMeasurementJob, code: string): Promise<void>;
  heartbeat(workerName: string, gitSha: string | null, success?: boolean): Promise<void>;
  close(): Promise<void>;
}

export interface EnhancedConversionClient {
  deliver(event: EnhancedConversionDelivery): Promise<{ requestId: string | null }>;
}
