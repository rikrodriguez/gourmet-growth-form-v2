import React from 'react';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { createHash } from 'node:crypto';
import type { EventQuoteView, PaymentConfigurationV2, PaymentContractModeV2, PaymentDraftRegistrationV2, QuoteCommand } from '../../src/office/backend/event-quote-contracts';
import { digest } from '../../src/office/backend/event-quote-workflow';
import { reviewGourmetPaymentsAgreementV2 } from '../../src/office/backend/gourmet-payments-agreement-v2';
import { prepareGourmetPaymentsV2Wire, decodeGourmetPaymentsV2Receipt } from '../../src/office/backend/gourmet-payments-v2-wire';
import { validateQuoteView, exactQuoteReviewKey, exactPaymentContractV2Preparation, type EventQuoteStatusResponse } from '../../src/office/event-quote-client';
import { PersistedPaymentPreparation } from '../../src/office/dashboard/PersistedQuoteWorkspace';
import { bindDashboardQuoteClient, DashboardQuoteAccessGate, type DashboardQuoteGrant } from '../../src/office/dashboard/quote-access';
import { TEST_AT, testActor, testBrief, testCatalog, testScope, testService } from './event-quote-fixtures';

const EVENT = 'schema4-payment-ui';
async function snapshot(mode: PaymentContractModeV2 = 'retainer_50', registered = true) {
  const t = testService(), execute = (command: unknown) => t.service.execute(testScope, testActor, EVENT, command);
  let view = await execute({ action: 'create', key: 'create', expectedRevision: 0, brief: testBrief });
  view = await execute({ action: 'quote', key: 'quote', expectedRevision: 1, expectedBriefDigest: view.record.briefs[0].digest,
    expectedCatalogDigest: digest(testCatalog), selections: [{ itemId: 'TEST-ITEM', quantity: 100 }] });
  const q = view.record.quotes[0];
  view = await execute({ action: 'approve', key: 'approve', expectedRevision: 2, quoteVersion: q.version, quoteDigest: q.digest,
    artifactSha256: q.artifact.sha256, intendedRecipient: testBrief.recipient });
  const status: EventQuoteStatusResponse = { ...await t.service.status(testScope, testActor), externalEffectsEnabled: false,
    session: { mode: testScope.mode, canWrite: true, canApprove: true, csrfToken: 'synthetic-csrf-existing', expiresAtMs: testActor.expiresAtMs } };
  view = await execute(exactPaymentContractV2Preparation(view, status, 'prepare', mode, TEST_AT));
  const before = structuredClone(view.record.paymentContractPreparationsV2![0]), p = view.record.paymentContractPreparationsV2![0];
  const configuration: PaymentConfigurationV2['configuration'] = { contractVersion: 2, preparationId: p.id, paymentMode: mode,
    canonicalLeadId: 'lead-synthetic-schema4', paymentTerms: 'Condiciones sintéticas del plan, sin autorización comercial.', termsChangeReason: 'Revisión interna sintética explícita.',
    paymentSchedule: mode === 'full_upfront' ? null : mode === 'retainer_50'
      ? { kind: 'retainer_50', eventDate: '2027-12-15', eventTime: '19:00', timezone: 'America/New_York', balanceDate: '2027-12-08', balanceTime: '13:00', timingExceptionReason: null }
      : { kind: 'fixed_49_reservation', balanceDate: '2027-12-08', balanceTime: '13:00', timezone: 'America/New_York', agreedBalanceCents: p.paymentBalanceCents },
    linkExpiration: { kind: 'at', date: '2027-11-01', time: '12:00', timezone: 'UTC' } };
  const input = { scope: testScope, eventId: EVENT, record: view.record, preparationId: p.id, currentCatalogDigest: digest(testCatalog), configuration, nowMs: TEST_AT };
  const review = reviewGourmetPaymentsAgreementV2(input); assert.equal(review.status, 'review_required');
  if (review.status !== 'review_required') throw new Error('Synthetic review failed');
  const wire = prepareGourmetPaymentsV2Wire(input, { actor: testActor, expectedReviewDigest: review.reviewDigest });
  assert.equal(wire.status, 'prepared_wire_internal'); if (wire.status !== 'prepared_wire_internal') throw new Error('Synthetic wire failed');
  const configurationContent = { id: 'configure', preparationId: p.id, preparationDigest: p.digest, configuration,
    leadSource: 'synthetic_fixture' as const, reviewDigest: review.reviewDigest, actorId: testActor.actorId, atMs: TEST_AT, status: 'draft_configuration' as const };
  const config: PaymentConfigurationV2 = { ...configurationContent, digest: digest(configurationContent) };
  view = structuredClone(view); view.record.schemaVersion = 4;
  view.record.paymentConfigurationsV2 = [config]; view.record.paymentDraftRegistrationsV2 = [];
  function appendAudit(action: 'configure_payment_v2' | 'register_payment_draft_v2', key: string) {
    const content = { sequence: view.record.audit.length + 1, action, actorId: testActor.actorId, atMs: TEST_AT, commandKey: key,
      inputDigest: digest({ synthetic: key }), previousDigest: view.record.audit.at(-1)!.digest };
    view.record.audit.push({ ...content, digest: digest(content) }); view.record.revision++;
    view.record.receipts.push({ key, inputDigest: content.inputDigest, actorId: testActor.actorId, resultingRevision: view.record.revision });
  }
  appendAudit('configure_payment_v2', config.id);
  if (registered) {
    const receipt = decodeGourmetPaymentsV2Receipt(JSON.stringify({ status: 'contract_validated_internal', prepared: wire.prepared,
      executable: false, providerEnabled: false, publicPaymentUrl: null, authorizationVerified: false }), wire);
    assert.equal(receipt.status, 'contract_validated_internal'); if (receipt.status !== 'contract_validated_internal') throw new Error('Synthetic receipt failed');
    const content = { id: 'register', configurationId: config.id, configurationDigest: config.digest, preparationId: p.id, preparationDigest: p.digest,
      reviewDigest: review.reviewDigest, receipt, bodySha256: createHash('sha256').update(wire.body).digest('hex'), receiptDigest: digest(receipt),
      actorId: testActor.actorId, atMs: TEST_AT, status: 'draft_internal' as const, executable: false as const, providerEnabled: false as const,
      publicPaymentUrl: null, authorizationVerified: false as const };
    const registration: PaymentDraftRegistrationV2 = { ...content, digest: digest(content) };
    view.record.paymentDraftRegistrationsV2.push(registration); appendAudit('register_payment_draft_v2', registration.id);
  }
  return { view, status, originalPreparation: before };
}

