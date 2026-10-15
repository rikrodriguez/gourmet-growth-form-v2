import { EventQuoteError, type EventQuoteView } from './event-quote-contracts';
import { canonical, digest } from './event-quote-workflow';
import { freshOperation, type AuthorizePaymentAgreementV2, type PaymentAgreementAuthorizedContextV2 } from './payment-agreement-dispatch-v2';
import { prepareGourmetCheckoutEmissionV1, decodeGourmetCheckoutEmissionReceiptV1,
  type CheckoutEmissionBrowserCommandV1, type CheckoutEmissionReceiptV1 } from './gourmet-checkout-emission-v1';
import { paymentAgreementOperationIdV2, type PaymentAgreementIntegrationV2, type PaymentAgreementHandoffV2 } from './payment-agreement-operations-v2';

const fail = (code: string, status = 422): never => { throw new EventQuoteError(code, status); };
export function parseCheckoutEmissionBrowserCommandV1(raw: unknown): CheckoutEmissionBrowserCommandV1 {
  const keys = ['key', 'configurationId', 'configurationDigest', 'expectedReviewDigest', 'expectedConditionsDigest', 'operation'];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length !== keys.length || !keys.every(k => Object.hasOwn(raw, k))) return fail('INVALID_INPUT', 400);
  const value = raw as Record<string, unknown>;
  if (![value.key, value.configurationId].every(v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(v) && !['constructor', 'prototype', '__proto__'].includes(v))
    || ![value.configurationDigest, value.expectedReviewDigest, value.expectedConditionsDigest].every(v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v))
    || !['issue', 'reconcile'].includes(value.operation as string)) return fail('INVALID_INPUT', 400);
  return structuredClone(value) as CheckoutEmissionBrowserCommandV1;
}
async function bounded<T>(timeout: number, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const control = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = performance.now() + timeout;
  try {
    const result = await Promise.race([action(control.signal), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { reject(new EventQuoteError('CHECKOUT_DELIVERY_TIMEOUT', 503)); control.abort(); }, timeout);
    })]);
    if (performance.now() >= deadline) return fail('CHECKOUT_DELIVERY_TIMEOUT', 503);
    return result;
  } finally { if (timer) clearTimeout(timer); control.abort(); }
}

/** The original Payments ledger owns checkout issuance. Office retains its
 * intent/outcome in the existing encrypted handoff, outside quote mutations.
 * Every retry looks up the stable receiver identity before issuing anything. */
