import React from 'react';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import * as client from '../../src/office/event-quote-client';
import { PersistedPaymentPreparation } from '../../src/office/dashboard/PersistedQuoteWorkspace';
import { bindDashboardQuoteClient, DashboardQuoteAccessGate, type DashboardQuoteGrant } from '../../src/office/dashboard/quote-access';
import { digest } from '../../src/office/backend/event-quote-workflow';
import { TEST_AT, testActor, testBrief, testCatalog, testScope, testService } from './event-quote-fixtures';
import type { EventQuoteView } from '../../src/office/backend/event-quote-contracts';

const EVENT = 'payment-contract-v2-ui';
const modes = ['retainer_50', 'full_upfront', 'fixed_49_reservation'] as const;
async function approved(catalog = testCatalog, quantity = 100) {
  const t = testService(), execute = (command: unknown) => t.service.execute(testScope, testActor, EVENT, command);
  t.catalog(catalog);
  let view = await execute({ action: 'create', key: 'create', expectedRevision: 0, brief: testBrief });
  view = await execute({ action: 'quote', key: 'quote', expectedRevision: 1, expectedBriefDigest: view.record.briefs[0].digest,
    expectedCatalogDigest: digest(catalog), selections: [{ itemId: 'TEST-ITEM', quantity }] });
  const q = view.record.quotes[0];
  view = await execute({ action: 'approve', key: 'approve', expectedRevision: 2, quoteVersion: q.version, quoteDigest: q.digest,
    artifactSha256: q.artifact.sha256, intendedRecipient: testBrief.recipient });
  const status: client.EventQuoteStatusResponse = { ...await t.service.status(testScope, testActor), externalEffectsEnabled: false,
    session: { mode: testScope.mode, canWrite: true, canApprove: true, csrfToken: 'synthetic-csrf-existing', expiresAtMs: testActor.expiresAtMs } };
  return { ...t, view, status, execute };
}
function v2Command(view: EventQuoteView, status: client.EventQuoteStatusResponse, mode: unknown) {
  const fn = (client as Record<string, unknown>).exactPaymentContractV2Preparation;
  assert.equal(typeof fn, 'function');
  return (fn as (...args: unknown[]) => Record<string, unknown>)(view, status, 'prepare-v2', mode, TEST_AT);
}
function v2Blocked(view: EventQuoteView, status: client.EventQuoteStatusResponse) {
  const fn = (client as Record<string, unknown>).paymentContractV2PreparationBlocked;
  assert.equal(typeof fn, 'function');
  return (fn as (...args: unknown[]) => boolean)(view, status, TEST_AT);
}

test('V2 commands require an explicit mode and preserve the exact approved quote pins', async () => {
  const t = await approved(), q = t.view.record.quotes[0];
  for (const mode of ['', undefined, null, '49', 'automatic']) assert.throws(() => v2Command(t.view, t.status, mode));
  for (const mode of modes) assert.deepEqual(v2Command(t.view, t.status, mode), {
    action: 'prepare_payment_v2', key: 'prepare-v2', expectedRevision: t.view.record.revision, quoteVersion: q.version,
    quoteDigest: q.digest, approvalDigest: t.view.record.decisions[0].digest, artifactSha256: q.artifact.sha256, paymentMode: mode,
  });
});

test('legacy history never blocks a separate V2 draft; one V2 draft blocks all other modes for that quote', async () => {
  const t = await approved();
  const legacy = await t.execute(client.exactPaymentPreparation(t.view, t.status, 'legacy', TEST_AT));
  assert.equal(v2Blocked(legacy, t.status), false);
  const next = await t.execute(v2Command(legacy, t.status, 'retainer_50'));
  assert.equal(v2Blocked(next, t.status), true);
  for (const mode of modes) assert.throws(() => v2Command(next, t.status, mode));
  assert.deepEqual(next.record.paymentPreparations, legacy.record.paymentPreparations);
});

