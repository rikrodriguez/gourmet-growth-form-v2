import assert from 'node:assert/strict';
import test from 'node:test';
import { createEventQuoteApi, EVENT_QUOTE_API, EVENT_QUOTE_CSRF_HEADER } from '../../src/office/backend/event-quote-http';
import { assertEventQuoteRecord, digest } from '../../src/office/backend/event-quote-workflow';
import { exactPaymentPreparation, validateQuoteView, type EventQuoteStatusResponse } from '../../src/office/event-quote-client';
import { TEST_AT, testActor, testBrief, testCatalog, testScope, testService } from './event-quote-fixtures';

// These percentage quotes never enter the legacy structural adapter. That
// contract's independent fixed-reservation fixtures belong to its own suite.
const scenarios = [
  { id: 'different-deposit', totalCents: 10000, depositBps: 3000, depositCents: 3000 },
  { id: 'equal-deposit', totalCents: 9800, depositBps: 5000, depositCents: 4900 },
];

async function approved(scenario: typeof scenarios[number]) {
  const t = testService(), eventId = `payments-boundary-${scenario.id}`;
  const terms = `Condiciones sintéticas: anticipo del ${scenario.depositBps / 100} % del total.\nFecha propuesta sin confirmar; sin acuerdo de pago.`;
  const catalog = { ...testCatalog, taxBps: 0, depositBps: scenario.depositBps, terms,
    items: [{ ...testCatalog.items[0], unitPriceCents: scenario.totalCents }] };
  t.catalog(catalog);
  const execute = (command: unknown) => t.service.execute(testScope, testActor, eventId, command);
  let view = await execute({ action: 'create', key: 'create', expectedRevision: 0, brief: testBrief });
  view = await execute({ action: 'quote', key: 'quote', expectedRevision: 1,
    expectedBriefDigest: view.record.briefs[0].digest, expectedCatalogDigest: digest(catalog),
    selections: [{ itemId: catalog.items[0].id, quantity: 1 }] });
  const quote = view.record.quotes[0];
  view = await execute({ action: 'approve', key: 'approve', expectedRevision: 2,
    quoteVersion: quote.version, quoteDigest: quote.digest, artifactSha256: quote.artifact.sha256,
    intendedRecipient: testBrief.recipient });
  const status: EventQuoteStatusResponse = { ...await t.service.status(testScope, testActor), externalEffectsEnabled: false,
    session: { mode: testScope.mode, canWrite: true, canApprove: true, csrfToken: 'synthetic_boundary_csrf', expiresAtMs: testActor.expiresAtMs } };
  return { ...t, eventId, view, execute, terms, command: exactPaymentPreparation(view, status, 'prepare', TEST_AT) };
}

