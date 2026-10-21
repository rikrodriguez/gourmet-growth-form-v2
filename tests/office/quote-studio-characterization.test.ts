import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { ExternalProposalError, MemoryExternalProposalStore, proposalBridgeScope, type SyntheticProposalDocument } from '../../src/office/backend/external-proposal';
import { readProposalDocument } from '../../src/office/backend/external-proposal-provider';
import { EventQuoteError } from '../../src/office/backend/event-quote-contracts';
import { createDurableTestProposalService } from '../../src/office/backend/external-proposal-durable';
import { serializeExternalProposalReview } from '../../src/office/external-proposal-contracts';
import { verifyExternalProposalResponse } from '../../src/office/external-proposal-response';
import { proposalFixture } from './external-proposal-fixtures';
import { durableProposalFixture } from './external-proposal-durable-fixtures';
import { linkCanonicalDocument } from './external-proposal-canonical-fixtures';
import { REPORTED_QUOTE_STUDIO_PAYLOAD_BYTES, syntheticQuoteStudioLoad, syntheticStudioStateText } from './quote-studio-fixtures';

const DOCUMENT_LIMIT = 262_144; // Existing contract, not a changed configuration.
const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const providerMismatch = (error: unknown) => error instanceof ExternalProposalError && error.code === 'PROVIDER_MISMATCH';
async function memoryCase() {
  const store = new MemoryExternalProposalStore(); let key = '';
  const f = await proposalFixture({ read: selected => { key = selected; return store.read(selected); }, transact: (selected, change) => {
    key = selected; return store.transact(selected, change);
  } });
  const target = f.targets[0], authority = f.authorities.get(target.leadId)!, document = structuredClone(f.documents.get(target.proposalId)!);
  return { ...f, target, document, scope: proposalBridgeScope(authority),
    context: { target, scope: document.scope, source: authority.source }, record: () => store.read(key),
    // Intentionally malformed provider outputs, through the existing fixture
    // port. This is not a Quote Studio adapter or an identity/version mapping.
    raw(value: unknown) { f.documents.set(target.proposalId, value as SyntheticProposalDocument); },
  };
}

test('Quote Studio load observations do not constitute a document or review response, even with a shared template projectId', async () => {
  const f = await memoryCase();
  const view = await f.service.execute(f.target, { action: 'associate', key: 'studio-valid-control', expectedRevision: 0 });
  const reviewContext = { target: f.target, identityKey: view.identityKey, scope: view.scope };
  assert.equal((await verifyExternalProposalResponse(view, reviewContext)).contentVerified, true);
  assert.equal(view.status, 'pending_internal_review'); assert.equal(view.approval, null);
  const before = await f.record(), ledger = await f.bridge.snapshot(f.scope);
  const first = syntheticQuoteStudioLoad({ id: f.target.proposalId });
  const other = syntheticQuoteStudioLoad({ id: 'synthetic-other-load', revision: 18 });
  assert.notEqual(first.id, other.id); assert.notEqual(first.revision, other.revision);
  assert.equal(first.state.projectId, other.state.projectId);
  // Every raw envelope fails the document/response schema. These assertions do
  // not pretend that a producer-specific parser validates its inner fields.
  for (const [index, load] of [first, { ...first, ok: false }, { ...first, id: other.id }, { ...first, revision: other.revision }, other].entries()) {
    await assert.rejects(readProposalDocument({ async read() { return load; } }, f.context), providerMismatch);
    await assert.rejects(verifyExternalProposalResponse(load, reviewContext));
    f.raw(load);
    await assert.rejects(f.service.execute(f.target, { action: 'associate', key: `studio-raw-${index}`, expectedRevision: 1 }), providerMismatch);
    await assert.rejects(f.service.execute(f.target, { action: 'approve', key: `studio-raw-approve-${index}`, expectedRevision: 1, reviewKey: view.snapshot!.reviewKey }), providerMismatch);
    assert.deepEqual(await f.record(), before); assert.deepEqual(await f.bridge.snapshot(f.scope), ledger);
  }
  f.raw(f.document);
  assert.equal((await f.restart().read(f.target)).status, 'pending_internal_review');
  assert.equal(before!.approvals.length, 0); assert.equal(before!.receipts.length, 1);
});

