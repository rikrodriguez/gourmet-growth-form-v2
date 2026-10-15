import type { QuoteScope } from './backend/event-quote-contracts';
import { serializeExternalProposalReview, type ExternalProposalApproval, type ExternalProposalSnapshot, type ExternalProposalView, type ProposalTarget } from './external-proposal-contracts';

export type ExternalProposalReviewContext = { target: ProposalTarget; identityKey: string; scope: QuoteScope };
const invalid = (): never => { throw new Error('Invalid external proposal response'); };
function object(raw: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) return invalid();
  const own = Reflect.ownKeys(raw);
  if (own.length !== keys.length || own.some(key => {
    const d = Object.getOwnPropertyDescriptor(raw, key);
    return typeof key !== 'string' || !keys.includes(key) || !d?.enumerable || !('value' in d);
  })) return invalid();
  return raw as Record<string, unknown>;
}
function token(raw: unknown, max = 96): string {
  if (typeof raw !== 'string' || raw.length > max || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(raw) || ['constructor', 'prototype', '__proto__'].includes(raw)) return invalid();
  return raw;
}
function text(raw: unknown, max: number): string {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > max || /[\u0000-\u001f\u007f]/.test(raw)) return invalid();
  return raw;
}
function integer(raw: unknown, min = 0): number {
  if (!Number.isSafeInteger(raw) || (raw as number) < min) return invalid();
  return raw as number;
}
function digest(raw: unknown): string {
  if (typeof raw !== 'string' || !/^[a-f0-9]{64}$/.test(raw)) return invalid();
  return raw;
}
function bool(raw: unknown): boolean { return typeof raw === 'boolean' ? raw : invalid(); }
function snapshotInput(raw: unknown): ExternalProposalSnapshot {
  const s = object(raw, ['leadId', 'eventId', 'proposalId', 'provider', 'sourceVersion', 'content', 'sha256', 'provenance', 'bindingDigest', 'briefDigest', 'intendedRecipient', 'associationRevision', 'reviewKey']);
  const p = object(s.provenance, ['accountId', 'boardId', 'itemId', 'observedAt', 'evidenceRef']);
  const observedAt = text(p.observedAt, 24);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(observedAt) || !Number.isFinite(Date.parse(observedAt))
    || new Date(observedAt).toISOString() !== observedAt.replace(/Z$/, observedAt.includes('.') ? 'Z' : '.000Z')
    || s.provider !== 'synthetic') return invalid();
  let content: string | null = null, sha256: string | null = null;
  if (s.content !== null || s.sha256 !== null) {
    if (typeof s.content !== 'string' || !s.content.trim() || new TextEncoder().encode(s.content).byteLength > 262144) return invalid();
    content = s.content; sha256 = digest(s.sha256);
  }
  return { leadId: token(s.leadId), eventId: token(s.eventId), proposalId: token(s.proposalId), provider: 'synthetic', sourceVersion: token(s.sourceVersion), content, sha256,
    provenance: { accountId: token(p.accountId, 128), boardId: token(p.boardId, 128), itemId: token(p.itemId, 128), observedAt, evidenceRef: token(p.evidenceRef) },
    bindingDigest: digest(s.bindingDigest), briefDigest: digest(s.briefDigest), intendedRecipient: text(s.intendedRecipient, 320), associationRevision: integer(s.associationRevision, 1), reviewKey: digest(s.reviewKey) };
}
function responseInput(raw: unknown, expected: ExternalProposalReviewContext, now: number): ExternalProposalView {
  const v = object(raw, ['leadId', 'eventId', 'proposalId', 'identityKey', 'scope', 'revision', 'expiresAtMs', 'canWrite', 'canApprove', 'snapshot', 'status', 'approval', 'externalEffectsEnabled']);
  const scope = object(v.scope, ['organizationId', 'workspaceId', 'mode']);
  if (scope.mode !== 'test' || scope.mode !== expected.scope.mode || scope.organizationId !== expected.scope.organizationId || scope.workspaceId !== expected.scope.workspaceId
    || v.identityKey !== expected.identityKey || v.leadId !== expected.target.leadId || v.eventId !== expected.target.eventId || v.proposalId !== expected.target.proposalId
    || v.externalEffectsEnabled !== false || !Number.isSafeInteger(now) || integer(v.expiresAtMs, 1) <= now) return invalid();
  const snapshot = v.snapshot === null ? null : snapshotInput(v.snapshot);
  let approval: ExternalProposalApproval | null = null;
  if (v.approval !== null) {
    const a = object(v.approval, ['reviewKey', 'actorId', 'atMs', 'status']);
    if (a.status !== 'approved_internal_unsent' || integer(a.atMs) > now) return invalid();
    approval = { reviewKey: digest(a.reviewKey), actorId: token(a.actorId, 128), atMs: integer(a.atMs), status: 'approved_internal_unsent' };
  }
  const revision = integer(v.revision), canWrite = bool(v.canWrite), canApprove = bool(v.canApprove);
  const status = v.status;
  if (!['missing', 'reference_only', 'pending_internal_review', 'approved_internal_unsent', 'obsolete'].includes(status as string)
    || canApprove && !canWrite || !snapshot && (status !== 'missing' || revision !== 0)
    || snapshot && (status === 'missing' || snapshot.associationRevision > revision || snapshot.leadId !== v.leadId || snapshot.eventId !== v.eventId || snapshot.proposalId !== v.proposalId)
    || (status === 'approved_internal_unsent') !== (approval !== null)
    || approval && (!snapshot?.sha256 || approval.reviewKey !== snapshot.reviewKey)
    || status === 'reference_only' && snapshot?.content !== null
    || ['pending_internal_review', 'approved_internal_unsent'].includes(status as string) && snapshot?.content === null) return invalid();
  return { leadId: token(v.leadId), eventId: token(v.eventId), proposalId: token(v.proposalId), identityKey: token(v.identityKey, 256),
    scope: { organizationId: token(scope.organizationId, 128), workspaceId: token(scope.workspaceId, 128), mode: 'test' }, revision, expiresAtMs: integer(v.expiresAtMs, 1),
    canWrite, canApprove, snapshot, approval, status: status as ExternalProposalView['status'], externalEffectsEnabled: false };
}
async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}
/** Returns detached schema-checked values only. No caller object survives an await.
 * A digest is integrity evidence against the service's trusted key, not source authentication. */
export async function verifyExternalProposalResponse(raw: unknown, expected: ExternalProposalReviewContext, clock: () => number = Date.now): Promise<{ view: ExternalProposalView; contentVerified: boolean }> {
  const view = responseInput(raw, expected, clock()), snapshot = view.snapshot;
  if (!snapshot) return { view, contentVerified: false };
  if (await sha256(serializeExternalProposalReview(snapshot)) !== snapshot.reviewKey) return invalid();
  if (snapshot.content !== null && await sha256(snapshot.content) !== snapshot.sha256) return invalid();
  if (view.expiresAtMs <= clock()) return invalid();
  return { view, contentVerified: snapshot.content !== null };
}
