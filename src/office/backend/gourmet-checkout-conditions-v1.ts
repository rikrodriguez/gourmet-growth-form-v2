import { types } from 'node:util';
import { canonical, digest } from './event-quote-workflow';
import { proposeRetainerBalanceDateV2, resolveApprovedLocalMinuteV2 } from './payment-calendar-v2';
import { decodePaymentAgreementReceiptV2, freezePaymentAgreementV2, paymentAgreementOperationIdV2,
  type PaymentAgreementOperationV2 } from './payment-agreement-operations-v2';

export type GourmetCheckoutConditionsV1 = {
  contractVersion: 1; purpose: 'gourmet_payment_checkout';
  sourceDraft: { agreementId: string; operationId: string; operationDigest: string };
  operation: PaymentAgreementOperationV2;
};
export type GourmetCheckoutProviderAssessmentV1 = {
  representation: 'subscriptions_setup_and_one_balance' | 'orders_capture';
  blockers: 'PROVIDER_DISABLED'[];
};
type Prepared = { status: 'prepared_checkout_conditions'; conditions: GourmetCheckoutConditionsV1;
  conditionsDigest: string; providerAssessment: GourmetCheckoutProviderAssessmentV1 };
type Blocked = { status: 'blocked'; code: string };
class InvalidConditions extends Error { constructor(readonly code: string) { super(code); } }
const check = (valid: unknown, code = 'INVALID_CHECKOUT_CONDITIONS'): void => { if (!valid) throw new InvalidConditions(code); };

