import type { EventQuoteRecord, PaymentContractPreparationV2, QuoteScope, QuoteVersion } from './event-quote-contracts';
import { assertEventQuoteRecord, digest } from './event-quote-workflow';
import { proposeRetainerBalanceDateV2, resolveApprovedLocalMinuteV2 } from './payment-calendar-v2';

export type PaymentAgreementReviewInputV2 = {
  /** Server-owned record, scope, current catalogue and clock; never a wire identity. */
  scope: QuoteScope; eventId: string; record: EventQuoteRecord; preparationId: string;
  currentCatalogDigest: string; configuration: unknown; nowMs: number;
};
type Blocked = { status: 'blocked'; code: string; fields: readonly string[] };
type Expiration = { configured: Record<string, unknown>; instant: string | null };
type Schedule = { configured: Record<string, unknown>; balanceInstant: string; eventInstant: string | null;
  proposedBalanceDate: string | null; timingReviewReason: string | null };
export type InternalPaymentPlanV2 = {
  contractVersion: 2; scope: QuoteScope; eventId: string; preparationId: string; preparationDigest: string;
  sourceQuote: { version: number; digest: string; approvalDigest: string; briefDigest: string; catalogDigest: string;
    artifactSha256: string; intendedRecipient: string; currency: 'USD'; totalCents: number; depositCents: number;
    depositBasis: PaymentContractPreparationV2['depositBasis']; terms: string };
  paymentMode: PaymentContractPreparationV2['paymentMode']; initialPaymentCents: number; paymentBalanceCents: number;
  canonicalLeadId: string; paymentTerms: string; termsChangeReason: string | null;
  paymentSchedule: Schedule | null; linkExpiration: Expiration;
};
type Review = { status: 'review_required'; plan: InternalPaymentPlanV2; reviewDigest: string };
type Prepared = { status: 'prepared_internal'; contractVersion: 2; plan: InternalPaymentPlanV2; reviewDigest: string;
  internalApproval: { actorId: string; atMs: number; purpose: 'internal_payment_plan_only'; reviewDigest: string };
  executable: false; providerEnabled: false; publicPaymentUrl: null;
  blockers: ['PROVIDER_DISABLED', 'RECEIVER_V2_UNAVAILABLE'] };
export type { Prepared as InternalPaymentPreparationV2 };

const block = (code: string, fields: readonly string[] = []): Blocked => ({ status: 'blocked', code, fields });
function object(raw: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) return null;
  const own = Reflect.ownKeys(raw);
  if (own.length !== keys.length || own.some(key => typeof key !== 'string' || !keys.includes(key))) return null;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return null;
  }
  return raw as Record<string, unknown>;
}
function text(raw: unknown, max: number): raw is string {
  return typeof raw === 'string' && raw.trim().length > 0 && raw.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(raw);
}
function futureMinute(date: unknown, time: unknown, timezone: unknown, nowMs: number): string | null {
  if (typeof date !== 'string' || typeof time !== 'string' || typeof timezone !== 'string') return null;
  const instant = resolveApprovedLocalMinuteV2(date, time, timezone);
  return instant && /:00Z$/.test(instant) && Date.parse(instant) > nowMs ? instant : null;
}
function expiration(raw: unknown, nowMs: number): Expiration | null {
  const never = object(raw, ['kind']);
  if (never?.kind === 'never') return { configured: { kind: 'never' }, instant: null };
  const at = object(raw, ['kind', 'date', 'time', 'timezone']);
  if (at?.kind !== 'at') return null;
  const instant = futureMinute(at.date, at.time, at.timezone, nowMs);
  return instant ? { configured: structuredClone(at), instant } : null;
}

/**
 * New internal contract only; never pass its facts to the v1 adapter or PHP
 * endpoint, which would discard them and enforce a fixed reservation instead.
 * This validates configured facts and computes a review fingerprint. It cannot
 * authenticate a caller, approve terms, create an agreement or dispatch a plan.
 */
export function reviewGourmetPaymentsAgreementV2(input: PaymentAgreementReviewInputV2): Review | Blocked {
  if (!Number.isSafeInteger(input.nowMs) || input.nowMs < 0 || input.nowMs > 8_640_000_000_000_000)
    return block('INVALID_NOW', ['nowMs']);
  try { assertEventQuoteRecord(input.record, input.scope, input.eventId); }
  catch { return block('INVALID_SOURCE_RECORD', ['record']); }
  const p = input.record.paymentContractPreparationsV2?.find(p => p.id === input.preparationId);
  const q = input.record.quotes.at(-1), brief = input.record.briefs.at(-1);
  if (!p || !q || !brief || p.quoteDigest !== q.digest || q.briefDigest !== brief.digest
    || input.record.audit.at(-1)!.atMs > input.nowMs || q.catalog.validUntilMs <= input.nowMs || q.catalogDigest !== input.currentCatalogDigest)
    return block('STALE_PAYMENT_CONFIGURATION', ['preparationId', 'quote', 'catalog']);
  return reviewValidatedPaymentPlanV2({ scope: input.scope, eventId: input.eventId, preparation: p, quote: q,
    configuration: input.configuration, nowMs: input.nowMs });
}

