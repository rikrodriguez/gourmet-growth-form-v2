import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical, digest } from '../../src/office/backend/event-quote-workflow';
import type { PaymentAgreementOperationV2, PaymentAgreementReceiptV2 } from '../../src/office/backend/payment-agreement-operations-v2';
import { prepareGourmetCheckoutConditionsV1 } from '../../src/office/backend/gourmet-checkout-conditions-v1';
import { operationFixture } from './operational-cases';
import { TEST_AT } from '../office/event-quote-fixtures';

type Mode = 'retainer_50' | 'full_upfront' | 'fixed_49_reservation';
type Mutable = Record<string, any>;
type OperationCase = { label: string; operation: PaymentAgreementOperationV2; nowMs?: number };
const expectedAssessment = (mode: Mode) => ({ representation: mode === 'full_upfront' ? 'orders_capture' : 'subscriptions_setup_and_one_balance', blockers: ['PROVIDER_DISABLED'] });
const uuid = (index: number) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
function draftReceipt(operation: PaymentAgreementOperationV2, agreementId = uuid(0)): PaymentAgreementReceiptV2 {
  return { contractVersion: 2, status: 'draft_persisted', agreementId, operationId: operation.operationId,
    operationDigest: digest(operation), operation, executable: false, providerEnabled: false,
    publicPaymentUrl: null, authorizationVerified: false, serviceAuthenticated: true };
}
/** Recompute untrusted integrity fields so malformed business facts reach the
 * actual structural validator rather than failing only their outer hash. */
