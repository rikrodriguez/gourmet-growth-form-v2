import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import type { EventQuoteView, PaymentContractModeV2 } from '../../src/office/backend/event-quote-contracts';
import { createEventQuoteService, digest } from '../../src/office/backend/event-quote-workflow';
import { createEventQuoteApi, EVENT_QUOTE_API, EVENT_QUOTE_CSRF_HEADER } from '../../src/office/backend/event-quote-http';
import { PostgresEventQuoteStore, eventQuoteStorageKey } from '../../src/office/backend/event-quote-postgres';
import { PostgresPaymentAgreementOutboxV2 } from '../../src/office/backend/payment-agreement-outbox-v2';
import { createPaymentAgreementHttpTransportV2 } from '../../src/office/backend/payment-agreement-transport-v2';
import { createGourmetCheckoutTransportV1 } from '../../src/office/backend/gourmet-checkout-transport-v1';
import { DEFAULT_OFFICE_DATABASE_URL } from '../../src/office/backend/postgres-store';
import { MondayVault } from '../../src/office/backend/monday-store';
import type { CheckoutEmissionBrowserCommandV1 } from '../../src/office/backend/gourmet-checkout-emission-v1';
import { parseCheckoutEmissionBrowserCommandV1 } from '../../src/office/backend/payment-checkout-dispatch-v1';
import type { PaymentAgreementIntegrationV2 } from '../../src/office/backend/payment-agreement-operations-v2';
import { startOperationalPaymentReceiverV2 } from '../payments-contract/php-operational-receiver';
import { testActor, testBrief, testCatalog, testScope } from './event-quote-fixtures';

