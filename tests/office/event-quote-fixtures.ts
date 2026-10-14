import { EventQuoteError, type BriefInput, type CatalogSnapshot, type EventQuoteRecord, type EventQuoteStore, type QuoteActor, type QuoteScope } from '../../src/office/backend/event-quote-contracts';
import { assertEventQuoteRecord, canonical, createEventQuoteService, digest } from '../../src/office/backend/event-quote-workflow';

export const TEST_AT = 1791918000000;
export const testScope: QuoteScope = { organizationId: 'TEST-ORG', workspaceId: 'TEST-WORKSPACE', mode: 'test' };
export const testActor: QuoteActor = { actorId: 'TEST-ACTOR', durable: false, expiresAtMs: TEST_AT + 172800000, canWrite: true, canApprove: true };
export const testBrief: BriefInput = { contactName: 'Contacto sintético', recipient: 'client@example.test', originalMessage: 'Consulta de prueba completa; solicito propuesta con servicio para 24 asistentes.', attendees: 24, proposedDate: '2026-11-24 19:00 America/Lima', proposedLocation: 'Lugar sintético, por verificar', requirements: 'Servicio sintético, sin confirmación operativa.' };
export const testCatalog: CatalogSnapshot = { id: 'TEST-CATALOG', version: 'v1', authority: 'test_only', approvalRef: 'test:arithmetic-only', source: 'Fixture aislado; no precios Gourmet', currency: 'USD', validUntilMs: TEST_AT + 86400000, taxBps: 700, depositBps: 5000, terms: 'Condiciones sintéticas exclusivamente para pruebas.', items: [{ id: 'TEST-ITEM', label: 'Partida sintética', unit: 'persona', unitPriceCents: 101 }] };

export class MemoryEventQuoteStore implements EventQuoteStore {
  private rows = new Map<string, EventQuoteRecord>();
  private queue: Promise<unknown> = Promise.resolve();
  async read(scope: QuoteScope, eventId: string) { const r = this.rows.get(digest({ scope, eventId })); return r ? structuredClone(r) : null; }
  transact(scope: QuoteScope, eventId: string, change: (current: EventQuoteRecord | null) => EventQuoteRecord | Promise<EventQuoteRecord>): Promise<EventQuoteRecord> {
    const next = this.queue.then(async () => {
      const current = await this.read(scope, eventId); const r = await change(current ? structuredClone(current) : null); assertEventQuoteRecord(r, scope, eventId);
      if (current) for (const key of ['briefs', 'quotes', 'decisions', 'audit', 'receipts'] as const) if (canonical(current[key]) !== canonical(r[key].slice(0, current[key].length))) throw new EventQuoteError('APPEND_ONLY', 409);
      this.rows.set(digest({ scope, eventId }), structuredClone(r)); return structuredClone(r);
    }); this.queue = next.catch(() => {}); return next;
  }
}
export function testService() {
  const store = new MemoryEventQuoteStore(); let catalog: CatalogSnapshot | null = structuredClone(testCatalog); let now = TEST_AT;
  const service = createEventQuoteService({ store, catalogFor: async () => catalog, clock: () => now });
  return { store, service, catalog(value: CatalogSnapshot | null) { catalog = value; }, clock(value: number) { now = value; } };
}
