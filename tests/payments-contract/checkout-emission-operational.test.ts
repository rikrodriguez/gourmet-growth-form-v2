import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { canonical, digest } from '../../src/office/backend/event-quote-workflow';
import { prepareGourmetPaymentsAgreementV2, reviewGourmetPaymentsAgreementV2 } from '../../src/office/backend/gourmet-payments-agreement-v2';
import { createPaymentAgreementOperationV2, decodePaymentAgreementReceiptV2,
  type PaymentAgreementOperationV2 } from '../../src/office/backend/payment-agreement-operations-v2';
import type { PaymentContractModeV2 } from '../../src/office/backend/event-quote-contracts';
import { TEST_AT, testActor, testScope } from '../office/event-quote-fixtures';
import { authorization, envelope, operationFixture, request } from './operational-cases';
import { createOperationalPaymentFixtureV2, startOperationalPaymentReceiverV2,
  type OperationalDatabaseBindingV2, type OperationalFixtureOptionsV2,
  type OperationalLedgerSnapshotV2, type OperationalPaymentReceiverV2 } from './php-operational-receiver';

const path = '/internal/payment-checkouts/v1';
const purpose = 'issue_payment_checkout_v1';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const php = process.env.GOURMET_CONTRACT_PHP_BIN || 'php';
const mysqlPhp = process.env.GOURMET_CONTRACT_MYSQL_PHP_BIN || php;
const requested = new Set((process.env.GOURMET_CONTRACT_TEST_ENGINES ?? (process.env.CI === 'true' ? 'mariadb,mysql' : '')).split(',').filter(Boolean));
for (const engine of requested) assert.ok(['mariadb', 'mysql'].includes(engine), 'Explicit supported checkout test engine required');
const evidenceDirectory = fileURLToPath(new URL('../../test-results/gourmet-payments-contract/checkouts/', import.meta.url));

// Expected wire is built independently from the public contract, rather than
// asking the TS transport or PHP issuer to manufacture its own expectation.
function commandFor(operation: PaymentAgreementOperationV2, sourceDraftId: string, actorId = 'SYNTHETIC-CHECKOUT-ISSUER', nowMs = Date.now()) {
  const operationDigest = digest(operation);
  const conditions = { contractVersion: 1, purpose: 'gourmet_payment_checkout',
    sourceDraft: { agreementId: sourceDraftId, operationId: operation.operationId, operationDigest }, operation };
  const pins = { contractVersion: 1, purpose, sourceDraftId, operationId: operation.operationId,
    operationDigest, conditionsDigest: digest(conditions) };
  const issuanceId = digest(pins);
  const authorization = { issuer: 'gourmet_office', purpose, capability: purpose, actorId,
    scope: operation.prepared.plan.scope, issuanceId, sourceDraftId,
    operationDigest, conditionsDigest: pins.conditionsDigest, issuedAtMs: nowMs - 1000, expiresAtMs: nowMs + 60_000 };
  const command = { contractVersion: 1, issuanceId, sourceDraftId, operationId: operation.operationId,
    operationDigest, conditionsDigest: pins.conditionsDigest, authorization };
  return { command, conditions, key: `gourmet-checkout-v1-${issuanceId}` };
}
type Command = ReturnType<typeof commandFor>;
type Receipt = { contractVersion: 1; status: 'checkout_issued'; issuanceId: string; sourceDraftId: string;
  checkoutId: string; conditionsDigest: string; conditions: Command['conditions'];
  providerAssessment: { representation: 'orders_capture' | 'subscriptions_setup_and_one_balance'; blockers: ['PROVIDER_DISABLED'] };
  publicPaymentUrl: string; executable: false; providerEnabled: false; authorizationVerified: false; serviceAuthenticated: true };
const headers = (receiver: OperationalPaymentReceiverV2, key: string) => ({ authorization: `Bearer ${receiver.sharedSecret}`,
  'content-type': 'application/json', 'idempotency-key': key });
