import { createHash } from 'node:crypto';
import type { BridgeScope } from '../canonical-bridge-contracts';
import type { ExternalProposalApproval, ExternalProposalCommand, ExternalProposalSnapshot, ExternalProposalView, ProposalTarget } from '../external-proposal-contracts';
import { serializeExternalProposalReview } from '../external-proposal-contracts';
import type { EventQuoteIdentity } from './event-quote-http';
import type { LeadLinkIdentity } from './lead-link-http';
import { CanonicalBridge } from './canonical-bridge';
import { historicalLeadKey, normalizeHistoricalLink, type HistoricalLinkInput } from './lead-link-history';

const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const digest = (value: unknown) => hash(JSON.stringify(value));
const copy = <T,>(value: T): T => structuredClone(value);
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(value) && !['constructor', 'prototype', '__proto__'].includes(value);
export class ExternalProposalError extends Error {
  constructor(readonly code: string) { super(code); }
}
function fail(code: string): never { throw new ExternalProposalError(code); }
function targetInput(target: ProposalTarget): ProposalTarget {
  if (!target || Object.keys(target).sort().join() !== 'eventId,leadId,proposalId' || !Object.values(target).every(id)) fail('INVALID_TARGET');
  return copy(target);
}
/** Server composition must resolve existing identities, exact source mapping and the saved brief.
 * This contract grants no access and is never accepted from request headers/body. */
export type ProposalAuthority = {
  lead: LeadLinkIdentity; quote: EventQuoteIdentity; eventIds: readonly string[];
  bindingId: string; leadVersionId: string; eventVersionId: string;
  source: { accountId: string; boardId: string; itemId: string };
  brief: { digest: string; recipient: string };
};
export type SyntheticProposalDocument = ProposalTarget & {
  scope: EventQuoteIdentity['scope']; provider: 'synthetic'; sourceVersion: string;
  /** Exact UTF-8 text from the trusted fixture provider, never a caller-supplied digest or URL fetch. */
  content: string | null; evidenceRef: string; historicalLink: HistoricalLinkInput;
};
export type ProposalRecord = {
  revision: number; snapshots: ExternalProposalSnapshot[]; approvals: ExternalProposalApproval[];
  receipts: { key: string; inputDigest: string }[];
};
export interface ExternalProposalStore {
  read(key: string): Promise<ProposalRecord | null>;
  /** Serialize per key. Commit the returned value atomically; a throw rolls back. */
  transact(key: string, change: (record: ProposalRecord | null) => Promise<ProposalRecord>): Promise<void>;
}
/** Synthetic tests only. Reusing this store recovers committed state after a lost response/service restart.
 * No process-crash durability is claimed; there is deliberately no production adapter. */