test('template identity and numeric producer revisions cannot replace explicit document identity or an opaque canonical version', async () => {
  const f = await memoryCase(), load = syntheticQuoteStudioLoad({ id: f.target.proposalId });
  await linkCanonicalDocument(f.bridge, f.scope, f.authorities.get(f.target.leadId)!.bindingId, f.document);
  const view = await f.service.execute(f.target, { action: 'associate', key: 'studio-version-control', expectedRevision: 0 });
  const before = await f.record(), ledger = await f.bridge.snapshot(f.scope), binding = ledger.bindings.at(-1)!;
  assert.equal(typeof load.revision, 'number'); assert.equal(typeof f.document.sourceVersion, 'string');
  assert.notEqual(load.revision, binding.revision); assert.notEqual(load.revision, view.revision);
  for (const proposalId of [load.state.projectId, 'synthetic-foreign-document']) {
    const raw = { ...f.document, proposalId };
    await assert.rejects(readProposalDocument({ async read() { return raw; } }, f.context), providerMismatch);
    f.raw(raw);
    await assert.rejects(f.service.execute(f.target, { action: 'associate', key: `studio-id-${proposalId}`, expectedRevision: 1 }), providerMismatch);
  }
  const numeric = { ...f.document, sourceVersion: load.revision };
  await assert.rejects(readProposalDocument({ async read() { return numeric; } }, f.context), providerMismatch);
  // An explicitly synthetic opaque label is syntactically valid but is not
  // the version selected by this fixture's canonical quote. No conversion from
  // the producer revision to a real document version is implemented or assumed.
  const wrongVersion = { ...f.document, sourceVersion: 'synthetic-unmapped-version' };
  assert.equal((await readProposalDocument({ async read() { return wrongVersion; } }, f.context)).document.sourceVersion, wrongVersion.sourceVersion);
  f.raw(wrongVersion);
  await assert.rejects(f.service.execute(f.target, { action: 'associate', key: 'studio-unmapped-version', expectedRevision: 1 }),
    error => error instanceof ExternalProposalError && error.code === 'CANONICAL_VERSION_MISMATCH');
  assert.deepEqual(await f.record(), before); assert.deepEqual(await f.bridge.snapshot(f.scope), ledger);
});

test('exact UTF-8 documentary boundary accepts 262144 bytes while 262145 and the reported-size vector stay ineligible', async () => {
  const f = await memoryCase(), content = syntheticStudioStateText(DOCUMENT_LIMIT);
  assert.equal(Buffer.byteLength(content, 'utf8'), DOCUMENT_LIMIT); assert(content.length < DOCUMENT_LIMIT);
  const valid = { ...f.document, content };
  const verified = await readProposalDocument({ async read() { return valid; } }, f.context);
  assert.equal(verified.sha256, hash(content)); assert.equal(verified.referenceOnly, false);
  f.raw(valid);
  const view = await f.service.execute(f.target, { action: 'associate', key: 'studio-boundary-control', expectedRevision: 0 });
  const context = { target: f.target, identityKey: view.identityKey, scope: view.scope };
  assert.equal((await verifyExternalProposalResponse(view, context)).contentVerified, true);
  assert.equal(view.status, 'pending_internal_review'); assert.equal(view.approval, null);
  const before = await f.record(), ledger = await f.bridge.snapshot(f.scope);
  for (const bytes of [DOCUMENT_LIMIT + 1, REPORTED_QUOTE_STUDIO_PAYLOAD_BYTES]) {
    const text = syntheticStudioStateText(bytes);
    assert.equal(Buffer.byteLength(text, 'utf8'), bytes); assert(text.length < bytes);
    const oversized = { ...f.document, content: text };
    await assert.rejects(readProposalDocument({ async read() { return oversized; } }, f.context), providerMismatch);
    f.raw(oversized);
    await assert.rejects(f.service.execute(f.target, { action: 'associate', key: `studio-oversize-${bytes}`, expectedRevision: 1 }), providerMismatch);
    await assert.rejects(f.service.execute(f.target, { action: 'approve', key: `studio-oversize-approve-${bytes}`, expectedRevision: 1, reviewKey: view.snapshot!.reviewKey }), providerMismatch);
    // Even rehashing the oversized transport payload cannot bypass the browser
    // guard: all hashes match, while the independent byte-size limit rejects.
    const response = structuredClone(view), snapshot = response.snapshot!;
    snapshot.content = text; snapshot.sha256 = hash(text); snapshot.reviewKey = hash(serializeExternalProposalReview(snapshot));
    await assert.rejects(verifyExternalProposalResponse(response, context));
    assert.deepEqual(await f.record(), before); assert.deepEqual(await f.bridge.snapshot(f.scope), ledger);
  }
});

