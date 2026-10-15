import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { canonical, digest } from '../../src/office/backend/event-quote-workflow';
import { prepareGourmetPaymentsAgreementV2, reviewGourmetPaymentsAgreementV2 } from '../../src/office/backend/gourmet-payments-agreement-v2';
import { createPaymentAgreementOperationV2, decodePaymentAgreementReceiptV2, paymentAgreementIdempotencyKeyV2,
  paymentAgreementOperationIdV2, type PaymentAgreementAuthorizationV2, type PaymentAgreementOperationV2 } from '../../src/office/backend/payment-agreement-operations-v2';
import type { PaymentContractModeV2 } from '../../src/office/backend/event-quote-contracts';
import { TEST_AT, testActor, testBrief, testCatalog, testScope, testService } from '../office/event-quote-fixtures';
import { createOperationalPaymentFixtureV2, operationalFixtureSharedSecret, startOperationalPaymentReceiverV2,
  type OperationalFixtureV2, type OperationalLedgerSnapshotV2 } from './php-operational-receiver';

const paymentTerms = 'Condiciones sintéticas aprobadas.\r\nUnicode café 🥘; espacios:  dos; / y \\; \u2028\u2029.';
const termsReason = 'Revisión explícita sintética de condiciones; no autoriza cobros.';
let ledger: OperationalFixtureV2;
before(async () => { ledger = await createOperationalPaymentFixtureV2({ seedLegacy: true }); });
after(async () => { await ledger?.close(); });

