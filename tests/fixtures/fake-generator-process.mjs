import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

// Public protocol fixture, not the external template or a production generator.
export function fakeGeneratorOutput(request) {
  return {
    schemaVersion: 1, mode: 'fixture-only', provenance: request.provenance,
    execution: { networkUsed: false, paymentCreated: false, published: false },
    paypalRequest: {
      method: 'POST', path: '/v1/checkout/payment-resources', headers: ['Accept: application/json'],
      body: { return_url: 'https://return.invalid/fixture', line_items: [{ unit_amount: {
        value: request.reservation.depositAmount, currency_code: request.reservation.currency,
      } }] },
    },
    landingHtml: '<!doctype html><html><head><title>Protocol fixture</title></head><body><a href="https://checkout.invalid/fixture">Fixture</a></body></html>',
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.includes('--fail')) { process.stderr.write('PRIVATE CHILD OUTPUT'); process.exit(1); }
  if (process.argv.includes('--malformed')) { process.stdout.write('PRIVATE CHILD OUTPUT'); process.exit(0); }
  if (process.env.CONTEXT_TEST_SECRET) { process.stderr.write('INHERITED SECRET'); process.exit(1); }
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  process.stdout.write(JSON.stringify(fakeGeneratorOutput(JSON.parse(input))));
}
