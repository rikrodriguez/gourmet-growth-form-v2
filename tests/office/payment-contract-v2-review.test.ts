import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareGourmetPaymentsAgreementV2, reviewGourmetPaymentsAgreementV2 } from '../../src/office/backend/gourmet-payments-agreement-v2';
import { digest } from '../../src/office/backend/event-quote-workflow';
import { TEST_AT, testActor, testBrief, testCatalog, testScope, testService } from './event-quote-fixtures';

async function fixture(paymentMode = 'retainer_50', total = 10001, bps = 5000, commercial = false) {
  const t = testService(), eventId = 'contract-v2-review';
  const scope = commercial ? { ...testScope, mode: 'commercial' as const } : testScope;
  const actor = commercial ? { ...testActor, durable: true } : testActor;
  const catalog = { ...testCatalog, authority: commercial ? 'owner_authorized' as const : 'test_only' as const,
    taxBps: 0, depositBps: bps, terms: 'Condiciones cotizadas exactas.\nSin cobro ni aceptación.',
    items: [{ ...testCatalog.items[0], unitPriceCents: total }] };
  t.catalog(catalog);
  const execute = (command: unknown) => t.service.execute(scope, actor, eventId, command);
  let view = await execute({ action: 'create', key: 'create', expectedRevision: 0, brief: testBrief });
  view = await execute({ action: 'quote', key: 'quote', expectedRevision: 1, expectedBriefDigest: view.record.briefs[0].digest,
    expectedCatalogDigest: digest(catalog), selections: [{ itemId: catalog.items[0].id, quantity: 1 }] });
  const q = view.record.quotes[0];
  view = await execute({ action: 'approve', key: 'approve', expectedRevision: 2, quoteVersion: q.version,
    quoteDigest: q.digest, artifactSha256: q.artifact.sha256, intendedRecipient: testBrief.recipient });
  view = await execute({ action: 'prepare_payment_v2', key: 'prepare-v2', expectedRevision: 3, quoteVersion: q.version,
    quoteDigest: q.digest, approvalDigest: view.record.decisions[0].digest, artifactSha256: q.artifact.sha256, paymentMode });
  const p = view.record.paymentContractPreparationsV2![0];
  const configuration: any = { contractVersion: 2, preparationId: p.id, paymentMode, canonicalLeadId: 'synthetic-canonical-lead',
    paymentTerms: q.catalog.terms, termsChangeReason: p.quotedDepositMatchesMode ? null : 'Modalidad distinta seleccionada expresamente para esta prueba.',
    paymentSchedule: paymentMode === 'full_upfront' ? null : paymentMode === 'retainer_50'
      ? { kind: paymentMode, eventDate: '2099-12-15', eventTime: '18:00', timezone: 'America/New_York', balanceDate: '2099-12-08', balanceTime: '12:00', timingExceptionReason: null }
      : { kind: paymentMode, balanceDate: '2099-12-01', balanceTime: '09:30', timezone: 'Asia/Kathmandu', agreedBalanceCents: p.paymentBalanceCents },
    linkExpiration: { kind: 'at', date: '2099-11-20', time: '13:00', timezone: 'America/New_York' } };
  const input: any = { scope, eventId, record: view.record, preparationId: p.id,
    currentCatalogDigest: digest(catalog), configuration, nowMs: TEST_AT };
  return { ...t, execute, view, q, p, input, configuration };
}

function approve(input: any) {
  const review = reviewGourmetPaymentsAgreementV2(input);
  assert.equal(review.status, 'review_required');
  if (review.status !== 'review_required') throw new Error(JSON.stringify(review));
  return { actor: testActor, expectedReviewDigest: review.reviewDigest };
}

