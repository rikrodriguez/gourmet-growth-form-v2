import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { createOfficeApi } from '../../src/office/backend/http';
import { registerFixtureCommunicationsRoutes, type FixtureCommunicationsDependencies } from '../../src/office/backend/communications-http';
import { createFixtureCommunicationsDependencies } from '../../src/office/backend/communications-fixture';
import { COMMUNICATIONS_API as API, COMMUNICATIONS_CSRF_HEADER as CSRF, type CommunicationsReviewView } from '../../src/office/communications-api-contracts';
import type { CommunicationsScope, CommunicationsStoredRecord, CommunicationsStore } from '../../src/office/backend/communications-contracts';
import type { OfficeStore } from '../../src/office/backend/state';

const AT = 1791810000000;
const base = { host: '127.0.0.1:4175', origin: 'http://127.0.0.1:4175' };
function memory(): CommunicationsStore {
  let record: CommunicationsStoredRecord | null = null;
  return { async read() { return structuredClone(record); }, async compareAndSet(expected, ledger) { if ((record?.revision ?? null) !== expected) return false; record = { revision: (record?.revision ?? 0) + 1, ledger: structuredClone(ledger) }; return true; } };
}
function setup() {
  let at = AT;
  const stores = new Map<string, CommunicationsStore>(); const scopes: CommunicationsScope[] = [];
  const dependencies = createFixtureCommunicationsDependencies({ storage: 'ephemeral', clock: () => at, storeFor(scope) { scopes.push(scope); const store = memory(); stores.set(scope.actorId, store); return store; } });
  const app = Fastify({ logger: false, bodyLimit: 16384, trustProxy: false });
  registerFixtureCommunicationsRoutes(app, dependencies);
  return { app, stores, scopes, expire() { at += 16 * 60_000; } };
}
async function start(app: ReturnType<typeof Fastify>) {
  const response = await app.inject({ method: 'POST', url: `${API}/session`, headers: base, payload: {} });
  assert.equal(response.statusCode, 200, response.body);
  const view = response.json<CommunicationsReviewView>();
  assert.match(String(response.headers['set-cookie']), /; Path=\/office-api\/communications; HttpOnly; SameSite=Strict; Max-Age=900$/);
  const cookie = String(response.headers['set-cookie']).split(';')[0];
  return { view, cookie, headers: { ...base, cookie, [CSRF]: view.session.csrfToken } };
}
async function link(app: ReturnType<typeof Fastify>, session: Awaited<ReturnType<typeof start>>, index = 0) {
  const v = session.view.workflow;
  const r = await app.inject({ method: 'POST', url: `${API}/associations`, headers: session.headers, payload: { expectedRevision: v.revision, id: 'association-1', ...v.candidates[index], explicit: true, ambiguityAcknowledged: true, evidenceRef: 'fixture:human-reviewed-context' } });
  assert.equal(r.statusCode, 200, r.body); session.view = r.json(); return session;
}
async function draft(app: ReturnType<typeof Fastify>, s: Awaited<ReturnType<typeof start>>, extra = {}) {
  const association = s.view.workflow.associations.at(-1)!;
  const lead = s.view.workflow.snapshots.find(v => v.id === association.leadSnapshotId)!;
  assert.equal(lead.kind, 'lead');
  const payload = { expectedRevision: s.view.workflow.revision, id: 'draft-1', associationId: association.id, purpose: 'reply', to: [(lead as any).data.email], cc: [], bcc: [], subject: 'Propuesta sintética exacta', bodyText: 'Texto privado ficticio', bodyHtml: '<p>Contenido <b>ficticio</b></p>', attachments: [], ...extra };
  const r = await app.inject({ method: 'POST', url: `${API}/drafts`, headers: s.headers, payload });
  if (r.statusCode === 200) s.view = r.json(); return r;
}
function approval(s: Awaited<ReturnType<typeof start>>, id = 'approval-1') { const d = s.view.workflow.drafts.at(-1)!; return { expectedRevision: s.view.workflow.revision, id, draftId: d.id, draftRevision: d.revision, draftDigest: d.digest }; }

