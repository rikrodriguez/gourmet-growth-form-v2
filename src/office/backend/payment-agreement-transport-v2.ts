import { EventQuoteError } from './event-quote-contracts';
import { canonical } from './event-quote-workflow';
import { paymentAgreementIdempotencyKeyV2, type PaymentAgreementTransportV2 } from './payment-agreement-operations-v2';

/** Explicit server-only original Payments transport. No environment discovery or
 * default secret/host. Omission leaves both methods disabled. */
export function createPaymentAgreementHttpTransportV2(options?: {
  baseUrl: string; resolveAuthorizationHeader(): string | Promise<string>;
  allowLoopbackTest?: boolean; fetch?: typeof fetch;
}): PaymentAgreementTransportV2 {
  if (!options) { const disabled = async (): Promise<never> => { throw new EventQuoteError('PAYMENT_AGREEMENTS_DISABLED',503); }; return { create:disabled,reconcile:disabled }; }
  let u: URL; try { u = new URL(options.baseUrl); } catch { throw new EventQuoteError('PAYMENT_AGREEMENT_TRANSPORT_INVALID',503); }
  const loopback = options.allowLoopbackTest === true && ['127.0.0.1','localhost','[::1]'].includes(u.hostname);
  if (u.origin !== options.baseUrl || u.username || u.password || u.search || u.hash || !(u.protocol === 'https:' || loopback && u.protocol === 'http:')) throw new EventQuoteError('PAYMENT_AGREEMENT_TRANSPORT_INVALID',503);
  const request = async (path:string,operationId:string,body:unknown,signal:AbortSignal) => {
    const auth = await options.resolveAuthorizationHeader();
    if (signal.aborted || typeof auth !== 'string' || !/^Bearer [^\s\r\n]{16,4096}$/.test(auth)) throw new EventQuoteError('PAYMENT_AGREEMENT_TRANSPORT_UNAVAILABLE',503);
    const r = await (options.fetch ?? fetch)(u.origin+path,{method:'POST',headers:{'content-type':'application/json','authorization':auth,'idempotency-key':paymentAgreementIdempotencyKeyV2(operationId)},body:canonical(body),signal,redirect:'error'});
    if (Number(r.headers.get('content-length') ?? 0) > 393_216) { await r.body?.cancel(); throw new EventQuoteError('PAYMENT_AGREEMENT_RECEIPT_INVALID',502); }
    const chunks:Uint8Array[]=[];let length=0;const reader=r.body?.getReader();
    if(reader)try{for(;;){const next=await reader.read();if(next.done)break;length+=next.value.byteLength;if(length>393_216){await reader.cancel();throw new EventQuoteError('PAYMENT_AGREEMENT_RECEIPT_INVALID',502);}chunks.push(next.value);}}finally{reader.releaseLock();}
    return {status:r.status,body:Buffer.concat(chunks).toString('utf8')};
  };
  return {create:(operation,authorization,signal)=>request('/internal/v2/payment-agreements',operation.operationId,{operation,authorization},signal),
    reconcile:(operationId,operationDigest,signal)=>request('/internal/v2/payment-agreements/reconcile',operationId,{operationId,operationDigest},signal)};
}