async function operationFixture(mode: PaymentContractModeV2 = 'retainer_50', suffix: string = mode, total = 10001, bps = 5000) {
  const t = testService(), eventId = `synthetic-operational-${suffix}`;
  const catalog = { ...testCatalog, taxBps: 0, depositBps: bps,
    items: [{ ...testCatalog.items[0], unitPriceCents: total }] };
  t.catalog(catalog);
  const execute = (command: unknown) => t.service.execute(testScope, testActor, eventId, command);
  let view = await execute({ action: 'create', key: 'create', expectedRevision: 0, brief: testBrief });
  view = await execute({ action: 'quote', key: 'quote', expectedRevision: 1, expectedBriefDigest: view.record.briefs[0].digest,
    expectedCatalogDigest: digest(catalog), selections: [{ itemId: catalog.items[0].id, quantity: 1 }] });
  const quote = view.record.quotes[0];
  view = await execute({ action: 'approve', key: 'approve', expectedRevision: 2, quoteVersion: quote.version,
    quoteDigest: quote.digest, artifactSha256: quote.artifact.sha256, intendedRecipient: testBrief.recipient });
  view = await execute({ action: 'prepare_payment_v2', key: 'prepare-v2', expectedRevision: 3, quoteVersion: quote.version,
    quoteDigest: quote.digest, approvalDigest: view.record.decisions[0].digest, artifactSha256: quote.artifact.sha256, paymentMode: mode });
  const preparation = view.record.paymentContractPreparationsV2![0];
  const configuration = { contractVersion: 2, preparationId: preparation.id, paymentMode: mode,
    canonicalLeadId: 'synthetic-operational-canonical-lead', paymentTerms, termsChangeReason: termsReason,
    paymentSchedule: mode === 'full_upfront' ? null : mode === 'retainer_50'
      ? { kind: mode, eventDate: '2099-12-15', eventTime: '18:00', timezone: 'America/New_York', balanceDate: '2099-12-08', balanceTime: '12:00', timingExceptionReason: null }
      : { kind: mode, balanceDate: '2099-12-01', balanceTime: '09:30', timezone: 'Asia/Kathmandu', agreedBalanceCents: preparation.paymentBalanceCents },
    linkExpiration: { kind: 'at', date: '2099-11-20', time: '13:00', timezone: 'America/New_York' } };
  const input = { scope: testScope, eventId, record: view.record, preparationId: preparation.id,
    currentCatalogDigest: digest(catalog), configuration, nowMs: TEST_AT };
  const review = reviewGourmetPaymentsAgreementV2(input);
  assert.equal(review.status, 'review_required');
  if (review.status !== 'review_required') throw new Error(JSON.stringify(review));
  const prepared = prepareGourmetPaymentsAgreementV2(input, { actor: testActor, expectedReviewDigest: review.reviewDigest });
  assert.equal(prepared.status, 'prepared_internal');
  if (prepared.status !== 'prepared_internal') throw new Error(JSON.stringify(prepared));
  const operation = createPaymentAgreementOperationV2({ prepared, configurationId: `configuration-${suffix}`,
    configurationDigest: digest(configuration), recipientName: testBrief.contactName,
    source: { source: 'synthetic_fixture', canonicalLeadId: configuration.canonicalLeadId,
      serviceName: 'Servicio sintético operacional', phone: '+1 202 555 0100', eventLocation: 'Lugar sintético verificado' } });
  return { operation, sourceRecord: structuredClone(view.record), configuration };
}
function authorization(operation: PaymentAgreementOperationV2, nowMs = Date.now()): PaymentAgreementAuthorizationV2 {
  return { issuer: 'gourmet_office', purpose: 'create_disabled_payment_agreement_v2', actorId: 'SYNTHETIC-CURRENT-OPERATOR',
    scope: operation.prepared.plan.scope, operationId: operation.operationId, operationDigest: digest(operation),
    issuedAtMs: nowMs - 1000, expiresAtMs: nowMs + 60_000 };
}
function envelope(operation: PaymentAgreementOperationV2, auth = authorization(operation)) { return canonical({ operation, authorization: auth }); }
function request(operation: PaymentAgreementOperationV2, extra: Record<string, unknown> = {}) {
  return { action: 'route', body: envelope(operation), headers: { authorization: `Bearer ${operationalFixtureSharedSecret}`,
    'content-type': 'application/json; charset=utf-8', 'idempotency-key': paymentAgreementIdempotencyKeyV2(operation.operationId) }, ...extra };
}
function response(result: ReturnType<OperationalFixtureV2['invoke']>, expected: number) {
  assert.ok(result.response); assert.equal(result.response.status, expected, result.response.body);
  return JSON.parse(result.response.body);
}
function sqlInstant(utc: string | null) { return utc === null ? null : utc.replace('T', ' ').replace('Z', '.000000'); }
function assertNoFinancialSideEffects(snapshot: OperationalLedgerSnapshotV2) {
  for (const table of ['payment_attempts', 'payment_consents', 'provider_resources', 'provider_webhook_events', 'email_outbox', 'monday_sync_outbox', 'sales_os_event_outbox'])
    assert.equal(snapshot.counts[table], 0, `${table} must remain empty for internal drafts`);
  for (const row of snapshot.agreements.filter(row => row.contract_version === 2)) {
    assert.equal(row.provider, null); assert.equal(row.public_token_hash, null); assert.equal(row.token_is_null, 1);
    assert.equal(row.status, 'DRAFT_INTERNAL');
  }
}
function assertPersisted(result: ReturnType<OperationalFixtureV2['invoke']>, operation: PaymentAgreementOperationV2, receiptBody: string) {
  const receipt = decodePaymentAgreementReceiptV2(receiptBody, operation), plan = operation.prepared.plan;
  const row = result.snapshot.agreements.find(row => row.public_uuid === receipt.agreementId);
  assert.ok(row, 'Receipt must identify an actual SQLite agreement row');
  assert.equal(row.contract_version, 2); assert.equal(row.payment_mode, plan.paymentMode);
  assert.equal(row.currency, 'USD'); assert.equal(row.total_cents, plan.sourceQuote.totalCents);
  assert.equal(row.initial_cents, plan.initialPaymentCents); assert.equal(row.balance_cents, plan.paymentBalanceCents);
  assert.equal(row.reservation_cents, plan.paymentMode === 'fixed_49_reservation' ? 4900 : null);
  assert.equal(row.operation_id, operation.operationId); assert.equal(row.operation_digest, digest(operation));
  assert.equal(row.operation_json, canonical(operation));
  assert.deepEqual(JSON.parse(row.operation_json), operation, 'Stored operation preserves every term, BPS, date, approval and source fact');
  assert.equal(row.configuration_id, operation.configurationId); assert.equal(row.configuration_digest, operation.configurationDigest);
  assert.equal(row.source_lead_id, plan.canonicalLeadId); assert.equal(row.source_quote_id, plan.sourceQuote.digest);
  assert.equal(row.source_quote_version, String(plan.sourceQuote.version));
  assert.equal(row.recipient_name, operation.recipient.name); assert.equal(row.recipient_email, operation.recipient.email);
  assert.equal(row.recipient_phone, operation.recipient.phone); assert.equal(row.service_name, operation.service.name);
  assert.equal(row.event_location, operation.service.eventLocation);
  assert.equal(row.event_at_utc, sqlInstant(plan.paymentSchedule?.eventInstant ?? null));
  assert.equal(row.balance_due_at_utc, sqlInstant(plan.paymentSchedule?.balanceInstant ?? null));
  assert.equal(row.balance_timezone, plan.paymentSchedule?.configured.timezone ?? null);
  assert.equal(row.link_expires_at, sqlInstant(plan.linkExpiration.instant));
  const schedules = result.snapshot.schedules.filter(row => row.agreement_uuid === receipt.agreementId);
  assert.equal(schedules.length, plan.paymentMode === 'full_upfront' ? 1 : 2);
  const initial = schedules.find(row => row.kind === (plan.paymentMode === 'fixed_49_reservation' ? 'RESERVATION' : 'INITIAL'));
  assert.ok(initial); assert.equal(initial.amount_cents, plan.initialPaymentCents);
  const balance = schedules.find(row => row.kind === 'BALANCE');
  if (plan.paymentMode === 'full_upfront') assert.equal(balance, undefined);
  else { assert.ok(balance); assert.equal(balance.amount_cents, plan.paymentBalanceCents); assert.equal(balance.due_at_utc, sqlInstant(plan.paymentSchedule!.balanceInstant)); }
  assert.ok(schedules.every(row => row.status === 'DRAFT' && row.paid_at === null));
  const replay = result.snapshot.idempotency.find(row => row.idempotency_key === paymentAgreementIdempotencyKeyV2(operation.operationId));
  assert.ok(replay); assert.equal(replay.scope, 'internal.payment_agreements.draft.v2');
  assert.equal(replay.request_hash, digest(operation)); assert.equal(replay.encrypted_response, 1); assert.equal(replay.response_status, 201);
  assert.ok(replay.completed_at); assert.equal(replay.locked_until, null);
  assertNoFinancialSideEffects(result.snapshot);
  return receipt;
}

