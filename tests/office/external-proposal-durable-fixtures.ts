import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { DEFAULT_OFFICE_DATABASE_URL } from '../../src/office/backend/postgres-store';
import { MondayVault } from '../../src/office/backend/monday-store';
import { PostgresQuoteAccessRepository } from '../../src/office/backend/quote-access-postgres';
import { PostgresEventQuoteStore } from '../../src/office/backend/event-quote-postgres';
import { CanonicalBridge } from '../../src/office/backend/canonical-bridge';
import { PostgresCanonicalBridgeStore } from '../../src/office/backend/canonical-bridge-postgres';
import { PostgresExternalProposalRepository } from '../../src/office/backend/external-proposal-postgres';
import { createDurableTestProposalService } from '../../src/office/backend/external-proposal-durable';
import { proposalBridgeScope } from '../../src/office/backend/external-proposal';
import { proposalFixture } from './external-proposal-fixtures';
import { testScope } from './event-quote-fixtures';
export const durableProposalProof = { sessionToken: 'dashboard_synthetic_session_1234', csrfToken: 'dashboard_synthetic_csrf_1234' };
export const proposalVault = () => new MondayVault(Buffer.alloc(32, 79)); // Existing synthetic vault fixture, never a production key.
export async function durableProposalFixture() {
 const memory = await proposalFixture(), target = memory.targets[0], authority = memory.authorities.get(target.leadId)!;
 const actorId = authority.quote.actor.actorId, scope = testScope, at = Date.now(); let now = at;
 const schemas = { accessSchema: `quote_access_test_${randomUUID().replaceAll('-', '')}`, quoteSchema: `quote_test_${randomUUID().replaceAll('-', '')}`, bridgeSchema: `bridge_test_${randomUUID().replaceAll('-', '')}`, proposalSchema: `proposal_test_${randomUUID().replaceAll('-', '')}` };
 const pool = new Pool({ connectionString: DEFAULT_OFFICE_DATABASE_URL, connectionTimeoutMillis: 1000, max: 6 });
 const vault = proposalVault(), access = new PostgresQuoteAccessRepository(pool, { schema: schemas.accessSchema });
 const repository = new PostgresExternalProposalRepository(pool, vault, schemas.proposalSchema);
 const sources = [{ sourceSystem: 'fixture:proposal', partition: 'demo' }] as const;
 const mapping = { bindingId: authority.bindingId, leadVersionId: authority.leadVersionId, eventVersionId: authority.eventVersionId, source: authority.source };
 const options = { pool, vault, target, ...schemas, clock: () => now };
 try {
  await access.initializeTestSchema(); await repository.initializeTestSchema();
  await new PostgresEventQuoteStore(pool, { vault, schema: schemas.quoteSchema }).initialize();
  await pool.query((await readFile(new URL('../../migrations/office/004_canonical_bridge.up.sql', import.meta.url), 'utf8')).replaceAll('office_canonical_bridge', schemas.bridgeSchema));
  const hash = (s: string) => createHash('sha256').update(s).digest('hex'), s = [scope.organizationId, scope.workspaceId, scope.mode];
  // Only these fresh loopback schemas contain synthetic existing authority rows.
  // The service itself never provisions accounts, roles, sessions or grants.
  await pool.query(`INSERT INTO ${schemas.accessSchema}.users VALUES ($1,$2,$3,$4,'MANAGER',true,1)`, [...s, actorId]);
  await pool.query(`INSERT INTO ${schemas.accessSchema}.memberships VALUES ('proposal-test-membership',$1,$2,$3,$4,1,$5,NULL)`, [...s, actorId, new Date(at - 1000)]);
  await pool.query(`INSERT INTO ${schemas.accessSchema}.sessions VALUES ($1,$2,$3,$4,$5,$6,'proposal-test-membership',1,1,$7,NULL)`, [hash(durableProposalProof.sessionToken), hash(durableProposalProof.csrfToken), ...s, actorId, new Date(at + 600000)]);
  await pool.query(`INSERT INTO ${schemas.accessSchema}.assignments VALUES ($1,$2,$3,$4,$5,1,true)`, [...s, target.eventId, actorId]);
  await pool.query(`INSERT INTO ${schemas.accessSchema}.event_grants VALUES ($1,$2,$3,$4,$5,1,true,true,true,$6,NULL)`, [...s, target.eventId, actorId, new Date(at - 1000)]);
  const quote = await memory.quoteService.read(scope, memory.actor, target.eventId);
  await new PostgresEventQuoteStore(pool, { vault, schema: schemas.quoteSchema }).transact(scope, target.eventId, () => quote.record);
  const bridge = new CanonicalBridge(new PostgresCanonicalBridgeStore(pool, { schema: schemas.bridgeSchema, sources }), { sources, clock: () => at });
  const bridgeScope = proposalBridgeScope(authority), prior = await memory.bridge.snapshot(bridgeScope);
  for (const source of prior.sourceVersions) {
   const state = await bridge.snapshot(bridgeScope);
   await bridge.execute(bridgeScope, { action: 'record_source', idempotencyKey: `durable-source-${state.revision}`, expectedRevision: state.revision, kind: source.kind, reference: source.reference, sourceVersion: source.sourceVersion, contentDigest: source.contentDigest, provenance: source.provenance });
  }
  const state = await bridge.snapshot(bridgeScope);
  await bridge.execute(bridgeScope, { action: 'bind', idempotencyKey: 'durable-bind', expectedRevision: state.revision, bindingId: mapping.bindingId, expectedBindingRevision: 0, expectedBindingDigest: null, evidenceRef: 'durable-fixture-binding', refs: { lead: mapping.leadVersionId, event: mapping.eventVersionId, quote: null, invoice: null } });
  const service = createDurableTestProposalService({ ...options, mapping }), document = memory.documents.get(target.proposalId)!;
  await service.publish(durableProposalProof, document);
  return { ...options, at, actorId, scope, mapping, service, repository, bridge, bridgeScope, document, proof: durableProposalProof,
   setClock(value: number) { now = value; },
   async close() { try { for (const schema of Object.values(schemas)) await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } finally { await pool.end(); } },
  };
 } catch (error) { for (const schema of Object.values(schemas)) await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {}); await pool.end(); throw error; }
}
