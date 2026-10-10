import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_PAYMENT_CENTS,
  registerInvoice,
  applyConfirmedPayment,
  buildReconciliationReport,
} from '../../src/operations/payments.mjs';

function emptyState() {
  return { leads: {}, closers: {}, assignments: {}, callEvents: {}, payments: {}, invoices: {}, exceptions: {} };
}

function invoiceInput(overrides = {}) {
  return {
    invoiceId: 'fixture-invoice-1', eventId: 'fixture-gourmet-event-1', currency: 'USD',
    totalCents: 10_000, provider: 'fixture-provider', providerInvoiceId: 'fixture-external-invoice-1',
    ...overrides,
  };
}

function paymentInput(overrides = {}) {
  return {
    provider: 'fixture-provider', eventId: 'fixture-webhook-1', transactionId: 'fixture-transaction-1',
    providerInvoiceId: 'fixture-external-invoice-1', gourmetEventId: 'fixture-gourmet-event-1',
    invoiceId: 'fixture-invoice-1', amountCents: 2_500, currency: 'USD', status: 'confirmed',
    occurredAtMs: 5_000,
    ...overrides,
  };
}

function readyState(input = invoiceInput()) {
  const state = emptyState();
  registerInvoice(state, input);
  return state;
}

function pay(state, overrides = {}, nowMs = 7_000) {
  return applyConfirmedPayment(state, paymentInput(overrides), { nowMs });
}

function money(state, invoiceId = 'fixture-invoice-1') {
  const invoice = state.invoices[invoiceId];
  return { totalCents: invoice.totalCents, paidCents: invoice.paidCents, balanceCents: invoice.balanceCents };
}

function assertExceptionWithoutMoneyChange(state, overrides, expectedReason, nowMs = 7_000) {
  const before = structuredClone(state.invoices);
  const result = pay(state, overrides, nowMs);
  assert.equal(result.status, 'exception');
  assert.equal(result.creditedCents, 0);
  assert.equal(result.requiresHumanReview, true);
  if (expectedReason) assert.equal(result.reason, expectedReason);
  assert.deepEqual(state.invoices, before);
  assert.equal(state.exceptions[result.exceptionId].status, 'open');
  return result;
}

test('trusted invoice registration validates exact cents and never changes a conflicting binding', () => {
  const state = emptyState();
  assert.equal(registerInvoice(state, invoiceInput()).status, 'registered');
  assert.deepEqual(money(state), { totalCents: 10_000, paidCents: 0, balanceCents: 10_000 });
  assert.equal(registerInvoice(state, invoiceInput()).status, 'duplicate');
  assert.equal(registerInvoice(state, invoiceInput({ totalCents: 11_000 })).status, 'updated');
  assert.equal(state.invoices['fixture-invoice-1'].balanceCents, 11_000);
  const before = structuredClone(state.invoices);
  for (const changes of [{ eventId: 'another-event' }, { providerInvoiceId: 'another-external-invoice' }]) {
    assert.throws(() => registerInvoice(state, invoiceInput(changes)), { code: 'invoice_binding_conflict' });
    assert.deepEqual(state.invoices, before);
  }
  assert.throws(() => registerInvoice(state, invoiceInput({ invoiceId: 'another-invoice' })), { code: 'ambiguous_provider_invoice' });
  for (const totalCents of [0, -1, 1.5, '100', NaN, Infinity, MAX_PAYMENT_CENTS + 1, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => registerInvoice(emptyState(), invoiceInput({ totalCents })), { code: 'invalid_total_cents' });
  }
  assert.throws(() => registerInvoice(emptyState(), invoiceInput({ currency: 'EUR' })), { code: 'unsupported_currency' });
});

test('two exact partial payments settle once, preserve cents and freeze the invoice amount', () => {
  const state = readyState();
  const first = pay(state);
  assert.equal(first.status, 'confirmed');
  assert.equal(first.creditedCents, 2_500);
  assert.deepEqual(money(state), { totalCents: 10_000, paidCents: 2_500, balanceCents: 7_500 });
  const second = pay(state, { eventId: 'fixture-webhook-2', transactionId: 'fixture-transaction-2', amountCents: 7_500 });
  assert.equal(second.status, 'confirmed');
  assert.deepEqual(money(state), { totalCents: 10_000, paidCents: 10_000, balanceCents: 0 });
  assert.equal(state.invoices['fixture-invoice-1'].receiptIds.length, 2);
  assert.throws(() => registerInvoice(state, invoiceInput({ totalCents: 11_000 })), { code: 'invoice_amount_immutable_after_receipt' });
  assertExceptionWithoutMoneyChange(state, { eventId: 'fixture-webhook-3', transactionId: 'fixture-transaction-3', amountCents: 1 }, 'overpayment');
});