function changed(operation: PaymentAgreementOperationV2, mutate: (value: Mutable) => void, reseal = true): PaymentAgreementOperationV2 {
  const value = structuredClone(operation) as Mutable;
  mutate(value);
  if (reseal) {
    value.prepared.reviewDigest = digest(value.prepared.plan);
    value.prepared.internalApproval.reviewDigest = value.prepared.reviewDigest;
  }
  return value as PaymentAgreementOperationV2;
}
function retainerCalendar(operation: PaymentAgreementOperationV2, input: {
  eventDate: string; balanceDate: string; timezone: string; eventInstant: string; balanceInstant: string;
}): PaymentAgreementOperationV2 {
  return changed(operation, value => {
    value.prepared.plan.paymentSchedule = { configured: { kind: 'retainer_50', eventDate: input.eventDate,
      eventTime: '18:00', timezone: input.timezone, balanceDate: input.balanceDate, balanceTime: '12:00', timingExceptionReason: null },
      eventInstant: input.eventInstant, balanceInstant: input.balanceInstant, proposedBalanceDate: input.balanceDate, timingReviewReason: null };
    value.prepared.plan.linkExpiration = { configured: { kind: 'never' }, instant: null };
  });
}
let casePromise: Promise<{ valid: OperationCase[]; invalid: OperationCase[] }> | undefined;
function cases() {
  return casePromise ??= (async () => {
    const retainer = (await operationFixture('retainer_50', 'checkout-retainer-odd')).operation;
    const full = (await operationFixture('full_upfront', 'checkout-full-odd')).operation;
    const fixed = (await operationFixture('fixed_49_reservation', 'checkout-fixed-odd')).operation;
    const valid: OperationCase[] = [
      { label: 'retainer odd cents', operation: retainer }, { label: 'full odd cents', operation: full }, { label: 'fixed odd cents', operation: fixed },
    ];
    for (const [mode, total] of [['full_upfront', 1], ['retainer_50', 2], ['fixed_49_reservation', 4901],
      ['retainer_50', 9800], ['fixed_49_reservation', 9800], ['retainer_50', 1_000_000_000],
      ['full_upfront', 1_000_000_000], ['fixed_49_reservation', 1_000_000_000]] as const) {
      // These are structural wire bounds, not an assertion that a catalog item
      // at that unit price or a current commercial quote has been authorized.
      const operation = total < 1_000_000 ? (await operationFixture(mode, `checkout-${mode}-${total}`, total)).operation
        : changed(mode === 'retainer_50' ? retainer : mode === 'full_upfront' ? full : fixed, value => {
          const p = value.prepared.plan;
          p.sourceQuote.totalCents = total; p.sourceQuote.depositCents = Math.floor((total * p.sourceQuote.depositBasis.basisPoints + 5000) / 10000);
          p.initialPaymentCents = mode === 'full_upfront' ? total : mode === 'retainer_50' ? Math.floor((total + 1) / 2) : 4900;
          p.paymentBalanceCents = total - p.initialPaymentCents;
          if (mode === 'fixed_49_reservation') p.paymentSchedule.configured.agreedBalanceCents = p.paymentBalanceCents;
        });
      valid.push({ label: `${mode} boundary ${total}`, operation });
    }
    valid.push({ label: 'New York calendar crosses DST without subtracting 168 hours', operation: retainerCalendar(retainer, {
      eventDate: '2030-03-13', balanceDate: '2030-03-06', timezone: 'America/New_York',
      eventInstant: '2030-03-13T22:00:00Z', balanceInstant: '2030-03-06T17:00:00Z' }) });
    valid.push({ label: 'UTC leap-year balance date', operation: retainerCalendar(retainer, {
      eventDate: '2032-03-07', balanceDate: '2032-02-29', timezone: 'UTC',
      eventInstant: '2032-03-07T18:00:00Z', balanceInstant: '2032-02-29T12:00:00Z' }) });
    valid.push({ label: 'Kathmandu year boundary and fractional offset', operation: retainerCalendar(retainer, {
      eventDate: '2030-01-04', balanceDate: '2029-12-28', timezone: 'Asia/Kathmandu',
      eventInstant: '2030-01-04T12:15:00Z', balanceInstant: '2029-12-28T06:15:00Z' }) });
    valid.push({ label: 'never expires full without invented future schedule', operation: changed(full, value => {
      value.prepared.plan.linkExpiration = { configured: { kind: 'never' }, instant: null };
    }) });
    valid.push({ label: 'explicit alternate future retainer date preserves timing reason', operation: changed(retainer, value => {
      const s = value.prepared.plan.paymentSchedule;
      s.configured.balanceDate = '2099-12-07'; s.balanceInstant = '2099-12-07T17:00:00Z';
      s.configured.timingExceptionReason = s.timingReviewReason = 'Fecha alternativa sintética aprobada; preservar exactamente.\r\nSegunda línea.';
    }) });
    for (const basisPoints of [0, 10000]) valid.push({ label: `quoted percentage ${basisPoints} is preserved independently from the selected retainer`,
      operation: changed(retainer, value => {
        value.prepared.plan.sourceQuote.depositBasis.basisPoints = basisPoints;
        value.prepared.plan.sourceQuote.depositCents = Math.floor((10001 * basisPoints + 5000) / 10000);
      }) });
    valid.push({ label: 'conditions retain the complete allowed UTF-16 length', operation: changed(full, value => {
      value.prepared.plan.paymentTerms = '🥘'.repeat(2000);
    }) });
    const invalid: OperationCase[] = [];
    const reject = (label: string, mutate: (value: Mutable) => void, operation = retainer, reseal = true) => invalid.push({ label, operation: changed(operation, mutate, reseal) });
    for (const total of [0, -1, 0.5, 1_000_000_001, Number.MAX_SAFE_INTEGER + 1])
      reject(`invalid total ${total}`, value => { value.prepared.plan.sourceQuote.totalCents = total; });
    reject('fractional initial cents', value => { value.prepared.plan.initialPaymentCents = 5000.5; });
    reject('initial plus balance differs from total', value => { ++value.prepared.plan.paymentBalanceCents; });
    reject('odd retainer rounded down instead of up', value => { value.prepared.plan.initialPaymentCents = 5000; value.prepared.plan.paymentBalanceCents = 5001; });
    reject('quoted deposit half-up cents changed', value => { --value.prepared.plan.sourceQuote.depositCents; });
    for (const basisPoints of [-1, 5000.5, 10001]) reject(`invalid basis points ${basisPoints}`, value => { value.prepared.plan.sourceQuote.depositBasis.basisPoints = basisPoints; });
    for (const currency of ['EUR', 'usd', '', null]) reject(`invalid currency ${currency}`, value => { value.prepared.plan.sourceQuote.currency = currency; });
    for (const mode of ['legacy_v1', 'retainer_50 ', 'RETAINER_50', null]) reject(`invalid mode ${mode}`, value => { value.prepared.plan.paymentMode = mode; });
    reject('fixed 49 cannot inherit percentage initial', value => { value.prepared.plan.initialPaymentCents = 5001; value.prepared.plan.paymentBalanceCents = 5000; }, fixed);
    reject('fixed reservation requires a positive balance after USD 49', value => {
      const p = value.prepared.plan; p.sourceQuote.totalCents = 4900; p.sourceQuote.depositCents = 2450;
      p.initialPaymentCents = 4900; p.paymentBalanceCents = p.paymentSchedule.configured.agreedBalanceCents = 0;
    }, fixed);
    reject('retainer one cent cannot invent a zero future balance', value => {
      const p = value.prepared.plan; p.sourceQuote.totalCents = p.sourceQuote.depositCents = p.initialPaymentCents = 1; p.paymentBalanceCents = 0;
    });
    reject('fixed amount agreement missing', value => { delete value.prepared.plan.paymentSchedule.configured.agreedBalanceCents; }, fixed);
    reject('full cannot retain a future balance', value => { value.prepared.plan.initialPaymentCents = 10000; value.prepared.plan.paymentBalanceCents = 1; }, full);
    reject('full cannot retain a split schedule', value => { value.prepared.plan.paymentSchedule = structuredClone(retainer.prepared.plan.paymentSchedule); }, full);
    for (const key of ['canonicalLeadId', 'paymentTerms', 'termsChangeReason', 'paymentSchedule', 'linkExpiration']) reject(`missing ${key}`, value => { delete value.prepared.plan[key]; });
    reject('changed conditions without explicit reason', value => { value.prepared.plan.termsChangeReason = null; });
    reject('whitespace-only conditions', value => { value.prepared.plan.paymentTerms = '\u00a0\t'; });
    reject('conditions exceed UTF-16 boundary', value => { value.prepared.plan.paymentTerms = '🥘'.repeat(2001); });
    reject('terms include forbidden control byte', value => { value.prepared.plan.paymentTerms += '\u0000'; });
    reject('preparation binding changed', value => { value.prepared.plan.preparationId += 'a'; });
    reject('configuration digest binding changed', value => { value.configurationDigest = 'a'.repeat(64); });
    reject('configuration ID binding changed', value => { value.configurationId += '-other'; });
    reject('operation ID binding changed', value => { value.operationId = 'a'.repeat(64); });
    reject('recipient does not match intended quote recipient', value => { value.recipient.email = 'other@example.test'; });
    reject('approval actor missing', value => { delete value.prepared.internalApproval.actorId; });
    reject('approval purpose changed', value => { value.prepared.internalApproval.purpose = 'charge_buyer'; });
    reject('approval is in the future', value => { value.prepared.internalApproval.atMs = TEST_AT + 1; });
    reject('review digest mismatched', value => { value.prepared.reviewDigest = 'b'.repeat(64); }, retainer, false);
    reject('approval review digest mismatched', value => { value.prepared.internalApproval.reviewDigest = 'b'.repeat(64); }, retainer, false);
    reject('unknown operation field', value => { value.paymentUrl = 'https://synthetic.invalid/forbidden'; });
    reject('prepared executable flag', value => { value.prepared.executable = true; });
    reject('prepared provider flag', value => { value.prepared.providerEnabled = true; });
    for (const timezone of [null, 'EST', '+05:45', 'Synthetic/Nowhere']) reject(`invalid timezone ${timezone}`, value => { value.prepared.plan.paymentSchedule.configured.timezone = timezone; });
    reject('missing explicit event hour', value => { value.prepared.plan.paymentSchedule.configured.eventTime = null; });
    reject('missing explicit balance hour', value => { delete value.prepared.plan.paymentSchedule.configured.balanceTime; });
    reject('impossible local date', value => { value.prepared.plan.paymentSchedule.configured.balanceDate = '2030-02-30'; });
    reject('second-precision local time', value => { value.prepared.plan.paymentSchedule.configured.balanceTime = '12:00:01'; });
    reject('changed UTC instant', value => { value.prepared.plan.paymentSchedule.balanceInstant = '2099-12-08T17:00:01Z'; });
    reject('balance not before event', value => { const s = value.prepared.plan.paymentSchedule; s.configured.balanceDate = s.configured.eventDate; s.configured.balanceTime = s.configured.eventTime; s.balanceInstant = s.eventInstant; });
    reject('DST gap cannot resolve to an approved instant', value => { const s = value.prepared.plan.paymentSchedule; s.configured.balanceDate = '2030-03-10'; s.configured.balanceTime = '02:30'; s.balanceInstant = '2030-03-10T07:30:00Z'; });
    reject('DST fold cannot select one occurrence implicitly', value => { const s = value.prepared.plan.paymentSchedule; s.configured.balanceDate = '2030-11-03'; s.configured.balanceTime = '01:30'; s.balanceInstant = '2030-11-03T05:30:00Z'; });
    reject('alternate balance without timing reason', value => { const s = value.prepared.plan.paymentSchedule; s.configured.balanceDate = '2099-12-07'; s.balanceInstant = '2099-12-07T17:00:00Z'; });
    reject('missing expiry policy', value => { value.prepared.plan.linkExpiration = null; });
    reject('expiry named zone missing', value => { delete value.prepared.plan.linkExpiration.configured.timezone; });
    reject('expiry instant altered', value => { value.prepared.plan.linkExpiration.instant = '2099-11-20T18:00:01Z'; });
    reject('never-expiry cannot retain an instant', value => { value.prepared.plan.linkExpiration.configured = { kind: 'never' }; });
    invalid.push({ label: 'expiry exactly now is no longer current', operation: retainer, nowMs: Date.parse(retainer.prepared.plan.linkExpiration.instant!) });
    invalid.push({ label: 'balance exactly now is no longer current', operation: changed(retainer, value => {
      value.prepared.plan.linkExpiration = { configured: { kind: 'never' }, instant: null };
    }), nowMs: Date.parse(retainer.prepared.plan.paymentSchedule!.balanceInstant) });
    return { valid, invalid };
  })();
}

