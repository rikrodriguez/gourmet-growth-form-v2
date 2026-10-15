import type { QuoteScope } from './event-quote-contracts';
import { EventQuoteError } from './event-quote-contracts';
import { canonical, digest } from './event-quote-workflow';
import { prepareGourmetCheckoutConditionsV1, type GourmetCheckoutConditionsV1, type GourmetCheckoutProviderAssessmentV1 } from './gourmet-checkout-conditions-v1';
import { freezePaymentAgreementV2 } from './payment-agreement-operations-v2';
import { types } from 'node:util';

/** A fresh, server-resolved issuance capability. Quote approval and the draft's
 * historical internalApproval are deliberately insufficient. No resolver or
 * commercial grant is installed by this module. */
export type CheckoutIssuanceAuthorityV1 = {
  actorId: string; scope: QuoteScope; purpose: 'issue_payment_checkout_v1';
  durable: true; canIssueCheckout: true; expiresAtMs: number;
};
export type CheckoutEmissionCommandV1 = {
  contractVersion: 1; issuanceId: string; sourceDraftId: string; operationId: string;
  operationDigest: string; conditionsDigest: string;
  authorization: {
    issuer: 'gourmet_office'; purpose: 'issue_payment_checkout_v1'; capability: 'issue_payment_checkout_v1';
    actorId: string; scope: QuoteScope; issuanceId: string; sourceDraftId: string;
    operationDigest: string; conditionsDigest: string; issuedAtMs: number; expiresAtMs: number;
  };
};
export type CheckoutEmissionBrowserCommandV1 = {
  key: string; configurationId: string; configurationDigest: string; expectedReviewDigest: string;
  expectedConditionsDigest: string; operation: 'issue' | 'reconcile';
};
export type CheckoutEmissionReceiptV1 = {
  contractVersion: 1; status: 'checkout_issued'; issuanceId: string; sourceDraftId: string; checkoutId: string;
  conditionsDigest: string; conditions: GourmetCheckoutConditionsV1; providerAssessment: GourmetCheckoutProviderAssessmentV1;
  publicPaymentUrl: string; executable: false; providerEnabled: false; authorizationVerified: false; serviceAuthenticated: true;
};
export type CheckoutEmissionSummaryV1 = {
  issuanceId: string; conditionsDigest: string; status: 'pending' | 'reconciliation_required' | 'checkout_issued';
  checkoutId: string | null; publicPaymentUrl: string | null; executable: false; providerEnabled: false;
  authorizationVerified: false; serviceAuthenticated: boolean;
};
const blocked = (code: string) => ({ status: 'blocked' as const, code });
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const own = Reflect.ownKeys(value);
  return own.length === keys.length && own.every(key => typeof key === 'string' && keys.includes(key)
    && Object.getOwnPropertyDescriptor(value, key)?.enumerable === true && 'value' in Object.getOwnPropertyDescriptor(value, key)!);
}
function ownDataPath(value: unknown, path: string[]): unknown {
  for (const key of path) {
    if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return undefined;
    value = descriptor.value;
  }
  return value;
}
export function checkoutIssuanceIdV1(source: {
  sourceDraftId: string; operationId: string; operationDigest: string; conditionsDigest: string;
}): string {
  return digest({ contractVersion: 1, purpose: 'issue_payment_checkout_v1', ...source });
}
export const checkoutEmissionIdempotencyKeyV1 = (issuanceId: string) => {
  if (!/^[a-f0-9]{64}$/.test(issuanceId)) throw new EventQuoteError('CHECKOUT_EMISSION_INVALID', 422);
  return `gourmet-checkout-v1-${issuanceId}`;
};

/** Construct only an internal command. This cannot issue a token, activate a
 * provider, turn a due date into auto-debit consent, or alter the source draft. */
