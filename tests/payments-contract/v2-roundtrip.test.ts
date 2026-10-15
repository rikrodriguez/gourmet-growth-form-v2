import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { canonical, digest } from '../../src/office/backend/event-quote-workflow';
import { prepareGourmetPaymentsAgreementV2, reviewGourmetPaymentsAgreementV2, type InternalPaymentPreparationV2 } from '../../src/office/backend/gourmet-payments-agreement-v2';
import { decodeGourmetPaymentsV2Receipt, prepareGourmetPaymentsV2Wire, type GourmetPaymentsV2Wire } from '../../src/office/backend/gourmet-payments-v2-wire';
import type { PaymentContractModeV2 } from '../../src/office/backend/event-quote-contracts';
import { TEST_AT, testActor, testBrief, testCatalog, testScope, testService } from '../office/event-quote-fixtures';

const receiverClass = fileURLToPath(new URL('../../integrations/gourmet-payments-v2/src/Http/InternalPaymentPlanV2.php', import.meta.url));
const receiverHarness = fileURLToPath(new URL('./receive-v2.php', import.meta.url));
const phpBinary = process.env.GOURMET_CONTRACT_PHP_BIN || 'php';
const disabledFunctions = 'curl_exec,curl_multi_exec,fsockopen,pfsockopen,stream_socket_client,stream_socket_server,socket_create,socket_connect,socket_sendto,dns_get_record,gethostbyname,gethostbynamel,checkdnsrr,mail,exec,shell_exec,system,passthru,popen,proc_open,pcntl_exec,dl';
const sourceTerms = 'Condiciones cotizadas sintéticas.\nPreservar espacios:  dos; Unicode: café 🥘; separadores:\u2028línea\u2029párrafo; barra / y \\ literal.';
const newTerms = 'Condiciones del nuevo plan sintético.\r\nSin autorización de cobro; 🧾 / \"texto\"; \u2028\u2029; saldo según calendario revisado.';

