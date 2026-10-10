import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DraftError,
  createQuoteDraft,
  reviseQuoteDraft,
  createPageSpec,
  createPaymentRequestDraft,
  prepareMessageDraft,
  reviseMessageDraft,
  reviewMessageDraft,
  approveMessageDraft,
  verifyApproval,
} from '../../src/operations/drafts.mjs';

// Only synthetic fixtures. No HTTP clients, database, environment credentials,
// customer records, invoice provider, messaging worker, or generated URLs.
const NOW = 1_800_000_000_000;
const clock = () => ({ nowMs: NOW });
const empty = () => ({ leads: {}, closers: {}, assignments: {}, callEvents: {}, payments: {}, invoices: {}, exceptions: {} });
const quoteInput = (overrides = {}) => ({
  draftId: 'quote-fixture-1', gourmetEventId: 'event-fixture-1', actorId: 'office-demo-operator-fixture',
  currency: 'USD', catalogVersion: 'catalog-synthetic-v1',
  lines: [{ catalogItemId: 'meal-fixture', label: 'Synthetic meal', qty: 3, unitPriceCents: 101 }],
  taxBps: 500, depositBps: 5000, ...overrides,
});
const refInput = (draftId, overrides = {}) => ({
  draftId, gourmetEventId: 'event-fixture-1', actorId: 'office-demo-operator-fixture',
  quoteDraftId: 'quote-fixture-1', quoteRevision: 1, ...overrides,
});
const messageInput = (overrides = {}) => ({
  draftId: 'message-fixture-1', gourmetEventId: 'event-fixture-1', actorId: 'office-demo-operator-fixture',
  channel: 'email', recipient: 'client-fixture@example.invalid',
  text: 'Synthetic text for local review only. Total: USD 3.18.',
  artifactRefs: [{ draftId: 'quote-fixture-1', revision: 1 }], ...overrides,
});
function assertError(code, operation) {
  assert.throws(operation, error => error instanceof DraftError && error.code === code);
}
function approve(state, approvalId = 'approval-fixture-1', draftId = 'message-fixture-1', revision = 1) {
  const reviewed = reviewMessageDraft(state, { draftId, revision });
  return approveMessageDraft(state, { approvalId, draftId, revision, reviewDigest: reviewed.reviewDigest }, {
    nowMs: NOW + 1000, simulation: true, explicitApproval: true, authenticatedActorId: 'office-demo-operator-fixture',
  });
}

test('server computes cents with BigInt and half-up rounding', () => {
  const state = empty();
  const quote = createQuoteDraft(state, quoteInput(), clock());
  assert.equal(quote.subtotalCents, 303);
  assert.equal(quote.taxCents, 15);
  assert.equal(quote.totalCents, 318);
  assert.equal(quote.depositCents, 159);
  assert.equal(quote.status, 'pending_approval');
  const half = createQuoteDraft(state, quoteInput({ draftId: 'quote-half', lines: [{ catalogItemId: 'half', label: 'Half fixture', qty: 1, unitPriceCents: 1 }], taxBps: 5000, depositBps: 2500 }), clock());
  assert.equal(half.taxCents, 1);
  assert.equal(half.totalCents, 2);
  assert.equal(half.depositCents, 1);
});

test('quote upper bound is checked before converting BigInt to Number', () => {
  const state = empty();
  const line = { catalogItemId: 'large', label: 'Large synthetic line', qty: 1000, unitPriceCents: 1_000_000 };
  assert.equal(createQuoteDraft(state, quoteInput({ lines: [line], taxBps: 0 }), clock()).totalCents, 1_000_000_000);
  assertError('quote_total_limit', () => createQuoteDraft(state, quoteInput({ draftId: 'too-large', lines: [line], taxBps: 1 }), clock()));
  assertError('quote_total_limit', () => createQuoteDraft(state, quoteInput({ draftId: 'too-many-dollars', lines: [line, line], taxBps: 0 }), clock()));
});