test('replayed event and new webhook ID for same transaction do not credit or return stale balances', () => {
  const state = readyState();
  const first = pay(state);
  pay(state, { eventId: 'fixture-webhook-2', transactionId: 'fixture-transaction-2', amountCents: 500 });
  const before = structuredClone(state.invoices);
  const replay = pay(state, {}, 9_000);
  assert.equal(replay.status, 'duplicate');
  assert.equal(replay.creditedCents, 0);
  assert.equal(replay.receiptId, first.receiptId);
  assert.equal(replay.invoice.paidCents, 3_000);
  assert.equal(replay.invoice.balanceCents, 7_000);
  const newNotification = pay(state, { eventId: 'fixture-webhook-1-repeat' }, 10_000);
  assert.equal(newNotification.status, 'duplicate');
  assert.equal(newNotification.invoice.paidCents, 3_000);
  assert.equal(newNotification.creditedCents, 0);
  assert.deepEqual(state.invoices, before);
  assert.equal(Object.values(state.payments.transactions).filter((receipt) => receipt.status === 'confirmed').length, 2);
  assert.equal(Object.keys(state.payments.events).length, 3);
});

test('changed payload under an existing provider event or transaction creates an immediate exception', () => {
  const state = readyState();
  pay(state);
  assertExceptionWithoutMoneyChange(state, { amountCents: 3_000 }, 'provider_event_collision');
  for (const changes of [
    { amountCents: 3_000 },
    { invoiceId: 'other-invoice' },
    { gourmetEventId: 'other-event' },
    { providerInvoiceId: 'other-provider-invoice' },
    { occurredAtMs: 4_999 },
  ]) {
    assertExceptionWithoutMoneyChange(state, { ...changes, eventId: `different-${Object.keys(changes)[0]}` }, 'provider_transaction_collision');
  }
  assert.equal(Object.values(state.payments.transactions).filter((receipt) => receipt.status === 'confirmed').length, 1);
});

test('all four invoice/event binding identifiers must match a unique trusted invoice', () => {
  const cases = [
    [{ provider: 'unknown-provider' }, 'unmapped_provider_invoice'],
    [{ providerInvoiceId: 'unknown-external' }, 'unmapped_provider_invoice'],
    [{ invoiceId: 'unknown-internal' }, 'unmapped_internal_invoice'],
    [{ gourmetEventId: 'wrong-gourmet-event' }, 'invoice_mapping_mismatch'],
    [{ transactionId: undefined }, 'invalid_transactionId'],
    [{ gourmetEventId: undefined }, 'invalid_gourmetEventId'],
  ];
  for (const [changes, reason] of cases) assertExceptionWithoutMoneyChange(readyState(), changes, reason);
  const crossInvoice = readyState();
  registerInvoice(crossInvoice, invoiceInput({ invoiceId: 'fixture-invoice-2', eventId: 'fixture-gourmet-event-2', providerInvoiceId: 'fixture-external-invoice-2' }));
  assertExceptionWithoutMoneyChange(crossInvoice, { invoiceId: 'fixture-invoice-2', gourmetEventId: 'fixture-gourmet-event-2' }, 'invoice_mapping_mismatch');
  const ambiguous = readyState();
  ambiguous.invoices['fixture-corrupt-duplicate'] = { ...structuredClone(ambiguous.invoices['fixture-invoice-1']), invoiceId: 'fixture-corrupt-duplicate' };
  assertExceptionWithoutMoneyChange(ambiguous, {}, 'ambiguous_provider_invoice');
});