for (const mode of ['retainer_50', 'full_upfront', 'fixed_49_reservation'] as const) test(`browser accepts exact read-only schema4 ${mode} snapshots`, async () => {
  for (const registered of [false, true]) {
    const t = await snapshot(mode, registered);
    assert.equal(validateQuoteView(t.view, EVENT), t.view);
    assert.deepEqual(t.view.record.paymentContractPreparationsV2![0], t.originalPreparation);
  }
});

const mutate = async (change: (value: any) => void) => {
  const { view } = await snapshot(); const forged = structuredClone(view); change(forged);
  assert.throws(() => validateQuoteView(forged, EVENT));
};
test('schema4 decoder rejects missing ledgers, duplicate configurations and invalid source state', async () => {
  for (const field of ['paymentPreparations', 'paymentContractPreparationsV2', 'paymentConfigurationsV2', 'paymentDraftRegistrationsV2']) {
    await mutate(v => { delete v.record[field]; }); await mutate(v => { v.record[field] = null; });
  }
  await mutate(v => { v.record.paymentConfigurationsV2 = []; });
  await mutate(v => { v.record.paymentConfigurationsV2.push(structuredClone(v.record.paymentConfigurationsV2[0])); });
  await mutate(v => { v.record.paymentDraftRegistrationsV2.push(structuredClone(v.record.paymentDraftRegistrationsV2[0])); });
  await mutate(v => { v.record.scope.mode = 'commercial'; });
  await mutate(v => { v.record.extra = true; });
  for (const schemaVersion of [1, 2, 3]) await mutate(v => { v.record.schemaVersion = schemaVersion; });
});

test('schema4 decoder rejects configuration substitutions, identity injection and malformed calendar facts', async () => {
  const patches = [
    { preparationId: 'missing' }, { preparationDigest: 'f'.repeat(64) }, { leadSource: 'crm' }, { status: 'approved' },
    { reviewDigest: 'bad' }, { digest: 'bad' }, { actorId: '' }, { atMs: TEST_AT - 1 },
  ];
  for (const patch of patches) await mutate(v => { Object.assign(v.record.paymentConfigurationsV2[0], patch); });
  for (const patch of [{ contractVersion: 1 }, { preparationId: 'missing' }, { paymentMode: 'full_upfront' },
    { canonicalLeadId: '\u0000lead' }, { paymentTerms: '' }, { termsChangeReason: '' }, { publicPaymentUrl: 'https://example.invalid/pay' },
    { linkExpiration: { kind: 'at', date: '2027-02-30', time: '12:00', timezone: 'UTC' } },
    { linkExpiration: { kind: 'at', date: '2027-11-07', time: '01:30', timezone: 'America/New_York' } },
    { linkExpiration: { kind: 'never', implicit: true } }]) {
    await mutate(v => { Object.assign(v.record.paymentConfigurationsV2[0].configuration, patch); });
  }
  for (const patch of [{ eventDate: '2027-02-30' }, { balanceDate: '2027-12-16' }, { timezone: 'EST' },
    { balanceDate: '2027-12-07' }, { balanceTime: '25:00' }, { timingExceptionReason: '' }, { invented: true }]) {
    await mutate(v => { Object.assign(v.record.paymentConfigurationsV2[0].configuration.paymentSchedule, patch); });
  }
});