for (const [name, field, invalid] of [
  ['negative money', 'unitPriceCents', -1], ['fractional money', 'unitPriceCents', 100.5],
  ['boolean money', 'unitPriceCents', true], ['string money', 'unitPriceCents', '100'],
  ['infinite money', 'unitPriceCents', Infinity], ['NaN money', 'unitPriceCents', NaN],
  ['too-large unit price', 'unitPriceCents', 1_000_001], ['zero quantity', 'qty', 0],
  ['fractional quantity', 'qty', 1.1], ['boolean quantity', 'qty', true], ['quantity over limit', 'qty', 1001],
]) {
  test(`rejects ${name} without creating a draft`, () => {
    const state = empty();
    const input = quoteInput();
    input.lines[0][field] = invalid;
    assertError('invalid_integer', () => createQuoteDraft(state, input, clock()));
    assert.equal(state.drafts, undefined);
  });
}

test('strict payload rejects unknown keys, accessors, unsafe ids and long text', () => {
  const state = empty();
  assertError('unknown_field', () => createQuoteDraft(state, quoteInput({ role: 'admin' }), clock()));
  assertError('unknown_field', () => createQuoteDraft(state, quoteInput({ totalCents: 5 }), clock()));
  const accessor = quoteInput();
  Object.defineProperty(accessor, 'actorId', { get() { throw new Error('must not read accessor'); }, enumerable: true });
  assertError('invalid_object', () => createQuoteDraft(state, accessor, clock()));
  assertError('invalid_id', () => createQuoteDraft(state, quoteInput({ draftId: '__proto__' }), clock()));
  assertError('invalid_id', () => createQuoteDraft(state, quoteInput({ actorId: 'x'.repeat(101) }), clock()));
  assertError('invalid_string', () => createQuoteDraft(state, quoteInput({ lines: [{ catalogItemId: 'item', label: 'x'.repeat(101), qty: 1, unitPriceCents: 1 }] }), clock()));
  assertError('invalid_lines', () => createQuoteDraft(state, quoteInput({ lines: Array.from({ length: 101 }, () => ({ catalogItemId: 'item', label: 'Fixture', qty: 1, unitPriceCents: 1 })) }), clock()));
  assertError('invalid_integer', () => createQuoteDraft(state, quoteInput({ taxBps: 10001 }), clock()));
  assertError('invalid_integer', () => createQuoteDraft(state, quoteInput({ depositBps: -1 }), clock()));
  assertError('unsupported_currency', () => createQuoteDraft(state, quoteInput({ currency: 'EUR' }), clock()));
  assertError('invalid_timestamp', () => createQuoteDraft(state, quoteInput(), { nowMs: true }));
  assert.equal(state.drafts, undefined);
});

test('same id/content is idempotent and conflicting payload is rejected', () => {
  const state = empty();
  const first = createQuoteDraft(state, quoteInput(), clock());
  const reordered = Object.fromEntries(Object.entries(quoteInput()).reverse());
  assert.strictEqual(createQuoteDraft(state, reordered, { nowMs: NOW + 1 }), first);
  assertError('draft_id_conflict', () => createQuoteDraft(state, quoteInput({ taxBps: 501 }), clock()));
  assert.equal(Object.keys(state.drafts).length, 1);
  assert.equal(state.drafts[first.draftId].currentRevision, 1);
});

test('quote revision is explicit, immutable and idempotent', () => {
  const state = empty();
  const original = createQuoteDraft(state, quoteInput(), clock());
  assert.ok(Object.isFrozen(original));
  assert.ok(Object.isFrozen(original.lines[0]));
  assert.throws(() => { original.lines[0].qty = 99; }, TypeError);
  const input = quoteInput({ expectedRevision: 1, taxBps: 1000 });
  const next = reviseQuoteDraft(state, input, { nowMs: NOW + 2 });
  assert.equal(next.revision, 2);
  assert.equal(original.taxBps, 500);
  assert.equal(state.drafts[original.draftId].revisions[1].totalCents, 318);
  assert.strictEqual(reviseQuoteDraft(state, input, { nowMs: NOW + 3 }), next);
  assertError('revision_conflict', () => reviseQuoteDraft(state, { ...input, taxBps: 1001 }, clock()));
  assertError('cross_event_reference', () => reviseQuoteDraft(state, { ...input, gourmetEventId: 'different-event' }, clock()));
});

