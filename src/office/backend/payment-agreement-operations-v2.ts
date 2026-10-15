import type { PoolClient } from 'pg';
import { EventQuoteError, type EventQuoteRecord, type QuoteScope } from './event-quote-contracts';
import { canonical, digest } from './event-quote-workflow';
import type { InternalPaymentPreparationV2 } from './gourmet-payments-agreement-v2';
import type { CheckoutEmissionCommandV1, CheckoutEmissionReceiptV1, CheckoutEmissionSummaryV1, CheckoutIssuanceAuthorityV1 } from './gourmet-checkout-emission-v1';

export type PaymentAgreementOperationCommandV2 = { key: string; configurationId: string; configurationDigest: string; expectedReviewDigest: string; operation: 'create' | 'reconcile' };
export type PaymentAgreementOperationV2 = {
  contractVersion: 2; operationId: string; configurationId: string; configurationDigest: string;
  prepared: InternalPaymentPreparationV2;
  recipient: { name: string; email: string; phone: string | null };
  service: { name: string; eventLocation: string | null };
};
export type PaymentAgreementAuthorizationV2 = {
  issuer: 'gourmet_office'; purpose: 'create_disabled_payment_agreement_v2'; actorId: string; scope: QuoteScope;
  operationId: string; operationDigest: string; issuedAtMs: number; expiresAtMs: number;
};
export type PaymentAgreementReceiptV2 = {
  contractVersion: 2; status: 'draft_persisted'; agreementId: string; operationId: string; operationDigest: string;
  operation: PaymentAgreementOperationV2; executable: false; providerEnabled: false; publicPaymentUrl: null;
  authorizationVerified: false; serviceAuthenticated: true;
};
export type PaymentAgreementOperationSummaryV2 = {
  operationId: string; operationDigest: string; configurationId: string; configurationDigest: string;
  status: 'pending' | 'reconciliation_required' | 'draft_persisted' | 'rejected'; agreementId: string | null;
  executable: false; providerEnabled: false; publicPaymentUrl: null; authorizationVerified: false;
  serviceAuthenticated: boolean; updatedAtMs: number;
  checkoutConditionsDigest?: string; checkout?: CheckoutEmissionSummaryV1;
};
export type PaymentAgreementHandoffV2 = {
  operation: PaymentAgreementOperationV2; operationDigest: string; summary: PaymentAgreementOperationSummaryV2;
  receipt: PaymentAgreementReceiptV2 | null; revision: number; attemptId: string | null; leaseUntilMs: number | null;
  checkoutReceipt?: CheckoutEmissionReceiptV1; checkoutOrigin?: string;
};
export interface PaymentAgreementOutboxV2 {
  list(scope: QuoteScope, eventId: string, client?: PoolClient): Promise<PaymentAgreementOperationSummaryV2[]>;
  get(scope: QuoteScope, eventId: string, operationId: string, client?: PoolClient): Promise<PaymentAgreementHandoffV2 | null>;
  putIntent(input: { scope: QuoteScope; eventId: string; operation: PaymentAgreementOperationV2; actorId: string; key: string; inputDigest: string; atMs: number }, client: PoolClient): Promise<PaymentAgreementHandoffV2>;
  claim(scope: QuoteScope, eventId: string, operationId: string, nowMs: number): Promise<{ handoff: PaymentAgreementHandoffV2; attemptId: string | null }>;
  finish(scope: QuoteScope, eventId: string, operationId: string, attemptId: string, result: { receipt: PaymentAgreementReceiptV2 | null; rejected?: boolean }, nowMs: number): Promise<void>;
  putCheckoutIntent?(input: { scope: QuoteScope; eventId: string; operationId: string; issuanceId: string; conditionsDigest: string;
    publicCheckoutOrigin: string; actorId: string; key: string; inputDigest: string; atMs: number }, client: PoolClient): Promise<void>;
  finishCheckout?(scope: QuoteScope, eventId: string, operationId: string, issuanceId: string, receipt: CheckoutEmissionReceiptV1 | null, nowMs: number): Promise<void>;
}
export type PaymentAgreementTransportV2 = {
  create(operation: PaymentAgreementOperationV2, authorization: PaymentAgreementAuthorizationV2, signal: AbortSignal): Promise<{ status: number; body: string }>;
  reconcile(operationId: string, operationDigest: string, signal: AbortSignal): Promise<{ status: number; body: string }>;
};
export type PaymentAgreementSourceV2 = { source: 'synthetic_fixture'; canonicalLeadId: string; serviceName: string; phone?: string | null; eventLocation?: string | null };
export type PaymentAgreementIntegrationV2 = {
  outbox: PaymentAgreementOutboxV2; transport: PaymentAgreementTransportV2;
  resolveSource(scope: QuoteScope, eventId: string, record: EventQuoteRecord): Promise<PaymentAgreementSourceV2 | null>;
  commercialEnabled?: false; deliveryTimeoutMs?: number;
  checkout?: {
    transport: { publicCheckoutOrigin: string | null;
      issue(command: CheckoutEmissionCommandV1, signal: AbortSignal): Promise<{ status: number; body: string }>;
      reconcile(command: CheckoutEmissionCommandV1, signal: AbortSignal): Promise<{ status: number; body: string }> };
    /** Fresh server-owned issuance capability; never derived from canApprove. */
    /** null event advertises the capability only; issuance rechecks a concrete event. */
    resolveIssuanceAuthority(scope: QuoteScope, eventId: string | null, actorId: string, client: PoolClient): Promise<CheckoutIssuanceAuthorityV1 | null>;
  };
};
export function freezePaymentAgreementV2<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freezePaymentAgreementV2(child); Object.freeze(value); }
  return value;
}
export function paymentAgreementOperationIdV2(scope: QuoteScope, eventId: string, configurationId: string, configurationDigest: string, preparationDigest: string): string {
  return digest({ scope, eventId, configurationId, configurationDigest, preparationDigest });
}
export const paymentAgreementIdempotencyKeyV2 = (operationId: string) => `gourmet-v2-${operationId}`;
function text(value: unknown, max: number): value is string { return typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value); }
export function createPaymentAgreementOperationV2(input: {
  prepared: InternalPaymentPreparationV2; configurationId: string; configurationDigest: string;
  recipientName: string; source: PaymentAgreementSourceV2;
}): PaymentAgreementOperationV2 {
  const p = input.prepared, s = input.source;
  if (p.plan.scope.mode !== 'test' || s.source !== 'synthetic_fixture' || s.canonicalLeadId !== p.plan.canonicalLeadId
    || !text(input.recipientName, 160) || !text(s.serviceName, 180)
    || (s.phone != null && !text(s.phone, 32)) || (s.eventLocation != null && !text(s.eventLocation, 500))
    || !text(input.configurationId, 96) || !/^[a-f0-9]{64}$/.test(input.configurationDigest)) throw new EventQuoteError('PAYMENT_AGREEMENT_SOURCE_INVALID', 422);
  const operation: PaymentAgreementOperationV2 = { contractVersion: 2,
    operationId: paymentAgreementOperationIdV2(p.plan.scope, p.plan.eventId, input.configurationId, input.configurationDigest, p.plan.preparationDigest),
    configurationId: input.configurationId, configurationDigest: input.configurationDigest, prepared: structuredClone(p),
    recipient: { name: input.recipientName, email: p.plan.sourceQuote.intendedRecipient, phone: s.phone ?? null },
    service: { name: s.serviceName, eventLocation: s.eventLocation ?? null } };
  if (Buffer.byteLength(canonical(operation), 'utf8') > 196_608) throw new EventQuoteError('PAYMENT_AGREEMENT_WIRE_LIMIT', 422);
  return freezePaymentAgreementV2(operation);
}
export function decodePaymentAgreementReceiptV2(body: string, operation: PaymentAgreementOperationV2): PaymentAgreementReceiptV2 {
  try {
    if (typeof body !== 'string' || Buffer.byteLength(body, 'utf8') > 393_216) throw new Error();
    const r = JSON.parse(body), keys = ['contractVersion', 'status', 'agreementId', 'operationId', 'operationDigest', 'operation', 'executable', 'providerEnabled', 'publicPaymentUrl', 'authorizationVerified', 'serviceAuthenticated'];
    if (!r || typeof r !== 'object' || Array.isArray(r) || Object.keys(r).length !== keys.length || !keys.every(k => Object.hasOwn(r, k))
      || r.contractVersion !== 2 || r.status !== 'draft_persisted' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(r.agreementId)
      || r.operationId !== operation.operationId || r.operationDigest !== digest(operation) || canonical(r.operation) !== canonical(operation)
      || r.executable !== false || r.providerEnabled !== false || r.publicPaymentUrl !== null || r.authorizationVerified !== false || r.serviceAuthenticated !== true) throw new Error();
    return freezePaymentAgreementV2(r as PaymentAgreementReceiptV2);
  } catch { throw new EventQuoteError('PAYMENT_AGREEMENT_RECEIPT_INVALID', 502); }
}
