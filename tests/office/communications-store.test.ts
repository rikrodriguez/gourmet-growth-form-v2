import assert from 'node:assert/strict';
import test from 'node:test';
import type { CommunicationsLedger, CommunicationsScope } from '../../src/office/backend/communications-contracts';
import { MemoryMondayStore, MondayVault, type MondayStore } from '../../src/office/backend/monday-store';

const module = await import('../../src/office/backend/communications-store').catch(() => null);
function api() { assert.ok(module, 'The encrypted scoped communications store must be implemented.'); return module; }
const scope = (): CommunicationsScope => ({ organizationId: 'fixture-communications-org', actorId: 'fixture-reviewer', partition: 'external', dataMode: 'fixture' });
const vault = () => new MondayVault(Buffer.alloc(32, 71));
const code = (expected: string) => (error: unknown) => error instanceof Error && (error as Error & { code?: string }).code === expected && error.message === expected;
function ledger(owner = scope()): CommunicationsLedger {
  return { version: 1, scope: owner, revision: 1, events: [{ revision: 1, type: 'snapshot', value: {
    id: 'fixture-lead-snapshot', kind: 'lead', source: 'monday', sourceKey: 'fixture-board:fixture-lead', providerVersion: 'fixture-v1', observedAtMs: 1000, revision: 1, digest: 'a'.repeat(64),
    data: { boardId: 'fixture-board', itemId: 'fixture-lead', displayName: 'Fixture contact', email: 'fixture-contact@invalid.test', phone: null, phoneCountry: null, eventDate: '2026-12-01', guestsText: null, eventTypeText: null, serviceStyleText: null, mappingVersion: 'fixture-v1' },
  } }] };
}
function next(previous: CommunicationsLedger): CommunicationsLedger {
  const value = structuredClone(previous); value.revision++;
  value.events.push({ revision: value.revision, type: 'approval', value: { id: `fixture-approval-${value.revision}`, draftId: 'fixture-draft', draftRevision: 1, draftDigest: 'b'.repeat(64), approvedBy: value.scope.actorId, approvedAtMs: 2000, status: 'approved_unsent' } });
  return value;
}

test('encrypts ledger payload, returns detached data, and preserves opaque physical CAS revisions', async () => {
  const { createCommunicationsStore, communicationsStorageKey } = api(); const physical = new MemoryMondayStore(); const originalScope = scope(); const crypto = vault();
  const store = createCommunicationsStore({ scope: originalScope, store: physical, vault: crypto });
  assert.equal(await store.read(), null); const first = ledger(); assert.equal(await store.compareAndSet(null, first), true);
  const key = communicationsStorageKey(scope()); const sealed = await physical.read(key); assert.ok(sealed);
  const encoded = JSON.stringify(sealed.value);
  for (const marker of ['Fixture contact', 'fixture-contact@invalid.test', 'fixture-reviewer', 'fixture-board']) assert.ok(!encoded.includes(marker));
  assert.deepEqual(Object.keys(sealed.value as object).sort(), ['ciphertext', 'iv', 'tag', 'version']);
  const read = await store.read(); assert.ok(read); assert.deepEqual(read.ledger, first); assert.equal(read.revision, sealed.revision);
  assert.equal(await physical.compareAndSet('monday-fixture-unrelated', null, { unrelated: true }), true);
  assert.equal(await store.compareAndSet(read.revision, next(first)), true);
  const advanced = await store.read(); assert.ok(advanced); assert.equal(advanced.ledger.revision, 2); assert.ok(advanced.revision > read.revision + 1);
  read.ledger.events.length = 0; first.events.length = 0; originalScope.actorId = 'other-reviewer';
  assert.equal((await store.read())!.ledger.events.length, 2); assert.equal((await store.read())!.ledger.scope.actorId, 'fixture-reviewer');
  assert.equal('delete' in store, false);
});