function routeInput(receiver: OperationalPaymentReceiverV2, value: Command, extra: Record<string, unknown> = {}) {
  return { action: 'route', path, headers: headers(receiver, value.key), body: canonical(value.command), ...extra };
}
async function httpCommand(receiver: OperationalPaymentReceiverV2, value: Command, expected: number, endpoint = path): Promise<Receipt> {
  const response = await fetch(receiver.baseUrl + endpoint, { method: 'POST', headers: headers(receiver, value.key),
    body: canonical(value.command), signal: AbortSignal.timeout(5000) });
  const body = await response.text(); assert.equal(response.status, expected, body);
  return JSON.parse(body) as Receipt;
}
const snapshot = (receiver: OperationalPaymentReceiverV2) => receiver.fixture.invoke({ action: 'snapshot' }).snapshot;
function unchanged(before: OperationalLedgerSnapshotV2, after: OperationalLedgerSnapshotV2) {
  assert.deepEqual(after, before, 'Every row, encrypted receipt, original schedule, audit and migration must remain identical');
}
function originalRowsPreserved(before: OperationalLedgerSnapshotV2, after: OperationalLedgerSnapshotV2) {
  assert.deepEqual(after.tableNames, before.tableNames, 'Issuance cannot create tables or another ledger');
  for (const [table, hashes] of Object.entries(before.rowHashes)) {
    const remaining = [...after.rowHashes[table]];
    for (const hash of hashes) {
      const index = remaining.indexOf(hash);
      assert.ok(index >= 0, `Existing ${table} row changed or vanished, including binary/encrypted columns`);
      remaining.splice(index, 1);
    }
  }
}
function assertReceipt(receipt: Receipt, value: Command) {
  assert.deepEqual(Object.keys(receipt).sort(), ['contractVersion', 'status', 'issuanceId', 'sourceDraftId', 'checkoutId',
    'conditionsDigest', 'conditions', 'providerAssessment', 'publicPaymentUrl', 'executable', 'providerEnabled',
    'authorizationVerified', 'serviceAuthenticated'].sort());
  assert.equal(receipt.contractVersion, 1); assert.equal(receipt.status, 'checkout_issued');
  assert.match(receipt.checkoutId, uuid); assert.notEqual(receipt.checkoutId, value.command.sourceDraftId);
  assert.equal(receipt.issuanceId, value.command.issuanceId); assert.equal(receipt.sourceDraftId, value.command.sourceDraftId);
  assert.equal(receipt.conditionsDigest, value.command.conditionsDigest); assert.deepEqual(receipt.conditions, value.conditions);
  assert.equal(digest(receipt.conditions), receipt.conditionsDigest);
  assert.deepEqual(receipt.providerAssessment, { representation: value.conditions.operation.prepared.plan.paymentMode === 'full_upfront'
    ? 'orders_capture' : 'subscriptions_setup_and_one_balance', blockers: ['PROVIDER_DISABLED'] });
  assert.match(receipt.publicPaymentUrl, /^https:\/\/synthetic\.invalid\/pay\/[A-Za-z0-9_-]{43}$/);
  assert.equal(receipt.executable, false); assert.equal(receipt.providerEnabled, false);
  assert.equal(receipt.authorizationVerified, false); assert.equal(receipt.serviceAuthenticated, true);
}
function assertIssued(before: OperationalLedgerSnapshotV2, after: OperationalLedgerSnapshotV2, receipt: Receipt, value: Command) {
  assertReceipt(receipt, value); originalRowsPreserved(before, after);
  const plan = value.conditions.operation.prepared.plan;
  assert.equal(after.counts.payment_agreements, before.counts.payment_agreements + 1);
  assert.equal(after.agreements.filter(row => row.status === 'DRAFT_INTERNAL').length,
    before.agreements.filter(row => row.status === 'DRAFT_INTERNAL').length, 'Issuance creates a checkout, never another disabled draft');
  const child = after.agreements.find(row => row.public_uuid === receipt.checkoutId);
  assert.ok(child); assert.equal(child.contract_version, 3); assert.equal(child.payment_mode, plan.paymentMode);
  assert.equal(child.status, 'PENDING_CHECKOUT');
  for (const field of ['operation_id', 'operation_digest', 'operation_json', 'configuration_id', 'configuration_digest'])
    assert.equal(child[field], null, 'Immutable source pins belong to the issuance relation, not a second draft');
  assert.equal(child.terms_version, receipt.conditionsDigest);
  assert.equal(child.reservation_policy_version, `checkout-v1-${plan.paymentMode}`);
  assert.equal(child.total_cents, plan.sourceQuote.totalCents); assert.equal(child.currency, 'USD');
  assert.equal(child.initial_cents, plan.initialPaymentCents); assert.equal(child.balance_cents, plan.paymentBalanceCents);
  assert.equal(child.reservation_cents, plan.paymentMode === 'fixed_49_reservation' ? 4900 : null);
  assert.equal(child.provider, null); assert.equal(child.token_is_null, 0);
  assert.equal(child.link_expires_at, plan.linkExpiration.instant?.replace('T', ' ').replace('Z', '.000000') ?? null);
  assert.equal(child.balance_due_at_utc, plan.paymentSchedule?.balanceInstant.replace('T', ' ').replace('Z', '.000000') ?? null);
  assert.equal(child.balance_timezone, plan.paymentSchedule?.configured.timezone ?? null);
  const schedules = after.schedules.filter(row => row.agreement_uuid === receipt.checkoutId);
  assert.equal(schedules.length, plan.paymentBalanceCents > 0 ? 2 : 1);
  assert.equal(schedules.find(row => row.kind === (plan.paymentMode === 'fixed_49_reservation' ? 'RESERVATION' : 'INITIAL'))?.amount_cents, plan.initialPaymentCents);
  assert.equal(schedules.find(row => row.kind === 'BALANCE')?.amount_cents, plan.paymentBalanceCents || undefined);
  const relation = after.checkoutIssuances.filter(row => row.source_draft_uuid === receipt.sourceDraftId);
  assert.equal(relation.length, 1); assert.equal(relation[0].checkout_uuid, receipt.checkoutId);
  assert.equal(relation[0].issuance_id, receipt.issuanceId); assert.equal(relation[0].conditions_digest, receipt.conditionsDigest);
  assert.equal(relation[0].conditions_json, canonical(value.conditions));
  assert.equal(relation[0].source_operation_id, value.command.operationId);
  assert.equal(relation[0].source_operation_digest, value.command.operationDigest);
  assert.equal(after.counts.payment_checkout_issuances, before.counts.payment_checkout_issuances + 1);
  const guards = after.idempotency.filter(row => row.idempotency_key === value.key);
  assert.equal(guards.length, 1); assert.equal(guards[0].scope, 'internal.payment_checkouts.issue.v1');
  assert.equal(guards[0].encrypted_response, 1); assert.ok(guards[0].completed_at); assert.equal(guards[0].locked_until, null);
  assert.equal(after.counts.idempotency_keys, before.counts.idempotency_keys + 1);
  assert.equal(after.audit.filter(row => row.event_type === 'PAYMENT_CHECKOUT_V1_ISSUED' && row.aggregate_public_uuid === receipt.checkoutId).length, 1);
  for (const table of ['payment_attempts', 'payment_consents', 'provider_resources', 'provider_webhook_events', 'email_outbox', 'monday_sync_outbox', 'sales_os_event_outbox'])
    assert.equal(after.counts[table], before.counts[table], `Issuance must not execute or publish ${table}`);
}
async function draft(receiver: OperationalPaymentReceiverV2, mode: PaymentContractModeV2, suffix: string, total = 10001) {
  const { operation } = await operationFixture(mode, suffix, total);
  const response = await fetch(receiver.baseUrl + '/internal/v2/payment-agreements', { method: 'POST',
    headers: request(operation).headers, body: envelope(operation), signal: AbortSignal.timeout(5000) });
  const body = await response.text(); assert.equal(response.status, 201, body);
  return { operation, receipt: decodePaymentAgreementReceiptV2(body, operation) };
}
async function historicalOperation(kind: 'expiry' | 'balance') {
  const original = await operationFixture('retainer_50', `historical-${kind}`);
  const configuration = structuredClone(original.configuration);
  const minute = (ms: number) => ({ date: new Date(ms).toISOString().slice(0, 10), time: new Date(ms).toISOString().slice(11, 16) });
  if (kind === 'expiry') configuration.linkExpiration = { kind: 'at', ...minute(TEST_AT + 3600_000), timezone: 'UTC' };
  else configuration.paymentSchedule = { kind: 'retainer_50',
    eventDate: minute(TEST_AT + 7 * 86400_000 + 3600_000).date, eventTime: minute(TEST_AT + 7 * 86400_000 + 3600_000).time,
    balanceDate: minute(TEST_AT + 3600_000).date, balanceTime: minute(TEST_AT + 3600_000).time,
    timezone: 'UTC', timingExceptionReason: null };
  const input = { scope: testScope, eventId: original.operation.prepared.plan.eventId, record: original.sourceRecord,
    preparationId: configuration.preparationId, currentCatalogDigest: original.sourceRecord.quotes[0].catalogDigest,
    configuration, nowMs: TEST_AT };
  const reviewed = reviewGourmetPaymentsAgreementV2(input); assert.equal(reviewed.status, 'review_required');
  if (reviewed.status !== 'review_required') throw new Error(JSON.stringify(reviewed));
  const prepared = prepareGourmetPaymentsAgreementV2(input, { actor: testActor, expectedReviewDigest: reviewed.reviewDigest });
  assert.equal(prepared.status, 'prepared_internal'); if (prepared.status !== 'prepared_internal') throw new Error(JSON.stringify(prepared));
  return createPaymentAgreementOperationV2({ prepared, configurationId: `historical-${kind}`,
    configurationDigest: digest(configuration), recipientName: original.operation.recipient.name,
    source: { source: 'synthetic_fixture', canonicalLeadId: configuration.canonicalLeadId,
      serviceName: original.operation.service.name, phone: original.operation.recipient.phone, eventLocation: original.operation.service.eventLocation } });
}