/** Detach JSON data without evaluating accessors, serializers or proxies. */
function data(raw: unknown): unknown {
  let nodes = 0, bytes = 0;
  const add = (size: number) => { bytes += size; check(bytes <= 393_216); };
  const visit = (value: unknown, depth: number): unknown => {
    check(++nodes <= 20_000 && depth <= 40);
    if (value === null || typeof value === 'boolean') { add(5); return value; }
    if (typeof value === 'string') {
      check(Buffer.from(value, 'utf8').toString('utf8') === value);
      add(Buffer.byteLength(JSON.stringify(value))); return value;
    }
    if (typeof value === 'number') { check(Number.isFinite(value) && !Object.is(value, -0)); add(24); return value; }
    check(!!value && typeof value === 'object' && !types.isProxy(value));
    const object = value as object, array = Array.isArray(object), prototype = Object.getPrototypeOf(object);
    check(array ? prototype === Array.prototype : prototype === Object.prototype || prototype === null);
    const keys = Reflect.ownKeys(object); check(keys.length <= 20_000);
    if (array) {
      check(object.length <= 20_000 && keys.length === object.length + 1);
      const copy: unknown[] = [];
      for (let i = 0; i < object.length; ++i) {
        const descriptor = Object.getOwnPropertyDescriptor(object, String(i));
        check(descriptor && 'value' in descriptor && descriptor.enumerable);
        copy.push(visit(descriptor!.value, depth + 1)); add(1);
      }
      check(keys.every(key => key === 'length' || typeof key === 'string' && /^(0|[1-9][0-9]*)$/.test(key)));
      return copy;
    }
    const copy: Record<string, unknown> = {};
    for (const key of keys) {
      check(typeof key === 'string');
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      check(descriptor && 'value' in descriptor && descriptor.enumerable);
      add(Buffer.byteLength(JSON.stringify(key)) + 2);
      Object.defineProperty(copy, key, { value: visit(descriptor!.value, depth + 1), enumerable: true, writable: true, configurable: true });
    }
    return copy;
  };
  return visit(raw, 0);
}
function object(raw: unknown, keys: readonly string[], code = 'INVALID_CHECKOUT_CONDITIONS'): Record<string, any> {
  check(raw && typeof raw === 'object' && !Array.isArray(raw), code);
  const value = raw as Record<string, unknown>, own = Object.keys(value);
  check(own.length === keys.length && keys.every(key => Object.hasOwn(value, key)), code);
  return value;
}
function text(raw: unknown, max: number, multiline = true): string {
  check(typeof raw === 'string' && raw.trim().length > 0 && raw.length <= max
    && !(multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u : /[\u0000-\u001f\u007f]/u).test(raw));
  return raw as string;
}
function identifier(raw: unknown): string {
  const value = text(raw, 96, false);
  check(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value) && !['constructor', 'prototype', '__proto__'].includes(value)); return value;
}
function hash(raw: unknown): string { check(typeof raw === 'string' && /^[a-f0-9]{64}$/.test(raw)); return raw as string; }
function integer(raw: unknown, min: number, max: number): number { check(Number.isSafeInteger(raw) && (raw as number) >= min && (raw as number) <= max, 'INVALID_CHECKOUT_AMOUNT'); return raw as number; }
function nullableReason(raw: unknown) { if (raw !== null) text(raw, 2000); }
function futureMinute(date: unknown, time: unknown, timezone: unknown, nowMs: number): string {
  check(typeof date === 'string' && typeof time === 'string' && typeof timezone === 'string', 'INVALID_CHECKOUT_CALENDAR');
  const instant = resolveApprovedLocalMinuteV2(date as string, time as string, timezone as string);
  check(instant && /:00Z$/.test(instant), 'INVALID_CHECKOUT_CALENDAR');
  check(Date.parse(instant!) > nowMs, 'CHECKOUT_DEADLINE_NOT_FUTURE'); return instant!;
}
function validatePlan(raw: unknown, nowMs: number) {
  const p = object(raw, ['status', 'contractVersion', 'plan', 'reviewDigest', 'internalApproval', 'executable', 'providerEnabled', 'publicPaymentUrl', 'blockers']);
  check(p.status === 'prepared_internal' && p.contractVersion === 2 && p.executable === false && p.providerEnabled === false && p.publicPaymentUrl === null);
  check(canonical(p.blockers) === canonical(['PROVIDER_DISABLED', 'RECEIVER_V2_UNAVAILABLE']));
  const plan = object(p.plan, ['contractVersion', 'scope', 'eventId', 'preparationId', 'preparationDigest', 'sourceQuote', 'paymentMode', 'initialPaymentCents', 'paymentBalanceCents', 'canonicalLeadId', 'paymentTerms', 'termsChangeReason', 'paymentSchedule', 'linkExpiration']);
  check(plan.contractVersion === 2);
  const scope = object(plan.scope, ['organizationId', 'workspaceId', 'mode']);
  identifier(scope.organizationId); identifier(scope.workspaceId); check(['test', 'commercial'].includes(scope.mode));
  identifier(plan.eventId); identifier(plan.preparationId); hash(plan.preparationDigest);
  const q = object(plan.sourceQuote, ['version', 'digest', 'approvalDigest', 'briefDigest', 'catalogDigest', 'artifactSha256', 'intendedRecipient', 'currency', 'totalCents', 'depositCents', 'depositBasis', 'terms']);
  integer(q.version, 1, 20);
  for (const key of ['digest', 'approvalDigest', 'briefDigest', 'catalogDigest', 'artifactSha256']) hash(q[key]);
  check(/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(text(q.intendedRecipient, 254, false)));
  check(q.currency === 'USD', 'INVALID_CHECKOUT_CURRENCY');
  const total = integer(q.totalCents, 1, 1_000_000_000), deposit = integer(q.depositCents, 0, total);
  const basis = object(q.depositBasis, ['kind', 'basisPoints']); check(basis.kind === 'quoted_percentage');
  const bps = integer(basis.basisPoints, 0, 10000);
  check(deposit === Math.floor((total * bps + 5000) / 10000), 'INVALID_CHECKOUT_AMOUNT'); text(q.terms, 4000);
  check(['retainer_50', 'full_upfront', 'fixed_49_reservation'].includes(plan.paymentMode), 'INVALID_CHECKOUT_PAYMENT_MODE');
  const initial = integer(plan.initialPaymentCents, 1, 1_000_000_000), balance = integer(plan.paymentBalanceCents, 0, 1_000_000_000);
  check(initial + balance === total, 'INVALID_CHECKOUT_AMOUNT');
  check(plan.paymentMode === 'retainer_50' ? initial === Math.floor((total + 1) / 2) && balance > 0
    : plan.paymentMode === 'full_upfront' ? initial === total && balance === 0
      : total > 4900 && initial === 4900 && balance === total - 4900, 'INVALID_CHECKOUT_AMOUNT');
  check(plan.preparationId === 'payment-contract-v2-' + digest({ contractVersion: 2, scope, eventId: plan.eventId,
    quoteVersion: q.version, quoteDigest: q.digest, approvalDigest: q.approvalDigest, paymentMode: plan.paymentMode }), 'INVALID_CHECKOUT_SOURCE_BINDING');
  text(plan.canonicalLeadId, 180); check(plan.canonicalLeadId.trim() === plan.canonicalLeadId && !/[\r\n\t]/.test(plan.canonicalLeadId));
  text(plan.paymentTerms, 4000); nullableReason(plan.termsChangeReason);
  const quotedMatches = plan.paymentMode !== 'fixed_49_reservation' && deposit === initial && bps === (plan.paymentMode === 'retainer_50' ? 5000 : 10000);
  if (!quotedMatches || plan.paymentTerms !== q.terms) check(typeof plan.termsChangeReason === 'string' && plan.termsChangeReason.trim(), 'CHECKOUT_TERMS_REVIEW_REQUIRED');
  const expiry = object(plan.linkExpiration, ['configured', 'instant']);
  if (expiry.configured?.kind === 'never') { object(expiry.configured, ['kind']); check(expiry.instant === null, 'INVALID_CHECKOUT_CALENDAR'); }
  else {
    const c = object(expiry.configured, ['kind', 'date', 'time', 'timezone']); check(c.kind === 'at');
    check(expiry.instant === futureMinute(c.date, c.time, c.timezone, nowMs), 'INVALID_CHECKOUT_CALENDAR');
  }
  if (plan.paymentMode === 'full_upfront') check(plan.paymentSchedule === null, 'INVALID_CHECKOUT_CALENDAR');
  else {
    const s = object(plan.paymentSchedule, ['configured', 'balanceInstant', 'eventInstant', 'proposedBalanceDate', 'timingReviewReason']);
    if (plan.paymentMode === 'fixed_49_reservation') {
      const c = object(s.configured, ['kind', 'balanceDate', 'balanceTime', 'timezone', 'agreedBalanceCents']);
      check(c.kind === 'fixed_49_reservation' && c.agreedBalanceCents === balance, 'INVALID_CHECKOUT_AMOUNT');
      check(s.balanceInstant === futureMinute(c.balanceDate, c.balanceTime, c.timezone, nowMs)
        && s.eventInstant === null && s.proposedBalanceDate === null && s.timingReviewReason === null, 'INVALID_CHECKOUT_CALENDAR');
    } else {
      const c = object(s.configured, ['kind', 'eventDate', 'eventTime', 'timezone', 'balanceDate', 'balanceTime', 'timingExceptionReason']); check(c.kind === 'retainer_50');
      nullableReason(c.timingExceptionReason);
      const event = futureMinute(c.eventDate, c.eventTime, c.timezone, nowMs), due = futureMinute(c.balanceDate, c.balanceTime, c.timezone, nowMs);
      const proposal = proposeRetainerBalanceDateV2({ eventDate: c.eventDate, eventTime: c.eventTime, timezone: c.timezone, nowMs });
      check(Date.parse(due) < Date.parse(event) && s.eventInstant === event && s.balanceInstant === due
        && !!proposal.proposedBalanceDate && s.proposedBalanceDate === proposal.proposedBalanceDate
        && s.timingReviewReason === c.timingExceptionReason, 'INVALID_CHECKOUT_CALENDAR');
      const review = c.balanceDate !== proposal.proposedBalanceDate || proposal.codes.some(code => ['EVENT_DATE_NOT_FUTURE', 'EVENT_WITHIN_SEVEN_DAYS', 'PROPOSED_BALANCE_DATE_PAST'].includes(code));
      if (review) check(typeof c.timingExceptionReason === 'string' && c.timingExceptionReason.trim(), 'CHECKOUT_TIMING_REVIEW_REQUIRED');
    }
  }
  check(hash(p.reviewDigest) === digest(plan), 'INVALID_CHECKOUT_SOURCE_BINDING');
  const a = object(p.internalApproval, ['actorId', 'atMs', 'purpose', 'reviewDigest'], 'INVALID_CHECKOUT_APPROVAL');
  identifier(a.actorId); check(Number.isSafeInteger(a.atMs) && a.atMs >= 0 && a.atMs <= nowMs && a.purpose === 'internal_payment_plan_only'
    && a.reviewDigest === p.reviewDigest, 'INVALID_CHECKOUT_APPROVAL');
}

