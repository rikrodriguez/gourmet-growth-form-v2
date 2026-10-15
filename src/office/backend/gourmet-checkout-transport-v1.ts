import { EventQuoteError } from './event-quote-contracts';
import { canonical } from './event-quote-workflow';
import { checkoutEmissionIdempotencyKeyV1, type CheckoutEmissionCommandV1 } from './gourmet-checkout-emission-v1';

/** Explicit original Payments transport. No host, credential discovery or
 * production composition is added. Provider activation remains separate. */
export function createGourmetCheckoutTransportV1(options?: {
  baseUrl: string; resolveAuthorizationHeader(): string | Promise<string>;
  publicCheckoutOrigin?: string;
  allowLoopbackTest?: boolean; fetch?: typeof fetch;
}) {
  if (!options) { const disabled = async (_command: CheckoutEmissionCommandV1, _signal: AbortSignal): Promise<never> => {
    throw new EventQuoteError('CHECKOUT_EMISSION_DISABLED', 503);
  }; return { publicCheckoutOrigin: null, issue: disabled, reconcile: disabled }; }
  let url: URL;
  try { url = new URL(options.baseUrl); } catch { throw new EventQuoteError('CHECKOUT_TRANSPORT_INVALID', 503); }
  const loopback = options.allowLoopbackTest === true && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.origin !== options.baseUrl || url.username || url.password || url.search || url.hash
    || !(url.protocol === 'https:' || loopback && url.protocol === 'http:')) throw new EventQuoteError('CHECKOUT_TRANSPORT_INVALID', 503);
  let publicOrigin: URL;
  try { publicOrigin = new URL(options.publicCheckoutOrigin ?? options.baseUrl); } catch { throw new EventQuoteError('CHECKOUT_TRANSPORT_INVALID', 503); }
  if (publicOrigin.origin !== (options.publicCheckoutOrigin ?? options.baseUrl) || publicOrigin.username || publicOrigin.password
    || !(publicOrigin.protocol === 'https:' || options.allowLoopbackTest === true && publicOrigin.protocol === 'http:'
      && ['127.0.0.1', 'localhost', '[::1]'].includes(publicOrigin.hostname))) throw new EventQuoteError('CHECKOUT_TRANSPORT_INVALID', 503);
  const request = async (path: string, command: CheckoutEmissionCommandV1, signal: AbortSignal) => {
    const authorization = await options.resolveAuthorizationHeader();
    if (signal.aborted || typeof authorization !== 'string' || !/^Bearer [^\s\r\n]{16,4096}$/.test(authorization))
      throw new EventQuoteError('CHECKOUT_TRANSPORT_UNAVAILABLE', 503);
    const response = await (options.fetch ?? fetch)(url.origin + path, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization,
        'idempotency-key': checkoutEmissionIdempotencyKeyV1(command.issuanceId) },
      body: canonical(command), signal, redirect: 'error',
    });
    if (Number(response.headers.get('content-length') ?? 0) > 393_216) {
      await response.body?.cancel(); throw new EventQuoteError('CHECKOUT_EMISSION_RECEIPT_INVALID', 502);
    }
    const chunks: Uint8Array[] = []; let length = 0;
    const reader = response.body?.getReader();
    if (reader) try {
      for (;;) {
        const next = await reader.read(); if (next.done) break;
        length += next.value.byteLength;
        if (length > 393_216) { await reader.cancel(); throw new EventQuoteError('CHECKOUT_EMISSION_RECEIPT_INVALID', 502); }
        chunks.push(next.value);
      }
    } finally { reader.releaseLock(); }
    return { status: response.status, body: Buffer.concat(chunks).toString('utf8') };
  };
  return { publicCheckoutOrigin: publicOrigin.origin,
    issue: (command: CheckoutEmissionCommandV1, signal: AbortSignal) => request('/internal/payment-checkouts/v1', command, signal),
    reconcile: (command: CheckoutEmissionCommandV1, signal: AbortSignal) => request('/internal/payment-checkouts/v1/reconcile', command, signal) };
}