test('communications HTTP is absent by default and rejects live/staging composition', async () => {
  const app = createOfficeApi({} as OfficeStore);
  try { for (const path of ['', '/session', '/associations', '/drafts', '/approvals', '/observations', '/send']) assert.equal((await app.inject({ method: 'GET', url: API + path, headers: base })).statusCode, 404); }
  finally { await app.close(); }
  const bare = Fastify(); assert.throws(() => registerFixtureCommunicationsRoutes(bare, { mode: 'live', storage: 'ephemeral', open: async () => null } as unknown as FixtureCommunicationsDependencies)); await bare.close();
  assert.throws(() => createOfficeApi({} as OfficeStore, { staging: {} as any, communicationsFixture: {} as any }));
});

test('communications HTTP creates separate server-chosen fixture identity and HttpOnly CSRF-bound session', async () => {
  const t = setup(); try {
    const a = await start(t.app), b = await start(t.app);
    assert.notEqual(a.cookie, b.cookie); assert.notEqual(a.view.session.csrfToken, b.view.session.csrfToken); assert.notEqual(a.view.session.actorId, b.view.session.actorId);
    assert.equal(a.view.mode, 'fixture'); assert.equal(a.view.session.storage, 'ephemeral'); assert.equal(a.view.workflow.outboundEffects, 0); assert.equal(t.scopes[0].partition, 'external'); assert.equal(t.scopes[0].dataMode, 'fixture');
    assert.equal(a.view.workflow.candidates.length, 3); assert(a.view.workflow.snapshots.some(s => s.kind === 'account' && s.data.mailbox === 'info'));
    const r = await t.app.inject({ method: 'POST', url: `${API}/session`, headers: a.headers, payload: {} });
    assert.equal(r.statusCode, 200); assert.equal(r.headers['set-cookie'], undefined); assert.equal(t.scopes.length, 2);
    const bad = await t.app.inject({ method: 'POST', url: `${API}/session`, headers: base, payload: { actorId: 'owner', dataMode: 'live', role: 'admin' } }); assert.equal(bad.statusCode, 400);
  } finally { await t.app.close(); }
});

test('communications HTTP independently refuses foreign origin, non-loopback, forwarded peer, non-JSON and query injection', async () => {
  const t = setup(); try {
    for (const headers of [{ host: base.host }, { ...base, origin: 'https://evil.test' }, { ...base, origin: 'http://localhost:4175' }, { ...base, host: 'evil.test' }, { ...base, 'x-forwarded-for': '127.0.0.1' }, { ...base, forwarded: 'for=127.0.0.1' }, { ...base, 'sec-fetch-site': 'cross-site' }]) assert.equal((await t.app.inject({ method: 'POST', url: `${API}/session`, headers, payload: {} })).statusCode, 403);
    assert.equal((await t.app.inject({ method: 'POST', url: `${API}/session`, headers: base, remoteAddress: '10.0.0.1', payload: {} })).statusCode, 403);
    assert.equal((await t.app.inject({ method: 'POST', url: `${API}/session`, headers: { ...base, 'content-type': 'text/plain' }, payload: '{}' })).statusCode, 415);
    assert.equal((await t.app.inject({ method: 'POST', url: `${API}/session?actorId=owner`, headers: base, payload: {} })).statusCode, 400);
    assert.equal(t.scopes.length, 0);
  } finally { await t.app.close(); }
});

test('communications HTTP requires independent session and matching CSRF for every write', async () => {
  const t = setup(); try {
    const a = await start(t.app), b = await start(t.app);
    for (const path of ['/associations', '/drafts', '/approvals']) {
      assert.equal((await t.app.inject({ method: 'POST', url: API + path, headers: base, payload: {} })).statusCode, 401);
      for (const headers of [{ ...base, cookie: a.cookie }, { ...a.headers, [CSRF]: b.view.session.csrfToken }]) assert.equal((await t.app.inject({ method: 'POST', url: API + path, headers, payload: {} })).statusCode, 403);
    }
    assert.equal((await t.app.inject({ method: 'DELETE', url: `${API}/session`, headers: { ...base, cookie: a.cookie } })).statusCode, 403);
    assert.equal((await t.app.inject({ method: 'GET', url: API, headers: { ...base, cookie: `${a.cookie}; ${a.cookie}` } })).statusCode, 401);
    assert.equal((await t.app.inject({ method: 'GET', url: API, headers: { ...base, cookie: 'gourmet_office_demo=pretend' } })).statusCode, 401);
  } finally { await t.app.close(); }
});

