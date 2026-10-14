import React from 'react';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { EventQuoteError, type EventQuoteView, type PreparePaymentCommand, type QuoteActor, type QuoteScope } from '../../src/office/backend/event-quote-contracts';
import { assertEventQuoteRecord, createEventQuoteService, digest } from '../../src/office/backend/event-quote-workflow';
import { createEventQuoteApi, EVENT_QUOTE_API, EVENT_QUOTE_CSRF_HEADER } from '../../src/office/backend/event-quote-http';
import { exactPaymentPreparation, paymentPreparationBlocked, paymentPreparationIsCurrent, validateQuoteView, type EventQuoteStatusResponse } from '../../src/office/event-quote-client';
import { PersistedPaymentPreparation } from '../../src/office/dashboard/PersistedQuoteWorkspace';
import { bindDashboardQuoteClient, DashboardQuoteAccessGate, type DashboardQuoteGrant } from '../../src/office/dashboard/quote-access';
import { TEST_AT, testActor, testBrief, testCatalog, testScope, testService } from './event-quote-fixtures';
const EVENT = 'payment-test';
async function setup(scope: QuoteScope = testScope, approve = true) {
  const t = testService(), execute = (raw: unknown, actor = testActor) => t.service.execute(scope, actor, EVENT, raw);
  let view = await execute({ action: 'create', key: 'create', expectedRevision: 0, brief: testBrief });
  view = await execute({ action: 'quote', key: 'quote', expectedRevision: 1, expectedBriefDigest: view.record.briefs[0].digest,
    expectedCatalogDigest: digest(testCatalog), selections: [{ itemId: 'TEST-ITEM', quantity: 24 }] });
  const q = view.record.quotes[0];
  if (approve) view = await execute({ action: 'approve', key: 'approve', expectedRevision: 2, quoteVersion: q.version, quoteDigest: q.digest, artifactSha256: q.artifact.sha256, intendedRecipient: testBrief.recipient });
  const status: EventQuoteStatusResponse = { ...await t.service.status(scope, testActor), externalEffectsEnabled: false,
    session: { mode: scope.mode, canWrite: true, canApprove: true, csrfToken: 'synthetic-csrf-existing', expiresAtMs: testActor.expiresAtMs } };
  return { ...t, view, status, execute, input: () => exactPaymentPreparation(view, status, 'prepare', TEST_AT) };
}
const rejected = (error: unknown) => error instanceof EventQuoteError;

test('payment preparation preserves approved amounts and terms in an immutable schema 2 pending snapshot', async () => {
  const t = await setup(); assert.equal(t.view.record.schemaVersion, 1); assert.equal(t.view.record.paymentPreparations, undefined);
  const before = structuredClone(t.view), next = await t.execute(t.input()), p = next.record.paymentPreparations![0], q = before.record.quotes[0];
  assert.equal(next.record.schemaVersion, 2); assert.equal(next.record.revision, 4); assert.equal(next.record.audit.at(-1)!.action, 'prepare_payment');
  assert.equal(p.totalCents, q.totalCents); assert.equal(p.depositCents, q.depositCents); assert.notEqual(p.depositCents, 4900);
  assert.equal(p.remainingCents, q.totalCents - q.depositCents); assert.equal(p.terms, q.catalog.terms);
  assert.equal(p.approvalDigest, before.record.decisions[0].digest); assert.equal(p.artifactSha256, q.artifact.sha256);
  assert.equal(p.status, 'pending_provider_review'); assert.equal(p.providerEnabled, false); assert.equal(p.publicPaymentUrl, null);
  assert.deepEqual(p.blockers, ['PROVIDER_DISABLED', 'LEGACY_TERMS_UNVERIFIED', 'CANONICAL_LEAD_REQUIRED', 'PAYMENT_SCHEDULE_REQUIRED']);
  assert.equal(next.externalEffectsEnabled, false); assert.equal(next.currentQuoteStatus, 'approved_internal_unsent');
  assert.deepEqual(next.record.quotes, before.record.quotes); assert.deepEqual(next.record.decisions, before.record.decisions);
  assertEventQuoteRecord(next.record, testScope, EVENT); assert.deepEqual(validateQuoteView(next, EVENT), next);
  assert.equal(paymentPreparationIsCurrent(p, next, TEST_AT), true); assert.equal(paymentPreparationBlocked(next, t.status, TEST_AT), true);
  const restarted = createEventQuoteService({ store: t.store, catalogFor: async () => testCatalog, clock: () => TEST_AT });
  assert.deepEqual(await restarted.read(testScope, testActor, EVENT), next);
});

