import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { serializeExternalProposalReview, type ExternalProposalSnapshot } from '../../src/office/external-proposal-contracts';
import { verifyExternalProposalResponse } from '../../src/office/external-proposal-response';
import { proposalFixture } from './external-proposal-fixtures';
async function setup() {
  const fixture = await proposalFixture(), target = fixture.targets[0];
  const view = await fixture.service.execute(target, { action: 'associate', key: 'review-associate', expectedRevision: 0 });
  return { fixture, target, view, context: { target, identityKey: view.identityKey, scope: view.scope } };
}
const mutations: [string, (s: ExternalProposalSnapshot) => void][] = [
  ['intendedRecipient', s => { s.intendedRecipient = 'shown-to-reviewer@example.test'; }],
  ['sourceVersion', s => { s.sourceVersion = 'v900'; }],
  ['provenance.accountId', s => { s.provenance.accountId = 'another-account'; }],
  ['provenance.boardId', s => { s.provenance.boardId = 'another-board'; }],
  ['provenance.itemId', s => { s.provenance.itemId = 'another-item'; }],
  ['provenance.observedAt', s => { s.provenance.observedAt = '2026-01-01T00:00:00.000Z'; }],
  ['provenance.evidenceRef', s => { s.provenance.evidenceRef = 'other-evidence'; }],
  ['briefDigest', s => { s.briefDigest = '0'.repeat(64); }],
  ['bindingDigest', s => { s.bindingDigest = '0'.repeat(64); }],
  ['associationRevision', s => { s.associationRevision++; }],
  ['content', s => { s.content += '\nAltered bytes'; }],
  ['sha256', s => { s.sha256 = '0'.repeat(64); }],
  ['reviewKey', s => { s.reviewKey = '0'.repeat(64); }],
];
for (const [field, mutate] of mutations) test(`review rejects altered ${field} with the original trusted reviewKey`, async () => {
  const { view, context } = await setup();
  const original = structuredClone(view); mutate(view.snapshot!);
  if (field !== 'reviewKey') assert.equal(view.snapshot!.reviewKey, original.snapshot!.reviewKey);
  if (field !== 'content') assert.equal(view.snapshot!.content, original.snapshot!.content);
  await assert.rejects(verifyExternalProposalResponse(view, context));
});
test('valid service snapshots use the same canonical bytes and remain valid after transport key reordering', async () => {
  const { fixture, target, view, context } = await setup();
  const { reviewKey, ...legacyBody } = view.snapshot!;
  assert.equal(serializeExternalProposalReview(view.snapshot!), JSON.stringify(legacyBody));
  assert.equal(createHash('sha256').update(serializeExternalProposalReview(view.snapshot!)).digest('hex'), reviewKey);
  const reordered = JSON.parse(JSON.stringify(view, (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).reverse()) : value));
  const verified = await verifyExternalProposalResponse(reordered, context);
  assert.equal(verified.contentVerified, true); assert.deepEqual(verified.view, view); assert.notEqual(verified.view, reordered);
  assert.notEqual(verified.view.snapshot, reordered.snapshot); assert.notEqual(verified.view.snapshot!.provenance, reordered.snapshot.provenance);
  const approved = await fixture.service.execute(target, { action: 'approve', key: 'valid-approval', expectedRevision: view.revision, reviewKey });
  assert.equal((await verifyExternalProposalResponse(approved, context)).view.status, 'approved_internal_unsent');
});
test('a rehashed metadata substitution cannot approve against the trusted service snapshot', async () => {
  const { fixture, target, view, context } = await setup();
  view.snapshot!.intendedRecipient = 'rehashed@example.test';
  view.snapshot!.reviewKey = createHash('sha256').update(serializeExternalProposalReview(view.snapshot!)).digest('hex');
  assert.equal((await verifyExternalProposalResponse(view, context)).contentVerified, true);
  await assert.rejects(fixture.service.execute(target, { action: 'approve', key: 'forged-review-key', expectedRevision: view.revision, reviewKey: view.snapshot!.reviewKey }));
  assert.equal((await fixture.service.read(target)).status, 'pending_internal_review');
});
test('content digest is verified independently even if the complete altered snapshot is rehashed', async () => {
  const { view, context } = await setup(); view.snapshot!.content += '\nChanged';
  view.snapshot!.reviewKey = createHash('sha256').update(serializeExternalProposalReview(view.snapshot!)).digest('hex');
  await assert.rejects(verifyExternalProposalResponse(view, context));
});
test('reference_only validates its complete reviewKey and remains ineligible for content review', async () => {
  const fixture = await proposalFixture(), target = fixture.targets[0]; fixture.documents.get(target.proposalId)!.content = null;
  const view = await fixture.service.execute(target, { action: 'associate', key: 'reference', expectedRevision: 0 });
  const context = { target, identityKey: view.identityKey, scope: view.scope };
  assert.equal((await verifyExternalProposalResponse(view, context)).contentVerified, false);
  view.snapshot!.intendedRecipient = 'other@example.test';
  await assert.rejects(verifyExternalProposalResponse(view, context));
});
test('missing and obsolete responses retain their valid schema without granting review', async () => {
  const fixture = await proposalFixture(), target = fixture.targets[0];
  const missing = await fixture.service.read(target), context = { target, identityKey: missing.identityKey, scope: missing.scope };
  assert.equal((await verifyExternalProposalResponse(missing, context)).contentVerified, false);
  await fixture.service.execute(target, { action: 'associate', key: 'associate', expectedRevision: 0 });
  await fixture.changeBrief(target);
  const obsolete = await fixture.service.read(target);
  assert.equal((await verifyExternalProposalResponse(obsolete, context)).view.status, 'obsolete');
});
for (const [name, mutate] of [
  ['extra view field', (v: any) => { v.extra = 'unreviewed'; }],
  ['missing view field', (v: any) => { delete v.canWrite; }],
  ['nonboolean permission', (v: any) => { v.canApprove = 'true'; }],
  ['impossible permission', (v: any) => { v.canWrite = false; }],
  ['invalid revision', (v: any) => { v.revision = NaN; }],
  ['expired response', (v: any) => { v.expiresAtMs = 0; }],
  ['unknown status', (v: any) => { v.status = 'accepted'; }],
  ['approval without decision', (v: any) => { v.status = 'approved_internal_unsent'; }],
  ['unknown scope key', (v: any) => { v.scope.extra = 'scope'; }],
  ['commercial scope', (v: any) => { v.scope.mode = 'commercial'; }],
  ['extra snapshot field', (v: any) => { v.snapshot.extra = 'unhashed'; }],
  ['missing snapshot field', (v: any) => { delete v.snapshot.briefDigest; }],
  ['array snapshot', (v: any) => { v.snapshot = []; }],
  ['invalid provider', (v: any) => { v.snapshot.provider = 'other'; }],
  ['invalid version type', (v: any) => { v.snapshot.sourceVersion = 2; }],
  ['invalid recipient type', (v: any) => { v.snapshot.intendedRecipient = null; }],
  ['unknown provenance field', (v: any) => { v.snapshot.provenance.extra = 'unhashed'; }],
  ['invalid observation date', (v: any) => { v.snapshot.provenance.observedAt = '2026-02-30T00:00:00.000Z'; }],
  ['malformed digest', (v: any) => { v.snapshot.bindingDigest = 'bad'; }],
  ['unpaired content/hash', (v: any) => { v.snapshot.content = null; }],
  ['invalid association revision', (v: any) => { v.snapshot.associationRevision = 0; }],
  ['unknown approval field', (v: any) => { v.approval = { reviewKey: v.snapshot.reviewKey, actorId: 'test', atMs: Date.now(), status: 'approved_internal_unsent', extra: true }; }],
] as const) test(`review rejects schema violation: ${name}`, async () => {
  const { view, context } = await setup(); mutate(view);
  await assert.rejects(verifyExternalProposalResponse(view, context));
});
test('schema validation never invokes response accessors', async () => {
  const { view, context } = await setup(); let accessed = false;
  Object.defineProperty(view.snapshot!, 'intendedRecipient', { enumerable: true, get() { accessed = true; return 'bad@example.test'; } });
  await assert.rejects(verifyExternalProposalResponse(view, context)); assert.equal(accessed, false);
});
test('a late adapter mutation cannot replace what was verified and returned for display', async t => {
  const { view, context } = await setup(), original = structuredClone(view);
  const realDigest = crypto.subtle.digest.bind(crypto.subtle); let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(crypto.subtle, 'digest', async (algorithm: AlgorithmIdentifier, bytes: BufferSource) => { await gate; return realDigest(algorithm, bytes); });
  const pending = verifyExternalProposalResponse(view, context);
  view.snapshot!.intendedRecipient = 'late-adapter@example.test'; view.snapshot!.provenance.evidenceRef = 'changed-after-validation';
  release(); const verified = await pending;
  assert.deepEqual(verified.view, original); assert.equal(verified.contentVerified, true);
});
