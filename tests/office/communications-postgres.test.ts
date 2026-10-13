import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import type { CommunicationsLedger, CommunicationsScope } from '../../src/office/backend/communications-contracts';
import { communicationsStorageKey, createCommunicationsStore } from '../../src/office/backend/communications-store';
import { MondayVault, PostgresMondayStore } from '../../src/office/backend/monday-store';
import { PostgresOfficeStore } from '../../src/office/backend/postgres-store';

const AT = Date.parse('2026-10-12T12:00:00.000Z');
const EMAIL = 'fixture-backup-marker@invalid.test';
const TEXT = 'SYNTHETIC_COMMUNICATION_BODY_NEVER_PLAINTEXT';
function scope(): CommunicationsScope { return { organizationId: `fixture-communications-${randomUUID()}`, actorId: 'fixture-reviewer', partition: 'external', dataMode: 'fixture' }; }
function ledger(owner: CommunicationsScope): CommunicationsLedger {
  return { version: 1, scope: owner, revision: 1, events: [{ revision: 1, type: 'snapshot', value: {
    id: 'fixture-thread-snapshot', source: 'gmail', kind: 'thread', sourceKey: 'fixture-info:fixture-thread', providerVersion: 'fixture-version-1', observedAtMs: AT, revision: 1, digest: 'a'.repeat(64),
    data: { mailbox: 'info', accountId: 'fixture-account-info', threadId: 'fixture-thread', messages: [{ id: 'fixture-message', from: [EMAIL], to: ['fixture-info@invalid.test'], cc: [], subject: 'Fixture request', bodyText: TEXT, attachments: [] }], coverage: { scope: 'selected_thread', incoming: 'complete', outgoing: 'complete' } },
  } }] };
}
function advance(previous: CommunicationsLedger, suffix = 'a'): CommunicationsLedger {
  const value = structuredClone(previous); value.revision++;
  value.events.push({ revision: value.revision, type: 'approval', value: { id: `fixture-approval-${value.revision}-${suffix}`, draftId: 'fixture-draft', draftRevision: 1, draftDigest: 'b'.repeat(64), approvedBy: value.scope.actorId, approvedAtMs: AT + value.revision, status: 'approved_unsent' } });
  return value;
}
async function harness(t: TestContext) {
  const stateId = `communications_test_${randomUUID()}`; const connections: PostgresOfficeStore[] = []; const closed = new Set<PostgresOfficeStore>(); const keys = new Set<string>();
  const vault = new MondayVault(Buffer.alloc(32, 79));
  async function connect(owner: CommunicationsScope) {
    const office = new PostgresOfficeStore({ stateId }); connections.push(office); await office.initialize(AT);
    const physical = new PostgresMondayStore(office.pool); keys.add(communicationsStorageKey(owner));
    return { office, physical, store: createCommunicationsStore({ scope: owner, store: physical, vault }) };
  }
  async function close(office: PostgresOfficeStore) { await office.close(); closed.add(office); }
  t.after(async () => {
    const active = connections.find(connection => !closed.has(connection));
    try {
      if (active) { const physical = new PostgresMondayStore(active.pool); for (const key of keys) { const stored = await physical.read(key); if (stored) assert.equal(await physical.compareAndSet(key, stored.revision, null), true); } }
    } finally { for (const connection of connections) if (!closed.has(connection)) await close(connection); }
  });
  return { connect, close, vault };
}

