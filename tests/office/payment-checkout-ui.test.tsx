import React from 'react';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { createEventQuoteService, digest } from '../../src/office/backend/event-quote-workflow';
import type { EventQuoteView, PaymentContractModeV2 } from '../../src/office/backend/event-quote-contracts';
import type { PaymentAgreementOperationSummaryV2 } from '../../src/office/backend/payment-agreement-operations-v2';
import { assertPaymentCheckoutCommandV1, eventQuoteClient, exactPaymentCheckoutV1Command, exactQuoteReviewKey,
  isSafePaymentCheckoutUrl, validateQuoteStatus, validateQuoteView, type EventQuoteStatusResponse } from '../../src/office/event-quote-client';
import { PersistedPaymentPreparation } from '../../src/office/dashboard/PersistedQuoteWorkspace';
import { bindDashboardQuoteClient, DashboardQuoteAccessGate, type DashboardQuoteGrant } from '../../src/office/dashboard/quote-access';
import { MemoryEventQuoteStore, TEST_AT, testActor, testBrief, testCatalog, testScope } from './event-quote-fixtures';

const EVENT = 'checkout-ui';
const PARENT = '00000000-0000-4000-8000-000000000101';
const CHILD = '00000000-0000-4000-8000-000000000102';
const URL = 'https://synthetic.invalid/pay/' + 'x'.repeat(43);
async function fixture(mode: PaymentContractModeV2 = 'retainer_50') {
  const service = createEventQuoteService({ store: new MemoryEventQuoteStore(), catalogFor: async () => testCatalog, clock: () => TEST_AT,
    testPaymentDrafts: { resolveCanonicalLead: async () => ({ source: 'synthetic_fixture', canonicalLeadId: 'synthetic-checkout-lead' }),
      validateContract: async () => { throw new Error('UI fixture must not contact the receiver'); } } });
  const execute = (command: unknown) => service.execute(testScope, testActor, EVENT, command);
  let view = await execute({ action: 'create', key: 'create', expectedRevision: 0, brief: testBrief });
  view = await execute({ action: 'quote', key: 'quote', expectedRevision: 1, expectedBriefDigest: view.record.briefs[0].digest,
    expectedCatalogDigest: digest(testCatalog), selections: [{ itemId: 'TEST-ITEM', quantity: 100 }] });
  const q = view.record.quotes[0];
  view = await execute({ action: 'approve', key: 'approve', expectedRevision: 2, quoteVersion: q.version, quoteDigest: q.digest,
    artifactSha256: q.artifact.sha256, intendedRecipient: testBrief.recipient });
  view = await execute({ action: 'prepare_payment_v2', key: 'prepare', expectedRevision: 3, quoteVersion: q.version, quoteDigest: q.digest,
    approvalDigest: view.record.decisions[0].digest, artifactSha256: q.artifact.sha256, paymentMode: mode });
  const p = view.record.paymentContractPreparationsV2![0];
  view = await execute({ action: 'configure_payment_v2', key: 'configure', expectedRevision: 4, preparationId: p.id, preparationDigest: p.digest,
    paymentTerms: 'Condiciones sintéticas explícitas; sin consentimiento de cliente.', termsChangeReason: 'Revisión sintética expresa.',
    paymentSchedule: mode === 'full_upfront' ? null : mode === 'retainer_50'
      ? { kind: mode, eventDate: '2099-12-15', eventTime: '18:00', timezone: 'America/New_York', balanceDate: '2099-12-08', balanceTime: '12:00', timingExceptionReason: null }
      : { kind: mode, balanceDate: '2099-12-01', balanceTime: '12:00', timezone: 'UTC', agreedBalanceCents: p.paymentBalanceCents },
    linkExpiration: { kind: 'at', date: '2099-11-20', time: '13:00', timezone: 'UTC' } });
  const c = view.record.paymentConfigurationsV2![0];
  const parent: PaymentAgreementOperationSummaryV2 = { operationId: 'a'.repeat(64), operationDigest: 'b'.repeat(64),
    configurationId: c.id, configurationDigest: c.digest, status: 'draft_persisted', agreementId: PARENT,
    executable: false, providerEnabled: false, publicPaymentUrl: null, authorizationVerified: false,
    serviceAuthenticated: true, updatedAtMs: TEST_AT, checkoutConditionsDigest: 'c'.repeat(64) };
  view = { ...view, paymentAgreementOperationsV2: [parent] };
  const status: EventQuoteStatusResponse = { ...await service.status(testScope, testActor), paymentAgreementsEnabled: true,
    paymentCheckoutsEnabled: true, externalEffectsEnabled: false,
    session: { mode: 'test', canWrite: true, canApprove: true, csrfToken: 'synthetic-csrf-existing', expiresAtMs: testActor.expiresAtMs } };
  return { view, status, parent, configuration: c };
}
function checkout(status: 'pending' | 'reconciliation_required' | 'checkout_issued'): NonNullable<PaymentAgreementOperationSummaryV2['checkout']> {
  return { issuanceId: 'd'.repeat(64), conditionsDigest: 'c'.repeat(64), status,
    checkoutId: status === 'checkout_issued' ? CHILD : null, publicPaymentUrl: status === 'checkout_issued' ? URL : null,
    executable: false, providerEnabled: false, authorizationVerified: false, serviceAuthenticated: status === 'checkout_issued' };
}

