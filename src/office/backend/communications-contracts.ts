// Private workflow contracts. Only an explicit local synthetic HTTP fixture is
// composed; no live importer, OAuth composition or sender consumes these.
export type MailboxKey = 'felipe' | 'info';
export type CommunicationsScope = { organizationId: string; actorId: string; partition: 'external'; dataMode: 'fixture' | 'live' };
export type Coverage = { scope: 'selected_thread' | 'correspondence' | 'incoming_notifications'; incoming: 'complete' | 'partial' | 'unknown'; outgoing: 'complete' | 'partial' | 'unknown' };
export type LeadData = {
  boardId: string; itemId: string; displayName: string; email: string | null; phone: string | null; phoneCountry: string | null;
  eventDate: string | null; guestsText: string | null; eventTypeText: string | null; serviceStyleText: string | null; mappingVersion: string;
};
export type EventData = { eventId: string; leadItemId: string; eventDate: string | null; evidenceRef: string };
export type AccountData = { mailbox: MailboxKey; accountId: string; email: string; verified: true };
export type AttachmentData = { id: string; filename: string; mimeType: string; sha256: string | null };
export type MessageData = { id: string; from: string[]; to: string[]; cc: string[]; subject: string; bodyText: string; attachments: AttachmentData[] };
export type ThreadData = { mailbox: MailboxKey; accountId: string; threadId: string; messages: MessageData[]; coverage: Coverage };
export type VoiceData = { mailbox: MailboxKey; accountId: string; contactEmail: string; notificationId: string; incomingText: string; coverage: { scope: 'incoming_notifications'; incoming: 'partial'; outgoing: 'unknown' } };
export type Observation = { sourceKey: string; providerVersion: string; observedAtMs: number } & (
  | { kind: 'lead'; source: 'monday'; data: LeadData }
  | { kind: 'event'; source: 'event_reference'; data: EventData }
  | { kind: 'account'; source: 'gmail'; data: AccountData }
  | { kind: 'thread'; source: 'gmail'; data: ThreadData }
  | { kind: 'voice'; source: 'voice_notification'; data: VoiceData }
);
export type SourceSnapshot = Observation & { id: string; revision: number; digest: string };
export type Association = { id: string; revision: number; digest: string; candidateSetDigest: string; leadSnapshotId: string; eventSnapshotId: string; accountSnapshotId: string; threadSnapshotId: string; evidenceRef: string; ambiguityAcknowledged: boolean };
export type Candidate = { leadSnapshotId: string; eventSnapshotId: string; accountSnapshotId: string; threadSnapshotId: string; reason: 'exact_email'; review: 'required' | 'ambiguous' };
export type ExactDraft = { id: string; revision: number; digest: string; associationId: string; associationDigest: string; contextDigest: string; policyVersion: string; purpose: 'reply' | 'follow_up'; to: string[]; cc: string[]; bcc: string[]; subject: string; bodyText: string; bodyHtml: string | null; attachments: AttachmentData[] };
export type Approval = { id: string; draftId: string; draftRevision: number; draftDigest: string; approvedBy: string; approvedAtMs: number; status: 'approved_unsent' };
export type CommunicationsEvent = { revision: number; type: 'snapshot' | 'association' | 'draft' | 'approval'; value: SourceSnapshot | Association | ExactDraft | Approval };
export type CommunicationsLedger = { version: 1; scope: CommunicationsScope; revision: number; events: CommunicationsEvent[] };
export type CommunicationsStoredRecord = { revision: number; ledger: CommunicationsLedger };
export interface CommunicationsStore {
  read(): Promise<CommunicationsStoredRecord | null>;
  compareAndSet(expectedRevision: number | null, ledger: CommunicationsLedger): Promise<boolean>;
}