/** Pure reconstruction from already validated source rows. Used by bounded
 * aggregate replay at its historical audit time; it never authenticates an
 * actor, loads a record, calls PHP or turns a stored digest into authority. */
export function reviewValidatedPaymentPlanV2(input: {
  scope: QuoteScope; eventId: string; preparation: PaymentContractPreparationV2; quote: QuoteVersion;
  configuration: unknown; nowMs: number;
}): Review | Blocked {
  const p = input.preparation, q = input.quote;
  if (!Number.isSafeInteger(input.nowMs) || input.nowMs < 0 || input.nowMs > 8_640_000_000_000_000)
    return block('INVALID_NOW', ['nowMs']);
  if (p.initialPaymentCents <= 0 || p.paymentMode !== 'full_upfront' && p.paymentBalanceCents <= 0)
    return block('PAYMENT_AMOUNT_REVIEW_REQUIRED', ['initialPaymentCents', 'paymentBalanceCents']);
  const config = object(input.configuration, ['contractVersion', 'preparationId', 'paymentMode', 'canonicalLeadId',
    'paymentTerms', 'termsChangeReason', 'paymentSchedule', 'linkExpiration']);
  if (!config) return block('PAYMENT_CONFIGURATION_REQUIRED', ['configuration']);
  if (config.contractVersion !== 2 || config.preparationId !== p.id || config.paymentMode !== p.paymentMode)
    return block('PAYMENT_CONFIGURATION_BINDING_MISMATCH', ['contractVersion', 'preparationId', 'paymentMode']);
  if (!text(config.canonicalLeadId, 180) || config.canonicalLeadId.trim() !== config.canonicalLeadId || /[\r\n\t]/.test(config.canonicalLeadId))
    return block('CANONICAL_LEAD_REQUIRED', ['canonicalLeadId']);
  if (!text(config.paymentTerms, 4000)) return block('PAYMENT_TERMS_REQUIRED', ['paymentTerms']);
  const reason = config.termsChangeReason;
  if (reason !== null && !text(reason, 2000)) return block('INVALID_TERMS_REVIEW_REASON', ['termsChangeReason']);
  if ((!p.quotedDepositMatchesMode || config.paymentTerms !== p.terms) && !text(reason, 2000))
    return block('QUOTED_PAYMENT_TERMS_REVIEW_REQUIRED', ['termsChangeReason']);
  const linkExpiration = expiration(config.linkExpiration, input.nowMs);
  if (!linkExpiration) return block('LINK_EXPIRATION_REQUIRED', ['linkExpiration']);

  let paymentSchedule: Schedule | null = null;
  if (p.paymentMode === 'full_upfront') {
    if (config.paymentSchedule !== null || p.paymentBalanceCents !== 0)
      return block('FULL_UPFRONT_HAS_NO_BALANCE_SCHEDULE', ['paymentSchedule']);
  } else if (p.paymentMode === 'fixed_49_reservation') {
    const schedule = object(config.paymentSchedule, ['kind', 'balanceDate', 'balanceTime', 'timezone', 'agreedBalanceCents']);
    if (!schedule || schedule.kind !== p.paymentMode || schedule.agreedBalanceCents !== p.paymentBalanceCents)
      return block('FIXED_RESERVATION_BALANCE_AGREEMENT_REQUIRED', ['paymentSchedule']);
    const balanceInstant = futureMinute(schedule.balanceDate, schedule.balanceTime, schedule.timezone, input.nowMs);
    if (!balanceInstant) return block('FUTURE_BALANCE_DATE_REQUIRED', ['balanceDate', 'balanceTime', 'timezone']);
    paymentSchedule = { configured: structuredClone(schedule), balanceInstant, eventInstant: null, proposedBalanceDate: null, timingReviewReason: null };
  } else {
    const schedule = object(config.paymentSchedule, ['kind', 'eventDate', 'eventTime', 'timezone', 'balanceDate', 'balanceTime', 'timingExceptionReason']);
    if (!schedule || schedule.kind !== 'retainer_50') return block('PAYMENT_SCHEDULE_REQUIRED', ['paymentSchedule']);
    const proposal = proposeRetainerBalanceDateV2({ eventDate: typeof schedule.eventDate === 'string' ? schedule.eventDate : null,
      eventTime: typeof schedule.eventTime === 'string' ? schedule.eventTime : null,
      timezone: typeof schedule.timezone === 'string' ? schedule.timezone : null, nowMs: input.nowMs });
    const eventInstant = futureMinute(schedule.eventDate, schedule.eventTime, schedule.timezone, input.nowMs);
    const balanceInstant = futureMinute(schedule.balanceDate, schedule.balanceTime, schedule.timezone, input.nowMs);
    if (!proposal.proposedBalanceDate || !eventInstant || !balanceInstant)
      return block('PAYMENT_SCHEDULE_REVIEW_REQUIRED', ['eventDate', 'eventTime', 'balanceDate', 'balanceTime', 'timezone']);
    if (Date.parse(balanceInstant) >= Date.parse(eventInstant))
      return block('BALANCE_MUST_PRECEDE_EVENT', ['balanceDate', 'balanceTime']);
    const needsTimingReview = schedule.balanceDate !== proposal.proposedBalanceDate
      || proposal.codes.some(code => ['EVENT_DATE_NOT_FUTURE', 'EVENT_WITHIN_SEVEN_DAYS', 'PROPOSED_BALANCE_DATE_PAST'].includes(code));
    const timingReason = schedule.timingExceptionReason;
    if (timingReason !== null && !text(timingReason, 2000)) return block('INVALID_TIMING_REVIEW_REASON', ['timingExceptionReason']);
    if (needsTimingReview && !text(timingReason, 2000))
      return block('EXPLICIT_TIMING_REVIEW_REQUIRED', ['balanceDate', 'timingExceptionReason']);
    paymentSchedule = { configured: structuredClone(schedule), balanceInstant, eventInstant,
      proposedBalanceDate: proposal.proposedBalanceDate, timingReviewReason: timingReason as string | null };
  }

  const plan: InternalPaymentPlanV2 = {
    contractVersion: 2, scope: structuredClone(input.scope), eventId: input.eventId, preparationId: p.id, preparationDigest: p.digest,
    sourceQuote: { version: q.version, digest: q.digest, approvalDigest: p.approvalDigest, briefDigest: p.briefDigest,
      catalogDigest: p.catalogDigest, artifactSha256: p.artifactSha256, intendedRecipient: p.intendedRecipient,
      currency: p.currency, totalCents: p.totalCents, depositCents: p.depositCents, depositBasis: structuredClone(p.depositBasis), terms: p.terms },
    paymentMode: p.paymentMode, initialPaymentCents: p.initialPaymentCents, paymentBalanceCents: p.paymentBalanceCents,
    canonicalLeadId: config.canonicalLeadId, paymentTerms: config.paymentTerms, termsChangeReason: reason as string | null,
    paymentSchedule, linkExpiration,
  };
  return { status: 'review_required', plan, reviewDigest: digest(plan) };
}

