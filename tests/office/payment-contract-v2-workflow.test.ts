import assert from 'node:assert/strict';
import test from 'node:test';
import { EventQuoteError, type EventQuoteView, type PaymentContractModeV2, type PreparePaymentV2Command } from '../../src/office/backend/event-quote-contracts';
import { assertEventQuoteRecord, createEventQuoteService, digest } from '../../src/office/backend/event-quote-workflow';
import { createEventQuoteApi, EVENT_QUOTE_API, EVENT_QUOTE_CSRF_HEADER, type QuoteAccessTarget } from '../../src/office/backend/event-quote-http';
import { TEST_AT, testActor as actor, testBrief as brief, testCatalog as baseCatalog, testScope as scope, testService } from './event-quote-fixtures';

const EVENT = 'payment-contract-v2';
const code = (expected: string) => (error: unknown) => error instanceof EventQuoteError && error.code === expected;
function command(view: EventQuoteView, paymentMode: PaymentContractModeV2, key = 'prepare-v2'): PreparePaymentV2Command {
  const q = view.record.quotes.at(-1)!, d = view.record.decisions.find(d => d.quoteDigest === q.digest)!;
  return { action: 'prepare_payment_v2', key, expectedRevision: view.record.revision, quoteVersion: q.version,
    quoteDigest: q.digest, approvalDigest: d.digest, artifactSha256: q.artifact.sha256, paymentMode };
}
function legacy(view: EventQuoteView) {
  const { paymentMode: _, ...input } = command(view, 'retainer_50');
  return { ...input, action: 'prepare_payment', key: 'prepare-legacy' };
}
async function setup(totalCents = 10001, depositBps = 3000, approve = true) {
  const t = testService(), catalog = { ...baseCatalog, taxBps: 0, depositBps,
    terms: `Condiciones originales sintéticas: anticipo ${depositBps / 100} %.\nSin aceptación ni confirmación.`,
    items: [{ ...baseCatalog.items[0], unitPriceCents: totalCents }] };
  t.catalog(catalog);
  const execute = (input: unknown) => t.service.execute(scope, actor, EVENT, input);
  let view = await execute({ action: 'create', key: 'create', expectedRevision: 0, brief });
  view = await execute({ action: 'quote', key: 'quote', expectedRevision: 1, expectedBriefDigest: view.record.briefs[0].digest,
    expectedCatalogDigest: digest(catalog), selections: [{ itemId: catalog.items[0].id, quantity: 1 }] });
  if (approve) {
    const q = view.record.quotes[0];
    view = await execute({ action: 'approve', key: 'approve', expectedRevision: 2, quoteVersion: q.version,
      quoteDigest: q.digest, artifactSha256: q.artifact.sha256, intendedRecipient: brief.recipient });
  }
  return { ...t, execute, view, catalogSnapshot: catalog };
}

for (const scenario of [
  { mode: 'retainer_50', total: 10001, bps: 3000, initial: 5001, match: false },
  { mode: 'retainer_50', total: 9800, bps: 5000, initial: 4900, match: true },
  { mode: 'retainer_50', total: 1, bps: 5000, initial: 1, match: true },
  { mode: 'full_upfront', total: 10001, bps: 10000, initial: 10001, match: true },
  { mode: 'full_upfront', total: 2594, bps: 0, initial: 2594, match: false },
  { mode: 'full_upfront', total: 0, bps: 10000, initial: 0, match: true },
  { mode: 'fixed_49_reservation', total: 10001, bps: 3000, initial: 4900, match: false },
  { mode: 'fixed_49_reservation', total: 9800, bps: 5000, initial: 4900, match: false },
] as const) {
  test(`v2 ${scenario.mode} preserves approved quote ${scenario.total}/${scenario.bps} and records only an unconfigured draft`, async () => {
    const t = await setup(scenario.total, scenario.bps), original = structuredClone(t.view.record);
    const prepared = await t.execute(command(t.view, scenario.mode)), p = prepared.record.paymentContractPreparationsV2![0], q = original.quotes[0];
    assert.equal(prepared.record.schemaVersion, 3); assert.deepEqual(prepared.record.paymentPreparations, []);
    assert.equal(p.contractVersion, 2); assert.equal(p.paymentMode, scenario.mode);
    assert.equal(p.totalCents, q.totalCents); assert.equal(p.depositCents, q.depositCents); assert.equal(p.remainingCents, q.totalCents - q.depositCents);
    assert.deepEqual(p.depositBasis, { kind: 'quoted_percentage', basisPoints: q.catalog.depositBps });
    assert.equal(p.initialPaymentCents, scenario.initial); assert.equal(p.paymentBalanceCents, scenario.total - scenario.initial);
    assert.equal(p.quotedDepositMatchesMode, scenario.match); assert.equal(p.terms, q.catalog.terms);
    assert.equal(p.blockers.includes('QUOTED_PAYMENT_TERMS_REVIEW_REQUIRED'), !scenario.match);
    assert.equal(p.blockers.includes('PAYMENT_SCHEDULE_REQUIRED'), scenario.mode !== 'full_upfront');
    for (const blocker of ['PROVIDER_DISABLED', 'RECEIVER_V2_UNAVAILABLE', 'CANONICAL_LEAD_REQUIRED', 'LINK_EXPIRATION_REQUIRED', 'PAYMENT_TERMS_REQUIRED', 'PAYMENT_TERMS_APPROVAL_REQUIRED']) assert.ok(p.blockers.includes(blocker as typeof p.blockers[number]));
    for (const field of ['paymentTerms', 'paymentSchedule', 'paymentTermsApproval', 'canonicalLeadId', 'publicPaymentUrl'] as const) assert.equal(p[field], null);
    assert.equal(p.status, 'pending_configuration'); assert.equal(p.provider, 'gourmet_payments_v2');
    assert.equal(p.providerEnabled, false); assert.equal(p.financialMeaning, 'unaccepted_quote'); assert.equal(prepared.externalEffectsEnabled, false);
    assert.deepEqual(prepared.record.briefs, original.briefs); assert.deepEqual(prepared.record.quotes, original.quotes); assert.deepEqual(prepared.record.decisions, original.decisions);
    assertEventQuoteRecord(prepared.record, scope, EVENT);
    assert.deepEqual(await t.execute(command(t.view, scenario.mode)), prepared);
    const restarted = createEventQuoteService({ store: t.store, catalogFor: async () => t.catalogSnapshot, clock: () => TEST_AT });
    assert.deepEqual(await restarted.read(scope, actor, EVENT), prepared);
  });
}