test('durable imports reject raw loads and oversized proposed content without changing encrypted state, reviews or the canonical ledger', async () => {
  const f = await durableProposalFixture();
  try {
    const ledger = await f.bridge.snapshot(f.bridgeScope), initial = (await f.service.history(f.proof))!;
    // A small existing-contract document succeeds through the same import port;
    // this explicit fixture version is unrelated to a producer revision.
    const control = { ...f.document, sourceVersion: 'synthetic-studio-control', content: 'Small explicit synthetic document, not a Quote Studio export.' };
    await f.service.publishFromProvider(f.proof, { async read() { return control; } });
    const imported = (await f.service.history(f.proof))!;
    assert.equal(imported.documents.length, initial.documents.length + 1); assert.equal(imported.revision, initial.revision + 1);
    assert.equal(imported.record, null); assert.deepEqual(await f.bridge.snapshot(f.bridgeScope), ledger);
    const view = await f.service.execute(f.proof, { action: 'associate', key: 'studio-pg-associate', expectedRevision: 0 });
    assert.equal(view.status, 'pending_internal_review'); assert.equal(view.approval, null);
    const approved = await f.service.execute(f.proof, { action: 'approve', key: 'studio-pg-explicit-approval', expectedRevision: 1, reviewKey: view.snapshot!.reviewKey });
    assert.equal(approved.status, 'approved_internal_unsent'); assert.equal(approved.externalEffectsEnabled, false);
    const before = await f.service.history(f.proof);
    const sqlState = async () => ({
      events: (await f.pool.query(`SELECT * FROM ${f.proposalSchema}.events ORDER BY key`)).rows,
      audit: (await f.pool.query(`SELECT * FROM ${f.proposalSchema}.audit_events ORDER BY event_key,revision`)).rows,
    });
    const saved = await sqlState(), load = syntheticQuoteStudioLoad({ id: f.target.proposalId });
    const attempts: unknown[] = [load, { ...load, ok: false }, { ...load, id: 'synthetic-foreign-load' }, { ...load, revision: load.revision + 1 },
      ...[DOCUMENT_LIMIT + 1, REPORTED_QUOTE_STUDIO_PAYLOAD_BYTES].map(bytes => ({ ...control, sourceVersion: `synthetic-size-${bytes}`, content: syntheticStudioStateText(bytes) }))];
    for (const output of attempts) {
      await assert.rejects(f.service.publishFromProvider(f.proof, { async read() { return output; } }),
        error => error instanceof EventQuoteError && error.code === 'PROVIDER_MISMATCH');
      assert.deepEqual(await f.service.history(f.proof), before); assert.deepEqual(await sqlState(), saved);
      assert.deepEqual(await f.bridge.snapshot(f.bridgeScope), ledger);
    }
    assert.equal(before!.record!.approvals.length, 1); assert.equal(before!.record!.receipts.length, 2);
    assert.deepEqual((await f.service.read(f.proof)).approval, approved.approval);
    console.log('QUOTE_STUDIO_CHARACTERIZATION_EVIDENCE=' + JSON.stringify({ reportedSizeVectorBytes: REPORTED_QUOTE_STUDIO_PAYLOAD_BYTES,
      documentaryLimitBytes: DOCUMENT_LIMIT, rejectedImports: attempts.length, preservedReceipts: before!.record!.receipts.length,
      preservedApprovals: before!.record!.approvals.length, preservedAudit: saved.audit.length, syntheticOnly: true }));
  } finally { await f.close(); }
});