test('communications HTTP executes real association → exact draft → approval → idempotent unsent outbox', async () => {
  const t = setup(); try {
    const s = await link(t.app, await start(t.app)); assert.equal((await draft(t.app, s)).statusCode, 200);
    const saved = s.view.workflow.drafts.at(-1)!;
    const r = await t.app.inject({ method: 'POST', url: `${API}/approvals`, headers: s.headers, payload: approval(s) }); assert.equal(r.statusCode, 200, r.body); s.view = r.json();
    assert.equal(s.view.workflow.approvals[0].approval.approvedBy, s.view.session.actorId); assert.equal(s.view.workflow.approvals[0].approval.draftDigest, saved.digest); assert.equal(s.view.workflow.outbox[0].status, 'approved_unsent'); assert.equal(s.view.workflow.outbox[0].dispatchEnabled, false);
    const duplicate = await t.app.inject({ method: 'POST', url: `${API}/approvals`, headers: s.headers, payload: approval(s, 'another-id') }); assert.equal(duplicate.statusCode, 200); assert.equal(duplicate.json().workflow.outbox.length, 1);
    const reload = await t.app.inject({ method: 'GET', url: API, headers: s.headers }); assert.deepEqual(reload.json(), s.view); assert.equal(reload.headers['cache-control'], 'no-store'); assert.equal(reload.headers['access-control-allow-origin'], undefined);
  } finally { await t.app.close(); }
});

test('communications HTTP refuses browser authority/observation injection without changing state', async () => {
  const t = setup(); try {
    const s = await link(t.app, await start(t.app)); await draft(t.app, s); const before = s.view.workflow.revision;
    for (const field of ['approvedBy', 'approvedAtMs', 'scope', 'policyVersion', 'dispatchEnabled', 'status', 'observation', 'coverage', 'contextDigest']) {
      const r = await t.app.inject({ method: 'POST', url: `${API}/approvals`, headers: s.headers, payload: { ...approval(s), [field]: 'forged' } }); assert.equal(r.statusCode, 400, `${field}: ${r.body}`);
    }
    for (const path of ['/observations', '/import', '/send', '/oauth']) assert.equal((await t.app.inject({ method: 'POST', url: API + path, headers: s.headers, payload: {} })).statusCode, 404);
    assert.equal((await t.app.inject({ method: 'GET', url: API, headers: s.headers })).json().workflow.revision, before);
  } finally { await t.app.close(); }
});

test('communications HTTP isolates ledgers and cannot approve another session draft', async () => {
  const t = setup(); try {
    const a = await link(t.app, await start(t.app)), b = await start(t.app); await draft(t.app, a);
    const r = await t.app.inject({ method: 'POST', url: `${API}/approvals`, headers: b.headers, payload: { ...approval(a), expectedRevision: b.view.workflow.revision } }); assert.equal(r.statusCode, 409);
    assert.equal((await t.app.inject({ method: 'GET', url: API, headers: b.headers })).json().workflow.drafts.length, 0);
    assert.notDeepEqual(await t.stores.get(a.view.session.actorId)!.read(), await t.stores.get(b.view.session.actorId)!.read());
  } finally { await t.app.close(); }
});

test('communications HTTP rejects stale exact revisions and competing repeated clicks', async () => {
  const t = setup(); try {
    const s = await link(t.app, await start(t.app)); await draft(t.app, s); const command = approval(s);
    const results = await Promise.all([1, 2].map(() => t.app.inject({ method: 'POST', url: `${API}/approvals`, headers: s.headers, payload: command })));
    assert.deepEqual(results.map(r => r.statusCode).sort(), [200, 409]); s.view = results.find(r => r.statusCode === 200)!.json();
    await draft(t.app, s, { bodyText: 'Texto editado que exige otra revisión' });
    assert.equal(s.view.workflow.approvals[0].current, false); assert.equal(s.view.workflow.outbox[0].status, 'stale');
    const stale = await t.app.inject({ method: 'POST', url: `${API}/approvals`, headers: s.headers, payload: { ...command, expectedRevision: s.view.workflow.revision } }); assert.equal(stale.statusCode, 409);
  } finally { await t.app.close(); }
});

