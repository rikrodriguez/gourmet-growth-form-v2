import { isDeepStrictEqual } from 'node:util';
import type { Pool } from 'pg';
import { CanonicalBridge } from './canonical-bridge';
import { PostgresCanonicalBridgeStore } from './canonical-bridge-postgres';
import { PostgresEventQuoteStore, eventQuoteStorageKey } from './event-quote-postgres';
import { PostgresQuoteAccessRepository, type ExistingQuoteSession } from './quote-access-postgres';
import { ExternalProposalError, ExternalProposalService, proposalBridgeScope, type ProposalAuthority, type SyntheticProposalDocument } from './external-proposal';
import { PostgresExternalProposalRepository, proposalCaseKey, type DurableProposalCase, type ProposalMapping } from './external-proposal-postgres';
import { EventQuoteError } from './event-quote-contracts';
import type { MondayVault } from './monday-store';
import type { ExternalProposalCommand, ProposalTarget } from '../external-proposal-contracts';
import { externalProposalIdentityKey } from '../external-proposal-contracts';
import { projectLeadLinks } from './lead-link-view';
import { normalizeHistoricalLink } from './lead-link-history';
import type { EventQuoteIdentity } from './event-quote-http';

/** Opt-in, fixed-case TEST_ONLY composition. No routes, initialization, identity
 * provisioning, provider calls or new permissions. Reuses existing event ACLs
 * for one server-mapped lead/event chain. All reads and writes share one client. */