/** Pure structural preparation from a server-owned draft receipt. It does not
 * authenticate that receipt, resolve current authority, collect consent, select
 * a provider implementation or issue a token, URL, payment or provider call. */
export function prepareGourmetCheckoutConditionsV1(input: { receipt: unknown; nowMs: number }): Prepared | Blocked {
  try {
    check(Number.isSafeInteger(input.nowMs) && input.nowMs >= 0 && input.nowMs <= 8_640_000_000_000_000, 'INVALID_NOW');
    const raw = object(data(input.receipt), ['contractVersion', 'status', 'agreementId', 'operationId', 'operationDigest', 'operation', 'executable', 'providerEnabled', 'publicPaymentUrl', 'authorizationVerified', 'serviceAuthenticated'], 'INVALID_PAYMENT_DRAFT_RECEIPT');
    const op = object(raw.operation, ['contractVersion', 'operationId', 'configurationId', 'configurationDigest', 'prepared', 'recipient', 'service']);
    check(op.contractVersion === 2); hash(op.operationId); identifier(op.configurationId); hash(op.configurationDigest);
    validatePlan(op.prepared, input.nowMs);
    const plan = op.prepared.plan;
    check(op.operationId === paymentAgreementOperationIdV2(plan.scope, plan.eventId, op.configurationId, op.configurationDigest, plan.preparationDigest), 'INVALID_CHECKOUT_SOURCE_BINDING');
    const recipient = object(op.recipient, ['name', 'email', 'phone']); text(recipient.name, 160, false); text(recipient.email, 254, false);
    check(recipient.email === plan.sourceQuote.intendedRecipient, 'INVALID_CHECKOUT_SOURCE_BINDING'); if (recipient.phone !== null) text(recipient.phone, 32, false);
    const service = object(op.service, ['name', 'eventLocation']); text(service.name, 180, false); if (service.eventLocation !== null) text(service.eventLocation, 500, false);
    check(Buffer.byteLength(canonical(op)) <= 196_608);
    let receipt;
    try { receipt = decodePaymentAgreementReceiptV2(canonical(raw), op as PaymentAgreementOperationV2); }
    catch { throw new InvalidConditions('INVALID_PAYMENT_DRAFT_RECEIPT'); }
    const conditions: GourmetCheckoutConditionsV1 = { contractVersion: 1, purpose: 'gourmet_payment_checkout',
      sourceDraft: { agreementId: receipt.agreementId, operationId: receipt.operationId, operationDigest: receipt.operationDigest },
      operation: receipt.operation };
    const providerAssessment: GourmetCheckoutProviderAssessmentV1 = plan.paymentMode === 'full_upfront'
      ? { representation: 'orders_capture', blockers: ['PROVIDER_DISABLED'] }
      : { representation: 'subscriptions_setup_and_one_balance', blockers: ['PROVIDER_DISABLED'] };
    return freezePaymentAgreementV2({ status: 'prepared_checkout_conditions', conditions, conditionsDigest: digest(conditions), providerAssessment });
  } catch (error) { return { status: 'blocked', code: error instanceof InvalidConditions ? error.code : 'INVALID_CHECKOUT_CONDITIONS' }; }
}