async function receipt(mode: 'retainer_50' | 'full_upfront' | 'fixed_49_reservation' = 'retainer_50', total = 10001): Promise<PaymentAgreementReceiptV2> {
  const { operation } = await operationFixture(mode, `checkout-${mode}-${total}`, total);
  return { contractVersion: 2, status: 'draft_persisted', agreementId: '00000000-0000-4000-8000-000000000101',
    operationId: operation.operationId, operationDigest: digest(operation), operation,
    executable: false, providerEnabled: false, publicPaymentUrl: null, authorizationVerified: false, serviceAuthenticated: true };
}

test('checkout conditions preserve the complete odd-cent retainer operation and its immutable draft binding', async () => {
  const draft = await receipt(), before = structuredClone(draft), result = prepareGourmetCheckoutConditionsV1({ receipt: draft, nowMs: TEST_AT });
  assert.equal(result.status, 'prepared_checkout_conditions');
  if (result.status !== 'prepared_checkout_conditions') throw new Error(JSON.stringify(result));
  assert.deepEqual(result.conditions, { contractVersion: 1, purpose: 'gourmet_payment_checkout',
    sourceDraft: { agreementId: draft.agreementId, operationId: draft.operationId, operationDigest: draft.operationDigest }, operation: draft.operation });
  assert.equal(canonical(result.conditions.operation), canonical(draft.operation));
  assert.equal(result.conditions.operation.prepared.plan.initialPaymentCents, 5001);
  assert.equal(result.conditions.operation.prepared.plan.paymentBalanceCents, 5000);
  assert.equal(result.conditionsDigest, digest(result.conditions));
  assert.deepEqual(result.providerAssessment, { representation: 'subscriptions_setup_and_one_balance',
    blockers: ['PROVIDER_DISABLED'] });
  assert.deepEqual(draft, before);
});