type PhpResult = { status: 'blocked'; code: string } | {
  status: 'contract_validated_internal'; prepared: InternalPaymentPreparationV2;
  executable: false; providerEnabled: false; publicPaymentUrl: null; authorizationVerified: false;
};
function receiveRaw(body: string, nowMs: number = TEST_AT): PhpResult {
  const child = spawnSync(phpBinary, [
    '-d', 'xdebug.mode=off', '-d', 'allow_url_fopen=0', '-d', 'allow_url_include=0',
    '-d', `disable_functions=${disabledFunctions}`, receiverHarness, String(nowMs),
  ], {
    input: body, encoding: 'utf8', timeout: 5000, maxBuffer: 1_048_576,
    cwd: fileURLToPath(new URL('.', import.meta.url)),
    // Neither application settings nor credentials enter this isolated child.
    env: { PATH: process.env.PATH || '/usr/bin:/bin', TZ: 'UTC', LC_ALL: 'C' },
  });
  assert.ifError(child.error);
  assert.equal(child.signal, null, `PHP v2 interrupted: ${child.signal}`);
  assert.equal(child.status, 0, `Isolated PHP v2 failed: ${child.stderr || child.stdout}`);
  assert.equal(child.stderr, '', 'Isolated PHP v2 must not emit warnings');
  return JSON.parse(child.stdout) as PhpResult;
}
function receive(value: unknown, nowMs: number = TEST_AT) { return receiveRaw(canonical(value), nowMs); }
function expectBlocked(value: PhpResult) {
  assert.equal(value.status, 'blocked');
  if (value.status !== 'blocked') throw new Error('Incompatible synthetic plan unexpectedly validated');
  assert.deepEqual(Object.keys(value).sort(), ['code', 'status']);
  assert.equal(typeof value.code, 'string'); assert.ok(value.code.length > 0);
}
function rehash(prepared: any) {
  prepared.reviewDigest = digest(prepared.plan);
  prepared.internalApproval.reviewDigest = prepared.reviewDigest;
  return prepared;
}
async function fixture(mode: PaymentContractModeV2 = 'retainer_50', total = 10001, bps = 5000) {
  const t = testService(), eventId = 'synthetic-v2-wire';
  const quantity = total === 1_000_000_000 ? 1000 : 1;
  const catalog = { ...testCatalog, taxBps: 0, depositBps: bps, terms: sourceTerms,
    items: [{ ...testCatalog.items[0], unitPriceCents: total / quantity }] };
  t.catalog(catalog);
  const execute = (command: unknown) => t.service.execute(testScope, testActor, eventId, command);
  let view = await execute({ action: 'create', key: 'create', expectedRevision: 0, brief: testBrief });
  view = await execute({ action: 'quote', key: 'quote', expectedRevision: 1, expectedBriefDigest: view.record.briefs[0].digest,
    expectedCatalogDigest: digest(catalog), selections: [{ itemId: catalog.items[0].id, quantity }] });
  const q = view.record.quotes[0];
  view = await execute({ action: 'approve', key: 'approve', expectedRevision: 2, quoteVersion: q.version,
    quoteDigest: q.digest, artifactSha256: q.artifact.sha256, intendedRecipient: testBrief.recipient });
  view = await execute({ action: 'prepare_payment_v2', key: 'prepare-v2', expectedRevision: 3, quoteVersion: q.version,
    quoteDigest: q.digest, approvalDigest: view.record.decisions[0].digest, artifactSha256: q.artifact.sha256, paymentMode: mode });
  const p = view.record.paymentContractPreparationsV2![0];
  const configuration: any = { contractVersion: 2, preparationId: p.id, paymentMode: mode,
    canonicalLeadId: 'synthetic-canonical-lead', paymentTerms: newTerms, termsChangeReason: 'Revisión expresa sintética de las nuevas condiciones.',
    paymentSchedule: mode === 'full_upfront' ? null : mode === 'retainer_50'
      ? { kind: mode, eventDate: '2099-12-15', eventTime: '18:00', timezone: 'America/New_York', balanceDate: '2099-12-08', balanceTime: '12:00', timingExceptionReason: null }
      : { kind: mode, balanceDate: '2099-12-01', balanceTime: '09:30', timezone: 'Asia/Kathmandu', agreedBalanceCents: p.paymentBalanceCents },
    linkExpiration: { kind: 'at', date: '2099-11-20', time: '13:00', timezone: 'America/New_York' } };
  const input = { scope: testScope, eventId, record: view.record, preparationId: p.id,
    currentCatalogDigest: digest(catalog), configuration, nowMs: TEST_AT };
  return { input, configuration, q, p };
}
function approve(input: Parameters<typeof reviewGourmetPaymentsAgreementV2>[0]) {
  const review = reviewGourmetPaymentsAgreementV2(input);
  assert.equal(review.status, 'review_required');
  if (review.status !== 'review_required') throw new Error(JSON.stringify(review));
  return { actor: testActor, expectedReviewDigest: review.reviewDigest };
}
function wire(input: Parameters<typeof prepareGourmetPaymentsV2Wire>[0]): GourmetPaymentsV2Wire {
  const result = prepareGourmetPaymentsV2Wire(input, approve(input));
  assert.equal(result.status, 'prepared_wire_internal');
  if (result.status !== 'prepared_wire_internal') throw new Error(JSON.stringify(result));
  return result;
}

test('isolated PHP v2 class is required; the original fixed-reservation parser is not a substitute', () => {
  assert.ok(existsSync(receiverClass), 'The new isolated PHP v2 class is absent; no fallback to original PHP v1 is permitted');
});

