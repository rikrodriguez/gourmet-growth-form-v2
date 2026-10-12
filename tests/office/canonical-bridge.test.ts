import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { describe, it } from 'node:test';
import { CanonicalBridge, CanonicalBridgeError, MemoryCanonicalBridgeStore } from '../../src/office/backend/canonical-bridge';
import type { BridgeBindingRevision, BridgeChainReferences, BridgeCommand, BridgeEntityKind, BridgeScope, BridgeSourceReference, BridgeSourceVersion, CanonicalBridgeStore } from '../../src/office/canonical-bridge-contracts';
import { createOfficeFixtureState } from '../../src/office/backend/fixtures';
import { projectOfficeSnapshot } from '../../src/office/backend/state';

const AT = Date.parse('2026-10-12T06:00:00.000Z');
const DEMO: BridgeScope = { organizationId: 'org-synthetic', actorId: 'actor-synthetic', partition: 'demo' };
const EXTERNAL: BridgeScope = { ...DEMO, partition: 'external' };
const SOURCES = [{ sourceSystem: 'fixture:office', partition: 'demo' }, { sourceSystem: 'external:test', partition: 'external' }] as const;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const rejectsCode = (code: string) => (value: unknown) => value instanceof CanonicalBridgeError && value.code === code && value.message === code;
let sequence = 0;
const key = (prefix: string) => `${prefix}-${++sequence}`;
function makeBridge(store: CanonicalBridgeStore = new MemoryCanonicalBridgeStore(), clock = () => AT) {
  return new CanonicalBridge(store, { sources: SOURCES, clock });
}
function sourceCommand(kind: BridgeEntityKind, suffix: string, expectedRevision: number, scope: BridgeScope = DEMO, changes: Partial<BridgeCommand & { action: 'record_source' }> = {}): BridgeCommand {
  return {
    action: 'record_source', idempotencyKey: key(`source-${suffix}`), expectedRevision, kind,
    reference: { sourceSystem: scope.partition === 'demo' ? 'fixture:office' : 'external:test', boardId: `board-${kind}`, itemId: `item-${suffix}` },
    sourceVersion: 'version-1', contentDigest: digest(`${kind}:${suffix}:version-1`),
    provenance: { evidenceRef: `evidence-${suffix}`, observedAtMs: AT - 1000 }, ...changes,
  };
}
function sourceVersion(value: BridgeSourceVersion | BridgeBindingRevision): BridgeSourceVersion {
  assert('entityId' in value); return value;
}
function binding(value: BridgeSourceVersion | BridgeBindingRevision): BridgeBindingRevision {
  assert('bindingId' in value); return value;
}
async function record(bridge: CanonicalBridge, kind: BridgeEntityKind, suffix: string, scope: BridgeScope = DEMO, changes: Partial<BridgeCommand & { action: 'record_source' }> = {}) {
  const snapshot = await bridge.snapshot(scope);
  return sourceVersion((await bridge.execute(scope, sourceCommand(kind, suffix, snapshot.revision, scope, changes))).recorded);
}
async function chain(bridge: CanonicalBridge, suffix: string, scope: BridgeScope = DEMO): Promise<BridgeChainReferences> {
  return {
    lead: (await record(bridge, 'lead', `${suffix}-lead`, scope)).id,
    event: (await record(bridge, 'event', `${suffix}-event`, scope)).id,
    quote: (await record(bridge, 'quote', `${suffix}-quote`, scope)).id,
    invoice: (await record(bridge, 'invoice', `${suffix}-invoice`, scope)).id,
  };
}
async function bind(bridge: CanonicalBridge, bindingId: string, refs: BridgeChainReferences, scope: BridgeScope = DEMO, previous: BridgeBindingRevision | null = null) {
  const snapshot = await bridge.snapshot(scope);
  return binding((await bridge.execute(scope, {
    action: 'bind', idempotencyKey: key(`bind-${bindingId}`), expectedRevision: snapshot.revision,
    bindingId, expectedBindingRevision: previous?.revision ?? 0, expectedBindingDigest: previous?.digest ?? null,
    evidenceRef: `evidence-bind-${bindingId}`, refs,
  })).recorded);
}
async function unlink(bridge: CanonicalBridge, previous: BridgeBindingRevision, scope: BridgeScope = DEMO) {
  return binding((await bridge.execute(scope, {
    action: 'unlink', idempotencyKey: key('unlink'), expectedRevision: (await bridge.snapshot(scope)).revision,
    bindingId: previous.bindingId, expectedBindingRevision: previous.revision, expectedBindingDigest: previous.digest,
    evidenceRef: 'evidence-unlink',
  })).recorded);
}