for (const engine of ['sqlite', 'mariadb', 'mysql'] as const) test(`checkout issuance through original Application on disposable ${engine}`, async t => {
  if (engine !== 'sqlite' && !requested.has(engine)) {
    t.skip(`NOT_VALIDATED: checkout engine ${engine} is not selected`); return;
  }
  let database: { binding: OperationalDatabaseBindingV2; close(): Promise<void>; restart(): Promise<void> } | undefined;
  if (engine !== 'sqlite') {
    const { startEphemeralPaymentDatabaseV2 } = await import(new URL('./ephemeral-mysql.ts', import.meta.url).href);
    database = await startEphemeralPaymentDatabaseV2(engine);
  }
  const options: OperationalFixtureOptionsV2 = { phpBinary: engine === 'sqlite' ? php : mysqlPhp, seedLegacy: true,
    checkoutEmission: true, ...(database ? { database: { engine: engine as 'mariadb' | 'mysql', binding: database.binding } } : {}) };
  let receiver: OperationalPaymentReceiverV2 | undefined;
  const checks: string[] = [];
  const runCase = async (name: string, run: () => unknown | Promise<unknown>) => {
    let failure: unknown;
    await t.test(name, async () => { try { await run(); } catch (error) { failure = error; throw error; } });
    if (failure) throw failure;
    checks.push(name);
  };
  try {
    receiver = await startOperationalPaymentReceiverV2(options);
    const active = receiver;
    await runCase('customer HTTP serves only the two byte-verified original static assets', async () => {
      const manifest = JSON.parse(await readFile(new URL('./operational-assets/SOURCES.json', import.meta.url), 'utf8'));
      const before = snapshot(active);
      for (const file of manifest.files) {
        const asset = await fetch(`${active.baseUrl}/assets/${file.name}`);
        assert.equal(asset.status, 200); assert.equal(asset.headers.get('x-content-type-options'), 'nosniff');
        const bytes = Buffer.from(await asset.arrayBuffer()); assert.equal(bytes.length, file.size);
        assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256);
      }
      const checkoutStyles = await fetch(`${active.baseUrl}/assets/payment-checkout-v3.css`);
      assert.equal(checkoutStyles.status, 200);
      assert.match(checkoutStyles.headers.get('content-type') ?? '', /^text\/css\b/);
      assert.equal(checkoutStyles.headers.get('x-content-type-options'), 'nosniff');
      assert.equal((await fetch(`${active.baseUrl}/assets/synthetic-unlisted.js`)).status, 404);
      unchanged(before, snapshot(active));
    });
    for (const [mode, total] of [['retainer_50', 10001], ['full_upfront', 10001], ['fixed_49_reservation', 10001], ['retainer_50', 9800], ['full_upfront', 1]] as const) {
      await runCase(`${mode}/${total}: exact child checkout, immutable parent, encrypted replay and current customer terms`, async () => {
        const source = await draft(active, mode, `checkout-${engine}-${mode}-${total}`, total);
        const value = commandFor(source.operation, source.receipt.agreementId);
        const before = snapshot(active), issued = await httpCommand(active, value, 201), after = snapshot(active);
        assertIssued(before, after, issued, value);
        const token = new URL(issued.publicPaymentUrl).pathname.split('/').at(-1)!;
        const proof = active.fixture.invoke({ action: 'checkout_storage_proof', token, url: issued.publicPaymentUrl, agreementId: issued.checkoutId });
        assert.deepEqual(proof.checkoutStorageProof, { tokenHashMatches: true, plaintextTokenPresent: false, plaintextUrlPresent: false });
        unchanged(after, proof.snapshot);
        const page = await fetch(active.baseUrl + new URL(issued.publicPaymentUrl).pathname, { redirect: 'manual' });
        const html = await page.text(); assert.equal(page.status, 200, html);
        const money = (cents: number) => `$${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
        assert.ok(html.includes(money(value.conditions.operation.prepared.plan.initialPaymentCents)), html);
        assert.ok(html.includes('Condiciones sintéticas aprobadas.'), 'Customer page must display the actual newly approved terms');
        assert.match(html, /<link rel="stylesheet" href="\/assets\/payment-checkout-v3\.css">/);
        assert.ok(html.indexOf('class="agreement-terms"') < html.indexOf('class="consent"'), 'Terms precede acceptance in the document');
        assert.match(html, /<input type="checkbox" name="consent" value="yes" required disabled>/, 'Disabled processing cannot collect acceptance');
        assert.match(html, /<button type="submit" class="checkout-unavailable" disabled>Payment unavailable<\/button>/);
        assert.doesNotMatch(html, /class="paypal-button"|>Pay \$/);
        assert.ok(html.includes(`name="conditions_digest" value="${issued.conditionsDigest}"`), 'The accepted conditions remain bound to the hidden digest');
        const plan = value.conditions.operation.prepared.plan;
        const timezones = new Set<string>();
        for (const timezone of [plan.linkExpiration.configured.timezone, plan.paymentSchedule?.configured.timezone]) {
          if (typeof timezone === 'string') timezones.add(timezone);
        }
        for (const timezone of timezones) {
          assert.ok(html.includes(`<span class="checkout-timezone">${timezone}</span>`), 'Timezone identifiers remain complete display units');
        }
        if (mode !== 'fixed_49_reservation') {
          assert.doesNotMatch(html, /reservation fee is (?:<[^>]+>)*non-refundable/i);
          assert.doesNotMatch(html, /Pay \$49 with PayPal/);
        }
        if (mode === 'full_upfront') assert.doesNotMatch(html, /automatically charge|future balance payment/i);
        const start = await fetch(active.baseUrl + new URL(issued.publicPaymentUrl).pathname + '/paypal', { method: 'POST', redirect: 'manual' });
        assert.equal(start.status, 503, await start.text());
        unchanged(after, snapshot(active)); assert.equal((await active.inspect()).providerCalls, 0);
        const replay = await httpCommand(active, commandFor(source.operation, source.receipt.agreementId, 'SYNTHETIC-ANOTHER-CURRENT-ISSUER'), 200);
        assert.deepEqual(replay, issued); unchanged(after, snapshot(active));
        await active.restart();
        assert.deepEqual(await httpCommand(active, commandFor(source.operation, source.receipt.agreementId), 200, path + '/reconcile'), issued);
        unchanged(after, snapshot(active));
        if (mode === 'retainer_50' && total === 10001) {
          const guards = active.fixture.invoke({ action: 'checkout_sql_guards', sourceDraftId: issued.sourceDraftId });
          assert.equal(guards.transactionOpen, false); assert.ok(guards.checkoutSqlGuards); assert.equal(guards.checkoutSqlGuards.assertions, 14);
          assert.ok(Object.values(guards.checkoutSqlGuards.facts).every(Boolean)); unchanged(after, guards.snapshot);
        }
      });
    }
    await runCase('default off, fresh purpose/capability, canonical wire, source pins and commercial gates do not consume any ledger row', async () => {
      const source = await draft(active, 'retainer_50', `checkout-${engine}-gates`);
      const value = commandFor(source.operation, source.receipt.agreementId), before = snapshot(active);
      const absentReconcile = active.fixture.invoke({ ...routeInput(active, value), path: path + '/reconcile' });
      assert.equal(absentReconcile.response?.status, 404); unchanged(before, absentReconcile.snapshot);
      const reject = (body: unknown, status: number, env: NodeJS.ProcessEnv = {}, extra: Record<string, unknown> = {}) => {
        const result = active.fixture.invoke(routeInput(active, value, { body: canonical(body), ...extra }), env);
        assert.equal(result.response?.status, status, result.response?.body); unchanged(before, result.snapshot);
      };
      reject(value.command, 404, { INTERNAL_CHECKOUT_V1_ENABLED: 'false' });
      reject(value.command, 404, {}, { headers: { ...headers(active, value.key), authorization: 'Bearer synthetic-wrong' } });
      reject(value.command, 405, {}, { method: 'GET' });
      reject(value.command, 415, {}, { headers: { ...headers(active, value.key), 'content-type': 'text/plain' } });
      reject(value.command, 400, {}, { headers: headers(active, value.key + '-other') });
      for (const modify of [
        (c: any) => { c.authorization.purpose = 'create_disabled_payment_agreement_v2'; },
        (c: any) => { delete c.authorization.capability; c.authorization.canApprove = true; },
        (c: any) => { c.authorization.capability = 'approve'; },
        (c: any) => { c.authorization.issuedAtMs = Date.now() - 120_000; c.authorization.expiresAtMs = Date.now() - 60_000; },
        (c: any) => { c.authorization.issuedAtMs = Date.now() + 60_000; c.authorization.expiresAtMs = Date.now() + 120_000; },
        (c: any) => { c.authorization.issuedAtMs = Date.now() - 1000; c.authorization.expiresAtMs = Date.now() + 300_001; },
        (c: any) => { c.totalCents = 10000; }, (c: any) => { c.currency = 'EUR'; },
        (c: any) => { c.paymentMode = 'fixed_49_reservation'; },
        (c: any) => { c.balanceDueAt = '2099-12-09T17:00:00Z'; },
      ]) { const changed = structuredClone(value.command); modify(changed); reject(changed, 422); }
      const reordered = Object.fromEntries(Object.entries(value.command).reverse());
      const reorderedResult = active.fixture.invoke(routeInput(active, value, { body: JSON.stringify(reordered) }));
      assert.equal(reorderedResult.response?.status, 422); unchanged(before, reorderedResult.snapshot);
      const duplicateKeyResult = active.fixture.invoke(routeInput(active, value,
        { body: canonical(value.command).replace('"contractVersion":1', '"contractVersion":1,"contractVersion":1') }));
      assert.equal(duplicateKeyResult.response?.status, 422); unchanged(before, duplicateKeyResult.snapshot);
      reject(value.command, 503, {}, { production: true });
      const commercial = structuredClone(value.command); commercial.authorization.scope = { ...commercial.authorization.scope, mode: 'commercial' };
      reject(commercial, 503);
      const scopeMismatch = structuredClone(value.command); scopeMismatch.authorization.scope = { ...scopeMismatch.authorization.scope, workspaceId: 'SYNTHETIC-OTHER-WORKSPACE' };
      reject(scopeMismatch, 409);
      const absent = commandFor(source.operation, '00000000-0000-4000-8000-000000009999');
      const absentResult = active.fixture.invoke(routeInput(active, absent));
      assert.equal(absentResult.response?.status, 404, absentResult.response?.body); unchanged(before, absentResult.snapshot);
      const legacy = commandFor(source.operation, '00000000-0000-4000-8000-000000000001');
      const legacyResult = active.fixture.invoke(routeInput(active, legacy));
      assert.equal(legacyResult.response?.status, 422, legacyResult.response?.body); unchanged(before, legacyResult.snapshot);
      for (const changedPins of [{ operationDigest: 'a'.repeat(64) }, { conditionsDigest: 'b'.repeat(64) }, { operationId: 'c'.repeat(64) }]) {
        const altered = { ...value.command, ...changedPins };
        const issuanceId = digest({ contractVersion: 1, purpose, sourceDraftId: altered.sourceDraftId,
          operationId: altered.operationId, operationDigest: altered.operationDigest, conditionsDigest: altered.conditionsDigest });
        altered.issuanceId = issuanceId;
        altered.authorization = { ...altered.authorization, issuanceId, operationDigest: altered.operationDigest, conditionsDigest: altered.conditionsDigest };
        const result = active.fixture.invoke({ action: 'route', path, headers: headers(active, `gourmet-checkout-v1-${issuanceId}`), body: canonical(altered) });
        assert.equal(result.response?.status, 409, result.response?.body); unchanged(before, result.snapshot);
      }
      assert.equal((await active.inspect()).providerCalls, 0);
    });
    await runCase('expired source calendars reject a new issuance using the current receiver clock, with every historical row unchanged', async () => {
      for (const kind of ['expiry', 'balance'] as const) {
        const operation = await historicalOperation(kind);
        const seeded = active.fixture.invoke({ action: 'historical_draft', atMs: TEST_AT + 1000, body: envelope(operation, authorization(operation, TEST_AT + 1000)) });
        assert.ok(seeded.historicalDraftId);
        const value = commandFor(operation, seeded.historicalDraftId!), before = snapshot(active);
        const result = active.fixture.invoke(routeInput(active, value));
        assert.equal(result.response?.status, 422, result.response?.body); unchanged(before, result.snapshot);
      }
    });
    await runCase('actual customer GET after immutable checkout expiration is unavailable and preserves every parent, receipt and outbox row', async () => {
      const source = await draft(active, 'full_upfront', `checkout-${engine}-expired-customer-link`);
      const value = commandFor(source.operation, source.receipt.agreementId), issued = await httpCommand(active, value, 201);
      const before = snapshot(active), token = new URL(issued.publicPaymentUrl).pathname.split('/').at(-1)!;
      const expired = active.fixture.invoke({ action: 'checkout_expired_route', token });
      assert.equal(expired.response?.status, 404, expired.response?.body);
      assert.match(expired.response.body, /This payment link is unavailable\./);
      unchanged(before, expired.snapshot); assert.equal(expired.providerCalls, 0);
      for (const table of ['sales_os_event_outbox', 'email_outbox', 'monday_sync_outbox']) assert.equal(expired.snapshot.counts[table], 0);
      assert.deepEqual(await httpCommand(active, commandFor(source.operation, source.receipt.agreementId), 200, path + '/reconcile'), issued);
      unchanged(before, snapshot(active));
    });
    await runCase('real final-audit failure atomically rolls back child, schedules, parent relation, receipt and guard; identical retry commits once', async () => {
      const source = await draft(active, 'retainer_50', `checkout-${engine}-rollback`);
      const value = commandFor(source.operation, source.receipt.agreementId);
      const before = active.fixture.invoke({ action: 'install_checkout_audit_failure' }).snapshot;
      try {
        const failed = active.fixture.invoke(routeInput(active, value));
        assert.equal(failed.response?.status, 503, failed.response?.body); unchanged(before, failed.snapshot);
      } finally { active.fixture.invoke({ action: 'remove_checkout_audit_failure' }); }
      const afterRemoval = snapshot(active), issued = await httpCommand(active, value, 201);
      const committed = snapshot(active); assertIssued(afterRemoval, committed, issued, value);
      assert.deepEqual(await httpCommand(active, value, 200), issued); unchanged(committed, snapshot(active));
    });
    await runCase('authority expiring after child, receipt and audit persistence rolls back the entire transaction before commit', async () => {
      const source = await draft(active, 'retainer_50', `checkout-${engine}-final-freshness`);
      const value = commandFor(source.operation, source.receipt.agreementId), before = snapshot(active);
      const result = active.fixture.invoke({ action: 'checkout_authority_expiry', body: canonical(value.command) });
      assert.equal(result.callbackCalls, 1); assert.equal(result.transactionOpen, false);
      assert.deepEqual(result.checkoutExpiryProof, { childPresentInside: true, relationPresentInside: true,
        encryptedReceiptPresentInside: true, auditPresentInside: true, rejectedAtCommit: true });
      unchanged(before, result.snapshot);
      const issued = await httpCommand(active, value, 201);
      assertIssued(before, snapshot(active), issued, value);
    });
    await runCase('parallel identical commands and lost responses recover exactly one child UUID, token and encrypted receipt across process restart', async () => {
      const source = await draft(active, 'full_upfront', `checkout-${engine}-race`), value = commandFor(source.operation, source.receipt.agreementId);
      const before = snapshot(active);
      const attempts = await Promise.all(['SYNTHETIC-RACE-A', 'SYNTHETIC-RACE-B'].map(actor => active.fixture.invokeAsync(routeInput(active, commandFor(source.operation, source.receipt.agreementId, actor)))));
      assert.equal(attempts.filter(result => result.response?.status === 201).length, 1);
      for (const result of attempts) assert.ok([200, 201, 409].includes(result.response!.status), result.response!.body);
      // Deliberately discard the successful response: recovery must use the
      // actual committed encrypted receipt, rather than a saved URL in Node.
      await active.restart();
      const recovered = await httpCommand(active, value, 200, path + '/reconcile');
      const after = snapshot(active); assertIssued(before, after, recovered, value);
      const repeated = await httpCommand(active, commandFor(source.operation, source.receipt.agreementId, 'SYNTHETIC-RACE-RECOVERY'), 200);
      assert.deepEqual(repeated, recovered); unchanged(after, snapshot(active));
      for (const result of attempts.filter(result => [200, 201].includes(result.response!.status)))
        assert.deepEqual(JSON.parse(result.response!.body), recovered);
    });
    const final = await active.inspect(); assert.equal(final.providerCalls, 0);
    await mkdir(evidenceDirectory, { recursive: true });
    await writeFile(`${evidenceDirectory}${engine}.json`, JSON.stringify({ suite: 'original-payments-checkout-issuance-v1',
      status: 'VALIDATED', engine, storage: final.storage, checks, providerCalls: final.providerCalls,
      checkoutCount: final.checkoutIssuances.length, relationRows: final.counts.payment_checkout_issuances,
      draftCount: final.agreements.filter(row => row.status === 'DRAFT_INTERNAL').length }, null, 2) + '\n');
  } catch (error) {
    await mkdir(evidenceDirectory, { recursive: true });
    await writeFile(`${evidenceDirectory}${engine}.json`, JSON.stringify({ suite: 'original-payments-checkout-issuance-v1',
      status: 'FAILED', engine, checks, message: error instanceof Error ? error.message : String(error) }, null, 2) + '\n');
    throw error;
  } finally { await receiver?.close(); await database?.close(); }
});

test('checkout fixture capability remains off unless explicitly composed', async () => {
  const fixture = await createOperationalPaymentFixtureV2({ phpBinary: php });
  try {
    const source = await operationFixture('retainer_50', 'checkout-default-off');
    const parent = fixture.invoke(request(source.operation)); assert.equal(parent.response?.status, 201);
    const receipt = decodePaymentAgreementReceiptV2(parent.response!.body, source.operation);
    const value = commandFor(source.operation, receipt.agreementId), before = parent.snapshot;
    const result = fixture.invoke({ action: 'route', path, headers: { authorization: 'Bearer synthetic-operational-fixture-no-authority',
      'content-type': 'application/json', 'idempotency-key': value.key }, body: canonical(value.command) });
    assert.equal(result.response?.status, 404); unchanged(before, result.snapshot);
  } finally { await fixture.close(); }
});