test('page specs are same-event, exact-revision and stay blocked with no HTML or URL', () => {
  const state = empty();
  createQuoteDraft(state, quoteInput(), clock());
  const page = createPageSpec(state, refInput('page-fixture-1'), clock());
  assert.equal(page.rendererStatus, 'blocked_missing_generator');
  assert.equal(page.html, null);
  assert.equal(page.url, null);
  assert.strictEqual(createPageSpec(state, refInput('page-fixture-1'), clock()), page);
  assertError('cross_event_reference', () => createPageSpec(state, refInput('page-other', { gourmetEventId: 'other-event' }), clock()));
  assertError('reference_not_found', () => createPageSpec(state, refInput('page-missing', { quoteDraftId: 'unknown' }), clock()));
  reviseQuoteDraft(state, quoteInput({ expectedRevision: 1, taxBps: 600 }), clock());
  assertError('stale_reference', () => createPageSpec(state, refInput('page-stale'), clock()));
  assertError('stale_reference', () => createPageSpec(state, refInput('page-fixture-1'), clock()));
});

test('missing financial data is not zero or an inferred balance', () => {
  const state = empty();
  createQuoteDraft(state, quoteInput(), clock());
  const payment = createPaymentRequestDraft(state, { ...refInput('request-fixture-1'), amountCents: 318 }, clock());
  assert.equal(payment.balanceStatus, 'unverified');
  assert.equal(payment.remainingQuoteCents, null);
  assert.equal(payment.quoteCeilingCents, 318);
  assert.equal(payment.invoiceId, null);
  assert.equal(payment.paymentUrl, null);
  assert.equal(payment.status, 'pending_approval');
  assert.equal(payment.dependencyStatus, 'quote_approval_pending');
  assert.deepEqual(state.invoices, {});
  assert.deepEqual(state.payments, {});
});

test('payment request accepts only positive integer cents within explicit quote ceiling/context', () => {
  const state = empty();
  createQuoteDraft(state, quoteInput(), clock());
  for (const amountCents of [0, -1, 0.5, true, '1']) {
    assertError('invalid_integer', () => createPaymentRequestDraft(state, { ...refInput('request-invalid'), amountCents }, clock()));
  }
  assertError('payment_request_exceeds_cap', () => createPaymentRequestDraft(state, { ...refInput('request-over'), amountCents: 319 }, clock()));
  assertError('payment_request_exceeds_cap', () => createPaymentRequestDraft(state, { ...refInput('request-zero'), amountCents: 1 }, { ...clock(), remainingQuoteCents: 0 }));
  const payment = createPaymentRequestDraft(state, { ...refInput('request-known'), amountCents: 100 }, { ...clock(), remainingQuoteCents: 101 });
  assert.equal(payment.remainingQuoteCents, 101);
  assert.equal(payment.balanceStatus, 'verified_by_caller');
  assertError('draft_context_conflict', () => createPaymentRequestDraft(state, { ...refInput('request-known'), amountCents: 100 }, { ...clock(), remainingQuoteCents: 100 }));
  assertError('unknown_field', () => createPaymentRequestDraft(state, { ...refInput('request-forged'), amountCents: 1, remainingQuoteCents: 318 }, clock()));
  assertError('invalid_remaining_quote_cents', () => createPaymentRequestDraft(state, { ...refInput('request-bad-context'), amountCents: 1 }, { ...clock(), remainingQuoteCents: 319 }));
  assertError('cross_event_reference', () => createPaymentRequestDraft(state, { ...refInput('request-cross', { gourmetEventId: 'other-event' }), amountCents: 1 }, clock()));
});

test('message review preserves exact text, recipient, channel and artifact revision', () => {
  const state = empty();
  createQuoteDraft(state, quoteInput(), clock());
  const input = messageInput({ text: '  Exact fixture text\nSecond line.  ' });
  const message = prepareMessageDraft(state, input, clock());
  const reviewed = reviewMessageDraft(state, { draftId: message.draftId, revision: 1 });
  assert.equal(reviewed.text, input.text);
  assert.equal(reviewed.recipient, input.recipient);
  assert.equal(reviewed.channel, input.channel);
  assert.equal(reviewed.artifactRefs[0].revision, 1);
  assert.match(reviewed.reviewDigest, /^[a-f0-9]{64}$/);
  assert.equal(reviewed.allowsLiveEffect, false);
  assert.strictEqual(prepareMessageDraft(state, input, clock()), message);
  assertError('draft_id_conflict', () => prepareMessageDraft(state, { ...input, text: `${input.text}.` }, clock()));
});