export function prepareGourmetCheckoutEmissionV1(input: {
  receipt: unknown; expectedConditionsDigest: string; authority: unknown; nowMs: number;
  /** Recovery can read an existing expired checkout, but never create one. */
  operation?: 'issue' | 'reconcile';
}) {
  const a = input.authority;
  if (!Number.isSafeInteger(input.nowMs) || input.nowMs < 0 || input.nowMs > 8_640_000_000_000_000) return blocked('INVALID_NOW');
  if (!exact(a, ['actorId', 'scope', 'purpose', 'durable', 'canIssueCheckout', 'expiresAtMs'])
    || typeof a.actorId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(a.actorId)
    || ['constructor', 'prototype', '__proto__'].includes(a.actorId)
    || a.purpose !== 'issue_payment_checkout_v1' || a.durable !== true || a.canIssueCheckout !== true
    || !Number.isSafeInteger(a.expiresAtMs) || (a.expiresAtMs as number) <= input.nowMs
    || (a.expiresAtMs as number) > 8_640_000_000_000_000) return blocked('CHECKOUT_ISSUANCE_FORBIDDEN');
  let sourceTime = input.nowMs;
  if (input.operation === 'reconcile') {
    // The complete structural validator still checks this historical snapshot.
    // Only current authority, not today's calendar, governs read-only recovery.
    const historical = ownDataPath(input.receipt, ['operation', 'prepared', 'internalApproval', 'atMs']);
    if (!Number.isSafeInteger(historical) || (historical as number) > input.nowMs) return blocked('INVALID_CHECKOUT_CONDITIONS');
    sourceTime = historical as number;
  }
  const prepared = prepareGourmetCheckoutConditionsV1({ receipt: input.receipt, nowMs: sourceTime });
  if (prepared.status === 'blocked') return prepared;
  const scope = prepared.conditions.operation.prepared.plan.scope;
  if (!exact(a.scope, ['organizationId', 'workspaceId', 'mode']) || canonical(a.scope) !== canonical(scope)
    || scope.mode !== 'test') return blocked('CHECKOUT_ISSUANCE_FORBIDDEN');
  if (input.expectedConditionsDigest !== prepared.conditionsDigest) return blocked('STALE_CHECKOUT_CONDITIONS');
  const source = { sourceDraftId: prepared.conditions.sourceDraft.agreementId,
    operationId: prepared.conditions.sourceDraft.operationId, operationDigest: prepared.conditions.sourceDraft.operationDigest,
    conditionsDigest: prepared.conditionsDigest };
  const issuanceId = checkoutIssuanceIdV1(source);
  const command: CheckoutEmissionCommandV1 = { contractVersion: 1, issuanceId, ...source,
    authorization: { issuer: 'gourmet_office', purpose: 'issue_payment_checkout_v1', capability: 'issue_payment_checkout_v1',
      actorId: a.actorId, scope: structuredClone(scope), issuanceId, sourceDraftId: source.sourceDraftId,
      operationDigest: source.operationDigest, conditionsDigest: source.conditionsDigest,
      issuedAtMs: input.nowMs, expiresAtMs: Math.min(a.expiresAtMs as number, input.nowMs + 300_000) } };
  return freezePaymentAgreementV2({ status: 'prepared_checkout_emission' as const,
    conditions: prepared.conditions, conditionsDigest: prepared.conditionsDigest, providerAssessment: prepared.providerAssessment,
    command, body: canonical(command), idempotencyKey: checkoutEmissionIdempotencyKeyV1(issuanceId),
    executable: false as const, providerEnabled: false as const, publicPaymentUrl: null });
}

/** Require an actual related checkout identity and an original-host opaque URL.
 * Issuance is distinct from provider activation, customer consent and payment. */
export function decodeGourmetCheckoutEmissionReceiptV1(body: string, expected: {
  command: CheckoutEmissionCommandV1; conditions: GourmetCheckoutConditionsV1; providerAssessment: unknown;
  publicCheckoutOrigin: string;
}): CheckoutEmissionReceiptV1 {
  try {
    if (typeof body !== 'string' || Buffer.byteLength(body) > 393_216) throw new Error();
    const value: unknown = JSON.parse(body);
    if (!exact(value, ['contractVersion', 'status', 'checkoutId', 'issuanceId', 'sourceDraftId', 'conditionsDigest',
      'conditions', 'providerAssessment', 'executable', 'providerEnabled', 'publicPaymentUrl', 'authorizationVerified', 'serviceAuthenticated'])
      || value.contractVersion !== 1 || value.status !== 'checkout_issued'
      || typeof value.checkoutId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.checkoutId)
      || value.checkoutId === value.sourceDraftId
      || value.issuanceId !== expected.command.issuanceId || value.sourceDraftId !== expected.command.sourceDraftId
      || value.conditionsDigest !== expected.command.conditionsDigest || digest(value.conditions) !== value.conditionsDigest
      || canonical(value.conditions) !== canonical(expected.conditions)
      || canonical(value.providerAssessment) !== canonical(expected.providerAssessment)
      || value.executable !== false || value.providerEnabled !== false
      || value.authorizationVerified !== false || value.serviceAuthenticated !== true) throw new Error();
    const url = new URL(value.publicPaymentUrl as string), origin = new URL(expected.publicCheckoutOrigin);
    if (origin.origin !== expected.publicCheckoutOrigin || origin.username || origin.password
      || !['https:', 'http:'].includes(origin.protocol)
      || origin.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)
      || url.origin !== origin.origin || url.username || url.password || url.search || url.hash
      || !/^\/pay\/[A-Za-z0-9_-]{43}$/.test(url.pathname) || url.href !== value.publicPaymentUrl) throw new Error();
    return freezePaymentAgreementV2(value as CheckoutEmissionReceiptV1);
  } catch { throw new EventQuoteError('CHECKOUT_EMISSION_RECEIPT_INVALID', 502); }
}