for (const scenario of scenarios) {
  test(`percentage quote ${scenario.totalCents}/${scenario.depositCents} preserves conditions and free-text dates through preparation, retry and read`, async () => {
    const t = await approved(scenario), before = structuredClone(t.view.record);
    const prepared = await t.execute(t.command), preparation = prepared.record.paymentPreparations![0];
    assert.equal(prepared.record.schemaVersion, 2); assert.equal(prepared.record.revision, 4);
    assert.equal(preparation.totalCents, scenario.totalCents); assert.equal(preparation.depositCents, scenario.depositCents);
    assert.equal(preparation.remainingCents, scenario.totalCents - scenario.depositCents);
    assert.equal(prepared.record.quotes[0].catalog.depositBps, scenario.depositBps);
    assert.equal(preparation.terms, t.terms);
    assert.deepEqual(prepared.record.briefs, before.briefs); assert.deepEqual(prepared.record.quotes, before.quotes);
    assert.deepEqual(prepared.record.decisions, before.decisions);
    assert.equal(prepared.record.briefs[0].proposedDate, testBrief.proposedDate);
    assert.equal(prepared.record.quotes[0].catalog.validUntilMs, testCatalog.validUntilMs);
    assert.equal(preparation.status, 'pending_provider_review'); assert.equal(preparation.financialMeaning, 'unaccepted_quote');
    assert.equal(preparation.providerEnabled, false); assert.equal(preparation.publicPaymentUrl, null);
    assert.equal(prepared.externalEffectsEnabled, false);
    assert.deepEqual(preparation.blockers, ['PROVIDER_DISABLED', 'LEGACY_TERMS_UNVERIFIED', 'CANONICAL_LEAD_REQUIRED', 'PAYMENT_SCHEDULE_REQUIRED']);
    for (const field of ['request', 'payload', 'agreement', 'consent', 'confirmed_intent', 'lead_id', 'quote_id',
      'balance_due_date', 'timezone', 'link_expiration', 'event_at']) {
      assert.equal(Object.hasOwn(preparation, field), false, `${field} cannot be inferred from a percentage quote or its brief`);
    }
    assertEventQuoteRecord(prepared.record, testScope, t.eventId); assert.equal(validateQuoteView(prepared, t.eventId), prepared);
    assert.deepEqual(await t.execute(t.command), prepared);
    assert.deepEqual(await t.service.read(testScope, testActor, t.eventId), prepared);
    assert.deepEqual(await t.store.read(testScope, t.eventId), prepared.record);
  });

  test(`existing command API rejects legacy agreement creation and injected calendar or consent for ${scenario.totalCents}/${scenario.depositCents}`, async () => {
    const t = await approved(scenario), before = structuredClone(t.view);
    const origin = 'https://payments-boundary.example.test', csrfToken = 'synthetic_boundary_csrf';
    const app = createEventQuoteApi({ service: t.service, allowedOrigin: origin, clock: () => TEST_AT,
      resolveIdentity: () => ({ scope: testScope, actor: testActor, csrfToken, expiresAtMs: testActor.expiresAtMs }) });
    // An independent wire-shaped fixture, never derived from either percentage
    // quote and never passed to an adapter, receiver or provider.
    const legacyRequest = {
      lead_id: 'legacy-fixture-lead', quote_id: 'legacy-fixture-quote', quote_version: 'v1', monday_item_id: null,
      recipient: { name: 'Synthetic contract recipient', email: 'legacy-fixture@example.test', phone: null },
      event: { service_name: 'Synthetic contract service', event_at: '2027-12-15T13:00', location: null },
      total_cents: 125000, balance_due_date: '2027-12-01T13:00', timezone: 'America/New_York', link_expiration: '7d',
    };
    const attempts: Array<{ name: string; payload: unknown }> = [
      { name: 'raw legacy request', payload: legacyRequest },
      { name: 'unsupported agreement action', payload: { action: 'create_payment_agreement', key: 'create-agreement',
        expectedRevision: before.record.revision, request: legacyRequest } },
    ];
    const extraFields = { request: legacyRequest, balance_due_date: legacyRequest.balance_due_date,
      timezone: legacyRequest.timezone, link_expiration: legacyRequest.link_expiration,
      confirmed_intent: true, has_active_payment_agreement: false };
    for (const [field, value] of Object.entries(extraFields)) {
      attempts.push({ name: `injected ${field}`, payload: { ...t.command, key: `inject-${field}`, [field]: value } });
    }
    const headers = { host: new URL(origin).host, origin, [EVENT_QUOTE_CSRF_HEADER]: csrfToken };
    try {
      for (const attempt of attempts) {
        const response = await app.inject({ method: 'POST', url: `${EVENT_QUOTE_API}/${t.eventId}/commands`, headers, payload: attempt.payload });
        assert.equal(response.statusCode, 400, attempt.name); assert.deepEqual(response.json(), { error: 'INVALID_REQUEST' }, attempt.name);
        assert.deepEqual(await t.service.read(testScope, testActor, t.eventId), before, attempt.name);
        assert.deepEqual(await t.store.read(testScope, t.eventId), before.record, attempt.name);
      }
      const accepted = await app.inject({ method: 'POST', url: `${EVENT_QUOTE_API}/${t.eventId}/commands`, headers, payload: t.command });
      assert.equal(accepted.statusCode, 200, accepted.body);
      const prepared = validateQuoteView(accepted.json(), t.eventId), preparation = prepared.record.paymentPreparations![0];
      assert.equal(prepared.record.revision, 4); assert.equal(prepared.record.schemaVersion, 2);
      assert.equal(preparation.status, 'pending_provider_review'); assert.equal(preparation.providerEnabled, false);
      assert.equal(preparation.publicPaymentUrl, null); assert.equal(preparation.depositCents, scenario.depositCents);
      assert.equal(preparation.terms, t.terms); assert.deepEqual(prepared.record.briefs, before.record.briefs);
      assert.deepEqual(prepared.record.quotes, before.record.quotes); assert.deepEqual(prepared.record.decisions, before.record.decisions);
    } finally { await app.close(); }
  });
}