for (const mode of ['retainer_50', 'full_upfront', 'fixed_49_reservation'] as const) {
  test(`current workflow -> TS -> isolated PHP v2 -> TS preserves every ${mode} fact with odd cents and Unicode terms`, async () => {
    const t = await fixture(mode), before = structuredClone(t.input), original = prepareGourmetPaymentsAgreementV2(t.input, approve(t.input));
    const serialized = wire(t.input), result = receiveRaw(serialized.body);
    assert.equal(result.status, 'contract_validated_internal');
    if (result.status !== 'contract_validated_internal') throw new Error(JSON.stringify(result));
    assert.deepEqual(serialized.prepared, original); assert.deepEqual(result.prepared, original);
    assert.equal(serialized.body, canonical(original));
    assert.deepEqual(t.input, before); assert.equal(result.prepared.plan.sourceQuote.terms, sourceTerms);
    assert.equal(result.prepared.plan.paymentTerms, newTerms);
    assert.equal(result.prepared.plan.sourceQuote.totalCents, 10001);
    assert.equal(result.prepared.plan.sourceQuote.depositCents, 5001);
    assert.equal(result.prepared.plan.sourceQuote.depositBasis.basisPoints, 5000);
    const initial = mode === 'retainer_50' ? 5001 : mode === 'full_upfront' ? 10001 : 4900;
    assert.equal(result.prepared.plan.initialPaymentCents, initial);
    assert.equal(result.prepared.plan.paymentBalanceCents, 10001 - initial);
    assert.deepEqual(result.prepared.plan.paymentSchedule, serialized.prepared.plan.paymentSchedule);
    assert.deepEqual(result.prepared.plan.linkExpiration, serialized.prepared.plan.linkExpiration);
    assert.equal(result.authorizationVerified, false); assert.equal(result.executable, false);
    assert.equal(result.providerEnabled, false); assert.equal(result.publicPaymentUrl, null);
    assert.equal(decodeGourmetPaymentsV2Receipt(JSON.stringify(result), serialized).status, 'contract_validated_internal');
    assert.equal(Object.hasOwn(result, 'payment_agreement_id'), false);
    assert.equal(Object.hasOwn(result, 'request'), false);
  });
}

test('50% equal to USD 49 remains percentage retainer through PHP, while explicit exception preserves the source percentage', async () => {
  for (const mode of ['retainer_50', 'fixed_49_reservation'] as const) {
    const t = await fixture(mode, 9800), serialized = wire(t.input), result = receiveRaw(serialized.body);
    assert.equal(result.status, 'contract_validated_internal');
    if (result.status !== 'contract_validated_internal') throw new Error(JSON.stringify(result));
    assert.equal(result.prepared.plan.paymentMode, mode); assert.equal(result.prepared.plan.initialPaymentCents, 4900);
    assert.deepEqual(result.prepared.plan.sourceQuote.depositBasis, { kind: 'quoted_percentage', basisPoints: 5000 });
    assert.equal(result.prepared.plan.sourceQuote.depositCents, 4900);
  }
});

test('new explicit mode never overwrites an incompatible quoted percentage', async () => {
  for (const mode of ['retainer_50', 'full_upfront', 'fixed_49_reservation'] as const) {
    const t = await fixture(mode, 125001, 3000), serialized = wire(t.input), result = receiveRaw(serialized.body);
    assert.equal(result.status, 'contract_validated_internal');
    if (result.status !== 'contract_validated_internal') throw new Error(JSON.stringify(result));
    assert.equal(result.prepared.plan.sourceQuote.depositBasis.basisPoints, 3000);
    assert.equal(result.prepared.plan.sourceQuote.depositCents, t.q.depositCents);
    assert.equal(result.prepared.plan.termsChangeReason, t.configuration.termsChangeReason);
    const mutated: any = structuredClone(serialized.prepared); mutated.plan.termsChangeReason = null;
    expectBlocked(receive(rehash(mutated)));
  }
});

test('unchanged quote terms need no manufactured change reason only for the matching percentage mode; USD 49 equality remains an exception', async () => {
  for (const [mode, bps] of [['retainer_50', 5000], ['full_upfront', 10000]] as const) {
    const t = await fixture(mode, 9800, bps);
    t.configuration.paymentTerms = sourceTerms; t.configuration.termsChangeReason = null;
    assert.equal(receiveRaw(wire(t.input).body).status, 'contract_validated_internal');
  }
  const t = await fixture('fixed_49_reservation', 9800);
  t.configuration.paymentTerms = sourceTerms;
  const serialized = wire(t.input), changed: any = structuredClone(serialized.prepared);
  changed.plan.termsChangeReason = null;
  expectBlocked(receive(rehash(changed)));
});

test('PHP preserves current quote limits and minimum positive balances using integer cents', async () => {
  for (const [mode, total] of [['retainer_50', 3], ['fixed_49_reservation', 4901], ['retainer_50', 1_000_000_000], ['full_upfront', 1_000_000_000]] as const) {
    const serialized = wire((await fixture(mode, total)).input), result = receiveRaw(serialized.body);
    assert.equal(result.status, 'contract_validated_internal');
    if (result.status !== 'contract_validated_internal') throw new Error(JSON.stringify(result));
    assert.equal(result.prepared.plan.initialPaymentCents + result.prepared.plan.paymentBalanceCents, total);
    assert.deepEqual(result.prepared, serialized.prepared);
  }
});