test('invalid amounts, unsupported currency and invalid provider timestamps never change money', () => {
  for (const amountCents of [0, -1, 1.2, '2500', NaN, Infinity, MAX_PAYMENT_CENTS + 1, Number.MAX_SAFE_INTEGER]) {
    assertExceptionWithoutMoneyChange(readyState(), { amountCents }, 'invalid_amount_cents');
  }
  assertExceptionWithoutMoneyChange(readyState(), { currency: 'EUR' }, 'unsupported_currency');
  for (const occurredAtMs of [undefined, null, -1, 1.1, '5000', 7_001, Infinity]) {
    assertExceptionWithoutMoneyChange(readyState(), { occurredAtMs }, 'invalid_occurred_at');
  }
  assert.throws(() => pay(readyState(), {}, -1), { code: 'invalid_now_ms' });
  const cap = readyState(invoiceInput({ totalCents: MAX_PAYMENT_CENTS }));
  assert.equal(pay(cap, { amountCents: MAX_PAYMENT_CENTS }).status, 'confirmed');
  assert.deepEqual(money(cap), { totalCents: MAX_PAYMENT_CENTS, paidCents: MAX_PAYMENT_CENTS, balanceCents: 0 });
});

test('pending/failed/refunded events never credit or reverse; later valid confirmation can be assessed', () => {
  for (const status of ['pending', 'failed', 'refunded', 'chargeback']) {
    assertExceptionWithoutMoneyChange(readyState(), { status }, 'unsupported_payment_status');
  }
  const state = readyState();
  const pending = assertExceptionWithoutMoneyChange(state, { status: 'pending' }, 'unsupported_payment_status');
  assert.equal(Object.keys(state.payments.transactions).length, 0);
  assert.equal(pay(state, { eventId: 'fixture-confirmed-webhook' }).status, 'confirmed');
  assert.equal(state.exceptions[pending.exceptionId].status, 'open');
  assertExceptionWithoutMoneyChange(state, { status: 'refunded', eventId: 'fixture-refund-webhook' }, 'unsupported_payment_status');
  assert.equal(state.invoices['fixture-invoice-1'].paidCents, 2_500);
  // A provider may not rewrite the content of its already consumed event ID.
  assertExceptionWithoutMoneyChange(state, {}, 'provider_event_collision');
});

test('rejected confirmed mapping or overpayment requires human review, with deterministic exception replay', () => {
  const state = readyState();
  const rejected = assertExceptionWithoutMoneyChange(state, { amountCents: 10_001 }, 'overpayment');
  const replay = assertExceptionWithoutMoneyChange(state, { amountCents: 10_001 }, 'overpayment', 9_000);
  assert.equal(replay.exceptionId, rejected.exceptionId);
  assert.equal(replay.duplicate, true);
  assert.equal(Object.keys(state.exceptions).length, 1);
  assert.equal(state.exceptions[rejected.exceptionId].recordedAtMs, 7_000);
  assertExceptionWithoutMoneyChange(state, { eventId: 'fixture-corrected-webhook', amountCents: 2_500 }, 'provider_transaction_collision');
  assert.equal(state.invoices['fixture-invoice-1'].paidCents, 0);
});

test('provider-scoped transaction/event IDs can be identical without cross-crediting invoices', () => {
  const state = readyState();
  registerInvoice(state, invoiceInput({ invoiceId: 'fixture-invoice-2', eventId: 'fixture-gourmet-event-2', provider: 'fixture-provider-two' }));
  pay(state);
  const second = pay(state, { provider: 'fixture-provider-two', invoiceId: 'fixture-invoice-2', gourmetEventId: 'fixture-gourmet-event-2' });
  assert.equal(second.status, 'confirmed');
  assert.equal(state.invoices['fixture-invoice-1'].paidCents, 2_500);
  assert.equal(state.invoices['fixture-invoice-2'].paidCents, 2_500);
  assert.equal(Object.keys(state.payments.transactions).length, 2);
});

test('ledger corruption fails closed instead of adding money or hiding receipts in reports', () => {
  const corruptedMoney = readyState();
  pay(corruptedMoney);
  corruptedMoney.invoices['fixture-invoice-1'].paidCents = 0;
  corruptedMoney.invoices['fixture-invoice-1'].balanceCents = 10_000;
  assertExceptionWithoutMoneyChange(corruptedMoney, { eventId: 'fixture-new-webhook', transactionId: 'fixture-new-transaction' }, 'invoice_mapping_mismatch');
  assertExceptionWithoutMoneyChange(corruptedMoney, {}, 'invoice_integrity_error');
  assert.throws(() => buildReconciliationReport(corruptedMoney, { fromMs: 0, toMs: 10_000 }), { code: 'invoice_integrity_error' });

  for (const corrupt of [
    (state, receipt) => { receipt.occurredAtMs = undefined; },
    (state, receipt) => { receipt.receivedAtMs = -1; },
    (state, receipt) => { receipt.transactionId = 'corrupted-transaction'; },
    (state, receipt) => { receipt.amountCents = 2_500.5; },
    (state) => { state.invoices['fixture-invoice-1'].receiptIds = []; },
    (state) => { delete state.invoices['fixture-invoice-1']; },
  ]) {
    const state = readyState();
    pay(state);
    const receipt = Object.values(state.payments.transactions)[0];
    corrupt(state, receipt);
    assert.throws(() => buildReconciliationReport(state, { fromMs: 0, toMs: 10_000 }), { code: 'receipt_integrity_error' });
  }
});