for (const mode of ['retainer_50', 'full_upfront', 'fixed_49_reservation']) {
  test(`v2 ${mode} preserves source and all configured facts through isolated JSON round trip`, async () => {
    const t = await fixture(mode), before = structuredClone(t.input.record);
    const result = prepareGourmetPaymentsAgreementV2(t.input, approve(t.input));
    assert.equal(result.status, 'prepared_internal');
    if (result.status !== 'prepared_internal') throw new Error(JSON.stringify(result));
    assert.equal(result.plan.sourceQuote.totalCents, 10001);
    assert.equal(result.plan.sourceQuote.depositCents, 5001);
    assert.equal(result.plan.sourceQuote.depositBasis.basisPoints, 5000);
    assert.equal(result.plan.sourceQuote.terms, t.q.catalog.terms);
    assert.equal(result.plan.paymentTerms, t.configuration.paymentTerms);
    assert.equal(result.plan.paymentMode, mode);
    assert.equal(result.plan.initialPaymentCents, mode === 'full_upfront' ? 10001 : mode === 'retainer_50' ? 5001 : 4900);
    assert.equal(result.plan.paymentBalanceCents, 10001 - result.plan.initialPaymentCents);
    if (mode === 'full_upfront') assert.equal(result.plan.paymentSchedule, null);
    else assert.deepEqual(result.plan.paymentSchedule!.configured, t.configuration.paymentSchedule);
    assert.deepEqual(result.plan.linkExpiration.configured, t.configuration.linkExpiration);
    assert.equal(result.plan.linkExpiration.instant, '2099-11-20T18:00:00Z');
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
    assert.deepEqual(t.input.record, before);
    assert.equal(result.providerEnabled, false); assert.equal(result.executable, false); assert.equal(result.publicPaymentUrl, null);
    assert.deepEqual(result.blockers, ['PROVIDER_DISABLED', 'RECEIVER_V2_UNAVAILABLE']);
    assert.equal(Object.hasOwn(result, 'request'), false);
  });
}

test('a 50% quote amount equal to 49 stays retainer_50 and never selects the exception', async () => {
  const t = await fixture('retainer_50', 9800), result = prepareGourmetPaymentsAgreementV2(t.input, approve(t.input));
  assert.equal(result.status, 'prepared_internal');
  if (result.status !== 'prepared_internal') throw new Error(JSON.stringify(result));
  assert.equal(result.plan.initialPaymentCents, 4900); assert.equal(result.plan.paymentMode, 'retainer_50');
  assert.equal(result.plan.sourceQuote.depositBasis.basisPoints, 5000);
});

test('configuration and separate current plan approval are required even after quote approval', async () => {
  const t = await fixture();
  const pending = reviewGourmetPaymentsAgreementV2({ ...t.input, configuration: null });
  assert.equal(pending.status, 'blocked');
  assert.equal(prepareGourmetPaymentsAgreementV2(t.input).status, 'blocked');
  assert.equal(prepareGourmetPaymentsAgreementV2(t.input, { confirmed_intent: true }).status, 'blocked');
  for (const key of ['canonicalLeadId', 'paymentTerms', 'paymentSchedule', 'linkExpiration']) {
    const configuration = structuredClone(t.configuration); delete configuration[key];
    assert.equal(prepareGourmetPaymentsAgreementV2({ ...t.input, configuration }, approve(t.input)).status, 'blocked', key);
  }
});

test('full_upfront requires no balance, event date, timezone or fabricated future schedule', async () => {
  const t = await fixture('full_upfront', 10001, 10000), result = prepareGourmetPaymentsAgreementV2(t.input, approve(t.input));
  assert.equal(result.status, 'prepared_internal');
  if (result.status !== 'prepared_internal') throw new Error(JSON.stringify(result));
  assert.equal(result.plan.initialPaymentCents, 10001); assert.equal(result.plan.paymentBalanceCents, 0); assert.equal(result.plan.paymentSchedule, null);
  const configuration = { ...t.configuration, paymentSchedule: { kind: 'retainer_50', balanceDate: '2099-12-08' } };
  assert.equal(reviewGourmetPaymentsAgreementV2({ ...t.input, configuration }).status, 'blocked');
});

test('fixed_49 requires its expressly agreed balance and date and never uses the seven-day rule', async () => {
  const t = await fixture('fixed_49_reservation', 125001);
  const result = prepareGourmetPaymentsAgreementV2(t.input, approve(t.input));
  assert.equal(result.status, 'prepared_internal');
  if (result.status !== 'prepared_internal') throw new Error(JSON.stringify(result));
  assert.equal(result.plan.paymentSchedule!.balanceInstant, '2099-12-01T03:45:00Z');
  assert.equal(result.plan.paymentBalanceCents, 120101);
  for (const key of ['balanceDate', 'balanceTime', 'timezone', 'agreedBalanceCents']) {
    const configuration = structuredClone(t.configuration); delete configuration.paymentSchedule[key];
    assert.equal(reviewGourmetPaymentsAgreementV2({ ...t.input, configuration }).status, 'blocked', key);
  }
  const configuration = structuredClone(t.configuration); configuration.paymentSchedule.agreedBalanceCents++;
  assert.equal(reviewGourmetPaymentsAgreementV2({ ...t.input, configuration }).status, 'blocked');
});