test('schema4 decoder rejects registration pins, financial mutations and executable receipt claims', async () => {
  for (const patch of [{ configurationId: 'missing' }, { configurationDigest: 'f'.repeat(64) }, { preparationId: 'missing' },
    { preparationDigest: 'f'.repeat(64) }, { reviewDigest: 'f'.repeat(64) }, { bodySha256: 'bad' }, { receiptDigest: 'bad' },
    { atMs: TEST_AT - 1 }, { actorId: 'another-actor' }, { status: 'paid' }, { executable: true }, { providerEnabled: true },
    { publicPaymentUrl: 'https://example.invalid/pay' }, { authorizationVerified: true }, { forged: true }]) {
    await mutate(v => { Object.assign(v.record.paymentDraftRegistrationsV2[0], patch); });
  }
  for (const patch of [{ status: 'ready' }, { executable: true }, { providerEnabled: true }, { publicPaymentUrl: 'https://example.invalid/pay' },
    { authorizationVerified: true }, { forged: true }]) await mutate(v => { Object.assign(v.record.paymentDraftRegistrationsV2[0].receipt, patch); });
  for (const patch of [{ status: 'ready' }, { contractVersion: 1 }, { reviewDigest: 'f'.repeat(64) }, { executable: true },
    { providerEnabled: true }, { publicPaymentUrl: 'https://example.invalid/pay' }, { blockers: [] }, { forged: true }]) {
    await mutate(v => { Object.assign(v.record.paymentDraftRegistrationsV2[0].receipt.prepared, patch); });
  }
  for (const patch of [{ eventId: 'other-event' }, { preparationDigest: 'f'.repeat(64) }, { canonicalLeadId: 'other-lead' },
    { paymentMode: 'full_upfront' }, { initialPaymentCents: 1 }, { paymentBalanceCents: 0 }, { paymentTerms: 'changed' },
    { termsChangeReason: 'changed' }, { linkExpiration: { configured: { kind: 'never' }, instant: null } }, { forged: true }]) {
    await mutate(v => { Object.assign(v.record.paymentDraftRegistrationsV2[0].receipt.prepared.plan, patch); });
  }
  await mutate(v => { v.record.paymentDraftRegistrationsV2[0].receipt.prepared.plan.scope.workspaceId = 'other-workspace'; });
  await mutate(v => { v.record.paymentDraftRegistrationsV2[0].receipt.prepared.plan.sourceQuote.totalCents++; });
  await mutate(v => { v.record.paymentDraftRegistrationsV2[0].receipt.prepared.plan.paymentSchedule.balanceInstant = '2027-12-08T13:00:00Z'; });
  await mutate(v => { v.record.paymentDraftRegistrationsV2[0].receipt.prepared.internalApproval.purpose = 'customer_consent'; });
});

test('new draft commands require dashboard approval rights and reject caller supplied identity before transport', async () => {
  const t = await snapshot();
  const p = t.view.record.paymentContractPreparationsV2![0], config = t.view.record.paymentConfigurationsV2![0];
  const commands: QuoteCommand[] = [
    { action: 'configure_payment_v2', key: 'new-config', expectedRevision: 4, preparationId: p.id, preparationDigest: p.digest,
      paymentTerms: config.configuration.paymentTerms, termsChangeReason: config.configuration.termsChangeReason,
      paymentSchedule: config.configuration.paymentSchedule, linkExpiration: config.configuration.linkExpiration },
    { action: 'register_payment_draft_v2', key: 'new-register', expectedRevision: 5, configurationId: config.id,
      configurationDigest: config.digest, expectedReviewDigest: config.reviewDigest },
  ];
  for (const command of commands) {
    let called = 0;
    const grant: DashboardQuoteGrant = { state: 'ready', identityKey: 'synthetic', durableIdentity: false, scope: testScope,
      eventIds: [EVENT], expiresAtMs: testActor.expiresAtMs, permissions: { canRead: true, canWrite: true, canApprove: false },
      catalog: { ready: true, digest: digest(testCatalog), authority: 'test_only', validUntilMs: testCatalog.validUntilMs } };
    const source = { status: async () => t.status, read: async () => t.view, execute: async () => { called++; return t.view; } };
    let bound = bindDashboardQuoteClient(source, grant, new DashboardQuoteAccessGate().start(), () => TEST_AT);
    await assert.rejects(() => bound.execute(EVENT, command, 'synthetic', new AbortController().signal)); assert.equal(called, 0);
    bound = bindDashboardQuoteClient(source, { ...grant, permissions: { ...grant.permissions, canApprove: true } }, new DashboardQuoteAccessGate().start(), () => TEST_AT);
    for (const forged of [{ actorId: 'invented' }, { canonicalLeadId: 'invented' }, { scope: testScope }, { approval: { actor: testActor } }]) {
      await assert.rejects(() => bound.execute(EVENT, { ...command, ...forged } as QuoteCommand, 'synthetic', new AbortController().signal)); assert.equal(called, 0);
    }
  }
});