test('original SQLite migrations preserve synthetic v1 history and its fixed USD 49 invariant', () => {
  assert.deepEqual(ledger.initial.applied, ['0006_versioned_payment_agreement_drafts.sql']);
  assert.equal(ledger.initial.snapshot.migrations.length, 5);
  const before = ledger.initial.legacyBeforeMigration![0], after = ledger.initial.snapshot.agreements[0];
  assert.equal(after.public_uuid, before.public_uuid); assert.equal(after.contract_version, 1);
  assert.equal(after.total_cents, 10001); assert.equal(after.reservation_cents, 4900); assert.equal(after.balance_cents, 5101);
  assert.equal(after.initial_cents, null); assert.equal(after.payment_mode, null); assert.equal(after.token_is_null, 0);
  assert.deepEqual(ledger.initial.legacyMoney, { totalCents: 10001, reservationCents: 4900, balanceCents: 5101, currency: 'USD' });
  assert.deepEqual(ledger.initial.snapshot.schedules.map(row => [row.kind, row.amount_cents]), [['RESERVATION', 4900], ['BALANCE', 5101]]);
  assertNoFinancialSideEffects(ledger.initial.snapshot);
});

for (const mode of ['retainer_50', 'full_upfront', 'fixed_49_reservation'] as const) {
  test(`actual Application -> SQLite persists ${mode}; process restart replays/reconciles without another agreement`, async () => {
    const f = await operationFixture(mode), beforeSource = structuredClone(f.sourceRecord);
    const first = ledger.invoke(request(f.operation)); response(first, 201);
    const receipt = assertPersisted(first, f.operation, first.response!.body), committed = first.snapshot;
    // Every invocation is a fresh PHP process over the same actual ledger.
    const replay = ledger.invoke(request(f.operation)); response(replay, 200);
    assert.deepEqual(JSON.parse(replay.response!.body), receipt); assert.deepEqual(replay.snapshot, committed);
    const reconciliation = ledger.invoke(request(f.operation, { path: '/internal/v2/payment-agreements/reconcile',
      body: canonical({ operationId: f.operation.operationId, operationDigest: digest(f.operation) }) }));
    response(reconciliation, 200); assert.deepEqual(JSON.parse(reconciliation.response!.body), receipt);
    assert.deepEqual(reconciliation.snapshot, committed);
    const changed = structuredClone(f.operation); changed.service.name += ' altered';
    const conflict = ledger.invoke(request(changed));
    assert.deepEqual(response(conflict, 409), { status: 'idempotency_conflict' }); assert.deepEqual(conflict.snapshot, committed);
    assert.deepEqual(f.sourceRecord, beforeSource);
  });
}