test('checkout capability requires the explicit server flag rather than approval permission alone', async () => {
  const t = await fixture();
  assert.equal(validateQuoteStatus(t.status).paymentCheckoutsEnabled, true);
  for (const value of [false, 'true', null, 1]) assert.throws(() => validateQuoteStatus({ ...t.status, paymentCheckoutsEnabled: value }));
  assert.throws(() => validateQuoteStatus({ ...t.status, session: { ...t.status.session, mode: 'commercial' } }));
  const { paymentCheckoutsEnabled: _, ...noCapability } = t.status;
  assert.throws(() => exactPaymentCheckoutV1Command(t.view, noCapability, 'issue', t.configuration.id, 'issue', TEST_AT));
  assert.throws(() => exactPaymentCheckoutV1Command(t.view, { ...t.status, session: { ...t.status.session, canApprove: false } }, 'issue', t.configuration.id, 'issue', TEST_AT));
  assert.throws(() => exactPaymentCheckoutV1Command(t.view, t.status, 'issue', t.configuration.id, 'issue', t.status.session.expiresAtMs));
  for (const now of [NaN, Infinity, -1]) assert.throws(() => exactPaymentCheckoutV1Command(t.view, t.status, 'issue', t.configuration.id, 'issue', now));
  assert.throws(() => exactPaymentCheckoutV1Command(t.view, { ...t.status, catalog: null }, 'issue', t.configuration.id, 'issue', TEST_AT));
});

for (const mode of ['retainer_50', 'full_upfront', 'fixed_49_reservation'] as const) test(`${mode} issues only exact saved conditions from a current persisted parent`, async () => {
  const t = await fixture(mode), before = structuredClone(t.view);
  assert.deepEqual(exactPaymentCheckoutV1Command(t.view, t.status, 'issue', t.configuration.id, 'issue', TEST_AT), {
    key: 'issue', configurationId: t.configuration.id, configurationDigest: t.configuration.digest,
    expectedReviewDigest: t.configuration.reviewDigest, expectedConditionsDigest: t.parent.checkoutConditionsDigest, operation: 'issue' });
  assert.deepEqual(t.view, before);
  assert.throws(() => exactPaymentCheckoutV1Command({ ...t.view, currentQuoteStatus: 'obsolete' }, t.status, 'issue', t.configuration.id, 'issue', TEST_AT));
  delete t.parent.checkoutConditionsDigest;
  assert.throws(() => exactPaymentCheckoutV1Command(t.view, t.status, 'issue', t.configuration.id, 'issue', TEST_AT));
});

