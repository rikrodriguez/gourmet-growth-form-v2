import type { QuoteScope } from './backend/event-quote-contracts';
export const TEST_PROPOSAL_API = '/api/office/test-proposals';
export const TEST_PROPOSAL_IDENTITY = 'x-test-proposal-identity';
export const TEST_PROPOSAL_CSRF = 'x-test-proposal-csrf';

/** A document reference, deliberately separate from a calculated QuoteVersion. */
export type ProposalTarget = { leadId: string; eventId: string; proposalId: string };
/** Non-secret cache-isolation identity. Preserve strict token parsers even when
 * the existing base64url access revision starts with '-' or '_'. */
export function externalProposalIdentityKey(accessRevision: string): string {
  if (typeof accessRevision !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(accessRevision)) throw new Error('Invalid proposal access revision');
  return `proposal-${accessRevision}`;
}
export type ExternalProposalSnapshot = ProposalTarget & {
  provider: 'synthetic'; sourceVersion: string; content: string | null; sha256: string | null;
  provenance: { accountId: string; boardId: string; itemId: string; observedAt: string; evidenceRef: string };
  bindingDigest: string; briefDigest: string; intendedRecipient: string; associationRevision: number; reviewKey: string;
};
/** Canonical review bytes: fixed field order, UTF-8 JSON, no whitespace. reviewKey
 * is SHA-256 of this complete payload, independently of transport key order.
 * Both the trusted service and browser must use this exact serialization. */
export function serializeExternalProposalReview(snapshot: Omit<ExternalProposalSnapshot, 'reviewKey'>): string {
  return JSON.stringify({
    leadId: snapshot.leadId, eventId: snapshot.eventId, proposalId: snapshot.proposalId,
    provider: snapshot.provider, sourceVersion: snapshot.sourceVersion, content: snapshot.content, sha256: snapshot.sha256,
    provenance: { accountId: snapshot.provenance.accountId, boardId: snapshot.provenance.boardId, itemId: snapshot.provenance.itemId,
      observedAt: snapshot.provenance.observedAt, evidenceRef: snapshot.provenance.evidenceRef },
    bindingDigest: snapshot.bindingDigest, briefDigest: snapshot.briefDigest,
    intendedRecipient: snapshot.intendedRecipient, associationRevision: snapshot.associationRevision,
  });
}
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
