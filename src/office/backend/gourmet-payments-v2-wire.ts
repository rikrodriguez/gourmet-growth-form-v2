import { canonical } from './event-quote-workflow';
import { prepareGourmetPaymentsAgreementV2, type InternalPaymentPreparationV2, type PaymentAgreementReviewInputV2 } from './gourmet-payments-agreement-v2';

type Blocked = { status: 'blocked'; code: string; fields?: readonly string[] };
export type GourmetPaymentsV2Wire = {
  status: 'prepared_wire_internal'; body: string; prepared: InternalPaymentPreparationV2;
};
export type GourmetPaymentsV2Receipt = {
  status: 'contract_validated_internal'; prepared: InternalPaymentPreparationV2;
  executable: false; providerEnabled: false; publicPaymentUrl: null; authorizationVerified: false;
};

const issued = new WeakSet<object>();
const RECEIPT_KEYS = ['status', 'prepared', 'executable', 'providerEnabled', 'publicPaymentUrl', 'authorizationVerified'];
const blocked = (): Blocked => ({ status: 'blocked', code: 'INVALID_PAYMENT_PLAN_V2_RECEIPT' });
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function exact(raw: unknown, keys: readonly string[]): raw is Record<string, unknown> {
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    && Object.keys(raw).length === keys.length && keys.every(key => Object.hasOwn(raw, key));
}

/**
 * Server-only, pure preparation. Resolve record, clock, configuration and actor
 * through authorized composition before calling; this helper authenticates none
 * of them. There is no transport or runtime caller. Only the existing reviewed
 * helper can originate a wire snapshot; never accept a client-supplied Prepared.
 */
export function prepareGourmetPaymentsV2Wire(input: PaymentAgreementReviewInputV2, approval?: unknown): GourmetPaymentsV2Wire | Blocked {
  const prepared = prepareGourmetPaymentsAgreementV2(input, approval);
  if (prepared.status === 'blocked') return prepared;
  const snapshot = structuredClone(prepared), body = canonical(snapshot);
  if (Buffer.byteLength(body, 'utf8') > 131_072)
    return { status: 'blocked', code: 'PAYMENT_PLAN_V2_WIRE_LIMIT' };
  const result = freeze({ status: 'prepared_wire_internal' as const, body, prepared: snapshot });
  issued.add(result);
  return result;
}

/**
 * Decode only a receipt for this exact immutable local snapshot. Equality and a
 * self-consistent digest are integrity checks, not authentication, customer
 * consent, financial evidence, replay protection or provider authorization.
 * Even a successful isolated PHP validation leaves execution disabled.
 */
export function decodeGourmetPaymentsV2Receipt(raw: string, expected: GourmetPaymentsV2Wire): GourmetPaymentsV2Receipt | Blocked {
  if (!expected || !issued.has(expected) || typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > 262_144) return blocked();
  try {
    const value: unknown = JSON.parse(raw);
    if (exact(value, ['status', 'code']) && value.status === 'blocked' && typeof value.code === 'string'
      && value.code.length > 0 && value.code.length <= 128) return freeze({ status: 'blocked', code: value.code });
    if (!exact(value, RECEIPT_KEYS) || value.status !== 'contract_validated_internal'
      || value.executable !== false || value.providerEnabled !== false || value.publicPaymentUrl !== null
      || value.authorizationVerified !== false || canonical(value.prepared) !== expected.body) return blocked();
    return freeze(value as GourmetPaymentsV2Receipt);
  } catch { return blocked(); }
}
