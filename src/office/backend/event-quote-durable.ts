import type { FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { CatalogSnapshot, QuoteScope } from './event-quote-contracts';
import { createEventQuoteApi } from './event-quote-http';
import { PostgresQuoteAccessRepository, type ExistingQuoteSession } from './quote-access-postgres';
import { PostgresEventQuoteStore } from './event-quote-postgres';
import { createEventQuoteService } from './event-quote-workflow';
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
  clock?: () => number;
}) {
  const clock = options.clock ?? Date.now;
  const access = new PostgresQuoteAccessRepository(options.pool, { schema: options.accessSchema, clock });
  return createEventQuoteApi({
    allowedOrigin: options.allowedOrigin,
    clock,
    runAuthorized: async (request, target, operation) => {
      const proof = await options.resolveExistingSession(request);
      return access.run(proof, target, async (identity, client) => {
        const store = new PostgresEventQuoteStore(options.pool, {
          vault: options.vault, schema: options.quoteSchema, transaction: client,
        });
        const service = createEventQuoteService({ store, catalogFor: options.catalogFor, clock });
        return operation(identity, service);
      });
    },
  });
}
