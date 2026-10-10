import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import { executeOfficeCommand } from '../../src/office/backend/commands';
import { createOfficeFixtureState } from '../../src/office/backend/fixtures';
import { createOfficeApi } from '../../src/office/backend/http';
import { CASE_IDS, FUNCTION_IDS, FUNCTION_AREAS, OfficeError, canonical, projectOfficeSnapshot } from '../../src/office/backend/state';
import type { OfficeState, OfficeStore } from '../../src/office/backend/state';
import type { OfficeCommand } from '../../src/office/contracts';
import { validateOfficeSnapshot } from '../../src/office/adapter';
import { FUNCTIONS } from '../../src/office/functions';
import { validateDevelopmentDatabaseUrl } from '../../src/office/backend/postgres-store';

const AT = Date.parse('2026-10-10T21:00:00.000Z');
// This double proves domain/HTTP boundaries only; durable tests use real pg.
class TransactionalTestStore implements OfficeStore {
  state = createOfficeFixtureState(AT);
  async snapshot() { return structuredClone(this.state); }
  async transact<T>(fn: (state: OfficeState) => T | Promise<T>) { const copy = structuredClone(this.state); const result = await fn(copy); this.state = copy; return result; }
}
function error(code: string) { return (value: unknown) => value instanceof OfficeError && value.code === code; }
function decision(store: TransactionalTestStore, action: OfficeCommand['action'], key: string, text?: string): OfficeCommand {
  const row = store.state.office.approvals['approval-demo-aurora-proposals-fixture'];
  return { idempotencyKey: key, caseId: row.caseId, functionId: row.functionId, action, approvalId: row.id, revision: row.revision, digest: row.digest, ...(text ? { text } : {}) };
}
async function apiFixture(t: TestContext, clock = () => AT) {
  const store = new TransactionalTestStore();
  const api = createOfficeApi(store, { clock });
  t.after(() => api.close());
  await api.ready();
  const headers = { host: '127.0.0.1:4180', origin: 'http://127.0.0.1:4175' };
  const login = async (body: object = {}) => {
    const response = await api.inject({ method: 'POST', url: '/office-api/session', headers, payload: body });
    assert.equal(response.statusCode, 200);
    return { response, cookie: String(response.headers['set-cookie']).split(';')[0] };
  };
  return { api, store, headers, login };
}