test('ambiguous checkout recovery only reconciles its saved issuance and never creates automatically', async () => {
  const t = await fixture();
  for (const state of ['pending', 'reconciliation_required'] as const) {
    t.parent.checkout = checkout(state);
    assert.throws(() => exactPaymentCheckoutV1Command(t.view, t.status, 'again', t.configuration.id, 'issue', TEST_AT));
    assert.equal(exactPaymentCheckoutV1Command({ ...t.view, currentQuoteStatus: 'obsolete' }, { ...t.status, catalogDigest: 'f'.repeat(64) },
      'lookup', t.configuration.id, 'reconcile', TEST_AT).operation, 'reconcile');
  }
  t.parent.checkout = checkout('checkout_issued');
  assert.throws(() => exactPaymentCheckoutV1Command(t.view, t.status, 'again', t.configuration.id, 'issue', TEST_AT));
  assert.throws(() => exactPaymentCheckoutV1Command(t.view, t.status, 'lookup', t.configuration.id, 'reconcile', TEST_AT));
});

test('decoder binds child state to its parent and conditions and rejects unsafe links or invented effects', async () => {
  const t = await fixture();
  for (const state of ['pending', 'reconciliation_required', 'checkout_issued'] as const) {
    t.parent.checkout = checkout(state); assert.equal(validateQuoteView(t.view, EVENT), t.view);
    const patches = [{ conditionsDigest: 'f'.repeat(64) }, { issuanceId: 'invalid' }, { executable: true }, { providerEnabled: true },
      { authorizationVerified: true }, { serviceAuthenticated: state !== 'checkout_issued' }, { extra: true },
      { publicPaymentUrl: 'javascript:alert(1)' }, { checkoutId: PARENT }, { status: 'paid' }];
    for (const patch of patches) {
      const bad = structuredClone(t.view); Object.assign(bad.paymentAgreementOperationsV2![0].checkout!, patch);
      assert.throws(() => validateQuoteView(bad, EVENT));
    }
  }
  for (const url of ['http://example.invalid/pay/' + 'x'.repeat(43), URL + '?token=other', URL + '#fragment',
    URL.replace('synthetic.invalid', 'user:password@synthetic.invalid'), URL.replace('/pay/', '/other/'), URL + '/', '/pay/' + 'x'.repeat(43)]) {
    assert.equal(isSafePaymentCheckoutUrl(url), false);
  }
  assert.equal(isSafePaymentCheckoutUrl(URL), true);
  assert.equal(isSafePaymentCheckoutUrl(URL.replace('https://synthetic.invalid', 'http://127.0.0.1:17771')), true);
});

test('transport posts only checkout pins with CSRF/access revision once and rejects identity extensions before fetch', async context => {
  const t = await fixture(), command = exactPaymentCheckoutV1Command(t.view, t.status, 'issue', t.configuration.id, 'issue', TEST_AT);
  const calls: { url: string; init: RequestInit }[] = [];
  context.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, init }); return new Response(JSON.stringify(t.view), { headers: { 'content-type': 'application/json' } });
  });
  await eventQuoteClient.executePaymentCheckout!(EVENT, command, 'explicit-csrf', new AbortController().signal, 'access-revision');
  assert.equal(calls.length, 1); assert.equal(calls[0].url, `/api/office/event-quotes/${EVENT}/payment-checkouts/v1`);
  assert.equal(calls[0].init.method, 'POST'); assert.equal(calls[0].init.credentials, 'same-origin'); assert.equal(calls[0].init.redirect, 'error');
  assert.deepEqual(JSON.parse(calls[0].init.body as string), command);
  assert.equal(new Headers(calls[0].init.headers).get('x-event-quote-csrf'), 'explicit-csrf');
  assert.equal(new Headers(calls[0].init.headers).get('x-event-quote-access-revision'), 'access-revision');
  for (const extra of [{ actorId: 'invented' }, { scope: testScope }, { publicPaymentUrl: URL }, { amountCents: 1 }, { provider: 'PAYPAL' }]) {
    assert.throws(() => assertPaymentCheckoutCommandV1({ ...command, ...extra }));
    await assert.rejects(() => eventQuoteClient.executePaymentCheckout!(EVENT, { ...command, ...extra }, 'csrf', new AbortController().signal));
  }
  assert.equal(calls.length, 1);
  context.mock.method(globalThis, 'fetch', async () => { calls.push({ url: 'uncertain', init: {} }); throw new Error('response lost'); });
  await assert.rejects(() => eventQuoteClient.executePaymentCheckout!(EVENT, command, 'csrf', new AbortController().signal));
  assert.equal(calls.filter(call => call.url === 'uncertain').length, 1);
});