test('retainer schedule preserves seven local calendar days across DST, with a separately configured time', async () => {
  const t = await fixture(), configuration = structuredClone(t.configuration);
  configuration.paymentSchedule = { kind: 'retainer_50', eventDate: '2027-11-10', eventTime: '12:00', timezone: 'America/New_York', balanceDate: '2027-11-03', balanceTime: '10:15', timingExceptionReason: null };
  configuration.linkExpiration = { kind: 'never' };
  const input = { ...t.input, configuration }, result = prepareGourmetPaymentsAgreementV2(input, approve(input));
  assert.equal(result.status, 'prepared_internal');
  if (result.status !== 'prepared_internal') throw new Error(JSON.stringify(result));
  assert.equal(result.plan.paymentSchedule!.proposedBalanceDate, '2027-11-03');
  assert.equal(result.plan.paymentSchedule!.balanceInstant, '2027-11-03T14:15:00Z');
  const missing = structuredClone(configuration); missing.paymentSchedule.balanceTime = null;
  assert.equal(reviewGourmetPaymentsAgreementV2({ ...t.input, configuration: missing }).status, 'blocked');
});

test('under seven days requires explicit timing review and a newly approved future date, never a past collection', async () => {
  const t = await fixture(), configuration = structuredClone(t.configuration);
  const today = new Date(TEST_AT).toISOString().slice(0, 10);
  const eventDate = new Date(TEST_AT + 3 * 86400000).toISOString().slice(0, 10);
  const futureBalance = new Date(TEST_AT + 86400000).toISOString().slice(0, 10);
  configuration.paymentSchedule = { kind: 'retainer_50', eventDate, eventTime: '18:00', timezone: 'UTC', balanceDate: futureBalance, balanceTime: '12:00', timingExceptionReason: null };
  configuration.linkExpiration = { kind: 'never' };
  assert.equal(reviewGourmetPaymentsAgreementV2({ ...t.input, configuration }).status, 'blocked');
  configuration.paymentSchedule.timingExceptionReason = 'Revisión sintética expresa: evento cercano; fecha alternativa acordada.';
  const input = { ...t.input, configuration };
  assert.equal(prepareGourmetPaymentsAgreementV2(input, approve(input)).status, 'prepared_internal');
  configuration.paymentSchedule.balanceDate = today;
  configuration.paymentSchedule.balanceTime = '00:00';
  assert.equal(reviewGourmetPaymentsAgreementV2({ ...t.input, configuration }).status, 'blocked');
});

test('a complete review is invalidated by changes to every financial or collection fact', async () => {
  const t = await fixture(), approval = approve(t.input);
  const changes = [
    (c: any) => { c.paymentTerms += '\nNueva condición'; c.termsChangeReason = 'Revisión sintética expresa.'; },
    (c: any) => { c.paymentSchedule.balanceTime = '12:01'; },
    (c: any) => { c.paymentSchedule.eventTime = '18:01'; },
    (c: any) => { c.paymentSchedule.timezone = 'UTC'; },
    (c: any) => { c.linkExpiration.time = '13:01'; },
    (c: any) => { c.canonicalLeadId = 'different-synthetic-lead'; },
    (c: any) => { c.paymentMode = 'fixed_49_reservation'; },
    (c: any) => { c.contractVersion = 1; },
    (c: any) => { c.preparationId = 'another-preparation'; },
  ];
  for (const change of changes) {
    const configuration = structuredClone(t.configuration); change(configuration);
    assert.equal(prepareGourmetPaymentsAgreementV2({ ...t.input, configuration }, approval).status, 'blocked');
  }
});

test('new conditions and a change from the quoted deposit require an explicit reason and exact new approval', async () => {
  const t = await fixture('full_upfront', 10000, 3000);
  t.configuration.termsChangeReason = null;
  assert.equal(reviewGourmetPaymentsAgreementV2(t.input).status, 'blocked');
  t.configuration.termsChangeReason = 'Cambio expreso sintético del anticipo cotizado al pago total.';
  const result = prepareGourmetPaymentsAgreementV2(t.input, approve(t.input));
  assert.equal(result.status, 'prepared_internal');
  if (result.status !== 'prepared_internal') throw new Error(JSON.stringify(result));
  assert.equal(result.plan.sourceQuote.depositCents, 3000); assert.equal(result.plan.initialPaymentCents, 10000);
  const modified = { ...t.configuration, paymentTerms: 'Condiciones nuevas sin revisión.', termsChangeReason: null };
  assert.equal(reviewGourmetPaymentsAgreementV2({ ...t.input, configuration: modified }).status, 'blocked');
});

