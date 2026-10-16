/** Child API process: opens existing fixture schemas; never seeds or drops them. */
import { Pool } from 'pg';
import { createTestProposalApi } from '../../src/office/backend/external-proposal-http';
import { createDurableTestProposalService } from '../../src/office/backend/external-proposal-durable';
import { DEFAULT_OFFICE_DATABASE_URL } from '../../src/office/backend/postgres-store';
import { PostgresQuoteAccessRepository } from '../../src/office/backend/quote-access-postgres';
import { PostgresEventQuoteStore } from '../../src/office/backend/event-quote-postgres';
import { createEventQuoteService } from '../../src/office/backend/event-quote-workflow';
import { durableProposalProof, proposalVault } from '../office/external-proposal-durable-fixtures';
import { testCatalog } from '../office/event-quote-fixtures';
import type { EventQuoteIdentity } from '../../src/office/backend/event-quote-http';
const config = JSON.parse(process.argv[2]);
const pool = new Pool({ connectionString: DEFAULT_OFFICE_DATABASE_URL, connectionTimeoutMillis: 1000, max: 6 });
const vault = proposalVault(), proof = durableProposalProof;
const service = createDurableTestProposalService({ ...config, pool, vault });
const access = new PostgresQuoteAccessRepository(pool, { schema: config.accessSchema });
const app = createTestProposalApi({ service, allowedOrigin: 'http://127.0.0.1:4194', resolveExistingSession: () => proof });
const catalog = { ...testCatalog, validUntilMs: config.at + 600000 };
const quotes = <T,>(operation: (client: ReturnType<typeof createEventQuoteService>, identity: EventQuoteIdentity) => Promise<T>) => access.run(proof, { kind: 'read', eventId: config.target.eventId }, async (identity, client) => {
 const store = new PostgresEventQuoteStore(pool, { vault, schema: config.quoteSchema, transaction: client });
 return operation(createEventQuoteService({ store, catalogFor: async () => catalog }), identity);
});
// Read-only existing workspace. No quote writes, payment routes or new editor.
app.get('/__durable-quote/status', () => quotes(async (service, identity) => ({ ...await service.status(identity.scope, { ...identity.actor, expiresAtMs: identity.expiresAtMs, canWrite: false, canApprove: false }),
 session: { mode: 'test', canWrite: false, canApprove: false, csrfToken: proof.csrfToken, expiresAtMs: identity.expiresAtMs }, externalEffectsEnabled: false })));
app.get('/__durable-quote/read', () => quotes((service, identity) => service.read(identity.scope, { ...identity.actor, expiresAtMs: identity.expiresAtMs }, config.target.eventId)));
app.post('/__durable-fixture/control', async request => {
 const action = (request.body as { action: string }).action;
 if (action === 'version') {
  const value = await service.history(proof); if (!value) throw new Error('Missing fixture');
  const document = structuredClone(value.documents.at(-1)!); document.sourceVersion = `v${value.documents.length + 1}`; document.content += '\nVersión durable sintética actualizada.';
  await service.publish(proof, document);
 } else if (['readonly', 'revoke', 'restore'].includes(action)) {
  // Fixture controls only: mutate these pre-existing isolated SQL grants.
  const client = await pool.connect();
  try {
   await client.query('BEGIN');
   await client.query(`UPDATE ${config.accessSchema}.assignments SET version=version+1`);
   await client.query(`UPDATE ${config.accessSchema}.event_grants SET assignment_version=assignment_version+1, enabled=$1,can_approve=$2`, [action !== 'revoke', action === 'restore']);
   await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
 } else throw new Error('Unknown fixture control');
 return { ok: true };
});
app.get('/__durable-fixture/pid', async () => ({ pid: process.pid }));
let stopping = false;
async function stop() { if (stopping) return; stopping = true; await app.close(); await pool.end(); process.exit(0); }
process.once('SIGTERM', () => { void stop(); }); process.once('SIGINT', () => { void stop(); });
process.once('disconnect', () => { void stop(); });
await app.listen({ host: '127.0.0.1', port: 4195 });
process.send?.({ ready: true, pid: process.pid });
