import { spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';

/** Invoke an explicitly configured local pure adapter. Never accepts a command from conversation text. */
export function runFixtureAdapter(request, { command, args = [], timeout = 15000 } = {}) {
  if (!request || request.schemaVersion !== 1 || request.mode !== 'fixture-only') throw new Error('Solo se admite fixture-only.');
  if (typeof command !== 'string' || !command || !Array.isArray(args) || args.some(value => typeof value !== 'string')) {
    throw new Error('GENERATOR_UNAVAILABLE: configura un adaptador local revisado.');
  }
  const child = spawnSync(command, args, {
    input: JSON.stringify(request), encoding: 'utf8', timeout, maxBuffer: 2_000_000,
    env: { PATH: process.env.PATH || '/usr/bin:/bin', LANG: 'C.UTF-8' },
    shell: false,
  });
  // Do not echo a child process's potentially private stdout/stderr on failure.
  if (child.error || child.status !== 0) throw new Error(`GENERATOR_FAILED: el adaptador local falló (${child.error?.code || child.status}).`);
  let result;
  try { result = JSON.parse(child.stdout); } catch { throw new Error('GENERATOR_PROTOCOL_INVALID: salida no JSON.'); }
  return validateFixtureResult(request, result);
}

export function validateFixtureResult(request, result) {
  if (result?.schemaVersion !== 1 || result.mode !== 'fixture-only' ||
      !isDeepStrictEqual(result.provenance, request.provenance) ||
      !isDeepStrictEqual(result.execution, { networkUsed: false, paymentCreated: false, published: false })) {
    throw new Error('GENERATOR_PROTOCOL_INVALID: procedencia o restricciones alteradas.');
  }
  const paypal = result.paypalRequest;
  const item = paypal?.body?.line_items?.[0];
  if (paypal?.method !== 'POST' || paypal.path !== '/v1/checkout/payment-resources' ||
      !Array.isArray(paypal.body?.line_items) || paypal.body.line_items.length !== 1 ||
      item?.unit_amount?.value !== request.reservation.depositAmount ||
      item?.unit_amount?.currency_code !== request.reservation.currency ||
      !Array.isArray(paypal.headers) || paypal.headers.some(value => typeof value !== 'string' || /authorization|bearer/i.test(value))) {
    throw new Error('GENERATOR_PROTOCOL_INVALID: el payload no coincide con el importe y moneda revisados.');
  }
  let returnUrl;
  try { returnUrl = new URL(paypal.body.return_url); } catch { throw new Error('FIXTURE_URL_REQUIRED'); }
  if (returnUrl.protocol !== 'https:' || !returnUrl.hostname.endsWith('.invalid') || returnUrl.username || returnUrl.password) throw new Error('FIXTURE_URL_REQUIRED');
  if (typeof result.landingHtml !== 'string' || result.landingHtml.length > 1_000_000 ||
      /<(?:script|iframe|form|base|object|embed|svg|math)\b|\bon\w+\s*=|<meta\b[^>]*http-equiv/i.test(result.landingHtml)) {
    throw new Error('GENERATOR_PROTOCOL_INVALID: HTML de revisión no permitido.');
  }
  // The external template stays private. The public adapter returns only a local,
  // noninteractive preview with no scripts, forms, remote assets or payable link.
  let html = result.landingHtml.replace(/\s(?:href|src|action)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  const csp = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:; form-action \'none\'; base-uri \'none\'">';
  const banner = '<aside role="note" style="padding:16px;background:#fff3cf;color:#17231d">DEMO LOCAL · SIN PAGO · Historial incompleto. No es una reserva ni un enlace comercial.</aside>';
  html = html.replace(/<head(?:\s[^>]*)?>/i, match => `${match}${csp}`);
  html = html.replace(/<body(?:\s[^>]*)?>/i, match => `${match}${banner}`);
  if (!html.includes(csp) || !html.includes(banner)) throw new Error('GENERATOR_PROTOCOL_INVALID: falta estructura de página.');
  return { ...result, landingHtml: html };
}