test('lost-response retry and concurrent identical requests retain one preparation, receipt and audit', async () => {
  const t = await setup(), input = t.input();
  const results = await Promise.all([t.execute(input), t.execute(input), t.execute(input)]);
  assert.deepEqual(results[0], results[1]); assert.deepEqual(results[0], results[2]);
  assert.equal(results[0].record.paymentPreparations!.length, 1); assert.equal(results[0].record.revision, 4);
  await assert.rejects(() => t.execute({ ...input, key: 'other-key', expectedRevision: 4 }), rejected);
  await assert.rejects(() => t.execute(input, { ...testActor, actorId: 'other-author' }), rejected);
});

for (const field of ['quoteVersion', 'quoteDigest', 'approvalDigest', 'artifactSha256', 'expectedRevision'] as const) {
  test(`payment preparation rejects a stale or substituted ${field}`, async () => {
    const t = await setup(), input = t.input();
    await assert.rejects(() => t.execute({ ...input, [field]: typeof input[field] === 'number' ? Number(input[field]) + 1 : 'a'.repeat(64) }), rejected);
    assert.deepEqual(await t.service.read(testScope, testActor, EVENT), t.view);
  });
}
for (const forbidden of ['amountCents', 'depositCents', 'publicPaymentUrl', 'providerEnabled', 'recipient', 'scope', 'actorId', 'balance_due_date']) {
  test(`browser cannot inject ${forbidden} into preparation`, async () => {
    const t = await setup(); await assert.rejects(() => t.execute({ ...t.input(), [forbidden]: 'forged' }), rejected);
    assert.equal((await t.service.read(testScope, testActor, EVENT)).record.revision, 3);
  });
}
for (const actor of [{ ...testActor, canApprove: false }, { ...testActor, canWrite: false }, { ...testActor, expiresAtMs: TEST_AT }]) {
  test(`preparation requires current write and approval capabilities: ${JSON.stringify(actor)}`, async () => {
    const t = await setup(); await assert.rejects(() => t.execute(t.input(), actor), rejected);
  });
}
test('pending review cannot be converted into a payment preparation', async () => {
  const t = await setup(testScope, false), q = t.view.record.quotes[0];
  assert.equal(paymentPreparationBlocked(t.view, t.status, TEST_AT), true);
  await assert.rejects(() => t.execute({ action: 'prepare_payment', key: 'prepare', expectedRevision: 2, quoteVersion: 1, quoteDigest: q.digest, approvalDigest: 'a'.repeat(64), artifactSha256: q.artifact.sha256 }), rejected);
});

test('brief/catalogue changes obsolete a preparation and never change its historical amounts', async () => {
  const t = await setup(), prepared = await t.execute(t.input()), first = structuredClone(prepared.record.paymentPreparations![0]);
  const edited = await t.execute({ action: 'brief', key: 'brief2', expectedRevision: 4, brief: { ...testBrief, attendees: 25 } });
  assert.equal(paymentPreparationIsCurrent(first, edited, TEST_AT), false); assert.equal(paymentPreparationBlocked(edited, t.status, TEST_AT), true);
  await assert.rejects(() => t.execute({ ...t.input(), key: 'stale', expectedRevision: 5 }), rejected);
  assert.deepEqual(edited.record.paymentPreparations![0], first);
  let newer = await t.execute({ action: 'quote', key: 'quote2', expectedRevision: 5, expectedBriefDigest: edited.record.briefs[1].digest, expectedCatalogDigest: digest(testCatalog), selections: [{ itemId: 'TEST-ITEM', quantity: 25 }] });
  const q = newer.record.quotes[1];
  newer = await t.execute({ action: 'approve', key: 'approve2', expectedRevision: 6, quoteVersion: 2, quoteDigest: q.digest, artifactSha256: q.artifact.sha256, intendedRecipient: testBrief.recipient });
  newer = await t.execute(exactPaymentPreparation(newer, t.status, 'prepare2', TEST_AT));
  assert.equal(newer.record.paymentPreparations!.length, 2); assert.deepEqual(newer.record.paymentPreparations![0], first);
  assert.equal(paymentPreparationIsCurrent(first, newer, TEST_AT), false); assert.equal(paymentPreparationIsCurrent(newer.record.paymentPreparations![1], newer, TEST_AT), true);
  t.catalog({ ...testCatalog, version: 'v2' });
  assert.equal(paymentPreparationIsCurrent(newer.record.paymentPreparations![1], await t.service.read(testScope, testActor, EVENT), TEST_AT), false);
});