// The identity/capability resolver is an explicit in-process test double. The
// quote store, encrypted handoff and original PHP receiver use actual local DBs.
// This creates no real grants, sends nothing and never calls a payment provider.
async function fixture(mode: PaymentContractModeV2 = 'retainer_50', withDashboard = false) {
  let now = Date.now(), issuanceAllowed = true, loseResponse = false, expireAfterCommit = false, expireCatalogOnIssuance = false, authorityCalls = 0;
  const actor = { ...testActor, durable: true, expiresAtMs: now + 7_200_000 };
  const schema = `quote_test_${randomUUID().replaceAll('-', '')}`, eventId = `checkout-${randomUUID()}`;
  const pool = new Pool({ connectionString: DEFAULT_OFFICE_DATABASE_URL, connectionTimeoutMillis: 1000 });
  const vault = new MondayVault(Buffer.alloc(32, 84));
  const store = new PostgresEventQuoteStore(pool, { schema, vault });
  const receiver = await startOperationalPaymentReceiverV2({ checkoutEmission: true });
  let outbox = new PostgresPaymentAgreementOutboxV2(pool, { schema, vault });
  let issuedCalls = 0, lookupCalls = 0;
  const catalog = { ...testCatalog, taxBps: 0, validUntilMs: now + 3_600_000, items: [{ ...testCatalog.items[0], unitPriceCents: 10001 }] };
  const source = { source: 'synthetic_fixture' as const, canonicalLeadId: 'synthetic-checkout-lead', serviceName: 'Servicio sintético 🥘', eventLocation: 'Ubicación aprobada' };
  const transport = createGourmetCheckoutTransportV1({ baseUrl: receiver.baseUrl, publicCheckoutOrigin: 'https://synthetic.invalid',
    allowLoopbackTest: true, resolveAuthorizationHeader: () => `Bearer ${receiver.sharedSecret}` });
  const integration: PaymentAgreementIntegrationV2 = { outbox, resolveSource: async () => source,
    transport: createPaymentAgreementHttpTransportV2({ baseUrl: receiver.baseUrl, allowLoopbackTest: true, resolveAuthorizationHeader: () => `Bearer ${receiver.sharedSecret}` }),
    checkout: { resolveIssuanceAuthority: async (scope, event, actorId) => {
      if (event !== null && ++authorityCalls === 2 && expireCatalogOnIssuance) now = catalog.validUntilMs;
      return issuanceAllowed ? { actorId, scope, durable: true,
        canIssueCheckout: true, purpose: 'issue_payment_checkout_v1', expiresAtMs: actor.expiresAtMs } : null;
    },
      transport: { ...transport, issue: async (command, signal) => {
        issuedCalls++; const result = await transport.issue(command, signal);
        if (expireAfterCommit) now = actor.expiresAtMs;
        if (loseResponse && result.status === 201) throw new Error('Synthetic response lost after original PHP commit');
        return result;
      }, reconcile: async (command, signal) => { lookupCalls++; return transport.reconcile(command, signal); } } },
  };
  const csrf = 'synthetic-checkout-dispatch-csrf-1234';
  const app = createEventQuoteApi({ allowedOrigin: 'https://office.synthetic.invalid', clock: () => now, paymentAgreements: integration,
    ...(withDashboard ? { dashboardAccess: async () => ({ state: 'ready' as const, identityKey: 'synthetic-checkout-revision',
      serverRevision: 'synthetic-checkout-revision', durableIdentity: true as const, scope: testScope, expiresAtMs: actor.expiresAtMs,
      eventIds: [eventId], permissions: { canRead: true, canWrite: true, canApprove: true },
      catalog: { ready: true as const, digest: digest(catalog), validUntilMs: catalog.validUntilMs, authority: 'test_only' as const } }) } : {}),
    runAuthorized: async (_request, _target, operation) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const service = createEventQuoteService({ store: new PostgresEventQuoteStore(pool, { schema, vault, transaction: client }),
          clock: () => now, catalogFor: async () => catalog, testPaymentDrafts: {
            resolveCanonicalLead: async () => ({ source: 'synthetic_fixture', canonicalLeadId: source.canonicalLeadId }),
            validateContract: async () => { throw new Error('Legacy simulated validator must not run'); },
          } });
        const result = await operation({ scope: testScope, actor, expiresAtMs: actor.expiresAtMs, csrfToken: csrf,
          ...(withDashboard ? { accessRevision: 'synthetic-checkout-revision' } : {}) }, service, client);
        await client.query('COMMIT'); return result;
      } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    } });
  const headers = { host: 'office.synthetic.invalid', origin: 'https://office.synthetic.invalid', 'content-type': 'application/json', [EVENT_QUOTE_CSRF_HEADER]: csrf,
    ...(withDashboard ? { 'x-event-quote-access-revision': 'synthetic-checkout-revision' } : {}) };
  const post = async (path: string, payload: unknown) => app.inject({ method: 'POST', url: `${EVENT_QUOTE_API}/${eventId}/${path}`, headers, payload });
  const command = async (payload: unknown) => { const result = await post('commands', payload); assert.equal(result.statusCode, 200, result.body); return result.json() as EventQuoteView; };
  try {
    await store.initialize(); await outbox.initialize();
    let view = await command({ action: 'create', key: 'create', expectedRevision: 0, brief: testBrief });
    view = await command({ action: 'quote', key: 'quote', expectedRevision: 1, expectedBriefDigest: view.record.briefs[0].digest,
      expectedCatalogDigest: digest(catalog), selections: [{ itemId: catalog.items[0].id, quantity: 1 }] });
    const q = view.record.quotes[0];
    view = await command({ action: 'approve', key: 'approve', expectedRevision: 2, quoteVersion: q.version, quoteDigest: q.digest,
      artifactSha256: q.artifact.sha256, intendedRecipient: testBrief.recipient });
    view = await command({ action: 'prepare_payment_v2', key: 'prepare', expectedRevision: 3, quoteVersion: q.version, quoteDigest: q.digest,
      approvalDigest: view.record.decisions[0].digest, artifactSha256: q.artifact.sha256, paymentMode: mode });
    const p = view.record.paymentContractPreparationsV2![0];
    view = await command({ action: 'configure_payment_v2', key: 'configure', expectedRevision: 4, preparationId: p.id, preparationDigest: p.digest,
      paymentTerms: 'Condiciones exactas sintéticas.\r\nCafé 🥘; / y \\;  espacios.', termsChangeReason: 'Revisión expresa sintética.',
      paymentSchedule: mode === 'full_upfront' ? null : mode === 'retainer_50'
        ? { kind: mode, eventDate: '2099-12-15', eventTime: '18:00', timezone: 'America/New_York', balanceDate: '2099-12-08', balanceTime: '12:00', timingExceptionReason: null }
        : { kind: mode, balanceDate: '2099-12-01', balanceTime: '09:30', timezone: 'Asia/Kathmandu', agreedBalanceCents: p.paymentBalanceCents },
      linkExpiration: { kind: 'never' } });
    const c = view.record.paymentConfigurationsV2![0];
    const draft = await post('payment-agreements/v2', { key: 'draft-original', configurationId: c.id, configurationDigest: c.digest,
      expectedReviewDigest: c.reviewDigest, operation: 'create' });
    assert.equal(draft.statusCode, 200, draft.body); view = draft.json();
    const parent = view.paymentAgreementOperationsV2![0]; assert.equal(parent.status, 'draft_persisted'); assert.ok(parent.checkoutConditionsDigest);
    const issue: CheckoutEmissionBrowserCommandV1 = { key: 'issue-original', configurationId: c.id, configurationDigest: c.digest,
      expectedReviewDigest: c.reviewDigest, expectedConditionsDigest: parent.checkoutConditionsDigest, operation: 'issue' };
    return { app, pool, schema, eventId, receiver, view, issue, integration,
      calls: () => ({ issuedCalls, lookupCalls }), post: (payload: unknown) => post('payment-checkouts/v1', payload),
      deny: () => { issuanceAllowed = false; }, lose: () => { loseResponse = true; }, expire: () => { expireAfterCommit = true; },
      expireCatalog: () => { expireCatalogOnIssuance = true; },
      async restore() { now = Math.max(now, Date.now());
        // A later synthetic session can recover an already stored receipt;
        // clocks never move backwards to revive the previous authority.
        if (now >= actor.expiresAtMs) actor.expiresAtMs = now + 3_600_000;
        loseResponse = false; expireAfterCommit = false; await receiver.restart();
        outbox = new PostgresPaymentAgreementOutboxV2(pool, { schema, vault }); integration.outbox = outbox; },
      async close() { await app.close(); await receiver.close(); await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await pool.end(); } };
  } catch (error) { await app.close(); await receiver.close(); await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await pool.end(); throw error; }
}

