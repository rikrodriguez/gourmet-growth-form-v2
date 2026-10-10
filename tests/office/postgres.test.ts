import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { PostgresOfficeStore } from '../../src/office/backend/postgres-store';
import { executeOfficeCommand } from '../../src/office/backend/commands';
import { createOfficeApi } from '../../src/office/backend/http';
import { OfficeError, canonical, projectOfficeSnapshot } from '../../src/office/backend/state';
import { validateOfficeSnapshot } from '../../src/office/adapter';

const AT = Date.parse('2026-10-10T21:00:00.000Z');
const stateId = `test-office-${randomUUID()}`;
let store: PostgresOfficeStore;
describe('office real PostgreSQL durability (requires office:db start)', () => {
  before(async () => { store = new PostgresOfficeStore({ stateId }); await store.initialize(AT); });
  after(async () => { await store?.close(); });

  it('persists concurrent commands exactly once across independent connections', async () => {
    const command = { idempotencyKey: 'pg-concurrent-chat', caseId: 'demo-aurora', functionId: 'sales', action: 'chat', text: 'Consulta sintética durable' };
    const results = await Promise.all(Array.from({ length: 6 }, () => executeOfficeCommand(store, command, () => AT + 1)));
    assert.equal(results.filter(row => !row.replayed).length, 1); assert.equal(results.filter(row => row.replayed).length, 5);
    const rows = await store.pool.query('SELECT * FROM office_demo.command_events WHERE state_id=$1 AND command_key=$2', [stateId, command.idempotencyKey]); assert.equal(rows.rowCount, 1);
    const state = await store.snapshot(); assert.equal(state.office.cases['demo-aurora'].messages.filter(row => row.text.includes('Consulta sintética durable')).length, 1);
    const beforeRevision = await store.pool.query('SELECT revision FROM office_demo.states WHERE id=$1', [stateId]);
    await executeOfficeCommand(store, command, () => AT + 2);
    const afterRevision = await store.pool.query('SELECT revision FROM office_demo.states WHERE id=$1', [stateId]); assert.deepEqual(beforeRevision.rows, afterRevision.rows);
  });

  it('rolls back thrown mutations and enforces append-only history in store and SQL', async () => {
    const before = canonical(await store.snapshot());
    await assert.rejects(store.transact(state => { state.office.cases['demo-aurora'].title = 'Must roll back'; throw new OfficeError('TEST_ABORT', 409); }));
    assert.equal(canonical(await store.snapshot()), before);
    await assert.rejects(store.transact(state => { delete state.office.history['history-demo-aurora-captured']; }), (error: unknown) => error instanceof OfficeError && error.code === 'HISTORY_APPEND_ONLY');
    await assert.rejects(store.transact(state => { state.office.commands['pg-concurrent-chat'].digest = 'a'.repeat(64); }), (error: unknown) => error instanceof OfficeError && error.code === 'COMMANDS_APPEND_ONLY');
    await assert.rejects(store.pool.query('DELETE FROM office_demo.history_events WHERE state_id=$1', [stateId]), /OFFICE_EVENTS_APPEND_ONLY/);
    await assert.rejects(store.pool.query("UPDATE office_demo.command_events SET action='cancel' WHERE state_id=$1", [stateId]), /OFFICE_EVENTS_APPEND_ONLY/);
    assert.equal(canonical(await store.snapshot()), before);
    const counts = await store.pool.query('SELECT count(*)::int AS count FROM office_demo.history_events WHERE state_id=$1', [stateId]); assert.equal(counts.rows[0].count, Object.keys((await store.snapshot()).office.history).length);
  });

  it('commits one decision under a race and keeps the exact revision durable', async () => {
    const state = await store.snapshot(); const row = state.office.approvals['approval-demo-aurora-proposals-fixture'];
    const base = { caseId: row.caseId, functionId: row.functionId, approvalId: row.id, revision: row.revision, digest: row.digest };
    const results = await Promise.allSettled([
      executeOfficeCommand(store, { ...base, idempotencyKey: 'pg-approve-race', action: 'approve' }, () => AT + 5),
      executeOfficeCommand(store, { ...base, idempotencyKey: 'pg-reject-race', action: 'reject' }, () => AT + 5),
    ]);
    assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
    const failed = results.find(row => row.status === 'rejected') as PromiseRejectedResult; assert.equal(failed.reason.code, 'APPROVAL_TERMINAL');
    const current = (await store.snapshot()).office.approvals[row.id]; assert(['approved_demo', 'rejected_demo'].includes(current.status));
    await executeOfficeCommand(store, { ...base, idempotencyKey: 'pg-revise-after-race', action: 'revise', text: 'Contenido sintético revisado y durable.' }, () => AT + 6);
    const revised = (await store.snapshot()).office.approvals[row.id]; assert.equal(revised.revision, 2); assert.equal(revised.status, 'pending'); assert.notEqual(revised.digest, base.digest);
    await assert.rejects(executeOfficeCommand(store, { ...base, idempotencyKey: 'pg-old-approval', action: 'approve' }, () => AT + 7), (error: unknown) => error instanceof OfficeError && error.code === 'REVISION_CONFLICT');
  });

  it('recovers commands, revised approvals and audit after replacing API and pool', async () => {
    const before = canonical(await store.snapshot());
    const firstApi = createOfficeApi(store, { clock: () => AT + 10 });
    const headers = { host: '127.0.0.1:4180', origin: 'http://127.0.0.1:4175' };
    const oldLogin = await firstApi.inject({ method: 'POST', url: '/office-api/session', headers, payload: {} }); const oldCookie = String(oldLogin.headers['set-cookie']).split(';')[0];
    await firstApi.close(); await store.close();
    store = new PostgresOfficeStore({ stateId }); await store.initialize(AT + 10);
    assert.equal(canonical(await store.snapshot()), before);
    const restarted = createOfficeApi(store, { clock: () => AT + 11 });
    try {
      assert.equal((await restarted.inject({ url: '/office-api/snapshot', headers: { ...headers, cookie: oldCookie } })).statusCode, 401);
      const login = await restarted.inject({ method: 'POST', url: '/office-api/session', headers, payload: {} }); assert.equal(login.statusCode, 200);
      const cookie = String(login.headers['set-cookie']).split(';')[0];
      const result = await restarted.inject({ url: '/office-api/snapshot', headers: { ...headers, cookie } }); assert.equal(result.statusCode, 200);
      assert.deepEqual(validateOfficeSnapshot(result.json(), 'demo'), projectOfficeSnapshot(await store.snapshot(), AT + 11));
      const replay = await restarted.inject({ method: 'POST', url: '/office-api/commands', headers: { ...headers, cookie }, payload: { idempotencyKey: 'pg-concurrent-chat', caseId: 'demo-aurora', functionId: 'sales', action: 'chat', text: 'Consulta sintética durable' } });
      assert.equal(replay.statusCode, 200); assert.equal(replay.json().replayed, true);
    } finally { await restarted.close(); }
  });
});
