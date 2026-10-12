import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CanonicalBridge, CanonicalBridgeError } from '../../src/office/backend/canonical-bridge';
import type {
  BridgeBindingRevision, BridgeChainReferences, BridgeCommand, BridgeEntityKind, BridgeReceipt,
  BridgeScope, BridgeSourcePolicy, BridgeSourceVersion, CanonicalBridgeStore,
} from '../../src/office/canonical-bridge-contracts';

const AT = Date.parse('2026-10-12T06:30:00.000Z');
const SCOPE: BridgeScope = { organizationId: 'boundary-org', actorId: 'boundary-actor', partition: 'demo' };
const SOURCES: readonly BridgeSourcePolicy[] = [
  { sourceSystem: 'fixture:boundary', partition: 'demo' },
  { sourceSystem: 'external:boundary', partition: 'external' },
];
const rejectsCode = (code: string) => (error: unknown) => error instanceof CanonicalBridgeError && error.code === code && error.message === code;
type SourceCommand = Extract<BridgeCommand, { action: 'record_source' }>;
type StoredRow = { revision: number; value: unknown };
type StoredEvent = { command: BridgeCommand; atMs: number; receipt: BridgeReceipt; previousDigest: string | null; digest: string };
type StoredLedger = { schemaVersion: 1; scope: BridgeScope; revision: number; events: StoredEvent[] };

// A detached, atomic synthetic CAS store, with deliberate failure injection.
class TestStore implements CanonicalBridgeStore {
  readonly rows = new Map<string, StoredRow>();
  writeCalls = 0;
  rejectNextWrite = false;
  async read(key: string): Promise<StoredRow | null> { return structuredClone(this.rows.get(key) ?? null); }
  async compareAndSet(key: string, expectedRevision: number | null, value: unknown): Promise<boolean> {
    this.writeCalls++;
    if (this.rejectNextWrite) { this.rejectNextWrite = false; return false; }
    const current = this.rows.get(key);
    if ((current?.revision ?? null) !== expectedRevision) return false;
    this.rows.set(key, { revision: (current?.revision ?? 0) + 1, value: structuredClone(value) });
    return true;
  }
}
function bridge(store: CanonicalBridgeStore, sources = SOURCES) { return new CanonicalBridge(store, { sources, clock: () => AT }); }
function command(kind: BridgeEntityKind, expectedRevision: number, suffix: string = kind): SourceCommand {
  return {
    action: 'record_source', idempotencyKey: `boundary-record-${suffix}`, expectedRevision, kind,
    reference: { sourceSystem: 'fixture:boundary', boardId: `fixture-board-${kind}`, itemId: `fixture-item-${suffix}` },
    sourceVersion: 'revision-1', contentDigest: 'a'.repeat(64),
    provenance: { evidenceRef: `fixture-proof-${suffix}`, observedAtMs: AT - 1 },
  };
}
function source(receipt: BridgeReceipt): BridgeSourceVersion { assert('entityId' in receipt.recorded); return receipt.recorded; }
function binding(receipt: BridgeReceipt): BridgeBindingRevision { assert('bindingId' in receipt.recorded); return receipt.recorded; }
async function seed(store: TestStore) {
  const service = bridge(store);
  const commands = (['lead', 'event', 'quote', 'invoice'] as const).map((kind, index) => command(kind, index));
  const receipts: BridgeReceipt[] = [];
  for (const item of commands) receipts.push(await service.execute(SCOPE, item));
  const refs: BridgeChainReferences = {
    lead: source(receipts[0]).id, event: source(receipts[1]).id,
    quote: source(receipts[2]).id, invoice: source(receipts[3]).id,
  };
  const bindCommand: BridgeCommand = {
    action: 'bind', idempotencyKey: 'boundary-bind', expectedRevision: 4,
    bindingId: 'boundary-chain', expectedBindingRevision: 0, expectedBindingDigest: null,
    evidenceRef: 'fixture-explicit-binding', refs,
  };
  const bound = await service.execute(SCOPE, bindCommand);
  return { service, commands, receipts, refs, bindCommand, bound };
}
function onlyRow(store: TestStore): { revision: number; value: StoredLedger } {
  assert.equal(store.rows.size, 1);
  return structuredClone([...store.rows.values()][0]) as { revision: number; value: StoredLedger };
}
function pausedRead(inner: CanonicalBridgeStore) {
  let entered!: () => void; let release!: () => void; let pause = true;
  const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
  const releasePromise = new Promise<void>(resolve => { release = resolve; });
  const store: CanonicalBridgeStore = {
    async read(key) {
      const row = await inner.read(key);
      if (pause) { pause = false; entered(); await releasePromise; }
      return row;
    },
    compareAndSet: (key, revision, value) => inner.compareAndSet(key, revision, value),
  };
  return { store, entered: enteredPromise, release };
}

