import type { AttributionContext, GourmetTelemetryEvent } from '../telemetry/types';

export type ValidatedEvent = GourmetTelemetryEvent;

export type EventRejection = {
  index: number;
  event_id: string | null;
  code: string;
};

export type EventBatchResult = {
  accepted_event_ids: string[];
  duplicate_event_ids: string[];
};

export type LeadAnswerKey =
  | 'event_type'
  | 'date_window'
  | 'exact_date'
  | 'first_name'
  | 'guest_range'
  | 'service_style'
  | 'zip_code';

export type LeadAnswers = Partial<Record<LeadAnswerKey, string | null>>;

export type CapturePhoneInput = {
  visitor_id: string;
  session_id: string;
  phone: string;
  intent_cluster: 'bbq';
  idempotency_key: string;
  attribution?: AttributionContext;
  answers?: Pick<LeadAnswers, 'guest_range' | 'service_style' | 'zip_code'>;
};

export type EncryptedPhone = {
  ciphertext: string;
  iv: string;
  authTag: string;
  keyId: string;
};

export type LeadCaptureRecord = Omit<CapturePhoneInput, 'phone'> & {
  encryptedPhone: EncryptedPhone;
};

export type LeadCaptureResult = {
  leadId: string;
  status: 'created' | 'updated' | 'existing';
};

export interface GrowthDataStore {
  health(): Promise<void>;
  ingestEvents(events: ValidatedEvent[], isQa: boolean): Promise<EventBatchResult>;
  captureLead(input: LeadCaptureRecord, isQa: boolean): Promise<LeadCaptureResult>;
  updateLead(leadId: string, sessionId: string, answers: LeadAnswers): Promise<boolean>;
  cleanupQa(): Promise<{ events: number; leads: number; sessions: number; visitors: number }>;
  close(): Promise<void>;
}