test('the existing card shows synthetic configuration and validation status with no extra form or payment action', async context => {
  context.mock.method(Date, 'now', () => TEST_AT);
  for (const registered of [false, true]) {
    const t = await snapshot('full_upfront', registered);
    const html = renderToStaticMarkup(<PersistedPaymentPreparation view={t.view} status={t.status} />);
    assert.equal((html.match(/Preparación de enlace de pago/g) ?? []).length, 1);
    assert.match(html, /Configuración sintética guardada/);
    if (registered) assert.match(html, /Validación contractual sintética registrada/);
    assert.match(html, /sin autorización comercial/);
    assert.doesNotMatch(html, /<a\b|href=|<form\b|<iframe\b|https:\/\/|Pago confirmado|Acuerdo creado/);
    assert.deepEqual(t.view.record.paymentContractPreparationsV2![0], t.originalPreparation);
  }
});

test('configuration and draft badges become stale when their quote, brief or catalogue pins cease to be current', async context => {
  context.mock.method(Date, 'now', () => TEST_AT);
  const t = await snapshot();
  for (const stale of [
    { ...t.view, currentQuoteStatus: 'obsolete' as const },
    { ...t.view, record: { ...t.view.record, briefs: [...t.view.record.briefs, { ...t.view.record.briefs[0], version: 2, digest: 'f'.repeat(64) }] } },
  ]) {
    const html = renderToStaticMarkup(<PersistedPaymentPreparation view={stale} status={t.status} />);
    assert.match(html, /Configuración sintética obsoleta/); assert.match(html, /Validación contractual sintética obsoleta/);
  }
  const html = renderToStaticMarkup(<PersistedPaymentPreparation view={t.view} status={{ ...t.status, catalogDigest: 'f'.repeat(64) }} />);
  assert.match(html, /Configuración sintética obsoleta/); assert.match(html, /Validación contractual sintética obsoleta/);
});

async function unconfigured(mode: PaymentContractModeV2) {
  const t = await snapshot(mode, false), facts = t.view.record.paymentConfigurationsV2![0].configuration;
  const view = structuredClone(t.view); view.record.schemaVersion = 3; delete view.record.paymentConfigurationsV2; delete view.record.paymentDraftRegistrationsV2;
  view.record.audit = view.record.audit.slice(0, 4); view.record.receipts = view.record.receipts.slice(0, 4); view.record.revision = 4;
  return { ...t, view, facts, status: { ...t.status, paymentDraftsEnabled: true as const } };
}

test('conditions form is explicit, empty and available only with the trusted test capability', async context => {
  context.mock.method(Date, 'now', () => TEST_AT);
  for (const mode of ['retainer_50', 'full_upfront', 'fixed_49_reservation'] as const) {
    const t = await unconfigured(mode), props = { view: t.view, status: t.status, writable: true, dirty: false, verified: exactQuoteReviewKey(t.view) };
    const html = renderToStaticMarkup(<PersistedPaymentPreparation {...props} />);
    assert.match(html, /payment-v2-conditions-form/); assert.match(html, /Guardar condiciones de prueba/);
    assert.match(html, /Una vez guardadas, estas condiciones no se editan/);
    assert.match(html, /<option value="" selected="">Selecciona una expiración explícita/);
    assert.match(html, /data-testid="payment-v2-terms"[^>]*><\/textarea>/);
    assert.doesNotMatch(html, /data-testid="persisted-payment-prepare"/);
    assert.doesNotMatch(html, /data-testid="payment-v2-register"|data-testid="payment-v2-date-proposal"/);
    if (mode === 'full_upfront') assert.doesNotMatch(html, /payment-v2-event-date|payment-v2-balance-date|payment-v2-calendar-timezone|payment-v2-agreed-balance/);
    else {
      assert.match(html, /data-testid="payment-v2-balance-date"[^>]*value=""/);
      assert.match(html, /data-testid="payment-v2-balance-time"[^>]*value=""/);
      assert.match(html, /data-testid="payment-v2-calendar-timezone"[^>]*value=""/);
      if (mode === 'fixed_49_reservation') assert.match(html, /data-testid="payment-v2-agreed-balance"[^>]*value=""/);
      else assert.match(html, /data-testid="payment-v2-event-time"[^>]*value=""/);
    }
    for (const status of [{ ...t.status, paymentDraftsEnabled: undefined }, { ...t.status, session: { ...t.status.session, mode: 'commercial' as const } }]) {
      assert.doesNotMatch(renderToStaticMarkup(<PersistedPaymentPreparation {...props} status={status} />), /payment-v2-conditions-form/);
    }
  }
});

