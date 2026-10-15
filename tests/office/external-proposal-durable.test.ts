import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Pool, type PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { DEFAULT_OFFICE_DATABASE_URL } from '../../src/office/backend/postgres-store';
import { createDurableTestProposalService } from '../../src/office/backend/external-proposal-durable';
import { PostgresEventQuoteStore } from '../../src/office/backend/event-quote-postgres';
import { PostgresExternalProposalRepository } from '../../src/office/backend/external-proposal-postgres';
import { CanonicalBridge } from '../../src/office/backend/canonical-bridge';
import { PostgresCanonicalBridgeStore } from '../../src/office/backend/canonical-bridge-postgres';
import { createEventQuoteService } from '../../src/office/backend/event-quote-workflow';
import { testBrief, testCatalog } from './event-quote-fixtures';
import { durableProposalFixture } from './external-proposal-durable-fixtures';
import type { ExternalProposalCommand } from '../../src/office/external-proposal-contracts';
const exec = promisify(execFile);
const associate: ExternalProposalCommand = { action: 'associate', key: 'durable-associate', expectedRevision: 0 };
const v2 = (f: Awaited<ReturnType<typeof durableProposalFixture>>) => ({ ...structuredClone(f.document), sourceVersion: 'v2', content: f.document.content + '\nSynthetic v2' });
const approve = (view: Awaited<ReturnType<ReturnType<typeof createDurableTestProposalService>['read']>>): ExternalProposalCommand => ({ action: 'approve', key: 'durable-approve', expectedRevision: view.revision, reviewKey: view.snapshot!.reviewKey });
const sources = [{ sourceSystem: 'fixture:proposal', partition: 'demo' }] as const;
const quoteService = (f: Awaited<ReturnType<typeof durableProposalFixture>>, pool = f.pool) => createEventQuoteService({
 store: new PostgresEventQuoteStore(pool, { vault: f.vault, schema: f.quoteSchema }), clock: () => f.at,
 catalogFor: async () => ({ ...testCatalog, validUntilMs: f.at + 3600000 }),
});
const changeBrief = async (f: Awaited<ReturnType<typeof durableProposalFixture>>, pool = f.pool) => {
 const service = quoteService(f, pool), actor = { actorId: f.actorId, durable: true, canWrite: true, canApprove: true, expiresAtMs: f.at + 600000 };
 return service.execute(f.scope, actor, f.target.eventId, { action: 'brief', key: 'durable-brief-change', expectedRevision: 1, brief: { ...testBrief, recipient: 'changed@example.test' } });
};