test('a 50 percent amount equal to USD 49 remains a retainer, and full upfront is valid below the v1 reservation threshold', async () => {
  for (const [mode, total] of [['retainer_50', 9800], ['full_upfront', 1]] as const) {
    const f = await operationFixture(mode, `${mode}-independent-v1-minimum`, total);
    const result = ledger.invoke(request(f.operation)); response(result, 201);
    const receipt = assertPersisted(result, f.operation, result.response!.body);
    const row = result.snapshot.agreements.find(row => row.public_uuid === receipt.agreementId)!;
    assert.equal(row.reservation_cents, null);
    assert.ok(result.snapshot.schedules.filter(row => row.agreement_uuid === receipt.agreementId).every(row => row.kind !== 'RESERVATION'));
  }
});

test('new route opt-in never enables original v1; original bearer checks and precise request errors write nothing', async () => {
  const { operation } = await operationFixture('retainer_50', 'rejection-base');
  const before = ledger.invoke({ action: 'snapshot' }).snapshot;
  const normal = request(operation), headers = normal.headers;
  const cases: [string, Record<string, unknown>, NodeJS.ProcessEnv, number, string][] = [
    ['v2 off', normal, { INTERNAL_V2_ENABLED: 'false' }, 404, 'not_found'],
    ['empty secret', normal, { INTERNAL_API_SHARED_SECRET: '' }, 404, 'not_found'],
    ['missing bearer', { ...normal, headers: { ...headers, authorization: '' } }, {}, 404, 'not_found'],
    ['wrong bearer', { ...normal, headers: { ...headers, authorization: 'Bearer synthetic-wrong' } }, {}, 404, 'not_found'],
    ['v1 remains off', { ...normal, path: '/internal/v1/payment-agreements' }, {}, 404, 'not_found'],
    ['method', { ...normal, method: 'GET' }, {}, 405, 'method_not_allowed'],
    ['mime', { ...normal, headers: { ...headers, 'content-type': 'application/json-invalid' } }, {}, 415, 'invalid_request'],
    ['key binding', { ...normal, headers: { ...headers, 'idempotency-key': 'synthetic-unbound-key' } }, {}, 400, 'invalid_request'],
    ['malformed body', { ...normal, body: '{}' }, {}, 422, 'invalid_request'],
    ['noncanonical body', { ...normal, body: ' ' + normal.body }, {}, 422, 'invalid_request'],
    ['production gate', { ...normal, production: true }, {}, 503, 'draft_execution_disabled'],
    ['missing replay encryption', normal, { PAYMENT_LINK_ENCRYPTION_KEY: '' }, 503, 'request_unavailable'],
  ];
  for (const [name, input, env, status, code] of cases) {
    const result = ledger.invoke(input, env);
    assert.deepEqual(response(result, status), { status: code }, name); assert.deepEqual(result.snapshot, before, name);
  }
  const unknown = await operationFixture('full_upfront', 'unknown-reconciliation');
  const absent = ledger.invoke(request(unknown.operation, { path: '/internal/v2/payment-agreements/reconcile',
    body: canonical({ operationId: unknown.operation.operationId, operationDigest: digest(unknown.operation) }) }));
  assert.deepEqual(response(absent, 404), { status: 'not_found' }); assert.deepEqual(absent.snapshot, before);
});