/**
 * Explicit server-side internal review, with the same actor trust boundary as
 * EventQuoteService. A caller must resolve the authenticated actor itself; actor
 * fields and a hash supplied by a browser are not authority. Explicit synthetic
 * test composition may persist this evidence through the quote transaction.
 * The result is local review evidence, not customer consent or payment authority.
 */
export function prepareGourmetPaymentsAgreementV2(input: PaymentAgreementReviewInputV2, approval?: unknown): Prepared | Blocked {
  const reviewed = reviewGourmetPaymentsAgreementV2(input);
  if (reviewed.status === 'blocked') return reviewed;
  const decision = object(approval, ['actor', 'expectedReviewDigest']);
  if (!decision) return block('PAYMENT_TERMS_APPROVAL_REQUIRED', ['approval']);
  const actor = object(decision.actor, ['actorId', 'durable', 'expiresAtMs', 'canWrite', 'canApprove']);
  if (!actor || !text(actor.actorId, 96) || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(actor.actorId)
    || ['constructor', 'prototype', '__proto__'].includes(actor.actorId)
    || typeof actor.durable !== 'boolean' || actor.canWrite !== true || actor.canApprove !== true
    || !Number.isSafeInteger(actor.expiresAtMs) || (actor.expiresAtMs as number) <= input.nowMs)
    return block('APPROVAL_FORBIDDEN', ['actor']);
  if (input.scope.mode === 'commercial' && !actor.durable) return block('DURABLE_IDENTITY_REQUIRED', ['actor']);
  if (decision.expectedReviewDigest !== reviewed.reviewDigest)
    return block('STALE_PAYMENT_TERMS_REVIEW', ['expectedReviewDigest']);
  // Freeze the reviewed facts by value; subsequent caller mutation cannot alter
  // the plan being approved. This creates no agreement ID, token, URL or intent.
  return snapshotInternalPaymentPreparationV2(reviewed, actor.actorId, input.nowMs);
}

/** Data reconstruction only. Historical replay checks the authenticated command
 * audit separately; supplying an actor ID here grants no current authority. */
export function snapshotInternalPaymentPreparationV2(reviewed: Review, actorId: string, atMs: number): Prepared {
  return { status: 'prepared_internal', contractVersion: 2, plan: structuredClone(reviewed.plan), reviewDigest: reviewed.reviewDigest,
    internalApproval: { actorId, atMs, purpose: 'internal_payment_plan_only', reviewDigest: reviewed.reviewDigest },
    executable: false, providerEnabled: false, publicPaymentUrl: null, blockers: ['PROVIDER_DISABLED', 'RECEIVER_V2_UNAVAILABLE'] };
}