test('encrypted documents, history and receipts recover in a new OS process with an idempotent replay', async () => {
 const f = await durableProposalFixture();
 try {
  const view = await f.service.execute(f.proof, associate), command = approve(view);
  await f.service.execute(f.proof, command);
  const config = { target: f.target, at: f.at, accessSchema: f.accessSchema, quoteSchema: f.quoteSchema, bridgeSchema: f.bridgeSchema, proposalSchema: f.proposalSchema, command };
  const firstChild = await exec(process.execPath, ['--import', 'tsx', 'tests/office/external-proposal-recovery-child.ts', JSON.stringify(config)], { maxBuffer: 1024 * 1024 });
  const current = JSON.parse(firstChild.stdout); assert.equal(current.view.status, 'approved_internal_unsent'); assert.equal(current.replay.revision, 2);
  assert.notEqual(current.view.identityKey, view.identityKey);
  await f.service.publish(f.proof, v2(f));
  const history = await f.service.history(f.proof);
  const child = await exec(process.execPath, ['--import', 'tsx', 'tests/office/external-proposal-recovery-child.ts', JSON.stringify(config)], { maxBuffer: 1024 * 1024 });
  const recovered = JSON.parse(child.stdout);
  assert.deepEqual(recovered.history, history); assert.equal(recovered.history.documents.length, 2);
  assert.equal(recovered.history.record.receipts.length, 2); assert.equal(recovered.history.record.approvals.length, 1);
  assert.equal(recovered.view.status, 'obsolete'); assert.equal(recovered.replay.status, 'obsolete'); assert.equal(recovered.replay.revision, 2);
  const raw = await f.pool.query(`SELECT payload::text FROM ${f.proposalSchema}.events`);
  assert.ok(!raw.rows[0].payload.includes('client@example.test')); assert.ok(!raw.rows[0].payload.includes('PROPUESTA'));
 } finally { await f.close(); }
});
test('independent pools serialize concurrent exact retries and conflicting revisions', async () => {
 const f = await durableProposalFixture(), pool = new Pool({ connectionString: DEFAULT_OFFICE_DATABASE_URL, connectionTimeoutMillis: 1000 });
 try {
  const other = createDurableTestProposalService({ ...f, pool });
  const views = await Promise.all([f.service.execute(f.proof, associate), other.execute(f.proof, associate)]);
  assert.equal(views[0].revision, 1); assert.equal(views[1].revision, 1);
  const command = approve(views[0]);
  const results = await Promise.allSettled([f.service.execute(f.proof, command), other.execute(f.proof, { ...command, key: 'other-command' })]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const h = await f.service.history(f.proof); assert.equal(h!.record!.receipts.length, 2); assert.equal(h!.record!.approvals.length, 1);
 } finally { await pool.end(); await f.close(); }
});
test('v1 -> v2 during the last resolveAuthority cannot persist a stale approval or receipt', async t => {
 const f = await durableProposalFixture();
 try {
  const view = await f.service.execute(f.proof, associate), original = PostgresEventQuoteStore.prototype.read;
  let calls = 0, changed = false;
  t.mock.method(PostgresEventQuoteStore.prototype, 'read', async function(this: PostgresEventQuoteStore, ...args: Parameters<PostgresEventQuoteStore['read']>) {
   const result = await original.apply(this, args);
   if (++calls === 4) {
    const client = (this as unknown as { transaction: PoolClient }).transaction;
    const current = (await f.repository.load(client, f.scope, f.actorId, f.target))!;
    await f.repository.save(client, current, { ...current, revision: current.revision + 1, documents: [...current.documents, v2(f)] }); changed = true;
   }
   return result;
  });
  await assert.rejects(f.service.execute(f.proof, approve(view)), (e: any) => e.code === 'PROPOSAL_SOURCE_CHANGED');
  assert.equal(changed, true); t.mock.restoreAll();
  const h = await f.service.history(f.proof); assert.equal(h!.record!.revision, 1); assert.equal(h!.record!.approvals.length, 0); assert.equal(h!.record!.receipts.length, 1);
  assert.equal(h!.documents.length, 1); // The same-transaction injected publication rolled back too.
  assert.equal((await f.pool.query(`SELECT count(*)::int AS n FROM ${f.proposalSchema}.audit_events`)).rows[0].n, 2);
 } finally { await f.close(); }
});
for (const revoke of ['session', 'grant', 'assignment']) test(`existing ${revoke} revocation denies a write and leaves history intact`, async () => {
 const f = await durableProposalFixture();
 try {
  await f.service.execute(f.proof, associate);
  if (revoke === 'session') await f.pool.query(`UPDATE ${f.accessSchema}.sessions SET revoked_at=clock_timestamp()`);
  if (revoke === 'grant') await f.pool.query(`UPDATE ${f.accessSchema}.event_grants SET enabled=false`);
  if (revoke === 'assignment') await f.pool.query(`UPDATE ${f.accessSchema}.assignments SET active=false`);
  await assert.rejects(f.service.execute(f.proof, { action: 'associate', key: 'denied', expectedRevision: 1 }));
  const count = await f.pool.query(`SELECT count(*)::int AS n FROM ${f.proposalSchema}.audit_events`); assert.equal(count.rows[0].n, 2);
 } finally { await f.close(); }
});
test('expiry after the encrypted SQL write rolls back document review, audit and receipt', async t => {
 const f = await durableProposalFixture();
 try {
  const view = await f.service.execute(f.proof, associate), original = PostgresExternalProposalRepository.prototype.save;
  t.mock.method(PostgresExternalProposalRepository.prototype, 'save', async function(this: PostgresExternalProposalRepository, ...args: Parameters<PostgresExternalProposalRepository['save']>) {
   await original.apply(this, args); f.setClock(f.at + 600001);
  });
  await assert.rejects(f.service.execute(f.proof, approve(view))); t.mock.restoreAll(); f.setClock(f.at);
  const h = await f.service.history(f.proof); assert.equal(h!.record!.revision, 1); assert.equal(h!.record!.approvals.length, 0);
  assert.equal((await f.pool.query(`SELECT count(*)::int AS n FROM ${f.proposalSchema}.audit_events`)).rows[0].n, 2);
 } finally { await f.close(); }
});
test('latest document, brief recipient and canonical binding must all match the approved snapshot', async () => {
 const f = await durableProposalFixture();
 try {
  const view = await f.service.execute(f.proof, associate); await changeBrief(f);
  await assert.rejects(f.service.execute(f.proof, approve(view)));
  const reviewedBrief = await f.service.execute(f.proof, { ...associate, key: 'associate-brief-v2', expectedRevision: 1 });
  assert.equal(reviewedBrief.snapshot!.intendedRecipient, 'changed@example.test');
  await f.service.publish(f.proof, v2(f));
  await assert.rejects(f.service.execute(f.proof, approve(reviewedBrief)));
  const h = await f.service.history(f.proof); assert.equal(h!.record!.approvals.length, 0);
  const next = await f.service.execute(f.proof, { ...associate, key: 'associate-v2', expectedRevision: 2 });
  const state = await f.bridge.snapshot(f.bridgeScope), binding = state.bindings.at(-1)!;
  await f.bridge.execute(f.bridgeScope, { action: 'unlink', idempotencyKey: 'unlink-durable', expectedRevision: state.revision, bindingId: f.mapping.bindingId, expectedBindingRevision: binding.revision, expectedBindingDigest: binding.digest, evidenceRef: 'fixture-unlink' });
  await assert.rejects(f.service.execute(f.proof, approve(next)));
 } finally { await f.close(); }
});

for (const resource of ['document', 'brief', 'binding', 'grant']) test(`another connection cannot change ${resource} during the last authority read`, async t => {
 const f = await durableProposalFixture(), appName = `proposal-writer-${randomUUID()}`;
 const pool = new Pool({ connectionString: DEFAULT_OFFICE_DATABASE_URL, connectionTimeoutMillis: 1000, application_name: appName });
 let release!: () => void, entered!: () => void;
 const barrier = new Promise<void>(r => { release = r; }), started = new Promise<void>(r => { entered = r; });
 let decision: Promise<unknown> | undefined, publication: Promise<unknown> | undefined;
 try {
  const view = await f.service.execute(f.proof, associate), original = PostgresEventQuoteStore.prototype.read; let calls = 0;
  const bridge = new CanonicalBridge(new PostgresCanonicalBridgeStore(pool, { schema: f.bridgeSchema, sources }), { sources, clock: () => f.at });
  const state = await bridge.snapshot(f.bridgeScope), binding = state.bindings.at(-1)!;
  t.mock.method(PostgresEventQuoteStore.prototype, 'read', async function(this: PostgresEventQuoteStore, ...args: Parameters<PostgresEventQuoteStore['read']>) {
   const result = await original.apply(this, args); if (++calls === 4) { entered(); await barrier; } return result;
  });
  decision = f.service.execute(f.proof, approve(view));
  await started;
  if (resource === 'document') publication = createDurableTestProposalService({ ...f, pool }).publish(f.proof, v2(f));
  if (resource === 'brief') publication = changeBrief(f, pool);
  if (resource === 'binding') publication = bridge.execute(f.bridgeScope, { action: 'bind', idempotencyKey: 'concurrent-bind', expectedRevision: state.revision, bindingId: binding.bindingId, expectedBindingRevision: binding.revision, expectedBindingDigest: binding.digest, refs: binding.refs!, evidenceRef: 'fixture-concurrent-bind' });
  if (resource === 'grant') publication = pool.query(`UPDATE ${f.accessSchema}.event_grants SET enabled=false`);
  let locked = false;
  for (let i = 0; i < 100; i++) {
   const result = await f.pool.query(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock') AS blocked`, [appName]);
   if (result.rows[0].blocked) { locked = true; break; } await new Promise(r => setTimeout(r, 10));
  }
  assert.equal(locked, true, 'Competing mutation must wait for the approval transaction');
  release(); const approved = await decision as { status: string }; assert.equal(approved.status, 'approved_internal_unsent'); await publication;
  t.mock.restoreAll();
  if (resource === 'grant') await assert.rejects(f.service.read(f.proof));
  else assert.equal((await f.service.read(f.proof)).status, 'obsolete');
 } finally { release(); await Promise.allSettled([decision, publication].filter(Boolean)); t.mock.restoreAll(); await pool.end(); await f.close(); }
});

test('borrowed canonical bridge client leaves commit and rollback ownership with the caller', async () => {
 const f = await durableProposalFixture(), client = await f.pool.connect();
 try {
  const before = await f.bridge.snapshot(f.bridgeScope); await client.query('BEGIN');
  const bridge = new CanonicalBridge(new PostgresCanonicalBridgeStore(f.pool, { schema: f.bridgeSchema, sources, transaction: client }), { sources, clock: () => f.at });
  await bridge.execute(f.bridgeScope, { action: 'record_source', idempotencyKey: 'borrowed-rollback', expectedRevision: before.revision, kind: 'lead', reference: { sourceSystem: 'fixture:proposal', boardId: '200', itemId: 'rollback-lead' }, sourceVersion: 'v1', contentDigest: 'a'.repeat(64), provenance: { evidenceRef: 'fixture-rollback', observedAtMs: f.at } });
  await client.query('ROLLBACK'); assert.deepEqual(await f.bridge.snapshot(f.bridgeScope), before);
 } finally { client.release(); await f.close(); }
});

test('source versions are immutable, publication retries do not append and reference_only cannot approve', async () => {
 const f = await durableProposalFixture();
 try {
  await f.service.publish(f.proof, f.document); assert.equal((await f.service.history(f.proof))!.revision, 1);
  await assert.rejects(f.service.publish(f.proof, { ...f.document, content: 'Rewritten under v1' }));
  await f.service.publish(f.proof, { ...v2(f), content: null });
  const view = await f.service.execute(f.proof, associate); assert.equal(view.status, 'reference_only');
  await assert.rejects(f.service.execute(f.proof, approve(view)));
  assert.equal((await f.service.history(f.proof))!.record!.approvals.length, 0);
 } finally { await f.close(); }
});
test('wrong vault, foreign case and append-history rewrites fail closed; SQL audit cannot be erased', async () => {
 const f = await durableProposalFixture();
 try {
  await f.service.execute(f.proof, associate);
  const foreign = createDurableTestProposalService({ ...f, target: { ...f.target, leadId: 'foreign-lead' } });
  assert.equal(await foreign.history(f.proof), null);
  const wrong = createDurableTestProposalService({ ...f, vault: { seal: f.vault.seal.bind(f.vault), open() { throw new Error('Wrong fixture vault'); } } });
  await assert.rejects(wrong.history(f.proof));
  const client = await f.pool.connect();
  try {
   await client.query('BEGIN'); const prior = (await f.repository.load(client, f.scope, f.actorId, f.target))!;
   const rewritten = structuredClone(prior); rewritten.revision++; rewritten.documents[0].content = 'Changed old document';
   await assert.rejects(f.repository.save(client, prior, rewritten)); await client.query('ROLLBACK');
  } finally { client.release(); }
  await assert.rejects(f.pool.query(`DELETE FROM ${f.proposalSchema}.audit_events`));
  await assert.rejects(f.pool.query(`TRUNCATE ${f.proposalSchema}.audit_events`));
  assert.equal((await f.service.history(f.proof))!.record!.receipts.length, 1);
 } finally { await f.close(); }
});
