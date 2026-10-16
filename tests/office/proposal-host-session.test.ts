import assert from 'node:assert/strict';
import test from 'node:test';
import { createExistingProposalSessionResolver } from '../../src/office/backend/proposal-host-session';
import { PostgresQuoteAccessRepository } from '../../src/office/backend/quote-access-postgres';
import { createDurableTestProposalService } from '../../src/office/backend/external-proposal-durable';
import { createTestProposalApi } from '../../src/office/backend/external-proposal-http';
import { EventQuoteError } from '../../src/office/backend/event-quote-contracts';
import { durableProposalFixture } from './external-proposal-durable-fixtures';
import { TEST_PROPOSAL_API as API } from '../../src/office/external-proposal-contracts';
const error = (code: string) => (e: unknown) => e instanceof EventQuoteError && e.code === code;
const target = { leadId: 'SYNTHETIC-LEAD', eventId: 'SYNTHETIC-EVENT', proposalId: 'SYNTHETIC-PROPOSAL' };
const input = () => ({ proof: { sessionToken: 'existing_synthetic_session_1234', csrfToken: 'existing_synthetic_csrf_1234' },
 scope: { organizationId: 'TEST-ORG', workspaceId: 'TEST-WORKSPACE', mode: 'test' }, actorId: 'TEST-ACTOR', target: { ...target }, expiresAtMs: Date.now() + 60000 });