test('fresh server assertion binds the exact actor, scope and operation; invalid or missing assertions never reach SQLite', async () => {
  const { operation } = await operationFixture('retainer_50', 'assertions');
  const before = ledger.invoke({ action: 'snapshot' }).snapshot;
  const now = Date.now(), valid = authorization(operation, now);
  const assertions = [null, { ...valid, actorId: '' }, { ...valid, issuer: 'browser' },
    { ...valid, purpose: 'charge_customer' }, { ...valid, operationId: '0'.repeat(64) },
    { ...valid, operationDigest: '0'.repeat(64) }, { ...valid, scope: { ...testScope, workspaceId: 'OTHER' } },
    { ...valid, issuedAtMs: now + 60_000 }, { ...valid, issuedAtMs: now - 60_000, expiresAtMs: now - 1 },
    { ...valid, expiresAtMs: valid.issuedAtMs + 300_001 }, { ...valid, issuedAtMs: 1.5 }];
  for (const auth of assertions) {
    const result = ledger.invoke(request(operation, { body: canonical({ operation, authorization: auth }) }));
    assert.deepEqual(response(result, 422), { status: 'invalid_request' }); assert.deepEqual(result.snapshot, before);
  }
});

test('rehashed incompatible amounts, conditions, calendars and approval still reject before any persistence', async () => {
  const f = await operationFixture('retainer_50', 'incompatible'), before = ledger.invoke({ action: 'snapshot' }).snapshot;
  const mutations: ((operation: any) => void)[] = [
    o => { o.prepared.plan.initialPaymentCents = 4900; o.prepared.plan.paymentBalanceCents = 5101; },
    o => { o.prepared.plan.sourceQuote.totalCents += 0.5; },
    o => { o.prepared.plan.sourceQuote.depositBasis.basisPoints = 4900; },
    o => { o.prepared.plan.paymentTerms = ''; },
    o => { o.prepared.plan.termsChangeReason = null; },
    o => { o.prepared.plan.paymentSchedule = null; },
    o => { o.prepared.plan.paymentSchedule.configured.timezone = 'EST'; },
    o => { o.prepared.plan.paymentSchedule.configured.eventTime = null; },
    o => { o.prepared.plan.linkExpiration.instant = '2020-01-01T00:00:00Z'; },
    o => { o.prepared.internalApproval = null; },
    o => { o.recipient.email = 'browser-injected@example.test'; },
  ];
  for (const mutate of mutations) {
    const operation: any = structuredClone(f.operation); mutate(operation);
    operation.prepared.reviewDigest = digest(operation.prepared.plan);
    if (operation.prepared.internalApproval) operation.prepared.internalApproval.reviewDigest = operation.prepared.reviewDigest;
    const result = ledger.invoke(request(operation));
    assert.deepEqual(response(result, 422), { status: 'invalid_request' }); assert.deepEqual(result.snapshot, before);
  }
  // A coherent commercial scope remains disabled independently of bearer.
  const commercial = structuredClone(f.operation);
  commercial.prepared.plan.scope = { ...commercial.prepared.plan.scope, mode: 'commercial' };
  commercial.prepared.plan.preparationId = 'payment-contract-v2-' + digest({ contractVersion: 2,
    scope: commercial.prepared.plan.scope, eventId: commercial.prepared.plan.eventId,
    quoteVersion: commercial.prepared.plan.sourceQuote.version, quoteDigest: commercial.prepared.plan.sourceQuote.digest,
    approvalDigest: commercial.prepared.plan.sourceQuote.approvalDigest, paymentMode: commercial.prepared.plan.paymentMode });
  commercial.prepared.reviewDigest = digest(commercial.prepared.plan);
  commercial.prepared.internalApproval.reviewDigest = commercial.prepared.reviewDigest;
  commercial.operationId = paymentAgreementOperationIdV2(commercial.prepared.plan.scope, commercial.prepared.plan.eventId,
    commercial.configurationId, commercial.configurationDigest, commercial.prepared.plan.preparationDigest);
  const blocked = ledger.invoke(request(commercial));
  assert.deepEqual(response(blocked, 503), { status: 'draft_execution_disabled' }); assert.deepEqual(blocked.snapshot, before);
});

test('real service callback sees inserted draft then throws; its SQLite transaction rolls back agreement, schedules and audit together', async () => {
  const { operation } = await operationFixture('retainer_50', 'rollback');
  const result = ledger.invoke({ action: 'rollback', body: envelope(operation) });
  assert.equal(result.callbackCalls, 1); assert.deepEqual(result.seenInside, { status: 'DRAFT_INTERNAL', token_is_null: 1 });
  assert.equal(result.transactionOpen, false); assert.deepEqual(result.snapshot, result.before);
  assertNoFinancialSideEffects(result.snapshot);
});