test('invalid Unicode remains an explicit PHP incompatibility instead of rewriting quoted or newly reviewed text', async () => {
  const t = await fixture();
  t.configuration.paymentTerms = 'Synthetic invalid surrogate: \ud800';
  const serialized = wire(t.input), before = serialized.body;
  expectBlocked(receiveRaw(serialized.body));
  assert.equal(serialized.prepared.plan.paymentTerms, t.configuration.paymentTerms);
  assert.equal(serialized.body, before);
});

test('TS serialization needs current complete preparation and separate approval; it does not accept a Prepared supplied as input', async () => {
  const t = await fixture(), before = structuredClone(t.input);
  assert.equal(prepareGourmetPaymentsV2Wire(t.input).status, 'blocked');
  assert.equal(prepareGourmetPaymentsV2Wire({ ...t.input, configuration: null }, approve(t.input)).status, 'blocked');
  assert.equal(prepareGourmetPaymentsV2Wire({ ...t.input, currentCatalogDigest: 'f'.repeat(64) }, approve(t.input)).status, 'blocked');
  const prepared = wire(t.input).prepared;
  assert.equal(prepareGourmetPaymentsV2Wire(prepared as any, approve(t.input)).status, 'blocked');
  assert.deepEqual(t.input, before);
});

test('wire snapshot is deeply immutable and receipt comparison never follows later caller mutation', async () => {
  const t = await fixture(), serialized = wire(t.input), result = receiveRaw(serialized.body);
  assert.ok(Object.isFrozen(serialized)); assert.ok(Object.isFrozen(serialized.prepared.plan.sourceQuote.depositBasis));
  assert.throws(() => { serialized.prepared.plan.sourceQuote.totalCents++; }, TypeError);
  assert.throws(() => { serialized.prepared.plan.paymentSchedule!.configured.balanceTime = '01:00'; }, TypeError);
  t.configuration.paymentTerms = 'Later caller change'; t.input.record.quotes[0].totalCents++;
  assert.equal(serialized.prepared.plan.paymentTerms, newTerms);
  assert.equal(decodeGourmetPaymentsV2Receipt(JSON.stringify(result), serialized).status, 'contract_validated_internal');
  assert.equal(decodeGourmetPaymentsV2Receipt(JSON.stringify(result), structuredClone(serialized)).status, 'blocked');
});

test('PHP preserves seven local calendar days across DST without copying the event hour into the balance hour', async () => {
  const t = await fixture();
  t.configuration.paymentSchedule = { kind: 'retainer_50', eventDate: '2027-11-10', eventTime: '12:00', timezone: 'America/New_York', balanceDate: '2027-11-03', balanceTime: '10:15', timingExceptionReason: null };
  t.configuration.linkExpiration = { kind: 'never' };
  const serialized = wire(t.input), result = receiveRaw(serialized.body);
  assert.equal(result.status, 'contract_validated_internal');
  if (result.status !== 'contract_validated_internal') throw new Error(JSON.stringify(result));
  assert.equal(result.prepared.plan.paymentSchedule!.balanceInstant, '2027-11-03T14:15:00Z');
  assert.equal(result.prepared.plan.paymentSchedule!.eventInstant, '2027-11-10T17:00:00Z');
  assert.equal(result.prepared.plan.paymentSchedule!.proposedBalanceDate, '2027-11-03');
  assert.deepEqual(result.prepared.plan.linkExpiration, { configured: { kind: 'never' }, instant: null });
});

test('close event requires explicit timing review and an independently configured future balance; PHP checks its own clock', async () => {
  const t = await fixture();
  const date = new Date(TEST_AT).toISOString().slice(0, 10), tomorrow = new Date(TEST_AT + 86400000).toISOString().slice(0, 10);
  const minute = TEST_AT + 60000;
  t.configuration.paymentSchedule = { kind: 'retainer_50', eventDate: tomorrow, eventTime: '18:00', timezone: 'UTC',
    balanceDate: date, balanceTime: new Date(minute).toISOString().slice(11, 16), timingExceptionReason: 'Evento cercano: fecha futura alternativa revisada expresamente.' };
  t.configuration.linkExpiration = { kind: 'never' };
  const serialized = wire(t.input);
  assert.equal(receiveRaw(serialized.body, minute - 1).status, 'contract_validated_internal');
  expectBlocked(receiveRaw(serialized.body, minute)); expectBlocked(receiveRaw(serialized.body, minute + 1));
  const mutated: any = structuredClone(serialized.prepared);
  mutated.plan.paymentSchedule.configured.timingExceptionReason = null; mutated.plan.paymentSchedule.timingReviewReason = null;
  expectBlocked(receive(rehash(mutated)));
});