test('v2 requires an explicit supported mode and rejects all injected configuration without mutation', async () => {
  const t = await setup(9800, 5000), input = command(t.view, 'retainer_50'), { paymentMode: _, ...missing } = input;
  for (const invalid of [missing, ...[undefined, null, '', 'approved_quote_deposit', '49', 'fixed_49', 'RETAlNER_50'].map(paymentMode => ({ ...input, paymentMode })),
    ...Object.entries({ paymentTerms: 'new terms', paymentSchedule: {}, paymentTermsApproval: true, canonicalLeadId: 'lead',
      initialPaymentCents: 4900, terms: 'new terms', timezone: 'UTC', balance_due_date: '2027-12-01T13:00', link_expiration: '7d',
      confirmed_intent: true, providerEnabled: true }).map(([field, value]) => ({ ...input, [field]: value }))]) {
    await assert.rejects(t.execute(invalid)); assert.deepEqual(await t.service.read(scope, actor, EVENT), t.view);
  }
});

for (const total of [0, 1, 4899, 4900]) test(`explicit fixed 49 rejects total ${total} without changing the quote`, async () => {
  const t = await setup(total, 5000);
  await assert.rejects(t.execute(command(t.view, 'fixed_49_reservation')), code('FIXED_RESERVATION_TOTAL_REQUIRED'));
  assert.deepEqual(await t.service.read(scope, actor, EVENT), t.view);
});

test('v2 idempotency, mode identity and one v2 per quote remain exact', async () => {
  const a = await setup(9800, 5000), b = await setup(9800, 5000), input = command(a.view, 'retainer_50');
  const [left, retry] = await Promise.all([a.execute(input), a.execute(input)]);
  assert.deepEqual(left, retry); assert.equal(left.record.revision, 4); assert.equal(left.record.paymentContractPreparationsV2!.length, 1);
  const fixed = await b.execute(command(b.view, 'fixed_49_reservation'));
  assert.notEqual(left.record.paymentContractPreparationsV2![0].id, fixed.record.paymentContractPreparationsV2![0].id);
  await assert.rejects(a.execute({ ...input, paymentMode: 'full_upfront' }), code('IDEMPOTENCY_CONFLICT'));
  await assert.rejects(a.execute(command(left, 'full_upfront', 'other-mode')), code('PAYMENT_V2_ALREADY_PREPARED'));
  assert.deepEqual(await a.service.read(scope, actor, EVENT), left);
});

