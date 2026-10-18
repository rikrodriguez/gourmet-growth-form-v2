import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ExternalProposalPanel } from '../../src/office/dashboard/ExternalProposalPanel';
import { ExternalProposalError, MemoryExternalProposalStore, proposalBridgeScope } from '../../src/office/backend/external-proposal';
import { proposalFixture } from './external-proposal-fixtures';
import { serializeExternalProposalReview, type ExternalProposalCommand } from '../../src/office/external-proposal-contracts';
import { linkCanonicalDocument } from './external-proposal-canonical-fixtures';
const code = (value: string) => (e: unknown) => e instanceof ExternalProposalError && e.code === value;
async function associated() {
  const f = await proposalFixture();
  const view = await f.service.execute(f.targets[0], { action: 'associate', key: 'associate-1', expectedRevision: 0 });
  return { ...f, view };
}
const approval = (f: Awaited<ReturnType<typeof associated>>): ExternalProposalCommand => ({ action: 'approve', key: 'approve-1', expectedRevision: f.view.revision, reviewKey: f.view.snapshot!.reviewKey });

async function fixedDocumentCase() {
  const memory = new MemoryExternalProposalStore(); let recordKey = '';
  const f = await proposalFixture({ read: key => memory.read(key), transact: (key, change) => {
    recordKey = key; return memory.transact(key, change);
  } });
  const target = f.targets[0], authority = f.authorities.get(target.leadId)!;
  const scope = proposalBridgeScope(authority), document = f.documents.get(target.proposalId)!;
  await linkCanonicalDocument(f.bridge, scope, authority.bindingId, document);
  const associate: ExternalProposalCommand = { action: 'associate', key: 'fixed-case-associate', expectedRevision: 0 };
  const associated = await f.service.execute(target, associate);
  const approve: ExternalProposalCommand = { action: 'approve', key: 'fixed-case-approve', expectedRevision: 1, reviewKey: associated.snapshot!.reviewKey };
  const approved = await f.service.execute(target, approve);
  const other = { ...target, proposalId: 'SYNTHETIC-PROPOSAL-SECOND' };
  // Both documents use the same opaque version. Their explicit proposal IDs,
  // rather than a version or shared lead/event, determine case ownership.
  const otherDocument = { ...structuredClone(document), ...other, content: 'SECOND SYNTHETIC DOCUMENT FOR THE SAME LEAD AND EVENT' };
  f.documents.set(other.proposalId, otherDocument);
  return { ...f, memory, target, other, approved, associate, approve, recordKey: () => recordKey,
    linkOther: () => linkCanonicalDocument(f.bridge, scope, authority.bindingId, otherDocument),
    restoreLink: () => linkCanonicalDocument(f.bridge, scope, authority.bindingId, document),
  };
}

for (const operation of ['read', 'associate', 'replay-associate', 'replay-approve'] as const) test(`fixed-case document target rejects ${operation} for another canonically valid proposal without changing history`, async () => {
  const f = await fixedDocumentCase(), before = await f.memory.read(f.recordKey());
  await f.linkOther();
  const attempt = operation === 'read' ? f.service.read(f.other) : f.service.execute(f.other,
    operation === 'associate' ? { action: 'associate', key: 'fixed-case-retarget', expectedRevision: 2 }
      : operation === 'replay-associate' ? f.associate : f.approve);
  await assert.rejects(attempt, code('BINDING_MISMATCH'));
  assert.deepEqual(await f.memory.read(f.recordKey()), before, 'rejected targets must preserve snapshots, approvals and receipts');

  await f.restoreLink();
  const restarted = f.restart(), recovered = await restarted.read(f.target);
  assert.equal(recovered.revision, 2); assert.equal(recovered.status, 'obsolete');
  assert.deepEqual(recovered.snapshot, f.approved.snapshot, 'the original persisted snapshot remains readable after an explicit link revision');
  for (const command of [f.associate, f.approve]) assert.deepEqual(await restarted.execute(f.target, command), recovered);
  assert.deepEqual(await f.memory.read(f.recordKey()), before);
});