test('weekly report uses half-open settlement period, exposes late receipts and open older exceptions, and stays read-only', () => {
  const state = readyState();
  const week = 604_800_000;
  pay(state, { amountCents: 100, occurredAtMs: 0 }, 100);
  pay(state, { amountCents: 200, eventId: 'fixture-late-webhook', transactionId: 'fixture-late-transaction', occurredAtMs: week - 1 }, week + 5_000);
  pay(state, { amountCents: 300, eventId: 'fixture-next-week-webhook', transactionId: 'fixture-next-week-transaction', occurredAtMs: week }, week + 6_000);
  const oldException = assertExceptionWithoutMoneyChange(state, { status: 'pending', eventId: 'fixture-old-exception' }, 'unsupported_payment_status', 7_000);
  const before = structuredClone(state);
  const report = buildReconciliationReport(state, { fromMs: 0, toMs: week });
  assert.equal(report.status, 'reconciliation_human_required');
  assert.equal(report.cadence, 'weekly');
  assert.equal(report.confirmedCents, 300);
  assert.equal(report.receiptCount, 2);
  assert.deepEqual(report.receipts.map((receipt) => receipt.amountCents), [100, 200]);
  assert.equal(report.receipts[1].receivedAtMs, week + 5_000);
  assert.equal(report.invoices[0].paidCents, 600);
  assert.equal(report.openExceptionCount, 1);
  assert.deepEqual(buildReconciliationReport(state, { fromMs: 0, toMs: week }), report);
  assert.deepEqual(state, before);
  report.invoices[0].paidCents = 999;
  report.exceptions[0].status = 'closed';
  assert.deepEqual(state, before);
  const nextWeek = buildReconciliationReport(state, { fromMs: week, toMs: week * 2 });
  assert.equal(nextWeek.confirmedCents, 300);
  assert.equal(nextWeek.exceptions[0].exceptionId, oldException.exceptionId);
  assert.equal(nextWeek.exceptions[0].recordedInPeriod, false);
  assert.equal(nextWeek.openExceptionCount, 1);
  assert.equal(state.exceptions[oldException.exceptionId].status, 'open');
});

test('empty report still requires human reconciliation; invalid period and state are rejected', () => {
  const state = readyState();
  const before = structuredClone(state);
  const report = buildReconciliationReport(state, { fromMs: 0, toMs: 604_800_000 });
  assert.equal(report.confirmedCents, 0);
  assert.equal(report.receiptCount, 0);
  assert.equal(report.status, 'reconciliation_human_required');
  assert.deepEqual(state, before);
  for (const period of [{}, { fromMs: 1, toMs: 1 }, { fromMs: -1, toMs: 1 }, { fromMs: 0, toMs: 1.5 }]) {
    assert.throws(() => buildReconciliationReport(state, period), { code: 'invalid_reconciliation_period' });
  }
  assert.throws(() => registerInvoice({ invoices: [] }, invoiceInput()), TypeError);
});

test('null-prototype persisted maps and prototype-looking identifiers cannot alias stored records', () => {
  const state = emptyState();
  state.invoices = Object.create(null);
  state.payments = Object.create(null);
  state.exceptions = Object.create(null);
  registerInvoice(state, invoiceInput({ invoiceId: 'constructor' }));
  assert.equal(pay(state, { invoiceId: 'constructor' }).status, 'confirmed');
  assert.equal(Object.hasOwn(state.invoices, 'constructor'), true);
  assert.equal(buildReconciliationReport(state, { fromMs: 0, toMs: 10_000 }).confirmedCents, 2_500);
  assert.throws(() => registerInvoice(state, invoiceInput({ invoiceId: '__proto__' })), { code: 'invalid_invoiceId' });
});
