import type { EncryptedPhone, LeadAnswers } from '../backend/contracts';

export type CrmOutboxStatus = 'pending' | 'processing' | 'retry' | 'completed' | 'dead';

export type ClaimedCrmJob = {
  outboxId: string;
  leadId: string;
  dedupeKey: string;
  payloadVersion: number;
  attemptCount: number;
  createAttemptedAt: Date | null;
};

export type CrmLeadSnapshot = {
  leadId: string;
  createdAt: Date;
  isQa: boolean;
  mondayItemId: string | null;
  encryptedPhone: EncryptedPhone;
  answers: LeadAnswers;
  utmTerm: string | null;
  landingUrl: string;
};

export type MondayColumnValues = Record<string, string | null | { label: string } | { date: string } | { phone: string; countryShortName: 'US' }>;

export type MondayItem = {
  id: string;
  name: string;
  url: string;
};

export type MondayBoardPreflight = {
  boardId: string;
  boardName: string;
  groupId: string;
  groupName: string;
};

export interface CrmOutboxStore {
  health(): Promise<void>;
  heartbeat(workerName: string, gitSha: string | null, success?: boolean): Promise<void>;
  claim(workerId: string, batchSize: number, maxAttempts: number, leaseMs: number): Promise<ClaimedCrmJob[]>;
  loadLead(leadId: string): Promise<CrmLeadSnapshot | null>;
  markCreateAttempted(outboxId: string): Promise<Date>;
  saveMondayItem(leadId: string, item: MondayItem): Promise<void>;
  complete(job: ClaimedCrmJob): Promise<void>;
  retry(job: ClaimedCrmJob, code: string, nextAttemptAt: Date): Promise<void>;
  dead(job: ClaimedCrmJob, code: string): Promise<void>;
  close(): Promise<void>;
}

export interface MondayClient {
  preflight(): Promise<MondayBoardPreflight>;
  createLead(name: string, columns: MondayColumnValues, idempotencyKey: string): Promise<MondayItem>;
  updateLead(itemId: string, columns: MondayColumnValues, idempotencyKey: string): Promise<MondayItem>;
  getItem(itemId: string): Promise<MondayItem | null>;
  archiveItem(itemId: string, idempotencyKey: string): Promise<void>;
}