describe('canonical bridge explicit source references', () => {
  it('starts empty and retains only reference, revision and provenance data', async () => {
    const bridge = makeBridge();
    assert.deepEqual(await bridge.snapshot(DEMO), { schemaVersion: 1, scope: DEMO, revision: 0, sourceVersions: [], bindings: [] });
    const command = sourceCommand('lead', 'minimal', 0);
    const receipt = await bridge.execute(DEMO, command);
    const row = sourceVersion(receipt.recorded);
    assert.equal(receipt.replayed, false); assert.equal(receipt.deduplicated, false); assert.equal(receipt.revision, 1);
    assert.deepEqual(row.reference, (command as Extract<BridgeCommand, { action: 'record_source' }>).reference);
    assert.equal(row.recordedBy, DEMO.actorId); assert.equal(row.recordedAtMs, AT);
    assert(row.id.length > 0); assert(row.entityId.length > 0);
    assert.equal(Object.hasOwn(row, 'name'), false); assert.equal(Object.hasOwn(row, 'contact'), false); assert.equal(Object.hasOwn(row, 'amount'), false);
    assert.equal((await bridge.snapshot(DEMO)).sourceVersions.length, 1);
  });

  it('deduplicates a source version without replacing first observed provenance', async () => {
    const bridge = makeBridge(); const firstCommand = sourceCommand('quote', 'duplicate', 0);
    const first = await bridge.execute(DEMO, firstCommand); const row = sourceVersion(first.recorded);
    const second = await bridge.execute(DEMO, {
      ...firstCommand, idempotencyKey: key('re-observed'), expectedRevision: (await bridge.snapshot(DEMO)).revision,
      provenance: { evidenceRef: 'new-observation-evidence', observedAtMs: AT },
    });
    assert.equal(second.replayed, false); assert.equal(second.deduplicated, true);
    assert.deepEqual(second.recorded, row);
    assert.equal((await bridge.snapshot(DEMO)).sourceVersions.length, 1);
  });

  it('retains multiple immutable source versions without selecting a latest version for bindings', async () => {
    const bridge = makeBridge(); const refs = await chain(bridge, 'versions');
    const quote1 = (await bridge.snapshot(DEMO)).sourceVersions.find(row => row.id === refs.quote)!;
    const first = await bind(bridge, 'binding-versions', refs);
    const quote2 = await record(bridge, 'quote', 'versions-quote', DEMO, { sourceVersion: 'version-2', contentDigest: digest('quote-version-2') });
    assert.equal(quote2.entityId, quote1.entityId); assert.notEqual(quote2.id, quote1.id);
    assert.deepEqual((await bridge.readBinding(DEMO, first.bindingId, 1)).refs, refs);
    const second = await bind(bridge, first.bindingId, { ...refs, quote: quote2.id }, DEMO, first);
    assert.equal(second.revision, 2); assert.equal(second.previousDigest, first.digest); assert.equal(second.refs?.quote, quote2.id);
    assert.equal((await bridge.readBinding(DEMO, first.bindingId, 1)).refs?.quote, quote1.id);
    assert.equal((await bridge.snapshot(DEMO)).sourceVersions.filter(row => row.entityId === quote1.entityId).length, 2);
    assert.equal(await bridge.resolve(DEMO, quote1.id), null);
    assert.deepEqual(await bridge.resolve(DEMO, quote2.id), second);
  });

  it('rejects changed content or kind for an existing identity atomically', async () => {
    const bridge = makeBridge(); const command = sourceCommand('lead', 'immutable', 0);
    await bridge.execute(DEMO, command); const before = await bridge.snapshot(DEMO);
    await assert.rejects(bridge.execute(DEMO, { ...command, idempotencyKey: key('changed-digest'), expectedRevision: before.revision, contentDigest: digest('changed') }), rejectsCode('BRIDGE_VERSION_CONFLICT'));
    await assert.rejects(bridge.execute(DEMO, { ...command, idempotencyKey: key('changed-kind'), expectedRevision: before.revision, kind: 'event', sourceVersion: 'version-2' }), rejectsCode('BRIDGE_ENTITY_KIND_CONFLICT'));
    assert.deepEqual(await bridge.snapshot(DEMO), before);
  });

  it('uses collision-safe tuples for source identities and trusted workspace keys', async () => {
    const bridge = makeBridge();
    const reference1: BridgeSourceReference = { sourceSystem: 'fixture:office', boardId: 'board:a', itemId: 'b' };
    const reference2: BridgeSourceReference = { sourceSystem: 'fixture:office', boardId: 'board', itemId: 'a:b' };
    const a = await record(bridge, 'lead', 'tuple-a', DEMO, { reference: reference1 });
    const b = await record(bridge, 'lead', 'tuple-b', DEMO, { reference: reference2 });
    assert.notEqual(a.entityId, b.entityId); assert.notEqual(a.id, b.id);
    const scope1: BridgeScope = { organizationId: 'org:a', actorId: 'b', partition: 'demo' };
    const scope2: BridgeScope = { organizationId: 'org', actorId: 'a:b', partition: 'demo' };
    await record(bridge, 'lead', 'tuple-workspace', scope1);
    assert.equal((await bridge.snapshot(scope1)).sourceVersions.length, 1);
    assert.equal((await bridge.snapshot(scope2)).sourceVersions.length, 0);
  });

  it('does not infer links from matching source tokens or arbitrary commercial values', async () => {
    const bridge = makeBridge();
    const lead = await record(bridge, 'lead', 'same-token', DEMO, { reference: { sourceSystem: 'fixture:office', boardId: 'board-lead', itemId: 'same-token' } });
    const event = await record(bridge, 'event', 'same-token', DEMO, { reference: { sourceSystem: 'fixture:office', boardId: 'board-event', itemId: 'same-token' } });
    assert.equal(await bridge.resolve(DEMO, lead.id), null); assert.equal(await bridge.resolve(DEMO, event.id), null);
    const before = await bridge.snapshot(DEMO);
    await assert.rejects(bridge.execute(DEMO, { ...sourceCommand('quote', 'no-commercial-payload', before.revision), name: 'Synthetic same token', email: 'synthetic@invalid.test', amount: 100 }), rejectsCode('BRIDGE_INVALID_COMMAND'));
    assert.deepEqual(await bridge.snapshot(DEMO), before);
  });
});