test('an explicitly configured expiration cannot become past or equal to the receiver clock', async () => {
  const t = await fixture(), expirationMs = TEST_AT + 60000;
  t.configuration.linkExpiration = { kind: 'at', date: new Date(expirationMs).toISOString().slice(0, 10), time: new Date(expirationMs).toISOString().slice(11, 16), timezone: 'UTC' };
  const serialized = wire(t.input);
  assert.equal(receiveRaw(serialized.body, expirationMs - 1).status, 'contract_validated_internal');
  expectBlocked(receiveRaw(serialized.body, expirationMs)); expectBlocked(receiveRaw(serialized.body, expirationMs + 1));
});

const invariants: readonly [string, (p: any) => void][] = [
  ['fractional amount', p => { p.plan.initialPaymentCents += 0.5; }],
  ['negative balance', p => { p.plan.paymentBalanceCents = -1; }],
  ['string amount', p => { p.plan.sourceQuote.totalCents = '10001'; }],
  ['unsafe amount', p => { p.plan.sourceQuote.totalCents = Number.MAX_SAFE_INTEGER + 1; }],
  ['wrong sum', p => { p.plan.paymentBalanceCents++; }],
  ['wrong retainer percentage', p => { p.plan.initialPaymentCents++; p.plan.paymentBalanceCents--; }],
  ['changed quoted arithmetic', p => { p.plan.sourceQuote.depositCents++; }],
  ['invalid quoted basis', p => { p.plan.sourceQuote.depositBasis.basisPoints = 10001; }],
  ['invented fixed source basis', p => { p.plan.sourceQuote.depositBasis = { kind: 'fixed', cents: 4900 }; }],
  ['unsupported currency', p => { p.plan.sourceQuote.currency = 'PEN'; }],
  ['blank new terms', p => { p.plan.paymentTerms = ''; }],
  ['missing new terms', p => { delete p.plan.paymentTerms; }],
  ['missing conditions review reason', p => { p.plan.termsChangeReason = null; }],
  ['blank canonical lead', p => { p.plan.canonicalLeadId = ''; }],
  ['trimmed canonical lead', p => { p.plan.canonicalLeadId = ' lead '; }],
  ['invalid quote pin', p => { p.plan.sourceQuote.digest = 'broken'; }],
  ['missing approval pin', p => { delete p.plan.sourceQuote.approvalDigest; }],
  ['missing quote terms', p => { delete p.plan.sourceQuote.terms; }],
  ['missing event hour', p => { delete p.plan.paymentSchedule.configured.eventTime; }],
  ['missing balance hour', p => { delete p.plan.paymentSchedule.configured.balanceTime; }],
  ['missing timezone', p => { delete p.plan.paymentSchedule.configured.timezone; }],
  ['timezone abbreviation', p => { p.plan.paymentSchedule.configured.timezone = 'CST'; }],
  ['numeric timezone', p => { p.plan.paymentSchedule.configured.timezone = '+05:45'; }],
  ['invalid timezone', p => { p.plan.paymentSchedule.configured.timezone = 'Mars/Olympus'; }],
  ['invalid calendar day', p => { p.plan.paymentSchedule.configured.balanceDate = '2099-02-30'; }],
  ['seconds instead of minute', p => { p.plan.paymentSchedule.configured.balanceTime = '12:00:01'; }],
  ['instant does not match configured date', p => { p.plan.paymentSchedule.balanceInstant = '2099-12-08T18:00:00Z'; }],
  ['proposed date not seven calendar labels before event', p => { p.plan.paymentSchedule.proposedBalanceDate = '2099-12-07'; }],
  ['schedule change without timing review', p => { p.plan.paymentSchedule.configured.balanceDate = '2099-12-07'; p.plan.paymentSchedule.balanceInstant = '2099-12-07T17:00:00Z'; }],
  ['balance at event', p => { p.plan.paymentSchedule.configured.balanceDate = '2099-12-15'; p.plan.paymentSchedule.configured.balanceTime = '18:00'; p.plan.paymentSchedule.balanceInstant = p.plan.paymentSchedule.eventInstant; }],
  ['contradictory timing review evidence', p => { p.plan.paymentSchedule.timingReviewReason = 'Different from configured reason'; }],
  ['missing expiration', p => { delete p.plan.linkExpiration; }],
  ['expiration mismatch', p => { p.plan.linkExpiration.instant = '2099-11-20T18:01:00Z'; }],
  ['never expiration with instant', p => { p.plan.linkExpiration.configured = { kind: 'never' }; }],
  ['malformed approval actor', p => { p.internalApproval.actorId = 'bad actor'; }],
  ['future internal approval', p => { p.internalApproval.atMs = TEST_AT + 1; }],
  ['wrong approval purpose', p => { p.internalApproval.purpose = 'execute_payment'; }],
  ['unknown financial field', p => { p.plan.reservation_cents = 4900; }],
  ['mixed v1 discriminator', p => { p.plan.contractVersion = 1; }],
  ['mixed root version', p => { p.contractVersion = 1; }],
  ['unknown payment mode', p => { p.plan.paymentMode = 'approved_quote_deposit'; }],
  ['authorization flag injection', p => { p.internalApproval.authorized = true; }],
  ['executable flag', p => { p.executable = true; }],
  ['provider flag', p => { p.providerEnabled = true; }],
  ['public URL injection', p => { p.publicPaymentUrl = 'https://example.invalid/forged'; }],
];
for (const [name, change] of invariants) {
  test(`PHP independently blocks ${name} even after all review hashes are recomputed`, async () => {
    const serialized = wire((await fixture()).input), mutated = structuredClone(serialized.prepared);
    change(mutated); expectBlocked(receive(rehash(mutated)));
  });
}