test('configured facts have a separate visible review and unchecked confirmation before registration', async context => {
  context.mock.method(Date, 'now', () => TEST_AT);
  const t = await snapshot('retainer_50', false), status = { ...t.status, paymentDraftsEnabled: true as const };
  const html = renderToStaticMarkup(<PersistedPaymentPreparation view={t.view} status={status} writable dirty={false} verified={exactQuoteReviewKey(t.view)} />);
  assert.match(html, /Condiciones de prueba guardadas · pendientes de revisión/);
  assert.match(html, /data-testid="persisted-payment-v2-review"/); assert.match(html, /Condiciones originales/);
  assert.match(html, /Condiciones configuradas/); assert.match(html, /Una vez guardadas, estas condiciones no se editan/); assert.match(html, /2027-12-08 13:00/); assert.match(html, /2027-12-15 19:00/);
  assert.match(html, new RegExp(t.view.record.paymentConfigurationsV2![0].reviewDigest));
  assert.match(html, /data-testid="payment-v2-confirm-review"[^>]*type="checkbox"/);
  assert.match(html, /data-testid="payment-v2-register" disabled=""/);
  assert.doesNotMatch(html, /payment-v2-conditions-form|Pendiente de configuración y aprobación|Falta vincular el lead|<a\b|href=/);
});

test('registration replaces the pending review action with a non executable draft status', async context => {
  context.mock.method(Date, 'now', () => TEST_AT);
  const t = await snapshot('full_upfront'), status = { ...t.status, paymentDraftsEnabled: true as const };
  const html = renderToStaticMarkup(<PersistedPaymentPreparation view={t.view} status={status} writable dirty={false} verified={exactQuoteReviewKey(t.view)} />);
  assert.match(html, /Acuerdo borrador de prueba registrado · sin enlace/); assert.match(html, /Ejecución: desactivada/);
  assert.match(html, /Autorización comercial: sin verificar/);
  assert.doesNotMatch(html, /payment-v2-conditions-form|payment-v2-register|payment-v2-confirm-review|Pendiente de configuración y aprobación|falta resolver y aprobar/);
});

test('visible conditions and draft command helpers preserve exact pins and reject inferred or stale facts', async () => {
  const api = await import('../../src/office/event-quote-client');
  const t = await unconfigured('retainer_50'), preparation = t.view.record.paymentContractPreparationsV2![0];
  const { paymentTerms, termsChangeReason, paymentSchedule, linkExpiration } = t.facts;
  const facts = { paymentTerms, termsChangeReason, paymentSchedule, linkExpiration };
  const configure = api.exactPaymentConfigurationV2Command(t.view, t.status, 'visible-config', preparation.id, facts, TEST_AT);
  assert.deepEqual(configure, { action: 'configure_payment_v2', key: 'visible-config', expectedRevision: 4,
    preparationId: preparation.id, preparationDigest: preparation.digest, ...facts });
  for (const patch of [{ paymentTerms: '' }, { linkExpiration: null }, { paymentSchedule: null }, { canonicalLeadId: 'invented' }]) {
    assert.throws(() => api.exactPaymentConfigurationV2Command(t.view, t.status, 'invalid', preparation.id, { ...facts, ...patch } as never, TEST_AT));
  }
  for (const changed of [{ ...t.status, paymentDraftsEnabled: undefined }, { ...t.status, session: { ...t.status.session, canApprove: false } }]) {
    assert.throws(() => api.exactPaymentConfigurationV2Command(t.view, changed, 'invalid', preparation.id, facts, TEST_AT));
  }
  const configured = await snapshot('retainer_50', false), config = configured.view.record.paymentConfigurationsV2![0];
  const register = api.exactPaymentDraftRegistrationV2Command(configured.view, { ...configured.status, paymentDraftsEnabled: true }, 'visible-register', config.id, TEST_AT);
  assert.deepEqual(register, { action: 'register_payment_draft_v2', key: 'visible-register', expectedRevision: 5,
    configurationId: config.id, configurationDigest: config.digest, expectedReviewDigest: config.reviewDigest });
  assert.throws(() => api.exactPaymentDraftRegistrationV2Command({ ...configured.view, currentQuoteStatus: 'obsolete' }, { ...configured.status, paymentDraftsEnabled: true }, 'invalid', config.id, TEST_AT));
});


