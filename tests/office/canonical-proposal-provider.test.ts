import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createCanonicalProposalDocumentProvider, type CanonicalProposalSelection } from '../../src/office/backend/canonical-proposal-provider';
import { ExternalProposalError, ExternalProposalService, proposalBridgeScope } from '../../src/office/backend/external-proposal';
import { proposalFixture } from './external-proposal-fixtures';
import { durableProposalFixture } from './external-proposal-durable-fixtures';
import { createDurableTestProposalService } from '../../src/office/backend/external-proposal-durable';
import { EventQuoteError } from '../../src/office/backend/event-quote-contracts';

const hash = (content: string) => createHash('sha256').update(content, 'utf8').digest('hex');
const code = (expected: string) => (e: unknown) => e instanceof ExternalProposalError && e.code === expected;
async function fixture() {
  const f = await proposalFixture(), target = f.targets[0], authority = f.authorities.get(target.leadId)!;
  const bridgeScope = proposalBridgeScope(authority), document = f.documents.get(target.proposalId)!;
  document.content = 'abc';
  let state = await f.bridge.snapshot(bridgeScope);
  const receipt = await f.bridge.execute(bridgeScope, { action: 'record_source',
    idempotencyKey: 'canonical-proposal-source', expectedRevision: state.revision, kind: 'quote',
    reference: { sourceSystem: 'fixture:proposal', boardId: 'synthetic-document-board', itemId: target.proposalId },
    sourceVersion: document.sourceVersion, contentDigest: hash(document.content),
    provenance: { evidenceRef: 'synthetic-document-source', observedAtMs: state.bindings.at(-1)!.recordedAtMs },
  });
  assert('id' in receipt.recorded);
  state = await f.bridge.snapshot(bridgeScope);
  const previous = state.bindings.filter(b => b.bindingId === authority.bindingId).at(-1)!;
  await f.bridge.execute(bridgeScope, { action: 'bind', idempotencyKey: 'canonical-document-link', expectedRevision: state.revision,
    bindingId: authority.bindingId, expectedBindingRevision: previous.revision, expectedBindingDigest: previous.digest,
    evidenceRef: 'synthetic-exact-link', refs: { ...previous.refs!, quote: receipt.recorded.id },
  });
  state = await f.bridge.snapshot(bridgeScope);
  const binding = state.bindings.filter(b => b.bindingId === authority.bindingId).at(-1)!;
  const selection: CanonicalProposalSelection = {
    target, scope: authority.quote.scope, bridgeScope, source: authority.source,
    binding: { id: binding.bindingId, revision: binding.revision, digest: binding.digest },
    references: { lead: state.sourceVersions.find(v => v.id === binding.refs!.lead)!.reference,
      event: state.sourceVersions.find(v => v.id === binding.refs!.event)!.reference,
      proposal: receipt.recorded.reference },
  };
  const current: { selection: unknown; reads: number; documentReads: number; hook?: () => Promise<void> } = { selection, reads: 0, documentReads: 0 };
  const owner = { async readExistingLink() { current.reads++; return current.selection; } };
  const expected = { target, scope: authority.quote.scope, bridgeScope, source: authority.source, bindingId: authority.bindingId };
  const provider = createCanonicalProposalDocumentProvider({ bridge: f.bridge, expected, owner, provider: { async read() {
    current.documentReads++; if (current.hook) await current.hook(); return document;
  } } });
  const service = new ExternalProposalService({ bridge: f.bridge, store: f.store, provider,
    async resolveAuthority(t) { return f.authorities.get(t.leadId) ?? null; } });
  return { ...f, target, authority, bridgeScope, document, selection, current, owner, provider, service, binding, expected };
}