test('isolates organization, actor, external partition and fixture versus live using unambiguous tuple keys', async () => {
  const { createCommunicationsStore, communicationsStorageKey } = api(); const physical = new MemoryMondayStore(); const crypto = vault(); const owner = scope();
  const first = createCommunicationsStore({ scope: owner, store: physical, vault: crypto }); assert.equal(await first.compareAndSet(null, ledger(owner)), true);
  const others: CommunicationsScope[] = [{ ...owner, actorId: 'fixture-other-reviewer' }, { ...owner, organizationId: 'fixture-other-org' }, { ...owner, dataMode: 'live' }];
  const keys = new Set([communicationsStorageKey(owner)]);
  for (const other of others) { keys.add(communicationsStorageKey(other)); assert.equal(await createCommunicationsStore({ scope: other, store: physical, vault: crypto }).read(), null); }
  assert.equal(keys.size, 4);
  assert.notEqual(communicationsStorageKey({ ...owner, organizationId: 'fixture:a', actorId: 'b:c' }), communicationsStorageKey({ ...owner, organizationId: 'fixture:a:b', actorId: 'c' }));
  assert.match(communicationsStorageKey(owner), /^monday-communications-[a-f0-9]{64}$/);
  assert.throws(() => createCommunicationsStore({ scope: { ...owner, partition: 'demo' } as unknown as CommunicationsScope, store: physical, vault: crypto }), code('COMMUNICATIONS_INVALID_SCOPE'));
  assert.throws(() => communicationsStorageKey({ ...owner, organizationId: '' }), code('COMMUNICATIONS_INVALID_SCOPE'));
  assert.throws(() => communicationsStorageKey({ ...owner, unexpected: true } as CommunicationsScope), code('COMMUNICATIONS_INVALID_SCOPE'));
});

test('rejects initial history gaps, foreign scope and rewritten history without changing persisted ciphertext', async () => {
  const { createCommunicationsStore, communicationsStorageKey } = api(); const physical = new MemoryMondayStore(); const store = createCommunicationsStore({ scope: scope(), store: physical, vault: vault() });
  await assert.rejects(store.compareAndSet(null, next(ledger())), code('COMMUNICATIONS_INVALID_LEDGER'));
  await assert.rejects(store.compareAndSet(null, ledger({ ...scope(), actorId: 'fixture-other' })), code('COMMUNICATIONS_INVALID_LEDGER'));
  assert.equal(await store.compareAndSet(null, ledger()), true); const read = (await store.read())!; const before = await physical.read(communicationsStorageKey(scope()));
  const rewritten = next(read.ledger); rewritten.events[0].value.id = 'rewritten-source';
  await assert.rejects(store.compareAndSet(read.revision, rewritten), code('COMMUNICATIONS_INVALID_LEDGER'));
  await assert.rejects(store.compareAndSet(read.revision, read.ledger), code('COMMUNICATIONS_INVALID_LEDGER'));
  const gapped = next(next(read.ledger)); await assert.rejects(store.compareAndSet(read.revision, gapped), code('COMMUNICATIONS_INVALID_LEDGER'));
  assert.deepEqual(await physical.read(communicationsStorageKey(scope())), before);
});

test('conflicting writes return false, retain one history advance, and retry against fresh physical revision', async () => {
  const { createCommunicationsStore } = api(); const physical = new MemoryMondayStore(); const first = createCommunicationsStore({ scope: scope(), store: physical, vault: vault() }); const second = createCommunicationsStore({ scope: scope(), store: physical, vault: vault() });
  assert.equal(await first.compareAndSet(null, ledger()), true); const read = (await first.read())!;
  const contenders = [next(read.ledger), next(read.ledger)]; contenders[1].events[1].value.id = 'fixture-other-approval';
  const result = await Promise.all(contenders.map((value, index) => [first, second][index].compareAndSet(read.revision, value)));
  assert.deepEqual([...result].sort(), [false, true]); const winner = (await first.read())!; assert.equal(winner.ledger.revision, 2);
  assert.equal(await second.compareAndSet(read.revision, next(read.ledger)), false);
  assert.equal(await second.compareAndSet(winner.revision, next(winner.ledger)), true); assert.equal((await first.read())!.ledger.revision, 3);
});

test('rejects executable serializers, accessor scope, sparse arrays, cycles and nonfinite data before storage', async () => {
  const { createCommunicationsStore, communicationsStorageKey } = api(); const physical = new MemoryMondayStore(); const store = createCommunicationsStore({ scope: scope(), store: physical, vault: vault() }); let executed = 0;
  const badScope = { ...scope() }; Object.defineProperty(badScope, 'actorId', { enumerable: true, get: () => { executed++; return 'fixture-reviewer'; } });
  assert.throws(() => communicationsStorageKey(badScope), code('COMMUNICATIONS_INVALID_SCOPE')); assert.equal(executed, 0);
  const accessor = ledger(); Object.defineProperty(accessor.events[0].value, 'danger', { enumerable: true, get: () => { executed++; return 'value'; } });
  const serializer = ledger(); Object.assign(serializer.events[0].value, { toJSON: () => { executed++; return 'bad'; } });
  const cycle = ledger(); Object.assign(cycle.events[0].value, { cycle });
  const nonfinite = ledger(); Object.assign(nonfinite.events[0].value, { count: Infinity });
  const sparse = ledger(); delete sparse.events[0];
  for (const value of [accessor, serializer, cycle, nonfinite, sparse]) await assert.rejects(store.compareAndSet(null, value), code('COMMUNICATIONS_INVALID_LEDGER'));
  assert.equal(executed, 0); assert.equal(await physical.read(communicationsStorageKey(scope())), null);
});