test('registered and historical drafts retain exact configured facts without approval controls', async context => {
  context.mock.method(Date, 'now', () => TEST_AT);
  const t = await snapshot('retainer_50');
  for (const view of [t.view, { ...t.view, currentQuoteStatus: 'obsolete' as const }]) {
    const html = renderToStaticMarkup(<PersistedPaymentPreparation view={view} status={t.status} />);
    assert.match(html, /Condiciones del acuerdo borrador/);
    for (const fact of ['2027-12-08 13:00', '2027-12-15 19:00', 'America\/New_York', '2027-11-01 12:00', 'Revisión interna sintética explícita']) assert.ok(html.includes(fact));
    assert.match(html, /Condiciones configuradas/); assert.match(html, /Condiciones originales/);
    assert.doesNotMatch(html, /payment-v2-register|payment-v2-confirm-review|payment-v2-conditions-form/);
  }
});

test('operational capability is explicit and strictly typed instead of accepting a false or injected mode', async () => {
  const api = await import('../../src/office/event-quote-client'), t = await snapshot('full_upfront', false);
  assert.equal(api.validateQuoteStatus({ ...t.status, paymentAgreementsEnabled: true }).paymentAgreementsEnabled, true);
  for (const value of [false, 'true', null, 1]) assert.throws(() => api.validateQuoteStatus({ ...t.status, paymentAgreementsEnabled: value }));
});