test('communications HTTP blocks followup without correspondence coverage and unknown attachment approval', async () => {
  const t = setup(); try {
    const s = await link(t.app, await start(t.app)); assert.equal((await draft(t.app, s, { purpose: 'follow_up' })).statusCode, 422);
    assert.equal((await draft(t.app, s, { attachments: [{ id: 'fixture-attachment', filename: 'fixture.pdf', mimeType: 'application/pdf', sha256: null }] })).statusCode, 200);
    const r = await t.app.inject({ method: 'POST', url: `${API}/approvals`, headers: s.headers, payload: approval(s) }); assert.equal(r.statusCode, 422); assert.equal(r.json().error, 'attachment_unverified');
    const b = await start(t.app); const index = b.view.workflow.candidates.findIndex(c => { const l = b.view.workflow.snapshots.find(v => v.id === c.leadSnapshotId); return l?.kind === 'lead' && l.data.email === 'cedar@example.test'; }); await link(t.app, b, index); assert.equal((await draft(t.app, b, { purpose: 'follow_up' })).statusCode, 200);
  } finally { await t.app.close(); }
});

test('communications HTTP logout and expiry invalidate cookie plus CSRF; reopening is a new scope', async () => {
  const t = setup(); try {
    const a = await start(t.app); const logout = await t.app.inject({ method: 'DELETE', url: `${API}/session`, headers: a.headers }); assert.equal(logout.statusCode, 204); assert.match(String(logout.headers['set-cookie']), /Max-Age=0/);
    assert.equal((await t.app.inject({ method: 'GET', url: API, headers: a.headers })).statusCode, 401);
    const b = await start(t.app); t.expire(); assert.equal((await t.app.inject({ method: 'POST', url: `${API}/associations`, headers: b.headers, payload: {} })).statusCode, 401);
    const c = await start(t.app); assert.notEqual(c.view.session.actorId, b.view.session.actorId);
  } finally { await t.app.close(); }
});

test('communications HTTP redacts storage failures and does not issue a session when initialization fails', async () => {
  const app = Fastify(); registerFixtureCommunicationsRoutes(app, { mode: 'fixture', storage: 'postgres', open: async () => { throw new Error('private-db-credentials-and-data'); } });
  try { const r = await app.inject({ method: 'POST', url: `${API}/session`, headers: base, payload: {} }); assert.equal(r.statusCode, 503); assert.deepEqual(r.json(), { error: 'COMMUNICATIONS_UNAVAILABLE' }); assert.equal(r.headers['set-cookie'], undefined); }
  finally { await app.close(); }
});

test('communications HTTP returns committed success for admitted writes crossing expiry, then rejects new writes', async () => {
  let at = AT; let delay = false; let entered!: () => void, resume!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; }); const gate = new Promise<void>(resolve => { resume = resolve; });
  const store = memory(); const delayed: CommunicationsStore = { read: async () => { if (delay) { entered(); await gate; } return store.read(); }, compareAndSet: (revision, ledger) => store.compareAndSet(revision, ledger) };
  const app = Fastify(); registerFixtureCommunicationsRoutes(app, createFixtureCommunicationsDependencies({ storage: 'ephemeral', clock: () => at, storeFor: () => delayed }));
  try {
    const s = await link(app, await start(app)); await draft(app, s); delay = true;
    const pending = app.inject({ method: 'POST', url: `${API}/approvals`, headers: s.headers, payload: approval(s) });
    await waiting; at += 16 * 60_000; resume(); const r = await pending;
    assert.equal(r.statusCode, 200, r.body); assert.equal(r.json().workflow.approvals.length, 1); assert.equal(r.json().workflow.outbox[0].status, 'approved_unsent');
    assert.equal((await app.inject({ method: 'GET', url: API, headers: s.headers })).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: `${API}/approvals`, headers: s.headers, payload: approval(s) })).statusCode, 401);
  } finally { await app.close(); }
});

test('communications HTTP permits bounded UTF-8 drafts above 16KiB without expanding other routes', async () => {
  const t = setup(); try {
    const s = await link(t.app, await start(t.app)); const bodyText = 'ñ'.repeat(12_000); assert(Buffer.byteLength(bodyText) > 16_384);
    const r = await draft(t.app, s, { bodyText, bodyHtml: '<p>' + '界'.repeat(10_000) + '</p>' }); assert.equal(r.statusCode, 200, r.body); assert.equal(s.view.workflow.drafts.at(-1)!.bodyText, bodyText);
    const oversized = await draft(t.app, s, { bodyText: '界'.repeat(65_000), bodyHtml: '界'.repeat(120_000) }); assert.equal(oversized.statusCode, 413);
    const unrelated = await t.app.inject({ method: 'POST', url: `${API}/associations`, headers: s.headers, payload: { content: 'ñ'.repeat(9000) } }); assert.equal(unrelated.statusCode, 413);
  } finally { await t.app.close(); }
});