for (const legacyFirst of [true, false]) test(`legacy and v2 may coexist for one quote, legacyFirst=${legacyFirst}`, async () => {
  const t = await setup(), original = structuredClone(t.view.record);
  assert.equal(original.schemaVersion, 1); assert.equal(Object.hasOwn(original, 'paymentContractPreparationsV2'), false);
  const first = await t.execute(legacyFirst ? legacy(t.view) : command(t.view, 'retainer_50'));
  if (legacyFirst) {
    assert.equal(first.record.schemaVersion, 2); assert.equal(Object.hasOwn(first.record, 'paymentContractPreparationsV2'), false);
    assert.equal(JSON.stringify((await t.service.read(scope, actor, EVENT)).record), JSON.stringify(first.record));
  }
  const second = await t.execute(legacyFirst ? command(first, 'retainer_50') : legacy(first));
  assert.equal(second.record.schemaVersion, 3); assert.equal(second.record.paymentPreparations!.length, 1);
  assert.equal(second.record.paymentContractPreparationsV2!.length, 1); assert.equal(second.record.revision, 5);
  if (legacyFirst) assert.deepEqual(second.record.paymentPreparations, first.record.paymentPreparations);
  else assert.deepEqual(second.record.paymentContractPreparationsV2, first.record.paymentContractPreparationsV2);
  assert.deepEqual(second.record.briefs, original.briefs); assert.deepEqual(second.record.quotes, original.quotes); assert.deepEqual(second.record.decisions, original.decisions);
  assertEventQuoteRecord(second.record, scope, EVENT);
});

test('v2 requires current internal approval and exact quote/approval/artifact/revision pins', async () => {
  const pending = await setup(10001, 3000, false), q = pending.view.record.quotes[0];
  await assert.rejects(pending.execute({ action: 'prepare_payment_v2', key: 'pending', expectedRevision: 2, quoteVersion: q.version,
    quoteDigest: q.digest, approvalDigest: '0'.repeat(64), artifactSha256: q.artifact.sha256, paymentMode: 'retainer_50' }), code('STALE_PAYMENT_PREPARATION'));
  const t = await setup(), input = command(t.view, 'retainer_50');
  for (const changed of [{ quoteVersion: 2 }, { quoteDigest: '0'.repeat(64) }, { approvalDigest: '0'.repeat(64) }, { artifactSha256: '0'.repeat(64) }]) {
    await assert.rejects(t.execute({ ...input, ...changed }), code('STALE_PAYMENT_PREPARATION'));
  }
  await assert.rejects(t.execute({ ...input, expectedRevision: 2 }), code('REVISION_CONFLICT'));
  for (const [capability, expected] of [[{ canWrite: false }, 'WRITE_FORBIDDEN'], [{ canApprove: false }, 'APPROVAL_FORBIDDEN'], [{ expiresAtMs: TEST_AT }, 'IDENTITY_EXPIRED']] as const) {
    await assert.rejects(t.service.execute(scope, { ...actor, ...capability }, EVENT, input), code(expected));
  }
  assert.deepEqual(await t.service.read(scope, actor, EVENT), t.view);
});

test('v2 historical snapshots survive later briefs; stale catalogue and cross-scope reuse fail closed', async () => {
  const t = await setup(), input = command(t.view, 'retainer_50'), prepared = await t.execute(input);
  const changed = await t.execute({ action: 'brief', key: 'brief-2', expectedRevision: 4, brief: { ...brief, proposedDate: 'Otra fecha pendiente' } });
  assert.equal(changed.currentQuoteStatus, 'obsolete'); assert.deepEqual(changed.record.paymentContractPreparationsV2, prepared.record.paymentContractPreparationsV2);
  await assert.rejects(t.execute({ ...input, key: 'stale', expectedRevision: 5 }), code('STALE_PAYMENT_PREPARATION'));
  assertEventQuoteRecord(changed.record, scope, EVENT);
  const other = await setup(); other.catalog({ ...other.catalogSnapshot, version: 'replacement' });
  await assert.rejects(other.execute(command(other.view, 'retainer_50')), code('STALE_PAYMENT_PREPARATION'));
  const forged = structuredClone(prepared.record); forged.scope = { ...scope, workspaceId: 'other' };
  assert.throws(() => assertEventQuoteRecord(forged, forged.scope, EVENT));
});