test('operational browser transport posts only configuration pins to the agreement endpoint', async context => {
  const api = await import('../../src/office/event-quote-client'), t = await snapshot('full_upfront', false);
  const config = t.view.record.paymentConfigurationsV2![0], command = { key: 'operation-create', configurationId: config.id,
    configurationDigest: config.digest, expectedReviewDigest: config.reviewDigest, operation: 'create' };
  const operation = (api.eventQuoteClient as unknown as Record<string, unknown>).executePaymentAgreement;
  assert.equal(typeof operation, 'function'); let received: { url: string; init: RequestInit } | null = null;
  context.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    received = { url, init }; return new Response(JSON.stringify(t.view), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  await (operation as (...args: unknown[]) => Promise<EventQuoteView>)(EVENT, command, 'csrf-explicit', new AbortController().signal);
  assert.equal(received!.url, `/api/office/event-quotes/${EVENT}/payment-agreements/v2`);
  assert.equal(received!.init.method, 'POST'); assert.deepEqual(JSON.parse(received!.init.body as string), command);
  assert.equal((received!.init.headers as Record<string, string>)['x-event-quote-csrf'], 'csrf-explicit');
});


async function operationalSnapshot(state: 'pending' | 'reconciliation_required' | 'draft_persisted' | 'rejected' = 'draft_persisted') {
  const t = await snapshot('full_upfront', false), config = t.view.record.paymentConfigurationsV2![0];
  const operation = { operationId: 'a'.repeat(64), operationDigest: 'b'.repeat(64), configurationId: config.id, configurationDigest: config.digest,
    status: state, agreementId: state === 'draft_persisted' ? '4ce21b13-dbc2-4dcb-bae6-842100f344b1' : null,
    executable: false as const, providerEnabled: false as const, publicPaymentUrl: null, authorizationVerified: false as const,
    serviceAuthenticated: state === 'draft_persisted', updatedAtMs: TEST_AT };
  return { ...t, operation, view: { ...t.view, paymentAgreementOperationsV2: [operation] }, status: { ...t.status, paymentAgreementsEnabled: true as const } };
}

test('browser validates disabled operational summaries and rejects forged identities, flags and configuration pins', async () => {
  for (const state of ['pending', 'reconciliation_required', 'draft_persisted', 'rejected'] as const) {
    const t = await operationalSnapshot(state); assert.equal(validateQuoteView(t.view, EVENT), t.view);
    for (const patch of [{ operationId: 'bad' }, { operationDigest: 'bad' }, { configurationId: 'other-config' }, { configurationDigest: 'f'.repeat(64) },
      { updatedAtMs: TEST_AT - 1 }, { status: 'paid' }, { executable: true }, { providerEnabled: true }, { authorizationVerified: true },
      { publicPaymentUrl: 'https://example.invalid/pay' }, { actorId: 'invented' }, { serviceAuthenticated: !t.operation.serviceAuthenticated }]) {
      const view = structuredClone(t.view); Object.assign(view.paymentAgreementOperationsV2[0], patch); assert.throws(() => validateQuoteView(view, EVENT));
    }
    const duplicate = structuredClone(t.view); duplicate.paymentAgreementOperationsV2.push(structuredClone(duplicate.paymentAgreementOperationsV2[0]));
    assert.throws(() => validateQuoteView(duplicate, EVENT));
    const malformed = structuredClone(t.view); malformed.paymentAgreementOperationsV2[0].agreementId = state === 'draft_persisted' ? 'made-up' : '4ce21b13-dbc2-4dcb-bae6-842100f344b1';
    assert.throws(() => validateQuoteView(malformed, EVENT));
  }
});

test('operational approval guard rejects identity and payment payload injections before any request', async () => {
  const t = await operationalSnapshot('pending'), config = t.view.record.paymentConfigurationsV2![0];
  let called = 0;
  const source = { status: async () => t.status, read: async () => t.view, execute: async () => t.view,
    executePaymentAgreement: async () => { called++; return t.view; } };
  const grant: DashboardQuoteGrant = { state: 'ready', identityKey: 'synthetic', durableIdentity: false, scope: testScope,
    eventIds: [EVENT], expiresAtMs: testActor.expiresAtMs, permissions: { canRead: true, canWrite: true, canApprove: false },
    catalog: { ready: true, digest: digest(testCatalog), authority: 'test_only', validUntilMs: testCatalog.validUntilMs } };
  const command = { key: 'operation-reconcile', configurationId: config.id, configurationDigest: config.digest, expectedReviewDigest: config.reviewDigest, operation: 'reconcile' as const };
  let bound = bindDashboardQuoteClient(source, grant, new DashboardQuoteAccessGate().start(), () => TEST_AT);
  await assert.rejects(() => bound.executePaymentAgreement!(EVENT, command, 'csrf', new AbortController().signal)); assert.equal(called, 0);
  bound = bindDashboardQuoteClient(source, { ...grant, permissions: { ...grant.permissions, canApprove: true } }, new DashboardQuoteAccessGate().start(), () => TEST_AT);
  for (const patch of [{ actorId: 'invented' }, { scope: testScope }, { canonicalLeadId: 'invented' }, { payload: {} }, { serviceToken: 'invented' }, { operation: 'dispatch' }]) {
    await assert.rejects(() => bound.executePaymentAgreement!(EVENT, { ...command, ...patch } as never, 'csrf', new AbortController().signal)); assert.equal(called, 0);
  }
  await bound.executePaymentAgreement!(EVENT, command, 'csrf', new AbortController().signal); assert.equal(called, 1);
});

test('operational command helper creates directly from configured facts and reconciles a historical ambiguous operation without creation', async () => {
  const api = await import('../../src/office/event-quote-client'), t = await snapshot('full_upfront', false), config = t.view.record.paymentConfigurationsV2![0];
  const status = { ...t.status, paymentAgreementsEnabled: true as const };
  const command = api.exactPaymentAgreementOperationV2Command(t.view, status, 'operation-create', config.id, 'create', TEST_AT);
  assert.deepEqual(command, { key: 'operation-create', configurationId: config.id, configurationDigest: config.digest,
    expectedReviewDigest: config.reviewDigest, operation: 'create' });
  assert.equal(t.view.record.paymentDraftRegistrationsV2!.length, 0);
  assert.throws(() => api.exactPaymentAgreementOperationV2Command(t.view, t.status, 'missing-capability', config.id, 'create', TEST_AT));
  const pending = await operationalSnapshot('reconciliation_required');
  const historical = { ...pending.view, currentQuoteStatus: 'obsolete' as const };
  const staleStatus = { ...pending.status, catalogDigest: 'f'.repeat(64) };
  assert.throws(() => api.exactPaymentAgreementOperationV2Command(historical, staleStatus, 'create-again', config.id, 'create', TEST_AT));
  assert.equal(api.exactPaymentAgreementOperationV2Command(historical, staleStatus, 'lookup-only', config.id, 'reconcile', TEST_AT).operation, 'reconcile');
  const persisted = await operationalSnapshot();
  assert.throws(() => api.exactPaymentAgreementOperationV2Command(persisted.view, persisted.status, 'again', config.id, 'reconcile', TEST_AT));
});

test('the same review confirms an actual disabled agreement directly when the server capability is present', async context => {
  context.mock.method(Date, 'now', () => TEST_AT);
  const t = await snapshot('full_upfront', false), status = { ...t.status, paymentAgreementsEnabled: true as const };
  const html = renderToStaticMarkup(<PersistedPaymentPreparation view={t.view} status={status} writable dirty={false}
    verified={exactQuoteReviewKey(t.view)} onPaymentAgreementOperation={() => {}} />);
  assert.equal((html.match(/Preparación de enlace de pago/g) ?? []).length, 1);
  assert.match(html, /data-testid="payment-v2-create-agreement" disabled=""/); assert.match(html, /Crear acuerdo deshabilitado en Payments/);
  assert.match(html, /data-testid="payment-v2-confirm-review"/);
  assert.doesNotMatch(html, /data-testid="payment-v2-register"|payment-v2-conditions-form|<a\b|href=|https:\/\//);
});

test('actual Payments agreement IDs and all facts remain visible after reload with every payment effect disabled', async context => {
  context.mock.method(Date, 'now', () => TEST_AT);
  const t = await operationalSnapshot();
  const html = renderToStaticMarkup(<PersistedPaymentPreparation view={t.view} status={t.status} />);
  assert.match(html, /DRAFT_INTERNAL/); assert.match(html, /4ce21b13-dbc2-4dcb-bae6-842100f344b1/);
  assert.match(html, /Ejecutable: no/); assert.match(html, /Proveedor: desactivado/); assert.match(html, /Autorización comercial: sin verificar/);
  assert.match(html, /2027-11-01 12:00/); assert.match(html, /Condiciones originales/); assert.match(html, /Condiciones configuradas/);
  assert.doesNotMatch(html, /payment-v2-register|payment-v2-create-agreement|payment-v2-reconcile|<a\b|href=|https:\/\//);
});

for (const state of ['pending', 'reconciliation_required'] as const) test(`${state} exposes only safe explicit reconciliation, including historical source`, async context => {
  context.mock.method(Date, 'now', () => TEST_AT);
  const t = await operationalSnapshot(state);
  const html = renderToStaticMarkup(<PersistedPaymentPreparation view={{ ...t.view, currentQuoteStatus: 'obsolete' }} status={t.status}
    writable dirty={false} onPaymentAgreementOperation={() => {}} />);
  assert.match(html, /data-testid="payment-v2-reconcile"/); assert.match(html, /La reconciliación no crea otro acuerdo/);
  assert.doesNotMatch(html, /payment-v2-create-agreement|payment-v2-register|data-testid="payment-v2-reconcile" disabled=""|payment-v2-agreement-id/);
});

test('an unconfirmed creation can be retried explicitly with current facts, while reconciliation stays lookup only', async context => {
  context.mock.method(Date, 'now', () => TEST_AT);
  const api = await import('../../src/office/event-quote-client'), t = await operationalSnapshot('reconciliation_required');
  const config = t.view.record.paymentConfigurationsV2![0];
  assert.deepEqual(api.exactPaymentAgreementOperationV2Command(t.view, t.status, 'explicit-create-retry', config.id, 'create', TEST_AT), {
    key: 'explicit-create-retry', configurationId: config.id, configurationDigest: config.digest, expectedReviewDigest: config.reviewDigest, operation: 'create',
  });
  const html = renderToStaticMarkup(<PersistedPaymentPreparation view={t.view} status={t.status} writable dirty={false}
    verified={exactQuoteReviewKey(t.view)} onPaymentAgreementOperation={() => {}} />);
  assert.match(html, /Reintentar creación del borrador/);
  assert.match(html, /data-testid="payment-v2-create-agreement" disabled=""/);
  assert.match(html, /data-testid="payment-v2-confirm-review"[^>]*type="checkbox"/);
  assert.doesNotMatch(html, /data-testid="payment-v2-confirm-review"[^>]*checked=/);
  assert.match(html, /Reconciliar acuerdo en Payments/); assert.match(html, /La reconciliación no crea otro acuerdo/);
  const stale = { ...t.view, currentQuoteStatus: 'obsolete' as const };
  assert.throws(() => api.exactPaymentAgreementOperationV2Command(stale, t.status, 'forbidden-retry', config.id, 'create', TEST_AT));
  const staleHtml = renderToStaticMarkup(<PersistedPaymentPreparation view={stale} status={t.status} writable dirty={false} onPaymentAgreementOperation={() => {}} />);
  assert.doesNotMatch(staleHtml, /Reintentar creación del borrador|payment-v2-create-agreement|payment-v2-confirm-review/);
  assert.match(staleHtml, /payment-v2-reconcile/);
  for (const status of ['pending', 'rejected', 'draft_persisted'] as const) {
    const other = await operationalSnapshot(status);
    assert.throws(() => api.exactPaymentAgreementOperationV2Command(other.view, other.status, 'not-a-retry', config.id, 'create', TEST_AT));
  }
});