export class MemoryExternalProposalStore implements ExternalProposalStore {
  private rows = new Map<string, ProposalRecord>();
  private tails = new Map<string, Promise<unknown>>();
  async read(key: string) { return copy(this.rows.get(key) ?? null); }
  async transact(key: string, change: (record: ProposalRecord | null) => Promise<ProposalRecord>) {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      const result = await change(await this.read(key));
      this.rows.set(key, copy(result));
    });
    this.tails.set(key, next);
    try { await next; } finally { if (this.tails.get(key) === next) this.tails.delete(key); }
  }
}
export function proposalBridgeScope(authority: ProposalAuthority): BridgeScope {
  return { organizationId: `proposal-${digest(authority.quote.scope)}`, actorId: authority.quote.actor.actorId, partition: 'demo' };
}
/** Opt-in TEST_ONLY service: no routes, provider credentials, editor, sending or URL transport. */
export class ExternalProposalService {
  constructor(private readonly options: {
    bridge: CanonicalBridge; store: ExternalProposalStore;
    resolveAuthority(target: ProposalTarget): Promise<ProposalAuthority | null>;
    provider: { read(target: ProposalTarget): Promise<SyntheticProposalDocument> };
    clock?: () => number;
  }) {}
  private now() { return (this.options.clock ?? Date.now)(); }
  private async authority(target: ProposalTarget, write = false, approve = false) {
    const raw = await this.options.resolveAuthority(copy(target));
    if (!raw) fail('ACCESS_DENIED');
    const a = copy(raw), l = a.lead, q = a.quote;
    if (l.scope.mode !== 'test' || q.scope.mode !== 'test' || digest(l.scope) !== digest(q.scope)
      || !l.canRead || !l.leadIds.includes(target.leadId) || !a.eventIds.includes(target.eventId)
      || !Number.isSafeInteger(l.expiresAtMs) || !Number.isSafeInteger(q.expiresAtMs)
      || Math.min(l.expiresAtMs, q.expiresAtMs) <= this.now()
      || write && !q.actor.canWrite || approve && !q.actor.canApprove
      || !/^[a-f0-9]{64}$/.test(a.brief.digest) || !a.brief.recipient || a.brief.recipient.length > 320) fail('ACCESS_DENIED');
    return a;
  }
  private continuity(before: ProposalAuthority, after: ProposalAuthority) {
    // Expiry may shorten, but identity, permissions, saved brief and source assignment may not change in flight.
    const stable = (a: ProposalAuthority) => ({ ...a, lead: { ...a.lead, expiresAtMs: 0 }, quote: { ...a.quote, expiresAtMs: 0 } });
    if (digest(stable(before)) !== digest(stable(after))) fail('ACCESS_CHANGED');
    if (Math.min(before.lead.expiresAtMs, before.quote.expiresAtMs) <= this.now()) fail('ACCESS_DENIED');
  }
  private key(a: ProposalAuthority, target: ProposalTarget) {
    // Scope includes workspace and test mode; actor separation matches the canonical bridge.
    return digest([a.quote.scope, a.quote.actor.actorId, target.leadId, target.eventId]);
  }
  private async binding(a: ProposalAuthority, target: ProposalTarget) {
    const scope = proposalBridgeScope(a), state = await this.options.bridge.snapshot(scope);
    const binding = state.bindings.filter(b => b.bindingId === a.bindingId).at(-1);
    const lead = state.sourceVersions.find(v => v.id === a.leadVersionId);
    const event = state.sourceVersions.find(v => v.id === a.eventVersionId);
    if (!binding?.refs || binding.refs.lead !== a.leadVersionId || binding.refs.event !== a.eventVersionId
      || !lead || lead.kind !== 'lead' || !event || event.kind !== 'event'
      || lead.reference.boardId !== a.source.boardId || lead.reference.itemId !== a.source.itemId
      || event.reference.itemId !== target.eventId) fail('BINDING_MISMATCH');
    return binding;
  }
  private async evidence(a: ProposalAuthority, target: ProposalTarget, associationRevision = 0): Promise<ExternalProposalSnapshot> {
    const document = copy(await this.options.provider.read(copy(target)));
    if (document.provider !== 'synthetic' || digest(document.scope) !== digest(a.quote.scope)
      || document.leadId !== target.leadId || document.eventId !== target.eventId || document.proposalId !== target.proposalId
      || !id(document.sourceVersion) || !id(document.evidenceRef)
      || document.content !== null && (typeof document.content !== 'string' || !document.content.trim() || Buffer.byteLength(document.content) > 262144)) fail('PROVIDER_MISMATCH');
    const history = normalizeHistoricalLink(document.historicalLink);
    if (history.status === 'quarantined' || history.category !== 'quote'
      || historicalLeadKey(history.provenance) !== historicalLeadKey(a.source)) fail('SOURCE_MISMATCH');
    const binding = await this.binding(a, target);
    const snapshot = { ...target, provider: 'synthetic' as const, sourceVersion: document.sourceVersion,
      content: document.content, sha256: document.content === null ? null : hash(document.content),
      provenance: { ...a.source, observedAt: history.provenance.observedAt, evidenceRef: document.evidenceRef },
      bindingDigest: binding.digest, briefDigest: a.brief.digest, intendedRecipient: a.brief.recipient, associationRevision };
    return { ...snapshot, reviewKey: hash(serializeExternalProposalReview(snapshot)) };
  }
  private view(a: ProposalAuthority, target: ProposalTarget, record: ProposalRecord | null, live: ExternalProposalSnapshot | null): ExternalProposalView {
    const snapshot = record?.snapshots.at(-1) ?? null;
    const current = snapshot?.reviewKey === live?.reviewKey;
    const approval = current && snapshot ? record?.approvals.find(v => v.reviewKey === snapshot.reviewKey) ?? null : null;
    return { ...target, identityKey: a.lead.identityKey, scope: a.quote.scope, revision: record?.revision ?? 0,
      expiresAtMs: Math.min(a.lead.expiresAtMs, a.quote.expiresAtMs), canWrite: a.quote.actor.canWrite, canApprove: a.quote.actor.canWrite && a.quote.actor.canApprove,
      snapshot, approval, status: !snapshot ? 'missing' : !current ? 'obsolete' : snapshot.sha256 === null ? 'reference_only' : approval ? 'approved_internal_unsent' : 'pending_internal_review', externalEffectsEnabled: false };
  }
  async read(rawTarget: ProposalTarget): Promise<ExternalProposalView> {
    const target = targetInput(rawTarget), a = await this.authority(target);
    const record = await this.options.store.read(this.key(a, target));
    const live = record ? await this.evidence(a, target, record.snapshots.at(-1)?.associationRevision) : null;
    this.continuity(a, await this.authority(target));
    return copy(this.view(a, target, record, live));
  }
  async execute(rawTarget: ProposalTarget, rawCommand: ExternalProposalCommand): Promise<ExternalProposalView> {
    const target = targetInput(rawTarget), command = copy(rawCommand);
    if (!command || !id(command.key) || !Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0
      || !['associate', 'approve'].includes(command.action)
      || Object.keys(command).sort().join() !== (command.action === 'associate' ? 'action,expectedRevision,key' : 'action,expectedRevision,key,reviewKey')
      || command.action === 'approve' && !/^[a-f0-9]{64}$/.test(command.reviewKey)) fail('INVALID_COMMAND');
    const a = await this.authority(target, true, command.action === 'approve');
    const evidence = await this.evidence(a, target);
    const inputDigest = digest([target, command]);
    await this.options.store.transact(this.key(a, target), async current => {
      const record = current ?? { revision: 0, snapshots: [], approvals: [], receipts: [] };
      this.continuity(a, await this.authority(target, true, command.action === 'approve'));
      const prior = record.receipts.find(r => r.key === command.key);
      if (prior) { if (prior.inputDigest !== inputDigest) fail('IDEMPOTENCY_CONFLICT'); return record; }
      if (record.revision !== command.expectedRevision) fail('REVISION_CONFLICT');
      if (record.receipts.length >= 200) fail('LIMIT');
      const { reviewKey: _reviewKey, ...body } = evidence;
      const associated = { ...body, associationRevision: command.action === 'associate' ? record.revision + 1 : record.snapshots.at(-1)?.associationRevision ?? 0 };
      const live = { ...associated, reviewKey: hash(serializeExternalProposalReview(associated)) };
      // A new content payload under a used provider version is never accepted as a new revision.
      if (record.snapshots.some(s => s.proposalId === live.proposalId && s.sourceVersion === live.sourceVersion && s.sha256 !== live.sha256)) fail('VERSION_CONFLICT');
      if (command.action === 'associate') record.snapshots.push(live);
      else {
        const snapshot = record.snapshots.at(-1);
        if (!snapshot?.sha256 || command.reviewKey !== snapshot.reviewKey || live.reviewKey !== snapshot.reviewKey) fail('REVIEW_OBSOLETE');
        if (!record.approvals.some(r => r.reviewKey === snapshot.reviewKey)) record.approvals.push({ reviewKey: snapshot.reviewKey, actorId: a.quote.actor.actorId, atMs: this.now(), status: 'approved_internal_unsent' });
      }
      // Recheck canonical link after provider/store I/O; never rebase silently.
      if ((await this.binding(a, target)).digest !== live.bindingDigest) fail('BINDING_CHANGED');
      if ((await this.evidence(a, target, live.associationRevision)).reviewKey !== live.reviewKey) fail('DOCUMENT_CHANGED');
      this.continuity(a, await this.authority(target, true, command.action === 'approve'));
      record.revision++; record.receipts.push({ key: command.key, inputDigest });
      return record;
    });
    // A lost response is recovered by read or an exact-key retry; no automatic retry/effect.
    return this.read(target);
  }
}
