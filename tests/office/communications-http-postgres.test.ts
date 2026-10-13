import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createOfficeApi } from '../../src/office/backend/http';
import { createFixtureCommunicationsDependencies } from '../../src/office/backend/communications-fixture';
import { createCommunicationsStore, communicationsStorageKey } from '../../src/office/backend/communications-store';
import { createCommunicationsWorkflow } from '../../src/office/backend/communications';
import { MondayVault, PostgresMondayStore, type MondayStore } from '../../src/office/backend/monday-store';
import { PostgresOfficeStore } from '../../src/office/backend/postgres-store';
import { COMMUNICATIONS_API as API, COMMUNICATIONS_CSRF_HEADER as CSRF, type CommunicationsReviewView } from '../../src/office/communications-api-contracts';
import type { CommunicationsScope } from '../../src/office/backend/communications-contracts';

const AT = 1791810000000;
const base = { host: '127.0.0.1:4175', origin: 'http://127.0.0.1:4175' };
async function setup() {
  const office = new PostgresOfficeStore({ stateId: `test-communications-http-${randomUUID()}` }); await office.initialize(AT);
  const physical = new PostgresMondayStore(office.pool); const vault = new MondayVault(Buffer.alloc(32, 67));
  const scopes: CommunicationsScope[] = []; let fail = false;
  const faultable: MondayStore = { read: key => physical.read(key), compareAndSet: (key, revision, value) => { if (fail) throw new Error('private-storage-error'); return physical.compareAndSet(key, revision, value); } };
  const dependencies = createFixtureCommunicationsDependencies({ storage: 'postgres', clock: () => AT, storeFor(scope) { scopes.push(scope); return createCommunicationsStore({ scope, store: faultable, vault }); } });
  const app = createOfficeApi(office, { communicationsFixture: dependencies });
  return { office, physical, vault, scopes, app, dependencies, fail(value: boolean) { fail = value; } };
}
async function prepare(app: ReturnType<typeof createOfficeApi>) {
  const initial = await app.inject({ method: 'POST', url: `${API}/session`, headers: base, payload: {} }); assert.equal(initial.statusCode, 200, initial.body);
  let view = initial.json<CommunicationsReviewView>(); const headers = { ...base, cookie: String(initial.headers['set-cookie']).split(';')[0], [CSRF]: view.session.csrfToken };
  let r = await app.inject({ method: 'POST', url: `${API}/associations`, headers, payload: { expectedRevision: view.workflow.revision, id: 'association-1', ...view.workflow.candidates[0], explicit: true, ambiguityAcknowledged: true, evidenceRef: 'fixture:approved-source-selection' } }); assert.equal(r.statusCode, 200, r.body); view = r.json();
  r = await app.inject({ method: 'POST', url: `${API}/drafts`, headers, payload: { expectedRevision: view.workflow.revision, id: 'draft-1', associationId: 'association-1', purpose: 'reply', to: ['aurora@example.test'], cc: [], bcc: [], subject: 'Prueba HTTP con PostgreSQL', bodyText: 'Contenido exacto sintético', bodyHtml: '<p>Contenido exacto sintético</p>', attachments: [] } }); assert.equal(r.statusCode, 200, r.body); view = r.json();
  const d = view.workflow.drafts.at(-1)!;
  return { view, headers, command: { expectedRevision: view.workflow.revision, id: 'approval-1', draftId: d.id, draftRevision: d.revision, draftDigest: d.digest } };
}

test('real PostgreSQL: HTTP approval uses encrypted workflow ledger, reload persists and server restart expires access', async () => {
  const t = await setup(); let restarted: ReturnType<typeof createOfficeApi> | undefined;
  try {
    const s = await prepare(t.app);
    const approved = await t.app.inject({ method: 'POST', url: `${API}/approvals`, headers: s.headers, payload: s.command }); assert.equal(approved.statusCode, 200, approved.body);
    const v = approved.json<CommunicationsReviewView>(); assert.equal(v.session.storage, 'postgres'); assert.equal(v.workflow.outbox.length, 1); assert.equal(v.workflow.outbox[0].dispatchEnabled, false);
    assert.deepEqual((await t.app.inject({ method: 'GET', url: API, headers: s.headers })).json(), v);
    const stored = await t.physical.read(communicationsStorageKey(t.scopes[0])); assert(stored); assert(!JSON.stringify(stored).includes('Contenido exacto sintético'));
    const workflow = createCommunicationsWorkflow({ scope: t.scopes[0], store: createCommunicationsStore({ scope: t.scopes[0], store: t.physical, vault: t.vault }), clock: () => AT }); assert.deepEqual(await workflow.view(), v.workflow);
    await t.app.close(); restarted = createOfficeApi(t.office, { communicationsFixture: t.dependencies });
    assert.equal((await restarted.inject({ method: 'GET', url: API, headers: s.headers })).statusCode, 401);
    const fresh = await restarted.inject({ method: 'POST', url: `${API}/session`, headers: base, payload: {} }); assert.equal(fresh.statusCode, 200); assert.notEqual(fresh.json().session.actorId, v.session.actorId); assert.equal(fresh.json().workflow.drafts.length, 0);
    assert.equal((await workflow.view()).approvals.length, 1);
  } finally { if (restarted) await restarted.close(); else await t.app.close(); await t.office.close(); }
});

test('real PostgreSQL: HTTP write failure stays unapproved, redacted, and requires explicit retry', async () => {
  const t = await setup();
  try {
    const s = await prepare(t.app); t.fail(true);
    const failed = await t.app.inject({ method: 'POST', url: `${API}/approvals`, headers: s.headers, payload: s.command }); assert.equal(failed.statusCode, 503); assert.deepEqual(failed.json(), { error: 'COMMUNICATIONS_UNAVAILABLE' });
    const before = (await t.app.inject({ method: 'GET', url: API, headers: s.headers })).json<CommunicationsReviewView>(); assert.equal(before.workflow.revision, s.view.workflow.revision); assert.equal(before.workflow.approvals.length, 0); assert.equal(before.workflow.outbox.length, 0);
    t.fail(false); const retry = await t.app.inject({ method: 'POST', url: `${API}/approvals`, headers: s.headers, payload: s.command }); assert.equal(retry.statusCode, 200); assert.equal(retry.json().workflow.approvals.length, 1);
  } finally { await t.app.close(); await t.office.close(); }
});
