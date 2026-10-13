import type { CommunicationsScope, CommunicationsStore, Observation } from './communications-contracts';
import { createCommunicationsWorkflow } from './communications';
import type { FixtureCommunicationsDependencies } from './communications-http';

// All names, identifiers and reserved .test contacts below are invented. This
// adapter is server-owned and has no provider client, token or network fallback.
export function communicationsFixtureObservations(at: number): Observation[] {
  const common = { providerVersion: 'fixture-v1', observedAtMs: at };
  const rows: Observation[] = [];
  for (const [itemId, displayName, email] of [
    ['fixture-lead-aurora', 'Aurora · contacto sintético', 'aurora@example.test'],
    ['fixture-lead-cedar', 'Cedar · contacto sintético', 'cedar@example.test'],
  ]) {
    rows.push({ ...common, kind: 'lead', source: 'monday', sourceKey: `fixture-board:${itemId}`, data: { boardId: 'fixture-board', itemId, displayName, email, phone: null, phoneCountry: null, eventDate: '2026-11-12', guestsText: '12 invitados sintéticos', eventTypeText: 'Cena de prueba', serviceStyleText: 'Familiar', mappingVersion: 'fixture-v1' } });
    rows.push({ ...common, kind: 'event', source: 'event_reference', sourceKey: `event-${itemId}`, data: { eventId: `event-${itemId}`, leadItemId: itemId, eventDate: '2026-11-12', evidenceRef: `fixture:event:${itemId}` } });
  }
  for (const mailbox of ['felipe', 'info'] as const) {
    rows.push({ ...common, kind: 'account', source: 'gmail', sourceKey: `${mailbox}:fixture-${mailbox}`, data: { mailbox, accountId: `fixture-${mailbox}`, email: `${mailbox}@example.test`, verified: true } });
    const contacts = mailbox === 'felipe' ? ['aurora'] : ['aurora', 'cedar'];
    for (const contact of contacts) {
      const threadId = `fixture-${contact}-${mailbox}`;
      rows.push({ ...common, kind: 'thread', source: 'gmail', sourceKey: `${mailbox}:fixture-${mailbox}:${threadId}`, data: { mailbox, accountId: `fixture-${mailbox}`, threadId, messages: [{ id: `${threadId}-message`, from: [`${contact}@example.test`], to: [`${mailbox}@example.test`], cc: [], subject: `Consulta ${contact} · SINTÉTICA`, bodyText: 'Solicitamos una propuesta para una cena de prueba. Este mensaje y sus contactos son ficticios.', attachments: [] }], coverage: contact === 'cedar' ? { scope: 'correspondence', incoming: 'complete', outgoing: 'complete' } : { scope: 'selected_thread', incoming: 'complete', outgoing: 'unknown' } } });
    }
  }
  return rows;
}

export function createFixtureCommunicationsDependencies(options: {
  storage: FixtureCommunicationsDependencies['storage'];
  storeFor: (scope: CommunicationsScope) => Promise<CommunicationsStore> | CommunicationsStore;
  clock?: () => number;
}): FixtureCommunicationsDependencies {
  const clock = options.clock ?? Date.now;
  return {
    mode: 'fixture', storage: options.storage, clock,
    async open(scope) {
      if (scope.organizationId !== 'gourmet-communications-fixture' || scope.dataMode !== 'fixture' || scope.partition !== 'external' || !/^fixture-[a-f0-9-]{36}$/.test(scope.actorId)) throw new Error('Fixture scope required');
      const workflow = createCommunicationsWorkflow({ scope, store: await options.storeFor(scope), clock });
      let view = await workflow.view();
      if (view.revision !== 0) throw new Error('Fresh fixture scope required');
      for (const observation of communicationsFixtureObservations(clock())) view = await workflow.recordObservation({ expectedRevision: view.revision, observation });
      return workflow;
    },
  };
}
