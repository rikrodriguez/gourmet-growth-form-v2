import type { QuoteScope } from './backend/event-quote-contracts';

/** A document reference, deliberately separate from a calculated QuoteVersion. */
export type ProposalTarget = { leadId: string; eventId: string; proposalId: string };
export type ExternalProposalSnapshot = ProposalTarget & {
  provider: 'synthetic'; sourceVersion: string; content: string | null; sha256: string | null;
  provenance: { accountId: string; boardId: string; itemId: string; observedAt: string; evidenceRef: string };
  bindingDigest: string; briefDigest: string; intendedRecipient: string; associationRevision: number; reviewKey: string;
};
export type ExternalProposalApproval = { reviewKey: string; actorId: string; atMs: number; status: 'approved_internal_unsent' };
export type ExternalProposalView = ProposalTarget & {
  identityKey: string; scope: QuoteScope; revision: number; expiresAtMs: number;
  canWrite: boolean; canApprove: boolean; snapshot: ExternalProposalSnapshot | null;
  status: 'missing' | 'reference_only' | 'pending_internal_review' | 'approved_internal_unsent' | 'obsolete';
  approval: ExternalProposalApproval | null; externalEffectsEnabled: false;
};
export type ExternalProposalCommand = { key: string; expectedRevision: number } & (
  { action: 'associate' } | { action: 'approve'; reviewKey: string }
);
export interface ExternalProposalClient {
  read(target: ProposalTarget, signal: AbortSignal): Promise<ExternalProposalView>;
  execute(target: ProposalTarget, command: ExternalProposalCommand, signal: AbortSignal): Promise<ExternalProposalView>;
}