test('catalogue revision and expiry block preparation and replay rather than changing terms', async () => {
  for (const change of ['revision', 'expiry'] as const) {
    const t = await setup(), input = t.input(); await t.execute(input);
    if (change === 'revision') t.catalog({ ...testCatalog, version: 'v2' }); else t.clock(testCatalog.validUntilMs);
    if (change === 'expiry') await assert.rejects(() => t.execute(input), rejected);
    else {
      const replay = await t.execute(input); assert.equal(paymentPreparationIsCurrent(replay.record.paymentPreparations![0], replay, TEST_AT), false);
      await assert.rejects(() => t.execute({ ...input, key: 'new', expectedRevision: 4 }), rejected);
    }
  }
});

test('same event and quote content in another tenant has a different preparation identity and no cross-scope access', async () => {
  const a = await setup(), b = await setup({ ...testScope, workspaceId: 'OTHER-WORKSPACE' });
  const pa = (await a.execute(a.input())).record.paymentPreparations![0], pb = (await b.execute(b.input())).record.paymentPreparations![0];
  assert.equal(pa.quoteDigest, pb.quoteDigest); assert.notEqual(pa.id, pb.id);
  await assert.rejects(() => a.service.execute({ ...testScope, organizationId: 'OTHER' }, testActor, EVENT, a.input()), rejected);
  await assert.rejects(() => a.service.execute(testScope, testActor, 'OTHER-EVENT', a.input()), rejected);
});

test('HTTP preparation uses approval authorization, CSRF and same-origin before mutation', async () => {
  const t = await setup(); let actor: QuoteActor = { ...testActor };
  const app = createEventQuoteApi({ service: t.service, allowedOrigin: 'https://quotes.test', clock: () => TEST_AT,
    resolveIdentity: () => ({ scope: testScope, actor, csrfToken: 'synthetic-csrf-existing', expiresAtMs: testActor.expiresAtMs }) });
  const headers = { host: 'quotes.test', origin: 'https://quotes.test', [EVENT_QUOTE_CSRF_HEADER]: 'synthetic-csrf-existing' };
  const post = (extra = {}) => app.inject({ method: 'POST', url: `${EVENT_QUOTE_API}/${EVENT}/commands`, headers: { ...headers, ...extra }, payload: t.input() });
  try {
    actor = { ...testActor, canApprove: false }; assert.equal((await post()).statusCode, 403);
    actor = { ...testActor }; assert.equal((await post({ [EVENT_QUOTE_CSRF_HEADER]: 'wrong' })).statusCode, 403);
    assert.equal((await post({ origin: 'https://other.test' })).statusCode, 403);
    assert.equal((await post()).statusCode, 200); assert.equal((await post()).json().record.paymentPreparations.length, 1);
  } finally { await app.close(); }
});

test('Dashboard bound client cannot prepare with only write permission', async () => {
  const t = await setup(); let called = false;
  const grant: DashboardQuoteGrant = { state: 'ready', identityKey: 'synthetic', durableIdentity: false, scope: testScope, eventIds: [EVENT], expiresAtMs: testActor.expiresAtMs,
    permissions: { canRead: true, canWrite: true, canApprove: false }, catalog: { ready: true, digest: digest(testCatalog), authority: 'test_only', validUntilMs: testCatalog.validUntilMs } };
  const client = bindDashboardQuoteClient({ status: async () => t.status, read: async () => t.view, execute: async () => { called = true; return t.view; } }, grant, new DashboardQuoteAccessGate().start(), () => TEST_AT);
  await assert.rejects(() => client.execute(EVENT, t.input(), 'synthetic', new AbortController().signal)); assert.equal(called, false);
});

test('pending UI contains no payment URL or pay link and keeps legacy compatibility and unknown funds explicit', async () => {
  const t = await setup(), view = await t.execute(t.input());
  const html = renderToStaticMarkup(<PersistedPaymentPreparation view={view} status={t.status} />);
  assert.match(html, /Pendiente de revisión del proveedor · sin enlace/); assert.match(html, /Cobrado: desconocido/);
  assert.match(html, /No se sustituye el anticipo cotizado/); assert.match(html, /Faltan calendario de pago/); assert.match(html, /disabled/);
  assert.doesNotMatch(html, /<a\b|href=|https:\/\/|PENDING_RESERVATION|Pago confirmado/);
});