describe('canonical bridge explicit chains and history', () => {
  it('allows an explicit lead-event chain before quote and invoice exist', async () => {
    const bridge = makeBridge(); const lead = await record(bridge, 'lead', 'early-lead'); const event = await record(bridge, 'event', 'early-event');
    const refs = { lead: lead.id, event: event.id, quote: null, invoice: null };
    const row = await bind(bridge, 'binding-early', refs);
    assert.deepEqual(row.refs, refs); assert.equal(row.revision, 1);
    assert.deepEqual(await bridge.resolve(DEMO, lead.id), row);
  });

  it('requires quote for invoice and rejects missing or wrong-kind references without partial writes', async () => {
    const bridge = makeBridge(); const refs = await chain(bridge, 'invalid'); const before = await bridge.snapshot(DEMO);
    const base: BridgeCommand = { action: 'bind', idempotencyKey: key('bad-chain'), expectedRevision: before.revision, bindingId: 'binding-invalid', expectedBindingRevision: 0, expectedBindingDigest: null, evidenceRef: 'evidence-invalid', refs };
    for (const [invalidRefs, code] of [
      [{ ...refs, quote: null }, 'BRIDGE_INVALID_CHAIN'],
      [{ ...refs, lead: refs.event }, 'BRIDGE_REFERENCE_KIND_MISMATCH'],
      [{ ...refs, quote: 'missing-source-version' }, 'BRIDGE_REFERENCE_NOT_FOUND'],
      [{ ...refs, invoice: refs.quote }, 'BRIDGE_REFERENCE_KIND_MISMATCH'],
    ] as const) {
      await assert.rejects(bridge.execute(DEMO, { ...base, idempotencyKey: key('invalid-chain'), refs: invalidRefs }), rejectsCode(code));
      assert.deepEqual(await bridge.snapshot(DEMO), before);
    }
  });

  it('rejects a quote identity linked to incompatible chains even through another source version', async () => {
    const bridge = makeBridge(); const firstRefs = await chain(bridge, 'quote-conflict-a'); const secondRefs = await chain(bridge, 'quote-conflict-b');
    await bind(bridge, 'binding-quote-a', firstRefs);
    const existingQuote = (await bridge.snapshot(DEMO)).sourceVersions.find(row => row.id === firstRefs.quote)!;
    const quote2 = await record(bridge, 'quote', 'quote-conflict-a-quote', DEMO, { reference: existingQuote.reference, sourceVersion: 'version-2', contentDigest: digest('conflicting-quote-version') });
    const before = await bridge.snapshot(DEMO);
    await assert.rejects(bind(bridge, 'binding-quote-b', { ...secondRefs, quote: quote2.id }), rejectsCode('BRIDGE_LINK_CONFLICT'));
    assert.deepEqual(await bridge.snapshot(DEMO), before);
  });

  it('rejects an invoice identity linked to another event independently of quote identity', async () => {
    const bridge = makeBridge(); const a = await chain(bridge, 'invoice-conflict-a'); const b = await chain(bridge, 'invoice-conflict-b');
    await bind(bridge, 'binding-invoice-a', a); const before = await bridge.snapshot(DEMO);
    await assert.rejects(bind(bridge, 'binding-invoice-b', { ...b, invoice: a.invoice }), rejectsCode('BRIDGE_LINK_CONFLICT'));
    assert.deepEqual(await bridge.snapshot(DEMO), before);
  });

  it('pins an invoice to one exact quote version across active bindings', async () => {
    const bridge = makeBridge(); const refs = await chain(bridge, 'invoice-quote-version');
    await bind(bridge, 'binding-invoice-quote-v1', refs);
    const quote = (await bridge.snapshot(DEMO)).sourceVersions.find(row => row.id === refs.quote)!;
    const quote2 = await record(bridge, 'quote', 'invoice-quote-version-quote', DEMO, { reference: quote.reference, sourceVersion: 'version-2', contentDigest: digest('invoice-quote-version-2') });
    const before = await bridge.snapshot(DEMO);
    await assert.rejects(bind(bridge, 'binding-invoice-quote-v2', { ...refs, quote: quote2.id }), rejectsCode('BRIDGE_LINK_CONFLICT'));
    assert.deepEqual(await bridge.snapshot(DEMO), before);
  });

  it('preserves multiple compatible bindings but refuses ambiguous resolution', async () => {
    const bridge = makeBridge(); const refs = await chain(bridge, 'ambiguous');
    const a = await bind(bridge, 'binding-compatible-a', refs); const b = await bind(bridge, 'binding-compatible-b', refs);
    await assert.rejects(bridge.resolve(DEMO, refs.lead), rejectsCode('BRIDGE_AMBIGUOUS_LINK'));
    await assert.rejects(bridge.resolve(DEMO, refs.quote!), rejectsCode('BRIDGE_AMBIGUOUS_LINK'));
    assert.deepEqual((await bridge.readBinding(DEMO, a.bindingId, 1)).refs, refs);
    await unlink(bridge, a);
    assert.deepEqual(await bridge.resolve(DEMO, refs.quote!), b);
    await unlink(bridge, b);
    assert.equal(await bridge.resolve(DEMO, refs.quote!), null);
  });

  it('unlinks through an immutable tombstone and reverts as a fresh monotonic revision', async () => {
    const bridge = makeBridge(); const refs = await chain(bridge, 'revert'); const first = await bind(bridge, 'binding-revert', refs);
    const removed = await unlink(bridge, first);
    assert.equal(removed.revision, 2); assert.equal(removed.action, 'unlink'); assert.equal(removed.refs, null); assert.equal(removed.previousDigest, first.digest);
    assert.equal(await bridge.resolve(DEMO, refs.lead), null);
    const command: BridgeCommand = {
      action: 'revert', idempotencyKey: key('revert'), expectedRevision: (await bridge.snapshot(DEMO)).revision,
      bindingId: first.bindingId, expectedBindingRevision: removed.revision, expectedBindingDigest: removed.digest,
      evidenceRef: 'evidence-explicit-reversal', targetRevision: 1,
    };
    const receipt = await bridge.execute(DEMO, command); const restored = binding(receipt.recorded);
    assert.equal(restored.revision, 3); assert.equal(restored.action, 'revert'); assert.equal(restored.targetRevision, 1);
    assert.equal(restored.previousDigest, removed.digest); assert.notEqual(restored.digest, first.digest); assert.deepEqual(restored.refs, refs);
    assert.equal(restored.evidenceRef, 'evidence-explicit-reversal');
    assert.deepEqual(await bridge.readBinding(DEMO, first.bindingId, 1), first);
    assert.deepEqual(await bridge.readBinding(DEMO, first.bindingId, 2), removed);
    assert.deepEqual(await bridge.resolve(DEMO, refs.lead), restored);
    const replay = await bridge.execute(DEMO, command);
    assert.equal(replay.replayed, true); assert.equal(replay.revision, receipt.revision); assert.deepEqual(replay.recorded, receipt.recorded);
  });

  it('rechecks current conflicts on revert and preserves the complete pre-failure state', async () => {
    const bridge = makeBridge(); const a = await chain(bridge, 'revert-conflict-a'); const b = await chain(bridge, 'revert-conflict-b');
    const first = await bind(bridge, 'binding-revert-conflict-a', a); const removed = await unlink(bridge, first);
    await bind(bridge, 'binding-revert-conflict-b', { ...b, quote: a.quote, invoice: a.invoice });
    const before = await bridge.snapshot(DEMO);
    await assert.rejects(bridge.execute(DEMO, {
      action: 'revert', idempotencyKey: key('revert-conflict'), expectedRevision: before.revision,
      bindingId: first.bindingId, expectedBindingRevision: removed.revision, expectedBindingDigest: removed.digest,
      evidenceRef: 'evidence-revert-conflict', targetRevision: 1,
    }), rejectsCode('BRIDGE_LINK_CONFLICT'));
    assert.deepEqual(await bridge.snapshot(DEMO), before);
  });

  it('refuses stale binding revision or digest after an ABA-shaped revert', async () => {
    const bridge = makeBridge(); const refs = await chain(bridge, 'aba'); const first = await bind(bridge, 'binding-aba', refs); const removed = await unlink(bridge, first);
    const restored = binding((await bridge.execute(DEMO, {
      action: 'revert', idempotencyKey: key('aba-revert'), expectedRevision: (await bridge.snapshot(DEMO)).revision,
      bindingId: first.bindingId, expectedBindingRevision: removed.revision, expectedBindingDigest: removed.digest, evidenceRef: 'evidence-aba-revert', targetRevision: 1,
    })).recorded);
    const before = await bridge.snapshot(DEMO);
    for (const [revision, expectedDigest] of [[first.revision, first.digest], [restored.revision, first.digest]] as const) {
      await assert.rejects(bridge.execute(DEMO, {
        action: 'unlink', idempotencyKey: key('stale-aba'), expectedRevision: before.revision,
        bindingId: first.bindingId, expectedBindingRevision: revision, expectedBindingDigest: expectedDigest, evidenceRef: 'evidence-stale-aba',
      }), rejectsCode('BRIDGE_BINDING_CONFLICT'));
      assert.deepEqual(await bridge.snapshot(DEMO), before);
    }
  });
});

