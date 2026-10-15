/** Synthetic-only composition shared by unit tests and the loopback browser fixture. */
import { createHash } from 'node:crypto';
import { CanonicalBridge, MemoryCanonicalBridgeStore } from '../../src/office/backend/canonical-bridge';
import { ExternalProposalService, MemoryExternalProposalStore, proposalBridgeScope, type ProposalAuthority, type SyntheticProposalDocument, type ExternalProposalStore } from '../../src/office/backend/external-proposal';
import { createEventQuoteService } from '../../src/office/backend/event-quote-workflow';
import { MemoryEventQuoteStore, testBrief, testCatalog, testScope, testActor } from './event-quote-fixtures';
import type { ProposalTarget } from '../../src/office/external-proposal-contracts';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
export async function proposalFixture(store: ExternalProposalStore = new MemoryExternalProposalStore()) {
  let now = Date.now(), withdrawn = false;
  let providerHook: (() => Promise<void>) | undefined;
  const quoteStore = new MemoryEventQuoteStore();
  const quoteService = createEventQuoteService({ store: quoteStore, clock: () => now, catalogFor: async () => ({ ...testCatalog, validUntilMs: now + 600_000 }) });
  const actor = { ...testActor, expiresAtMs: now + 600_000 };
  const bridge = new CanonicalBridge(new MemoryCanonicalBridgeStore(), { sources: [{ sourceSystem: 'fixture:proposal', partition: 'demo' }], clock: () => now });
  const targets: ProposalTarget[] = ['a', 'b'].map(s => ({ leadId: `demo-history-${s}`, eventId: `SYNTHETIC-EVENT-${s}`, proposalId: `SYNTHETIC-PROPOSAL-${s}` }));
  const authorities = new Map<string, ProposalAuthority>(), documents = new Map<string, SyntheticProposalDocument>();
  for (const [index, target] of targets.entries()) {
    const record = await quoteService.execute(testScope, actor, target.eventId, { action: 'create', key: `brief-${index}`, expectedRevision: 0, brief: testBrief });
    const source = { accountId: 'demo-account', boardId: '200', itemId: String(300 + index) };
    const authority: ProposalAuthority = {
      lead: { identityKey: 'synthetic-test-identity', durableIdentity: false, scope: testScope, expiresAtMs: actor.expiresAtMs, canRead: true, canOpen: false, leadIds: targets.map(t => t.leadId) },
      quote: { scope: testScope, actor, csrfToken: 'existing_fixture_csrf_not_a_credential', expiresAtMs: actor.expiresAtMs },
      eventIds: targets.map(t => t.eventId), bindingId: `proposal-binding-${index}`, leadVersionId: '', eventVersionId: '', source,
      brief: { digest: record.record.briefs[0].digest, recipient: testBrief.recipient },
    };
    const scope = proposalBridgeScope(authority);
    for (const kind of ['lead', 'event'] as const) {
      const state = await bridge.snapshot(scope);
      const receipt = await bridge.execute(scope, { action: 'record_source', idempotencyKey: `${kind}-${index}`, expectedRevision: state.revision, kind,
        reference: { sourceSystem: 'fixture:proposal', boardId: source.boardId, itemId: kind === 'lead' ? source.itemId : target.eventId }, sourceVersion: 'v1', contentDigest: sha(`${kind}-${index}`), provenance: { evidenceRef: `fixture-${kind}-${index}`, observedAtMs: now } });
      if (!('id' in receipt.recorded)) throw new Error('Invalid fixture');
      if (kind === 'lead') authority.leadVersionId = receipt.recorded.id; else authority.eventVersionId = receipt.recorded.id;
    }
    const state = await bridge.snapshot(scope);
    await bridge.execute(scope, { action: 'bind', idempotencyKey: `bind-${index}`, expectedRevision: state.revision, bindingId: authority.bindingId, expectedBindingRevision: 0, expectedBindingDigest: null, evidenceRef: `fixture-binding-${index}`, refs: { lead: authority.leadVersionId, event: authority.eventVersionId, quote: null, invoice: null } });
    authorities.set(target.leadId, authority);
    documents.set(target.proposalId, { ...target, scope: testScope, provider: 'synthetic', sourceVersion: 'v1', content: `PROPUESTA SINTÉTICA ${index + 1}\nServicio de prueba para 24 asistentes.\nCondiciones de muestra; disponibilidad sin confirmar.\nNo enviada ni aceptada.`, evidenceRef: `fixture-document-${index}`, historicalLink: { provenance: { ...source, columnId: 'text_mm1mkvn', updateId: null, observedAt: new Date(now).toISOString(), changedAt: null, originalValueType: 'text' }, originalUrl: `https://proposal.example.test/existing?boardId=200&itemId=${source.itemId}` } });
  }
  const options = { bridge, store, clock: () => now,
    async resolveAuthority(target: ProposalTarget) {
      if (withdrawn) return null;
      const a = authorities.get(target.leadId);
      if (!a) return null;
      const saved = await quoteService.read(testScope, actor, target.eventId);
      const brief = saved.record.briefs.at(-1)!;
      return structuredClone({ ...a, brief: { digest: brief.digest, recipient: brief.recipient } });
    },
    provider: { async read(target: ProposalTarget) {
      if (providerHook) await providerHook();
      const document = documents.get(target.proposalId);
      if (!document) throw new Error('Missing synthetic document');
      return structuredClone(document);
    } },
  };
  return { service: new ExternalProposalService(options), restart: () => new ExternalProposalService(options), bridge, store, targets, authorities, documents, quoteService, actor,
    withdraw(value = true) { withdrawn = value; }, clock(value: number) { now = value; }, providerHook(value?: () => Promise<void>) { providerHook = value; },
    async changeBrief(target = targets[0], recipient = 'other@example.test') {
      const view = await quoteService.read(testScope, actor, target.eventId);
      return quoteService.execute(testScope, actor, target.eventId, { action: 'brief', key: `brief-change-${view.record.revision}`, expectedRevision: view.record.revision, brief: { ...testBrief, recipient } });
    },
  };
}