for (const mode of ['retainer_50', 'full_upfront', 'fixed_49_reservation'] as const) {
  const targets = mode === 'full_upfront' ? ['expiration.at'] as const : ['expiration.at', 'paymentSchedule'] as const;
  for (const target of targets) {
    for (const [name, control] of [['NUL', '\u0000'], ['SOH', '\u0001'], ['TAB', '\t'], ['LF', '\n'], ['CR', '\r'], ['DEL', '\u007f']] as const) {
      test(`PHP returns a blocked contract for timezone ${name} in ${mode} ${target} without crashing`, async () => {
        const serialized = wire((await fixture(mode)).input), mutated: any = structuredClone(serialized.prepared);
        const configured = target === 'expiration.at' ? mutated.plan.linkExpiration.configured : mutated.plan.paymentSchedule.configured;
        // Keep the control inside the string: trimming a suffix must not mask a
        // constructor error or turn a hostile timezone into an accepted zone.
        configured.timezone = `America/New_York${control}suffix`;
        expectBlocked(receive(rehash(mutated)));
      });
    }
  }
}

for (const [name, date, time, timezone, instant] of [
  ['New York fold', '2026-11-01', '01:30', 'America/New_York', '2026-11-01T05:30:00Z'],
  ['New York gap', '2027-03-14', '02:30', 'America/New_York', '2027-03-14T07:30:00Z'],
  ['Lord Howe half-hour fold', '2027-04-04', '01:45', 'Australia/Lord_Howe', '2027-04-03T14:45:00Z'],
] as const) {
  test(`PHP rejects ${name} rather than normalizing configured local facts`, async () => {
    const serialized = wire((await fixture('fixed_49_reservation')).input), mutated: any = structuredClone(serialized.prepared);
    Object.assign(mutated.plan.paymentSchedule.configured, { balanceDate: date, balanceTime: time, timezone });
    mutated.plan.paymentSchedule.balanceInstant = instant;
    expectBlocked(receive(rehash(mutated)));
    const expiry: any = structuredClone(serialized.prepared);
    expiry.plan.linkExpiration = { configured: { kind: 'at', date, time, timezone }, instant };
    expectBlocked(receive(rehash(expiry)));
  });
}