test('payment card starts with no selected mode and shows the three explicit choices', async context => {
  context.mock.method(Date, 'now', () => TEST_AT);
  const t = await approved();
  const html = renderToStaticMarkup(<PersistedPaymentPreparation view={t.view} status={t.status} writable dirty={false} verified={client.exactQuoteReviewKey(t.view)} />);
  assert.equal((html.match(/Preparación de enlace de pago/g) ?? []).length, 1);
  assert.match(html, /data-testid="persisted-payment-mode"/);
  assert.match(html, /<option value="" selected="">/);
  for (const mode of modes) assert.match(html, new RegExp(`value="${mode}"`));
  assert.match(html, /data-testid="persisted-payment-prepare" disabled=""/);
  assert.doesNotMatch(html, /<a\b|href=|<iframe\b|https:\/\//);
});

for (const mode of modes) test(`saved ${mode} draft remains pending configuration and preserves legacy history`, async context => {
  context.mock.method(Date, 'now', () => TEST_AT);
  const t = await approved(), legacy = await t.execute(client.exactPaymentPreparation(t.view, t.status, 'legacy', TEST_AT));
  const view = await t.execute(v2Command(legacy, t.status, mode));
  assert.equal(client.validateQuoteView(view, EVENT), view);
  const html = renderToStaticMarkup(<PersistedPaymentPreparation view={view} status={t.status} writable dirty={false} verified={client.exactQuoteReviewKey(view)} />);
  assert.equal((html.match(/Preparación de enlace de pago/g) ?? []).length, 1);
  assert.match(html, /Legado/); assert.match(html, /Borrador de contrato v2/);
  assert.match(html, /Pendiente de configuración y aprobación · sin enlace/);
  assert.match(html, /Anticipo cotizado/); assert.match(html, /Cobrado: desconocido/);
  if (mode === 'full_upfront') {
    assert.match(html, /100 % por adelantado/); assert.match(html, /Pago único/); assert.match(html, /Sin saldo futuro/);
  } else if (mode === 'retainer_50') {
    assert.match(html, /50 % inicial/); assert.match(html, /7 días calendario antes/); assert.match(html, /propuesta/);
  } else {
    assert.match(html, /Reserva fija de USD 49/); assert.match(html, /fecha acordada/);
  }
  assert.doesNotMatch(html, /<a\b|href=|<form\b|<iframe\b|https:\/\/|provider_ready|Pago confirmado/);
});

test('schema 3 response validation rejects forged V2 financial and approval evidence', async () => {
  const t = await approved(), view = await t.execute(v2Command(t.view, t.status, 'retainer_50'));
  for (const [field, value] of [
    ['initialPaymentCents', 1], ['paymentBalanceCents', 0], ['quotedDepositMatchesMode', false],
    ['publicPaymentUrl', 'https://example.invalid/pay'], ['providerEnabled', true], ['paymentTermsApproval', { approved: true }],
    ['canonicalLeadId', 'invented-lead'], ['paymentSchedule', { at: '2027-01-01' }], ['paymentTerms', 'invented'],
  ]) {
    const forged = structuredClone(view) as unknown as { record: { paymentContractPreparationsV2: Record<string, unknown>[] } };
    forged.record.paymentContractPreparationsV2[0][field as string] = value;
    assert.throws(() => client.validateQuoteView(forged, EVENT), `reject ${field}`);
  }
  const duplicate = structuredClone(view) as unknown as { record: { paymentContractPreparationsV2: unknown[] } };
  duplicate.record.paymentContractPreparationsV2.push(structuredClone(duplicate.record.paymentContractPreparationsV2[0]));
  assert.throws(() => client.validateQuoteView(duplicate, EVENT));
});

test('dashboard grant requires approval permission before forwarding V2 preparation', async () => {
  const t = await approved(); let called = false;
  const grant: DashboardQuoteGrant = { state: 'ready', identityKey: 'synthetic', durableIdentity: false, scope: testScope,
    eventIds: [EVENT], expiresAtMs: testActor.expiresAtMs, permissions: { canRead: true, canWrite: true, canApprove: false },
    catalog: { ready: true, digest: digest(testCatalog), authority: 'test_only', validUntilMs: testCatalog.validUntilMs } };
  const bound = bindDashboardQuoteClient({ status: async () => t.status, read: async () => t.view,
    execute: async () => { called = true; return t.view; } }, grant, new DashboardQuoteAccessGate().start(), () => TEST_AT);
  await assert.rejects(() => bound.execute(EVENT, v2Command(t.view, t.status, 'full_upfront') as never, 'synthetic', new AbortController().signal));
  assert.equal(called, false);
});

for (const mode of modes) test(`explicit ${mode} selection enables only a safe preparation action`, async context => {
  context.mock.method(Date, 'now', () => TEST_AT);
  const t = await approved();
  const html = renderToStaticMarkup(<PersistedPaymentPreparation view={t.view} status={t.status} writable dirty={false}
    verified={client.exactQuoteReviewKey(t.view)} paymentMode={mode} />);
  assert.match(html, new RegExp(`<option value="${mode}" selected="">`));
  assert.doesNotMatch(html, /data-testid="persisted-payment-prepare" disabled=""/);
  assert.doesNotMatch(html, /<a\b|href=|<form\b|https:\/\//);
});

test('a quoted percentage equal to USD 49 never selects or approves the fixed reservation mode', async context => {
  context.mock.method(Date, 'now', () => TEST_AT);
  const t = await approved({ ...testCatalog, taxBps: 0, depositBps: 5000,
    items: [{ ...testCatalog.items[0], unitPriceCents: 4900 }] }, 2);
  assert.equal(t.view.record.quotes[0].depositCents, 4900);
  const html = renderToStaticMarkup(<PersistedPaymentPreparation view={t.view} status={t.status} writable dirty={false} verified={client.exactQuoteReviewKey(t.view)} />);
  assert.match(html, /<option value="" selected="">/);
  assert.match(html, /data-testid="persisted-payment-prepare" disabled=""/);
  const view = await t.execute(v2Command(t.view, t.status, 'fixed_49_reservation'));
  const draft = view.record.paymentContractPreparationsV2![0];
  assert.equal(draft.quotedDepositMatchesMode, false); assert.equal(draft.paymentTermsApproval, null);
  assert.ok(draft.blockers.includes('QUOTED_PAYMENT_TERMS_REVIEW_REQUIRED'));
});

test('full upfront V2 draft shows a single payment and omits a future balance schedule requirement', async context => {
  context.mock.method(Date, 'now', () => TEST_AT);
  const t = await approved(), view = await t.execute(v2Command(t.view, t.status, 'full_upfront'));
  assert.equal(client.validateQuoteView(view, EVENT), view);
  const html = renderToStaticMarkup(<PersistedPaymentPreparation view={view} status={t.status} />);
  assert.match(html, /Pago único/); assert.match(html, /Sin saldo futuro/);
  assert.doesNotMatch(html, /7 días|fecha acordada|Faltan calendario|saldo: /);
});

test('schema versions retain their own ledgers and reject extra V2 evidence or missing blockers', async () => {
  const t = await approved(), view = await t.execute(v2Command(t.view, t.status, 'retainer_50'));
  for (const schemaVersion of [1, 2]) assert.throws(() => client.validateQuoteView({ ...view, record: { ...view.record, schemaVersion } }, EVENT));
  for (const paymentPreparations of [undefined, null]) assert.throws(() => client.validateQuoteView({ ...view, record: { ...view.record, paymentPreparations } }, EVENT));
  assert.throws(() => client.validateQuoteView({ ...view, record: { ...view.record, paymentContractPreparationsV2: [] } }, EVENT));
  for (const patch of [
    { depositBasis: { kind: 'quoted_percentage', basisPoints: 10000 } }, { paymentMode: 'automatic' },
    { blockers: [] }, { quotedTermsMatch: true }, { quoteVersion: 100 }, { terms: 'substituted' },
    { totalCents: 0 }, { approvalDigest: 'a'.repeat(64) },
  ]) {
    const forged = structuredClone(view);
    Object.assign(forged.record.paymentContractPreparationsV2![0], patch);
    assert.throws(() => client.validateQuoteView(forged, EVENT));
  }
});