test('fixed-case document target serializes concurrent foreign association and receipt retry without contaminating the aggregate', async () => {
  const f = await fixedDocumentCase(), before = await f.memory.read(f.recordKey());
  await f.linkOther();
  const results = await Promise.allSettled([
    f.service.execute(f.other, { action: 'associate', key: 'fixed-case-concurrent-retarget', expectedRevision: 2 }),
    f.restart().execute(f.other, f.associate),
  ]);
  for (const result of results) {
    assert.equal(result.status, 'rejected');
    if (result.status === 'rejected') assert(code('BINDING_MISMATCH')(result.reason));
  }
  assert.deepEqual(await f.memory.read(f.recordKey()), before);
});

for (const field of ['leadId', 'eventId', 'proposalId'] as const) test(`fixed-case document target rejects historical ${field} contamination even when the latest snapshot matches`, async () => {
  const f = await fixedDocumentCase();
  await f.service.execute(f.target, { action: 'associate', key: 'fixed-case-second-association', expectedRevision: 2 });
  // Model an already persisted mixed-target history from the previous service.
  // Keep its latest snapshot valid and the historical review/approval internally
  // consistent, so checking only the latest record or review hash is insufficient.
  await f.memory.transact(f.recordKey(), async current => {
    const record = structuredClone(current)!, snapshot = record.snapshots[0], previousKey = snapshot.reviewKey;
    snapshot[field] = `OTHER-${field}`;
    snapshot.reviewKey = createHash('sha256').update(serializeExternalProposalReview(snapshot)).digest('hex');
    record.approvals.find(item => item.reviewKey === previousKey)!.reviewKey = snapshot.reviewKey;
    assert.equal(record.snapshots.at(-1)![field], f.target[field]);
    return record;
  });
  const before = await f.memory.read(f.recordKey()), restarted = f.restart();
  await assert.rejects(restarted.read(f.target), code('BINDING_MISMATCH'));
  await assert.rejects(restarted.execute(f.target, f.associate), code('BINDING_MISMATCH'));
  await assert.rejects(restarted.execute(f.target, { action: 'associate', key: 'fixed-case-history-append', expectedRevision: 3 }), code('BINDING_MISMATCH'));
  assert.deepEqual(await f.memory.read(f.recordKey()), before);
});

for (const mismatch of ['proposal', 'version', 'hash'] as const) test(`base service rejects a contradictory canonical quote ${mismatch} before association`, async () => {
  const f = await proposalFixture(), target = f.targets[0], a = f.authorities.get(target.leadId)!;
  const document = f.documents.get(target.proposalId)!;
  await linkCanonicalDocument(f.bridge, proposalBridgeScope(a), a.bindingId, document,
    mismatch === 'proposal' ? { proposalId: f.targets[1].proposalId } : mismatch === 'version' ? { sourceVersion: 'v2' } : { contentDigest: 'f'.repeat(64) });
  await assert.rejects(f.service.execute(target, { action: 'associate', key: 'canonical-contradiction', expectedRevision: 0 }),
    code(mismatch === 'proposal' ? 'BINDING_MISMATCH' : mismatch === 'version' ? 'CANONICAL_VERSION_MISMATCH' : 'CANONICAL_CONTENT_MISMATCH'));
  assert.equal((await f.service.read(target)).revision, 0);
});

test('base service reviews matching canonical quote bytes without requiring a provider adapter', async () => {
  const f = await proposalFixture(), target = f.targets[0], a = f.authorities.get(target.leadId)!;
  await linkCanonicalDocument(f.bridge, proposalBridgeScope(a), a.bindingId, f.documents.get(target.proposalId)!);
  const view = await f.service.execute(target, { action: 'associate', key: 'canonical-exact', expectedRevision: 0 });
  const approved = await f.service.execute(target, { action: 'approve', key: 'canonical-approved', expectedRevision: 1, reviewKey: view.snapshot!.reviewKey });
  assert.equal(approved.status, 'approved_internal_unsent'); assert.equal(approved.externalEffectsEnabled, false);
});