test('v2 ledger replay rejects rehashed draft tampering, removal, duplicates and schema downgrades', async () => {
  const t = await setup(), view = await t.execute(command(t.view, 'retainer_50'));
  for (const change of [{ initialPaymentCents: 4900 }, { paymentBalanceCents: 0 }, { depositCents: 4900 }, { paymentMode: 'fixed_49_reservation' },
    { depositBasis: { kind: 'quoted_percentage', basisPoints: 5000 } }, { quotedDepositMatchesMode: true }, { terms: 'altered' },
    { paymentSchedule: { due: '2027-01-01' } }, { paymentTermsApproval: { approved: true } }, { canonicalLeadId: 'forged' },
    { providerEnabled: true }, { publicPaymentUrl: 'https://example.test/pay' }, { blockers: [] }]) {
    const forged = structuredClone(view.record), p = forged.paymentContractPreparationsV2![0];
    Object.assign(p, change); const { digest: _, ...content } = p; p.digest = digest(content);
    assert.throws(() => assertEventQuoteRecord(forged, scope, EVENT));
  }
  for (const schemaVersion of [1, 2] as const) { const forged = structuredClone(view.record); forged.schemaVersion = schemaVersion; assert.throws(() => assertEventQuoteRecord(forged, scope, EVENT)); }
  const removed = structuredClone(view.record); removed.paymentContractPreparationsV2 = []; assert.throws(() => assertEventQuoteRecord(removed, scope, EVENT));
  const nullLegacy = structuredClone(view.record); (nullLegacy as unknown as Record<string, unknown>).paymentPreparations = null;
  assert.throws(() => assertEventQuoteRecord(nullLegacy, scope, EVENT));
  const duplicated = structuredClone(view.record); duplicated.paymentContractPreparationsV2!.push(duplicated.paymentContractPreparationsV2![0]); assert.throws(() => assertEventQuoteRecord(duplicated, scope, EVENT));
});

test('v2 twenty immutable quote preparations fit the bounded ledger and preserve every historical mode', async () => {
  const t = await setup(); let view = await t.execute(command(t.view, 'retainer_50'));
  const first = structuredClone(view.record.paymentContractPreparationsV2![0]);
  const modes: PaymentContractModeV2[] = ['retainer_50', 'full_upfront', 'fixed_49_reservation'];
  for (let version = 2; version <= 20; version++) {
    view = await t.execute({ action: 'quote', key: `quote-${version}`, expectedRevision: view.record.revision,
      expectedBriefDigest: view.record.briefs[0].digest, expectedCatalogDigest: digest(t.catalogSnapshot),
      selections: [{ itemId: t.catalogSnapshot.items[0].id, quantity: 1 }] });
    const q = view.record.quotes.at(-1)!;
    view = await t.execute({ action: 'approve', key: `approve-${version}`, expectedRevision: view.record.revision,
      quoteVersion: q.version, quoteDigest: q.digest, artifactSha256: q.artifact.sha256, intendedRecipient: brief.recipient });
    view = await t.execute(command(view, modes[version % modes.length], `prepare-v2-${version}`));
  }
  assert.equal(view.record.revision, 61); assert.equal(view.record.paymentContractPreparationsV2!.length, 20);
  assert.deepEqual(view.record.paymentContractPreparationsV2![0], first); assertEventQuoteRecord(view.record, scope, EVENT);
  await assert.rejects(t.execute({ action: 'quote', key: 'quote-over-cap', expectedRevision: view.record.revision,
    expectedBriefDigest: view.record.briefs[0].digest, expectedCatalogDigest: digest(t.catalogSnapshot),
    selections: [{ itemId: t.catalogSnapshot.items[0].id, quantity: 1 }] }), code('RECORD_LIMIT'));
  assert.deepEqual(await t.service.read(scope, actor, EVENT), view);
});

test('v2 HTTP uses the durable approval target, requires write/approve and CSRF, and accepts no configuration', async () => {
  const t = await setup(), targets: QuoteAccessTarget[] = [], origin = 'https://v2.example.test', csrf = 'synthetic_v2_csrf_token';
  let currentActor = actor;
  const app = createEventQuoteApi({ allowedOrigin: origin, clock: () => TEST_AT,
    async runAuthorized(_request, target, operation) { targets.push(target); return operation({ scope, actor: currentActor, csrfToken: csrf, expiresAtMs: actor.expiresAtMs }, t.service); } });
  const input = command(t.view, 'retainer_50'), headers = { host: 'v2.example.test', origin, [EVENT_QUOTE_CSRF_HEADER]: csrf };
  const post = (payload = input, extraHeaders = {}) => app.inject({ method: 'POST', url: `${EVENT_QUOTE_API}/${EVENT}/commands`, headers: { ...headers, ...extraHeaders }, payload });
  try {
    currentActor = { ...actor, canApprove: false }; assert.equal((await post()).statusCode, 403);
    currentActor = { ...actor, canWrite: false }; assert.equal((await post()).statusCode, 403);
    currentActor = actor; assert.equal((await post(input, { [EVENT_QUOTE_CSRF_HEADER]: 'wrong' })).statusCode, 403);
    assert.equal((await post({ ...input, paymentSchedule: {} } as typeof input)).statusCode, 400);
    assert.deepEqual(await t.service.read(scope, actor, EVENT), t.view);
    const result = await post(); assert.equal(result.statusCode, 200, result.body);
    assert.equal(result.json().record.paymentContractPreparationsV2[0].paymentTermsApproval, null);
    assert.deepEqual(targets, Array.from({ length: 5 }, () => ({ kind: 'approve', eventId: EVENT })));
  } finally { await app.close(); }
});