test('rejects malformed envelopes, event revisions and unsafe size or depth', async () => {
  const { createCommunicationsStore } = api(); const store = createCommunicationsStore({ scope: scope(), store: new MemoryMondayStore(), vault: vault() });
  const invalid: unknown[] = [{ ...ledger(), version: 2 }, { ...ledger(), revision: 0 }, { ...ledger(), events: [] }, { ...ledger(), extra: true }];
  const eventType = ledger(); eventType.events[0].type = 'send' as never; invalid.push(eventType);
  const revision = ledger(); revision.events[0].revision = 2; invalid.push(revision);
  const value = ledger(); value.events[0].value = null as never; invalid.push(value);
  const huge = ledger(); Object.assign(huge.events[0].value, { body: 'x'.repeat(1_048_576) }); invalid.push(huge);
  const deep = ledger(); let cursor: Record<string, unknown> = deep.events[0].value as unknown as Record<string, unknown>; for (let i = 0; i < 70; i++) { const nested = {}; cursor.nested = nested; cursor = nested; } invalid.push(deep);
  for (const item of invalid) await assert.rejects(store.compareAndSet(null, item as CommunicationsLedger), code('COMMUNICATIONS_INVALID_LEDGER'));
  for (const expected of [-1, 0, NaN, Number.MAX_SAFE_INTEGER + 1]) await assert.rejects(store.compareAndSet(expected, ledger()), code('COMMUNICATIONS_INVALID_LEDGER'));
});

test('scope-bound authenticated encryption rejects swapped ciphertext and changed authentication tags', async () => {
  const { createCommunicationsStore, communicationsStorageKey } = api(); const physical = new MemoryMondayStore(); const crypto = vault(); const first = createCommunicationsStore({ scope: scope(), store: physical, vault: crypto });
  assert.equal(await first.compareAndSet(null, ledger()), true); const ownKey = communicationsStorageKey(scope()); const sealed = (await physical.read(ownKey))!;
  const foreignScope = { ...scope(), actorId: 'fixture-other' }; const foreignKey = communicationsStorageKey(foreignScope);
  assert.equal(await physical.compareAndSet(foreignKey, null, sealed.value), true);
  await assert.rejects(createCommunicationsStore({ scope: foreignScope, store: physical, vault: crypto }).read(), code('COMMUNICATIONS_INVALID_LEDGER'));
  const changed = structuredClone(sealed.value) as { tag: string }; changed.tag = Buffer.alloc(16, 99).toString('base64url');
  assert.equal(await physical.compareAndSet(ownKey, sealed.revision, changed), true); await assert.rejects(first.read(), code('COMMUNICATIONS_INVALID_LEDGER'));
});

test('sanitizes unavailable storage and rejects corrupt decrypted ledgers without fallback', async () => {
  const { createCommunicationsStore, communicationsStorageKey } = api(); const noisy: MondayStore = { read: async () => { throw new Error('fixture-private@invalid.test'); }, compareAndSet: async () => { throw new Error('fixture-private@invalid.test'); } };
  const unavailable = createCommunicationsStore({ scope: scope(), store: noisy, vault: vault() }); await assert.rejects(unavailable.read(), code('COMMUNICATIONS_STORE_UNAVAILABLE')); await assert.rejects(unavailable.compareAndSet(null, ledger()), code('COMMUNICATIONS_STORE_UNAVAILABLE'));
  const physical = new MemoryMondayStore(); const owner = scope(); const key = communicationsStorageKey(owner); const crypto = vault(); const corrupt = { ...ledger(), scope: { ...owner, actorId: 'fixture-other' } };
  assert.equal(await physical.compareAndSet(key, null, crypto.seal(corrupt, `communications:v1:${key}`)), true);
  const store = createCommunicationsStore({ scope: owner, store: physical, vault: crypto }); await assert.rejects(store.read(), code('COMMUNICATIONS_INVALID_LEDGER'));
  await assert.rejects(store.compareAndSet((await physical.read(key))!.revision, next(ledger())), code('COMMUNICATIONS_INVALID_LEDGER'));
});