for (const mode of ['retainer_50', 'full_upfront', 'fixed_49_reservation'] as const) test(`Office HTTP + PostgreSQL -> original PHP issues exactly one related ${mode} checkout`, async () => {
  const t = await fixture(mode);
  try {
    const before = await t.receiver.inspect();
    const response = await t.post(t.issue); assert.equal(response.statusCode, 200, response.body);
    const view = response.json() as EventQuoteView, parent = view.paymentAgreementOperationsV2![0];
    assert.deepEqual(view.record, t.view.record); assert.equal(parent.status, 'draft_persisted'); assert.equal(parent.publicPaymentUrl, null);
    assert.equal(parent.checkout?.status, 'checkout_issued', JSON.stringify(parent));
    assert.notEqual(parent.checkout.checkoutId, parent.agreementId); assert.equal(parent.checkout.executable, false); assert.equal(parent.checkout.providerEnabled, false);
    const after = await t.receiver.inspect(); assert.equal(after.counts.payment_agreements, before.counts.payment_agreements + 1);
    assert.equal(after.counts.payment_checkout_issuances, 1); assert.equal(after.providerCalls, 0);
    assert.deepEqual(after.agreements.find(row => row.public_uuid === parent.agreementId), before.agreements[0]);
    const raw = JSON.stringify((await t.pool.query(`SELECT payload FROM ${t.schema}.payment_handoffs_v2 WHERE event_key=$1`, [eventQuoteStorageKey(testScope, t.eventId)])).rows);
    assert.ok(!raw.includes(parent.checkout.publicPaymentUrl!)); assert.ok(!raw.includes('Condiciones exactas'));
    const calls = t.calls(); const replay = await t.post({ ...t.issue, key: 'read-only-recover', operation: 'reconcile' });
    assert.equal(replay.statusCode, 200, replay.body); assert.deepEqual(replay.json(), view); assert.deepEqual(t.calls(), calls);
  } finally { await t.close(); }
});