test('actor authority, current catalog and immutable record bindings are checked again at preparation', async () => {
  const t = await fixture(), approval = approve(t.input);
  for (const actor of [{ ...testActor, canApprove: false }, { ...testActor, canWrite: false }, { ...testActor, expiresAtMs: TEST_AT }]) {
    assert.equal(prepareGourmetPaymentsAgreementV2(t.input, { ...approval, actor }).status, 'blocked');
  }
  assert.equal(prepareGourmetPaymentsAgreementV2({ ...t.input, currentCatalogDigest: 'f'.repeat(64) }, approval).status, 'blocked');
  assert.equal(prepareGourmetPaymentsAgreementV2({ ...t.input, nowMs: testCatalog.validUntilMs }, approval).status, 'blocked');
  const record = structuredClone(t.input.record); record.quotes[0].depositCents++;
  assert.equal(prepareGourmetPaymentsAgreementV2({ ...t.input, record }, approval).status, 'blocked');
  assert.equal(prepareGourmetPaymentsAgreementV2({ ...t.input, eventId: 'different-event' }, approval).status, 'blocked');
});

test('zero totals and a retainer with zero future balance remain blocked without changing the source quote', async () => {
  for (const [mode, total] of [['full_upfront', 0], ['retainer_50', 1]] as const) {
    const t = await fixture(mode, total), before = structuredClone(t.input.record);
    assert.equal(reviewGourmetPaymentsAgreementV2(t.input).status, 'blocked');
    assert.deepEqual(t.input.record, before);
  }
});

test('approval flags, malformed actors and extra fields never replace server-owned current review authority', async () => {
  const t = await fixture(), decision = approve(t.input);
  for (const actor of [null, true, { ...testActor, canApprove: 'true' }, { ...testActor, durable: 1 },
    { ...testActor, actorId: '' }, { ...testActor, actorId: 'constructor' }, { ...testActor, actorId: 'invalid actor' },
    { ...testActor, expiresAtMs: TEST_AT + 0.5 }, { ...testActor, extra: true }]) {
    assert.equal(prepareGourmetPaymentsAgreementV2(t.input, { ...decision, actor }).status, 'blocked');
  }
  assert.equal(prepareGourmetPaymentsAgreementV2(t.input, { ...decision, approved: true }).status, 'blocked');
  const configuration = { ...t.configuration, confirmed_intent: true };
  assert.equal(reviewGourmetPaymentsAgreementV2({ ...t.input, configuration }).status, 'blocked');
  let reads = 0;
  const accessor = { ...t.configuration };
  Object.defineProperty(accessor, 'paymentTerms', { enumerable: true, get() { reads++; return t.configuration.paymentTerms; } });
  assert.equal(reviewGourmetPaymentsAgreementV2({ ...t.input, configuration: accessor }).status, 'blocked');
  assert.equal(reads, 0);
});

test('commercial internal review requires a durable server-owned actor and owner-authorized source', async () => {
  const t = await fixture('retainer_50', 10001, 5000, true), decision = approve(t.input);
  assert.equal(prepareGourmetPaymentsAgreementV2(t.input, decision).status, 'blocked');
  assert.equal(prepareGourmetPaymentsAgreementV2(t.input, { ...decision, actor: { ...testActor, durable: true } }).status, 'prepared_internal');
  const invalidScope = { ...t.input, scope: testScope };
  assert.equal(reviewGourmetPaymentsAgreementV2(invalidScope).status, 'blocked');
});

test('future eligibility is checked again after review and no approved plan can retain a past collection', async () => {
  const t = await fixture(), configuration = structuredClone(t.configuration);
  const date = new Date(TEST_AT).toISOString().slice(0, 10), tomorrow = new Date(TEST_AT + 86400000).toISOString().slice(0, 10);
  configuration.paymentSchedule = { kind: 'retainer_50', eventDate: tomorrow, eventTime: '18:00', timezone: 'UTC',
    balanceDate: date, balanceTime: new Date(TEST_AT + 60000).toISOString().slice(11, 16), timingExceptionReason: 'Revisión sintética expresa de evento cercano.' };
  configuration.linkExpiration = { kind: 'never' };
  const input = { ...t.input, configuration }, decision = approve(input);
  assert.equal(prepareGourmetPaymentsAgreementV2(input, decision).status, 'prepared_internal');
  assert.equal(prepareGourmetPaymentsAgreementV2({ ...input, nowMs: TEST_AT + 60000 }, decision).status, 'blocked');
});