for (const mode of ['retainer_50', 'fixed_49_reservation'] as const) {
  test(`Apia skipped day blocks ${mode} balance while neighboring existing dates validate against a clock before the transition`, async () => {
    const nowMs = Date.parse('2011-12-01T00:00:00Z');
    const baseline: any = structuredClone(wire((await fixture(mode)).input).prepared);
    // These are deliberately rehashed raw-receiver fixtures. The old trusted
    // clock and nonfuture approval prevent a past-date/approval check from
    // hiding a broken skipped-day resolver. No production record is changed.
    baseline.internalApproval.atMs = nowMs;
    baseline.plan.linkExpiration = { configured: { kind: 'never' }, instant: null };
    for (const [date, instant, exists] of [
      ['2011-12-29', '2011-12-29T22:00:00Z', true],
      // This instant is what a normalizing parser would silently turn into
      // 2011-12-31T12:00. It is future and before the event, so neither check
      // may substitute for rejecting the nonexistent configured calendar day.
      ['2011-12-30', '2011-12-30T22:00:00Z', false],
      ['2011-12-31', '2011-12-30T22:00:00Z', true],
    ] as const) {
      const prepared = structuredClone(baseline);
      prepared.plan.paymentSchedule = mode === 'retainer_50'
        ? { configured: { kind: mode, eventDate: '2012-01-06', eventTime: '12:00', timezone: 'Pacific/Apia',
          balanceDate: date, balanceTime: '12:00', timingExceptionReason: 'Fecha alternativa revisada expresamente en fixture sintético.' },
        balanceInstant: instant, eventInstant: '2012-01-05T22:00:00Z', proposedBalanceDate: '2011-12-30',
        timingReviewReason: 'Fecha alternativa revisada expresamente en fixture sintético.' }
        : { configured: { kind: mode, balanceDate: date, balanceTime: '12:00', timezone: 'Pacific/Apia', agreedBalanceCents: prepared.plan.paymentBalanceCents },
          balanceInstant: instant, eventInstant: null, proposedBalanceDate: null, timingReviewReason: null };
      const result = receive(rehash(prepared), nowMs);
      if (!exists) expectBlocked(result);
      else {
        assert.equal(result.status, 'contract_validated_internal', `Existing Apia date ${date} must not be rejected by the clock or other fixture fields`);
        if (result.status !== 'contract_validated_internal') throw new Error(JSON.stringify(result));
        assert.deepEqual(result.prepared, prepared);
      }
    }
  });
}

test('Apia skipped day expiration is rejected independently of past dates while adjacent expirations remain exact and future', async () => {
  const nowMs = Date.parse('2011-12-01T00:00:00Z');
  const baseline: any = structuredClone(wire((await fixture('full_upfront')).input).prepared);
  baseline.internalApproval.atMs = nowMs;
  assert.equal(baseline.plan.paymentSchedule, null);
  for (const [date, instant, exists] of [
    ['2011-12-29', '2011-12-29T22:00:00Z', true],
    ['2011-12-30', '2011-12-30T22:00:00Z', false],
    ['2011-12-31', '2011-12-30T22:00:00Z', true],
  ] as const) {
    const prepared = structuredClone(baseline);
    prepared.plan.linkExpiration = { configured: { kind: 'at', date, time: '12:00', timezone: 'Pacific/Apia' }, instant };
    const result = receive(rehash(prepared), nowMs);
    if (!exists) expectBlocked(result);
    else {
      assert.equal(result.status, 'contract_validated_internal', `Existing Apia expiration ${date} must remain future and exact`);
      if (result.status !== 'contract_validated_internal') throw new Error(JSON.stringify(result));
      assert.deepEqual(result.prepared, prepared);
    }
  }
});

test('full upfront rejects a future balance and the fixed exception rejects changed agreed amount, even with fresh hashes', async () => {
  const retainer = wire((await fixture()).input).prepared;
  const upfront = wire((await fixture('full_upfront')).input);
  for (const change of [(p: any) => { p.plan.paymentSchedule = structuredClone(retainer.plan.paymentSchedule); },
    (p: any) => { p.plan.initialPaymentCents--; p.plan.paymentBalanceCents = 1; }]) {
    const mutated = structuredClone(upfront.prepared); change(mutated); expectBlocked(receive(rehash(mutated)));
  }
  const fixed = wire((await fixture('fixed_49_reservation')).input);
  for (const change of [(p: any) => { p.plan.paymentSchedule.configured.agreedBalanceCents++; },
    (p: any) => { p.plan.initialPaymentCents++; p.plan.paymentBalanceCents--; p.plan.paymentSchedule.configured.agreedBalanceCents--; },
    (p: any) => { p.plan.termsChangeReason = null; },
    (p: any) => { p.plan.paymentSchedule.configured.eventDate = '2099-12-15'; }]) {
    const mutated = structuredClone(fixed.prepared); change(mutated); expectBlocked(receive(rehash(mutated)));
  }
});