describe('canonical bridge persisted ledger boundaries', () => {
  it('fails closed on altered commands, receipts, digests, deleted and reordered events', async () => {
    const store = new TestStore(); const seeded = await seed(store);
    const original = onlyRow(store); const before = await seeded.service.snapshot(SCOPE);
    const mutations: Array<(row: typeof original) => void> = [
      row => { assert(row.value.events[0].command.action === 'record_source'); row.value.events[0].command.reference.itemId = 'fixture-replaced-item'; },
      row => { source(row.value.events[0].receipt).provenance.evidenceRef = 'fixture-replaced-proof'; },
      row => { row.value.events[0].digest = 'f'.repeat(64); },
      row => { row.value.events.pop(); },
      row => { [row.value.events[0], row.value.events[1]] = [row.value.events[1], row.value.events[0]]; },
      row => { row.value.events[1].previousDigest = null; },
    ];
    for (const mutate of mutations) {
      const corrupted = structuredClone(original); mutate(corrupted); const unchangedCorruption = structuredClone(corrupted);
      let writes = 0;
      const substituted: CanonicalBridgeStore = {
        async read() { return structuredClone(corrupted); },
        async compareAndSet() { writes++; return true; },
      };
      const service = bridge(substituted);
      await assert.rejects(service.snapshot(SCOPE), rejectsCode('BRIDGE_STATE_INVALID'));
      await assert.rejects(service.execute(SCOPE, command('lead', before.revision, 'after-corruption')), rejectsCode('BRIDGE_STATE_INVALID'));
      assert.equal(writes, 0); assert.deepEqual(corrupted, unchangedCorruption);
      assert.deepEqual(await seeded.service.snapshot(SCOPE), before);
    }
  });

  it('rejects a valid foreign ledger substituted across organization, actor or partition', async () => {
    const ownerStore = new TestStore(); const seeded = await seed(ownerStore);
    const ownerRow = onlyRow(ownerStore); const ownerSnapshot = await seeded.service.snapshot(SCOPE);
    const scopes: BridgeScope[] = [
      { ...SCOPE, organizationId: 'foreign-org' }, { ...SCOPE, actorId: 'foreign-actor' }, { ...SCOPE, partition: 'external' },
    ];
    for (const scope of scopes) {
      for (const rewriteDeclaredScope of [false, true]) {
        const foreignRow = structuredClone(ownerRow);
        if (rewriteDeclaredScope) foreignRow.value.scope = structuredClone(scope);
        let writes = 0;
        const substituted: CanonicalBridgeStore = {
          async read() { return structuredClone(foreignRow); },
          async compareAndSet() { writes++; return true; },
        };
        const service = bridge(substituted);
        await assert.rejects(service.snapshot(scope), rejectsCode('BRIDGE_STATE_INVALID'));
        await assert.rejects(service.readBinding(scope, binding(seeded.bound).bindingId, 1), rejectsCode('BRIDGE_STATE_INVALID'));
        const newCommand = command('lead', ownerSnapshot.revision, 'foreign-write');
        if (scope.partition === 'external') newCommand.reference.sourceSystem = 'external:boundary';
        await assert.rejects(service.execute(scope, newCommand), rejectsCode('BRIDGE_STATE_INVALID'));
        assert.equal(writes, 0);
      }
    }
    assert.deepEqual(await seeded.service.snapshot(SCOPE), ownerSnapshot);
  });

  it('does not execute getters embedded in persisted values', async () => {
    const store = new TestStore(); await seed(store); const row = onlyRow(store); let getterCalls = 0; let writes = 0;
    Object.defineProperty(row.value.events[0], 'receipt', {
      enumerable: true, get() { getterCalls++; throw new Error('private-store-getter-detail'); },
    });
    const substituted: CanonicalBridgeStore = {
      async read() { return row; }, async compareAndSet() { writes++; return true; },
    };
    await assert.rejects(bridge(substituted).snapshot(SCOPE), rejectsCode('BRIDGE_STATE_INVALID'));
    await assert.rejects(bridge(substituted).execute(SCOPE, command('lead', 5, 'getter-write')), rejectsCode('BRIDGE_STATE_INVALID'));
    assert.equal(getterCalls, 0); assert.equal(writes, 0);
  });

  it('rejects oversized persisted bytes or event counts without replaying or writing them', async () => {
    const store = new TestStore(); const seeded = await seed(store); const original = onlyRow(store);
    const oversizedBytes = structuredClone(original);
    assert(oversizedBytes.value.events[0].command.action === 'record_source');
    oversizedBytes.value.events[0].command.provenance.evidenceRef = 'x'.repeat(1_048_577);
    // Keep the count fixture below the byte limit, without issuing 1000 commands.
    const compactStore = new TestStore();
    await bridge(compactStore).execute(SCOPE, {
      ...command('lead', 0), idempotencyKey: 'i', sourceVersion: 'v',
      reference: { sourceSystem: 'fixture:boundary', boardId: 'b', itemId: 'i' },
      provenance: { evidenceRef: 'e', observedAtMs: AT - 1 },
    });
    const compactEvent = onlyRow(compactStore).value.events[0];
    const oversizedEvents = structuredClone(original);
    oversizedEvents.value.events = Array.from({ length: 1001 }, () => structuredClone(compactEvent));
    oversizedEvents.value.revision = 1001;
    assert(Buffer.byteLength(JSON.stringify(oversizedEvents), 'utf8') < 1_048_576);
    for (const row of [oversizedBytes, oversizedEvents]) {
      let writes = 0;
      const substituted: CanonicalBridgeStore = {
        async read() { return structuredClone(row); }, async compareAndSet() { writes++; return true; },
      };
      const service = bridge(substituted);
      await assert.rejects(service.snapshot(SCOPE), rejectsCode('BRIDGE_STATE_INVALID'));
      await assert.rejects(service.execute(SCOPE, command('lead', row.value.revision, 'oversize-write')), rejectsCode('BRIDGE_STATE_INVALID'));
      assert.equal(writes, 0);
    }
    assert.deepEqual(onlyRow(store), original);
    assert.equal((await seeded.service.snapshot(SCOPE)).revision, 5);
  });

  it('reconstructs source versions, binding history and original receipts from the same CAS store', async () => {
    const store = new TestStore(); const seeded = await seed(store); const first = binding(seeded.bound);
    const removed = await bridge(store).execute(SCOPE, {
      action: 'unlink', idempotencyKey: 'boundary-persisted-unlink', expectedRevision: 5,
      bindingId: first.bindingId, expectedBindingRevision: first.revision, expectedBindingDigest: first.digest,
      evidenceRef: 'fixture-unlink-proof',
    });
    const tombstone = binding(removed);
    const restored = await bridge(store).execute(SCOPE, {
      action: 'revert', idempotencyKey: 'boundary-persisted-revert', expectedRevision: 6,
      bindingId: first.bindingId, expectedBindingRevision: tombstone.revision, expectedBindingDigest: tombstone.digest,
      evidenceRef: 'fixture-revert-proof', targetRevision: 1,
    });
    const before = await bridge(store).snapshot(SCOPE); const writes = store.writeCalls;
    const reconstructed = bridge(store);
    assert.deepEqual(await reconstructed.readBinding(SCOPE, first.bindingId, 1), first);
    assert.deepEqual(await reconstructed.readBinding(SCOPE, first.bindingId, 2), tombstone);
    assert.deepEqual(await reconstructed.readBinding(SCOPE, first.bindingId, 3), binding(restored));
    assert.deepEqual(await reconstructed.resolve(SCOPE, seeded.refs.invoice!), binding(restored));
    for (const [originalCommand, originalReceipt] of [
      [seeded.commands[0], seeded.receipts[0]], [seeded.bindCommand, seeded.bound],
    ] as const) {
      const replay = await reconstructed.execute(SCOPE, originalCommand);
      assert.deepEqual(replay, { ...originalReceipt, replayed: true });
    }
    await assert.rejects(reconstructed.execute(SCOPE, { ...seeded.commands[0], sourceVersion: 'revision-replaced' }), rejectsCode('BRIDGE_IDEMPOTENCY_CONFLICT'));
    assert.equal(store.writeCalls, writes); assert.deepEqual(await bridge(store).snapshot(SCOPE), before);
  });

  it('never substitutes the latest binding for an absent exact read or revert revision', async () => {
    const store = new TestStore(); const seeded = await seed(store); const first = binding(seeded.bound);
    const before = await seeded.service.snapshot(SCOPE); const writes = store.writeCalls;
    await assert.rejects(seeded.service.readBinding(SCOPE, first.bindingId, 2), rejectsCode('BRIDGE_REFERENCE_NOT_FOUND'));
    await assert.rejects(seeded.service.readBinding(SCOPE, 'absent-binding', 1), rejectsCode('BRIDGE_REFERENCE_NOT_FOUND'));
    await assert.rejects(seeded.service.execute(SCOPE, {
      action: 'revert', idempotencyKey: 'boundary-missing-target', expectedRevision: before.revision,
      bindingId: first.bindingId, expectedBindingRevision: first.revision, expectedBindingDigest: first.digest,
      evidenceRef: 'fixture-missing-target-proof', targetRevision: 999,
    }), rejectsCode('BRIDGE_REFERENCE_NOT_FOUND'));
    assert.deepEqual(await seeded.service.resolve(SCOPE, seeded.refs.lead), first);
    assert.deepEqual(await seeded.service.snapshot(SCOPE), before); assert.equal(store.writeCalls, writes);
  });
});