export function createDurableTestProposalService(options: {
  pool: Pool; vault: Pick<MondayVault, 'seal' | 'open'>;
  target: ProposalTarget; mapping?: ProposalMapping;
  proposalSchema: string; quoteSchema: string; accessSchema: string; bridgeSchema: string;
  clock?: () => number;
}) {
  const target = structuredClone(options.target), mapping = options.mapping && structuredClone(options.mapping);
  const clock = options.clock ?? Date.now;
  const access = new PostgresQuoteAccessRepository(options.pool, { schema: options.accessSchema, clock });
  const repository = new PostgresExternalProposalRepository(options.pool, options.vault, options.proposalSchema);
  const sources = [{ sourceSystem: 'fixture:proposal', partition: 'demo' }] as const;
  const run = <T,>(proof: ExistingQuoteSession | null, kind: 'read' | 'write' | 'approve', operation: (context: {
    service: ExternalProposalService; identity: EventQuoteIdentity; value(): DurableProposalCase | null; publish(document: SyntheticProposalDocument): Promise<void>;
  }) => Promise<T>) => access.run(proof, { kind, eventId: target.eventId }, async (identity, client) => {
    try {
      if (identity.scope.mode !== 'test') throw new ExternalProposalError('ACCESS_DENIED');
      let current = await repository.load(client, identity.scope, identity.actor.actorId, target);
      const assigned = current?.mapping ?? mapping;
      if (!assigned || mapping && current && !isDeepStrictEqual(mapping, current.mapping)) throw new ExternalProposalError('BINDING_MISMATCH');
      const quotes = new PostgresEventQuoteStore(options.pool, { vault: options.vault, schema: options.quoteSchema, transaction: client });
      // Hold the existing brief row against all other consumers' updates. Their
      // default read/write behavior is unchanged; PostgreSQL enforces the lock.
      const briefLock = await client.query(`SELECT key FROM ${options.quoteSchema}.events WHERE key=$1 FOR SHARE`, [eventQuoteStorageKey(identity.scope, target.eventId)]);
      if (briefLock.rows.length !== 1) throw new ExternalProposalError('BRIEF_REQUIRED');
      const bridge = new CanonicalBridge(new PostgresCanonicalBridgeStore(options.pool, { schema: options.bridgeSchema, sources, transaction: client }), { sources, clock });
      const resolveAuthority = async (): Promise<ProposalAuthority> => {
        const saved = await quotes.read(identity.scope, target.eventId), brief = saved?.briefs.at(-1);
        if (!brief) throw new ExternalProposalError('BRIEF_REQUIRED');
        return { quote: identity, lead: { identityKey: externalProposalIdentityKey(identity.accessRevision!), durableIdentity: true, scope: identity.scope, expiresAtMs: identity.expiresAtMs,
          canRead: true, canOpen: false, leadIds: [target.leadId] }, eventIds: [target.eventId], ...structuredClone(assigned), brief: { digest: brief.digest, recipient: brief.recipient } };
      };
      const authority = await resolveAuthority();
      const ledger = await bridge.snapshot(proposalBridgeScope(authority));
      const linked = ledger.bindings.filter(b => b.bindingId === assigned.bindingId).at(-1);
      const lead = ledger.sourceVersions.find(s => s.id === assigned.leadVersionId), event = ledger.sourceVersions.find(s => s.id === assigned.eventVersionId);
      if (!linked?.refs || linked.refs.lead !== assigned.leadVersionId || linked.refs.event !== assigned.eventVersionId
        || lead?.kind !== 'lead' || event?.kind !== 'event' || lead.reference.boardId !== assigned.source.boardId
        || lead.reference.itemId !== assigned.source.itemId || event.reference.itemId !== target.eventId) throw new ExternalProposalError('BINDING_MISMATCH');
      const service = new ExternalProposalService({ bridge, clock, resolveAuthority,
        provider: { async read() { if (!current) throw new ExternalProposalError('SOURCE_REQUIRED'); return structuredClone(current.documents.at(-1)!); } },
        store: {
          async read(key) { if (key !== proposalCaseKey(identity.scope, identity.actor.actorId, target)) throw new ExternalProposalError('ACCESS_DENIED'); return structuredClone(current?.record ?? null); },
          async transact(key, change) {
            if (!current || key !== proposalCaseKey(identity.scope, identity.actor.actorId, target)) throw new ExternalProposalError('SOURCE_REQUIRED');
            const prior = structuredClone(current), record = await change(structuredClone(current.record));
            if (isDeepStrictEqual(prior.record, record)) return;
            const next = { ...prior, revision: prior.revision + 1, record };
            // CAS also detects changes made on this shared connection during a
            // last authority read. A competing connection cannot change source
            // at all until this authorization transaction commits or rolls back.
            await repository.save(client, prior, next); current = next;
          },
        },
      });
      const result = await operation({ service, identity, value: () => structuredClone(current), async publish(document) {
        const copy = structuredClone(document);
        if (current) {
          const existing = current.documents.find(d => d.sourceVersion === copy.sourceVersion);
          if (existing) { if (!isDeepStrictEqual(existing, copy)) throw new ExternalProposalError('VERSION_CONFLICT'); return; }
        }
        const next: DurableProposalCase = current ? { ...structuredClone(current), revision: current.revision + 1, documents: [...current.documents, copy] }
          : { schemaVersion: 1, revision: 1, scope: identity.scope, actorId: identity.actor.actorId, target, mapping: structuredClone(assigned), documents: [copy], record: null };
        await repository.save(client, current, next); current = next;
      } });
      if (current) await repository.assertCurrent(client, current);
      return result;
    } catch (error) { if (error instanceof ExternalProposalError) throw new EventQuoteError(error.code, 409); throw error; }
  });
  return {
    access: (proof: ExistingQuoteSession | null) => run(proof, 'read', async c => ({ access: {
      state: 'ready' as const, identityKey: externalProposalIdentityKey(c.identity.accessRevision!), durableIdentity: true,
      scope: c.identity.scope, expiresAtMs: c.identity.expiresAtMs, canRead: true, canOpen: false, leadIds: [target.leadId],
    }, target: structuredClone(target), csrfToken: c.identity.csrfToken })),
    leadHistory: (proof: ExistingQuoteSession | null, expectedIdentity: string) => run(proof, 'read', async c => {
      const identityKey = externalProposalIdentityKey(c.identity.accessRevision!);
      if (identityKey !== expectedIdentity) throw new EventQuoteError('ACCESS_CHANGED', 403);
      const value = c.value(); if (!value) throw new EventQuoteError('SOURCE_REQUIRED', 404);
      return { identityKey, scope: c.identity.scope, leadId: target.leadId,
        history: projectLeadLinks({ leadId: target.leadId, ...value.mapping.source }, [normalizeHistoricalLink(value.documents.at(-1)!.historicalLink)], new Map()),
        agreement: null, openingSession: { canOpen: false, csrfToken: null, expiresAtMs: c.identity.expiresAtMs } };
    }),
    read: (proof: ExistingQuoteSession | null, expectedIdentity?: string) => run(proof, 'read', async c => {
      if (expectedIdentity !== undefined && externalProposalIdentityKey(c.identity.accessRevision!) !== expectedIdentity) throw new EventQuoteError('ACCESS_CHANGED', 403);
      return c.service.read(target);
    }),
    execute: (proof: ExistingQuoteSession | null, command: ExternalProposalCommand, expectedIdentity?: string) => { const copy = structuredClone(command); return run(proof, copy.action === 'approve' ? 'approve' : 'write', async c => {
      if (expectedIdentity !== undefined && externalProposalIdentityKey(c.identity.accessRevision!) !== expectedIdentity) throw new EventQuoteError('ACCESS_CHANGED', 403);
      return c.service.execute(target, copy);
    }); },
    publish: (proof: ExistingQuoteSession | null, document: SyntheticProposalDocument) => { const copy = structuredClone(document); return run(proof, 'write', async c => { await c.publish(copy); }); },
    history: (proof: ExistingQuoteSession | null) => run(proof, 'read', async c => c.value()),
  };
}