test('lost original issuance response recovers the same checkout after PHP and Office repository restart', async () => {
  const t = await fixture();
  try {
    t.lose(); const first = await t.post(t.issue); assert.equal(first.statusCode, 200, first.body);
    assert.equal(first.json().paymentAgreementOperationsV2[0].checkout.status, 'reconciliation_required');
    const committed = await t.receiver.inspect(); assert.equal(committed.counts.payment_checkout_issuances, 1);
    await t.restore(); const recovered = await t.post({ ...t.issue, key: 'recover-after-restart', operation: 'reconcile' });
    assert.equal(recovered.statusCode, 200, recovered.body); const checkout = recovered.json().paymentAgreementOperationsV2[0].checkout;
    assert.equal(checkout.status, 'checkout_issued'); assert.equal(checkout.checkoutId, committed.agreements.find(row => row.contract_version === 3)!.public_uuid);
    assert.equal(t.calls().issuedCalls, 1); assert.deepEqual((await t.receiver.inspect()).allRows, committed.allRows);
  } finally { await t.close(); }
});

test('issuance endpoint requires the separate capability before transport, even for a quote approver', async () => {
  const t = await fixture();
  try {
    const before = await t.receiver.inspect(); t.deny(); const response = await t.post(t.issue);
    assert.equal(response.statusCode, 403); assert.equal(t.calls().issuedCalls, 0); assert.equal(t.calls().lookupCalls, 0);
    assert.deepEqual((await t.receiver.inspect()).allRows, before.allRows);
  } finally { await t.close(); }
});

test('authority lost after remote commit withholds private output but retains an independently recoverable encrypted receipt', async () => {
  const t = await fixture('full_upfront');
  try {
    t.expire(); const response = await t.post(t.issue); assert.equal(response.statusCode, 401, response.body);
    assert.equal((await t.receiver.inspect()).counts.payment_checkout_issuances, 1);
    await t.restore(); const recovered = await t.post({ ...t.issue, key: 'fresh-authority-recovery', operation: 'reconcile' });
    assert.equal(recovered.statusCode, 200, recovered.body); assert.equal(recovered.json().paymentAgreementOperationsV2[0].checkout.status, 'checkout_issued');
    assert.equal(t.calls().issuedCalls, 1);
  } finally { await t.close(); }
});

test('checkout browser commands reject injected identities, prices, URLs and source receipts', () => {
  const command = { key: 'synthetic', configurationId: 'configuration', configurationDigest: 'a'.repeat(64), expectedReviewDigest: 'b'.repeat(64), expectedConditionsDigest: 'c'.repeat(64), operation: 'issue' };
  for (const patch of [{ actorId: 'forged' }, { totalCents: 1 }, { publicPaymentUrl: 'https://invalid.example' }, { receipt: {} }])
    assert.throws(() => parseCheckoutEmissionBrowserCommandV1({ ...command, ...patch }));
});

test('catalogue expiry during the last issuance-capability lookup prevents creation after receiver lookup', async () => {
  const t = await fixture();
  try {
    const before = await t.receiver.inspect(); t.expireCatalog();
    const result = await t.post(t.issue); assert.equal(result.statusCode, 200, result.body);
    assert.equal(result.json().paymentAgreementOperationsV2[0].checkout.status, 'reconciliation_required');
    assert.equal(t.calls().lookupCalls, 1); assert.equal(t.calls().issuedCalls, 0);
    assert.deepEqual((await t.receiver.inspect()).allRows, before.allRows);
  } finally { await t.close(); }
});

test('successful checkout response preserves the current Dashboard access revision after remote I/O', async () => {
  const t = await fixture('retainer_50', true);
  try {
    const response = await t.post(t.issue); assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().accessRevision, 'synthetic-checkout-revision');
    assert.equal(response.json().paymentAgreementOperationsV2[0].checkout.status, 'checkout_issued');
  } finally { await t.close(); }
});