test('channel semantics and references reject ambiguous message recipients', () => {
  const state = empty();
  createQuoteDraft(state, quoteInput(), clock());
  for (const overrides of [
    { recipient: 'Client Name' }, { channel: 'sms', recipient: '555 123 4567' },
    { channel: 'slack', recipient: '#sales' }, { channel: 'email', recipient: 'a@example.invalid\nBcc: b@example.invalid' },
  ]) assertError('invalid_recipient', () => prepareMessageDraft(state, messageInput(overrides), clock()));
  assertError('unsupported_channel', () => prepareMessageDraft(state, messageInput({ channel: 'whatsapp' }), clock()));
  assertError('invalid_message_text', () => prepareMessageDraft(state, messageInput({ text: 'x'.repeat(10001) }), clock()));
  assertError('cross_event_reference', () => prepareMessageDraft(state, messageInput({ gourmetEventId: 'other-event' }), clock()));
  assertError('duplicate_artifact_reference', () => prepareMessageDraft(state, messageInput({ artifactRefs: [{ draftId: 'quote-fixture-1', revision: 1 }, { draftId: 'quote-fixture-1', revision: 1 }] }), clock()));
  assert.equal(prepareMessageDraft(state, messageInput({ draftId: 'sms-fixture', channel: 'sms', recipient: '+12025550123' }), clock()).status, 'pending_approval');
  assert.equal(prepareMessageDraft(state, messageInput({ draftId: 'slack-fixture', channel: 'slack', recipient: 'CFIXTURE123' }), clock()).status, 'pending_approval');
});

test('approval binds digest to exact review and trusted actor; simulation never permits live effect', () => {
  const state = empty();
  createQuoteDraft(state, quoteInput(), clock());
  prepareMessageDraft(state, messageInput(), clock());
  const reviewed = reviewMessageDraft(state, { draftId: 'message-fixture-1', revision: 1 });
  const input = { approvalId: 'approval-fixture-1', draftId: 'message-fixture-1', revision: 1, reviewDigest: reviewed.reviewDigest };
  assertError('simulation_approval_required', () => approveMessageDraft(state, input, { ...clock(), authenticatedActorId: 'office-demo-operator-fixture', explicitApproval: true }));
  assertError('simulation_approval_required', () => approveMessageDraft(state, input, { ...clock(), authenticatedActorId: 'office-demo-operator-fixture', simulation: true }));
  assertError('unknown_field', () => approveMessageDraft(state, { ...input, actorId: 'forged-actor' }, { ...clock(), authenticatedActorId: 'office-demo-operator-fixture', simulation: true, explicitApproval: true }));
  assertError('approval_digest_mismatch', () => approveMessageDraft(state, { ...input, reviewDigest: '0'.repeat(64) }, { ...clock(), authenticatedActorId: 'office-demo-operator-fixture', simulation: true, explicitApproval: true }));
  const approval = approve(state);
  assert.equal(approval.authenticatedActorId, 'office-demo-operator-fixture');
  assert.equal(approval.scope, 'local_simulation_only');
  assert.equal(approval.allowsLiveEffect, false);
  assert.equal(verifyApproval(state, { approvalId: approval.approvalId }), false);
  assert.equal(verifyApproval(state, { approvalId: approval.approvalId }, { simulation: true }), true);
  assert.strictEqual(approve(state), approval);
  assertError('approval_id_conflict', () => approveMessageDraft(state, input, { ...clock(), authenticatedActorId: 'other-fixture', simulation: true, explicitApproval: true }));
});

test('message text or recipient edits create new revisions and invalidate existing approvals', () => {
  for (const edits of [{ text: 'Changed synthetic text.' }, { recipient: 'changed-fixture@example.invalid' }, { channel: 'sms', recipient: '+12025550123' }]) {
    const state = empty();
    createQuoteDraft(state, quoteInput(), clock());
    const original = prepareMessageDraft(state, messageInput(), clock());
    approve(state);
    const input = messageInput({ ...edits, expectedRevision: 1 });
    const revised = reviseMessageDraft(state, input, { nowMs: NOW + 2 });
    assert.equal(revised.revision, 2);
    assert.equal(original.revision, 1);
    assert.equal(state.approvals['approval-fixture-1'].valid, false);
    assert.equal(state.approvals['approval-fixture-1'].invalidationReason, 'material_revision');
    assert.equal(verifyApproval(state, { approvalId: 'approval-fixture-1' }, { simulation: true }), false);
    assert.strictEqual(reviseMessageDraft(state, input, clock()), revised);
    assertError('stale_reference', () => approve(state));
    const nextApproval = approve(state, 'approval-fixture-2', revised.draftId, 2);
    assert.equal(nextApproval.valid, true);
  }
});