test('canonical quote metadata does not turn a missing document into documentary approval', async () => {
  const f = await proposalFixture(), target = f.targets[0], a = f.authorities.get(target.leadId)!;
  const document = f.documents.get(target.proposalId)!;
  await linkCanonicalDocument(f.bridge, proposalBridgeScope(a), a.bindingId, document); document.content = null;
  const view = await f.service.execute(target, { action: 'associate', key: 'canonical-reference', expectedRevision: 0 });
  assert.equal(view.status, 'reference_only'); assert.equal(view.snapshot!.sha256, null);
  await assert.rejects(f.service.execute(target, { action: 'approve', key: 'canonical-no-content', expectedRevision: 1, reviewKey: view.snapshot!.reviewKey }), code('REVIEW_OBSOLETE'));
});

test('exact existing lead/event association preserves provenance and hashes trusted UTF-8 content; no calculated quote is generated', async () => {
  const f = await associated(), s = f.view.snapshot!;
  assert.equal(f.view.status, 'pending_internal_review');
  assert.equal(s.sha256, createHash('sha256').update(f.documents.get(f.targets[0].proposalId)!.content!).digest('hex'));
  assert.equal(s.provenance.itemId, '300'); assert.equal(s.sourceVersion, 'v1');
  assert.equal(s.intendedRecipient, 'client@example.test');
  const approved = await f.service.execute(f.targets[0], approval(f));
  assert.equal(approved.status, 'approved_internal_unsent'); assert.equal(approved.externalEffectsEnabled, false);
  assert.equal((await f.quoteService.read(f.authorities.get(f.targets[0].leadId)!.quote.scope, f.actor, f.targets[0].eventId)).record.quotes.length, 0);
});
test('a URL alone is reference_only and cannot authorize documentary approval', async () => {
  const f = await proposalFixture(); f.documents.get(f.targets[0].proposalId)!.content = null;
  const view = await f.service.execute(f.targets[0], { action: 'associate', key: 'reference', expectedRevision: 0 });
  assert.equal(view.status, 'reference_only'); assert.equal(view.snapshot!.sha256, null);
  assert.ok(!JSON.stringify(view).includes('https://'));
  await assert.rejects(f.service.execute(f.targets[0], { action: 'approve', key: 'ref-approve', expectedRevision: 1, reviewKey: view.snapshot!.reviewKey }), code('REVIEW_OBSOLETE'));
});
test('lead/event/proposal IDs cannot be mixed, including contradictory IDs embedded in a historical link', async () => {
  const f = await proposalFixture(), a = f.targets[0], b = f.targets[1];
  await assert.rejects(f.service.execute({ ...a, eventId: b.eventId }, { action: 'associate', key: 'mixed-event', expectedRevision: 0 }), code('PROVIDER_MISMATCH'));
  await assert.rejects(f.service.execute({ ...a, proposalId: b.proposalId }, { action: 'associate', key: 'mixed-proposal', expectedRevision: 0 }), code('PROVIDER_MISMATCH'));
  f.documents.get(a.proposalId)!.historicalLink.originalUrl = 'https://proposal.example.test/existing?itemId=301&boardId=200';
  await assert.rejects(f.service.execute(a, { action: 'associate', key: 'mixed-link', expectedRevision: 0 }), code('SOURCE_MISMATCH'));
});
for (const field of ['leadId', 'eventId', 'proposalId'] as const) test(`reject unknown ${field} without discovering another case`, async () => {
  const f = await proposalFixture();
  await assert.rejects(f.service.execute({ ...f.targets[0], [field]: 'unknown' }, { action: 'associate', key: 'unknown', expectedRevision: 0 }));
});
test('isolates lead, event, workspace, organization, actor and test/commercial mode', async () => {
  const f = await associated(), a = f.authorities.get(f.targets[0].leadId)!;
  assert.equal((await f.service.read(f.targets[1])).status, 'missing');
  for (const field of ['organizationId', 'workspaceId'] as const) {
    const scope = a.quote.scope; a.quote.scope = { ...scope, [field]: 'other' };
    await assert.rejects(f.service.read(f.targets[0]), code('ACCESS_DENIED')); a.quote.scope = scope;
  }
  const originalActor = a.quote.actor; a.quote.actor = { ...originalActor, actorId: 'other-actor' };
  assert.equal((await f.service.read(f.targets[0])).status, 'missing'); a.quote.actor = originalActor;
  a.quote.scope = { ...a.quote.scope, mode: 'commercial' };
  await assert.rejects(f.service.read(f.targets[0]), code('ACCESS_DENIED'));
});
for (const permission of ['read', 'write', 'approve', 'event', 'lead', 'expiry', 'withdrawn']) test(`existing permission ${permission} fails closed`, async () => {
  const f = await associated(), a = f.authorities.get(f.targets[0].leadId)!;
  if (permission === 'read') a.lead.canRead = false;
  if (permission === 'write') a.quote.actor = { ...a.quote.actor, canWrite: false };
  if (permission === 'approve') a.quote.actor = { ...a.quote.actor, canApprove: false };
  if (permission === 'event') a.eventIds = [];
  if (permission === 'lead') a.lead.leadIds = [];
  if (permission === 'expiry') a.lead.expiresAtMs = 0;
  if (permission === 'withdrawn') f.withdraw();
  await assert.rejects(f.service.execute(f.targets[0], approval(f)), code('ACCESS_DENIED'));
});
test('read-only existing identity can read content but cannot associate or approve', async () => {
  const f = await associated(), a = f.authorities.get(f.targets[0].leadId)!;
  a.quote.actor = { ...a.quote.actor, canWrite: false, canApprove: false };
  assert.equal((await f.service.read(f.targets[0])).canWrite, false);
  await assert.rejects(f.service.execute(f.targets[0], { action: 'associate', key: 'readonly', expectedRevision: 1 }), code('ACCESS_DENIED'));
});
test('a changed document invalidates approval and rejects mutation under the same immutable provider version', async () => {
  const f = await associated(); await f.service.execute(f.targets[0], approval(f));
  const doc = f.documents.get(f.targets[0].proposalId)!; doc.content += '\nChanged';
  const read = await f.service.read(f.targets[0]); assert.equal(read.status, 'obsolete'); assert.equal(read.approval, null);
  await assert.rejects(f.service.execute(f.targets[0], { action: 'associate', key: 'mutate-version', expectedRevision: 2 }), code('VERSION_CONFLICT'));
  doc.sourceVersion = 'v2';
  const v2 = await f.service.execute(f.targets[0], { action: 'associate', key: 'v2', expectedRevision: 2 });
  assert.equal(v2.status, 'pending_internal_review'); assert.notEqual(v2.snapshot!.sha256, f.view.snapshot!.sha256);
  await assert.rejects(f.service.execute(f.targets[0], { action: 'approve', key: 'old-hash', expectedRevision: 3, reviewKey: f.view.snapshot!.reviewKey }), code('REVIEW_OBSOLETE'));
});
test('a new provider version with identical bytes still invalidates approval', async () => {
  const f = await associated(); await f.service.execute(f.targets[0], approval(f));
  f.documents.get(f.targets[0].proposalId)!.sourceVersion = 'v2';
  assert.equal((await f.service.read(f.targets[0])).status, 'obsolete');
});
for (const recipient of ['other@example.test', 'client@example.test']) test(`saved brief/recipient change invalidates approval (${recipient})`, async () => {
  const f = await associated(); await f.service.execute(f.targets[0], approval(f));
  await f.changeBrief(f.targets[0], recipient);
  assert.equal((await f.service.read(f.targets[0])).status, 'obsolete');
  await assert.rejects(f.service.execute(f.targets[0], { action: 'approve', key: 'old-recipient', expectedRevision: 2, reviewKey: f.view.snapshot!.reviewKey }), code('REVIEW_OBSOLETE'));
});
test('canonical link revision invalidates approval even when the same IDs are linked again', async () => {
  const f = await associated(); await f.service.execute(f.targets[0], approval(f));
  const a = f.authorities.get(f.targets[0].leadId)!, scope = proposalBridgeScope(a), s = await f.bridge.snapshot(scope), binding = s.bindings.find(b => b.bindingId === a.bindingId)!;
  await f.bridge.execute(scope, { action: 'bind', idempotencyKey: 'relink', expectedRevision: s.revision, bindingId: a.bindingId, expectedBindingRevision: binding.revision, expectedBindingDigest: binding.digest, evidenceRef: 'relinked-fixture', refs: binding.refs });
  assert.equal((await f.service.read(f.targets[0])).status, 'obsolete');
});
test('reassociation creates a fresh review and never resurrects an older approval', async () => {
  const f = await associated(); await f.service.execute(f.targets[0], approval(f));
  const result = await f.service.execute(f.targets[0], { action: 'associate', key: 'reassociate', expectedRevision: 2 });
  assert.equal(result.status, 'pending_internal_review'); assert.equal(result.approval, null);
  assert.notEqual(result.snapshot!.reviewKey, f.view.snapshot!.reviewKey);
});
test('concurrent exact retries commit once; service restart recovers association and approval; conflicting key is rejected', async () => {
  const f = await proposalFixture(), command: ExternalProposalCommand = { action: 'associate', key: 'retry', expectedRevision: 0 };
  const results = await Promise.all([f.service.execute(f.targets[0], command), f.service.execute(f.targets[0], command)]);
  assert.equal(results[0].revision, 1); assert.equal(results[1].revision, 1);
  const restarted = f.restart(), view = await restarted.read(f.targets[0]);
  assert.equal(view.revision, 1);
  const approve: ExternalProposalCommand = { action: 'approve', key: 'approve-retry', expectedRevision: 1, reviewKey: view.snapshot!.reviewKey };
  await restarted.execute(f.targets[0], approve);
  assert.equal((await f.restart().execute(f.targets[0], approve)).revision, 2);
  assert.equal((await f.restart().read(f.targets[0])).status, 'approved_internal_unsent');
  await assert.rejects(restarted.execute(f.targets[0], { ...command, expectedRevision: 2 }), code('IDEMPOTENCY_CONFLICT'));
});
test('receipt 200 commits, full history permits exact replay after restart and rejects new or conflicting commands without mutation', async () => {
  const memory = new MemoryExternalProposalStore(); let recordKey = '';
  const f = await proposalFixture({ read: key => memory.read(key), transact: (key, change) => {
    recordKey = key; return memory.transact(key, change);
  } });
  const target = f.targets[0], first: ExternalProposalCommand = { action: 'associate', key: 'limit-associate', expectedRevision: 0 };
  const associated = await f.service.execute(target, first);
  for (let revision = 1; revision < 199; revision++) {
    await f.service.execute(target, { action: 'approve', key: `limit-approve-${revision}`, expectedRevision: revision, reviewKey: associated.snapshot!.reviewKey });
  }
  const before = (await memory.read(recordKey))!;
  assert.equal(before.revision, 199); assert.equal(before.receipts.length, 199);
  assert.equal(before.snapshots.length, 1); assert.equal(before.approvals.length, 1);
  const last: ExternalProposalCommand = { action: 'associate', key: 'limit-receipt-200', expectedRevision: 199 };
  const committed = await f.service.execute(target, last), full = (await memory.read(recordKey))!;
  assert.equal(committed.revision, 200); assert.equal(committed.status, 'pending_internal_review');
  assert.equal(full.receipts.length, 200); assert.equal(full.receipts.at(-1)!.key, last.key);
  assert.equal(full.snapshots.length, 2); assert.deepEqual(full.approvals, before.approvals);
  const retries: ExternalProposalCommand[] = [last, first];
  for (const service of [f.service, f.restart()]) {
    assert.deepEqual(await service.read(target), committed);
    for (const retry of retries) {
      assert.deepEqual(await service.execute(target, retry), committed);
      assert.deepEqual(await memory.read(recordKey), full);
    }
    await assert.rejects(service.execute(target, { ...last, expectedRevision: 200 }), code('IDEMPOTENCY_CONFLICT'));
    assert.deepEqual(await memory.read(recordKey), full);
    await assert.rejects(service.execute(target, { action: 'associate', key: 'limit-receipt-201', expectedRevision: 200 }), code('LIMIT'));
    assert.deepEqual(await memory.read(recordKey), full);
  }
});
test('lost post-commit response recovers by explicit read and exact-key retry', async () => {
  const memory = new MemoryExternalProposalStore(); let drop = false;
  const f = await proposalFixture({ read: async key => { if (drop) { drop = false; throw new Error('Lost response'); } return memory.read(key); }, transact: async (key, change) => { await memory.transact(key, change); drop = true; } });
  const command: ExternalProposalCommand = { action: 'associate', key: 'lost-response', expectedRevision: 0 };
  await assert.rejects(f.service.execute(f.targets[0], command));
  assert.equal((await f.restart().read(f.targets[0])).revision, 1);
  await assert.rejects(f.restart().execute(f.targets[0], command));
  assert.equal((await f.restart().read(f.targets[0])).revision, 1);
});
for (const change of ['withdraw', 'expire', 'recipient', 'document']) test(`in-flight ${change} cannot commit stale evidence`, async () => {
  const f = await associated(); let calls = 0;
  f.providerHook(async () => {
    if (++calls !== 1) return;
    if (change === 'withdraw') f.withdraw();
    if (change === 'expire') f.clock(Date.now() + 700_000);
    if (change === 'recipient') await f.changeBrief();
    if (change === 'document') f.documents.get(f.targets[0].proposalId)!.sourceVersion = 'v2';
  });
  await assert.rejects(f.service.execute(f.targets[0], approval(f)));
  f.providerHook(); f.withdraw(false); f.clock(Date.now());
  assert.equal((await f.service.read(f.targets[0])).revision, 1);
});
test('panel SSR is closed and does not query or preview any external source', () => {
  let calls = 0;
  const html = renderToStaticMarkup(<ExternalProposalPanel client={{ async read() { calls++; throw new Error(); }, async execute() { calls++; throw new Error(); } }} target={{ leadId: 'L', eventId: 'E', proposalId: 'P' }} identityKey="test" scope={{ organizationId: 'O', workspaceId: 'W', mode: 'test' }} />);
  assert.equal(calls, 0); assert.doesNotMatch(html, /<iframe|<img|<a |<pre|type="checkbox"/);
  assert.match(html, /Consultar propuesta externa/);
});

