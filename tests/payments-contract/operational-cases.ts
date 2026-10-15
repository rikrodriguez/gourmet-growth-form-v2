import assert from 'node:assert/strict';
import { canonical, digest } from '../../src/office/backend/event-quote-workflow';
import { prepareGourmetPaymentsAgreementV2, reviewGourmetPaymentsAgreementV2 } from '../../src/office/backend/gourmet-payments-agreement-v2';
import { createPaymentAgreementOperationV2, decodePaymentAgreementReceiptV2, paymentAgreementIdempotencyKeyV2,
  type PaymentAgreementAuthorizationV2, type PaymentAgreementOperationV2 } from '../../src/office/backend/payment-agreement-operations-v2';
import type { PaymentContractModeV2 } from '../../src/office/backend/event-quote-contracts';
import { TEST_AT, testActor, testBrief, testCatalog, testScope, testService } from '../office/event-quote-fixtures';
import { operationalFixtureSharedSecret,
  type OperationalFixtureV2, type OperationalLedgerSnapshotV2 } from './php-operational-receiver';

const paymentTerms = 'Condiciones sintéticas aprobadas.\r\nUnicode café 🥘; espacios:  dos; / y \\; \u2028\u2029.';
const termsReason = 'Revisión explícita sintética de condiciones; no autoriza cobros.';
export async function operationFixture(mode: PaymentContractModeV2 = 'retainer_50', suffix: string = mode, total = 10001, bps = 5000) {
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
export function authorization(operation: PaymentAgreementOperationV2, nowMs = Date.now()): PaymentAgreementAuthorizationV2 {
  return { issuer: 'gourmet_office', purpose: 'create_disabled_payment_agreement_v2', actorId: 'SYNTHETIC-CURRENT-OPERATOR',
    scope: operation.prepared.plan.scope, operationId: operation.operationId, operationDigest: digest(operation),
    issuedAtMs: nowMs - 1000, expiresAtMs: nowMs + 60_000 };
}
export function envelope(operation: PaymentAgreementOperationV2, auth = authorization(operation)) { return canonical({ operation, authorization: auth }); }
export function request(operation: PaymentAgreementOperationV2, extra: Record<string, unknown> = {}) {
  return { action: 'route', body: envelope(operation), headers: { authorization: `Bearer ${operationalFixtureSharedSecret}`,
    'content-type': 'application/json; charset=utf-8', 'idempotency-key': paymentAgreementIdempotencyKeyV2(operation.operationId) }, ...extra };
}
export function response(result: ReturnType<OperationalFixtureV2['invoke']>, expected: number) {
  assert.ok(result.response); assert.equal(result.response.status, expected, result.response.body);
  return JSON.parse(result.response.body);
}
function sqlInstant(utc: string | null) { return utc === null ? null : utc.replace('T', ' ').replace('Z', '.000000'); }
export function assertNoFinancialSideEffects(snapshot: OperationalLedgerSnapshotV2) {
  for (const table of ['payment_attempts', 'payment_consents', 'provider_resources', 'provider_webhook_events', 'email_outbox', 'monday_sync_outbox', 'sales_os_event_outbox'])
    assert.equal(snapshot.counts[table], 0, `${table} must remain empty for internal drafts`);
  for (const row of snapshot.agreements.filter(row => row.contract_version === 2)) {
    assert.equal(row.provider, null); assert.equal(row.public_token_hash, null); assert.equal(row.token_is_null, 1);
    assert.equal(row.status, 'DRAFT_INTERNAL');
  }
}
export function assertPersisted(result: ReturnType<OperationalFixtureV2['invoke']>, operation: PaymentAgreementOperationV2, receiptBody: string) {
  const receipt = decodePaymentAgreementReceiptV2(receiptBody, operation), plan = operation.prepared.plan;
  const row = result.snapshot.agreements.find(row => row.public_uuid === receipt.agreementId);
  assert.ok(row, 'Receipt must identify an actual agreement row');
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
  assert.equal(initial.due_at_utc, row.created_at);
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