test('Application failure after guard and encrypted receipt rolls back the entire intent; the same operation can retry once', async () => {
  const { operation } = await operationFixture('retainer_50', 'application-transaction-rollback');
  const before = ledger.invoke({ action: 'install_audit_failure' }).snapshot;
  try {
    const failed = ledger.invoke(request(operation));
    assert.deepEqual(response(failed, 503), { status: 'request_unavailable' });
    assert.deepEqual(failed.snapshot, before, 'A failed Application commit must not leave an orphan idempotency key or any draft rows');
    assert.equal(failed.snapshot.idempotency.filter(row => row.idempotency_key === paymentAgreementIdempotencyKeyV2(operation.operationId)).length, 0);
  } finally { ledger.invoke({ action: 'remove_audit_failure' }); }
  const retry = ledger.invoke(request(operation)); response(retry, 201);
  const receipt = assertPersisted(retry, operation, retry.response!.body);
  assert.equal(retry.snapshot.counts.payment_agreements, before.counts.payment_agreements + 1);
  assert.equal(retry.snapshot.counts.payment_schedules, before.counts.payment_schedules + 2);
  assert.equal(retry.snapshot.counts.idempotency_keys, before.counts.idempotency_keys + 1);
  const replay = ledger.invoke(request(operation)); response(replay, 200);
  assert.deepEqual(decodePaymentAgreementReceiptV2(replay.response!.body, operation), receipt);
  assert.deepEqual(replay.snapshot, retry.snapshot);
});

test('actual Migrator atomically rolls back a late 0006 rebuild fault; reopening the file preserves v1 rows and permits a clean retry', () => {
  const result = ledger.invoke({ action: 'migration_fault' }).migrationFault!;
  assert.equal(result.failed, true); assert.equal(result.transactionOpen, false);
  assert.deepEqual(result.afterFailure, result.before, 'Late migration failure must preserve the complete prior schema, data, FKs and migration receipts durably');
  assert.equal(result.afterFailure.foreignKeys, 1); assert.deepEqual(result.afterFailure.foreignKeyViolations, []);
  assert.equal(result.afterFailure.migrations.some((row: any) => row.version === '0006_versioned_payment_agreement_drafts.sql'), false);
  assert.deepEqual(result.applied, ['0006_versioned_payment_agreement_drafts.sql']); assert.deepEqual(result.reapplied, []);
  assert.equal(result.afterSuccess.agreements.length, 1); assert.equal(result.afterSuccess.agreements[0].contract_version, 1);
  for (const [key, value] of Object.entries(result.before.agreements[0])) assert.equal(result.afterSuccess.agreements[0][key], value);
  assert.deepEqual(result.afterSuccess.schedules, result.before.schedules);
  assert.equal(result.afterSuccess.foreignKeys, 1); assert.deepEqual(result.afterSuccess.foreignKeyViolations, []);
});

test('real loopback HTTP parses Content-Type through original Request; restarted Application reconciles the committed SQLite agreement', async () => {
  const receiver = await startOperationalPaymentReceiverV2();
  try {
    const { operation } = await operationFixture('fixed_49_reservation', 'http');
    const headers = { authorization: `Bearer ${receiver.sharedSecret}`, 'content-type': 'application/json',
      'idempotency-key': paymentAgreementIdempotencyKeyV2(operation.operationId) };
    const first = await fetch(`${receiver.baseUrl}/internal/v2/payment-agreements`, { method: 'POST', headers, body: envelope(operation) });
    assert.equal(first.status, 201); const body = await first.text(), receipt = decodePaymentAgreementReceiptV2(body, operation);
    const before = await receiver.inspect();
    assert.equal(before.agreements.length, 1); assert.equal(before.agreements[0].public_uuid, receipt.agreementId);
    assertNoFinancialSideEffects(before); assert.equal(before.providerCalls, 0);
    await receiver.restart();
    const replay = await fetch(`${receiver.baseUrl}/internal/v2/payment-agreements/reconcile`, { method: 'POST', headers,
      body: canonical({ operationId: operation.operationId, operationDigest: digest(operation) }) });
    assert.equal(replay.status, 200); assert.deepEqual(decodePaymentAgreementReceiptV2(await replay.text(), operation), receipt);
    assert.deepEqual(await receiver.inspect(), before);
  } finally { await receiver.close(); }
});
