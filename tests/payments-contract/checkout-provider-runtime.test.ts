import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { canonical, digest } from '../../src/office/backend/event-quote-workflow';
import type { PaymentContractModeV2 } from '../../src/office/backend/event-quote-contracts';
import { decodePaymentAgreementReceiptV2 } from '../../src/office/backend/payment-agreement-operations-v2';
import { operationFixture, request } from './operational-cases';
import { createOperationalPaymentFixtureV2, operationalFixtureSharedSecret,
  type OperationalFixtureV2 } from './php-operational-receiver';

const php = process.env.GOURMET_CONTRACT_PHP_BIN || 'php';
const runner = fileURLToPath(new URL('./checkout-provider-runtime.php', import.meta.url));
const noNetwork = 'curl_exec,curl_multi_exec,fsockopen,pfsockopen,stream_socket_client,stream_socket_server,socket_create,socket_connect,socket_sendto,dns_get_record,gethostbyname,gethostbynamel,checkdnsrr,mail,exec,shell_exec,system,passthru,popen,proc_open,pcntl_exec,dl';
type ProviderResult = {
  result?: { status?: string; paid?: boolean; approvalUrl?: string | null; providerReference?: string | null; agreementStatus?: string };
  error?: { class: string; code: string }; providerCalls: number;
  liveCalls: number; transport: string;
  consentProof?: { negativeRejections: string[]; beforeValidRows: number; afterFirstRows: number;
    afterSecondRows: number; repeatedRowsIdentical: boolean };
  calls: { method: string; path: string; requestId: string | null; payload: any }[];
  snapshot: { counts: Record<string, number>; allRows: Record<string, { rows: number; sha256: string }>;
    agreements: any[]; schedules: any[]; attempts: any[]; resources: any[]; idempotency: any[]; audit: any[];
    consents: any[]; outboxes: Record<string, any[]> };
};

function provider(fixture: OperationalFixtureV2, input: Record<string, unknown>): ProviderResult {
  const run = spawnSync(php, ['-d', 'xdebug.mode=off', '-d', 'allow_url_fopen=0', '-d', 'allow_url_include=0',
    '-d', `disable_functions=${noNetwork}`, runner, fixture.runtime, fixture.directory], {
    input: JSON.stringify(input), encoding: 'utf8', timeout: 10_000, maxBuffer: 8_388_608,
    cwd: fixture.directory, env: { PATH: process.env.PATH || '/usr/bin:/bin', TZ: 'UTC', LC_ALL: 'C' },
  });
  assert.ifError(run.error); assert.equal(run.status, 0, run.stderr); assert.equal(run.stderr, '');
  const value = JSON.parse(run.stdout) as ProviderResult;
  assert.equal(value.liveCalls, 0); assert.equal(value.transport, 'explicit_fake_no_fallback');
  return value;
}
function success(value: ProviderResult) { assert.equal(value.error, undefined, JSON.stringify(value.error)); return value; }
const calls = (value: ProviderResult, path: string, method = 'POST') => value.calls.filter(call => call.path === path && call.method === method);
const noOutboxes = (value: ProviderResult) => {
  for (const rows of Object.values(value.snapshot.outboxes)) assert.deepEqual(rows, []);
};
function unchangedFinancial(before: ProviderResult, after: ProviderResult) {
  for (const table of ['payment_schedules', 'payment_attempts', 'audit_events', 'email_outbox', 'monday_sync_outbox', 'sales_os_event_outbox'])
    assert.deepEqual(after.snapshot.allRows[table], before.snapshot.allRows[table], table);
}
async function emit(fixture: OperationalFixtureV2, mode: PaymentContractModeV2, suffix: string, total = 10001) {
  const { operation } = await operationFixture(mode, suffix, total);
  const draft = fixture.invoke(request(operation));
  assert.equal(draft.response?.status, 201, draft.response?.body);
  const receipt = decodePaymentAgreementReceiptV2(draft.response!.body, operation);
  const conditions = { contractVersion: 1, purpose: 'gourmet_payment_checkout',
    sourceDraft: { agreementId: receipt.agreementId, operationId: operation.operationId, operationDigest: digest(operation) }, operation };
  const purpose = 'issue_payment_checkout_v1', nowMs = Date.now();
  const pins = { contractVersion: 1, purpose, sourceDraftId: receipt.agreementId, operationId: operation.operationId,
    operationDigest: digest(operation), conditionsDigest: digest(conditions) };
  const issuanceId = digest(pins);
  const command = { contractVersion: 1, issuanceId, sourceDraftId: receipt.agreementId, operationId: operation.operationId,
    operationDigest: digest(operation), conditionsDigest: digest(conditions), authorization: {
      issuer: 'gourmet_office', purpose, capability: purpose, actorId: 'SYNTHETIC-PROVIDER-CHECKOUT-ISSUER',
      scope: operation.prepared.plan.scope, issuanceId, sourceDraftId: receipt.agreementId,
      operationDigest: digest(operation), conditionsDigest: digest(conditions), issuedAtMs: nowMs - 1000, expiresAtMs: nowMs + 60_000,
    } };
  const issued = fixture.invoke({ action: 'route', path: '/internal/payment-checkouts/v1',
    headers: { authorization: `Bearer ${operationalFixtureSharedSecret}`, 'content-type': 'application/json',
      'idempotency-key': `gourmet-checkout-v1-${issuanceId}` }, body: canonical(command) });
  assert.equal(issued.response?.status, 201, issued.response?.body);
  const checkout = JSON.parse(issued.response!.body) as { checkoutId: string };
  assert.notEqual(checkout.checkoutId, receipt.agreementId);
  return { childAgreementId: checkout.checkoutId, sourceDraftId: receipt.agreementId, operation };
}