test('full upfront preserves one cent and selects the approved Orders CAPTURE representation', async () => {
  const result = prepareGourmetCheckoutConditionsV1({ receipt: await receipt('full_upfront', 1), nowMs: TEST_AT });
  assert.equal(result.status, 'prepared_checkout_conditions');
  if (result.status !== 'prepared_checkout_conditions') throw new Error(JSON.stringify(result));
  assert.equal(result.conditions.operation.prepared.plan.paymentBalanceCents, 0);
  assert.equal(result.conditions.operation.prepared.plan.paymentSchedule, null);
  assert.deepEqual(result.providerAssessment, { representation: 'orders_capture', blockers: ['PROVIDER_DISABLED'] });
});

test('all approved checkout modes preserve every source, calendar, expiry and condition byte', async t => {
  for (const [index, item] of (await cases()).valid.entries()) await t.test(item.label, () => {
    const input = draftReceipt(item.operation, uuid(index)), before = canonical(input);
    const result = prepareGourmetCheckoutConditionsV1({ receipt: input, nowMs: TEST_AT });
    assert.equal(result.status, 'prepared_checkout_conditions', JSON.stringify(result));
    if (result.status !== 'prepared_checkout_conditions') throw new Error(JSON.stringify(result));
    assert.deepEqual(result.providerAssessment, expectedAssessment(item.operation.prepared.plan.paymentMode));
    assert.equal(canonical(result.conditions.operation), canonical(item.operation));
    assert.deepEqual(result.conditions.sourceDraft, { agreementId: uuid(index), operationId: item.operation.operationId, operationDigest: digest(item.operation) });
    assert.equal(result.conditionsDigest, digest(result.conditions));
    assert.equal(canonical(JSON.parse(canonical(result.conditions))), canonical(result.conditions));
    assert.equal(canonical(input), before, 'Preparing conditions must not mutate source evidence');
    assert.notEqual(result.conditions.operation, item.operation, 'Detached output must not freeze or retain mutable caller objects');
    assert.ok(Object.isFrozen(result.conditions.operation.prepared.plan.sourceQuote.depositBasis));
    assert.throws(() => { result.conditions.operation.prepared.plan.paymentTerms = 'changed'; }, TypeError);
  });
});