export async function executePaymentCheckoutOperationV1(eventId: string, raw: unknown, deps: {
  integration: PaymentAgreementIntegrationV2; authorize: AuthorizePaymentAgreementV2; clock?: () => number;
}): Promise<EventQuoteView> {
  const command = parseCheckoutEmissionBrowserCommandV1(raw), { integration, authorize } = deps;
  const checkout = integration.checkout, putIntent = integration.outbox.putCheckoutIntent?.bind(integration.outbox),
    finish = integration.outbox.finishCheckout?.bind(integration.outbox);
  if (!checkout || !putIntent || !finish || !checkout.transport.publicCheckoutOrigin) return fail('CHECKOUT_EMISSION_DISABLED', 503);
  const publicCheckoutOrigin = checkout.transport.publicCheckoutOrigin;
  const timeout = integration.deliveryTimeoutMs ?? 2000;
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 5000) return fail('CHECKOUT_TIMEOUT_INVALID', 503);
  let last = -1; const sourceClock = deps.clock ?? Date.now;
  const clock = () => { const now = sourceClock(); if (!Number.isSafeInteger(now) || now < 0 || now < last) return fail('CHECKOUT_CLOCK_INVALID', 503); last = now; return now; };
  const enabled = (context: PaymentAgreementAuthorizedContextV2) => {
    if (context.scope.mode !== 'test' || !context.actor.durable || !context.actor.canWrite || !context.actor.canApprove || context.actor.expiresAtMs <= clock())
      return fail('CHECKOUT_ISSUANCE_FORBIDDEN', 403);
  };
  const load = async (context: PaymentAgreementAuthorizedContextV2) => {
    enabled(context);
    const view = await context.service.read(context.scope, context.actor, eventId);
    const config = view.record.paymentConfigurationsV2?.find(c => c.id === command.configurationId);
    if (!config || config.digest !== command.configurationDigest || config.reviewDigest !== command.expectedReviewDigest) return fail('STALE_PAYMENT_CONFIGURATION', 409);
    const operationId = paymentAgreementOperationIdV2(context.scope, eventId, config.id, config.digest, config.preparationDigest);
    const handoff = await integration.outbox.get(context.scope, eventId, operationId, context.client);
    if (!handoff?.receipt || handoff.summary.status !== 'draft_persisted') return fail('PAYMENT_DRAFT_NOT_FOUND', 409);
    return handoff;
  };
  const prepare = async (context: PaymentAgreementAuthorizedContextV2, handoff: PaymentAgreementHandoffV2, operation: 'issue' | 'reconcile', sourceDeadline?: number) => {
    enabled(context);
    const authority = await checkout.resolveIssuanceAuthority(context.scope, eventId, context.actor.actorId, context.client);
    enabled(context);
    if (!authority || authority.actorId !== context.actor.actorId || authority.expiresAtMs > context.actor.expiresAtMs) return fail('CHECKOUT_ISSUANCE_FORBIDDEN', 403);
    if (sourceDeadline !== undefined && sourceDeadline <= clock()) return fail('STALE_PAYMENT_CONFIGURATION', 409);
    const prepared = prepareGourmetCheckoutEmissionV1({ receipt: handoff.receipt, expectedConditionsDigest: command.expectedConditionsDigest,
      authority: { ...authority, expiresAtMs: Math.min(authority.expiresAtMs, sourceDeadline ?? authority.expiresAtMs) }, nowMs: clock(), operation });
    if (prepared.status === 'blocked') return fail(prepared.code, prepared.code === 'CHECKOUT_ISSUANCE_FORBIDDEN' ? 403 : 409);
    return prepared;
  };
  const committed = await authorize(async context => {
    const handoff = await load(context), prepared = await prepare(context, handoff, 'reconcile');
    if (command.operation === 'reconcile' && !handoff.summary.checkout) return fail('CHECKOUT_NOT_FOUND', 404);
    await putIntent({ scope: context.scope, eventId, operationId: handoff.operation.operationId, issuanceId: prepared.command.issuanceId,
      conditionsDigest: prepared.conditionsDigest, publicCheckoutOrigin, actorId: context.actor.actorId, key: command.key,
      inputDigest: digest(command), atMs: clock() }, context.client);
    return { scope: structuredClone(context.scope), handoff, prepared };
  });
  if (!committed.handoff.checkoutReceipt) {
    let receipt: CheckoutEmissionReceiptV1 | null = null;
    try {
      const found = await bounded(timeout, signal => checkout.transport.reconcile(committed.prepared.command, signal));
      if (found.status === 200) receipt = decodeGourmetCheckoutEmissionReceiptV1(found.body, { ...committed.prepared, publicCheckoutOrigin });
      else if (found.status === 404 && command.operation === 'issue') {
        const prepared = await authorize(async context => {
          if (canonical(context.scope) !== canonical(committed.scope)) return fail('ACCESS_DENIED', 403);
          const current = await load(context);
          if (current.operationDigest !== committed.handoff.operationDigest || current.receipt!.agreementId !== committed.handoff.receipt!.agreementId) return fail('CHECKOUT_SOURCE_CONFLICT', 409);
          // Current catalogue/source/quote facts are required for a new checkout.
          // Historical approval actor/time are compared separately from the plan.
          const checked = await freshOperation(context, eventId, { ...command, operation: 'create' }, integration, clock);
          const original = current.operation;
          if (canonical(checked.operation.prepared.plan) !== canonical(original.prepared.plan)
            || canonical(checked.operation.recipient) !== canonical(original.recipient) || canonical(checked.operation.service) !== canonical(original.service)) return fail('CHECKOUT_SOURCE_CONFLICT', 409);
          return prepare(context, current, 'issue', checked.authorization.expiresAtMs);
        });
        if (prepared.command.authorization.expiresAtMs <= clock()) return fail('CHECKOUT_ISSUANCE_FORBIDDEN', 403);
        const created = await bounded(timeout, signal => checkout.transport.issue(prepared.command, signal));
        if (created.status === 200 || created.status === 201) receipt = decodeGourmetCheckoutEmissionReceiptV1(created.body, { ...prepared, publicCheckoutOrigin });
      }
    } catch { /* A lost response remains recoverable under the stable original-ledger key. */ }
    await finish(committed.scope, eventId, committed.handoff.operation.operationId, committed.prepared.command.issuanceId, receipt, clock());
  }
  return authorize(async context => {
    enabled(context);
    if (canonical(context.scope) !== canonical(committed.scope)) return fail('ACCESS_DENIED', 403);
    await prepare(context, await load(context), 'reconcile');
    return { ...await context.service.read(context.scope, context.actor, eventId),
      paymentAgreementOperationsV2: await integration.outbox.list(context.scope, eventId, context.client) };
  });
}