test('encrypted communications history and exact approval survive actual PostgreSQL pool replacement', async t => {
  const owner = scope(); const { connect, close } = await harness(t); const original = await connect(owner); const first = ledger(owner);
  assert.equal(await original.store.compareAndSet(null, first), true); const persisted = (await original.store.read())!;
  const approved = advance(persisted.ledger); assert.equal(await original.store.compareAndSet(persisted.revision, approved), true); const before = (await original.store.read())!;
  const encoded = await original.office.pool.query<{ payload: string }>('SELECT payload::text AS payload FROM office_demo.monday_private_records WHERE key=$1', [communicationsStorageKey(owner)]);
  assert.equal(encoded.rowCount, 1);
  for (const marker of [EMAIL, TEXT, owner.organizationId, owner.actorId, 'approved_unsent', 'fixture-thread']) assert.ok(!encoded.rows[0].payload.includes(marker));
  await close(original.office);
  const replacement = await connect(owner); const recovered = (await replacement.store.read())!;
  assert.deepEqual(recovered, before); assert.deepEqual(recovered.ledger.events, approved.events);
  assert.equal(recovered.ledger.events[1].type, 'approval'); assert.equal(recovered.ledger.revision, 2);
  assert.equal(await replacement.store.compareAndSet(recovered.revision, advance(recovered.ledger)), true);
  assert.equal((await replacement.store.read())!.ledger.revision, 3);
});

test('independent PostgreSQL workers serialize absent inserts and competing appends with opaque physical CAS tokens', async t => {
  const owner = scope(); const { connect } = await harness(t); const first = await connect(owner); const second = await connect(owner); const initial = ledger(owner);
  const insertions = await Promise.all([first.store.compareAndSet(null, initial), second.store.compareAndSet(null, initial)]);
  assert.deepEqual([...insertions].sort(), [false, true]); const before = (await first.store.read())!;
  assert.ok(before.revision > before.ledger.revision, 'A private-table sequence token must not be confused with logical ledger revision.');
  const candidates = [advance(before.ledger, 'first'), advance(before.ledger, 'second')];
  const appends = await Promise.all([first.store.compareAndSet(before.revision, candidates[0]), second.store.compareAndSet(before.revision, candidates[1])]);
  assert.deepEqual([...appends].sort(), [false, true]); const winner = (await second.store.read())!;
  assert.equal(winner.ledger.revision, 2); assert.equal(winner.ledger.events.length, 2); assert.deepEqual(winner.ledger.events[0], before.ledger.events[0]);
  assert.equal(await first.store.compareAndSet(before.revision, advance(before.ledger, 'stale')), false);
  assert.equal(await second.store.compareAndSet(winner.revision, advance(winner.ledger, 'retry')), true);
  const durable = (await first.store.read())!; assert.equal(durable.ledger.revision, 3); assert.equal(durable.ledger.events.length, 3);
});

test('PostgreSQL communications scopes isolate organization, actor and fixture versus live and reject ciphertext transplantation', async t => {
  const owner = scope(); const { connect } = await harness(t); const first = await connect(owner); assert.equal(await first.store.compareAndSet(null, ledger(owner)), true);
  const original = (await first.physical.read(communicationsStorageKey(owner)))!;
  const others: CommunicationsScope[] = [{ ...owner, actorId: 'fixture-second-reviewer' }, { ...owner, organizationId: `fixture-other-${randomUUID()}` }, { ...owner, dataMode: 'live' }];
  for (const other of others) {
    const connection = await connect(other); assert.equal(await connection.store.read(), null);
    assert.equal(await connection.physical.compareAndSet(communicationsStorageKey(other), null, original.value), true);
    await assert.rejects(connection.store.read(), error => error instanceof Error && error.message === 'COMMUNICATIONS_INVALID_LEDGER');
  }
  const originalLedger = (await first.store.read())!.ledger; const rewritten = advance(originalLedger); rewritten.events[0].value.id = 'fixture-forged-source';
  await assert.rejects(first.store.compareAndSet(original.revision, rewritten), error => error instanceof Error && error.message === 'COMMUNICATIONS_INVALID_LEDGER');
  assert.deepEqual((await first.physical.read(communicationsStorageKey(owner)))!.value, original.value);
  const result = await first.office.pool.query<{ count: string }>('SELECT count(*)::text AS count FROM office_demo.monday_private_records WHERE key=ANY($1::text[])', [[communicationsStorageKey(owner), ...others.map(communicationsStorageKey)]]);
  assert.equal(result.rows[0].count, '4');
});