test('rehashing incompatible facts cannot turn them into checkout conditions', async t => {
  for (const item of (await cases()).invalid) await t.test(item.label, () => {
    const result = prepareGourmetCheckoutConditionsV1({ receipt: draftReceipt(item.operation), nowMs: item.nowMs ?? TEST_AT });
    assert.equal(result.status, 'blocked', `${item.label}: ${JSON.stringify(result)}`);
    if (result.status === 'blocked') assert.match(result.code, /^[A-Z][A-Z0-9_]{0,95}$/);
  });
});

test('USD 49 initial amount never changes a percentage agreement into a fixed reservation', async () => {
  const values = (await cases()).valid.filter(item => item.label.endsWith('boundary 9800'));
  assert.equal(values.length, 2);
  const results = values.map(item => prepareGourmetCheckoutConditionsV1({ receipt: draftReceipt(item.operation), nowMs: TEST_AT }));
  for (const result of results) {
    assert.equal(result.status, 'prepared_checkout_conditions');
    if (result.status !== 'prepared_checkout_conditions') throw new Error(JSON.stringify(result));
    assert.equal(result.conditions.operation.prepared.plan.initialPaymentCents, 4900);
    assert.equal(result.conditions.operation.prepared.plan.sourceQuote.depositBasis.basisPoints, 5000);
  }
  assert.notEqual(values[0].operation.prepared.plan.paymentMode, values[1].operation.prepared.plan.paymentMode);
  assert.notEqual(digest(values[0].operation), digest(values[1].operation));
  assert.equal(values[0].operation.prepared.plan.paymentSchedule!.configured.kind, 'retainer_50');
  assert.equal(values[1].operation.prepared.plan.paymentSchedule!.configured.kind, 'fixed_49_reservation');
});

test('only a complete disabled draft receipt can bind checkout conditions', async t => {
  const draft = await receipt();
  const mutations: [string, (value: Mutable) => void][] = [
    ['missing agreement UUID', value => { delete value.agreementId; }],
    ['invalid agreement UUID', value => { value.agreementId = 'synthetic-not-uuid'; }],
    ['v1 receipt', value => { value.contractVersion = 1; }],
    ['unpersisted status', value => { value.status = 'prepared_internal'; }],
    ['operation digest mismatch', value => { value.operationDigest = 'a'.repeat(64); }],
    ['operation ID mismatch', value => { value.operationId = 'a'.repeat(64); }],
    ['URL attached', value => { value.publicPaymentUrl = 'https://synthetic.invalid/not-issued'; }],
    ['provider enabled', value => { value.providerEnabled = true; }],
    ['executable flag', value => { value.executable = true; }],
    ['authority inferred', value => { value.authorizationVerified = true; }],
    ['service authentication absent', value => { value.serviceAuthenticated = false; }],
    ['unknown receipt field', value => { value.checkout = true; }],
  ];
  for (const [label, mutate] of mutations) await t.test(label, () => {
    const value = structuredClone(draft); mutate(value);
    assert.equal(prepareGourmetCheckoutConditionsV1({ receipt: value, nowMs: TEST_AT }).status, 'blocked');
  });
  for (const nowMs of [-1, NaN, Infinity, TEST_AT + 0.5, 8_640_000_000_000_001])
    assert.deepEqual(prepareGourmetCheckoutConditionsV1({ receipt: draft, nowMs }), { status: 'blocked', code: 'INVALID_NOW' });
});