describe('canonical bridge authorization, concurrency and detached data', () => {
  it('replays an exact command receipt while rejecting changed bodies and stale new commands', async () => {
    const bridge = makeBridge(); const command = sourceCommand('lead', 'replay', 0);
    const first = await bridge.execute(DEMO, command); await record(bridge, 'event', 'after-replay');
    const before = await bridge.snapshot(DEMO); const replay = await bridge.execute(DEMO, command);
    assert.equal(replay.replayed, true); assert.equal(replay.revision, first.revision); assert.deepEqual(replay.recorded, first.recorded);
    await assert.rejects(bridge.execute(DEMO, { ...command, sourceVersion: 'version-2' }), rejectsCode('BRIDGE_IDEMPOTENCY_CONFLICT'));
    await assert.rejects(bridge.execute(DEMO, { ...command, idempotencyKey: key('stale-new') }), rejectsCode('BRIDGE_REVISION_CONFLICT'));
    assert.deepEqual(await bridge.snapshot(DEMO), before);
  });

  it('isolates organization, actor and partition before reads or idempotency replay', async () => {
    const bridge = makeBridge(); const refs = await chain(bridge, 'scope'); const first = await bind(bridge, 'binding-scope', refs);
    const foreignScopes: BridgeScope[] = [{ ...DEMO, organizationId: 'org-other' }, { ...DEMO, actorId: 'actor-other' }, EXTERNAL];
    for (const scope of foreignScopes) {
      assert.equal((await bridge.snapshot(scope)).sourceVersions.length, 0);
      await assert.rejects(bridge.resolve(scope, refs.lead), rejectsCode('BRIDGE_REFERENCE_NOT_FOUND'));
      await assert.rejects(bridge.readBinding(scope, first.bindingId, 1), rejectsCode('BRIDGE_REFERENCE_NOT_FOUND'));
      await assert.rejects(bind(bridge, first.bindingId, refs, scope), rejectsCode('BRIDGE_REFERENCE_NOT_FOUND'));
      assert.equal((await bridge.snapshot(scope)).revision, 0);
    }
    const command = sourceCommand('lead', 'same-idempotency-key', (await bridge.snapshot(DEMO)).revision);
    const owner = await bridge.execute(DEMO, command);
    const actorScope = { ...DEMO, actorId: 'actor-other' };
    const independent = await bridge.execute(actorScope, { ...command, expectedRevision: 0 });
    assert.equal(independent.replayed, false); assert.equal(sourceVersion(independent.recorded).recordedBy, actorScope.actorId);
    assert.equal(sourceVersion(owner.recorded).recordedBy, DEMO.actorId);
    await assert.rejects(bridge.execute(EXTERNAL, command), rejectsCode('BRIDGE_FORBIDDEN_PARTITION'));
    await assert.rejects(bridge.execute({ ...DEMO, actorId: '' }, command), rejectsCode('BRIDGE_INVALID_SCOPE'));
  });

  it('requires explicitly registered sources and denies demo/external crossover', async () => {
    const bridge = makeBridge();
    await assert.rejects(bridge.execute(DEMO, sourceCommand('lead', 'unknown-source', 0, DEMO, { reference: { sourceSystem: 'unregistered:test', boardId: 'board-test', itemId: 'item-test' } })), rejectsCode('BRIDGE_SOURCE_NOT_ALLOWED'));
    await assert.rejects(bridge.execute(DEMO, sourceCommand('lead', 'external-as-demo', 0, EXTERNAL)), rejectsCode('BRIDGE_FORBIDDEN_PARTITION'));
    await assert.rejects(bridge.execute(EXTERNAL, sourceCommand('lead', 'demo-as-external', 0, DEMO)), rejectsCode('BRIDGE_FORBIDDEN_PARTITION'));
    assert.equal((await bridge.snapshot(DEMO)).revision, 0); assert.equal((await bridge.snapshot(EXTERNAL)).revision, 0);
  });

  it('accepts an unconfigured empty source policy while allowing no source implicitly', async () => {
    const bridge = new CanonicalBridge(new MemoryCanonicalBridgeStore(), { sources: [], clock: () => AT });
    assert.equal((await bridge.snapshot(DEMO)).revision, 0);
    await assert.rejects(bridge.execute(DEMO, sourceCommand('lead', 'unconfigured', 0)), rejectsCode('BRIDGE_SOURCE_NOT_ALLOWED'));
    assert.equal((await bridge.snapshot(DEMO)).revision, 0);
  });

  it('rejects duplicate or contradictory source registrations before using storage', () => {
    const store: CanonicalBridgeStore = {
      async read() { assert.fail('invalid source policy must not read storage'); },
      async compareAndSet() { assert.fail('invalid source policy must not write storage'); },
    };
    for (const policies of [
      [{ sourceSystem: 'fixture:office', partition: 'demo' }, { sourceSystem: 'fixture:office', partition: 'demo' }],
      [{ sourceSystem: 'fixture:office', partition: 'demo' }, { sourceSystem: 'fixture:office', partition: 'external' }],
    ] as const) assert.throws(() => new CanonicalBridge(store, { sources: policies, clock: () => AT }), rejectsCode('BRIDGE_SOURCE_POLICY_INVALID'));
  });

  it('allows only one winner for concurrent commands against an identical revision', async () => {
    const inner = new MemoryCanonicalBridgeStore(); let readCount = 0; let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const store: CanonicalBridgeStore = {
      async read(storageKey) {
        const current = await inner.read(storageKey); const arrival = ++readCount;
        if (arrival <= 2) { if (arrival === 2) release(); await gate; }
        return current;
      },
      compareAndSet: (storageKey, revision, value) => inner.compareAndSet(storageKey, revision, value),
    };
    const bridge = makeBridge(store);
    const results = await Promise.allSettled([bridge.execute(DEMO, sourceCommand('lead', 'race-a', 0)), bridge.execute(DEMO, sourceCommand('lead', 'race-b', 0))]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const rejected = results.find(result => result.status === 'rejected'); assert(rejected?.status === 'rejected');
    assert(rejectsCode('BRIDGE_REVISION_CONFLICT')(rejected.reason));
    const snapshot = await bridge.snapshot(DEMO); assert.equal(snapshot.revision, 1); assert.equal(snapshot.sourceVersions.length, 1);
  });

  it('detaches command inputs, receipts, snapshots and exact binding reads', async () => {
    const bridge = makeBridge(); const command = sourceCommand('lead', 'detached', 0) as Extract<BridgeCommand, { action: 'record_source' }>;
    const receipt = await bridge.execute(DEMO, command); const original = structuredClone(receipt.recorded);
    command.reference.itemId = 'mutated-input'; command.provenance.evidenceRef = 'mutated-evidence';
    sourceVersion(receipt.recorded).reference.itemId = 'mutated-output';
    const snapshot = await bridge.snapshot(DEMO); assert.deepEqual(snapshot.sourceVersions[0], original);
    snapshot.scope.actorId = 'mutated-scope'; snapshot.sourceVersions[0].reference.boardId = 'mutated-board'; snapshot.sourceVersions.length = 0;
    const reread = await bridge.snapshot(DEMO); assert.deepEqual(reread.sourceVersions[0], original); assert.deepEqual(reread.scope, DEMO);
    const refs = await chain(bridge, 'detached-binding'); const first = await bind(bridge, 'binding-detached', refs);
    refs.lead = 'mutated-chain-input'; first.refs!.event = 'mutated-receipt';
    const read = await bridge.readBinding(DEMO, first.bindingId, 1); assert.notEqual(read.refs!.event, 'mutated-receipt');
    read.refs!.quote = 'mutated-read'; assert.notEqual((await bridge.readBinding(DEMO, first.bindingId, 1)).refs!.quote, 'mutated-read');
  });

  it('rejects unknown fields, malformed data and accessors without executing getters', async () => {
    const bridge = makeBridge(); const valid = sourceCommand('lead', 'strict-input', 0);
    let getterReads = 0; const withGetter = { ...valid };
    Object.defineProperty(withGetter, 'kind', { enumerable: true, get() { getterReads++; throw new Error('private-getter-detail'); } });
    const invalidInputs: unknown[] = [null, [], { ...valid, unknown: 'private-extra-field' }, { ...valid, actorId: 'actor-in-body' },
      { ...valid, reference: { sourceSystem: 'fixture:office', boardId: 'board', itemId: 'item', contact: 'synthetic@invalid.test' } },
      { ...valid, provenance: { evidenceRef: 'evidence', observedAtMs: AT, unexpected: true } },
      { ...valid, expectedRevision: -1 }, { ...valid, expectedRevision: 0.5 }, { ...valid, contentDigest: 'not-a-digest' },
      { ...valid, sourceVersion: '' }, { ...valid, sourceVersion: 'x'.repeat(1000) }, withGetter];
    for (const input of invalidInputs) await assert.rejects(bridge.execute(DEMO, input), rejectsCode('BRIDGE_INVALID_COMMAND'));
    assert.equal(getterReads, 0); assert.equal((await bridge.snapshot(DEMO)).revision, 0);
    await assert.rejects(bridge.snapshot({ ...DEMO, injected: 'scope-extra' } as BridgeScope), rejectsCode('BRIDGE_INVALID_SCOPE'));
  });

  it('validates persisted state and sanitizes read and CAS storage failures', async () => {
    const malformed: CanonicalBridgeStore = {
      async read() { return { revision: 1, value: { schemaVersion: 999, private: 'private-corrupt-state' } }; },
      async compareAndSet() { assert.fail('invalid stored state must never be committed'); },
    };
    await assert.rejects(makeBridge(malformed).snapshot(DEMO), rejectsCode('BRIDGE_STATE_INVALID'));
    const failedRead: CanonicalBridgeStore = { async read() { throw new Error('private-store-read-detail'); }, async compareAndSet() { return true; } };
    await assert.rejects(makeBridge(failedRead).snapshot(DEMO), rejectsCode('BRIDGE_STORE_UNAVAILABLE'));
    const failedCas: CanonicalBridgeStore = { async read() { return null; }, async compareAndSet() { throw new Error('private-store-write-detail'); } };
    await assert.rejects(makeBridge(failedCas).execute(DEMO, sourceCommand('lead', 'failed-cas', 0)), rejectsCode('BRIDGE_STORE_UNAVAILABLE'));
  });

  it('rejects invalid clocks before recording any evidence', async () => {
    for (const time of [NaN, Infinity, -1, AT + 0.5]) {
      const store = new MemoryCanonicalBridgeStore(); const bridge = makeBridge(store, () => time);
      await assert.rejects(bridge.execute(DEMO, sourceCommand('lead', 'invalid-clock', 0)), rejectsCode('BRIDGE_INVALID_CLOCK'));
      assert.equal((await makeBridge(store).snapshot(DEMO)).revision, 0);
    }
  });

  it('keeps external bridge metadata separate from DEMO Office state and metrics without network calls', async t => {
    let networkCalls = 0;
    const blocked = () => { networkCalls++; throw new Error('network forbidden in synthetic bridge tests'); };
    t.mock.method(globalThis, 'fetch', blocked); t.mock.method(http, 'request', blocked); t.mock.method(http, 'get', blocked);
    t.mock.method(https, 'request', blocked); t.mock.method(https, 'get', blocked);
    const state = createOfficeFixtureState(AT); const originalState = structuredClone(state); const originalProjection = projectOfficeSnapshot(state, AT);
    const bridge = makeBridge(); const externalRefs = await chain(bridge, 'outside-office', EXTERNAL);
    await bind(bridge, 'binding-external-only', externalRefs, EXTERNAL);
    assert.equal((await bridge.snapshot(DEMO)).sourceVersions.length, 0);
    await assert.rejects(bridge.resolve(DEMO, externalRefs.lead), rejectsCode('BRIDGE_REFERENCE_NOT_FOUND'));
    assert.deepEqual(state, originalState); assert.deepEqual(projectOfficeSnapshot(state, AT), originalProjection);
    assert.equal(originalProjection.outboundEffects, 0); assert.equal(originalProjection.mondayWrites, 0); assert.equal(networkCalls, 0);
  });
});