describe('office domain with transaction double', () => {
  it('keeps all nine function areas consistent with the UI contract and uses the domain for drafts', async () => {
    assert.deepEqual(FUNCTION_AREAS, Object.fromEntries(FUNCTIONS.map(row => [row.id, row.area])));
    const store = new TransactionalTestStore();
    for (const functionId of FUNCTION_IDS) {
      const response = await executeOfficeCommand(store, { idempotencyKey: `draft-${functionId}`, caseId: 'demo-aurora', functionId, action: 'draft', text: `Brief sintético ${functionId}` }, () => AT);
      assert.equal(response.replayed, false);
      const approval = response.snapshot.cases[0].approvals.find(row => row.body.includes(`Brief sintético ${functionId}`));
      assert(approval); assert.equal(approval.status, 'pending'); assert.equal(approval.digest.length, 64);
    }
    assert.equal(Object.keys(store.state.office.commands).length, 9);
    assert(Object.values(store.state.office.commands).every(row => !Object.hasOwn(row, 'snapshot')));
    const savedLogistics = Object.values(store.state.office.jobs).find(row => row.functionId === 'logistics')!;
    savedLogistics.area = 'kitchen';
    const stored = canonical(store.state);
    const projected = projectOfficeSnapshot(store.state, AT);
    assert.equal(projected.cases[0].tasks.find(row => row.id === savedLogistics.id)?.area, 'coordination');
    assert.equal(canonical(store.state), stored, 'display normalization preserves stored history and commands');
  });

  it('requires the human sale before preparing a chef/supplier action', async () => {
    const store = new TransactionalTestStore(); const before = canonical(store.state);
    await assert.rejects(executeOfficeCommand(store, { idempotencyKey: 'chef-too-early', caseId: 'demo-harbor', functionId: 'suppliers', action: 'draft' }, () => AT), error('SALE_NOT_CLOSED'));
    assert.equal(canonical(store.state), before);
    const chat = await executeOfficeCommand(store, { idempotencyKey: 'chef-explanation', caseId: 'demo-harbor', functionId: 'suppliers', action: 'chat', text: '¿Cuál es el bloqueo?' }, () => AT);
    assert(chat.snapshot.cases[2].messages.some(row => row.text.includes('bloqueada hasta cerrar la venta humana')));
  });

  it('approves the exact review without inferring payment, supplier acceptance or outbound execution', async () => {
    const store = new TransactionalTestStore();
    const response = await executeOfficeCommand(store, decision(store, 'approve', 'approve-demo'), () => AT);
    const item = response.snapshot.cases[0];
    assert.equal(item.payment, 'verified'); assert.equal(item.supplier, 'pending');
    assert.equal(item.approvals.find(row => row.id === 'approval-demo-aurora-proposals-fixture')?.status, 'approved_demo');
    assert.equal(response.snapshot.outboundEffects, 0); assert.equal(response.snapshot.mondayWrites, 0);
    assert(Object.values(store.state.approvals).some(row => row.valid));
  });

  it('revises a draft with attachments, invalidates approved content and replays current state', async () => {
    const store = new TransactionalTestStore();
    const approved = decision(store, 'approve', 'approval-first');
    await executeOfficeCommand(store, approved, () => AT);
    const revision = decision(store, 'revise', 'revise-after-approval', 'Nuevo contenido sintético que conserva adjuntos.');
    const revised = await executeOfficeCommand(store, revision, () => AT + 1);
    const current = revised.snapshot.cases[0].approvals.find(row => row.id === revision.approvalId)!;
    assert.equal(current.revision, 2); assert.equal(current.status, 'pending'); assert.equal(current.attachments.length, 1);
    assert.notEqual(current.digest, approved.digest);
    assert(Object.values(store.state.approvals).every(row => !row.valid));
    assert(Object.values(store.state.office.jobs).some(row => row.status === 'stale'));
    const replay = await executeOfficeCommand(store, approved, () => AT + 2);
    assert.equal(replay.replayed, true); assert.equal(replay.snapshot.cases[0].approvals.find(row => row.id === current.id)?.status, 'pending');
    await assert.rejects(executeOfficeCommand(store, { ...approved, idempotencyKey: 'old-content' }, () => AT + 3), error('REVISION_CONFLICT'));
    await assert.rejects(executeOfficeCommand(store, { ...approved, action: 'reject' }, () => AT + 3), error('IDEMPOTENCY_CONFLICT'));
  });

  it('rejects or cancels terminal drafts and refuses cross-case/function and stale digests atomically', async () => {
    for (const action of ['reject', 'cancel'] as const) {
      const store = new TransactionalTestStore();
      const response = await executeOfficeCommand(store, decision(store, action, `${action}-demo`), () => AT);
      assert.equal(response.snapshot.cases[0].approvals.find(row => row.id === 'approval-demo-aurora-proposals-fixture')?.status, action === 'reject' ? 'rejected_demo' : 'cancelled_demo');
      await assert.rejects(executeOfficeCommand(store, decision(store, 'approve', 'terminal-approve'), () => AT), error('APPROVAL_TERMINAL'));
    }
    const store = new TransactionalTestStore(); const original = canonical(store.state);
    const base = decision(store, 'approve', 'bound-approval');
    for (const [change, code] of [[{ caseId: 'demo-cedar' }, 'APPROVAL_NOT_FOUND'], [{ functionId: 'finance' }, 'APPROVAL_NOT_FOUND'], [{ digest: 'a'.repeat(64) }, 'APPROVAL_DIGEST_MISMATCH'], [{ revision: 2 }, 'REVISION_CONFLICT']] as const) {
      await assert.rejects(executeOfficeCommand(store, { ...base, ...change }, () => AT), error(code));
      assert.equal(canonical(store.state), original);
    }
  });

  it('bounds projections and labels partial coverage while preserving all durable records', () => {
    const state = createOfficeFixtureState(AT); const message = state.office.cases['demo-aurora'].messages[0];
    state.office.cases['demo-aurora'].messages = Array.from({ length: 1001 }, (_, i) => ({ ...message, id: `message-large-${i}`, evidence: { ...message.evidence, at: new Date(AT + i).toISOString() } }));
    const snapshot = projectOfficeSnapshot(state, AT + 1001);
    assert.equal(snapshot.hasMore, true); assert(snapshot.note.includes('Cobertura parcial'));
    assert.equal(snapshot.cases[0].messages.length, 1000); assert.equal(snapshot.cases[0].messages[0].id, 'message-large-1000');
    assert.equal(state.office.cases['demo-aurora'].messages.length, 1001);
    assert.deepEqual(validateOfficeSnapshot(snapshot, 'demo'), snapshot);
  });

  it('refuses remote, production, password and URL-option database connections', () => {
    assert.equal(validateDevelopmentDatabaseUrl('postgresql://office_candidate@127.0.0.1:55433/gourmet_office_candidate_dev'), 'postgresql://office_candidate@127.0.0.1:55433/gourmet_office_candidate_dev');
    for (const value of ['postgresql://office_candidate@example.test:55433/gourmet_office_candidate_dev', 'postgresql://office_candidate@127.0.0.1:55433/production', 'postgresql://office_candidate:password@127.0.0.1:55433/gourmet_office_candidate_dev', 'postgresql://office_candidate@127.0.0.1:55433/gourmet_office_candidate_dev?options=anything', 'invalid']) assert.throws(() => validateDevelopmentDatabaseUrl(value), error('INVALID_DEVELOPMENT_DATABASE'));
  });
});