test('quote edit invalidates dependent message approval including indirect payment request refs', () => {
  const state = empty();
  createQuoteDraft(state, quoteInput(), clock());
  createPaymentRequestDraft(state, { ...refInput('request-fixture-1'), amountCents: 100 }, clock());
  prepareMessageDraft(state, messageInput({ artifactRefs: [{ draftId: 'request-fixture-1', revision: 1 }] }), clock());
  approve(state);
  reviseQuoteDraft(state, quoteInput({ expectedRevision: 1, taxBps: 1000 }), { nowMs: NOW + 2 });
  assert.equal(state.approvals['approval-fixture-1'].valid, false);
  assert.equal(verifyApproval(state, { approvalId: 'approval-fixture-1' }, { simulation: true }), false);
  assertError('stale_reference', () => createPaymentRequestDraft(state, { ...refInput('request-stale'), amountCents: 1 }, clock()));
});

test('blocked page can be reviewed but cannot be approved through a message', () => {
  const state = empty();
  createQuoteDraft(state, quoteInput(), clock());
  createPageSpec(state, refInput('page-fixture-1'), clock());
  prepareMessageDraft(state, messageInput({ artifactRefs: [{ draftId: 'page-fixture-1', revision: 1 }] }), clock());
  const reviewed = reviewMessageDraft(state, { draftId: 'message-fixture-1', revision: 1 });
  assert.equal(reviewed.blockedReason, 'blocked_missing_generator');
  assert.equal(reviewed.text, messageInput().text);
  assertError('blocked_missing_generator', () => approve(state));
  assert.equal(state.approvals, undefined);
});

test('persisted/reloaded approvals fail closed on content tampering, preserving read-only verification', () => {
  const state = empty();
  createQuoteDraft(state, quoteInput(), clock());
  prepareMessageDraft(state, messageInput(), clock());
  approve(state);
  const reloaded = JSON.parse(JSON.stringify(state));
  assert.equal(verifyApproval(reloaded, { approvalId: 'approval-fixture-1' }, { simulation: true }), true);
  reloaded.drafts['quote-fixture-1'].revisions[1].totalCents = 1;
  const before = JSON.stringify(reloaded);
  assert.equal(verifyApproval(reloaded, { approvalId: 'approval-fixture-1' }, { simulation: true }), false);
  assert.equal(JSON.stringify(reloaded), before);
  const changedRecipient = JSON.parse(JSON.stringify(state));
  changedRecipient.drafts['message-fixture-1'].revisions[1].recipient = 'changed@example.invalid';
  assert.equal(verifyApproval(changedRecipient, { approvalId: 'approval-fixture-1' }, { simulation: true }), false);
});

test('module exposes no send, publish, renderer, or provider-confirmation effect', async () => {
  const exports = await import('../../src/operations/drafts.mjs');
  assert.deepEqual(Object.keys(exports).sort(), ['DraftError', 'approveMessageDraft', 'createPageSpec', 'createPaymentRequestDraft', 'createQuoteDraft', 'prepareMessageDraft', 'reviewMessageDraft', 'reviseMessageDraft', 'reviseQuoteDraft', 'verifyApproval'].sort());
  const previousFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('network forbidden in fixture test'); };
  try {
    const state = empty();
    createQuoteDraft(state, quoteInput(), clock());
    createPageSpec(state, refInput('page-fixture-1'), clock());
    createPaymentRequestDraft(state, { ...refInput('request-fixture-1'), amountCents: 1 }, clock());
    prepareMessageDraft(state, messageInput(), clock());
    approve(state);
    assert.deepEqual(state.payments, {});
    assert.deepEqual(state.invoices, {});
  } finally { globalThis.fetch = previousFetch; }
});