test('canonical provider composes with the existing proposal service for the exact immutable quote version', async () => {
  const f = await fixture(), before = await f.bridge.snapshot(f.bridgeScope);
  const view = await f.service.execute(f.target, { action: 'associate', key: 'exact-canonical', expectedRevision: 0 });
  assert.equal(view.snapshot!.sha256, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(view.snapshot!.bindingDigest, f.binding.digest); assert.equal(view.snapshot!.sourceVersion, 'v1');
  assert.equal(view.status, 'pending_internal_review'); assert.equal(view.externalEffectsEnabled, false);
  assert.deepEqual(await f.bridge.snapshot(f.bridgeScope), before); // No implicit registration or rebind.
  assert(f.current.reads >= 2);
});

for (const change of ['lead', 'event', 'proposal', 'source', 'namespace', 'scope', 'revision', 'digest'] as const)
test(`rejects contradictory ${change} selection before reading provider content`, async () => {
  const f = await fixture(), selection = structuredClone(f.selection);
  if (change === 'lead') selection.target.leadId = f.targets[1].leadId;
  if (change === 'event') selection.references.event.itemId = f.targets[1].eventId;
  if (change === 'proposal') selection.references.proposal.itemId = f.targets[1].proposalId;
  if (change === 'source') selection.source.itemId = '301';
  if (change === 'namespace') selection.references.proposal.sourceSystem = 'fixture:other';
  if (change === 'scope') selection.bridgeScope.actorId = 'other-actor';
  if (change === 'revision') selection.binding.revision--;
  if (change === 'digest') selection.binding.digest = 'f'.repeat(64);
  f.current.selection = selection;
  await assert.rejects(f.provider.read(f.target), ExternalProposalError);
  assert.equal(f.current.documentReads, 0);
});

for (const change of ['version', 'content'] as const) test(`rejects a document with obsolete canonical ${change}`, async () => {
  const f = await fixture();
  if (change === 'version') f.document.sourceVersion = 'v2'; else f.document.content = 'changed';
  await assert.rejects(f.service.execute(f.target, { action: 'associate', key: `wrong-${change}`, expectedRevision: 0 }),
    code(change === 'version' ? 'CANONICAL_VERSION_MISMATCH' : 'CANONICAL_CONTENT_MISMATCH'));
  assert.equal((await f.restart().read(f.target)).revision, 0);
});

test('reference_only has no computed hash and cannot receive documentary approval', async () => {
  const f = await fixture(); f.document.content = null;
  const view = await f.service.execute(f.target, { action: 'associate', key: 'reference', expectedRevision: 0 });
  assert.equal(view.status, 'reference_only'); assert.equal(view.snapshot!.sha256, null);
  await assert.rejects(f.service.execute(f.target, { action: 'approve', key: 'no-content', expectedRevision: 1, reviewKey: view.snapshot!.reviewKey }));
});

for (const change of ['withdraw', 'retarget', 'unlink', 'rebind'] as const)
test(`rejects ${change} while provider I/O is pending and preserves proposal state`, async () => {
  const f = await fixture();
  f.current.hook = async () => {
    if (change === 'withdraw') f.current.selection = null;
    if (change === 'retarget') f.current.selection = { ...f.selection, target: f.targets[1] };
    if (change === 'unlink' || change === 'rebind') {
      const state = await f.bridge.snapshot(f.bridgeScope), latest = state.bindings.filter(b => b.bindingId === f.binding.bindingId).at(-1)!;
      await f.bridge.execute(f.bridgeScope, { action: change === 'unlink' ? 'unlink' : 'bind',
        idempotencyKey: 'inflight-link-change', expectedRevision: state.revision, bindingId: latest.bindingId,
        expectedBindingRevision: latest.revision, expectedBindingDigest: latest.digest, evidenceRef: 'synthetic-link-change',
        ...(change === 'rebind' ? { refs: latest.refs! } : {}),
      } as never);
    }
  };
  await assert.rejects(f.service.execute(f.target, { action: 'associate', key: 'no-late-link', expectedRevision: 0 }), ExternalProposalError);
  assert.equal((await f.restart().read(f.target)).revision, 0);
});

test('no owner, missing mapping and source failure fail closed without reading the document', async () => {
  const f = await fixture();
  const missing = createCanonicalProposalDocumentProvider({ bridge: f.bridge, expected: f.expected, provider: f.provider });
  await assert.rejects(missing.read(f.target), code('CANONICAL_LINK_UNCONFIGURED'));
  f.current.selection = null; await assert.rejects(f.provider.read(f.target), code('CANONICAL_LINK_REQUIRED'));
  const failing = createCanonicalProposalDocumentProvider({ bridge: f.bridge, expected: f.expected, owner: { async readExistingLink() { throw new Error('private upstream detail'); } }, provider: f.provider });
  await assert.rejects(failing.read(f.target), code('CANONICAL_LINK_UNAVAILABLE'));
  assert.equal(f.current.documentReads, 0);
});

test('unknown fields and accessors cannot provide authority or execute during snapshotting', async () => {
  const f = await fixture(); let invoked = 0;
  const getter = structuredClone(f.selection); Object.defineProperty(getter.references.proposal, 'itemId', { enumerable: true, get() { invoked++; return f.target.proposalId; } });
  for (const raw of [{ ...f.selection, canApprove: true }, getter, { ...f.selection, scope: { ...f.selection.scope, mode: 'commercial' } }]) {
    f.current.selection = raw; await assert.rejects(f.provider.read(f.target), ExternalProposalError);
  }
  assert.equal(invoked, 0); assert.equal(f.current.documentReads, 0);
});

test('read-only existing authority still cannot associate or approve through the canonical adapter', async () => {
  const f = await fixture(); f.authority.quote.actor = { ...f.authority.quote.actor, canWrite: false, canApprove: false };
  await assert.rejects(f.service.execute(f.target, { action: 'associate', key: 'read-only', expectedRevision: 0 }), code('ACCESS_DENIED'));
  assert.equal(f.current.documentReads, 0);
});

test('canonical adapter is opt-in and normal servers do not install it', async () => {
  for (const file of ['src/office/backend/http.ts', 'src/office/backend/server.ts', 'src/office/backend/staging-app.ts', 'src/office/backend/staging-server.ts']) {
    assert.doesNotMatch(await readFile(file, 'utf8'), /createCanonicalProposalDocumentProvider/);
  }
});

test('a provider outage returns a bounded error without exposing upstream details', async () => {
  const f = await fixture(); f.current.hook = async () => { throw new Error('private upstream detail'); };
  await assert.rejects(f.provider.read(f.target), code('PROVIDER_UNAVAILABLE'));
});

test('a binding with no quote cannot silently select a proposal from another source', async () => {
  const f = await fixture(), state = await f.bridge.snapshot(f.bridgeScope);
  const receipt = await f.bridge.execute(f.bridgeScope, { action: 'bind', idempotencyKey: 'remove-canonical-quote', expectedRevision: state.revision,
    bindingId: f.binding.bindingId, expectedBindingRevision: f.binding.revision, expectedBindingDigest: f.binding.digest,
    evidenceRef: 'synthetic-unlinked-document', refs: { ...f.binding.refs!, quote: null } });
  assert('bindingId' in receipt.recorded);
  f.selection.binding = { id: receipt.recorded.bindingId, revision: receipt.recorded.revision, digest: receipt.recorded.digest };
  await assert.rejects(f.provider.read(f.target), code('CANONICAL_LINK_OBSOLETE')); assert.equal(f.current.documentReads, 0);
});

test('unrelated ledger observations do not invalidate the explicitly selected binding', async () => {
  const f = await fixture(), state = await f.bridge.snapshot(f.bridgeScope);
  await f.bridge.execute(f.bridgeScope, { action: 'record_source', idempotencyKey: 'unrelated-observation', expectedRevision: state.revision,
    kind: 'event', reference: { ...f.selection.references.event, itemId: 'UNRELATED-SYNTHETIC-EVENT' }, sourceVersion: 'v1',
    contentDigest: 'a'.repeat(64), provenance: { evidenceRef: 'synthetic-unrelated-source', observedAtMs: f.binding.recordedAtMs } });
  assert.deepEqual(await f.provider.read(f.target), f.document);
});

test('a valid foreign actor/organization ledger cannot replace the caller canonical context', async () => {
  const f = await fixture(), foreignScope = { ...f.bridgeScope, organizationId: 'other-organization', actorId: 'other-actor' };
  const refs: Record<string, string> = {};
  f.document.content = 'foreign document bytes';
  for (const [kind, reference] of [['lead', f.selection.references.lead], ['event', f.selection.references.event], ['quote', f.selection.references.proposal]] as const) {
    const state = await f.bridge.snapshot(foreignScope);
    const receipt = await f.bridge.execute(foreignScope, { action: 'record_source', idempotencyKey: `foreign-${kind}`, expectedRevision: state.revision,
      kind, reference, sourceVersion: 'v1', contentDigest: hash(f.document.content), provenance: { evidenceRef: `foreign-${kind}`, observedAtMs: f.binding.recordedAtMs } });
    assert('id' in receipt.recorded); refs[kind] = receipt.recorded.id;
  }
  const state = await f.bridge.snapshot(foreignScope);
  const receipt = await f.bridge.execute(foreignScope, { action: 'bind', idempotencyKey: 'foreign-link', expectedRevision: state.revision,
    bindingId: f.selection.binding.id, expectedBindingRevision: 0, expectedBindingDigest: null, evidenceRef: 'foreign-chain',
    refs: { lead: refs.lead, event: refs.event, quote: refs.quote, invoice: null } });
  assert('bindingId' in receipt.recorded);
  f.current.selection = { ...f.selection, bridgeScope: foreignScope,
    binding: { id: receipt.recorded.bindingId, revision: receipt.recorded.revision, digest: receipt.recorded.digest } };
  await assert.rejects(f.service.execute(f.target, { action: 'associate', key: 'foreign-canonical-context', expectedRevision: 0 }), ExternalProposalError);
  assert.equal(f.current.documentReads, 0);
});

test('another valid binding in the same ledger cannot replace the caller selected binding', async () => {
  const f = await fixture(), state = await f.bridge.snapshot(f.bridgeScope);
  const receipt = await f.bridge.execute(f.bridgeScope, { action: 'bind', idempotencyKey: 'alternative-valid-binding', expectedRevision: state.revision,
    bindingId: 'alternative-binding', expectedBindingRevision: 0, expectedBindingDigest: null,
    evidenceRef: 'synthetic-alternative-binding', refs: f.binding.refs! });
  assert('bindingId' in receipt.recorded);
  f.current.selection = { ...f.selection, binding: { id: receipt.recorded.bindingId, revision: receipt.recorded.revision, digest: receipt.recorded.digest } };
  await assert.rejects(f.provider.read(f.target), ExternalProposalError); assert.equal(f.current.documentReads, 0);
});

test('a request for another lead cannot invoke the fixed-case link owner or document reader', async () => {
  const f = await fixture();
  await assert.rejects(f.provider.read(f.targets[1]), ExternalProposalError);
  assert.equal(f.current.reads, 0); assert.equal(f.current.documentReads, 0);
});

test('canonical import uses the existing SQL authorization, encrypted history and idempotent recovery', async () => {
  const f = await durableProposalFixture();
  try {
    const document = { ...structuredClone(f.document), sourceVersion: 'canonical-v2', content: 'abc' };
    let state = await f.bridge.snapshot(f.bridgeScope);
    const receipt = await f.bridge.execute(f.bridgeScope, { action: 'record_source', idempotencyKey: 'durable-canonical-source', expectedRevision: state.revision,
      kind: 'quote', reference: { sourceSystem: 'fixture:proposal', boardId: 'synthetic-document-board', itemId: f.target.proposalId },
      sourceVersion: document.sourceVersion, contentDigest: hash(document.content), provenance: { evidenceRef: 'synthetic-durable-document', observedAtMs: f.at } });
    assert('id' in receipt.recorded);
    state = await f.bridge.snapshot(f.bridgeScope);
    const prior = state.bindings.filter(b => b.bindingId === f.mapping.bindingId).at(-1)!;
    const linked = await f.bridge.execute(f.bridgeScope, { action: 'bind', idempotencyKey: 'durable-canonical-link', expectedRevision: state.revision,
      bindingId: prior.bindingId, expectedBindingRevision: prior.revision, expectedBindingDigest: prior.digest,
      evidenceRef: 'synthetic-durable-chain', refs: { ...prior.refs!, quote: receipt.recorded.id } });
    assert('bindingId' in linked.recorded);
    const selection: CanonicalProposalSelection = { target: f.target, scope: f.scope, bridgeScope: f.bridgeScope, source: f.mapping.source,
      binding: { id: linked.recorded.bindingId, revision: linked.recorded.revision, digest: linked.recorded.digest },
      references: { lead: state.sourceVersions.find(v => v.id === prior.refs!.lead)!.reference,
        event: state.sourceVersions.find(v => v.id === prior.refs!.event)!.reference, proposal: receipt.recorded.reference } };
    let reads = 0;
    const provider = createCanonicalProposalDocumentProvider({ bridge: f.bridge,
      expected: { target: f.target, scope: f.scope, bridgeScope: f.bridgeScope, source: f.mapping.source, bindingId: f.mapping.bindingId },
      owner: { async readExistingLink() { return selection; } },
      provider: { async read() { reads++; return document; } } });
    await f.service.publishFromProvider(f.proof, provider);
    const associated = await f.service.execute(f.proof, { action: 'associate', key: 'canonical-association', expectedRevision: 0 });
    assert.equal(associated.snapshot!.sha256, hash('abc')); assert.equal(associated.snapshot!.sourceVersion, 'canonical-v2');
    const saved = await f.service.history(f.proof), restarted = createDurableTestProposalService(f);
    await restarted.publishFromProvider(f.proof, provider);
    assert.deepEqual(await restarted.history(f.proof), saved); assert.equal(saved!.documents.length, 2); assert.equal(reads, 2);
    document.content = 'altered canonical bytes';
    await assert.rejects(restarted.publishFromProvider(f.proof, provider), (e: unknown) => e instanceof EventQuoteError && e.code === 'CANONICAL_CONTENT_MISMATCH');
    assert.deepEqual(await restarted.history(f.proof), saved);
    await f.pool.query(`UPDATE ${f.accessSchema}.sessions SET revoked_at=now()`);
    const before = reads;
    await assert.rejects(restarted.publishFromProvider(f.proof, provider)); assert.equal(reads, before);
  } finally { await f.close(); }
});