test('bound Dashboard client preserves checkout transport, checks approval and prevents expired access dispatch', async () => {
  const t = await fixture(), command = exactPaymentCheckoutV1Command(t.view, t.status, 'issue', t.configuration.id, 'issue', TEST_AT);
  let calls = 0, now = TEST_AT;
  const source = { status: async () => t.status, read: async () => t.view, execute: async () => t.view,
    executePaymentCheckout: async () => { calls++; return t.view; } };
  const grant: DashboardQuoteGrant = { state: 'ready', identityKey: 'synthetic', durableIdentity: true, scope: testScope,
    eventIds: [EVENT], expiresAtMs: testActor.expiresAtMs, permissions: { canRead: true, canWrite: true, canApprove: true },
    catalog: { ready: true, digest: digest(testCatalog), authority: 'test_only', validUntilMs: testCatalog.validUntilMs } };
  const bound = bindDashboardQuoteClient(source, grant, new DashboardQuoteAccessGate().start(), () => now);
  await bound.executePaymentCheckout!(EVENT, command, 'csrf', new AbortController().signal); assert.equal(calls, 1);
  now = testCatalog.validUntilMs;
  await assert.rejects(() => bound.executePaymentCheckout!(EVENT, command, 'csrf', new AbortController().signal)); assert.equal(calls, 1);
  const denied = bindDashboardQuoteClient(source, { ...grant, permissions: { ...grant.permissions, canApprove: false } },
    new DashboardQuoteAccessGate().start(), () => TEST_AT);
  await assert.rejects(() => denied.executePaymentCheckout!(EVENT, command, 'csrf', new AbortController().signal)); assert.equal(calls, 1);
});

test('existing card offers an unchecked explicit emission and shows issued child separately without a payment claim', async context => {
  context.mock.method(Date, 'now', () => TEST_AT);
  const t = await fixture(); let calls = 0;
  const render = () => renderToStaticMarkup(<PersistedPaymentPreparation view={t.view} status={t.status} writable dirty={false}
    verified={exactQuoteReviewKey(t.view)} onPaymentCheckout={() => { calls++; }} />);
  let html = render(); assert.equal(calls, 0);
  assert.equal((html.match(/Preparación de enlace de pago/g) ?? []).length, 1);
  assert.match(html, /data-testid="payment-checkout-confirm-review"/); assert.doesNotMatch(html, /checked=""/);
  assert.match(html, /data-testid="payment-checkout-issue" disabled=""/); assert.doesNotMatch(html, /payment-checkout-link/);
  delete t.status.paymentCheckoutsEnabled; html = render(); assert.doesNotMatch(html, /payment-checkout-confirm-review|payment-checkout-issue/);
  t.status.paymentCheckoutsEnabled = true;
  for (const state of ['pending', 'reconciliation_required'] as const) {
    t.parent.checkout = checkout(state); html = render(); assert.match(html, /payment-checkout-reconcile/);
    assert.doesNotMatch(html, /payment-checkout-issue|payment-checkout-link/);
  }
  t.parent.checkout = checkout('checkout_issued'); html = render();
  assert.match(html, /Checkout emitido · proveedor desactivado/); assert.match(html, new RegExp(CHILD)); assert.match(html, /DRAFT_INTERNAL/);
  assert.match(html, /data-testid="payment-checkout-link"/); assert.match(html, /noopener noreferrer/);
  assert.match(html, /no significa consentimiento, autorización comercial ni cobro/); assert.match(html, /Cobrado: desconocido/);
  assert.doesNotMatch(html, /payment-checkout-issue|payment-checkout-reconcile/); assert.equal(calls, 0);
  t.parent.checkout.publicPaymentUrl = 'javascript:alert(1)'; assert.doesNotMatch(render(), /payment-checkout-link/);
});