test('PHP rejects stale hashes, malformed/noncanonical JSON, duplicate keys, unknown keys and oversize input', async () => {
  const serialized = wire((await fixture()).input), stale = structuredClone(serialized.prepared);
  stale.plan.paymentTerms += '\nChanged after review'; expectBlocked(receive(stale));
  for (const raw of ['{', 'null', '[]', JSON.stringify(serialized.prepared), `${serialized.body}\n`,
    serialized.body.replace('{', '{"status":"forged",'), ' '.repeat(131073)]) expectBlocked(receiveRaw(raw));
  for (const changed of [{ ...serialized.prepared, unknown: true },
    { ...serialized.prepared, internalApproval: { ...serialized.prepared.internalApproval, reviewDigest: 'f'.repeat(64) } }]) expectBlocked(receive(changed));
});

test('PHP rejects invalid trusted clocks and approvals later than the receiver clock', async () => {
  const serialized = wire((await fixture()).input);
  for (const now of [-1, TEST_AT + 0.5, Number.MAX_SAFE_INTEGER + 1, TEST_AT - 1]) expectBlocked(receiveRaw(serialized.body, now));
});

test('TS rejects every changed receipt fact even when an isolated PHP self-consistency check accepts a freshly rehashed plan', async () => {
  const serialized = wire((await fixture()).input);
  const changes = [(p: any) => { p.plan.canonicalLeadId = 'different-synthetic-lead'; },
    (p: any) => {
      p.plan.sourceQuote.digest = 'f'.repeat(64);
      p.plan.preparationId = `payment-contract-v2-${digest({ contractVersion: 2, scope: p.plan.scope, eventId: p.plan.eventId,
        quoteVersion: p.plan.sourceQuote.version, quoteDigest: p.plan.sourceQuote.digest,
        approvalDigest: p.plan.sourceQuote.approvalDigest, paymentMode: p.plan.paymentMode })}`;
    },
    (p: any) => { p.plan.paymentTerms += '\nDifferent reviewed conditions'; },
    (p: any) => { p.internalApproval.actorId = 'OTHER-SYNTHETIC-ACTOR'; },
    (p: any) => { p.plan.paymentSchedule.configured.balanceTime = '12:01'; p.plan.paymentSchedule.balanceInstant = '2099-12-08T17:01:00Z'; }];
  for (const change of changes) {
    const mutated = structuredClone(serialized.prepared); change(mutated);
    const receipt = receive(rehash(mutated));
    assert.equal(receipt.status, 'contract_validated_internal', 'Self-consistency alone cannot authenticate source pins, terms or actor');
    assert.equal(decodeGourmetPaymentsV2Receipt(JSON.stringify(receipt), serialized).status, 'blocked');
  }
});

test('TS receipt decoder rejects unknown keys, missing facts, enabled effects and false authority claims', async () => {
  const serialized = wire((await fixture()).input), valid: any = receiveRaw(serialized.body);
  for (const value of [null, [], {}, { ...valid, authorizationVerified: true }, { ...valid, executable: true },
    { ...valid, providerEnabled: true }, { ...valid, publicPaymentUrl: 'https://example.invalid/forged' },
    { ...valid, status: 'created' }, { ...valid, unknown: true }, { ...valid, prepared: null },
    { ...valid, prepared: { ...valid.prepared, unknown: true } }, { status: 'blocked', code: 'NO', prepared: valid.prepared },
    { status: 'blocked', code: '' }, { ...valid, authorizationVerified: undefined }]) {
    assert.equal(decodeGourmetPaymentsV2Receipt(JSON.stringify(value), serialized).status, 'blocked');
  }
  for (const raw of ['{', 'x'.repeat(262145)]) assert.equal(decodeGourmetPaymentsV2Receipt(raw, serialized).status, 'blocked');
  assert.deepEqual(decodeGourmetPaymentsV2Receipt('{"status":"blocked","code":"INVALID_PAYMENT_PLAN_V2"}', serialized),
    { status: 'blocked', code: 'INVALID_PAYMENT_PLAN_V2' });
});