describe('office development HTTP authorization', () => {
  it('requires explicit session and sets a random restricted cookie without secrets', async t => {
    const { api, headers, login } = await apiFixture(t);
    assert.equal((await api.inject({ url: '/office-api/snapshot', headers })).statusCode, 401);
    const first = await login(); const second = await login();
    assert.notEqual(first.cookie, second.cookie);
    assert(String(first.response.headers['set-cookie']).includes('HttpOnly; SameSite=Strict'));
    const session = first.response.json(); assert.equal(session.mode, 'demo'); assert.deepEqual(session.caseIds, [...CASE_IDS]); assert.deepEqual(session.storage, { kind: 'postgres', durable: true });
    assert.equal((await api.inject({ url: '/office-api/snapshot', headers: { ...headers, cookie: first.cookie } })).statusCode, 200);
  });

  it('filters reads and rejects writes and replays outside role, case and function scope', async t => {
    const { api, store, headers, login } = await apiFixture(t);
    const { cookie } = await login({ role: 'viewer', caseIds: ['demo-aurora'], functionIds: ['proposals'] });
    const snapshot = (await api.inject({ url: '/office-api/snapshot', headers: { ...headers, cookie } })).json();
    assert.equal(snapshot.cases.length, 1);
    for (const key of ['tasks', 'approvals', 'history', 'messages', 'results']) assert(snapshot.cases[0][key].every((row: { functionId: string }) => row.functionId === 'proposals'));
    assert.equal((await api.inject({ method: 'POST', url: '/office-api/commands', headers: { ...headers, cookie }, payload: decision(store, 'approve', 'viewer-write') })).statusCode, 403);
    const operator = await login();
    const command = { idempotencyKey: 'persisted-chat', caseId: 'demo-cedar', functionId: 'finance', action: 'chat', text: 'Pregunta sintética' };
    assert.equal((await api.inject({ method: 'POST', url: '/office-api/command', headers: { ...headers, cookie: operator.cookie }, payload: command })).statusCode, 200);
    const limited = await login({ role: 'operator', caseIds: ['demo-aurora'], functionIds: ['proposals'] });
    assert.equal((await api.inject({ method: 'POST', url: '/office-api/commands', headers: { ...headers, cookie: limited.cookie }, payload: command })).statusCode, 403);
    assert.equal((await api.inject({ method: 'POST', url: '/office-api/commands', headers: { ...headers, cookie: limited.cookie }, payload: { ...command, idempotencyKey: 'wrong-function', caseId: 'demo-aurora' } })).statusCode, 403);
  });

  it('checks host, origin, JSON body and logout without echoing invalid payloads', async t => {
    const { api, headers, login } = await apiFixture(t); const { cookie } = await login();
    for (const invalid of [{ host: 'external.example' }, { origin: 'http://external.example' }, { origin: '' }]) assert.equal((await api.inject({ method: 'POST', url: '/office-api/session', headers: { ...headers, ...invalid }, payload: {} })).statusCode, 403);
    const malformed = await api.inject({ method: 'POST', url: '/office-api/commands', headers: { ...headers, cookie }, payload: { unknown: 'private-data-never-reflected' } });
    assert.equal(malformed.statusCode, 400); assert(!malformed.body.includes('private-data'));
    const unknown = await api.inject({ method: 'POST', url: '/office-api/session', headers, payload: { actorId: 'fake' } }); assert.equal(unknown.statusCode, 400);
    assert.equal((await api.inject({ method: 'DELETE', url: '/office-api/session', headers: { ...headers, cookie } })).statusCode, 204);
    assert.equal((await api.inject({ url: '/office-api/session', headers: { ...headers, cookie } })).statusCode, 401);
  });

  it('expires sessions and reports a storage failure instead of generating a substitute', async t => {
    let now = AT; const { api, headers, login, store } = await apiFixture(t, () => now);
    const { cookie } = await login(); now += 4 * 60 * 60 * 1000;
    assert.equal((await api.inject({ url: '/office-api/snapshot', headers: { ...headers, cookie } })).statusCode, 401);
    store.snapshot = async () => { throw new Error('private database failure'); };
    const response = await api.inject({ url: '/office-api/health', headers }); assert.equal(response.statusCode, 503); assert.deepEqual(response.json(), { error: 'OFFICE_STORAGE_UNAVAILABLE' });
  });
});
