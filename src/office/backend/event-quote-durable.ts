import type { FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { EventQuoteError, type CatalogSnapshot, type QuoteScope, type TestPaymentDraftDependenciesV2 } from './event-quote-contracts';
import { createEventQuoteApi, type RunQuoteAuthorization } from './event-quote-http';
import { PostgresQuoteAccessRepository, type ExistingQuoteSession } from './quote-access-postgres';
import { PostgresEventQuoteStore } from './event-quote-postgres';
import { assertEventId, createEventQuoteService } from './event-quote-workflow';
import type { MondayVault } from './monday-store';

/** Opt-in TEST_ONLY composition. Never starts a server or provisions accounts,
 * credentials, memberships, grants, catalogs or database schemas. The caller
 * must supply proof from an existing server-owned session adapter. */
export function createDurableTestQuoteApi(options: {
  pool: Pool;
  vault: Pick<MondayVault, 'seal' | 'open'>;
  allowedOrigin: string;
  resolveExistingSession(request: FastifyRequest): ExistingQuoteSession | null | Promise<ExistingQuoteSession | null>;
  catalogFor(scope: QuoteScope): Promise<CatalogSnapshot | null>;
  accessSchema?: string;
  quoteSchema?: string;
  /** One already assigned event. Omission leaves the Dashboard projection unregistered. */
  dashboardEventId?: string;
  /** Explicit synthetic-only lead binding and isolated contract validator.
   * Omission keeps configuration and registration commands disabled. */
  testPaymentDrafts?: TestPaymentDraftDependenciesV2;
  clock?: () => number;
}) {
  const clock = options.clock ?? Date.now;
  const access = new PostgresQuoteAccessRepository(options.pool, { schema: options.accessSchema, clock });
  const eventId = options.dashboardEventId;
  if (eventId !== undefined) {
    assertEventId(eventId);
    if (eventId === 'status') throw new EventQuoteError('INVALID_ID', 400);
  }
  const runAuthorized: RunQuoteAuthorization = async (request, target, operation) => {
    const proof = await options.resolveExistingSession(request);
    // With the single-event Dashboard opt-in, even its status uses that grant.
    // This never derives event authorization from role-only status.
    return access.run(proof, target.kind === 'status' && eventId !== undefined ? { kind: 'read', eventId } : target, async (identity, client) => {
      const store = new PostgresEventQuoteStore(options.pool, {
        vault: options.vault, schema: options.quoteSchema, transaction: client,
      });
      const service = createEventQuoteService({ store, catalogFor: options.catalogFor, clock, testPaymentDrafts: options.testPaymentDrafts });
      return operation(identity, service);
    });
  };
  return createEventQuoteApi({
    allowedOrigin: options.allowedOrigin, clock, runAuthorized,
    dashboardAccess: eventId === undefined ? undefined : request => runAuthorized(request, { kind: 'read', eventId }, async (identity, service) => {
      // This status call uses the event-authorized identity, never role-only /status.
      const status = await service.status(identity.scope, { ...identity.actor, expiresAtMs: identity.expiresAtMs });
      if (!identity.accessRevision || identity.scope.mode !== 'test' || !identity.actor.durable
        || !status.catalog || !status.catalogDigest || status.catalog.authority !== 'test_only'
        || !status.enabled && status.reason !== 'READ_ONLY') throw new EventQuoteError('QUOTE_ACCESS_UNAVAILABLE', 503);
      const now = clock();
      const expiresAtMs = Math.min(identity.expiresAtMs, status.catalog.validUntilMs, now + 15 * 60_000);
      if (!Number.isSafeInteger(now) || expiresAtMs <= now) throw new EventQuoteError('ACCESS_DENIED', 403);
      return { state: 'ready', identityKey: identity.accessRevision, serverRevision: identity.accessRevision, durableIdentity: true, scope: { ...identity.scope },
        expiresAtMs, eventIds: [eventId],
        permissions: { canRead: true, canWrite: identity.actor.canWrite, canApprove: identity.actor.canApprove },
        catalog: { ready: true, digest: status.catalogDigest, validUntilMs: status.catalog.validUntilMs, authority: 'test_only' } };
    }),
  });
}