const owned = (f: Awaited<ReturnType<typeof durableProposalFixture>>, expiresAtMs = f.at + 60000) => ({ proof: f.proof, scope: f.scope, actorId: f.actorId, target: f.target, expiresAtMs });
test('missing owner stays unavailable; request cookies, Basic, DEMO and bootstrap projections cannot supply authority', async () => {
 const resolve = createExistingProposalSessionResolver({ target });
 await assert.rejects(resolve({ headers: { authorization: 'Basic synthetic', cookie: 'gourmet_office_demo=synthetic' }, body: input() }), error('HOST_SESSION_UNCONFIGURED'));
 for (const raw of [null, { mode: 'demo', actorId: 'DEMO_ACTOR', storage: { durable: true } }, { authenticated: true, principal: 'OWNER_BOOTSTRAP' }, { role: 'operator', authenticated: true }]) {
  await assert.rejects(createExistingProposalSessionResolver({ target, owner: { readExistingSession: () => raw } })({}), error('AUTHENTICATION_REQUIRED'));
 }
 await assert.rejects(createExistingProposalSessionResolver({ target, owner: { readExistingSession() { throw new Error('private cookie secret'); } } })({}), error('HOST_SESSION_UNAVAILABLE'));
});
test('malformed, expired, commercial, contradictory and accessor-based owner responses fail before SQL', async () => {
 const changes = [
  (v: ReturnType<typeof input>) => { v.scope.mode = 'commercial'; },
  (v: ReturnType<typeof input>) => { v.expiresAtMs = Date.now() - 1; },
  (v: ReturnType<typeof input>) => { v.proof.sessionToken = 'bad'; },
  (v: ReturnType<typeof input>) => { v.target.eventId = 'OTHER-EVENT'; },
  (v: ReturnType<typeof input>) => { v.target.leadId = 'OTHER-LEAD'; },
  (v: ReturnType<typeof input>) => { v.target.proposalId = 'OTHER-PROPOSAL'; },
  (v: ReturnType<typeof input>) => { Object.assign(v, { durableIdentity: true, permissions: { canApprove: true } }); },
  (v: ReturnType<typeof input>) => { Object.assign(v.scope, { tenant: 'unmapped' }); },
 ];
 for (const change of changes) {
  const raw = input(); change(raw);
  await assert.rejects(createExistingProposalSessionResolver({ target, owner: { readExistingSession: () => raw } })({}), error('AUTHENTICATION_REQUIRED'));
 }
 let invoked = 0; const raw = input(); Object.defineProperty(raw.proof, 'csrfToken', { enumerable: true, get() { invoked++; return 'wrong'; } });
 await assert.rejects(createExistingProposalSessionResolver({ target, owner: { readExistingSession: () => raw } })({}), error('AUTHENTICATION_REQUIRED')); assert.equal(invoked, 0);
});
test('owner outputs and configured IDs are detached before later caller mutations', async () => {
 const raw = input(), configured = { ...target };
 const resolve = createExistingProposalSessionResolver({ target: configured, owner: { readExistingSession: () => raw } });
 configured.eventId = 'CHANGED'; const proof = await resolve({});
 raw.scope.workspaceId = 'CHANGED'; raw.proof.sessionToken = 'CHANGED'; raw.target.leadId = 'CHANGED';
 assert.equal(proof.hostIdentity!.scope.workspaceId, 'TEST-WORKSPACE'); assert.equal(proof.proposalTarget!.leadId, target.leadId);
 assert.equal(proof.sessionToken, 'existing_synthetic_session_1234');
});
test('SQL corroborates host actor, tenant, workspace, event and proof without provisioning any row', async () => {
 const f = await durableProposalFixture();
 try {
  const resolve = createExistingProposalSessionResolver({ target: f.target, owner: { readExistingSession: () => owned(f) } });
  const good = await resolve({}); assert.equal((await f.service.access(good)).target.eventId, f.target.eventId);
  const original = (await f.service.access(good)).access.identityKey;
  const shortened = { ...good, hostIdentity: { ...good.hostIdentity!, expiresAtMs: f.at + 30000 } };
  assert.notEqual((await f.service.access(shortened)).access.identityKey, original);
  await assert.rejects(f.service.read(shortened, original), error('ACCESS_CHANGED'));
  const rowsBefore = (await f.pool.query(`SELECT count(*)::int AS n FROM ${f.accessSchema}.sessions`)).rows[0].n;
  for (const hostIdentity of [
   { ...good.hostIdentity!, actorId: 'OTHER-ACTOR' }, { ...good.hostIdentity!, scope: { ...f.scope, organizationId: 'OTHER-ORG' } },
   { ...good.hostIdentity!, scope: { ...f.scope, workspaceId: 'OTHER-WORKSPACE' } }, { ...good.hostIdentity!, eventId: 'OTHER-EVENT' },
  ]) await assert.rejects(f.service.access({ ...good, hostIdentity }), error('ACCESS_DENIED'));
  await assert.rejects(f.service.access({ ...good, sessionToken: 'unregistered_synthetic_session_1234' }), error('AUTHENTICATION_REQUIRED'));
  assert.equal((await f.pool.query(`SELECT count(*)::int AS n FROM ${f.accessSchema}.sessions`)).rows[0].n, rowsBefore);
  assert.equal((await f.service.history(f.proof))!.record, null);
 } finally { await f.close(); }
});
test('a host-bound case cannot be repurposed for another lead or proposal on the same event', async () => {
 const f = await durableProposalFixture();
 try {
  const proof = await createExistingProposalSessionResolver({ target: f.target, owner: { readExistingSession: () => owned(f) } })({});
  for (const changed of [{ ...f.target, leadId: 'OTHER-LEAD' }, { ...f.target, proposalId: 'OTHER-PROPOSAL' }]) {
   const other = createDurableTestProposalService({ ...f, target: changed });
   await assert.rejects(other.access(proof), error('ACCESS_DENIED'));
  }
  assert.equal((await f.service.history(f.proof))!.revision, 1);
 } finally { await f.close(); }
});
test('host expiry shortens SQL authority and rolls back a completed write at the exact host boundary', async () => {
 const f = await durableProposalFixture();
 try {
  const until = f.at + 1000;
  const proof = await createExistingProposalSessionResolver({ target: f.target, clock: () => f.at, owner: { readExistingSession: () => owned(f, until) } })({});
  let now = f.at;
  const repo = new PostgresQuoteAccessRepository(f.pool, { schema: f.accessSchema, clock: () => now });
  const target = { kind: 'write' as const, eventId: f.target.eventId };
  await f.pool.query(`CREATE TABLE ${f.accessSchema}.host_probe(value text)`);
  await assert.rejects(repo.run(proof, target, async (identity, client) => {
   assert.equal(identity.expiresAtMs, until); await client.query(`INSERT INTO ${f.accessSchema}.host_probe VALUES ('must-rollback')`); now = until;
  }), error('ACCESS_DENIED'));
  assert.equal((await f.pool.query(`SELECT * FROM ${f.accessSchema}.host_probe`)).rowCount, 0);
  await assert.rejects(repo.run(proof, { kind: 'status' }, async () => null), error('ACCESS_DENIED'));
 } finally { await f.close(); }
});
test('existing HTTP seam consumes the owner each request, fails closed on withdrawal and never exposes session proof', async () => {
 const f = await durableProposalFixture(); let active = true;
 const resolve = createExistingProposalSessionResolver({ target: f.target, owner: { readExistingSession: () => active ? owned(f) : null } });
 const app = createTestProposalApi({ service: f.service, allowedOrigin: 'http://127.0.0.1:4194', resolveExistingSession: resolve });
 try {
  const headers = { host: '127.0.0.1:4194' };
  const access = await app.inject({ url: `${API}/access`, headers }); assert.equal(access.statusCode, 200);
  assert.equal(access.json().target.proposalId, f.target.proposalId); assert.ok(!access.body.includes(f.proof.sessionToken)); assert.ok(!access.body.includes('hostIdentity'));
  active = false; assert.equal((await app.inject({ url: `${API}/access`, headers })).statusCode, 401);
  const unconfigured = createTestProposalApi({ service: f.service, allowedOrigin: 'http://127.0.0.1:4194', resolveExistingSession: createExistingProposalSessionResolver({ target: f.target }) });
  try { assert.equal((await unconfigured.inject({ url: `${API}/access`, headers })).statusCode, 503); } finally { await unconfigured.close(); }
 } finally { await app.close(); await f.close(); }
});
test('owner metadata cannot restore revoked or read-only SQL grants', async () => {
 const f = await durableProposalFixture(); let reads = 0;
 try {
  const proof = await createExistingProposalSessionResolver({ target: f.target, owner: { readExistingSession: () => owned(f) } })({});
  await f.pool.query(`UPDATE ${f.accessSchema}.event_grants SET can_write=false,can_approve=false`);
  await assert.rejects(f.service.publishFromProvider(proof, { async read() { reads++; return f.document; } }), error('ACCESS_DENIED'));
  assert.equal(reads, 0);
  await f.pool.query(`UPDATE ${f.accessSchema}.sessions SET revoked_at=now()`);
  await assert.rejects(f.service.access(proof), error('AUTHENTICATION_REQUIRED'));
 } finally { await f.close(); }
});
