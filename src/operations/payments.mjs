import { createHash } from 'node:crypto';

export const MAX_PAYMENT_CENTS = 1_000_000_000;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const PAYMENT_FIELDS = [
  'provider', 'eventId', 'transactionId', 'providerInvoiceId',
  'gourmetEventId', 'invoiceId', 'amountCents', 'currency', 'status', 'occurredAtMs',
];

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isId(value) {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

function isCents(value, allowZero = false) {
  return Number.isSafeInteger(value) && value >= (allowZero ? 0 : 1) && value <= MAX_PAYMENT_CENTS;
}

function isTimestamp(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function assertState(state) {
  if (!isRecord(state) || !isRecord(state.invoices) || !isRecord(state.payments) || !isRecord(state.exceptions)) {
    throw new TypeError('State requires invoices, payments and exceptions records.');
  }
  for (const key of ['events', 'transactions']) {
    if (state.payments[key] !== undefined && !isRecord(state.payments[key])) {
      throw new TypeError(`payments.${key} must be a record.`);
    }
  }
}

function put(record, key, value) {
  Object.defineProperty(record, key, { value, writable: true, configurable: true, enumerable: true });
}

function own(record, key) {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function scalar(value) {
  if (value === undefined) return ['undefined'];
  if (typeof value === 'number' && !Number.isFinite(value)) return ['number', String(value)];
  if (typeof value === 'bigint') return ['bigint', String(value)];
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
  return ['invalid_type', typeof value];
}

function fingerprints(input) {
  const payload = PAYMENT_FIELDS.map((key) => [key, scalar(input[key])]);
  return {
    eventDigest: digest(payload),
    // A provider transaction has one immutable payment payload. Its webhook IDs may differ.
    transactionDigest: digest(payload.filter(([key]) => key !== 'eventId')),
  };
}

function paymentMaps(state) {
  state.payments.events ??= {};
  state.payments.transactions ??= {};
  return state.payments;
}

function summary(invoice) {
  return {
    invoiceId: invoice.invoiceId,
    gourmetEventId: invoice.eventId,
    currency: invoice.currency,
    totalCents: invoice.totalCents,
    paidCents: invoice.paidCents,
    balanceCents: invoice.balanceCents,
  };
}

function invoiceIntegrity(invoice) {
  return isRecord(invoice)
    && isId(invoice.invoiceId) && isId(invoice.eventId) && isId(invoice.provider) && isId(invoice.providerInvoiceId)
    && invoice.currency === 'USD'
    && isCents(invoice.totalCents) && isCents(invoice.paidCents, true) && isCents(invoice.balanceCents, true)
    && invoice.paidCents + invoice.balanceCents === invoice.totalCents
    && Array.isArray(invoice.receiptIds)
    && invoice.receiptIds.every(isId)
    && new Set(invoice.receiptIds).size === invoice.receiptIds.length;
}

function ledgerIntegrity(state, invoice) {
  if (!invoiceIntegrity(invoice)) return false;
  const transactions = state.payments.transactions ?? {};
  let paidCents = 0;
  for (const receiptId of invoice.receiptIds) {
    const receipt = own(transactions, receiptId);
    if (!receiptIntegrity(state, receiptId, receipt)
      || receipt.invoiceId !== invoice.invoiceId || receipt.gourmetEventId !== invoice.eventId
      || receipt.provider !== invoice.provider || receipt.providerInvoiceId !== invoice.providerInvoiceId
      || receipt.currency !== invoice.currency || !isCents(receipt.amountCents)) return false;
    paidCents += receipt.amountCents;
    if (!Number.isSafeInteger(paidCents) || paidCents > invoice.totalCents) return false;
  }
  return paidCents === invoice.paidCents;
}

function receiptIntegrity(state, receiptId, receipt) {
  if (!isRecord(receipt) || receipt.status !== 'confirmed' || receipt.receiptId !== receiptId
    || !isId(receipt.provider) || !isId(receipt.transactionId) || !isId(receipt.providerInvoiceId)
    || !isId(receipt.invoiceId) || !isId(receipt.gourmetEventId) || !isId(receipt.sourceEventId)
    || receipt.currency !== 'USD' || !isCents(receipt.amountCents)
    || !isTimestamp(receipt.occurredAtMs) || !isTimestamp(receipt.receivedAtMs)
    || receipt.occurredAtMs > receipt.receivedAtMs
    || receiptId !== `provider-transaction-${digest([receipt.provider, receipt.transactionId])}`) return false;
  const invoice = own(state.invoices, receipt.invoiceId);
  if (!invoiceIntegrity(invoice) || !invoice.receiptIds.includes(receiptId)
    || invoice.eventId !== receipt.gourmetEventId || invoice.provider !== receipt.provider
    || invoice.providerInvoiceId !== receipt.providerInvoiceId || invoice.currency !== receipt.currency) return false;
  return fingerprints({ ...receipt, eventId: receipt.sourceEventId }).transactionDigest === receipt.transactionDigest;
}

// A case-scoped reader: verify this invoice and its receipts without initializing
// payment maps, inspecting unrelated ledgers, or changing any persisted state.
export function readVerifiedInvoiceLedger(state, invoiceId) {
  if (!isId(invoiceId) || !isRecord(state) || !isRecord(state.invoices) || !isRecord(state.payments)
    || (state.payments.transactions !== undefined && !isRecord(state.payments.transactions))) return null;
  const invoice = own(state.invoices, invoiceId);
  if (!invoice || invoice.invoiceId !== invoiceId || !ledgerIntegrity(state, invoice)) return null;
  const receipts = invoice.receiptIds.map(id => state.payments.transactions[id]);
  return structuredClone({
    ...summary(invoice), receiptIds: invoice.receiptIds,
    confirmedAtMs: receipts.length ? Math.max(...receipts.map(receipt => receipt.receivedAtMs)) : null,
  });
}

function validationError(reason) {
  const error = new TypeError(reason);
  error.code = reason;
  return error;
}

/**
 * Register an invoice binding supplied by the authenticated operator gateway.
 * This core does not authenticate callers or contact a payment provider.
 * External invoice IDs are unique within a provider. Binding IDs never change;
 * an authorized amount correction is allowed only before any receipt exists.
 */
export function registerInvoice(state, input) {
  assertState(state);
  if (!isRecord(input)) throw validationError('invalid_invoice');
  for (const key of ['invoiceId', 'eventId', 'provider', 'providerInvoiceId']) {
    if (!isId(input[key])) throw validationError(`invalid_${key}`);
  }
  if (input.currency !== 'USD') throw validationError('unsupported_currency');
  if (!isCents(input.totalCents)) throw validationError('invalid_total_cents');

  const collisions = Object.values(state.invoices).filter((invoice) =>
    invoice?.provider === input.provider && invoice?.providerInvoiceId === input.providerInvoiceId
    && invoice?.invoiceId !== input.invoiceId);
  if (collisions.length > 0) throw validationError('ambiguous_provider_invoice');

  const existing = own(state.invoices, input.invoiceId);
  if (existing !== undefined) {
    if (!ledgerIntegrity(state, existing)) throw validationError('invoice_integrity_error');
    if (existing.invoiceId !== input.invoiceId || existing.eventId !== input.eventId
      || existing.provider !== input.provider || existing.providerInvoiceId !== input.providerInvoiceId
      || existing.currency !== input.currency) {
      throw validationError('invoice_binding_conflict');
    }
    if (existing.totalCents === input.totalCents) return { status: 'duplicate', invoice: summary(existing) };
    if (existing.receiptIds.length > 0 || existing.paidCents !== 0) {
      throw validationError('invoice_amount_immutable_after_receipt');
    }
    existing.totalCents = input.totalCents;
    existing.balanceCents = input.totalCents;
    return { status: 'updated', invoice: summary(existing) };
  }

  const invoice = {
    invoiceId: input.invoiceId,
    eventId: input.eventId,
    provider: input.provider,
    providerInvoiceId: input.providerInvoiceId,
    currency: input.currency,
    totalCents: input.totalCents,
    paidCents: 0,
    balanceCents: input.totalCents,
    receiptIds: [],
  };
  put(state.invoices, input.invoiceId, invoice);
  return { status: 'registered', invoice: summary(invoice) };
}

function exception(state, input, reason, nowMs, eventDigest) {
  const exceptionId = `payment-exception-${digest([reason, eventDigest]).slice(0, 32)}`;
  if (!own(state.exceptions, exceptionId)) {
    const refs = {};
    for (const key of ['provider', 'eventId', 'transactionId', 'providerInvoiceId', 'invoiceId', 'gourmetEventId']) {
      refs[key] = isId(input[key]) ? input[key] : null;
    }
    put(state.exceptions, exceptionId, {
      exceptionId,
      type: 'payment',
      reason,
      status: 'open',
      requiresHumanReview: true,
      recordedAtMs: nowMs,
      occurredAtMs: isTimestamp(input.occurredAtMs) ? input.occurredAtMs : null,
      ...refs,
      amountCents: isCents(input.amountCents) ? input.amountCents : null,
      currency: input.currency === 'USD' ? 'USD' : null,
      eventDigest,
    });
  }
  return { status: 'exception', reason, exceptionId, creditedCents: 0, requiresHumanReview: true };
}

function paymentProblem(input, nowMs) {
  for (const key of ['provider', 'eventId', 'transactionId', 'providerInvoiceId', 'gourmetEventId', 'invoiceId']) {
    if (!isId(input[key])) return `invalid_${key}`;
  }
  if (input.status !== 'confirmed') return 'unsupported_payment_status';
  if (input.currency !== 'USD') return 'unsupported_currency';
  if (!isCents(input.amountCents)) return 'invalid_amount_cents';
  if (!isTimestamp(input.occurredAtMs) || input.occurredAtMs > nowMs) return 'invalid_occurred_at';
  return null;
}

/**
 * Apply ONLY normalized, authenticated provider confirmation events.
 * The surrounding gateway must verify provenance before calling this function;
 * no live provider adapter, signature verification or webhook route is exported.
 * Synchronous mutations must run inside the caller's atomic transaction/lock.
 */
export function applyConfirmedPayment(state, input, { nowMs } = {}) {
  assertState(state);
  if (!isTimestamp(nowMs)) throw validationError('invalid_now_ms');
  if (!isRecord(input)) input = {};
  const { eventDigest, transactionDigest } = fingerprints(input);
  const maps = paymentMaps(state);
  const eventKey = isId(input.provider) && isId(input.eventId)
    ? `provider-event-${digest([input.provider, input.eventId])}` : null;
  const transactionKey = isId(input.provider) && isId(input.transactionId)
    ? `provider-transaction-${digest([input.provider, input.transactionId])}` : null;
  const previousEvent = eventKey ? own(maps.events, eventKey) : undefined;
  const previousTransaction = transactionKey ? own(maps.transactions, transactionKey) : undefined;

  if (previousEvent) {
    if (previousEvent.eventDigest !== eventDigest) {
      return exception(state, input, 'provider_event_collision', nowMs, eventDigest);
    }
    if (previousEvent.result.status === 'confirmed' || previousEvent.result.status === 'duplicate') {
      const invoice = own(state.invoices, previousEvent.result.invoice.invoiceId);
      if (!ledgerIntegrity(state, invoice)) return exception(state, input, 'invoice_integrity_error', nowMs, eventDigest);
      return { ...structuredClone(previousEvent.result), status: 'duplicate', creditedCents: 0, invoice: summary(invoice) };
    }
    return { ...structuredClone(previousEvent.result), duplicate: true };
  }

  let result;
  const validationProblem = paymentProblem(input, nowMs);
  if (validationProblem) {
    // Unsupported lifecycle events do not reserve a transaction: a later,
    // separately identified valid confirmation can still be evaluated.
    result = exception(state, input, validationProblem, nowMs, eventDigest);
  } else if (previousTransaction) {
    if (previousTransaction.transactionDigest !== transactionDigest) {
      result = exception(state, input, 'provider_transaction_collision', nowMs, eventDigest);
    } else if (previousTransaction.status === 'confirmed') {
      const invoice = own(state.invoices, previousTransaction.invoiceId);
      result = !ledgerIntegrity(state, invoice)
        ? exception(state, input, 'invoice_integrity_error', nowMs, eventDigest)
        : { status: 'duplicate', creditedCents: 0, receiptId: transactionKey, invoice: summary(invoice) };
    } else {
      result = { ...structuredClone(previousTransaction.result), duplicate: true };
    }
  } else {
    let problem = null;
    const matches = Object.values(state.invoices).filter((invoice) =>
      invoice?.provider === input.provider && invoice?.providerInvoiceId === input.providerInvoiceId);
    const invoice = own(state.invoices, input.invoiceId);
    if (!problem && matches.length === 0) problem = 'unmapped_provider_invoice';
    if (!problem && matches.length !== 1) problem = 'ambiguous_provider_invoice';
    if (!problem && !invoice) problem = 'unmapped_internal_invoice';
    if (!problem && (!ledgerIntegrity(state, invoice) || matches[0] !== invoice)) problem = 'invoice_mapping_mismatch';
    if (!problem && (invoice.invoiceId !== input.invoiceId || invoice.eventId !== input.gourmetEventId
      || invoice.provider !== input.provider || invoice.providerInvoiceId !== input.providerInvoiceId
      || invoice.currency !== input.currency)) problem = 'invoice_mapping_mismatch';
    if (!problem && input.amountCents > invoice.balanceCents) problem = 'overpayment';

    if (problem) {
      result = exception(state, input, problem, nowMs, eventDigest);
      if (transactionKey) {
        put(maps.transactions, transactionKey, { status: 'rejected', transactionDigest, result: structuredClone(result) });
      }
    } else {
      // All validation precedes the money mutation. Arithmetic is bounded integer cents.
      invoice.paidCents += input.amountCents;
      invoice.balanceCents -= input.amountCents;
      invoice.receiptIds.push(transactionKey);
      put(maps.transactions, transactionKey, {
        receiptId: transactionKey,
        status: 'confirmed',
        transactionDigest,
        provider: input.provider,
        transactionId: input.transactionId,
        providerInvoiceId: input.providerInvoiceId,
        invoiceId: input.invoiceId,
        gourmetEventId: input.gourmetEventId,
        amountCents: input.amountCents,
        currency: input.currency,
        occurredAtMs: input.occurredAtMs,
        receivedAtMs: nowMs,
        sourceEventId: input.eventId,
      });
      result = { status: 'confirmed', creditedCents: input.amountCents, receiptId: transactionKey, invoice: summary(invoice) };
    }
  }

  if (eventKey) {
    put(maps.events, eventKey, { eventDigest, transactionKey, result: structuredClone(result) });
  }
  return result;
}

/**
 * Read-only evidence for mandatory weekly HUMAN reconciliation with provider/
 * bank records. A report never marks funds verified, closes exceptions or sends
 * notifications. Period is [fromMs, toMs); overdue open exceptions remain visible.
 */
export function buildReconciliationReport(state, { fromMs, toMs } = {}) {
  assertState(state);
  if (!isTimestamp(fromMs) || !isTimestamp(toMs) || fromMs >= toMs) {
    throw validationError('invalid_reconciliation_period');
  }
  // Check all confirmed ledger entries BEFORE filtering by date. Corrupt dates or
  // orphan receipts must fail closed rather than disappear from reconciliation.
  for (const [receiptId, receipt] of Object.entries(state.payments.transactions ?? {})) {
    if (receipt.status === 'confirmed' && !receiptIntegrity(state, receiptId, receipt)) {
      throw validationError('receipt_integrity_error');
    }
  }
  const receipts = Object.values(state.payments.transactions ?? {})
    .filter((receipt) => receipt.status === 'confirmed'
      && receipt.occurredAtMs >= fromMs && receipt.occurredAtMs < toMs)
    .map((receipt) => ({
      receiptId: receipt.receiptId,
      provider: receipt.provider,
      transactionId: receipt.transactionId,
      providerInvoiceId: receipt.providerInvoiceId,
      invoiceId: receipt.invoiceId,
      gourmetEventId: receipt.gourmetEventId,
      amountCents: receipt.amountCents,
      currency: receipt.currency,
      occurredAtMs: receipt.occurredAtMs,
      receivedAtMs: receipt.receivedAtMs,
    }))
    .sort((a, b) => a.occurredAtMs - b.occurredAtMs || a.receiptId.localeCompare(b.receiptId, 'en'));
  const confirmedCents = receipts.reduce((total, receipt) => {
    if (!isCents(receipt.amountCents) || receipt.currency !== 'USD') throw validationError('receipt_integrity_error');
    const next = total + receipt.amountCents;
    if (!Number.isSafeInteger(next)) throw validationError('reconciliation_total_overflow');
    return next;
  }, 0);
  const exceptions = Object.values(state.exceptions)
    .filter((entry) => entry.type === 'payment'
      && (entry.status === 'open' || (entry.recordedAtMs >= fromMs && entry.recordedAtMs < toMs)))
    .map((entry) => ({ ...structuredClone(entry), recordedInPeriod: entry.recordedAtMs >= fromMs && entry.recordedAtMs < toMs }))
    .sort((a, b) => a.recordedAtMs - b.recordedAtMs || a.exceptionId.localeCompare(b.exceptionId, 'en'));
  const invoices = Object.values(state.invoices).map((invoice) => {
    if (!ledgerIntegrity(state, invoice)) throw validationError('invoice_integrity_error');
    return summary(invoice);
  }).sort((a, b) => a.invoiceId.localeCompare(b.invoiceId, 'en'));
  const report = {
    status: 'reconciliation_human_required',
    cadence: 'weekly',
    period: { fromMs, toMs },
    currency: 'USD',
    confirmedCents,
    receiptCount: receipts.length,
    receipts,
    invoices,
    exceptions,
    openExceptionCount: exceptions.filter((entry) => entry.status === 'open').length,
  };
  return { ...report, reportDigest: digest(report) };
}
