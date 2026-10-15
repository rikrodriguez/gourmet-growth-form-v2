import assert from 'node:assert/strict';
import test from 'node:test';
import { operationFixture } from '../payments-contract/operational-cases';
import { TEST_AT, testScope } from './event-quote-fixtures';
import { digest, canonical } from '../../src/office/backend/event-quote-workflow';
import { prepareGourmetCheckoutConditionsV1 } from '../../src/office/backend/gourmet-checkout-conditions-v1';
import { prepareGourmetCheckoutEmissionV1, decodeGourmetCheckoutEmissionReceiptV1 } from '../../src/office/backend/gourmet-checkout-emission-v1';
import { createGourmetCheckoutTransportV1 } from '../../src/office/backend/gourmet-checkout-transport-v1';

async function fixture() {
  const { operation } = await operationFixture();
  const receipt = { contractVersion: 2, status: 'draft_persisted', agreementId: '00000000-0000-4000-8000-000000000101',
    operationId: operation.operationId, operationDigest: digest(operation), operation,
    executable: false, providerEnabled: false, publicPaymentUrl: null, authorizationVerified: false, serviceAuthenticated: true };
  const conditions = prepareGourmetCheckoutConditionsV1({ receipt, nowMs: TEST_AT });
  if (conditions.status === 'blocked') throw new Error(conditions.code);
  return { receipt, expectedConditionsDigest: conditions.conditionsDigest, nowMs: TEST_AT,
    authority: { actorId: 'SYNTHETIC-ISSUER', scope: testScope, purpose: 'issue_payment_checkout_v1', durable: true, canIssueCheckout: true, expiresAtMs: TEST_AT + 60_000 } };
}
test('issuance intent is stable across fresh actors while approval-only, stale review and scope substitution fail closed', async () => {
  const f = await fixture(), a = prepareGourmetCheckoutEmissionV1(f), b = prepareGourmetCheckoutEmissionV1({ ...f, nowMs: TEST_AT + 1,
    authority: { ...f.authority, actorId: 'ANOTHER-SYNTHETIC-ISSUER' } });
  assert.equal(a.status, 'prepared_checkout_emission'); assert.equal(b.status, 'prepared_checkout_emission');
  if (a.status === 'blocked' || b.status === 'blocked') throw new Error('Unexpected blocked fixture');
  assert.equal(a.command.issuanceId, b.command.issuanceId); assert.equal(a.idempotencyKey, b.idempotencyKey);
  assert.notEqual(a.body, b.body); assert.equal(a.body, canonical(a.command));
  for (const authority of [{ ...f.authority, canIssueCheckout: false, canApprove: true },
    { ...f.authority, purpose: 'create_disabled_payment_agreement_v2' }, { ...f.authority, expiresAtMs: TEST_AT },
    { ...f.authority, scope: { ...testScope, workspaceId: 'OTHER' } }])
    assert.equal(prepareGourmetCheckoutEmissionV1({ ...f, authority }).status, 'blocked');
  assert.equal(prepareGourmetCheckoutEmissionV1({ ...f, expectedConditionsDigest: 'f'.repeat(64) }).status, 'blocked');
});
test('unknown authority and historical receipt data cannot execute Proxy traps or accessors', async () => {
  const f = await fixture(); let observed = 0;
  const accessor = Object.defineProperty({}, 'operation', { enumerable: true, get() { observed++; throw new Error('getter executed'); } });
  const proxy = new Proxy(f.authority, { getPrototypeOf() { observed++; throw new Error('proxy executed'); } });
  assert.equal(prepareGourmetCheckoutEmissionV1({ ...f, authority: proxy }).status, 'blocked');
  assert.equal(prepareGourmetCheckoutEmissionV1({ ...f, receipt: accessor, operation: 'reconcile' }).status, 'blocked');
  assert.equal(prepareGourmetCheckoutEmissionV1({ ...f, receipt: new Proxy({}, { get() { observed++; throw new Error('proxy executed'); } }), operation: 'reconcile' }).status, 'blocked');
  assert.equal(observed, 0);
});
test('receipt requires a different checkout identity and exact conditions and original-host URL, never payment claims', async () => {
  const prepared = prepareGourmetCheckoutEmissionV1(await fixture());
  if (prepared.status === 'blocked') throw new Error(prepared.code);
  const receipt = { contractVersion: 1, status: 'checkout_issued', issuanceId: prepared.command.issuanceId,
    sourceDraftId: prepared.command.sourceDraftId, checkoutId: '00000000-0000-4000-8000-000000000102',
    conditionsDigest: prepared.conditionsDigest, conditions: prepared.conditions, providerAssessment: prepared.providerAssessment,
    publicPaymentUrl: `https://synthetic.invalid/pay/${'a'.repeat(43)}`, executable: false, providerEnabled: false,
    authorizationVerified: false, serviceAuthenticated: true };
  const expected = { ...prepared, publicCheckoutOrigin: 'https://synthetic.invalid' };
  assert.deepEqual(decodeGourmetCheckoutEmissionReceiptV1(JSON.stringify(receipt), expected), receipt);
  for (const patch of [{ checkoutId: receipt.sourceDraftId }, { providerEnabled: true }, { authorizationVerified: true }, { status: 'paid' },
    { publicPaymentUrl: `https://different.invalid/pay/${'a'.repeat(43)}` }, { conditions: { ...receipt.conditions, purpose: 'changed' } }])
    assert.throws(() => decodeGourmetCheckoutEmissionReceiptV1(JSON.stringify({ ...receipt, ...patch }), expected));
});
test('transport is disabled by omission, rejects unsafe origins and bounds the reply without following redirects', async () => {
  const p = prepareGourmetCheckoutEmissionV1(await fixture()); if (p.status === 'blocked') throw new Error(p.code);
  await assert.rejects(createGourmetCheckoutTransportV1().issue(p.command, new AbortController().signal));
  assert.throws(() => createGourmetCheckoutTransportV1({ baseUrl: 'http://unsafe.example', resolveAuthorizationHeader: () => '' }));
  let calls = 0;
  const transport = createGourmetCheckoutTransportV1({ baseUrl: 'https://synthetic.invalid', resolveAuthorizationHeader: () => `Bearer ${'x'.repeat(32)}`,
    fetch: async (_url, init) => { calls++; assert.equal(init?.redirect, 'error'); return new Response('x'.repeat(393_217)); } });
  await assert.rejects(transport.issue(p.command, new AbortController().signal));
  const control = new AbortController(); control.abort(); await assert.rejects(transport.issue(p.command, control.signal));
  assert.equal(calls, 1);
});
