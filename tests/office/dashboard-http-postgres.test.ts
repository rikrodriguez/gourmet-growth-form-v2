import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { PostgresOfficeStore } from '../../src/office/backend/postgres-store';
import { MondayVault, PostgresMondayStore } from '../../src/office/backend/monday-store';
import { createCommunicationsStore } from '../../src/office/backend/communications-store';
import { createFixtureCommunicationsDependencies } from '../../src/office/backend/communications-fixture';
import { createOfficeApi } from '../../src/office/backend/http';
import { createDashboardReviewSource } from '../../src/office/dashboard/source';
import { validateCommunicationsReview } from '../../src/office/communications-client';
import type { CommunicationsReviewView } from '../../src/office/communications-api-contracts';
const AT = Date.parse('2026-10-13T00:00:00.000Z');

test('dashboard projection reads the guarded HTTP and encrypted PostgreSQL workflow without changing it', async () => {
  const store = new PostgresOfficeStore({ stateId: `test-dashboard-${randomUUID()}` });
  await store.initialize(AT);
  const physical = new PostgresMondayStore(store.pool); const vault = new MondayVault(randomBytes(32));
  const app = createOfficeApi(store, { communicationsFixture: createFixtureCommunicationsDependencies({ storage: 'postgres', clock: () => AT, storeFor: scope => createCommunicationsStore({ scope, store: physical, vault }) }) });
  const base = { host: '127.0.0.1:4175', origin: 'http://127.0.0.1:4175' };
  try {
    const start = await app.inject({ method: 'POST', url: '/office-api/communications/session', headers: base, payload: {} }); assert.equal(start.statusCode, 200);
    const cookie = String(start.headers['set-cookie']).split(';')[0]; let view = start.json<CommunicationsReviewView>();
    const headers = { ...base, cookie, 'x-communications-csrf': view.session.csrfToken };
    const linked = await app.inject({ method: 'POST', url: '/office-api/communications/associations', headers, payload: { expectedRevision: view.workflow.revision, id: 'dashboard-pg-association', ...view.workflow.candidates[0], explicit: true, ambiguityAcknowledged: true, evidenceRef: 'fixture:synthetic-dashboard-integration' } }); assert.equal(linked.statusCode, 200); view = linked.json();
    const saved = await app.inject({ method: 'POST', url: '/office-api/communications/drafts', headers, payload: { expectedRevision: view.workflow.revision, id: 'dashboard-pg-draft', associationId: 'dashboard-pg-association', purpose: 'reply', to: ['aurora@example.test'], cc: [], bcc: [], subject: 'Prueba de lectura del dashboard', bodyText: 'Contenido sintético exacto', bodyHtml: null, attachments: [] } }); assert.equal(saved.statusCode, 200); view = saved.json();
    const before = JSON.stringify(view.workflow); let reads = 0;
    const source = createDashboardReviewSource({ async read(signal) { signal.throwIfAborted(); reads++; const response = await app.inject({ method: 'GET', url: '/office-api/communications', headers: { ...base, cookie } }); assert.equal(response.statusCode, 200); assert.match(String(response.headers['cache-control']), /no-store/); return validateCommunicationsReview(response.json()); } }, () => AT);
    const first = await source.read(new AbortController().signal); const second = await source.read(new AbortController().signal);
    assert.equal(reads, 2); assert.deepEqual(first, second); assert.equal(first.items.length, 1); assert.equal(first.items[0].mailbox, 'felipe@example.test'); assert.equal(first.items[0].state, 'needs_review'); assert.equal(first.workflowRevision, view.workflow.revision); assert.equal(first.outboundEffects, 0);
    const after = await app.inject({ method: 'GET', url: '/office-api/communications', headers: { ...base, cookie } }); assert.equal(JSON.stringify(after.json<CommunicationsReviewView>().workflow), before);
    for (const hostileHeaders of [{ ...base, origin: 'https://unrelated.invalid', cookie }, { ...base }]) { const denied = await app.inject({ method: 'GET', url: '/office-api/communications', headers: hostileHeaders }); assert.ok([401, 403].includes(denied.statusCode)); }
    const plain = createOfficeApi(store); try { const absent = await plain.inject({ method: 'GET', url: '/office-api/communications', headers: base }); assert.equal(absent.statusCode, 404); } finally { await plain.close(); }
  } finally { await app.close(); await store.close(); }
});