for (const change of ['withdraw', 'grant', 'expiry']) test(`store wait reauthorizes ${change} before committing`, async () => {
  const memory = new MemoryExternalProposalStore(); let waiting = () => {};
  const f = await proposalFixture({ read: key => memory.read(key), transact: (key, callback) => memory.transact(key, async row => { waiting(); return callback(row); }) });
  const view = await f.service.execute(f.targets[0], { action: 'associate', key: 'first', expectedRevision: 0 });
  waiting = () => {
    if (change === 'withdraw') f.withdraw();
    if (change === 'grant') f.authorities.get(f.targets[0].leadId)!.quote.actor = { ...f.actor, canApprove: false };
    if (change === 'expiry') f.clock(Date.now() + 700_000);
  };
  await assert.rejects(f.service.execute(f.targets[0], { action: 'approve', key: 'blocked', expectedRevision: 1, reviewKey: view.snapshot!.reviewKey }));
});

test('document changed after the first provider read rolls back approval', async () => {
  const f = await associated(); let reads = 0;
  f.providerHook(async () => { if (++reads === 2) f.documents.get(f.targets[0].proposalId)!.sourceVersion = 'v2'; });
  await assert.rejects(f.service.execute(f.targets[0], approval(f)), code('DOCUMENT_CHANGED'));
  f.providerHook(); assert.equal((await f.service.read(f.targets[0])).revision, 1);
});