describe('canonical bridge asynchronous and CAS boundaries', () => {
  it('detaches source command and authorized scope before a pending store read', async () => {
    const store = new TestStore(); const paused = pausedRead(store); const service = bridge(paused.store);
    const originalScope = structuredClone(SCOPE); const suppliedScope = structuredClone(SCOPE);
    const suppliedCommand = command('lead', 0, 'pending-input'); const originalCommand = structuredClone(suppliedCommand);
    const pending = service.execute(suppliedScope, suppliedCommand); await paused.entered;
    suppliedScope.organizationId = 'injected-org'; suppliedScope.actorId = 'injected-actor'; suppliedScope.partition = 'external';
    suppliedCommand.kind = 'invoice'; suppliedCommand.reference.sourceSystem = 'external:boundary';
    suppliedCommand.reference.boardId = 'injected-board'; suppliedCommand.reference.itemId = 'injected-item';
    suppliedCommand.sourceVersion = 'injected-version'; suppliedCommand.provenance.evidenceRef = 'injected-proof';
    suppliedCommand.expectedRevision = 999; suppliedCommand.idempotencyKey = 'injected-key';
    paused.release(); const receipt = await pending;
    const row = source(receipt);
    assert.equal(row.kind, originalCommand.kind); assert.deepEqual(row.reference, originalCommand.reference);
    assert.equal(row.sourceVersion, originalCommand.sourceVersion); assert.deepEqual(row.provenance, originalCommand.provenance);
    assert.equal(row.recordedBy, originalScope.actorId);
    assert.deepEqual((await service.snapshot(originalScope)).sourceVersions, [row]);
    assert.equal((await service.snapshot(suppliedScope)).revision, 0);
    assert.equal((await service.execute(originalScope, originalCommand)).replayed, true);
  });

  it('detaches nested binding references while the ledger load is pending', async () => {
    const store = new TestStore(); const seeded = await seed(store);
    const paused = pausedRead(store); const service = bridge(paused.store);
    const supplied: Extract<BridgeCommand, { action: 'bind' }> = {
      action: 'bind', idempotencyKey: 'boundary-pending-binding', expectedRevision: 5,
      bindingId: 'pending-binding', expectedBindingRevision: 0, expectedBindingDigest: null,
      evidenceRef: 'fixture-pending-binding-proof', refs: structuredClone(seeded.refs),
    };
    const original = structuredClone(supplied); const pending = service.execute(SCOPE, supplied); await paused.entered;
    supplied.refs.lead = seeded.refs.event; supplied.refs.event = 'injected-version';
    supplied.refs.quote = null; supplied.refs.invoice = null;
    supplied.bindingId = 'injected-binding'; supplied.evidenceRef = 'injected-proof';
    paused.release(); const recorded = binding(await pending);
    assert.equal(recorded.bindingId, original.bindingId); assert.equal(recorded.evidenceRef, original.evidenceRef);
    assert.deepEqual(recorded.refs, original.refs);
    assert.deepEqual(await service.readBinding(SCOPE, original.bindingId, 1), recorded);
    await assert.rejects(service.readBinding(SCOPE, supplied.bindingId, 1), rejectsCode('BRIDGE_REFERENCE_NOT_FOUND'));
  });

  it('detaches scopes of snapshot, resolve and exact binding reads while awaiting storage', async () => {
    const store = new TestStore(); const seeded = await seed(store); const expectedSnapshot = await seeded.service.snapshot(SCOPE);
    const expectedBinding = binding(seeded.bound);
    const reads: Array<(service: CanonicalBridge, scope: BridgeScope) => Promise<unknown>> = [
      (service, scope) => service.snapshot(scope),
      (service, scope) => service.resolve(scope, seeded.refs.lead),
      (service, scope) => service.readBinding(scope, expectedBinding.bindingId, 1),
    ];
    for (const [index, read] of reads.entries()) {
      const paused = pausedRead(store); const suppliedScope = structuredClone(SCOPE);
      const pending = read(bridge(paused.store), suppliedScope); await paused.entered;
      suppliedScope.actorId = 'replaced-actor'; suppliedScope.organizationId = 'replaced-org'; suppliedScope.partition = 'external';
      paused.release(); assert.deepEqual(await pending, index === 0 ? expectedSnapshot : expectedBinding);
    }
    assert.deepEqual(await seeded.service.snapshot(SCOPE), expectedSnapshot);
  });

  it('keeps the trusted source registry detached from caller mutation during an await', async () => {
    const store = new TestStore(); const paused = pausedRead(store);
    const policies: BridgeSourcePolicy[] = structuredClone(SOURCES) as BridgeSourcePolicy[];
    const service = bridge(paused.store, policies); const pending = service.execute(SCOPE, command('lead', 0, 'policy-copy'));
    await paused.entered;
    policies[0].sourceSystem = 'injected:source'; policies[0].partition = 'external';
    policies.push({ sourceSystem: 'injected:allowed', partition: 'demo' });
    paused.release(); const recorded = source(await pending);
    assert.equal(recorded.reference.sourceSystem, 'fixture:boundary');
    const before = await service.snapshot(SCOPE);
    const injected = command('lead', before.revision, 'policy-injection'); injected.reference.sourceSystem = 'injected:allowed';
    await assert.rejects(service.execute(SCOPE, injected), rejectsCode('BRIDGE_SOURCE_NOT_ALLOWED'));
    assert.deepEqual(await service.snapshot(SCOPE), before);
  });

  it('leaves no partial source version or idempotency receipt after CAS returns false', async () => {
    const store = new TestStore(); const service = bridge(store); const original = await service.snapshot(SCOPE);
    const supplied = command('lead', 0, 'cas-retry'); store.rejectNextWrite = true;
    await assert.rejects(service.execute(SCOPE, supplied), rejectsCode('BRIDGE_REVISION_CONFLICT'));
    assert.deepEqual(await service.snapshot(SCOPE), original); assert.equal(store.rows.size, 0);
    const retry = await bridge(store).execute(SCOPE, supplied);
    assert.equal(retry.replayed, false); assert.equal(retry.deduplicated, false); assert.equal(retry.revision, 1);
    assert.deepEqual((await service.snapshot(SCOPE)).sourceVersions, [source(retry)]);
    assert.equal((await service.execute(SCOPE, supplied)).replayed, true);
  });

  it('keeps unlink and revert history unchanged after failed CAS and permits an exact retry', async () => {
    const store = new TestStore(); const seeded = await seed(store); const first = binding(seeded.bound);
    const unlink: BridgeCommand = {
      action: 'unlink', idempotencyKey: 'boundary-cas-unlink', expectedRevision: 5,
      bindingId: first.bindingId, expectedBindingRevision: first.revision, expectedBindingDigest: first.digest,
      evidenceRef: 'fixture-cas-unlink-proof',
    };
    const beforeUnlink = await seeded.service.snapshot(SCOPE); store.rejectNextWrite = true;
    await assert.rejects(seeded.service.execute(SCOPE, unlink), rejectsCode('BRIDGE_REVISION_CONFLICT'));
    assert.deepEqual(await bridge(store).snapshot(SCOPE), beforeUnlink);
    assert.deepEqual(await seeded.service.resolve(SCOPE, seeded.refs.invoice!), first);
    const removed = await bridge(store).execute(SCOPE, unlink); const tombstone = binding(removed);
    assert.equal(removed.replayed, false); assert.equal(tombstone.revision, 2);
    const revert: BridgeCommand = {
      action: 'revert', idempotencyKey: 'boundary-cas-revert', expectedRevision: 6,
      bindingId: first.bindingId, expectedBindingRevision: tombstone.revision, expectedBindingDigest: tombstone.digest,
      evidenceRef: 'fixture-cas-revert-proof', targetRevision: 1,
    };
    const beforeRevert = await seeded.service.snapshot(SCOPE); store.rejectNextWrite = true;
    await assert.rejects(seeded.service.execute(SCOPE, revert), rejectsCode('BRIDGE_REVISION_CONFLICT'));
    assert.deepEqual(await bridge(store).snapshot(SCOPE), beforeRevert);
    assert.equal(await seeded.service.resolve(SCOPE, seeded.refs.invoice!), null);
    const restored = await bridge(store).execute(SCOPE, revert);
    assert.equal(restored.replayed, false); assert.equal(binding(restored).revision, 3);
    assert.deepEqual(await seeded.service.resolve(SCOPE, seeded.refs.invoice!), binding(restored));
    assert.deepEqual((await seeded.service.snapshot(SCOPE)).bindings.map(row => row.action), ['bind', 'unlink', 'revert']);
  });
});