test('an imported 262144-byte document cannot append a review beyond the 524288-byte durable aggregate cap', async () => {
  const f = await durableProposalFixture();
  try {
    const associated = await f.service.execute(f.proof, { action: 'associate', key: 'studio-cap-small-associate', expectedRevision: 0 });
    const oldApproval = { action: 'approve' as const, key: 'studio-cap-small-approved', expectedRevision: 1, reviewKey: associated.snapshot!.reviewKey };
    await f.service.execute(f.proof, oldApproval);
    const historical = (await f.service.history(f.proof))!;
    const document = { ...f.document, sourceVersion: 'synthetic-studio-cap-vector', content: syntheticStudioStateText(DOCUMENT_LIMIT) };
    assert.equal(Buffer.byteLength(document.content, 'utf8'), DOCUMENT_LIMIT);
    // This is synthetic text, not a producer export. It passes the document
    // limit; durable association must also fit the separate aggregate limit.
    const context = { target: f.target, scope: f.scope, source: f.mapping.source };
    assert.equal((await readProposalDocument({ async read() { return document; } }, context)).sha256, hash(document.content));
    await f.service.publishFromProvider(f.proof, { async read() { return document; } });
    const imported = (await f.service.history(f.proof))!;
    assert.equal(imported.revision, historical.revision + 1);
    assert.equal(imported.documents.length, historical.documents.length + 1);
    assert.deepEqual(imported.documents.at(-1), document); assert.deepEqual(imported.record, historical.record);
    const aggregateLimit = 524_288, importedBytes = Buffer.byteLength(JSON.stringify(imported), 'utf8');
    assert(importedBytes < aggregateLimit);
    assert(importedBytes + DOCUMENT_LIMIT > aggregateLimit, 'duplicating the content alone already exceeds the aggregate cap');
    const sqlState = async () => ({
      events: (await f.pool.query(`SELECT * FROM ${f.proposalSchema}.events ORDER BY key`)).rows,
      audit: (await f.pool.query(`SELECT * FROM ${f.proposalSchema}.audit_events ORDER BY event_key,revision`)).rows,
    });
    const saved = await sqlState(), ledger = await f.bridge.snapshot(f.bridgeScope);
    const command = { action: 'associate' as const, key: 'studio-cap-large-associate', expectedRevision: imported.record!.revision };
    const full = (error: unknown) => error instanceof EventQuoteError && error.code === 'PROPOSAL_STORE_INVALID' && error.status === 409;
    await assert.rejects(f.service.execute(f.proof, command), full);
    const recovered = createDurableTestProposalService(f);
    const unchanged = async () => {
      assert.deepEqual(await recovered.history(f.proof), imported); assert.deepEqual(await sqlState(), saved);
      assert.deepEqual(await f.bridge.snapshot(f.bridgeScope), ledger);
    };
    await unchanged();
    await assert.rejects(recovered.execute(f.proof, command), full); await unchanged();
    const replay = await recovered.execute(f.proof, oldApproval);
    assert.equal(replay.status, 'obsolete'); assert.equal(replay.approval, null);
    assert.deepEqual(replay.snapshot, associated.snapshot); await unchanged();
    await recovered.publishFromProvider(f.proof, { async read() { return document; } }); await unchanged();
    assert.equal(imported.record!.approvals.length, 1); assert.equal(imported.record!.receipts.length, 2);
    assert.equal(imported.record!.receipts.some(receipt => receipt.key === command.key), false);
    console.log('QUOTE_STUDIO_AGGREGATE_CAP_EVIDENCE=' + JSON.stringify({ contentBytes: DOCUMENT_LIMIT, importedAggregateBytes: importedBytes,
      aggregateLimitBytes: aggregateLimit, error: 'PROPOSAL_STORE_INVALID', statusCode: 409,
      preservedReceipts: imported.record!.receipts.length, preservedApprovals: imported.record!.approvals.length, preservedAudit: saved.audit.length, recovered: true, syntheticOnly: true }));
  } finally { await f.close(); }
});