test('versioned checkout provider uses the original PDO ledger and explicitly injected fake HTTP transport', async t => {
  const fixture = await createOperationalPaymentFixtureV2({ checkoutEmission: true, phpBinary: php });
  try {
    for (const mode of ['retainer_50', 'fixed_49_reservation'] as const) await t.test(`${mode}: finite plan, child binding, reusable GET validation and both actual paid schedules`, async () => {
      // An even50% amount of4900 remains retainer; it must not acquire49policy.
      const value = await emit(fixture, mode, `provider-runtime-${mode}`, mode === 'retainer_50' ? 9800 : 10001);
      const started = success(provider(fixture, { action: 'start', childAgreementId: value.childAgreementId, nowMs: Date.now() }));
      assert.match(started.result!.approvalUrl!, /^https:\/\/www\.sandbox\.paypal\.com\//);
      const reference = started.result!.providerReference!;
      const subscriptionCalls = started.calls.filter(call => call.path === '/v1/billing/subscriptions' && call.method === 'POST');
      const sub = subscriptionCalls.at(-1)!.payload;
      assert.equal(sub.custom_id, value.childAgreementId); assert.notEqual(sub.custom_id, value.sourceDraftId);
      assert.equal(sub.start_time, value.operation.prepared.plan.paymentSchedule!.balanceInstant);
      const planCall = started.calls.filter(call => call.path === '/v1/billing/plans' && call.method === 'POST').at(-1)!;
      assert.equal(planCall.payload.payment_preferences.setup_fee.value, (value.operation.prepared.plan.initialPaymentCents / 100).toFixed(2));
      assert.equal(planCall.payload.billing_cycles.length, 1); assert.equal(planCall.payload.billing_cycles[0].tenure_type, 'REGULAR');
      assert.equal(planCall.payload.billing_cycles[0].total_cycles, 1);
      assert.equal(planCall.payload.billing_cycles[0].pricing_scheme.fixed_price.value, (value.operation.prepared.plan.paymentBalanceCents / 100).toFixed(2));
      assert.ok(!JSON.stringify(planCall.payload).includes('non-refundable'));
      const replay = success(provider(fixture, { action: 'start', childAgreementId: value.childAgreementId, nowMs: Date.now() }));
      assert.equal(replay.result!.providerReference, reference); assert.equal(replay.result!.approvalUrl, started.result!.approvalUrl);
      assert.equal(calls(replay, '/v1/billing/subscriptions').length, subscriptionCalls.length);
      const baseline = provider(fixture, { action: 'inspect' });
      provider(fixture, { action: 'fake_control', control: { wrongPlanBalance: true } });
      const mismatched = provider(fixture, { action: 'status', childAgreementId: value.childAgreementId, nowMs: Date.now() });
      assert.ok(mismatched.error); unchangedFinancial(baseline, mismatched);
      provider(fixture, { action: 'fake_control', control: { resetControls: true, providerReference: reference, completeInitial: true } });
      const initial = success(provider(fixture, { action: 'status', childAgreementId: value.childAgreementId, nowMs: Date.now() }));
      assert.equal(initial.result!.paid, false);
      assert.equal(initial.result!.agreementStatus, mode === 'retainer_50' ? 'INITIAL_PAID' : 'RESERVATION_PAID');
      const schedules = initial.snapshot.schedules.filter(row => row.agreement_id === initial.snapshot.agreements.find(row => row.public_uuid === value.childAgreementId).id);
      assert.equal(schedules.find(row => row.kind === (mode === 'retainer_50' ? 'INITIAL' : 'RESERVATION')).status, 'PAID');
      assert.equal(schedules.find(row => row.kind === 'BALANCE').status, 'SCHEDULED');
      provider(fixture, { action: 'fake_control', control: { resetControls: true, providerReference: reference, completeBalance: true } });
      const balanceNow = Date.parse(value.operation.prepared.plan.paymentSchedule!.balanceInstant) + 1000;
      const completed = success(provider(fixture, { action: 'status', childAgreementId: value.childAgreementId, nowMs: balanceNow }));
      assert.equal(completed.result!.paid, true); assert.equal(completed.result!.agreementStatus, 'FULLY_PAID');
      const restart = success(provider(fixture, { action: 'status', childAgreementId: value.childAgreementId, nowMs: balanceNow }));
      assert.deepEqual(restart.snapshot.allRows, completed.snapshot.allRows, 'A separate PHP process replays both payments without duplicating attempts/audit');
      noOutboxes(restart);
    });

    await t.test('Orders full payment: return GET is read-only, explicit capture is one-off and separate-process replay never captures twice', async () => {
      const value = await emit(fixture, 'full_upfront', 'provider-runtime-orders');
      const started = success(provider(fixture, { action: 'start', childAgreementId: value.childAgreementId, nowMs: Date.now() }));
      const reference = started.result!.providerReference!;
      assert.match(started.result!.approvalUrl!, /^https:\/\/www\.sandbox\.paypal\.com\//);
      const create = calls(started, '/v2/checkout/orders').at(-1)!;
      assert.equal(create.payload.intent, 'CAPTURE'); assert.equal(create.payload.purchase_units.length, 1);
      assert.equal(create.payload.purchase_units[0].custom_id, value.childAgreementId);
      assert.equal(create.payload.purchase_units[0].invoice_id, value.childAgreementId);
      assert.deepEqual(create.payload.purchase_units[0].amount, { currency_code: 'USD', value: '100.01' });
      provider(fixture, { action: 'fake_control', control: { resetControls: true, providerReference: reference, approveOrder: true } });
      const returned = success(provider(fixture, { action: 'resume', childAgreementId: value.childAgreementId, providerReference: reference, nowMs: Date.now() }));
      assert.equal(returned.result!.status, 'APPROVED'); assert.equal(returned.result!.paid, false);
      assert.equal(calls(returned, `/v2/checkout/orders/${reference}/capture`).length, 0);
      const captured = success(provider(fixture, { action: 'capture', childAgreementId: value.childAgreementId, providerReference: reference, nowMs: Date.now() }));
      assert.equal(captured.result!.paid, true); assert.equal(captured.result!.agreementStatus, 'FULLY_PAID');
      assert.equal(calls(captured, `/v2/checkout/orders/${reference}/capture`).length, 1);
      const again = success(provider(fixture, { action: 'capture', childAgreementId: value.childAgreementId, providerReference: reference, nowMs: Date.now() }));
      assert.deepEqual(again.snapshot.allRows, captured.snapshot.allRows);
      assert.equal(calls(again, `/v2/checkout/orders/${reference}/capture`).length, 1);
      noOutboxes(again);
    });

    await t.test('lost create response leaves a durable ambiguity instead of creating another order', async () => {
      const value = await emit(fixture, 'full_upfront', 'provider-runtime-lost-create');
      provider(fixture, { action: 'fake_control', control: { resetControls: true, loseOrderCreateResponse: true } });
      const before = provider(fixture, { action: 'inspect' });
      const failed = provider(fixture, { action: 'start', childAgreementId: value.childAgreementId, nowMs: Date.now() });
      assert.ok(failed.error); unchangedFinancial(before, failed);
      const posts = calls(failed, '/v2/checkout/orders').length;
      const retry = provider(fixture, { action: 'start', childAgreementId: value.childAgreementId, nowMs: Date.now() });
      assert.ok(retry.error); assert.equal(calls(retry, '/v2/checkout/orders').length, posts);
      assert.ok(retry.snapshot.idempotency.some(row => row.scope === 'PAYPAL_CHECKOUT_ORDER_CREATE_V1' && row.completed_at === null && row.locked_until === null));
      noOutboxes(retry);
    });

    await t.test('lost capture response and a late local audit failure recover the same remote capture with atomic ledger retry', async () => {
      const value = await emit(fixture, 'full_upfront', 'provider-runtime-capture-recovery');
      provider(fixture, { action: 'fake_control', control: { resetControls: true } });
      const started = success(provider(fixture, { action: 'start', childAgreementId: value.childAgreementId, nowMs: Date.now() }));
      const reference = started.result!.providerReference!;
      provider(fixture, { action: 'fake_control', control: { approveOrder: true, providerReference: reference, loseCaptureResponse: true } });
      provider(fixture, { action: 'install_audit_failure' });
      const before = provider(fixture, { action: 'inspect' });
      const failed = provider(fixture, { action: 'capture', childAgreementId: value.childAgreementId, providerReference: reference, nowMs: Date.now() });
      assert.ok(failed.error); unchangedFinancial(before, failed);
      assert.equal(calls(failed, `/v2/checkout/orders/${reference}/capture`).length, 1);
      provider(fixture, { action: 'remove_audit_failure' });
      const recovered = success(provider(fixture, { action: 'status', childAgreementId: value.childAgreementId, nowMs: Date.now() }));
      assert.equal(recovered.result!.paid, true); assert.equal(calls(recovered, `/v2/checkout/orders/${reference}/capture`).length, 1);
      assert.ok(recovered.snapshot.idempotency.some(row => row.scope === 'PAYPAL_CHECKOUT_ORDER_CAPTURE_V1' && row.completed_at !== null && row.locked_until === null));
      const replay = success(provider(fixture, { action: 'status', childAgreementId: value.childAgreementId, nowMs: Date.now() }));
      assert.deepEqual(replay.snapshot.allRows, recovered.snapshot.allRows); noOutboxes(replay);
    });

    await t.test('revocation committed during authoritative GET prevents the subsequent capture POST', async () => {
      const value = await emit(fixture, 'full_upfront', 'provider-runtime-revoke-after-get');
      provider(fixture, { action: 'fake_control', control: { resetControls: true } });
      const started = success(provider(fixture, { action: 'start', childAgreementId: value.childAgreementId, nowMs: Date.now() }));
      const reference = started.result!.providerReference!;
      const before = provider(fixture, { action: 'inspect' });
      provider(fixture, { action: 'fake_control', control: { approveOrder: true, providerReference: reference, revokeChildDuringOrderGet: true } });
      const refused = provider(fixture, { action: 'capture', childAgreementId: value.childAgreementId, providerReference: reference, nowMs: Date.now() });
      assert.ok(refused.error); assert.equal(calls(refused, `/v2/checkout/orders/${reference}/capture`).length, 0);
      assert.ok(refused.snapshot.agreements.find(row => row.public_uuid === value.childAgreementId).link_revoked_at);
      unchangedFinancial(before, refused); noOutboxes(refused);
    });

    await t.test('expiration while GET or OAuth is delayed is rechecked immediately before provider mutation', async () => {
      const value = await emit(fixture, 'full_upfront', 'provider-runtime-expiry-after-get');
      provider(fixture, { action: 'fake_control', control: { resetControls: true } });
      const started = success(provider(fixture, { action: 'start', childAgreementId: value.childAgreementId, nowMs: Date.now() }));
      const reference = started.result!.providerReference!;
      const before = provider(fixture, { action: 'inspect' });
      provider(fixture, { action: 'fake_control', control: { approveOrder: true, providerReference: reference, delayOrderGetMs: 50 } });
      const deadline = Date.parse(value.operation.prepared.plan.linkExpiration.instant!);
      const refused = provider(fixture, { action: 'capture', childAgreementId: value.childAgreementId, providerReference: reference, nowMs: deadline - 5 });
      assert.ok(refused.error); assert.equal(calls(refused, `/v2/checkout/orders/${reference}/capture`).length, 0);
      unchangedFinancial(before, refused);
      const oauth = await emit(fixture, 'full_upfront', 'provider-runtime-expiry-after-oauth');
      provider(fixture, { action: 'fake_control', control: { resetControls: true, delayOAuthMs: 100 } });
      const beforeOAuth = provider(fixture, { action: 'inspect' });
      const refusedOAuth = provider(fixture, { action: 'start', childAgreementId: oauth.childAgreementId,
        nowMs: Date.parse(oauth.operation.prepared.plan.linkExpiration.instant!) - 80 });
      assert.ok(refusedOAuth.error);
      assert.equal(calls(refusedOAuth, '/v1/oauth2/token').length, calls(beforeOAuth, '/v1/oauth2/token').length + 1,
        'The expiry check runs after an actual delayed OAuth response, before the order POST');
      assert.equal(calls(refusedOAuth, '/v2/checkout/orders').length, calls(beforeOAuth, '/v2/checkout/orders').length);
      unchangedFinancial(beforeOAuth, refusedOAuth); noOutboxes(refusedOAuth);
    });

    await t.test('malformed transaction collections, wrong currency and out-of-window payment timestamps cannot mark any schedule paid', async () => {
      for (const [suffix, control] of [
        ['object', { transactionsObject: true }],
        ['currency', { wrongCurrency: true }],
        ['before-creation', { paymentTime: '2020-01-01T00:00:00Z' }],
        ['future', { paymentTime: new Date(Date.now() + 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z') }],
      ] as const) {
        const value = await emit(fixture, 'retainer_50', `provider-runtime-invalid-${suffix}`);
        provider(fixture, { action: 'fake_control', control: { resetControls: true } });
        const started = success(provider(fixture, { action: 'start', childAgreementId: value.childAgreementId, nowMs: Date.now() }));
        const before = provider(fixture, { action: 'inspect' });
        provider(fixture, { action: 'fake_control', control: { resetControls: true,
          providerReference: started.result!.providerReference, completeInitial: true, ...control } });
        const refused = provider(fixture, { action: 'status', childAgreementId: value.childAgreementId, nowMs: Date.now() });
        assert.ok(refused.error, suffix); unchangedFinancial(before, refused); noOutboxes(refused);
      }
    });

    await t.test('numeric JSON objects cannot impersonate billing-cycle, purchase-unit or capture arrays', async () => {
      const split = await emit(fixture, 'retainer_50', 'provider-runtime-cycle-object');
      provider(fixture, { action: 'fake_control', control: { resetControls: true } });
      success(provider(fixture, { action: 'start', childAgreementId: split.childAgreementId, nowMs: Date.now() }));
      let before = provider(fixture, { action: 'inspect' });
      provider(fixture, { action: 'fake_control', control: { resetControls: true, planCyclesObject: true } });
      const badCycle = provider(fixture, { action: 'status', childAgreementId: split.childAgreementId, nowMs: Date.now() });
      assert.ok(badCycle.error); unchangedFinancial(before, badCycle);
      const full = await emit(fixture, 'full_upfront', 'provider-runtime-unit-capture-objects');
      provider(fixture, { action: 'fake_control', control: { resetControls: true } });
      const started = success(provider(fixture, { action: 'start', childAgreementId: full.childAgreementId, nowMs: Date.now() }));
      const reference = started.result!.providerReference!;
      before = provider(fixture, { action: 'inspect' });
      provider(fixture, { action: 'fake_control', control: { resetControls: true, orderUnitsObject: true } });
      const badUnits = provider(fixture, { action: 'status', childAgreementId: full.childAgreementId, nowMs: Date.now() });
      assert.ok(badUnits.error); unchangedFinancial(before, badUnits);
      provider(fixture, { action: 'fake_control', control: { resetControls: true, providerReference: reference,
        approveOrder: true, orderCapturesObject: true } });
      const badCaptures = provider(fixture, { action: 'capture', childAgreementId: full.childAgreementId, providerReference: reference, nowMs: Date.now() });
      assert.ok(badCaptures.error); unchangedFinancial(before, badCaptures);
      provider(fixture, { action: 'fake_control', control: { resetControls: true } });
      const recovered = success(provider(fixture, { action: 'status', childAgreementId: full.childAgreementId, nowMs: Date.now() }));
      assert.equal(recovered.result!.paid, true);
      assert.equal(calls(recovered, `/v2/checkout/orders/${reference}/capture`).length, 1);
      noOutboxes(recovered);
    });
  } finally { await fixture.close(); }
});

test('original checkout service records only the buyer consent appropriate to each explicit payment mode', async t => {
  const fixture = await createOperationalPaymentFixtureV2({ checkoutEmission: true, phpBinary: php });
  try {
    for (const mode of ['retainer_50', 'full_upfront', 'fixed_49_reservation'] as const)
      await t.test(`${mode}: exact conditions, SQL incompatibility rejection before insert and idempotent service repetition`, async () => {
        const value = await emit(fixture, mode, `provider-buyer-consent-${mode}`);
        const before = provider(fixture, { action: 'inspect' });
        const result = success(provider(fixture, { action: 'consent_proof', childAgreementId: value.childAgreementId, nowMs: Date.now() }));
        assert.deepEqual(result.consentProof, { negativeRejections: ['type', 'amount', 'digest', 'due'],
          beforeValidRows: 0, afterFirstRows: mode === 'full_upfront' ? 1 : 2,
          afterSecondRows: mode === 'full_upfront' ? 1 : 2, repeatedRowsIdentical: true });
        const child = result.snapshot.agreements.find(row => row.public_uuid === value.childAgreementId);
        const rows = result.snapshot.consents.filter(row => row.agreement_id === child.id);
        const plan = value.operation.prepared.plan;
        const expected = mode === 'full_upfront'
          ? [['ONE_TIME_PAYMENT', plan.sourceQuote.totalCents, null]]
          : [['INITIAL_PAYMENT', plan.initialPaymentCents, null], ['FUTURE_BALANCE_CHARGE', plan.paymentBalanceCents, child.balance_due_at_utc]];
        assert.deepEqual(rows.map(row => [row.consent_type, row.amount_cents, row.scheduled_charge_at]), expected);
        for (const row of rows) {
          assert.equal(row.terms_version, child.terms_version); assert.equal(row.provider, 'PAYPAL');
          assert.notEqual(row.consent_type, 'NON_REFUNDABLE_RESERVATION');
        }
        for (const [table, footprint] of Object.entries(before.snapshot.allRows))
          if (table !== 'payment_consents') assert.deepEqual(result.snapshot.allRows[table], footprint, `${table}: source, receipt and every other row stay unchanged`);
        assert.equal(result.providerCalls, 0); assert.equal(result.liveCalls, 0); noOutboxes(result);
      });
  } finally { await fixture.close(); }
});
