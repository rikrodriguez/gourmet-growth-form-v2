import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { durableProposalFixture } from './external-proposal-durable-fixtures';
import { createDurableTestProposalService } from '../../src/office/backend/external-proposal-durable';
import { createTestProposalApi } from '../../src/office/backend/external-proposal-http';
import { TEST_PROPOSAL_API as API, TEST_PROPOSAL_CSRF as CSRF, TEST_PROPOSAL_IDENTITY as ID, externalProposalIdentityKey } from '../../src/office/external-proposal-contracts';
import { verifyExternalProposalResponse } from '../../src/office/external-proposal-response';
import { validateLeadLinkAccess, bindLeadLinkClient, LeadLinkReadGate } from '../../src/office/dashboard/lead-link-access';
import { createExistingProposalSessionResolver } from '../../src/office/backend/proposal-host-session';
import { createTestProposalDashboardIntegration } from '../../src/office/dashboard/test-proposal-integration';
const origin = 'http://127.0.0.1:4194', host = '127.0.0.1:4194';
const setup = async () => {
 const f = await durableProposalFixture(), app = createTestProposalApi({ service: f.service, allowedOrigin: origin, resolveExistingSession: () => f.proof });
 const projected = await app.inject({ url: `${API}/access`, headers: { host } }); assert.equal(projected.statusCode, 200);
 const access = projected.json(); const headers = { host, origin, [ID]: access.access.identityKey, [CSRF]: access.csrfToken };
 return { f, app, access, headers };
};
test('the Dashboard consumes a persisted host session with a 512-character CSRF proof and keeps the SQL approver', async () => {
 const f = await durableProposalFixture(), proof = { ...f.proof, csrfToken: 'existing_synthetic_csrf_'.padEnd(512, 'x') };
 const resolveExistingSession = createExistingProposalSessionResolver({ target: f.target, owner: {
  readExistingSession: () => ({ proof, scope: f.scope, actorId: f.actorId, target: f.target, expiresAtMs: f.at + 60000 }),
 } });
 const app = createTestProposalApi({ service: f.service, allowedOrigin: origin, resolveExistingSession });
 const statuses: number[] = [];
 try {
  await f.pool.query(`UPDATE ${f.accessSchema}.sessions SET csrf_hash=$1`, [createHash('sha256').update(proof.csrfToken).digest('hex')]);
  const integration = createTestProposalDashboardIntegration({
   subscribe: () => () => {},
   quoteClient: { async status() { throw new Error('No automatic read'); }, async read() { throw new Error('No automatic read'); }, async execute() { throw new Error('No quote write'); } },
   fetch: async (url, init) => {
    const result = await app.inject({ url: String(url), headers: { host, ...Object.fromEntries(new Headers(init?.headers)) } });
    statuses.push(result.statusCode);
    return new Response(result.body, { status: result.statusCode, headers: { 'Content-Type': 'application/json' } });
   },
  });
  const signal = new AbortController().signal, access = await integration.source.read(signal);
  assert.equal(access.state, 'ready'); if (access.state !== 'ready') throw new Error('Ready context required');
  const history = await integration.historyClient.read(f.target.leadId, signal);
  assert.equal(history.identityKey, access.identityKey); assert.equal(history.leadId, f.target.leadId);
  const headers = { host, origin, [ID]: access.identityKey, [CSRF]: proof.csrfToken };
  const associated = await app.inject({ method: 'POST', url: `${API}/commands`, headers, payload: { action: 'associate', key: 'existing-session-associate', expectedRevision: 0 } });
  assert.equal(associated.statusCode, 200); const view = associated.json();
  const approved = await app.inject({ method: 'POST', url: `${API}/commands`, headers, payload: { action: 'approve', key: 'existing-session-approve', expectedRevision: view.revision, reviewKey: view.snapshot.reviewKey } });
  assert.equal(approved.statusCode, 200); assert.equal(approved.json().approval.actorId, f.actorId);
  assert.equal(approved.json().status, 'approved_internal_unsent'); assert.equal(approved.json().externalEffectsEnabled, false);
  await f.pool.query(`UPDATE ${f.accessSchema}.sessions SET revoked_at=now()`);
  await assert.rejects(integration.source.read(signal));
  assert.equal(integration.renderForLead({ leadId: f.target.leadId, identityKey: access.identityKey }), null);
  assert.deepEqual(statuses, [200, 200, 401]);
 } finally { await app.close(); await f.close(); }
});
test('safe prefix accepts every base64url leading character without relaxing proposal or history parsers', async () => {
 const scope = { organizationId: 'O', workspaceId: 'W', mode: 'test' as const }, target = { leadId: 'L', eventId: 'E', proposalId: 'P' };
 for (const first of 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_') {
  const raw = first + 'A'.repeat(42), identityKey = externalProposalIdentityKey(raw), expiresAtMs = Date.now() + 60000;
  const view = { ...target, scope, identityKey, expiresAtMs, revision: 0, canWrite: true, canApprove: true, snapshot: null, status: 'missing', approval: null, externalEffectsEnabled: false };
  assert.equal((await verifyExternalProposalResponse(view, { target, scope, identityKey })).view.identityKey, identityKey);
  const grant = validateLeadLinkAccess({ state: 'ready', identityKey, scope, expiresAtMs, durableIdentity: true, canRead: true, canOpen: false, leadIds: ['L'] }); assert.equal(grant.state, 'ready');
  if (first === '-' || first === '_') {
   await assert.rejects(verifyExternalProposalResponse({ ...view, identityKey: raw }, { target, scope, identityKey: raw }));
   assert.throws(() => validateLeadLinkAccess({ ...grant, identityKey: raw }));
  }
 }
 for (const raw of ['', 'A'.repeat(42), 'A'.repeat(44), 'bad\n' + 'A'.repeat(39)]) assert.throws(() => externalProposalIdentityKey(raw));
});
test('access, saved history and proposal use one identity; valid HTTP writes and retries preserve exact review', async () => {
 const { f, app, access, headers } = await setup();
 try {
  assert.equal(access.access.durableIdentity, true); assert.ok(access.access.identityKey.startsWith('proposal-'));
  const history = await app.inject({ url: `${API}/history`, headers }); assert.equal(history.statusCode, 200); assert.equal(history.json().identityKey, access.access.identityKey);
  const gate = new LeadLinkReadGate(), bound = bindLeadLinkClient({ async read() { return history.json(); } }, access.access, gate.start());
  assert.equal((await bound.read(f.target.leadId, new AbortController().signal)).leadId, f.target.leadId);
  const associated = await app.inject({ method: 'POST', url: `${API}/commands`, headers, payload: { action: 'associate', key: 'http-associate', expectedRevision: 0 } }); assert.equal(associated.statusCode, 200);
  const view = associated.json(); assert.equal((await verifyExternalProposalResponse(view, { target: f.target, scope: view.scope, identityKey: access.access.identityKey })).contentVerified, true);
  const command = { action: 'approve', key: 'http-approve', expectedRevision: 1, reviewKey: view.snapshot.reviewKey };
  const approved = await app.inject({ method: 'POST', url: `${API}/commands`, headers, payload: command }); assert.equal(approved.statusCode, 200); assert.equal(approved.json().status, 'approved_internal_unsent');
  assert.equal((await app.inject({ method: 'POST', url: `${API}/commands`, headers, payload: command })).json().revision, 2);
  const saved = await f.service.history(f.proof); assert.equal(saved!.record!.receipts.length, 2); assert.equal(saved!.record!.approvals.length, 1);
 } finally { await app.close(); await f.close(); }
});
test('same-origin, existing CSRF, identity revision and exact command are required before any write', async () => {
 const { f, app, headers } = await setup();
 try {
  const payload = { action: 'associate', key: 'denied', expectedRevision: 0 };
  for (const altered of [{ origin: 'http://other.test' }, { host: 'other.test' }, { [CSRF]: 'wrong' }, { [ID]: 'synthetic-test-identity' }, { [ID]: externalProposalIdentityKey('A'.repeat(43)) }]) {
   const r = await app.inject({ method: 'POST', url: `${API}/commands`, headers: { ...headers, ...altered }, payload }); assert.equal(r.statusCode, 403);
  }
  for (const key of [CSRF, ID]) {
   const omitted: Record<string,string> = { ...headers }; delete omitted[key];
   assert.equal((await app.inject({ method: 'POST', url: `${API}/commands`, headers: omitted, payload })).statusCode, 403);
  }
  assert.equal((await app.inject({ method: 'POST', url: `${API}/commands`, headers, payload: { ...payload, scope: f.scope } })).statusCode, 409);
  assert.equal((await app.inject({ url: `${API}/proposal?target=other`, headers })).statusCode, 400);
  assert.equal((await f.service.history(f.proof))!.record, null);
 } finally { await app.close(); await f.close(); }
});
test('a new durable instance rejects the old identity and recovers the same approved document', async () => {
 const { f, app, headers } = await setup(); let next: ReturnType<typeof createTestProposalApi> | undefined;
 try {
  const a = (await app.inject({ method: 'POST', url: `${API}/commands`, headers, payload: { action: 'associate', key: 'a', expectedRevision: 0 } })).json();
  const command = { action: 'approve', key: 'approve', expectedRevision: 1, reviewKey: a.snapshot.reviewKey };
  const before = (await app.inject({ method: 'POST', url: `${API}/commands`, headers, payload: command })).json(); await app.close();
  next = createTestProposalApi({ service: createDurableTestProposalService(f), allowedOrigin: origin, resolveExistingSession: () => f.proof });
  assert.equal((await next.inject({ url: `${API}/proposal`, headers })).statusCode, 403);
  assert.equal((await next.inject({ method: 'POST', url: `${API}/commands`, headers, payload: { ...command, key: 'stale', expectedRevision: 2 } })).statusCode, 403);
  const access = (await next.inject({ url: `${API}/access`, headers: { host } })).json(); assert.notEqual(access.access.identityKey, headers[ID]);
  const recovered = (await next.inject({ url: `${API}/proposal`, headers: { host, [ID]: access.access.identityKey } })).json(); assert.deepEqual(recovered.snapshot, before.snapshot); assert.deepEqual(recovered.approval, before.approval);
 } finally { await next?.close(); await app.close(); await f.close(); }
});
test('document and permission changes reject an earlier HTTP review without adding approval receipts', async () => {
 const { f, app, headers } = await setup();
 try {
  const view = (await app.inject({ method: 'POST', url: `${API}/commands`, headers, payload: { action: 'associate', key: 'a', expectedRevision: 0 } })).json();
  const command = { action: 'approve', key: 'old-review', expectedRevision: 1, reviewKey: view.snapshot.reviewKey };
  await f.service.publish(f.proof, { ...f.document, sourceVersion: 'v2', content: f.document.content + '\nV2' });
  assert.equal((await app.inject({ method: 'POST', url: `${API}/commands`, headers, payload: command })).statusCode, 409);
  await f.pool.query(`UPDATE ${f.accessSchema}.event_grants SET can_approve=false`);
  assert.equal((await app.inject({ url: `${API}/proposal`, headers })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: `${API}/commands`, headers, payload: command })).statusCode, 403);
  assert.equal((await f.service.history(f.proof))!.record!.receipts.length, 1);
 } finally { await app.close(); await f.close(); }
});
test('fixture Pool stop preserves schemas and normal runtimes do not register the test adapter', async () => {
 const f = await durableProposalFixture();
 try {
  await f.stop();
  const { Pool } = await import('pg'), { DEFAULT_OFFICE_DATABASE_URL } = await import('../../src/office/backend/postgres-store');
  const pool = new Pool({ connectionString: DEFAULT_OFFICE_DATABASE_URL, connectionTimeoutMillis: 1000 });
  try { assert.equal((await pool.query('SELECT to_regnamespace($1) IS NOT NULL AS present', [f.proposalSchema])).rows[0].present, true); } finally { await pool.end(); }
  for (const path of ['server.mjs', 'src/office/backend/server.ts', 'src/office/backend/staging-server.ts', 'src/office/backend/staging-app.ts']) assert.doesNotMatch(await readFile(path, 'utf8'), /external-proposal-http|createTestProposalApi/);
  assert.throws(() => createTestProposalApi({ service: f.service, allowedOrigin: 'https://commercial.test', resolveExistingSession: () => f.proof }));
 } finally { await f.close(); }
});