test('untrusted receipt objects cannot execute getters, serializers or proxy traps', async () => {
  const draft = await receipt(); let observed = 0;
  const getter = structuredClone(draft);
  Object.defineProperty(getter, 'operation', { enumerable: true, get() { ++observed; throw new Error('getter'); } });
  const serializer = { ...draft, toJSON() { ++observed; return draft; } };
  const proxy = new Proxy(draft, { ownKeys() { ++observed; throw new Error('proxy'); } });
  const cycle: Mutable = structuredClone(draft); cycle.self = cycle;
  const symbol = { ...draft, [Symbol('unknown')]: true };
  const loneSurrogate = structuredClone(draft); loneSurrogate.operation.recipient.name = '\ud800';
  for (const value of [getter, serializer, proxy, cycle, symbol, loneSurrogate, Object.create(draft), undefined, null, []])
    assert.equal(prepareGourmetCheckoutConditionsV1({ receipt: value, nowMs: TEST_AT }).status, 'blocked');
  assert.equal(observed, 0);
});

test('TS conditions round trip through original PHP operation validation and the disabled provider projections', async t => {
  const { valid, invalid } = await cases();
  const directory = await mkdtemp(join(tmpdir(), 'gourmet-checkout-contract-'));
  try {
    const { prepareGourmetPaymentsOperationalRuntime } = await import(new URL('../../scripts/prepare-gourmet-payments-operational.mjs', import.meta.url).href);
    const runtime = await prepareGourmetPaymentsOperationalRuntime({ destination: join(directory, 'runtime') });
    const disabledFunctions = 'curl_exec,curl_multi_exec,fsockopen,pfsockopen,stream_socket_client,stream_socket_server,socket_create,socket_connect,socket_sendto,dns_get_record,gethostbyname,gethostbynamel,checkdnsrr,mail,exec,shell_exec,system,passthru,popen,proc_open,pcntl_exec,dl';
    const child = spawnSync(process.env.GOURMET_CONTRACT_PHP_BIN || 'php', ['-d', 'xdebug.mode=off', '-d', 'allow_url_fopen=0',
      '-d', 'allow_url_include=0', '-d', `disable_functions=${disabledFunctions}`,
      fileURLToPath(new URL('./checkout-provider-contract.php', import.meta.url)), runtime], {
      input: JSON.stringify({ nowMs: TEST_AT, operations: valid.map(item => item.operation), invalidOperations: invalid }),
      encoding: 'utf8', timeout: 15_000, maxBuffer: 4_194_304, cwd: directory,
      env: { PATH: process.env.PATH || '/usr/bin:/bin', TZ: 'UTC', LC_ALL: 'C' },
    });
    assert.ifError(child.error); assert.equal(child.signal, null); assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stderr, '', 'Pure PHP contract fixture must emit no warnings');
    const output = JSON.parse(child.stdout);
    assert.equal(output.results.length, valid.length); assert.equal(output.invalidOperations, invalid.length);
    assert.equal(output.providerCalls, 0); assert.equal(output.databaseConnections, 0);
    assert.ok(output.fakeProvider.transportCalls > 0, 'Provider adapter proof must execute the original client through the explicit fake transport');
    assert.deepEqual(output.fakeProvider.checks, {
      createRequestBoundAndApprovedUnpaid: true, completedReplaySkipsCapture: true,
      lostCaptureRecoveredByGet: true, duplicateCaptureRecoveredByGet: true,
      unresolvedAndPendingNeverPaid: true, expiryBlocksNewCaptureButAllowsReadOnlyRecovery: true,
      incompatibleOrderEvidenceRejected: 18, splitModesNeverReinterpretedAsOrders: true,
    });
    for (const [index, item] of valid.entries()) {
      const result = prepareGourmetCheckoutConditionsV1({ receipt: draftReceipt(item.operation, uuid(index)), nowMs: TEST_AT });
      assert.equal(result.status, 'prepared_checkout_conditions');
      if (result.status !== 'prepared_checkout_conditions') throw new Error(JSON.stringify(result));
      const php = output.results[index];
      assert.equal(php.canonical, canonical(result.conditions), item.label);
      assert.equal(php.conditionsDigest, result.conditionsDigest, item.label);
      assert.deepEqual(php.conditions, result.conditions, item.label);
      assert.deepEqual(php.providerAssessment, result.providerAssessment, item.label);
      assert.deepEqual(JSON.parse(php.canonical).operation, item.operation);
    }
    assert.ok(output.assertions >= 200);
    t.diagnostic(JSON.stringify({ validCases: valid.length, incompatibleCases: invalid.length, phpAssertions: output.assertions,
      providerCalls: output.providerCalls, databaseConnections: output.databaseConnections,
      fakeProvider: output.fakeProvider }));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
